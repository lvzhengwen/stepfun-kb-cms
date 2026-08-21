const express = require('express');
const router = express.Router();
const multer = require('multer');
const fetch = require('node-fetch');
const FormData = require('form-data');
const logger = require('../utils/logger');
const fileMapping = require('../utils/fileMapping');

const STEP_API_BASE = 'https://api.stepfun.com/v1';

// Multer config - memory storage, 64MB limit
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 64 * 1024 * 1024 }
});

function getApiKey() {
  const key = process.env.STEP_API_KEY;
  if (!key || key === 'your_step_api_key_here') {
    return null;
  }
  return key;
}

/**
 * 格式化文件大小
 */
function formatSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / (1024 * 1024)).toFixed(2) + 'MB';
}

/**
 * 上传文件到 StepFun（内部辅助函数）
 * @param {Buffer} fileBuffer - 文件内容
 * @param {string} originalName - 文件名（UTF-8）
 * @param {string} mimetype - MIME 类型
 * @param {string} purpose - file-extract / retrieval-text / retrieval-image / storage
 * @param {string} apiKey - API Key
 * @returns {Promise<object>} StepFun 返回的 File 对象
 */
async function uploadToStepFun(fileBuffer, originalName, mimetype, purpose, apiKey) {
  const formData = new FormData();
  formData.append('purpose', purpose);
  formData.append('file', fileBuffer, {
    filename: originalName,
    contentType: mimetype
  });

  const response = await fetch(`${STEP_API_BASE}/files`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      ...formData.getHeaders()
    },
    body: formData
  });

  const data = await response.json();
  if (!response.ok) {
    const err = new Error(`StepFun 上传失败 [${response.status}]: ${data?.error?.message || '未知错误'}`);
    err.stepFunResponse = data;
    err.status = response.status;
    throw err;
  }
  return data;
}

/**
 * 上传文件
 * POST /api/files
 * multipart/form-data: purpose, file, also_extract(optional)
 *
 * 当 also_extract=true 时，同时上传一份 file-extract 副本用于查看内容，
 * 并在本地保存 retrieval_file_id -> extract_file_id 的映射关系。
 */
router.post('/', upload.single('file'), async (req, res) => {
  try {
    const apiKey = getApiKey();
    if (!apiKey) {
      logger.warn('FILE', '上传文件失败: API Key 未配置');
      return res.status(500).json({ error: '未配置 STEP_API_KEY，请在 .env 文件中设置' });
    }

    if (!req.file) {
      logger.warn('FILE', '上传文件失败: 未选择文件');
      return res.status(400).json({ error: '请选择要上传的文件' });
    }

    // 官方文档：retrieval 已废弃，应使用 retrieval-text / retrieval-image
    const purpose = req.body.purpose || 'retrieval-text';
    const alsoExtract = req.body.also_extract === 'true';

    // 修复 Windows 下中文文件名乱码：multer 默认按 latin1 解码，需要转换为 UTF-8
    const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');

    logger.info('FILE', `上传文件: name="${originalName}", size=${formatSize(req.file.size)}, mime="${req.file.mimetype}", purpose="${purpose}", also_extract=${alsoExtract}`);

    // Step 1: 用指定 purpose 上传（用于加入知识库）
    const mainFile = await uploadToStepFun(
      req.file.buffer, originalName, req.file.mimetype, purpose, apiKey
    );
    logger.info('FILE', `主文件上传成功: name="${originalName}", file_id="${mainFile.id}", purpose="${purpose}", bytes=${mainFile.bytes}, status="${mainFile.status}"`);

    // Step 2: 如果需要查看内容，同时上传一份 file-extract 副本
    let extractFileId = null;
    if (alsoExtract && purpose !== 'file-extract') {
      try {
        logger.info('FILE', `上传 file-extract 副本: name="${originalName}"`);
        const extractFile = await uploadToStepFun(
          req.file.buffer, originalName, req.file.mimetype, 'file-extract', apiKey
        );
        extractFileId = extractFile.id;
        logger.info('FILE', `file-extract 副本上传成功: name="${originalName}", file_id="${extractFile.id}", status="${extractFile.status}"`);

        // 保存映射关系
        fileMapping.set(mainFile.id, extractFile.id, { filename: originalName });
      } catch (extractErr) {
        // 副本上传失败不影响主流程，只是无法查看内容
        logger.warn('FILE', `file-extract 副本上传失败（不影响知识库功能）: ${extractErr.message}`);
      }
    }

    // 返回主文件信息（前端无感知多了一个 extract 副本）
    res.json({
      ...mainFile,
      _extract_file_id: extractFileId  // 附加信息，前端可用可不用
    });
  } catch (err) {
    logger.error('FILE', `上传异常: ${err.message}`);
    if (err.stepFunResponse) {
      return res.status(err.status || 500).json(err.stepFunResponse);
    }
    res.status(500).json({ error: err.message });
  }
});

/**
 * 获取文件信息
 * GET /api/files/:id
 */
router.get('/:id', async (req, res) => {
  try {
    const apiKey = getApiKey();
    if (!apiKey) {
      logger.warn('FILE', '获取文件信息失败: API Key 未配置');
      return res.status(500).json({ error: '未配置 STEP_API_KEY，请在 .env 文件中设置' });
    }

    const fileId = req.params.id;
    logger.info('FILE', `获取文件信息: file_id="${fileId}"`);

    const response = await fetch(`${STEP_API_BASE}/files/${fileId}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    const data = await response.json();
    if (!response.ok) {
      logger.error('FILE', `获取文件信息失败 [${response.status}]`, data);
      return res.status(response.status).json(data);
    }
    logger.info('FILE', `获取文件信息成功: file_id="${fileId}", purpose="${data.purpose}"`);
    res.json(data);
  } catch (err) {
    logger.error('FILE', `获取文件信息异常: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 获取文件内容（解析后的文本）
 * GET /api/files/:id/content
 *
 * 工作原理：
 *   1. 先查本地映射表，如果 :id 有对应的 extract_file_id，用 extract_file_id 调 StepFun API
 *   2. 如果没有映射，直接用 :id 尝试（兼容直接上传的 file-extract 文件）
 *   3. 如果 StepFun 返回 400（不支持获取内容），返回友好的错误提示
 */
router.get('/:id/content', async (req, res) => {
  try {
    const apiKey = getApiKey();
    if (!apiKey) {
      logger.warn('FILE', '获取文件内容失败: API Key 未配置');
      return res.status(500).json({ error: '未配置 STEP_API_KEY，请在 .env 文件中设置' });
    }

    const fileId = req.params.id;

    // 查映射表，看是否有对应的 file-extract 文件 ID
    const extractFileId = fileMapping.getExtractFileId(fileId);
    const lookupId = extractFileId || fileId;

    if (extractFileId) {
      logger.info('FILE', `获取文件内容: retrieval_id="${fileId}" -> extract_id="${extractFileId}"（使用映射）`);
    } else {
      logger.info('FILE', `获取文件内容: file_id="${fileId}"（无映射，直接请求）`);
    }

    const response = await fetch(`${STEP_API_BASE}/files/${lookupId}/content`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });

    if (!response.ok) {
      // 尝试读取 JSON 错误
      const errText = await response.text();
      let errData;
      try {
        errData = JSON.parse(errText);
      } catch {
        errData = { error: { message: errText, type: 'unknown' } };
      }
      logger.error('FILE', `获取文件内容失败 [${response.status}]: file_id="${lookupId}"`, errData);

      // 友好的错误提示
      const mappingInfo = fileMapping.get(fileId);
      const hint = mappingInfo
        ? '此文件已有 file-extract 副本，但 StepFun 仍返回错误。可能是文件尚未解析完成，请稍后重试。'
        : '此文件上传时未创建 file-extract 副本，无法直接查看内容。StepFun 的 GET /files/:id/content 接口仅支持 purpose=file-extract 的文件。';

      return res.status(response.status).json({
        ...errData,
        hint,
        solution: 'rag_query',
        solution_label: '使用 RAG 检索测试'
      });
    }

    // 返回纯文本内容
    const content = await response.text();
    logger.info('FILE', `获取文件内容成功: file_id="${lookupId}", 长度=${content.length}`);
    res.type('text/plain; charset=utf-8').send(content);
  } catch (err) {
    logger.error('FILE', `获取文件内容异常: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
