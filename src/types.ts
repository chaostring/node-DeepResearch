// Action Types
// 动作类型
import {CoreMessage, LanguageModelUsage} from "ai";

// 基础动作类型，所有动作的基础接口
type BaseAction = {
  action: "search" | "answer" | "reflect" | "visit" | "coding"; // 动作类型：搜索、回答、反思、访问、编码
  think: string; // 思考过程
};

// 搜索引擎查询接口
export type SERPQuery = {
  q: string,      // 查询字符串
  hl?: string,    // 结果的语言（可选）
  gl?: string,    // 地理位置（可选）
  location?: string, // 具体位置（可选）
  tbs?: string,   // 时间-日期过滤（可选）
}

// 搜索动作接口，继承自BaseAction
export type SearchAction = BaseAction & {
  action: "search"; // 动作类型固定为search
  searchRequests: string[]; // 搜索请求列表
};

// 引用来源接口
export type Reference = {
    exactQuote: string;   // 精确引用的文本
    url: string;          // 引用的URL
    title: string;        // 引用的标题
    dateTime?: string;    // 引用的时间（可选）
  }

// 回答动作接口，继承自BaseAction
export type AnswerAction = BaseAction & {
  action: "answer";      // 动作类型固定为answer
  answer: string;        // 回答内容
  references: Array<Reference>; // 引用来源列表
  isFinal?: boolean;     // 是否为最终答案（可选）
  mdAnswer?: string;     // Markdown格式的回答（可选）
};

// 知识项接口
export type KnowledgeItem = {
  question: string,       // 问题
  answer: string,         // 回答
  references?: Array<Reference> | Array<any>; // 引用来源（可选）
  type: 'qa' | 'side-info' | 'chat-history' | 'url' | 'coding', // 知识类型：问答、侧边信息、聊天历史、URL、编码
  updated?: string,       // 更新时间（可选）
  sourceCode?: string,    // 源代码（可选）
}

// 反思动作接口，继承自BaseAction
export type ReflectAction = BaseAction & {
  action: "reflect";      // 动作类型固定为reflect
  questionsToAnswer: string[]; // 需要回答的问题列表
};

// 访问动作接口，继承自BaseAction
export type VisitAction = BaseAction & {
  action: "visit";        // 动作类型固定为visit
  URLTargets: number[] | string[]; // URL目标列表，可以是索引或URL字符串
};

// 编码动作接口，继承自BaseAction
export type CodingAction = BaseAction & {
  action: "coding";       // 动作类型固定为coding
  codingIssue: string;    // 编码问题描述
};

// 步骤动作类型，可以是上述任一具体动作类型
export type StepAction = SearchAction | AnswerAction | ReflectAction | VisitAction | CodingAction;

// 评估类型
export type EvaluationType = 'definitive' | 'freshness' | 'plurality' | 'attribution' | 'completeness' | 'strict';

// 重复评估类型接口
export type RepeatEvaluationType = {
    type: EvaluationType;  // 评估类型
    numEvalsRequired: number; // 需要的评估次数
}

// 遵循Vercel AI SDK的令牌计数接口
// Following Vercel AI SDK's token counting interface
export interface TokenUsage {
  tool: string;            // 工具名称
  usage: LanguageModelUsage; // 语言模型使用情况
}

// 搜索响应接口
export interface SearchResponse {
  code: number;            // 响应代码
  status: number;          // 状态码
  data: Array<{            // 数据数组
    title: string;         // 标题
    description: string;   // 描述
    url: string;           // URL
    content: string;       // 内容
    usage: { tokens: number; }; // 使用的令牌数
  }> | null;
  name?: string;           // 名称（可选）
  message?: string;        // 消息（可选）
  readableMessage?: string; // 可读消息（可选）
}

// Brave搜索响应接口
export interface BraveSearchResponse {
  web: {
    results: Array<{
      title: string;       // 标题
      description: string; // 描述
      url: string;         // URL
    }>;
  };
}

// Serper搜索响应接口
export interface SerperSearchResponse {
  knowledgeGraph?: {        // 知识图谱（可选）
    title: string;          // 标题
    type: string;           // 类型
    website: string;        // 网站
    imageUrl: string;       // 图片URL
    description: string;    // 描述
    descriptionSource: string; // 描述来源
    descriptionLink: string; // 描述链接
    attributes: { [k: string]: string; }; // 属性
  },
  organic: {                // 有机搜索结果
    title: string;          // 标题
    link: string;           // 链接
    snippet: string;        // 摘要
    date: string;           // 日期
    siteLinks?: { title: string; link: string; }[]; // 网站链接（可选）
    position: number,       // 位置
  }[];
  topStories?: {            // 热门故事（可选）
    title: string;          // 标题
    link: string;           // 链接
    source: string;         // 来源
    data: string;           // 数据
    imageUrl: string;       // 图片URL
  }[];
  relatedSearches?: string[]; // 相关搜索（可选）
  credits: number;          // 积分
}

// 读取响应接口
export interface ReadResponse {
  code: number;              // 响应代码
  status: number;            // 状态码
  data?: {                   // 数据（可选）
    title: string;           // 标题
    description: string;     // 描述
    url: string;             // URL
    content: string;         // 内容
    usage: { tokens: number; }; // 使用的令牌数
    links: Array<[string, string]>; // 链接数组 [锚文本, URL]
  };
  name?: string;             // 名称（可选）
  message?: string;          // 消息（可选）
  readableMessage?: string;  // 可读消息（可选）
}

// 评估响应接口
export type EvaluationResponse = {
  pass: boolean;             // 是否通过
  think: string;             // 思考过程
  type?: EvaluationType;     // 评估类型（可选）
  freshness_analysis?: {     // 新鲜度分析（可选）
    days_ago: number;        // 几天前
    max_age_days?: number;   // 最大允许天数（可选）
  };
  plurality_analysis?: {     // 多样性分析（可选）
    minimum_count_required: number; // 最小需要数量
    actual_count_provided: number;  // 实际提供数量
  };
  exactQuote?: string;       // 精确引用（可选）
  completeness_analysis?: {  // 完整性分析（可选）
    aspects_expected: string, // 预期方面
    aspects_provided: string, // 提供方面
  },
  improvement_plan?: string; // 改进计划（可选）
};

// 代码生成响应接口
export type CodeGenResponse = {
  think: string;             // 思考过程
  code: string;              // 生成的代码
}

// 错误分析响应接口
export type ErrorAnalysisResponse = {
  recap: string;             // 概述
  blame: string;             // 责任归属
  improvement: string;       // 改进建议
};

// 未标准化的搜索片段接口
export type UnNormalizedSearchSnippet = {
  title: string;             // 标题
  url?: string;              // URL（可选）
  description?: string;      // 描述（可选）
  link?: string;             // 链接（可选）
  snippet?: string;          // 摘要（可选）
  weight?: number,           // 权重（可选）
  date?: string              // 日期（可选）
};

// 搜索片段接口，继承自UnNormalizedSearchSnippet
export type SearchSnippet = UnNormalizedSearchSnippet& {
  url: string;               // URL（必需）
  description: string;       // 描述（必需）
};

// 提升的搜索片段接口，继承自SearchSnippet
export type BoostedSearchSnippet = SearchSnippet & {
  freqBoost: number;         // 频率提升
  hostnameBoost: number;     // 主机名提升
  pathBoost: number;         // 路径提升
  jinaRerankBoost: number;   // Jina重排序提升
  finalScore: number;        // 最终得分
}

// OpenAI API 类型
// OpenAI API Types
export interface Model {
  id: string;              // 模型ID
  object: 'model';         // 对象类型固定为'model'
  created: number;         // 创建时间戳
  owned_by: string;        // 拥有者
}

// 提示对，包含系统提示和用户提示
export type PromptPair = { system: string, user: string };

// 响应格式类型
export type ResponseFormat = {
  type: 'json_schema' | 'json_object'; // 格式类型：JSON模式或JSON对象
  json_schema?: any;      // JSON模式（可选）
}

// 聊天完成请求接口
export interface ChatCompletionRequest {
  model: string;           // 模型名称
  messages: Array<CoreMessage>; // 消息数组
  stream?: boolean;        // 是否流式返回（可选）
  reasoning_effort?: 'low' | 'medium' | 'high'; // 推理努力程度（可选）
  max_completion_tokens?: number; // 最大完成令牌数（可选）

  budget_tokens?: number;  // 令牌预算（可选）
  max_attempts?: number;   // 最大尝试次数（可选）

  response_format?: ResponseFormat; // 响应格式（可选）
  no_direct_answer?: boolean; // 禁止直接回答（可选）
  max_returned_urls?: number; // 最大返回URL数（可选）

  boost_hostnames?: string[]; // 提升的主机名列表（可选）
  bad_hostnames?: string[];   // 不良主机名列表（可选）
  only_hostnames?: string[];  // 限定主机名列表（可选）
}

// URL注释接口
export interface URLAnnotation {
  type: 'url_citation',    // 类型固定为'url_citation'
  url_citation: Reference  // URL引用
}

// 聊天完成响应接口
export interface ChatCompletionResponse {
  id: string;              // 响应ID
  object: 'chat.completion'; // 对象类型固定为'chat.completion'
  created: number;         // 创建时间戳
  model: string;           // 使用的模型
  system_fingerprint: string; // 系统指纹
  choices: Array<{         // 选择数组
    index: number;         // 索引
    message: {             // 消息
      role: 'assistant';   // 角色固定为'assistant'
      content: string;     // 内容
      type: 'text' | 'think' | 'json' | 'error'; // 类型：文本、思考、JSON或错误
      annotations?: Array<URLAnnotation>; // 注释（可选）
    };
    logprobs: null;        // 日志概率（空）
    finish_reason: 'stop' | 'error'; // 结束原因：停止或错误
  }>;
  usage: {                 // 使用情况
    prompt_tokens: number; // 提示令牌数
    completion_tokens: number; // 完成令牌数
    total_tokens: number;  // 总令牌数
  };
  visitedURLs?: string[];  // 访问的URL列表（可选）
  readURLs?: string[];     // 读取的URL列表（可选）
  numURLs?: number;        // URL数量（可选）
}

// 聊天完成块接口（用于流式响应）
export interface ChatCompletionChunk {
  id: string;              // 块ID
  object: 'chat.completion.chunk'; // 对象类型固定为'chat.completion.chunk'
  created: number;         // 创建时间戳
  model: string;           // 使用的模型
  system_fingerprint: string; // 系统指纹
  choices: Array<{         // 选择数组
    index: number;         // 索引
    delta: {               // 增量
      role?: 'assistant';  // 角色，可选，固定为'assistant'
      content?: string;    // 内容（可选）
      type?: 'text' | 'think' | 'json' | 'error'; // 类型：文本、思考、JSON或错误（可选）
      url?: string;        // URL（可选）
      annotations?: Array<URLAnnotation>; // 注释（可选）
    };
    logprobs: null;        // 日志概率（空）
    finish_reason: null | 'stop' | 'thinking_end' | 'error'; // 结束原因：空、停止、思考结束或错误
  }>;
  usage?: any;             // 使用情况（可选）
  visitedURLs?: string[];  // 访问的URL列表（可选）
  readURLs?: string[];     // 读取的URL列表（可选）
  numURLs?: number;        // URL数量（可选）
}

// Tracker Types
import {TokenTracker} from './utils/token-tracker';
import {ActionTracker} from './utils/action-tracker';

// 跟踪器上下文接口
export interface TrackerContext {
  tokenTracker: TokenTracker; // 令牌跟踪器
  actionTracker: ActionTracker; // 动作跟踪器
}

