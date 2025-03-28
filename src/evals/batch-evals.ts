import fs from 'fs/promises';
import {exec} from 'child_process';
import {promisify} from 'util';
import {getResponse} from '../agent';
import {generateObject} from 'ai';
import {GEMINI_API_KEY} from '../config';
import {z} from 'zod';
import {AnswerAction, TrackerContext} from "../types";
import {createGoogleGenerativeAI} from "@ai-sdk/google";

// 将exec函数转换为基于Promise的异步函数
const execAsync = promisify(exec);

// 问题接口，包含问题和预期答案
interface Question {
  question: string;   // 问题
  answer: string;     // 预期答案
}

// 评估结果接口，记录单个问题的评估结果
interface EvaluationResult {
  pass: boolean;           // 是否通过评估
  reason: string;          // 评估结果的原因
  total_steps: number;     // 总步骤数
  total_tokens: number;    // 总令牌数
  question: string;        // 问题
  expected_answer: string; // 预期答案
  actual_answer: string;   // 实际答案
}

// 评估统计接口，记录整体评估结果的统计数据
interface EvaluationStats {
  model_name: string;      // 模型名称
  pass_rate: number;       // 通过率
  avg_steps: number;       // 平均步骤数
  max_steps: number;       // 最大步骤数
  min_steps: number;       // 最小步骤数
  median_steps: number;    // 中位数步骤数
  avg_tokens: number;      // 平均令牌数
  median_tokens: number;   // 中位数令牌数
  max_tokens: number;      // 最大令牌数
  min_tokens: number;      // 最小令牌数
}

// 计算中位数的函数
function calculateMedian(numbers: number[]): number {
  const sorted = [...numbers].sort((a, b) => a - b); // 先对数组进行排序
  const middle = Math.floor(sorted.length / 2);      // 找到中间位置

  // 如果数组长度是偶数，则中位数是中间两个数的平均值
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  // 如果数组长度是奇数，则中位数是中间的数
  return sorted[middle];
}

// 根据评估结果计算统计数据
function calculateStats(results: EvaluationResult[], modelName: string): EvaluationStats {
  const steps = results.map(r => r.total_steps);     // 提取所有步骤数
  const tokens = results.map(r => r.total_tokens);   // 提取所有令牌数
  const passCount = results.filter(r => r.pass).length; // 计算通过数量

  // 返回统计结果
  return {
    model_name: modelName,
    pass_rate: (passCount / results.length) * 100,            // 计算通过率（百分比）
    avg_steps: steps.reduce((a, b) => a + b, 0) / steps.length, // 计算平均步骤数
    max_steps: Math.max(...steps),                           // 最大步骤数
    min_steps: Math.min(...steps),                           // 最小步骤数
    median_steps: calculateMedian(steps),                    // 中位数步骤数
    avg_tokens: tokens.reduce((a, b) => a + b, 0) / tokens.length, // 计算平均令牌数
    median_tokens: calculateMedian(tokens),                  // 中位数令牌数
    max_tokens: Math.max(...tokens),                         // 最大令牌数
    min_tokens: Math.min(...tokens)                          // 最小令牌数
  };
}

// 打印统计结果到控制台
function printStats(stats: EvaluationStats): void {
  console.log('\n=== Evaluation Statistics ===');
  console.log(`Model: ${stats.model_name}`);
  console.log(`Pass Rate: ${stats.pass_rate.toFixed(0)}%`);           // 通过率，保留0位小数
  console.log(`Average Steps: ${stats.avg_steps.toFixed(0)}`);        // 平均步骤数，保留0位小数
  console.log(`Maximum Steps: ${stats.max_steps}`);
  console.log(`Minimum Steps: ${stats.min_steps}`);
  console.log(`Median Steps: ${stats.median_steps.toFixed(0)}`);      // 中位数步骤数，保留0位小数
  console.log(`Average Tokens: ${stats.avg_tokens.toFixed(0)}`);      // 平均令牌数，保留0位小数
  console.log(`Median Tokens: ${stats.median_tokens.toFixed(0)}`);    // 中位数令牌数，保留0位小数
  console.log(`Maximum Tokens: ${stats.max_tokens}`);
  console.log(`Minimum Tokens: ${stats.min_tokens}`);
  console.log('===========================\n');
}

// 获取当前Git提交的哈希（短版本）
async function getCurrentGitCommit(): Promise<string> {
  try {
    // 执行git命令获取当前提交的短哈希
    const {stdout} = await execAsync('git rev-parse --short HEAD');
    return stdout.trim();
  } catch (error) {
    console.error('Error getting git commit:', error);
    return 'unknown'; // 如果出错则返回"unknown"
  }
}

// 使用语言模型评估答案是否符合预期
async function evaluateAnswer(expectedAnswer: string, actualAnswer: string): Promise<{ pass: boolean; reason: string }> {
  // 构建评估提示，要求语言模型比较预期答案和实际答案
  const prompt = `You are a deterministic evaluator with zero temperature. Compare the following expected answer with the actual answer and determine if they convey the same information.

Expected answer: ${expectedAnswer}
Actual answer: ${actualAnswer}

Minor wording differences are acceptable as long as the core information of the expected answer is preserved in the actual answer.'`;

  // 定义评估结果的结构模式
  const schema = z.object({
    pass: z.boolean().describe('Whether the actual answer matches the expected answer'),
    reason: z.string().describe('Detailed explanation of why the evaluation passed or failed')
  });

  try {
    // 调用AI模型进行评估
    const result = await generateObject({
      model: createGoogleGenerativeAI({ apiKey: GEMINI_API_KEY })('gemini-2.0-flash'),  // 使用gemini-2.0-flash模型进行评估
      schema,
      prompt,
      maxTokens: 1000,
      temperature: 0  // 设置温度为0，确保确定性输出
    });

    return result.object;
  } catch (error) {
    // 如果评估过程出错，返回失败结果
    console.error('Evaluation failed:', error);
    return {
      pass: false,
      reason: `Evaluation error: ${error}`
    };
  }
}

// 批量评估函数，处理指定文件中的所有问题
async function batchEvaluate(inputFile: string): Promise<void> {
  // 读取并解析输入文件
  const questions: Question[] = JSON.parse(await fs.readFile(inputFile, 'utf-8'));
  const results: EvaluationResult[] = [];
  const gitCommit = await getCurrentGitCommit();
  const modelName = process.env.DEFAULT_MODEL_NAME || 'unknown';
  const outputFile = `eval-${gitCommit}-${modelName}.json`; // 输出文件名包含Git提交和模型名称

  // 处理每个问题
  for (let i = 0; i < questions.length; i++) {
    const {question, answer: expectedAnswer} = questions[i];
    console.log(`\nProcessing question ${i + 1}/${questions.length}: ${question}`);

    try {
      // 使用agent获取响应
      const {
        result: response,
        context
      } = await getResponse(question) as { result: AnswerAction; context: TrackerContext };

      // 使用流式agent获取响应的另一种方式（已注释）
      // const {
      //   result: response,
      //   context
      // } = await getResponseStreamingAgent(question) as { result: AnswerAction; context: TrackerContext };

      const actualAnswer = response.answer;

      // 评估响应
      const evaluation = await evaluateAnswer(expectedAnswer, actualAnswer);

      // 记录结果
      results.push({
        pass: evaluation.pass,
        reason: evaluation.reason,
        total_steps: context.actionTracker.getState().totalStep,
        total_tokens: context.tokenTracker.getTotalUsage().totalTokens,
        question,
        expected_answer: expectedAnswer,
        actual_answer: actualAnswer
      });

      console.log(`Evaluation: ${evaluation.pass ? 'PASS' : 'FAIL'}`);
      console.log(`Reason: ${evaluation.reason}`);
    } catch (error) {
      // 处理错误情况
      console.error(`Error processing question: ${question}`, error);
      results.push({
        pass: false,
        reason: `Error: ${error}`,
        total_steps: 0,
        total_tokens: 0,
        question,
        expected_answer: expectedAnswer,
        actual_answer: 'Error occurred'
      });
    }
  }

  // 计算并打印统计数据
  const stats = calculateStats(results, modelName);
  printStats(stats);

  // 保存结果到文件
  await fs.writeFile(outputFile, JSON.stringify({
    results,
    statistics: stats
  }, null, 2));

  console.log(`\nEvaluation results saved to ${outputFile}`);
}

// 如果这是主模块，则运行批量评估
if (require.main === module) {
  const inputFile = process.argv[2];
  if (!inputFile) {
    console.error('Please provide an input file path');
    process.exit(1);
  }

  batchEvaluate(inputFile).catch(console.error);
}

export {batchEvaluate};
