import {SERPQuery} from "../types";

// 根据搜索请求的时间参数格式化日期范围
export function formatDateRange(query: SERPQuery) {
  let searchDateTime;
  const currentDate = new Date(); // 当前日期
  let format = 'full'; // 默认格式为完整格式

  // 根据时间参数（tbs）确定搜索的开始时间和日期格式
  switch (query.tbs) {
    case 'qdr:h': // 过去一小时
      searchDateTime = new Date(Date.now() - 60 * 60 * 1000);
      format = 'hour';
      break;
    case 'qdr:d': // 过去一天
      searchDateTime = new Date(Date.now() - 24 * 60 * 60 * 1000);
      format = 'day';
      break;
    case 'qdr:w': // 过去一周
      searchDateTime = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      format = 'day';
      break;
    case 'qdr:m': // 过去一个月
      searchDateTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      format = 'day';
      break;
    case 'qdr:y': // 过去一年
      searchDateTime = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
      format = 'year';
      break;
    default:
      searchDateTime = undefined; // 未指定时间参数
  }

  // 如果有有效的搜索开始时间，则格式化日期范围
  if (searchDateTime !== undefined) {
    const startDate = formatDateBasedOnType(searchDateTime, format); // 开始日期
    const endDate = formatDateBasedOnType(currentDate, format); // 结束日期（当前时间）
    return `Between ${startDate} and ${endDate}`;
  }

  return ''; // 没有有效的时间参数，返回空字符串
}

// 根据指定的格式类型格式化日期
export function formatDateBasedOnType(date: Date, formatType: string) {
  // 从Date对象提取年、月、日、时、分、秒并格式化
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0'); // 月份从0开始，需要+1，并填充到2位
  const day = String(date.getDate()).padStart(2, '0'); // 填充日期到2位
  const hours = String(date.getHours()).padStart(2, '0'); // 填充小时到2位
  const minutes = String(date.getMinutes()).padStart(2, '0'); // 填充分钟到2位
  const seconds = String(date.getSeconds()).padStart(2, '0'); // 填充秒到2位

  // 根据格式类型返回不同精度的日期字符串
  switch (formatType) {
    case 'year': // 年-月-日 格式
      return `${year}-${month}-${day}`;
    case 'day': // 年-月-日 格式
      return `${year}-${month}-${day}`;
    case 'hour': // 年-月-日 时:分 格式
      return `${year}-${month}-${day} ${hours}:${minutes}`;
    case 'full': // 完整格式：年-月-日 时:分:秒
    default:
      return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }
}