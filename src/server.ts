import app from "./app";

// 设置服务器端口，优先使用环境变量中的PORT，如果不存在则默认使用3000端口
const port = process.env.PORT || 3000;

// 导出服务器启动函数，以便更好地进行测试
// Export server startup function for better testing
export function startServer() {
  // 启动服务器并监听指定端口
  return app.listen(port, () => {
    // 服务器成功启动后在控制台输出信息
    console.log(`Server running at http://localhost:${port}`);
  });
}

// 如果不是在测试环境中运行，则直接启动服务器
// Start server if running directly
if (process.env.NODE_ENV !== 'test') {
  startServer();
}