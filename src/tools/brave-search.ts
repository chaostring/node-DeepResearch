import axios from 'axios';
import {BRAVE_API_KEY} from "../config";

import { BraveSearchResponse } from '../types';

// Brave搜索函数：使用Brave搜索API进行网络搜索
export async function braveSearch(query: string): Promise<{ response: BraveSearchResponse }> {
  // 发送GET请求到Brave搜索API
  const response = await axios.get<BraveSearchResponse>('https://api.search.brave.com/res/v1/web/search', {
    // 请求参数
    params: {
      q: query,             // 搜索查询词
      count: 10,            // 返回结果数量限制为10个
      safesearch: 'off'     // 关闭安全搜索过滤
    },
    // 请求头
    headers: {
      'Accept': 'application/json',   // 接受JSON格式的响应
      'X-Subscription-Token': BRAVE_API_KEY  // Brave API密钥
    },
    timeout: 10000  // 10秒超时
  });

  // 保持与原代码相同的返回结构
  return { response: response.data };
}
