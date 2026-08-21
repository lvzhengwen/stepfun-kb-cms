require('dotenv').config();

// 设置控制台输出编码为 UTF-8（解决中文乱码）
if (process.platform === 'win32') {
  try {
    require('child_process').execSync('chcp 65001 > nul', { stdio: 'ignore', shell: 'cmd' });
  } catch (e) { /* ignore */ }
}

const express = require('express');
const http = require('http');
const path = require('path');
const logger = require('./utils/logger');
const vectorStoreRoutes = require('./routes/vectorStores');
const fileRoutes = require('./routes/files');
const chatRoutes = require('./routes/chat');
const visionRoutes = require('./routes/vision');
const imageRoutes = require('./routes/image');
const videoRoutes = require('./routes/video');
const ttsRoutes = require('./routes/tts');
const { setupRealtimeProxy } = require('./routes/realtime');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
// JSON body 上限提高到 200MB（视频理解需要 base64 视频，原始 < 128MB）
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true }));

// 操作日志中间件 - 记录所有 API 请求
app.use('/api', logger.requestLogger);

app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.use('/api/vector-stores', vectorStoreRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/vision', visionRoutes);
app.use('/api/image', imageRoutes);
app.use('/api/video', videoRoutes);
app.use('/api/tts', ttsRoutes);

// Health check
app.get('/api/health', (req, res) => {
  logger.info('HEALTH', '健康检查请求');
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 使用 http.Server 以便同时挂载 WebSocket 代理
const server = http.createServer(app);
setupRealtimeProxy(server);

server.listen(PORT, () => {
  logger.info('SERVER', `服务启动成功，监听端口 ${PORT}`);
  logger.info('SERVER', `访问地址: http://localhost:${PORT}`);
  logger.info('SERVER', `API Key: ${logger.maskApiKey(process.env.STEP_API_KEY)}`);

  if (!process.env.STEP_API_KEY || process.env.STEP_API_KEY === 'your_step_api_key_here') {
    logger.warn('SERVER', '未配置 STEP_API_KEY，请在 .env 文件中设置');
  }
  logger.info('SERVER', '等待请求...');
});
