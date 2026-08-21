const WebSocket = require('ws');
const logger = require('../utils/logger');

const STEP_REALTIME_URL = 'wss://api.stepfun.com/v1/realtime';

function getApiKey() {
  const key = process.env.STEP_API_KEY;
  if (!key || key === 'your_step_api_key_here') {
    return null;
  }
  return key;
}

// 允许透传的查询参数（目前只有 model）
const ALLOWED_PARAMS = ['model'];

// ---------- Tool Call 日志辅助 ----------

function truncateStr(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function summarizeTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return '(无)';
  return tools.map(t => {
    if (t.type === 'function') return `function:${t.function && t.function.name}`;
    if (t.type === 'web_search') return `web_search(top_k=${t.function && t.function.options && t.function.options.top_k})`;
    if (t.type === 'retrieval') return `retrieval(kb=${t.function && t.function.options && t.function.options.vector_store_id})`;
    return t.type;
  }).join(', ');
}

// 客户端 → 上游：记录工具相关事件
function inspectClientEvent(raw) {
  let evt;
  try { evt = JSON.parse(raw); } catch { return; }

  switch (evt.type) {
    case 'session.update': {
      const s = evt.session || {};
      const parts = [];
      if (s.tools !== undefined) parts.push(`tools=[${summarizeTools(s.tools)}]`);
      if (s.instructions) parts.push(`instructions="${truncateStr(s.instructions, 80)}"`);
      if (s.voice) parts.push(`voice=${s.voice}`);
      if (s.turn_detection !== undefined) parts.push(`turn_detection=${s.turn_detection ? s.turn_detection.type : 'null'}`);
      if (parts.length) logger.info('REALTIME', `→ session.update ${parts.join(' ')}`);
      break;
    }
    case 'conversation.item.create': {
      const item = evt.item || {};
      if (item.type === 'function_call_output') {
        logger.info('REALTIME', `→ function_call_output call_id=${item.call_id} output="${truncateStr(item.output, 120)}"`);
      } else if (item.type === 'message' && item.role === 'user') {
        const text = (item.content || []).map(c => c.text || (c.type === 'input_audio' ? '[音频]' : '')).join('');
        logger.info('REALTIME', `→ 用户消息: "${truncateStr(text, 80)}"`);
      }
      break;
    }
    case 'response.create':
      logger.info('REALTIME', '→ response.create（触发模型推理）');
      break;
    case 'response.cancel':
      logger.info('REALTIME', '→ response.cancel（打断）');
      break;
  }
}

// 上游 → 客户端：记录工具调用与响应关键事件（音频流不记）
function inspectServerEvent(raw) {
  let evt;
  try { evt = JSON.parse(raw); } catch { return; }

  switch (evt.type) {
    case 'session.updated': {
      const tools = evt.session && evt.session.tools;
      logger.info('REALTIME', `← session.updated 生效工具: [${summarizeTools(tools)}]`);
      break;
    }
    case 'conversation.item.created': {
      const item = evt.item || {};
      if (item.type === 'function_call') {
        logger.info('REALTIME', `← 🔧 函数调用请求: ${item.name}() call_id=${item.call_id}`);
      }
      break;
    }
    case 'response.function_call_arguments.done':
      logger.info('REALTIME', `← 函数参数完成: ${evt.name}(${truncateStr(evt.arguments, 150)}) call_id=${evt.call_id}`);
      break;
    case 'response.done': {
      const resp = evt.response || {};
      // 检查输出中是否有工具调用痕迹
      const outputs = resp.output || [];
      const fnCalls = outputs.filter(o => o.type === 'function_call');
      let extra = '';
      if (fnCalls.length > 0) {
        extra = ' 含函数调用: ' + fnCalls.map(f => f.name).join(', ');
      }
      logger.info('REALTIME', `← response.done status=${resp.status}${extra}`);
      break;
    }
    case 'error':
      logger.error('REALTIME', `← 错误: ${evt.error && evt.error.type} ${evt.error && evt.error.message}`);
      break;
  }
}

/**
 * Realtime WebSocket 代理
 * 浏览器 -> ws://localhost:PORT/api/realtime?model=xxx -> wss://api.stepfun.com/v1/realtime?model=xxx
 * 浏览器端 WebSocket 无法设置 Authorization 头，因此由服务端代理转发
 */
function setupRealtimeProxy(server) {
  const wss = new WebSocket.Server({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch (e) {
      socket.destroy();
      return;
    }

    if (pathname === '/api/realtime') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    }
    // 其他路径的 upgrade 请求交给其他处理器（或忽略）
  });

  wss.on('connection', (clientWs, req) => {
    const apiKey = getApiKey();
    if (!apiKey) {
      logger.warn('REALTIME', '连接被拒绝: API Key 未配置');
      clientWs.send(JSON.stringify({
        type: 'error',
        error: { type: 'config_error', message: '服务端未配置 STEP_API_KEY' }
      }));
      clientWs.close();
      return;
    }

    const reqUrl = new URL(req.url, 'http://localhost');
    const upstream = new URL(STEP_REALTIME_URL);
    for (const key of ALLOWED_PARAMS) {
      const val = reqUrl.searchParams.get(key);
      if (val) upstream.searchParams.set(key, val);
    }
    if (!upstream.searchParams.get('model')) {
      upstream.searchParams.set('model', 'step-1o-audio');
    }

    const model = upstream.searchParams.get('model');
    logger.info('REALTIME', `客户端接入，代理模型: ${model}`);

    const serverWs = new WebSocket(upstream.toString(), {
      headers: { Authorization: 'Bearer ' + apiKey }
    });

    // 缓冲上游连接建立前客户端发来的消息
    const pending = [];

    clientWs.on('message', (data) => {
      const raw = data.toString();
      inspectClientEvent(raw);
      if (serverWs.readyState === WebSocket.OPEN) {
        serverWs.send(raw);
      } else if (serverWs.readyState === WebSocket.CONNECTING) {
        pending.push(raw);
      }
    });

    serverWs.on('open', () => {
      logger.info('REALTIME', '已连接 StepFun Realtime API');
      for (const msg of pending) serverWs.send(msg);
      pending.length = 0;
    });

    serverWs.on('message', (data) => {
      const raw = data.toString();
      inspectServerEvent(raw);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(raw);
      }
    });

    serverWs.on('close', (code, reason) => {
      logger.info('REALTIME', `上游连接关闭: ${code} ${reason || ''}`);
      if (clientWs.readyState === WebSocket.OPEN) {
        // 1005/1006/1015 是保留状态码，不能用于主动 close 帧，否则 ws 会抛
        // "First argument must be a valid error code number" 导致进程崩溃
        const isValidCode = (code >= 1000 && code <= 4999 &&
          code !== 1004 && code !== 1005 && code !== 1006 && code !== 1015);
        const safeCode = isValidCode ? code : 1011;
        const safeReason = isValidCode ? reason : `upstream closed with reserved code ${code}`;
        try {
          clientWs.close(safeCode, safeReason);
        } catch (e) {
          logger.warn('REALTIME', `关闭客户端连接失败: ${e.message}`);
        }
      }
    });

    serverWs.on('error', (err) => {
      logger.error('REALTIME', `上游连接错误: ${err.message}`);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({
          type: 'error',
          error: { type: 'proxy_error', message: '上游连接失败: ' + err.message }
        }));
        clientWs.close();
      }
    });

    clientWs.on('close', () => {
      logger.info('REALTIME', '客户端断开');
      if (serverWs.readyState === WebSocket.OPEN || serverWs.readyState === WebSocket.CONNECTING) {
        serverWs.close();
      }
    });

    clientWs.on('error', () => {
      if (serverWs.readyState === WebSocket.OPEN) serverWs.close();
    });
  });

  logger.info('REALTIME', 'Realtime WebSocket 代理已挂载: /api/realtime');
}

module.exports = { setupRealtimeProxy };
