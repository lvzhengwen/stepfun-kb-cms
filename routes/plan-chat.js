/**
 * StepFun 聊天对话（OpenAI 兼容 Chat Completions）
 *
 * 端点（外部）: https://api.stepfun.com/v1/chat/completions
 * 参考: https://platform.stepfun.com/docs/zh/api-reference/chat/chat
 *
 * 注：Step Plan 套餐（step_plan/v1）是独立付费订阅，未订阅会返回
 * "you have no active step plan subscription"。这里直接使用与 RAG
 * 聊天（routes/chat.js）同一个 /v1 标准端点，模型、协议完全一致。
 *
 * 路由：
 *   POST /api/plan-chat              流式/非流式对话（SSE 透传）
 *   GET  /api/plan-chat/models       返回可用模型清单（含推荐/介绍）
 *   GET  /api/plan-chat/health       测试上游连通性
 */

const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const logger = require('../utils/logger');

const STEP_API_BASE = 'https://api.stepfun.com/v1';

// /v1 标准套餐下支持的文本/多模态通用模型
const KNOWN_MODELS = [
  { id: 'step-3.7-flash',        name: 'step-3.7-flash',        desc: '推荐默认，速度快/通用性强/支持多模态' },
  { id: 'step-3.7-flash-think',  name: 'step-3.7-flash-think',  desc: '思考模式，复杂推理任务表现更稳' },
  { id: 'step-1o',               name: 'step-1o',               desc: '多模态通用大模型，也可纯文本对话' },
  { id: 'step-1o-turbo',         name: 'step-1o-turbo',         desc: '1o 系列快速版' },
  { id: 'step-r1',               name: 'step-r1',               desc: '强推理：数学/代码/逻辑任务' },
  { id: 'step-r1-mini',          name: 'step-r1-mini',          desc: '轻量推理，速度更快' },
];

function getApiKey() {
  const key = process.env.STEP_API_KEY;
  if (!key || key === 'your_step_api_key_here') return null;
  return key;
}

/** GET /api/plan-chat/models — 返回模型清单 */
router.get('/models', (req, res) => {
  res.json({ models: KNOWN_MODELS, base: STEP_API_BASE });
});

/** GET /api/plan-chat/health — 测试上游连通性（拉取模型列表，做最小权限验证） */
router.get('/health', async (req, res) => {
  const apiKey = getApiKey();
  if (!apiKey) return res.status(500).json({ ok: false, error: '未配置 STEP_API_KEY' });

  try {
    const r = await fetch(`${STEP_API_BASE}/models`, {
      headers: { Authorization: 'Bearer ' + apiKey },
      timeout: 8000,
    });
    const text = await r.text();
    logger.info('PLAN-CHAT', `健康检查 ${r.status} upstream=${STEP_API_BASE}/models`);
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
    res.json({ ok: r.ok, upstream_status: r.status, base: STEP_API_BASE, upstream_body_preview: body });
  } catch (err) {
    logger.error('PLAN-CHAT', `健康检查失败: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message, base: STEP_API_BASE });
  }
});

/**
 * POST /api/plan-chat
 * Body: {
 *   model: string,                // 必填
 *   messages: [{role, content}],  // 必填（已含 system/user/assistant 任意顺序）
 *   temperature?: number,
 *   max_tokens?: number,
 *   top_p?: number,
 *   stream?: boolean,            // 默认 true
 *   // 以下为兼容字段：若 messages 中无 system，可单独传
 *   system_prompt?: string,
 * }
 */
router.post('/', async (req, res) => {
  const apiKey = getApiKey();
  if (!apiKey) {
    logger.warn('PLAN-CHAT', '调用失败: API Key 未配置');
    return res.status(500).json({ error: '未配置 STEP_API_KEY，请在 .env 文件中设置' });
  }

  let {
    model,
    messages: rawMessages,
    system_prompt,
    temperature = 0.7,
    max_tokens,
    top_p,
    stream = true,
  } = req.body || {};

  model = (model || 'step-3.7-flash').toString().trim();
  if (!model) return res.status(400).json({ error: '缺少 model 参数' });

  let messages = Array.isArray(rawMessages) ? rawMessages.slice() : [];
  if (messages.length === 0) {
    return res.status(400).json({ error: '缺少 messages 参数' });
  }

  // 如果 messages 不含 system 且提供了 system_prompt，自动注入在最前
  const hasSystem = messages.some(m => m && m.role === 'system');
  if (!hasSystem && system_prompt && String(system_prompt).trim()) {
    messages.unshift({ role: 'system', content: String(system_prompt) });
  }

  // 保留最后一条给日志看
  const last = messages[messages.length - 1];
  const lastPreview = (typeof last?.content === 'string' ? last.content :
    Array.isArray(last?.content) ? last.content.map(c => c.text || `[${c.type}]`).join('') : '')
    .replace(/\s+/g, ' ').slice(0, 120);

  logger.info('PLAN-CHAT', `请求: model=${model}, turns=${messages.length}, temp=${temperature}, stream=${stream}, last="${lastPreview}${lastPreview.length >= 120 ? '…' : ''}"`);

  const body = { model, messages, temperature, stream };
  if (Number.isFinite(max_tokens) && max_tokens > 0) body.max_tokens = max_tokens;
  if (Number.isFinite(top_p) && top_p > 0) body.top_p = top_p;

  const upstreamUrl = `${STEP_API_BASE}/chat/completions`;
  logger.info('PLAN-CHAT', `转发到 ${upstreamUrl}`, { model, stream, has_system: body.messages[0]?.role === 'system' });

  try {
    const response = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      let errData;
      try { errData = JSON.parse(errText); } catch { errData = { error: { message: errText } }; }
      logger.error('PLAN-CHAT', `上游失败 [${response.status}]`, errData);
      return res.status(response.status).json(errData);
    }

    if (!stream) {
      // 非流式：直接 JSON 返回
      const data = await response.json();
      const usage = data.usage || {};
      logger.info('PLAN-CHAT', `非流式成功: tokens=${usage.total_tokens || 'N/A'}, content_len=${(data.choices?.[0]?.message?.content || '').length}`);
      return res.json(data);
    }

    // 流式：SSE 透传
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    let chunkCount = 0;
    let fullContent = '';
    let firstChunkLogged = false;

    response.body.on('data', (chunk) => {
      res.write(chunk);
      const text = chunk.toString('utf8');
      const lines = text.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          chunkCount++;
          const delta = json.choices?.[0]?.delta;
          if (!firstChunkLogged) {
            logger.info('PLAN-CHAT', '[SSE] 第一个 chunk 结构:', JSON.stringify(json.choices?.[0]));
            firstChunkLogged = true;
          }
          if (delta?.content) fullContent += delta.content;
        } catch (e) { /* 忽略 */ }
      }
    });

    response.body.on('end', () => {
      // StepFun 的 SSE 流如果没有自动追加 [DONE]，我们手动补一个，便于前端判断结束
      try { res.write('data: [DONE]\n\n'); } catch (_) {}
      res.end();
      logger.info('PLAN-CHAT', `流式完成: chunks=${chunkCount}, content_len=${fullContent.length}, preview="${fullContent.slice(0, 80).replace(/\s+/g, ' ')}…"`);
    });

    response.body.on('error', (err) => {
      logger.error('PLAN-CHAT', `流式异常: ${err.message}`);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      } else {
        try { res.end(); } catch (_) {}
      }
    });

    req.on('close', () => {
      if (response.body && typeof response.body.destroy === 'function') {
        try { response.body.destroy(); } catch (_) {}
      }
    });
  } catch (err) {
    logger.error('PLAN-CHAT', `请求异常: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
