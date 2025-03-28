#!/usr/bin/env node
// 引入必要的依赖
import { Command } from 'commander';
import { getResponse } from './agent';
import { version } from '../package.json';

// 创建命令行程序实例
const program = new Command();

// 配置命令行程序
program
  // 设置程序名称
  .name('deepresearch')
  // 设置程序描述
  .description('AI-powered research assistant that keeps searching until it finds the answer')
  // 设置程序版本号，从package.json中获取
  .version(version)
  // 设置必需的参数：研究查询内容
  .argument('<query>', 'The research query to investigate')
  // 设置可选参数：令牌预算（token budget）
  .option('-t, --token-budget <number>', 'Maximum token budget', (val) => {
    // 将输入值转换为整数
    const num = parseInt(val);
    // 如果不是有效数字则抛出错误
    if (isNaN(num)) throw new Error('Invalid token budget: must be a number');
    return num;
  }, 1000000) // 默认值为100万
  // 设置可选参数：最大尝试次数
  .option('-m, --max-attempts <number>', 'Maximum bad attempts before giving up', (val) => {
    // 将输入值转换为整数
    const num = parseInt(val);
    // 如果不是有效数字则抛出错误
    if (isNaN(num)) throw new Error('Invalid max attempts: must be a number');
    return num;
  }, 3) // 默认值为3次
  // 设置可选标志：详细输出模式
  .option('-v, --verbose', 'Show detailed progress')
  // 设置命令执行的动作
  .action(async (query: string, options: any) => {
    try {
      // 调用agent的getResponse函数获取响应
      const { result } = await getResponse(
        query,
        parseInt(options.tokenBudget),
        parseInt(options.maxAttempts)
      );
      
      // 如果结果动作是"回答"，则输出结果
      if (result.action === 'answer') {
        // 输出回答内容
        console.log('\nAnswer:', result.answer);
        // 如果有引用来源，则输出引用
        if (result.references?.length) {
          console.log('\nReferences:');
          result.references.forEach(ref => {
            // 输出引用的URL
            console.log(`- ${ref.url}`);
            // 输出引用的精确引用文本
            console.log(`  "${ref.exactQuote}"`);
          });
        }
      }
    } catch (error) {
      // 捕获并处理可能的错误
      console.error('Error:', error instanceof Error ? error.message : String(error));
      // 出错时以错误状态退出程序
      process.exit(1);
    }
  });

// 解析命令行参数并执行
program.parse();
