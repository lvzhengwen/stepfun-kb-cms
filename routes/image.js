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

// 各模型支持的尺寸 + n 上限（实测 step-image-edit-2 仅支持 n=1）
const SIZE_OPTIONS = {
  'step-image-edit-2': ['1024x1024', '768x1360', '896x1184', '1360x768', '1184x896'],
  'step-2x-large': ['256x256', '512x512', '768x768', '1024x1024', '1280x800', '800x1280']
};
const MAX_N = {
  'step-image-edit-2': 1,
  'step-2x-large': 4
};

/**
 * 图片生成
 * POST /api/image/generate
 * Body: {
 *   prompt: string,
 *   negative_prompt?: string,
 *   model?: string,           // 默认 step-image-edit-2
 *   n?: number,               // 1-4，默认 1
 *   size?: string,            // 模型对应尺寸
 *   steps?: number,           // 1-50，默认 8
 *   seed?: number,            // 0 = 随机，默认 0
 *   cfg_scale?: number,       // 1.0-10.0，默认 1.0
 *   text_mode?: boolean       // 文字场景优化，默认 false
 * }
 *
 * 文档：https://platform.stepfun.com/docs/zh/guides/developer/image-generate
 * 注意：官方返回的 url 形式有时效限制，强制使用 b64_json 以便前端直接展示
 */
router.post('/generate', async (req, res) => {
  const apiKey = getApiKey();
  if (!apiKey) {
    logger.warn('IMAGE', '请求被拒绝: API Key 未配置');
    return res.status(500).json({ error: '未配置 STEP_API_KEY，请在 .env 文件中设置' });
  }

  const {
    prompt,
    negative_prompt,
    model = 'step-image-edit-2',
    n = 1,
    size,
    steps = 8,
    seed = 0,
    cfg_scale = 1.0,
    text_mode = false
  } = req.body;

  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: '缺少 prompt 参数' });
  }
  if (prompt.length > 512) {
    return res.status(400).json({ error: `prompt 超过 512 字符（当前 ${prompt.length}）` });
  }

  // 校验 n 和 size（n 按模型上限截断，step-image-edit-2 仅支持 1 张）
  const maxN = MAX_N[model] || 1;
  const nClamped = Math.max(1, Math.min(maxN, parseInt(n, 10) || 1));
  const allowedSizes = SIZE_OPTIONS[model] || SIZE_OPTIONS['step-image-edit-2'];
  const sizeFinal = allowedSizes.includes(size) ? size : allowedSizes[0];

  const stepsClamped = Math.max(1, Math.min(50, parseInt(steps, 10) || 8));
  const cfgClamped = Math.max(1.0, Math.min(10.0, parseFloat(cfg_scale) || 1.0));
  const seedFinal = parseInt(seed, 10) || 0;

  logger.info('IMAGE', `生成请求: model="${model}", n=${nClamped}, size="${sizeFinal}", steps=${stepsClamped}, cfg=${cfgClamped}, seed=${seedFinal}, text_mode=${!!text_mode}, prompt="${prompt.substring(0, 80)}${prompt.length > 80 ? '...' : ''}"`);

  // 构造请求体
  const body = {
    model,
    prompt,
    n: nClamped,
    response_format: 'b64_json',  // 强制 base64，避开 URL 时效问题
    size: sizeFinal,
    seed: seedFinal
  };
  // cfg_scale / steps / text_mode 放在 extra_body（（OpenAI SDK 等价于 extra_body，curl 直接传顶层）
  body.steps = stepsClamped;
  body.cfg_scale = cfgClamped;
  body.text_mode = !!text_mode;
  if (negative_prompt && cfgClamped > 1.0) {
    body.negative_prompt = negative_prompt.substring(0, 512);
  }

  const start = Date.now();
  try {
    const response = await fetch(`${STEP_API_BASE}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    });

    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!response.ok) {
      logger.error('IMAGE', `生成失败 [${response.status}]`, data);
      return res.status(response.status).json(data);
    }

    // 将 base64 转 data URL 一起返回，避免前端重复转
    const images = (data.data || []).map(item => {
      if (item.b64_json) {
        return {
          dataUrl: `data:image/png;base64,${item.b64_json}`,
          revised_prompt: item.revised_prompt || null
        };
      }
      if (item.url) {
        return { url: item.url, revised_prompt: item.revised_prompt || null };
      }
      return {};
    });

    const elapsed = Date.now() - start;
    logger.info('IMAGE', `生成完成: count=${images.length}, elapsed=${elapsed}ms`);

    res.json({ images, created: data.created || Math.floor(Date.now() / 1000), model });
  } catch (err) {
    logger.error('IMAGE', `生成异常: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// 提取 base64 data URL 中的实际 base64 部分
function extractBase64(dataUrl) {
  if (!dataUrl) return '';
  const m = dataUrl.match(/^data:[^;]+;base64,(.+)$/);
  return m ? m[1] : dataUrl;
}

/**
 * 图片编辑
 * POST /api/image/edit
 * Body: {
 *   image: string,              // base64 data URL 或纯 base64
 *   prompt: string,
 *   negative_prompt?: string,
 *   cfg_scale?: number,         // 1.0~10.0
 *   steps?: number,             // 1~50
 *   seed?: number,              // 0=随机
 *   text_mode?: boolean,
 *   response_format?: 'b64_json' | 'url'    // 默认 b64_json
 * }
 *
 * 文档：https://platform.stepfun.com/docs/zh/guides/developer/image-edit
 * 转发到 StepFun POST /v1/images/edits（multipart/form-data）
 */
router.post('/edit', async (req, res) => {
  const apiKey = getApiKey();
  if (!apiKey) {
    logger.warn('IMAGE', '编辑请求被拒绝: API Key 未配置');
    return res.status(500).json({ error: '未配置 STEP_API_KEY，请在 .env 文件中设置' });
  }

  const FormData = require('form-data');
  const {
    image,
    prompt,
    negative_prompt,
    cfg_scale = 1.0,
    steps = 8,
    seed = 0,
    text_mode = false,
    response_format = 'b64_json'
  } = req.body;

  if (!image) {
    return res.status(400).json({ error: '缺少 image 参数（base64 data URL）' });
  }
  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: '缺少 prompt 参数' });
  }
  if (prompt.length > 512) {
    return res.status(400).json({ error: `prompt 超过 512 字符（当前 ${prompt.length}）` });
  }

  const cfgClamped = Math.max(1.0, Math.min(10.0, parseFloat(cfg_scale) || 1.0));
  const stepsClamped = Math.max(1, Math.min(50, parseInt(steps, 10) || 8));
  const seedFinal = parseInt(seed, 10) || 0;

  logger.info('IMAGE', `编辑请求: model="step-image-edit-2", steps=${stepsClamped}, cfg=${cfgClamped}, seed=${seedFinal}, text_mode=${!!text_mode}, prompt="${prompt.substring(0, 80)}${prompt.length > 80 ? '...' : ''}"`);

  // 把 base64 解码成 Buffer，作为 image 文件上传
  const base64 = extractBase64(image);
  let imageBuffer;
  try {
    imageBuffer = Buffer.from(base64, 'base64');
  } catch (e) {
    return res.status(400).json({ error: 'image base64 解析失败' });
  }

  const form = new FormData();
  form.append('model', 'step-image-edit-2');
  form.append('image', imageBuffer, { filename: 'input.png', contentType: 'image/png' });
  form.append('prompt', prompt);
  form.append('response_format', response_format);
  form.append('cfg_scale', String(cfgClamped));
  form.append('steps', String(stepsClamped));
  form.append('seed', String(seedFinal));
  form.append('text_mode', text_mode ? 'true' : 'false');
  if (negative_prompt && cfgClamped > 1.0) {
    form.append('negative_prompt', negative_prompt.substring(0, 512));
  }

  const start = Date.now();
  try {
    const response = await fetch(`${STEP_API_BASE}/images/edits`, {
      method: 'POST',
      headers: {
        ...form.getHeaders(),
        'Authorization': `Bearer ${apiKey}`
      },
      body: form.getBuffer()
    });

    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!response.ok) {
      logger.error('IMAGE', `编辑失败 [${response.status}]`, data);
      return res.status(response.status).json(data);
    }

    const images = (data.data || []).map(item => {
      if (item.b64_json) {
        return { dataUrl: `data:image/png;base64,${item.b64_json}`, revised_prompt: item.revised_prompt || null };
      }
      if (item.url) {
        return { url: item.url, revised_prompt: item.revised_prompt || null };
      }
      return {};
    });

    const elapsed = Date.now() - start;
    logger.info('IMAGE', `编辑完成: count=${images.length}, elapsed=${elapsed}ms`);

    res.json({ images, created: data.created || Math.floor(Date.now() / 1000), model: 'step-image-edit-2' });
  } catch (err) {
    logger.error('IMAGE', `编辑异常: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;