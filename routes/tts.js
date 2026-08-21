const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const FormData = require('form-data');
const logger = require('../utils/logger');

const STEP_API_BASE = 'https://api.stepfun.com/v1';

function getApiKey() {
  const key = process.env.STEP_API_KEY;
  if (!key || key === 'your_step_api_key_here') return null;
  return key;
}

// StepFun 返回的二进制 audio Content-Type 映射
const FORMAT_MIME = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  opus: 'audio/opus',
  pcm: 'audio/pcm'
};

const ALLOWED_FORMATS = Object.keys(FORMAT_MIME);

/**
 * 音频合成 (TTS)
 * POST /api/tts/synthesize
 * Body: {
 *   model?: string,        // 默认 step-tts-2
 *   input: string,         // 要合成的文本（必填，≤ 4096 字符官方未明确，按 chat 经验）
 *   voice: string,         // 音色 ID
 *   volume?: number,       // 0.1~2.0，默认 1
 *   speed?: number,        // 0.5~2，默认 1
 *   response_format?: 'mp3'|'wav'|'flac'|'opus'|'pcm'  // 默认 mp3
 *   voice_label?: { emotion?: string, style?: string }
 * }
 *
 * 文档：https://platform.stepfun.com/docs/zh/guides/developer/tts
 * 返回：音频二进制流 + X-Audio-* 头部元数据
 */
router.post('/synthesize', async (req, res) => {
  const apiKey = getApiKey();
  if (!apiKey) {
    logger.warn('TTS', '请求被拒绝: API Key 未配置');
    return res.status(500).json({ error: '未配置 STEP_API_KEY，请在 .env 文件中设置' });
  }

  const {
    model = 'step-tts-2',
    input,
    voice,
    volume = 1,
    speed = 1,
    response_format = 'mp3',
    voice_label
  } = req.body;

  if (!input || !String(input).trim()) {
    return res.status(400).json({ error: '缺少 input 参数（要合成的文本）' });
  }
  if (!voice) {
    return res.status(400).json({ error: '缺少 voice 参数（音色 ID）' });
  }
  if (input.length > 4096) {
    return res.status(400).json({ error: `文本过长（当前 ${input.length}，限制 4096 字符）` });
  }

  const formatFinal = ALLOWED_FORMATS.includes(response_format) ? response_format : 'mp3';
  const volumeClamped = Math.max(0.1, Math.min(2.0, parseFloat(volume) || 1.0));
  const speedClamped = Math.max(0.5, Math.min(2.0, parseFloat(speed) || 1.0));

  const body = {
    model,
    input,
    voice,
    volume: volumeClamped,
    speed: speedClamped,
    response_format: formatFinal
  };
  if (voice_label && (voice_label.emotion || voice_label.style)) {
    body.voice_label = {};
    if (voice_label.emotion) body.voice_label.emotion = voice_label.emotion;
    if (voice_label.style) body.voice_label.style = voice_label.style;
  }

  logger.info('TTS', `合成请求: model="${model}", voice="${voice}", format=${formatFinal}, vol=${volumeClamped}, speed=${speedClamped}, emotion=${body.voice_label && body.voice_label.emotion || '-'}, style=${body.voice_label && body.voice_label.style || '-'}, text="${input.substring(0, 80)}${input.length > 80 ? '...' : ''}"`);

  const start = Date.now();
  try {
    const response = await fetch(`${STEP_API_BASE}/audio/speech`, {
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
      logger.error('TTS', `合成失败 [${response.status}]`, errData);
      return res.status(response.status).json(errData);
    }

    // 透传二进制音频
    const audioBuf = await response.buffer();
    const mime = FORMAT_MIME[formatFinal];
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', audioBuf.length);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Audio-Format', formatFinal);
    res.setHeader('X-Audio-Model', model);
    res.setHeader('X-Audio-Voice', voice);
    res.setHeader('X-Audio-Duration-Ms', String(Date.now() - start));
    res.send(audioBuf);

    logger.info('TTS', `合成完成: bytes=${audioBuf.length}, elapsed=${Date.now() - start}ms`);
  } catch (err) {
    logger.error('TTS', `合成异常: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// 从 base64 data URL 提取实际 base64 部分
function extractBase64(dataUrl) {
  if (!dataUrl) return '';
  const m = dataUrl.match(/^data:[^;]+;base64,(.+)$/);
  return m ? m[1] : dataUrl;
}

/**
 * 音色复刻 (Voice Cloning)
 * POST /api/tts/clone-voice
 * Body: {
 *   audio: string,          // base64 data URL 或纯 base64（mp3/wav，建议 5~10 秒）
 *   filename?: string,      // 原始文件名
 *   mime?: string,          // audio/mpeg 或 audio/wav
 *   model?: string,         // 默认 step-tts-2
 *   text?: string           // 音频对应的文本（建议传，否则走系统 ASR）
 * }
 *
 * 流程：上传音频到 Files API（purpose=storage）→ 调用 audio/voices 复刻
 * 文档：https://platform.stepfun.com/docs/zh/api-reference/audio/create-voice
 */
router.post('/clone-voice', async (req, res) => {
  const apiKey = getApiKey();
  if (!apiKey) {
    logger.warn('TTS', '音色复刻被拒绝: API Key 未配置');
    return res.status(500).json({ error: '未配置 STEP_API_KEY，请在 .env 文件中设置' });
  }

  const {
    audio,
    filename = 'voice_sample.mp3',
    mime = 'audio/mpeg',
    model = 'step-tts-2',
    text
  } = req.body;

  if (!audio) {
    return res.status(400).json({ error: '缺少 audio 参数（音频 base64 data URL）' });
  }

  const base64 = extractBase64(audio);
  let audioBuffer;
  try {
    audioBuffer = Buffer.from(base64, 'base64');
  } catch (e) {
    return res.status(400).json({ error: 'audio base64 解析失败' });
  }

  const sizeMB = audioBuffer.length / 1024 / 1024;
  logger.info('TTS', `音色复刻: model="${model}", audio=${sizeMB.toFixed(2)}MB, mime=${mime}, text="${(text || '').substring(0, 50)}"`);

  try {
    // Step 1: 上传音频到 Files API（purpose=storage）
    const formData = new FormData();
    formData.append('purpose', 'storage');
    formData.append('file', audioBuffer, { filename, contentType: mime });

    const uploadResp = await fetch(`${STEP_API_BASE}/files`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        ...formData.getHeaders()
      },
      body: formData
    });
    const uploadData = await uploadResp.json();
    if (!uploadResp.ok) {
      logger.error('TTS', `音频上传失败 [${uploadResp.status}]`, uploadData);
      return res.status(uploadResp.status).json(uploadData);
    }
    const fileId = uploadData.id;
    logger.info('TTS', `音频上传成功: file_id="${fileId}"`);

    // Step 2: 调用 audio/voices 复刻音色
    const voiceBody = { file_id: fileId, model };
    if (text && text.trim()) voiceBody.text = text.trim();

    const voiceResp = await fetch(`${STEP_API_BASE}/audio/voices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(voiceBody)
    });
    const voiceData = await voiceResp.json();
    if (!voiceResp.ok) {
      logger.error('TTS', `音色复刻失败 [${voiceResp.status}]`, voiceData);
      return res.status(voiceResp.status).json(voiceData);
    }

    logger.info('TTS', `音色复刻成功: voice_id="${voiceData.id}", duplicated=${!!voiceData.duplicated}`);
    res.json({ ...voiceData, file_id: fileId });
  } catch (err) {
    logger.error('TTS', `音色复刻异常: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;