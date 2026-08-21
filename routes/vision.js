const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const logger = require('../utils/logger');

const STEP_API_BASE = 'https://api.stepfun.com/v1';

function getApiKey() {
  const key = process.env.STEP_API_KEY;
  if (!key || key === 'your_step_api_key_here') {
    return null;
  }
  return key;
}

/**
 * 图片理解对话
 * POST /api/vision/chat
 * Body: {
 *   messages: [{ role, content }],   // 完整对话历史；content 为多模态数组
 *                                    // [{type:'image_url',image_url:{url,detail}}, {type:'text',text}]
 *   model?: string,                   // 默认 step-1o-turbo-vision
 *   temperature?: number,             // 默认 0.7
 *   stream?: boolean                  // 默认 true（SSE 透传）
 * }
 */
router.post('/chat', async (req, res) => {
  const apiKey = getApiKey();
  if (!apiKey) {
    logger.warn('VISION', '请求被拒绝: API Key 未配置');
    return res.status(500).json({ error: '未配置 STEP_API_KEY，请在 .env 文件中设置' });
  }

  const {
    messages,
    model = 'step-1o-turbo-vision',
    temperature = 0.7,
    stream = true
  } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: '缺少 messages 参数' });
  }

  // 统计图片数量（日志用）
  let imageCount = 0;
  let lastText = '';
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === 'image_url') imageCount++;
        if (part.type === 'text') lastText = part.text;
      }
    } else if (typeof m.content === 'string') {
      lastText = m.content;
    }
  }

  logger.info('VISION', `图片理解请求: model="${model}", turns=${messages.length}, images=${imageCount}, last_query="${lastText.substring(0, 80)}", stream=${stream}`);

  const body = { model, messages, temperature, stream };

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
      logger.error('VISION', `请求失败 [${response.status}]`, errData);
      return res.status(response.status).json(errData);
    }

    if (stream) {
      // SSE 流式透传
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
        logger.info('VISION', `流式响应完成: bytes=${contentLen}`);
      });
      response.body.on('error', (streamErr) => {
        logger.error('VISION', `流式响应异常: ${streamErr.message}`);
        if (!res.headersSent) res.status(500).json({ error: streamErr.message });
        else res.end();
      });
      req.on('close', () => {
        if (response.body) response.body.destroy();
      });
    } else {
      const data = await response.json();
      const usage = data.usage || {};
      logger.info('VISION', `请求成功: tokens=${usage.total_tokens || 'N/A'} (prompt=${usage.prompt_tokens}, cached=${usage.cached_tokens || 0})`);
      res.json(data);
    }
  } catch (err) {
    logger.error('VISION', `请求异常: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
