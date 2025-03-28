import https from 'https';
import { TokenTracker } from "../utils/token-tracker";
import { SearchResponse } from '../types';
import { JINA_API_KEY } from "../config";

// 使用Jina AI搜索API执行搜索查询
export function search(query: string, tracker?: TokenTracker): Promise<{ response: SearchResponse}> {
  return new Promise((resolve, reject) => {
    // 验证查询不为空
    if (!query.trim()) {
      reject(new Error('Query cannot be empty'));
      return;
    }

    // 设置HTTPS请求选项
    const options = {
      hostname: 's.jina.ai',               // Jina搜索API的主机名
      port: 443,                           // HTTPS默认端口
      path: `/?q=${encodeURIComponent(query)}`, // 将查询编码为URL参数
      method: 'GET',                       // 使用GET方法
      headers: {
        'Accept': 'application/json',      // 接受JSON格式的响应
        'Authorization': `Bearer ${JINA_API_KEY}`, // 使用API密钥进行认证
        'X-Respond-With': 'no-content',    // 请求不返回内容（仅返回搜索结果元数据）
      }
    };

    // 创建HTTPS请求
    const req = https.request(options, (res) => {
      let responseData = '';

      // 收集响应数据
      res.on('data', (chunk) => responseData += chunk);

      // 响应结束
      res.on('end', () => {
        // 首先检查HTTP状态码
        if (res.statusCode && res.statusCode >= 400) {
          try {
            // 尝试从响应中解析错误信息（如果可用）
            const errorResponse = JSON.parse(responseData);
            if (res.statusCode === 402) {
              // 402表示余额不足
              reject(new Error(errorResponse.readableMessage || 'Insufficient balance'));
              return;
            }
            reject(new Error(errorResponse.readableMessage || `HTTP Error ${res.statusCode}`));
          } catch {
            // 如果解析失败，只返回状态码
            reject(new Error(`HTTP Error ${res.statusCode}`));
          }
          return;
        }

        // 只为成功的响应解析JSON
        let response: SearchResponse;
        try {
          response = JSON.parse(responseData) as SearchResponse;
        } catch (error: unknown) {
          reject(new Error(`Failed to parse response: ${error instanceof Error ? error.message : 'Unknown error'}`));
          return;
        }

        // 验证响应格式
        if (!response.data || !Array.isArray(response.data)) {
          reject(new Error('Invalid response format'));
          return;
        }

        // 计算总令牌数
        const totalTokens = response.data.reduce((sum, item) => sum + (item.usage?.tokens || 0), 0);
        console.log('Total URLs:', response.data.length);

        // 使用令牌跟踪器记录使用情况
        const tokenTracker = tracker || new TokenTracker();
        tokenTracker.trackUsage('search', {
          totalTokens,
          promptTokens: query.length,           // 提示令牌数（查询长度）
          completionTokens: totalTokens         // 完成令牌数（总令牌）
        });

        // 解析成功，返回响应
        resolve({ response });
      });
    });

    // 添加超时处理
    req.setTimeout(30000, () => {    // 30秒超时
      req.destroy();
      reject(new Error('Request timed out'));
    });

    // 处理请求错误
    req.on('error', (error) => {
      reject(new Error(`Request failed: ${error.message}`));
    });

    // 结束请求
    req.end();
  });
}