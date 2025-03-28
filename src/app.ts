import express, {Request, Response, RequestHandler} from 'express';
import cors from 'cors';
import {getResponse} from './agent';
import {
  TrackerContext,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  AnswerAction,
  Model, StepAction, VisitAction
} from './types';
import {TokenTracker} from "./utils/token-tracker";
import {ActionTracker} from "./utils/action-tracker";
import {ObjectGeneratorSafe} from "./utils/safe-generator";
import {jsonSchema} from "ai"; // or another converter library

// 创建Express应用实例
const app = express();

// 从命令行参数获取可选的身份验证密钥
// Get secret from command line args for optional authentication
const secret = process.argv.find(arg => arg.startsWith('--secret='))?.split('=')[1];


// 启用跨域资源共享
app.use(cors());
// 配置JSON请求体解析器，限制请求体大小为10MB
app.use(express.json({
  limit: '10mb'
}));

// 添加健康检查端点，用于Docker容器验证
// Add health check endpoint for Docker container verification
app.get('/health', (req, res) => {
  res.json({status: 'ok'});
});

// 自然流式输出文本的异步生成器函数
async function* streamTextNaturally(text: string, streamingState: StreamingState) {
  // 将文本分割成保留CJK字符、URL和常规单词的块
  // Split text into chunks that preserve CJK characters, URLs, and regular words
  const chunks = splitTextIntoChunks(text);
  let burstMode = false;  // 爆发模式标志
  let consecutiveShortItems = 0;  // 连续短项计数

  for (const chunk of chunks) {
    // 如果不再处于流式传输状态，一次性输出剩余内容并返回
    if (!streamingState.currentlyStreaming) {
      yield chunks.slice(chunks.indexOf(chunk)).join('');
      return;
    }

    // 计算当前块的延迟时间
    const delay = calculateDelay(chunk, burstMode);

    // 处理连续的短项
    // Handle consecutive short items
    if (getEffectiveLength(chunk) <= 3 && chunk.trim().length > 0) {
      consecutiveShortItems++;
      // 如果连续3个或更多短项，进入爆发模式
      if (consecutiveShortItems >= 3) {
        burstMode = true;
      }
    } else {
      // 重置连续短项计数和爆发模式
      consecutiveShortItems = 0;
      burstMode = false;
    }

    // 等待一段时间，模拟真实打字速度
    await new Promise(resolve => setTimeout(resolve, delay));
    yield chunk;  // 输出当前块
  }
}

// 将文本分割成更小的块，保留特定特性
function splitTextIntoChunks(text: string): string[] {
  const chunks: string[] = [];
  let currentChunk = '';
  let inURL = false;  // URL标志

  // 辅助函数，将当前块添加到结果中
  const pushCurrentChunk = () => {
    if (currentChunk) {
      chunks.push(currentChunk);
      currentChunk = '';
    }
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1] || '';

    // URL检测
    if (char === 'h' && text.slice(i, i + 8).match(/https?:\/\//)) {
      pushCurrentChunk();
      inURL = true;
    }

    if (inURL) {
      currentChunk += char;
      // URL结束检测（空白或特定标点）
      if (/[\s\])}"']/.test(nextChar) || i === text.length - 1) {
        pushCurrentChunk();
        inURL = false;
      }
      continue;
    }

    // CJK字符检测（包括假名和韩文）
    if (/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(char)) {
      pushCurrentChunk();
      chunks.push(char);
      continue;
    }

    // 空白处理
    if (/\s/.test(char)) {
      pushCurrentChunk();
      chunks.push(char);
      continue;
    }

    // 常规单词构建
    currentChunk += char;

    // 在标点符号处断开
    if (/[.!?,;:]/.test(nextChar)) {
      pushCurrentChunk();
    }
  }

  // 确保最后的块也被添加
  pushCurrentChunk();
  return chunks.filter(chunk => chunk !== '');
}

// 计算块输出的延迟时间
function calculateDelay(chunk: string, burstMode: boolean): number {
  const trimmedChunk = chunk.trim();

  // 处理空白
  if (trimmedChunk.length === 0) {
    return Math.random() * 20 + 10;  // 10-30ms的随机延迟
  }

  // URL特殊处理
  if (chunk.match(/^https?:\/\//)) {
    return Math.random() * 50 + 10;  // URL输出较慢，10-60ms的随机延迟
  }

  // CJK字符特殊处理
  if (/^[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]$/.test(chunk)) {
    return Math.random() * 25 + 10;  // CJK字符单个输出较慢，10-35ms的随机延迟
  }

  // 基本延迟计算
  let baseDelay;
  if (burstMode) {
    baseDelay = Math.random() * 30 + 10;  // 爆发模式下10-40ms的随机延迟
  } else {
    const effectiveLength = getEffectiveLength(chunk);
    const perCharacterDelay = Math.max(10, 40 - effectiveLength * 2);
    baseDelay = Math.random() * perCharacterDelay + 10;
  }

  // 根据块特性添加变化
  if (/[A-Z]/.test(chunk[0])) {
    baseDelay += Math.random() * 20 + 10;  // 大写字母开头增加10-30ms的随机延迟
  }

  if (/[^a-zA-Z\s]/.test(chunk)) {
    baseDelay += Math.random() * 30 + 10;  // 非字母或空格字符增加10-40ms的随机延迟
  }

  // 标点符号的停顿
  if (/[.!?]$/.test(chunk)) {
    baseDelay += Math.random() * 200 + 10;  // 句末标点增加10-210ms的随机延迟
  } else if (/[,;:]$/.test(chunk)) {
    baseDelay += Math.random() * 100 + 10;  // 句中标点增加10-110ms的随机延迟
  }

  return baseDelay;
}

// 获取块的有效长度（考虑到CJK字符的宽度）
function getEffectiveLength(chunk: string): number {
  // 将CJK字符计为2个单位
  const cjkCount = (chunk.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const regularCount = chunk.length - cjkCount;
  return regularCount + (cjkCount * 2);
}

// 辅助函数，立即输出剩余内容
// Helper function to emit remaining content immediately
async function emitRemainingContent(
  res: Response,
  requestId: string,
  created: number,
  model: string,
  content: string,
) {
  if (!content) return;

  // 创建并发送包含剩余内容的响应块
  const chunk: ChatCompletionChunk = {
    id: requestId,
    object: 'chat.completion.chunk',
    created,
    model: model,
    system_fingerprint: 'fp_' + requestId,
    choices: [{
      index: 0,
      delta: {content, type: "think"},
      logprobs: null,
      finish_reason: null
    }],
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

interface StreamingState {
  currentlyStreaming: boolean;
  currentGenerator: AsyncGenerator<string> | null;
  remainingContent: string;
  isEmitting: boolean;
  queue: { content: string; resolve: () => void }[];
  processingQueue: boolean;
}

function getTokenBudgetAndMaxAttempts(
  reasoningEffort: 'low' | 'medium' | 'high' | null = 'medium',
  maxCompletionTokens: number | null = null
): { tokenBudget: number, maxBadAttempts: number } {
  if (maxCompletionTokens !== null) {
    return {
      tokenBudget: maxCompletionTokens,
      maxBadAttempts: 1 // Default to medium setting for max attempts
    };
  }

  switch (reasoningEffort) {
    case 'low':
      return {tokenBudget: 100000, maxBadAttempts: 1};
    case 'high':
      return {tokenBudget: 1000000, maxBadAttempts: 2};
    case 'medium':
    default:
      return {tokenBudget: 500000, maxBadAttempts: 1};
  }
}


async function completeCurrentStreaming(
  streamingState: StreamingState,
  res: Response,
  requestId: string,
  created: number,
  model: string
) {
  if (streamingState.currentlyStreaming && streamingState.remainingContent) {
    // Force completion of current streaming
    await emitRemainingContent(
      res,
      requestId,
      created,
      model,
      streamingState.remainingContent
    );
    // Reset streaming state
    streamingState.currentlyStreaming = false;
    streamingState.remainingContent = '';
    streamingState.currentGenerator = null;
  }
}

// OpenAI-compatible chat completions endpoint
// Models API endpoints
app.get('/v1/models', (async (_req: Request, res: Response) => {
  const models: Model[] = [{
    id: 'jina-deepsearch-v1',
    object: 'model',
    created: 1686935002,
    owned_by: 'jina-ai'
  }];

  res.json({
    object: 'list',
    data: models
  });
}) as RequestHandler);

app.get('/v1/models/:model', (async (req: Request, res: Response) => {
  const modelId = req.params.model;

  if (modelId === 'jina-deepsearch-v1') {
    res.json({
      id: 'jina-deepsearch-v1',
      object: 'model',
      created: 1686935002,
      owned_by: 'jina-ai'
    });
  } else {
    res.status(404).json({
      error: {
        message: `Model '${modelId}' not found`,
        type: 'invalid_request_error',
        param: null,
        code: 'model_not_found'
      }
    });
  }
}) as RequestHandler);

if (secret) {
  // Check authentication only if secret is set
  app.use((req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.split(' ')[1] !== secret) {
      console.log('[chat/completions] Unauthorized request');
      res.status(401).json({error: 'Unauthorized'});
      return;
    }

    return next();
  });
}

async function processQueue(streamingState: StreamingState, res: Response, requestId: string, created: number, model: string) {
  if (streamingState.processingQueue) return;

  streamingState.processingQueue = true;

  while (streamingState.queue.length > 0) {
    const current = streamingState.queue[0];

    // Clear any previous state
    streamingState.remainingContent = '';  // Add this line

    // Reset streaming state for new content
    streamingState.currentlyStreaming = true;
    streamingState.remainingContent = current.content;
    streamingState.isEmitting = true;

    try {
      // Add a check to prevent duplicate streaming
      if (streamingState.currentGenerator) {
        streamingState.currentGenerator = null;  // Add this line
      }

      for await (const word of streamTextNaturally(current.content, streamingState)) {
        const chunk: ChatCompletionChunk = {
          id: requestId,
          object: 'chat.completion.chunk',
          created,
          model,
          system_fingerprint: 'fp_' + requestId,
          choices: [{
            index: 0,
            delta: {content: word, type: 'think'},
            logprobs: null,
            finish_reason: null
          }]
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
    } catch (error) {
      console.error('Error in streaming:', error);
    } finally {
      // Clear state before moving to next item
      streamingState.isEmitting = false;
      streamingState.currentlyStreaming = false;
      streamingState.remainingContent = '';
      streamingState.queue.shift();
      current.resolve();
    }
  }

  streamingState.processingQueue = false;
}

app.post('/v1/chat/completions', (async (req: Request, res: Response) => {
  // Check authentication only if secret is set
  if (secret) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.split(' ')[1] !== secret) {
      console.log('[chat/completions] Unauthorized request');
      res.status(401).json({error: 'Unauthorized'});
      return;
    }
  }

  // Log request details (excluding sensitive data)
  console.log('[chat/completions] Request:', {
    model: req.body.model,
    stream: req.body.stream,
    messageCount: req.body.messages?.length,
    hasAuth: !!req.headers.authorization,
    requestId: Date.now().toString()
  });

  const body = req.body as ChatCompletionRequest;
  if (!body.messages?.length) {
    return res.status(400).json({error: 'Messages array is required and must not be empty'});
  }
  const lastMessage = body.messages[body.messages.length - 1];
  if (lastMessage.role !== 'user') {
    return res.status(400).json({error: 'Last message must be from user'});
  }

  console.log('messages', JSON.stringify(body.messages));

  // clean <think> from all assistant messages
  body.messages = body.messages?.filter(message => {
    if (message.role === 'assistant') {
      // 2 cases message.content can be a string or an array
      if (typeof message.content === 'string') {
        message.content = (message.content as string).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        // Filter out the message if the content is empty after <think> removal
        return message.content !== '';
      } else if (Array.isArray(message.content)) {
        // find all type: text and clean <think> from .text
        message.content.forEach((content: any) => {
          if (content.type === 'text') {
            content.text = (content.text as string).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
          }
        });
        //Filter out any content objects in the array that now have null/undefined/empty text.
        message.content = message.content.filter((content: any) =>
          !(content.type === 'text' && content.text === '')
        );

        //Filter out the message if the array is now empty
        return message.content.length > 0;
      }
      return true; // Keep the message if it's not an assistant message, or if assistant message has non string or array content.
    } else if (message.role === 'user' && Array.isArray(message.content)) {
      message.content = message.content.map((content: any) => {
        if (content.type === 'image_url') {
          return {
            type: 'image',
            image: content.image_url?.url || '',
          }
        }
        return content;
      });
      return true;
    } else if (message.role === 'system') {
      if (Array.isArray(message.content)) {
        message.content = message.content.map((content: any) => `${content.text || content}`).join(' ');
      }
      return true;
    }
    return true; // Keep other messages
  });

  let {tokenBudget, maxBadAttempts} = getTokenBudgetAndMaxAttempts(
    body.reasoning_effort,
    body.max_completion_tokens
  );

  if (body.budget_tokens) {
    tokenBudget = body.budget_tokens;
  }
  if (body.max_attempts) {
    maxBadAttempts = body.max_attempts;
  }

  let responseSchema = undefined;
  if (body.response_format?.json_schema) {
    // Convert JSON schema to Zod schema using a proper converter
    try {
      responseSchema = jsonSchema(body.response_format.json_schema);
      console.log(responseSchema)
    } catch (error: any) {
      return res.status(400).json({error: `Invalid JSON schema: ${error.message}`});
    }
  }

  const requestId = Date.now().toString();
  const created = Math.floor(Date.now() / 1000);
  const context: TrackerContext = {
    tokenTracker: new TokenTracker(),
    actionTracker: new ActionTracker()
  };

  // Add this inside the chat completions endpoint, before setting up the action listener
  const streamingState: StreamingState = {
    currentlyStreaming: false,
    currentGenerator: null,
    remainingContent: '',
    isEmitting: false,
    queue: [],
    processingQueue: false
  };

  if (body.stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');


    // Send initial chunk with opening think tag
    const initialChunk: ChatCompletionChunk = {
      id: requestId,
      object: 'chat.completion.chunk',
      created,
      model: body.model,
      system_fingerprint: 'fp_' + requestId,
      choices: [{
        index: 0,
        delta: {role: 'assistant', content: '<think>', type: 'think'},
        logprobs: null,
        finish_reason: null
      }]
    };
    res.write(`data: ${JSON.stringify(initialChunk)}\n\n`);

    // Set up progress listener with cleanup
    const actionListener = async (step: StepAction) => {
      // Add content to queue for both thinking steps and final answer
      if (step.action === 'visit') {
        // emit every url in the visit action in url field
        ((step as VisitAction).URLTargets as string[]).forEach((url) => {
          const chunk: ChatCompletionChunk = {
            id: requestId,
            object: 'chat.completion.chunk',
            created,
            model: body.model,
            system_fingerprint: 'fp_' + requestId,
            choices: [{
              index: 0,
              delta: {type: 'think', url},
              logprobs: null,
              finish_reason: null,
            }]
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        });
      }
      if (step.think) {
        // if not ends with a space, add one
        const content = step.think + ' ';
        await new Promise<void>(resolve => {
          streamingState.queue.push({
            content,
            resolve
          });
          // Single call to process queue is sufficient
          processQueue(streamingState, res, requestId, created, body.model);
        });
      }
    };
    context.actionTracker.on('action', actionListener);

    // Make sure to update the cleanup code
    res.on('finish', () => {
      streamingState.currentlyStreaming = false;
      streamingState.currentGenerator = null;
      streamingState.remainingContent = '';
      context.actionTracker.removeListener('action', actionListener);
    });
  }

  try {
    const {
      result: finalStep,
      visitedURLs,
      readURLs,
      allURLs
    } = await getResponse(undefined,
      tokenBudget,
      maxBadAttempts,
      context,
      body.messages,
      body.max_returned_urls,
      body.no_direct_answer,
      body.boost_hostnames,
      body.bad_hostnames,
      body.only_hostnames,
      )
    let finalAnswer = (finalStep as AnswerAction).mdAnswer;

    const annotations = (finalStep as AnswerAction).references?.map(ref => ({
      type: 'url_citation' as const,
      url_citation: {
        title: ref.title,
        exactQuote: ref.exactQuote,
        url: ref.url,
        dateTime: ref.dateTime,
      }
    }))


    if (responseSchema) {
      try {
        const generator = new ObjectGeneratorSafe(context?.tokenTracker);
        const result = await generator.generateObject({
          model: 'agent',
          schema: responseSchema,
          prompt: finalAnswer,
          system: "Extract the structured data from the text according to the JSON schema.",
        });

        // Use the generated object as the response content
        finalAnswer = JSON.stringify(result.object, null, 2);
        console.log('Generated object:', finalAnswer)
      } catch (error) {
        console.error('Error processing response with schema:', error);
      }
    }

    const usage = context.tokenTracker.getTotalUsageSnakeCase();
    if (body.stream) {
      // Complete any ongoing streaming before sending final answer
      await completeCurrentStreaming(streamingState, res, requestId, created, body.model);
      // Send closing think tag
      const closeThinkChunk: ChatCompletionChunk = {
        id: requestId,
        object: 'chat.completion.chunk',
        created,
        model: body.model,
        system_fingerprint: 'fp_' + requestId,
        choices: [{
          index: 0,
          delta: {content: `</think>\n\n`, type: 'think'},
          logprobs: null,
          finish_reason: 'thinking_end'
        }]
      };
      res.write(`data: ${JSON.stringify(closeThinkChunk)}\n\n`);

      // After the content is fully streamed, send the final chunk with finish_reason and usage
      const finalChunk: ChatCompletionChunk = {
        id: requestId,
        object: 'chat.completion.chunk',
        created,
        model: body.model,
        system_fingerprint: 'fp_' + requestId,
        choices: [{
          index: 0,
          delta: {
            content: finalAnswer,
            type: responseSchema ? 'json' : 'text',
            annotations,
          },
          logprobs: null,
          finish_reason: 'stop'
        }],
        usage,
        visitedURLs,
        readURLs,
        numURLs: allURLs.length
      };
      res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
      res.end();
    } else {

      const response: ChatCompletionResponse = {
        id: requestId,
        object: 'chat.completion',
        created,
        model: body.model,
        system_fingerprint: 'fp_' + requestId,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: finalStep.action === 'answer' ? (finalAnswer || '') : finalStep.think,
            type: responseSchema ? 'json' : 'text',
            annotations,
          },
          logprobs: null,
          finish_reason: 'stop'
        }],
        usage,
        visitedURLs,
        readURLs,
        numURLs: allURLs.length
      };

      // Log final response (excluding full content for brevity)
      console.log('[chat/completions] Response:', {
        id: response.id,
        status: 200,
        contentLength: response.choices[0].message.content.length,
        usage: response.usage,
        visitedURLs: response.visitedURLs,
        readURLs: response.readURLs,
        numURLs: allURLs.length
      });

      res.json(response);
    }
  } catch (error: any) {
    // Log error details
    console.error('[chat/completions] Error:', {
      message: error?.message || 'An error occurred',
      stack: error?.stack,
      type: error?.constructor?.name,
      requestId
    });

    // Track error as rejected tokens with Vercel token counting
    const errorMessage = error?.message || 'An error occurred';

    // Clean up event listeners
    context.actionTracker.removeAllListeners('action');

    // Get token usage in OpenAI API format
    const usage = context.tokenTracker.getTotalUsageSnakeCase();

    if (body.stream && res.headersSent) {
      // For streaming responses that have already started, send error as a chunk
      // First send closing think tag if we're in the middle of thinking
      const closeThinkChunk: ChatCompletionChunk = {
        id: requestId,
        object: 'chat.completion.chunk',
        created,
        model: body.model,
        system_fingerprint: 'fp_' + requestId,
        choices: [{
          index: 0,
          delta: {content: '</think>', type: 'think'},
          logprobs: null,
          finish_reason: 'error'
        }],
        usage,
      };
      res.write(`data: ${JSON.stringify(closeThinkChunk)}\n\n`);


      const errorChunk: ChatCompletionChunk = {
        id: requestId,
        object: 'chat.completion.chunk',
        created,
        model: body.model,
        system_fingerprint: 'fp_' + requestId,
        choices: [{
          index: 0,
          delta: {content: errorMessage, type: 'error'},
          logprobs: null,
          finish_reason: 'error'
        }],
        usage
      };
      res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
      res.end();
    } else {
      // For non-streaming or not-yet-started responses, send error as JSON
      const response: ChatCompletionResponse = {
        id: requestId,
        object: 'chat.completion',
        created,
        model: body.model,
        system_fingerprint: 'fp_' + requestId,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: `Error: ${errorMessage}`,
            type: 'error'
          },
          logprobs: null,
          finish_reason: 'error'
        }],
        usage,
      };
      res.json(response);
    }
  }
}) as RequestHandler);


export default app;
