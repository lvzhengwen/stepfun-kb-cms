const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const logger = require('../utils/logger');

const STEP_API_BASE = 'https://api.stepfun.com/v1';

function getApiKey(req) {
  const key = process.env.STEP_API_KEY;
  if (!key || key === 'your_step_api_key_here') {
    return null;
  }
  return key;
}

function apiKeyMiddleware(req, res, next) {
  const apiKey = getApiKey(req);
  if (!apiKey) {
    logger.warn('AUTH', 'API Key 未配置，请求被拒绝');
    return res.status(500).json({ error: '未配置 STEP_API_KEY，请在 .env 文件中设置' });
  }
  req.apiKey = apiKey;
  next();
}

/**
 * 创建知识库
 * POST /api/vector-stores
 * Body: { name: string, type?: "text" | "image" }
 */
router.post('/', apiKeyMiddleware, async (req, res) => {
  const { name, type } = req.body;
  logger.info('VECTOR-STORE', `创建知识库: name="${name}", type="${type || 'text'}"`);

  if (!name) {
    logger.warn('VECTOR-STORE', '创建失败: 缺少知识库名称');
    return res.status(400).json({ error: '知识库名称为必填项' });
  }
  const body = { name };
  if (type) body.type = type;

  try {
    const response = await fetch(`${STEP_API_BASE}/vector_stores`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${req.apiKey}`
      },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok) {
      logger.error('VECTOR-STORE', `创建失败 [${response.status}]`, data);
      return res.status(response.status).json(data);
    }
    logger.info('VECTOR-STORE', `创建成功: id="${data.id}", name="${data.name}", file_counts=`, data.file_counts);
    res.json(data);
  } catch (err) {
    logger.error('VECTOR-STORE', `创建异常: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 获取知识库列表
 * GET /api/vector-stores?limit=20&order=desc&before=&after=
 */
router.get('/', apiKeyMiddleware, async (req, res) => {
  const params = new URLSearchParams();
  if (req.query.limit) params.set('limit', req.query.limit);
  if (req.query.order) params.set('order', req.query.order);
  if (req.query.before) params.set('before', req.query.before);
  if (req.query.after) params.set('after', req.query.after);

  logger.info('VECTOR-STORE', `获取知识库列表: limit=${req.query.limit || 20}, order=${req.query.order || 'desc'}`);

  try {
    const url = `${STEP_API_BASE}/vector_stores${params.toString() ? '?' + params.toString() : ''}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${req.apiKey}` }
    });
    const data = await response.json();
    if (!response.ok) {
      logger.error('VECTOR-STORE', `获取列表失败 [${response.status}]`, data);
      return res.status(response.status).json(data);
    }
    const count = data.data ? data.data.length : 0;
    logger.info('VECTOR-STORE', `获取列表成功: 共 ${count} 个知识库, has_more=${data.has_more}`);
    res.json(data);
  } catch (err) {
    logger.error('VECTOR-STORE', `获取列表异常: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 获取知识库详情
 * GET /api/vector-stores/:id
 */
router.get('/:id', apiKeyMiddleware, async (req, res) => {
  const kbId = req.params.id;
  logger.info('VECTOR-STORE', `获取知识库详情: id="${kbId}"`);

  try {
    const response = await fetch(`${STEP_API_BASE}/vector_stores/${kbId}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${req.apiKey}` }
    });
    const data = await response.json();
    if (!response.ok) {
      logger.error('VECTOR-STORE', `获取详情失败 [${response.status}]`, data);
      return res.status(response.status).json(data);
    }
    logger.info('VECTOR-STORE', `获取详情成功: id="${data.id}", name="${data.name}", file_counts=`, data.file_counts);
    res.json(data);
  } catch (err) {
    logger.error('VECTOR-STORE', `获取详情异常: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 删除知识库
 * DELETE /api/vector-stores/:id
 */
router.delete('/:id', apiKeyMiddleware, async (req, res) => {
  const kbId = req.params.id;
  logger.info('VECTOR-STORE', `删除知识库: id="${kbId}"`);

  try {
    const response = await fetch(`${STEP_API_BASE}/vector_stores/${kbId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${req.apiKey}` }
    });
    const data = await response.json();
    if (!response.ok) {
      logger.error('VECTOR-STORE', `删除失败 [${response.status}]`, data);
      return res.status(response.status).json(data);
    }
    logger.info('VECTOR-STORE', `删除成功: id="${kbId}", deleted=${data.deleted}`);
    res.json(data);
  } catch (err) {
    logger.error('VECTOR-STORE', `删除异常: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 添加文件到知识库
 * POST /api/vector-stores/:id/files
 * Body: { files: [{ file_id: string, description?: string }] }
 *
 * 处理 "File not parsed, please try again later" 错误：
 *   StepFun 上传文件后会异步解析，如果立刻添加到知识库可能遇到此错误。
 *   这里加上重试机制（最多 5 次，间隔 2/4/6/8 秒），提升成功率。
 */
router.post('/:id/files', apiKeyMiddleware, async (req, res) => {
  const kbId = req.params.id;
  const files = req.body.files || [];
  logger.info('VECTOR-STORE', `添加文件到知识库: kb_id="${kbId}", file_count=${files.length}`, files.map(f => ({ file_id: f.file_id, description: f.description })));

  const maxRetries = 5;
  const delays = [2000, 4000, 6000, 8000, 10000]; // 第一次重试前等 2s，之后递增

  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(`${STEP_API_BASE}/vector_stores/${kbId}/files`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${req.apiKey}`
        },
        body: JSON.stringify(req.body)
      });
      const data = await response.json();

      // 成功
      if (response.ok) {
        if (attempt > 0) {
          logger.info('VECTOR-STORE', `添加文件成功（第 ${attempt} 次重试）: kb_id="${kbId}"`, data);
        } else {
          logger.info('VECTOR-STORE', `添加文件成功: kb_id="${kbId}"`, data);
        }
        return res.json(data);
      }

      // 判断是否是「文件未解析完成」错误（大小写不敏感匹配）
      const errMsg = data?.error?.message || '';
      const isNotParsed = errMsg.toLowerCase().includes('not parsed');

      if (isNotParsed && attempt < maxRetries) {
        const delay = delays[attempt];
        logger.warn('VECTOR-STORE', `添加文件遇到「文件未解析」错误，${delay / 1000} 秒后重试 (${attempt + 1}/${maxRetries}): kb_id="${kbId}"`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      // 其他错误或重试耗尽
      if (isNotParsed) {
        logger.error('VECTOR-STORE', `添加文件失败 [${response.status}]: 重试 ${maxRetries} 次后仍报「文件未解析」`, data);
      } else {
        logger.error('VECTOR-STORE', `添加文件失败 [${response.status}]`, data);
      }
      return res.status(response.status).json(data);
    } catch (err) {
      lastError = err;
      logger.error('VECTOR-STORE', `添加文件异常 (尝试 ${attempt + 1}/${maxRetries + 1}): ${err.message}`);
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, delays[attempt]));
        continue;
      }
    }
  }

  // 所有重试均失败
  logger.error('VECTOR-STORE', `添加文件最终失败: kb_id="${kbId}", error=${lastError?.message}`);
  res.status(500).json({ error: lastError?.message || '添加文件失败' });
});

/**
 * 获取知识库中的文件列表
 * GET /api/vector-stores/:id/files?limit=20&order=desc&before=&after=
 */
router.get('/:id/files', apiKeyMiddleware, async (req, res) => {
  const kbId = req.params.id;
  const params = new URLSearchParams();
  if (req.query.limit) params.set('limit', req.query.limit);
  if (req.query.order) params.set('order', req.query.order);
  if (req.query.before) params.set('before', req.query.before);
  if (req.query.after) params.set('after', req.query.after);

  logger.info('VECTOR-STORE', `获取知识库文件列表: kb_id="${kbId}", limit=${req.query.limit || 20}, order=${req.query.order || 'desc'}`);

  try {
    const url = `${STEP_API_BASE}/vector_stores/${kbId}/files${params.toString() ? '?' + params.toString() : ''}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${req.apiKey}` }
    });
    const data = await response.json();
    if (!response.ok) {
      logger.error('VECTOR-STORE', `获取文件列表失败 [${response.status}]`, data);
      return res.status(response.status).json(data);
    }
    const count = data.data ? data.data.length : 0;
    logger.info('VECTOR-STORE', `获取文件列表成功: kb_id="${kbId}", 共 ${count} 个文件, has_more=${data.has_more}`);
    res.json(data);
  } catch (err) {
    logger.error('VECTOR-STORE', `获取文件列表异常: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 从知识库中移除文件
 * DELETE /api/vector-stores/:id/files/:fileId
 */
router.delete('/:id/files/:fileId', apiKeyMiddleware, async (req, res) => {
  const kbId = req.params.id;
  const fileId = req.params.fileId;
  logger.info('VECTOR-STORE', `从知识库移除文件: kb_id="${kbId}", file_id="${fileId}"`);

  try {
    const response = await fetch(`${STEP_API_BASE}/vector_stores/${kbId}/files/${fileId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${req.apiKey}` }
    });
    const data = await response.json();
    if (!response.ok) {
      logger.error('VECTOR-STORE', `移除文件失败 [${response.status}]`, data);
      return res.status(response.status).json(data);
    }
    logger.info('VECTOR-STORE', `移除文件成功: kb_id="${kbId}", file_id="${fileId}", deleted=${data.deleted}`);
    res.json(data);
  } catch (err) {
    logger.error('VECTOR-STORE', `移除文件异常: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
