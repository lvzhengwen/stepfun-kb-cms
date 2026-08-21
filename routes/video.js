const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const logger = require('../utils/logger');

const STEP_API_BASE = 'https://api.stepfun.com/v1';

function getApiKey() {
  const key = process.env.STEP_API_KEY;
  if (!key || key === 'your_step_api_key_here') return null;
  return key;
}

/**
 * 视频理解对话
 * POST /api/video/chat
 * Body: {
 *   messages: [{ role, content }],    // content 为多模态数组
 *                                      // [{type:'video_url', video_url:{url}}, {type:'text', text}]
 *                                      // url 支持三种形式：HTTP URL / base64 data URL / stepfile://FileID
 *   model?: string,                    // 默认 step-3.7-flash
 *   temperature?: number,              // 默认 0.7
 *   max_tokens?: number,               // 默认 1024
 *   stream?: boolean                   // 默认 true
 * }
 */
router.post('/chat', async (req, res) => {
  const apiKey = getApiKey();
  if (!apiKey) {
    logger.warn('VIDEO', '请求被拒绝: API Key 未配置');
    return res.status(500).json({ error: '未配置 STEP_API_KEY，请在 .env 文件中设置' });
  }

  const {
    messages,
    model = 'step-3.7-flash',
    temperature = 0.7,
    max_tokens = 1024,
    stream = true
  } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: '缺少 messages 参数' });
  }

  // 统计视频数和最后文本
  let videoCount = 0;
  let lastText = '';
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === 'video_url') videoCount++;
        if (part.type === 'text') lastText = part.text;
      }
    } else if (typeof m.content === 'string') {
      lastText = m.content;
    }
  }

  logger.info('VIDEO', `视频理解请求: model="${model}", turns=${messages.length}, videos=${videoCount}, last_query="${lastText.substring(0, 80)}", stream=${stream}`);

  const body = { model, messages, temperature, max_tokens, stream };

  try {
    const response = await fetch(`${STEP_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errText = await response.text();
      let errData;
      try { errData = JSON.parse(errText); } catch { errData = { error: { message: errText } }; }
      logger.error('VIDEO', `请求失败 [${response.status}]`, errData);
      return res.status(response.status).json(errData);
    }

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      let contentLen = 0;
      response.body.on('data', (chunk) => {
        res.write(chunk);
        contentLen += chunk.length;
      });
      response.body.on('end', () => {
        res.write('data: [DONE]\n\n');
        res.end();
        logger.info('VIDEO', `流式响应完成: bytes=${contentLen}`);
      });
      response.body.on('error', (streamErr) => {
        logger.error('VIDEO', `流式响应异常: ${streamErr.message}`);
        if (!res.headersSent) res.status(500).json({ error: streamErr.message });
        else res.end();
      });
      req.on('close', () => {
        if (response.body) response.body.destroy();
      });
    } else {
      const data = await response.json();
      const usage = data.usage || {};
      logger.info('VIDEO', `请求成功: tokens=${usage.total_tokens || 'N/A'}`);
      res.json(data);
    }
  } catch (err) {
    logger.error('VIDEO', `请求异常: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;