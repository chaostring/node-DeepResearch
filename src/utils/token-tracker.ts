import {EventEmitter} from 'events';

import {TokenUsage} from '../types';
import {LanguageModelUsage} from "ai";

// 令牌跟踪器类，用于跟踪各种工具的令牌使用情况
export class TokenTracker extends EventEmitter {
  // 令牌使用记录数组
  private usages: TokenUsage[] = [];
  // 总令牌预算
  private budget?: number;

  // 构造函数，接受可选的预算参数
  constructor(budget?: number) {
    super();
    this.budget = budget;

    // 如果存在异步本地上下文，设置使用量监听器
    if ('asyncLocalContext' in process) {
      const asyncLocalContext = process.asyncLocalContext as any;
      this.on('usage', () => {
        if (asyncLocalContext.available()) {
          // 更新上下文中的计费金额
          asyncLocalContext.ctx.chargeAmount = this.getTotalUsage().totalTokens;
        }
      });

    }
  }

  // 跟踪工具的令牌使用情况
  trackUsage(tool: string, usage: LanguageModelUsage) {
    const u = {tool, usage};
    // 添加到使用记录数组
    this.usages.push(u);
    // 触发使用事件
    this.emit('usage', usage);
  }

  // 获取所有工具的总令牌使用量，使用驼峰命名格式
  getTotalUsage(): LanguageModelUsage {
    return this.usages.reduce((acc, {usage}) => {
      acc.promptTokens += usage.promptTokens;
      acc.completionTokens += usage.completionTokens;
      acc.totalTokens += usage.totalTokens;
      return acc;
    }, {promptTokens: 0, completionTokens: 0, totalTokens: 0});
  }

  // 获取所有工具的总令牌使用量，使用蛇形命名格式（用于OpenAI API兼容）
  getTotalUsageSnakeCase(): {prompt_tokens: number, completion_tokens: number, total_tokens: number} {
    return this.usages.reduce((acc, {usage}) => {
      acc.prompt_tokens += usage.promptTokens;
      acc.completion_tokens += usage.completionTokens;
      acc.total_tokens += usage.totalTokens;
      return acc;
    }, {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0});
  }

  // 获取按工具分类的令牌使用明细
  getUsageBreakdown(): Record<string, number> {
    return this.usages.reduce((acc, {tool, usage}) => {
      acc[tool] = (acc[tool] || 0) + usage.totalTokens;
      return acc;
    }, {} as Record<string, number>);
  }

  // 打印令牌使用摘要
  printSummary() {
    const breakdown = this.getUsageBreakdown();
    console.log('Token Usage Summary:', {
      budget: this.budget,
      total: this.getTotalUsage(),
      breakdown
    });
  }

  // 重置令牌使用记录
  reset() {
    this.usages = [];
  }
}
