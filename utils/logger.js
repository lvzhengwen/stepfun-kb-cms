const fs = require('fs');
const path = require('path');

// 日志目录
const LOG_DIR = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// 颜色映射
const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
  cyan: '\x1b[36m',
};

// 日志级别配置
const LEVELS = {
  INFO:  { color: COLORS.green, label: 'INFO ' },
  WARN:  { color: COLORS.yellow, label: 'WARN ' },
  ERROR: { color: COLORS.red, label: 'ERROR' },
  DEBUG: { color: COLORS.gray, label: 'DEBUG' },
};

/**
 * 获取当前时间字符串
 */
function timestamp() {
  const now = new Date();
  return now.toISOString().replace('T', ' ').substring(0, 19);
}

/**
 * 获取日志文件名（按天）
 */
function logFileName() {
  const now = new Date();
  const date = now.toISOString().substring(0, 10);
  return path.join(LOG_DIR, `app-${date}.log`);
}

/**
 * 脱敏 API Key
 */
function maskApiKey(key) {
  if (!key) return 'N/A';
  if (key.length <= 8) return '****';
  return key.substring(0, 4) + '****' + key.substring(key.length - 4);
}

/**
 * 核心日志函数
 */
function log(level, module, message, details) {
  const config = LEVELS[level] || LEVELS.INFO;
  const ts = timestamp();

  // 控制台输出（带颜色）
  const colorStr = `${config.color}[${ts}] [${config.label}]${COLORS.reset}`;
  const moduleStr = `${COLORS.cyan}[${module}]${COLORS.reset}`;
  console.log(`${colorStr} ${moduleStr} ${message}`);

  if (details !== undefined) {
    const detailStr = typeof details === 'string' ? details : JSON.stringify(details, null, 2);
    console.log(`${COLORS.gray}${detailStr}${COLORS.reset}`);
  }

  // 文件输出（纯文本）
  const fileLine = `[${ts}] [${config.label}] [${module}] ${message}`;
  fs.appendFileSync(logFileName(), fileLine + '\n');
  if (details !== undefined) {
    const detailStr = typeof details === 'string' ? details : JSON.stringify(details, null, 2);
    fs.appendFileSync(logFileName(), detailStr + '\n');
  }
  fs.appendFileSync(logFileName(), '─'.repeat(80) + '\n');
}

// 导出便捷方法
module.exports = {
  info:  (module, message, details) => log('INFO',  module, message, details),
  warn:  (module, message, details) => log('WARN',  module, message, details),
  error: (module, message, details) => log('ERROR', module, message, details),
  debug: (module, message, details) => log('DEBUG', module, message, details),

  // 请求日志中间件
  requestLogger: (req, res, next) => {
    const start = Date.now();
    const { method, originalUrl, ip } = req;

    // 记录请求体（脱敏）
    let bodyPreview = '';
    if (req.body && Object.keys(req.body).length > 0) {
      const safeBody = { ...req.body };
      // 不记录文件二进制内容
      if (safeBody.file) delete safeBody.file;
      bodyPreview = JSON.stringify(safeBody);
    }

    log('INFO', 'HTTP', `→ ${method} ${originalUrl} from ${ip}`, bodyPreview || undefined);

    // 响应完成后记录状态码和耗时
    res.on('finish', () => {
      const duration = Date.now() - start;
      const status = res.statusCode;
      const level = status >= 500 ? 'ERROR' : status >= 400 ? 'WARN' : 'INFO';
      log(level, 'HTTP', `← ${method} ${originalUrl} ${status} ${duration}ms`);
    });

    next();
  },

  maskApiKey,
};
