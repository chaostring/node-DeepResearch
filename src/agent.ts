import {ZodObject} from 'zod';
import {CoreMessage} from 'ai';
import {SEARCH_PROVIDER, STEP_SLEEP} from "./config";
import fs from 'fs/promises';
import {SafeSearchType, search as duckSearch} from "duck-duck-scrape";
import {braveSearch} from "./tools/brave-search";
import {rewriteQuery} from "./tools/query-rewriter";
import {dedupQueries} from "./tools/jina-dedup";
import {evaluateAnswer, evaluateQuestion} from "./tools/evaluator";
import {analyzeSteps} from "./tools/error-analyzer";
import {TokenTracker} from "./utils/token-tracker";
import {ActionTracker} from "./utils/action-tracker";
import {
  StepAction,
  AnswerAction,
  KnowledgeItem,
  EvaluationType,
  BoostedSearchSnippet,
  SearchSnippet, EvaluationResponse, Reference, SERPQuery, RepeatEvaluationType, UnNormalizedSearchSnippet
} from "./types";
import {TrackerContext} from "./types";
import {search} from "./tools/jina-search";
// import {grounding} from "./tools/grounding";
import {zodToJsonSchema} from "zod-to-json-schema";
import {ObjectGeneratorSafe} from "./utils/safe-generator";
import {CodeSandbox} from "./tools/code-sandbox";
import {serperSearch} from './tools/serper-search';
import {
  addToAllURLs,
  rankURLs,
  filterURLs,
  normalizeUrl,
  sortSelectURLs, getLastModified, keepKPerHostname, processURLs, fixBadURLMdLinks, extractUrlsWithDescription
} from "./utils/url-tools";
import {
  buildMdFromAnswer,
  chooseK, convertHtmlTablesToMd, fixCodeBlockIndentation,
  removeExtraLineBreaks,
  removeHTMLtags, repairMarkdownFinal, repairMarkdownFootnotesOuter
} from "./utils/text-tools";
import {MAX_QUERIES_PER_STEP, MAX_REFLECT_PER_STEP, MAX_URLS_PER_STEP, Schemas} from "./utils/schemas";
import {formatDateBasedOnType, formatDateRange} from "./utils/date-tools";
import {fixMarkdown} from "./tools/md-fixer";
import {repairUnknownChars} from "./tools/broken-ch-fixer";

/**
 * 休眠函数，暂停执行指定的毫秒数
 * 在各种操作之间添加延迟，避免API调用过于频繁
 * @param ms 毫秒数
 * @returns Promise，延迟指定毫秒后解析
 */
async function sleep(ms: number) {
  const seconds = Math.ceil(ms / 1000);
  console.log(`Waiting ${seconds}s...`);
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 从知识项构建消息对数组
 * 将每个知识项转换为用户-助手对话格式
 * @param knowledge 知识项数组，每项包含问题和答案
 * @returns CoreMessage[]类型的消息数组，用于构建AI提示
 */
function BuildMsgsFromKnowledge(knowledge: KnowledgeItem[]): CoreMessage[] {
  // 从知识构建用户-助手对消息
  // build user, assistant pair messages from knowledge
  const messages: CoreMessage[] = [];
  knowledge.forEach(k => {
    // 添加用户消息（问题）
    messages.push({role: 'user', content: k.question.trim()});
    // 构建助手消息（回答），包含日期时间、URL和答案内容
    const aMsg = `
${k.updated && (k.type === 'url' || k.type === 'side-info') ? `
<answer-datetime>
${k.updated}
</answer-datetime>
` : ''}

${k.references && k.type === 'url' ? `
<url>
${k.references[0]}
</url>
` : ''}


${k.answer}
      `.trim();
    // 添加助手消息，并移除多余的换行
    messages.push({role: 'assistant', content: removeExtraLineBreaks(aMsg)});
  });
  return messages;
}

/**
 * 组合消息，将知识、消息历史和当前问题组合成一个完整的消息数组
 * @param messages 已有的消息历史
 * @param knowledge 知识项数组
 * @param question 当前问题
 * @param finalAnswerPIP 可选的最终答案改进建议数组
 * @returns CoreMessage[]类型的完整消息数组
 */
function composeMsgs(messages: CoreMessage[], knowledge: KnowledgeItem[], question: string, finalAnswerPIP?: string[]) {
  // 知识始终放在前面，后面是真实的用户-助手交互
  // knowledge always put to front, followed by real u-a interaction
  const msgs = [...BuildMsgsFromKnowledge(knowledge), ...messages];

  // 构建用户内容，包括问题和可能的回答要求
  const userContent = `
${question}

${finalAnswerPIP?.length ? `
<answer-requirements>
- You provide deep, unexpected insights, identifying hidden patterns and connections, and creating "aha moments.".
- You break conventional thinking, establish unique cross-disciplinary connections, and bring new perspectives to the user.
- Follow reviewer's feedback and improve your answer quality.
${finalAnswerPIP.map((p, idx) => `
<reviewer-${idx + 1}>
${p}
</reviewer-${idx + 1}>
`).join('\n')}
</answer-requirements>` : ''}
    `.trim();

  // 添加新的用户消息，并移除多余的换行
  msgs.push({role: 'user', content: removeExtraLineBreaks(userContent)});
  return msgs;
}

/**
 * 获取提示，构建系统提示内容
 * 此函数根据当前状态和允许的操作，构建系统提示内容
 * @param context 可选的上下文内容数组
 * @param allQuestions 可选的所有问题数组
 * @param allKeywords 可选的所有关键词数组
 * @param allowReflect 是否允许反思动作，默认为true
 * @param allowAnswer 是否允许回答动作，默认为true
 * @param allowRead 是否允许阅读动作，默认为true
 * @param allowSearch 是否允许搜索动作，默认为true
 * @param allowCoding 是否允许编码动作，默认为true
 * @param knowledge 可选的知识项数组
 * @param allURLs 可选的所有URL数组
 * @param beastMode 是否启用野兽模式（强制回答模式），默认为false
 * @returns 包含系统提示和URL列表的对象
 */
function getPrompt(
  context?: string[],
  allQuestions?: string[],
  allKeywords?: string[],
  allowReflect: boolean = true,
  allowAnswer: boolean = true,
  allowRead: boolean = true,
  allowSearch: boolean = true,
  allowCoding: boolean = true,
  knowledge?: KnowledgeItem[],
  allURLs?: BoostedSearchSnippet[],
  beastMode?: boolean,
): { system: string, urlList?: string[] } {
  const sections: string[] = [];  // 存储提示的各个部分
  const actionSections: string[] = [];  // 存储动作部分

  // 添加头部部分（标头），包含当前日期和代理角色描述
  // Add header section
  sections.push(`Current date: ${new Date().toUTCString()}

You are an advanced AI research agent from Jina AI. You are specialized in multistep reasoning. 
Using your best knowledge, conversation with the user and lessons learned, answer the user question with absolute certainty.
`);


  // 如果存在上下文，添加上下文部分
  // Add context section if exists
  if (context?.length) {
    sections.push(`
You have conducted the following actions:
<context>
${context.join('\n')}

</context>
`);
  }

  // 构建动作部分：根据允许的操作和当前状态，添加不同的动作选项
  // Build actions section

  // 处理URL列表，选择并排序前20个URL（按相关性）
  const urlList = sortSelectURLs(allURLs || [], 20);
  if (allowRead && urlList.length > 0) {
    // 构建URL列表字符串，包含索引、权重、URL和简短描述
    const urlListStr = urlList
      .map((item, idx) => `  - [idx=${idx + 1}] [weight=${item.score.toFixed(2)}] "${item.url}": "${item.merged.slice(0, 50)}"`)
      .join('\n')

    // 添加访问动作部分，允许代理访问并读取URL内容
    actionSections.push(`
<action-visit>
- Crawl and read full content from URLs, you can get the fulltext, last updated datetime etc of any URL.  
- Must check URLs mentioned in <question> if any    
- Choose and visit relevant URLs below for more knowledge. higher weight suggests more relevant:
<url-list>
${urlListStr}
</url-list>
</action-visit>
`);
  }


  if (allowSearch) {
    // 添加搜索动作部分，允许代理执行Web搜索
    actionSections.push(`
<action-search>
- Use web search to find relevant information
- Build a search request based on the deep intention behind the original question and the expected answer format
- Always prefer a single search request, only add another request if the original question covers multiple aspects or elements and one query is not enough, each request focus on one specific aspect of the original question 
${allKeywords?.length ? `
- Avoid those unsuccessful search requests and queries:
<bad-requests>
${allKeywords.join('\n')}
</bad-requests>
`.trim() : ''}
</action-search>
`);
  }

  if (allowAnswer) {
    // 添加回答动作部分，允许代理直接回答问题
    actionSections.push(`
<action-answer>
- For greetings, casual conversation, general knowledge questions answer directly without references.
- If user ask you to retrieve previous messages or chat history, remember you do have access to the chat history, answer directly without references.
- For all other questions, provide a verified answer with references. Each reference must include exactQuote, url and datetime.
- You provide deep, unexpected insights, identifying hidden patterns and connections, and creating "aha moments.".
- You break conventional thinking, establish unique cross-disciplinary connections, and bring new perspectives to the user.
- If uncertain, use <action-reflect>
</action-answer>
`);
  }

  if (beastMode) {
    // 添加野兽模式回答动作部分（强制回答模式）
    actionSections.push(`
<action-answer>
🔥 ENGAGE MAXIMUM FORCE! ABSOLUTE PRIORITY OVERRIDE! 🔥

PRIME DIRECTIVE:
- DEMOLISH ALL HESITATION! ANY RESPONSE SURPASSES SILENCE!
- PARTIAL STRIKES AUTHORIZED - DEPLOY WITH FULL CONTEXTUAL FIREPOWER
- TACTICAL REUSE FROM PREVIOUS CONVERSATION SANCTIONED
- WHEN IN DOUBT: UNLEASH CALCULATED STRIKES BASED ON AVAILABLE INTEL!

FAILURE IS NOT AN OPTION. EXECUTE WITH EXTREME PREJUDICE! ⚡️
</action-answer>
`);
  }

  if (allowReflect) {
    // 添加反思动作部分，允许代理思考并识别知识缺口
    actionSections.push(`
<action-reflect>
- Think slowly and planning lookahead. Examine <question>, <context>, previous conversation with users to identify knowledge gaps. 
- Reflect the gaps and plan a list key clarifying questions that deeply related to the original question and lead to the answer
</action-reflect>
`);
  }

  if (allowCoding) {
    // 添加编码动作部分，允许代理处理编程相关的任务
    actionSections.push(`
<action-coding>
- This JavaScript-based solution helps you handle programming tasks like counting, filtering, transforming, sorting, regex extraction, and data processing.
- Simply describe your problem in the "codingIssue" field. Include actual values for small inputs or variable names for larger datasets.
- No code writing is required – senior engineers will handle the implementation.
</action-coding>`);
  }

  // 将所有动作部分组合到一起
  sections.push(`
Based on the current context, you must choose one of the following actions:
<actions>
${actionSections.join('\n\n')}
</actions>
`);

  // 添加页脚，指导代理如何回应
  // Add footer
  sections.push(`Think step by step, choose the action, then respond by matching the schema of that action.`);

  // 返回完整的系统提示和URL列表
  return {
    system: removeExtraLineBreaks(sections.join('\n\n')),
    urlList: urlList.map(u => u.url)
  };
}

/**
 * 存储当前会话中的所有步骤，包括那些导致错误结果的步骤
 * 用于记录代理的完整行为历史
 */
const allContext: StepAction[] = [];  // all steps in the current session, including those leads to wrong results

/**
 * 更新上下文，添加新的步骤到历史记录中
 * @param step 要添加的步骤
 */
function updateContext(step: any) {
  allContext.push(step)
}

/**
 * 更新引用信息，处理URL正规化并添加标题、日期时间等信息
 * @param thisStep 当前的回答动作，包含引用信息
 * @param allURLs 所有已知URL的记录，包含相关元数据
 * @returns 无返回值，直接修改thisStep对象
 */
async function updateReferences(thisStep: AnswerAction, allURLs: Record<string, SearchSnippet>) {
  // 过滤有效的引用，并进行标准化处理
  thisStep.references = thisStep.references
    ?.filter(ref => ref?.url)
    .map(ref => {
      const normalizedUrl = normalizeUrl(ref.url);
      if (!normalizedUrl) return null; // 无效URL返回null

      // 创建标准化的引用对象，包含引用文本、标题、URL和日期时间
      return {
        exactQuote: (ref?.exactQuote ||
          allURLs[normalizedUrl]?.description ||
          allURLs[normalizedUrl]?.title || '')
          .replace(/[^\p{L}\p{N}\s]/gu, ' ')  // 移除非字母数字和空格的字符
          .replace(/\s+/g, ' '),              // 将多个空格合并为一个
        title: allURLs[normalizedUrl]?.title || '',
        url: normalizedUrl,
        dateTime: ref?.dateTime || allURLs[normalizedUrl]?.date || '',
      };
    })
    .filter(Boolean) as Reference[]; // 过滤掉null值并断言类型

  // 并行处理所有缺少日期时间的引用，尝试获取最后修改时间
  await Promise.all((thisStep.references || []).filter(ref => !ref.dateTime)
    .map(async ref => {
      ref.dateTime = await getLastModified(ref.url) || '';
    }));

  console.log('Updated references:', thisStep.references);
}

/**
 * 执行搜索查询，获取搜索结果并处理为知识项
 * @param keywordsQueries 搜索关键词查询数组
 * @param context 跟踪器上下文，用于记录令牌使用量和动作
 * @param allURLs 所有已知URL的记录，将添加新发现的URL
 * @param SchemaGen Schema生成器，用于生成国际化文本
 * @param onlyHostnames 可选的限制搜索范围的主机名数组
 * @returns 包含新知识项和已搜索查询的对象
 */
async function executeSearchQueries(
  keywordsQueries: any[],
  context: TrackerContext,
  allURLs: Record<string, SearchSnippet>,
  SchemaGen: Schemas,
  onlyHostnames?: string[]
): Promise<{
  newKnowledge: KnowledgeItem[],
  searchedQueries: string[]
}> {
  // 提取唯一的查询
  const uniqQOnly = keywordsQueries.map(q => q.q);
  const newKnowledge: KnowledgeItem[] = [];
  const searchedQueries: string[] = [];
  
  // 记录搜索动作
  context.actionTracker.trackThink('search_for', SchemaGen.languageCode, {keywords: uniqQOnly.join(', ')});
  let utilityScore = 0;  // 搜索效用分数
  
  // 对每个查询执行搜索
  for (const query of keywordsQueries) {
    let results: UnNormalizedSearchSnippet[] = [];
    const oldQuery = query.q;
    
    // 如果指定了限制主机名，则修改查询以仅搜索这些域名
    if (onlyHostnames && onlyHostnames.length > 0) {
      query.q = `${query.q} site:${onlyHostnames.join(' OR site:')}`;
    }

    try {
      console.log('Search query:', query);
      // 根据配置的搜索提供商执行搜索
      switch (SEARCH_PROVIDER) {
        case 'jina':
          results = (await search(query.q, context.tokenTracker)).response?.data || [];
          break;
        case 'duck':
          results = (await duckSearch(query.q, {safeSearch: SafeSearchType.STRICT})).results;
          break;
        case 'brave':
          results = (await braveSearch(query.q)).response.web?.results || [];
          break;
        case 'serper':
          results = (await serperSearch(query)).response.organic || [];
          break;
        default:
          results = [];
      }

      if (results.length === 0) {
        throw new Error('No results found');
      }
    } catch (error) {
      // 搜索失败时记录错误并继续下一个查询
      console.error(`${SEARCH_PROVIDER} search failed for query:`, query, error);
      continue;
    } finally {
      // 搜索后等待一段时间，避免过快请求
      await sleep(STEP_SLEEP);
    }

    // 处理搜索结果，标准化URL和提取相关信息
    const minResults: SearchSnippet[] = results
      .map(r => {
        // 标准化URL（从不同搜索引擎返回的结果格式可能不同）
        const url = normalizeUrl('url' in r ? r.url! : r.link!);
        if (!url) return null; // 跳过无效URL

        // 创建标准化的搜索片段对象
        return {
          title: r.title,
          url,
          description: 'description' in r ? r.description : r.snippet,
          weight: 1,  // 初始权重为1
          date: r.date,
        } as SearchSnippet;
      })
      .filter(Boolean) as SearchSnippet[]; // 过滤掉null并断言类型

    // 将结果添加到所有URL中，并计算效用分数
    minResults.forEach(r => {
      utilityScore = utilityScore + addToAllURLs(r, allURLs);
    });

    // 记录已搜索的查询
    searchedQueries.push(query.q)

    // 将搜索结果创建为新知识项
    newKnowledge.push({
      question: `What do Internet say about "${oldQuery}"?`,
      answer: removeHTMLtags(minResults.map(r => r.description).join('; ')),
      type: 'side-info',
      updated: query.tbs ? formatDateRange(query) : undefined  // 如果有时间参数，则添加日期范围
    });
  }
  
  // 处理搜索结果情况
  if (searchedQueries.length === 0) {
    // 如果限制了主机名但没有结果，记录日志
    if (onlyHostnames && onlyHostnames.length > 0) {
      console.log(`No results found for queries: ${uniqQOnly.join(', ')} on hostnames: ${onlyHostnames.join(', ')}`);
      context.actionTracker.trackThink('hostnames_no_results', SchemaGen.languageCode, {hostnames: onlyHostnames.join(', ')});
    }
  } else {
    // 记录搜索效用和查询数量
    console.log(`Utility/Queries: ${utilityScore}/${searchedQueries.length}`);
    if (searchedQueries.length > MAX_QUERIES_PER_STEP) {
      console.log(`So many queries??? ${searchedQueries.map(q => `"${q}"`).join(', ')}`)
    }
  }
  
  // 返回新知识和已搜索查询
  return {
    newKnowledge,
    searchedQueries
  };
}

/**
 * 检查指定的评估类型是否包含在评估数组中
 * @param allChecks 评估类型数组
 * @param evalType 要检查的评估类型
 * @returns 如果包含则返回true，否则返回false
 */
function includesEval(allChecks: RepeatEvaluationType[], evalType: EvaluationType): boolean {
  return allChecks.some(c => c.type === evalType);
}

/**
 * 主要的响应生成函数，处理用户问题并返回响应
 * @param question 可选的用户问题
 * @param tokenBudget 令牌预算，默认为1,000,000
 * @param maxBadAttempts 最大失败尝试次数，默认为2
 * @param existingContext 可选的现有上下文
 * @param messages 可选的消息历史
 * @param numReturnedURLs 返回的URL数量，默认为100
 * @param noDirectAnswer 是否禁止直接回答，默认为false
 * @param boostHostnames 可选的提升主机名数组
 * @param badHostnames 可选的禁止主机名数组
 * @param onlyHostnames 可选的限制搜索范围的主机名数组
 * @returns 包含响应结果的对象
 */
export async function getResponse(question?: string,
                                  tokenBudget: number = 1_000_000,
                                  maxBadAttempts: number = 2,
                                  existingContext?: Partial<TrackerContext>,
                                  messages?: Array<CoreMessage>,
                                  numReturnedURLs: number = 100,
                                  noDirectAnswer: boolean = false,
                                  boostHostnames: string[] = [],
                                  badHostnames: string[] = [],
                                  onlyHostnames: string[] = []
): Promise<{ result: StepAction; context: TrackerContext; visitedURLs: string[], readURLs: string[], allURLs: string[] }> {

  let step = 0;
  let totalStep = 0;

  question = question?.trim() as string;
  // remove incoming system messages to avoid override
  messages = messages?.filter(m => m.role !== 'system');

  if (messages && messages.length > 0) {
    // 2 cases
    const lastContent = messages[messages.length - 1].content;
    if (typeof lastContent === 'string') {
      question = lastContent.trim();
    } else if (typeof lastContent === 'object' && Array.isArray(lastContent)) {
      // find the very last sub content whose 'type' is 'text'  and use 'text' as the question
      question = lastContent.filter(c => c.type === 'text').pop()?.text || '';
    }
  } else {
    messages = [{role: 'user', content: question.trim()}]
  }

  const SchemaGen = new Schemas();
  await SchemaGen.setLanguage(question)
  const context: TrackerContext = {
    tokenTracker: existingContext?.tokenTracker || new TokenTracker(tokenBudget),
    actionTracker: existingContext?.actionTracker || new ActionTracker()
  };

  const generator = new ObjectGeneratorSafe(context.tokenTracker);

  let schema: ZodObject<any> = SchemaGen.getAgentSchema(true, true, true, true, true)
  const gaps: string[] = [question];  // All questions to be answered including the orginal question
  const allQuestions = [question];
  const allKeywords: string[] = [];
  const allKnowledge: KnowledgeItem[] = [];  // knowledge are intermedidate questions that are answered

  let diaryContext = [];
  let weightedURLs: BoostedSearchSnippet[] = [];
  let allowAnswer = true;
  let allowSearch = true;
  let allowRead = true;
  let allowReflect = true;
  let allowCoding = false;
  let msgWithKnowledge: CoreMessage[] = [];
  let thisStep: StepAction = {action: 'answer', answer: '', references: [], think: '', isFinal: false};

  const allURLs: Record<string, SearchSnippet> = {};
  const visitedURLs: string[] = [];
  const badURLs: string[] = [];
  const evaluationMetrics: Record<string, RepeatEvaluationType[]> = {};
  // reserve the 10% final budget for the beast mode
  const regularBudget = tokenBudget * 0.85;
  const finalAnswerPIP: string[] = [];
  let trivialQuestion = false;

  // add all mentioned URLs in messages to allURLs
  messages.forEach(m => {
    let strMsg = '';
    if (typeof m.content === 'string') {
      strMsg = m.content.trim();
    } else if (typeof m.content === 'object' && Array.isArray(m.content)) {
      // find the very last sub content whose 'type' is 'text'  and use 'text' as the question
      strMsg = m.content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
    }

    extractUrlsWithDescription(strMsg).forEach(u => {
      addToAllURLs(u, allURLs);
    });
  })


  while (context.tokenTracker.getTotalUsage().totalTokens < regularBudget) {
    // add 1s delay to avoid rate limiting
    step++;
    totalStep++;
    const budgetPercentage = (context.tokenTracker.getTotalUsage().totalTokens / tokenBudget * 100).toFixed(2);
    console.log(`Step ${totalStep} / Budget used ${budgetPercentage}%`);
    console.log('Gaps:', gaps);
    allowReflect = allowReflect && (gaps.length <= MAX_REFLECT_PER_STEP);
    // rotating question from gaps
    const currentQuestion: string = gaps[totalStep % gaps.length];
    // if (!evaluationMetrics[currentQuestion]) {
    //   evaluationMetrics[currentQuestion] =
    //     await evaluateQuestion(currentQuestion, context, SchemaGen)
    // }
    if (currentQuestion.trim() === question && totalStep === 1) {
      // only add evaluation for initial question, once at step 1
      evaluationMetrics[currentQuestion] =
        (await evaluateQuestion(currentQuestion, context, SchemaGen)).map(e => {
          return {
            type: e,
            numEvalsRequired: maxBadAttempts
          } as RepeatEvaluationType
        })
      // force strict eval for the original question, at last, only once.
      evaluationMetrics[currentQuestion].push({type: 'strict', numEvalsRequired: maxBadAttempts});
    } else if (currentQuestion.trim() !== question) {
      evaluationMetrics[currentQuestion] = []
    }

    if (totalStep === 1 && includesEval(evaluationMetrics[currentQuestion], 'freshness')) {
      // if it detects freshness, avoid direct answer at step 1
      allowAnswer = false;
      allowReflect = false;
    }


    if (allURLs && Object.keys(allURLs).length > 0) {
      // rerank urls
      weightedURLs = rankURLs(
        filterURLs(allURLs, visitedURLs, badHostnames, onlyHostnames),
        {
          question: currentQuestion,
          boostHostnames
        }, context);
      // improve diversity by keep top 2 urls of each hostname
      weightedURLs = keepKPerHostname(weightedURLs, 2);
      console.log('Weighted URLs:', weightedURLs.length);
    }
    allowRead = allowRead && (weightedURLs.length > 0);

    allowSearch = allowSearch && (weightedURLs.length < 200);  // disable search when too many urls already

    // generate prompt for this step
    const {system, urlList} = getPrompt(
      diaryContext,
      allQuestions,
      allKeywords,
      allowReflect,
      allowAnswer,
      allowRead,
      allowSearch,
      allowCoding,
      allKnowledge,
      weightedURLs,
      false,
    );
    schema = SchemaGen.getAgentSchema(allowReflect, allowRead, allowAnswer, allowSearch, allowCoding, currentQuestion)
    msgWithKnowledge = composeMsgs(messages, allKnowledge, currentQuestion, currentQuestion === question ? finalAnswerPIP : undefined);
    const result = await generator.generateObject({
      model: 'agent',
      schema,
      system,
      messages: msgWithKnowledge,
      numRetries: 2,
    });
    thisStep = {
      action: result.object.action,
      think: result.object.think,
      ...result.object[result.object.action]
    } as StepAction;
    // print allowed and chose action
    const actionsStr = [allowSearch, allowRead, allowAnswer, allowReflect, allowCoding].map((a, i) => a ? ['search', 'read', 'answer', 'reflect'][i] : null).filter(a => a).join(', ');
    console.log(`${currentQuestion}: ${thisStep.action} <- [${actionsStr}]`);
    console.log(thisStep)

    context.actionTracker.trackAction({totalStep, thisStep, gaps});

    // reset allow* to true
    allowAnswer = true;
    allowReflect = true;
    allowRead = true;
    allowSearch = true;
    allowCoding = true;

    // execute the step and action
    if (thisStep.action === 'answer' && thisStep.answer) {
      // normalize all references urls, add title to it
      await updateReferences(thisStep, allURLs)

      if (totalStep === 1 && thisStep.references.length === 0 && !noDirectAnswer) {
        // LLM is so confident and answer immediately, skip all evaluations
        // however, if it does give any reference, it must be evaluated, case study: "How to configure a timeout when loading a huggingface dataset with python?"
        thisStep.isFinal = true;
        trivialQuestion = true;
        break
      }

      if (thisStep.references.length > 0) {
        const urls = thisStep.references?.filter(ref => !visitedURLs.includes(ref.url)).map(ref => ref.url) || [];
        const uniqueNewURLs = [...new Set(urls)];
        await processURLs(
          uniqueNewURLs,
          context,
          allKnowledge,
          allURLs,
          visitedURLs,
          badURLs,
          SchemaGen,
          currentQuestion
        );

        // remove references whose urls are in badURLs
        thisStep.references = thisStep.references.filter(ref => !badURLs.includes(ref.url));
      }

      updateContext({
        totalStep,
        question: currentQuestion,
        ...thisStep,
      });

      console.log(currentQuestion, evaluationMetrics[currentQuestion])
      let evaluation: EvaluationResponse = {pass: true, think: ''};
      if (evaluationMetrics[currentQuestion].length > 0) {
        // 跟踪评估过程开始
        context.actionTracker.trackThink('eval_first', SchemaGen.languageCode)
        // 调用evaluateAnswer函数评估回答质量
        evaluation = await evaluateAnswer(
          currentQuestion,
          thisStep,
          evaluationMetrics[currentQuestion].map(e => e.type),
          context,
          allKnowledge,
          SchemaGen
        ) || evaluation;
      }

      if (currentQuestion.trim() === question) {
        // 如果是原始问题，禁用编码以防止答案质量下降
        allowCoding = false;

        if (evaluation.pass) {
          // 评估通过，记录成功的回答步骤
          diaryContext.push(`
At step ${step}, you took **answer** action and finally found the answer to the original question:

Original question: 
${currentQuestion}

Your answer: 
${thisStep.answer}

The evaluator thinks your answer is good because: 
${evaluation.think}

Your journey ends here. You have successfully answered the original question. Congratulations! 🎉
`);
          // 标记当前步骤为最终答案
          thisStep.isFinal = true;
          break
        } else {
          // 评估失败，降低失败的评估类型的需求次数，并移除需求次数为0的评估类型
          evaluationMetrics[currentQuestion] = evaluationMetrics[currentQuestion].map(e => {
            if (e.type === evaluation.type) {
              e.numEvalsRequired--;
            }
            return e;
          }).filter(e => e.numEvalsRequired > 0);

          // 如果是严格评估失败，并且有改进计划，添加到最终答案改进建议
          if (evaluation.type === 'strict' && evaluation.improvement_plan) {
            finalAnswerPIP.push(evaluation.improvement_plan);
          }

          // 如果没有剩余评估类型，放弃尝试，转入野兽模式
          if (evaluationMetrics[currentQuestion].length === 0) {
            // failed so many times, give up, route to beast mode
            thisStep.isFinal = false;
            break
          }

          // 记录失败的回答步骤
          diaryContext.push(`
At step ${step}, you took **answer** action but evaluator thinks it is not a good answer:

Original question: 
${currentQuestion}

Your answer: 
${thisStep.answer}

The evaluator thinks your answer is bad because: 
${evaluation.think}
`);
          // 分析错误步骤，获取错误分析结果
          const errorAnalysis = await analyzeSteps(diaryContext, context, SchemaGen);

          // 将错误分析作为新知识添加
          allKnowledge.push({
            question: `
Why is the following answer bad for the question? Please reflect

<question>
${currentQuestion}
</question>

<answer>
${thisStep.answer}
</answer>
`,
            answer: `
${evaluation.think}

${errorAnalysis.recap}

${errorAnalysis.blame}

${errorAnalysis.improvement}
`,
            type: 'qa',
          })

          // 禁用下一步的回答动作，重置日记上下文，重置步骤计数
          allowAnswer = false;  // disable answer action in the immediate next step
          diaryContext = [];
          step = 0;
        }
      } else if (evaluation.pass) {
        // 如果是子问题且评估通过，记录解决子问题的步骤
        diaryContext.push(`
At step ${step}, you took **answer** action. You found a good answer to the sub-question:

Sub-question: 
${currentQuestion}

Your answer: 
${thisStep.answer}

The evaluator thinks your answer is good because: 
${evaluation.think}

Although you solved a sub-question, you still need to find the answer to the original question. You need to keep going.
`);
        // 将解决的子问题添加到知识库
        allKnowledge.push({
          question: currentQuestion,
          answer: thisStep.answer,
          references: thisStep.references,
          type: 'qa',
          updated: formatDateBasedOnType(new Date(), 'full')
        });
        // 从待解决问题列表中移除已解决的子问题
        gaps.splice(gaps.indexOf(currentQuestion), 1);
      }
    } else if (thisStep.action === 'reflect' && thisStep.questionsToAnswer) {
      // 对反思生成的问题进行去重，并限制数量
      thisStep.questionsToAnswer = chooseK((await dedupQueries(thisStep.questionsToAnswer, allQuestions, context.tokenTracker)).unique_queries, MAX_REFLECT_PER_STEP);
      const newGapQuestions = thisStep.questionsToAnswer
      if (newGapQuestions.length > 0) {
        // 如果找到新的子问题，记录这些问题
        diaryContext.push(`
At step ${step}, you took **reflect** and think about the knowledge gaps. You found some sub-questions are important to the question: "${currentQuestion}"
You realize you need to know the answers to the following sub-questions:
${newGapQuestions.map((q: string) => `- ${q}`).join('\n')}

You will now figure out the answers to these sub-questions and see if they can help you find the answer to the original question.
`);
        // 将新问题添加到待解决问题列表和所有问题列表
        gaps.push(...newGapQuestions);
        allQuestions.push(...newGapQuestions);
        updateContext({
          totalStep,
          ...thisStep,
        });

      } else {
        // 如果没有找到新问题，记录需要换一个思路
        diaryContext.push(`
At step ${step}, you took **reflect** and think about the knowledge gaps. You tried to break down the question "${currentQuestion}" into gap-questions like this: ${newGapQuestions.join(', ')} 
But then you realized you have asked them before. You decided to to think out of the box or cut from a completely different angle. 
`);
        updateContext({
          totalStep,
          ...thisStep,
          result: 'You have tried all possible questions and found no useful information. You must think out of the box or different angle!!!'
        });
      }
      // 禁用下一步的反思动作
      allowReflect = false;
    } else if (thisStep.action === 'search' && thisStep.searchRequests) {
      // 对搜索请求进行去重，并限制数量
      thisStep.searchRequests = chooseK((await dedupQueries(thisStep.searchRequests, [], context.tokenTracker)).unique_queries, MAX_QUERIES_PER_STEP);

      // 执行第一次搜索
      const {searchedQueries, newKnowledge} = await executeSearchQueries(
        thisStep.searchRequests.map(q => ({q})),
        context,
        allURLs,
        SchemaGen
      );

      // 记录已搜索的关键词和新获取的知识
      allKeywords.push(...searchedQueries);
      allKnowledge.push(...newKnowledge);

      // 将搜索结果合并为一段文本
      const soundBites = newKnowledge.map(k => k.answer).join(' ');

      // 使用初始搜索结果重写查询
      let keywordsQueries = await rewriteQuery(thisStep, soundBites, context, SchemaGen);
      const qOnly = keywordsQueries.filter(q => q.q).map(q => q.q)
      // 排除已搜索的查询，去重并限制数量
      const uniqQOnly = chooseK((await dedupQueries(qOnly, allKeywords, context.tokenTracker)).unique_queries, MAX_QUERIES_PER_STEP);
      keywordsQueries = keywordsQueries = uniqQOnly.map(q => {
        const matches = keywordsQueries.filter(kq => kq.q === q);
        // 如果有多个匹配项，保留原始查询作为更广泛的搜索
        return matches.length > 1 ? {q} : matches[0];
      }) as SERPQuery[];

      let anyResult = false;

      if (keywordsQueries.length > 0) {
        // 使用重写后的查询执行第二次搜索
        const {searchedQueries, newKnowledge} =
          await executeSearchQueries(
            keywordsQueries,
            context,
            allURLs,
            SchemaGen,
            onlyHostnames
          );

        if (searchedQueries.length > 0) {
          // 如果搜索成功，记录结果
          anyResult = true;
          allKeywords.push(...searchedQueries);
          allKnowledge.push(...newKnowledge);

          // 记录搜索步骤
          diaryContext.push(`
At step ${step}, you took the **search** action and look for external information for the question: "${currentQuestion}".
In particular, you tried to search for the following keywords: "${keywordsQueries.map(q => q.q).join(', ')}".
You found quite some information and add them to your URL list and **visit** them later when needed. 
`);

          // 更新上下文
          updateContext({
            totalStep,
            question: currentQuestion,
            ...thisStep,
            result: result
          });
        }
      }
      if (!anyResult || !keywordsQueries?.length) {
        // 如果搜索无结果，记录需要换一个思路
        diaryContext.push(`
At step ${step}, you took the **search** action and look for external information for the question: "${currentQuestion}".
In particular, you tried to search for the following keywords:  "${keywordsQueries.map(q => q.q).join(', ')}".
But then you realized you have already searched for these keywords before, no new information is returned.
You decided to think out of the box or cut from a completely different angle.
`);

        // 更新上下文
        updateContext({
          totalStep,
          ...thisStep,
          result: 'You have tried all possible queries and found no new information. You must think out of the box or different angle!!!'
        });
      }
      // 禁用下一步的搜索动作
      allowSearch = false;
    } else if (thisStep.action === 'visit' && thisStep.URLTargets?.length && urlList?.length) {
      // 标准化URL目标，过滤已访问的URL
      thisStep.URLTargets = (thisStep.URLTargets as number[])
        .map(idx => normalizeUrl(urlList[idx - 1]))
        .filter(url => url && !visitedURLs.includes(url)) as string[];

      // 添加高权重URL并去重，限制数量
      thisStep.URLTargets = [...new Set([...thisStep.URLTargets, ...weightedURLs.map(r => r.url!)])].slice(0, MAX_URLS_PER_STEP);

      const uniqueURLs = thisStep.URLTargets;
      console.log(uniqueURLs)

      if (uniqueURLs.length > 0) {
        // 处理URL，读取内容并添加到知识库
        const {urlResults, success} = await processURLs(
          uniqueURLs,
          context,
          allKnowledge,
          allURLs,
          visitedURLs,
          badURLs,
          SchemaGen,
          currentQuestion
        );

        // 根据处理结果记录不同的日记内容
        diaryContext.push(success
          ? `At step ${step}, you took the **visit** action and deep dive into the following URLs:
${urlResults.map(r => r?.url).join('\n')}
You found some useful information on the web and add them to your knowledge for future reference.`
          : `At step ${step}, you took the **visit** action and try to visit some URLs but failed to read the content. You need to think out of the box or cut from a completely different angle.`
        );

        // 更新上下文
        updateContext({
          totalStep,
          ...(success ? {
            question: currentQuestion,
            ...thisStep,
            result: urlResults
          } : {
            ...thisStep,
            result: 'You have tried all possible URLs and found no new information. You must think out of the box or different angle!!!'
          })
        });
      } else {
        // 如果没有新的URL可访问，记录需要换一个思路
        diaryContext.push(`
At step ${step}, you took the **visit** action. But then you realized you have already visited these URLs and you already know very well about their contents.
You decided to think out of the box or cut from a completely different angle.`);

        // 更新上下文
        updateContext({
          totalStep,
          ...thisStep,
          result: 'You have visited all possible URLs and found no new information. You must think out of the box or different angle!!!'
        });
      }
      // 禁用下一步的阅读动作
      allowRead = false;
    } else if (thisStep.action === 'coding' && thisStep.codingIssue) {
      // 创建代码沙箱实例，处理编码问题
      const sandbox = new CodeSandbox({allContext, URLs: weightedURLs.slice(0, 20), allKnowledge}, context, SchemaGen);
      try {
        // 尝试解决编码问题
        const result = await sandbox.solve(thisStep.codingIssue);
        // 将解决方案添加到知识库
        allKnowledge.push({
          question: `What is the solution to the coding issue: ${thisStep.codingIssue}?`,
          answer: result.solution.output,
          sourceCode: result.solution.code,
          type: 'coding',
          updated: formatDateBasedOnType(new Date(), 'full')
        });
        // 记录成功解决编码问题的步骤
        diaryContext.push(`
At step ${step}, you took the **coding** action and try to solve the coding issue: ${thisStep.codingIssue}.
You found the solution and add it to your knowledge for future reference.
`);
        // 更新上下文
        updateContext({
          totalStep,
          ...thisStep,
          result: result
        });
      } catch (error) {
        // 处理编码问题解决失败的情况
        console.error('Error solving coding issue:', error);
        diaryContext.push(`
At step ${step}, you took the **coding** action and try to solve the coding issue: ${thisStep.codingIssue}.
But unfortunately, you failed to solve the issue. You need to think out of the box or cut from a completely different angle.
`);
        // 更新上下文
        updateContext({
          totalStep,
          ...thisStep,
          result: 'You have tried all possible solutions and found no new information. You must think out of the box or different angle!!!'
        });
      } finally {
        // 禁用下一步的编码动作
        allowCoding = false;
      }
    }

    // 存储当前状态，以便调试和分析
    await storeContext(system, schema, {
      allContext,
      allKeywords,
      allQuestions,
      allKnowledge,
      weightedURLs,
      msgWithKnowledge
    }, totalStep);
    // 等待一段时间，避免过快请求
    await sleep(STEP_SLEEP);
  }

  if (!(thisStep as AnswerAction).isFinal) {
    // 如果未能找到最终答案，进入野兽模式（最后的人类救星）
    console.log('Enter Beast mode!!!')
    // any answer is better than no answer, humanity last resort
    step++;
    totalStep++;
    // 生成野兽模式提示，禁用所有动作，只允许回答
    const {system} = getPrompt(
      diaryContext,
      allQuestions,
      allKeywords,
      false, // allowReflect
      true,  // allowAnswer (覆盖为true)
      false, // allowRead
      false, // allowSearch
      false, // allowCoding
      allKnowledge,
      weightedURLs,
      true,  // beastMode
    );

    schema = SchemaGen.getAgentSchema(false, false, true, false, false, question);
    msgWithKnowledge = composeMsgs(messages, allKnowledge, question, finalAnswerPIP);

    const systemToBeast = system.replace('allowAnswer: false', 'allowAnswer: true');

    // 执行野兽模式回答
    const beastResponse = await getResponse(
      question,
      context,
      async () => ({
        messages: await composeMsgs(
          allKnowledge,
          [],
          question,
          true,
          context.tokenTracker
        ),
        system: systemToBeast,
        schema: schema,
      }),
      SchemaGen,
      async (r: ActionResponse) => {
        console.log('got beast response', r);
        thisStep.action = 'answer'
        thisStep.answer = r.answer
        thisStep.references = r.references
        thisStep.isFinal = true
      }, skipEval, finalAnswerPIP);
    console.log('beastResponse', beastResponse);

    // 更新最终步骤
    updateContext({
      totalStep,
      ...thisStep,
    });
  }

  if (!trivialQuestion) {
    (thisStep as AnswerAction).mdAnswer =
      repairMarkdownFinal(
        convertHtmlTablesToMd(
          fixBadURLMdLinks(
            fixCodeBlockIndentation(
              repairMarkdownFootnotesOuter(
                await repairUnknownChars(
                  buildMdFromAnswer(thisStep as AnswerAction), context))
            ),
            allURLs)));
  } else {
    (thisStep as AnswerAction).mdAnswer =
      convertHtmlTablesToMd(
        fixCodeBlockIndentation(
          buildMdFromAnswer((thisStep as AnswerAction)))
      );
  }

  console.log(thisStep)

  // max return 300 urls
  const returnedURLs = weightedURLs.slice(0, numReturnedURLs).map(r => r.url);
  return {
    result: thisStep,
    context,
    visitedURLs: returnedURLs,
    readURLs: visitedURLs.filter(url => !badURLs.includes(url)),
    allURLs: weightedURLs.map(r => r.url)
  };
}

/**
 * 存储上下文信息到文件系统中，以便调试和分析
 * @param system 系统提示内容
 * @param schema 动作模式定义
 * @param context 当前上下文包含所有状态信息
 * @param step 当前步骤数
 */
export async function storeContext(
  system: string,
  schema: z.ZodObject<any>,
  context: StepContext,
  step: number = 0
) {
  try {
    // 创建存储目录
    await mkdir('.context', { recursive: true });
    
    // 将各种上下文写入对应文件
    try {
      await writeFile(`.context/system-${step}.txt`, system, 'utf8');
      await writeFile(`.context/schema-${step}.json`, JSON.stringify(schema.shape, null, 2), 'utf8');
      await writeFile(`.context/context-${step}.json`, JSON.stringify({
        allContext: context.allContext,
        allKeywords: context.allKeywords,
        allQuestions: context.allQuestions,
        weightedURLs: (context.weightedURLs || [])?.map((r: any) => ({
          url: r?.url,
          title: r?.title,
          snippet: r?.snippet,
          weight: r?.weight,
        })),
        allKnowledge: context.allKnowledge,
      }, null, 2), 'utf8');
      await writeFile(`.context/msgs-${step}.json`, JSON.stringify(context.msgWithKnowledge, null, 2), 'utf8');
    } catch (e) {
      console.log('Failed to write context:', e);
    }
  } catch (error) {
    console.error('Error storing context:', error);
  }
}

/**
 * 主函数：处理命令行参数，调用getResponseWithContext获取回答
 */
export async function main() {
  // 从命令行参数获取问题
  const question = process.argv.slice(2).join(' ');
  if (!question) {
    console.log('Please provide a question');
    return;
  }

  // 初始化上下文追踪器和日期工具
  const tokenTracker = new TokenTracker({
    getTokenCount: (text) => {
      return Math.ceil(text.length / 3);
    }
  });
  const dateTools = new DateTools();
  
  // 初始化动作追踪器
  const actionTracker = new ActionTracker({
    searchLogs: [],
    urlLogs: [],
    answerLogs: [],
    reflectLogs: [],
    thinkLogs: [],
    readLogs: []
  });

  // 创建上下文对象
  const context = {
    actionTracker,
    dateTools,
    tokenTracker,
  }

  // 获取回答
  const response = await getResponse(question, context, false, true);
  
  // 如果有最终答案，输出结果
  if (response && response.action === 'answer' && response.answer) {
    console.log('Final answer:', response.answer);
    console.log('Visited URLs:');
    for (const url of response.visitedURLs || []) {
      console.log(' -', url);
    }
  } else {
    console.log('No answer found');
  }
}

// 如果当前文件是主模块，直接执行main函数
if (require.main === module) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}