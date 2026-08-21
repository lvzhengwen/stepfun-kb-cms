const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const MAPPING_FILE = path.join(__dirname, '..', 'data', 'file-mapping.json');

/**
 * 文件映射存储模块
 *
 * 维护 retrieval_file_id -> extract_file_id 的映射关系。
 * 上传文件时同时上传一份 file-extract 副本用于查看内容，
 * 这样知识库中的文件也可以通过 /files/:id/content 查看解析后的内容。
 *
 * 映射结构:
 * {
 *   "file-abc123": {           // retrieval-text 文件的 ID（知识库中的文件 ID）
 *     "extract_file_id": "file-def456",   // file-extract 文件的 ID（用于查看内容）
 *     "filename": "report.xlsx",
 *     "kb_id": "167907758199320576",
 *     "created_at": 1613779121
 *   }
 * }
 */

function ensureFile() {
  const dir = path.dirname(MAPPING_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(MAPPING_FILE)) {
    fs.writeFileSync(MAPPING_FILE, '{}', 'utf8');
  }
}

function readAll() {
  try {
    ensureFile();
    const raw = fs.readFileSync(MAPPING_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    logger.error('FILE-MAPPING', `读取映射文件失败: ${err.message}`);
    return {};
  }
}

function writeAll(mapping) {
  try {
    ensureFile();
    fs.writeFileSync(MAPPING_FILE, JSON.stringify(mapping, null, 2), 'utf8');
  } catch (err) {
    logger.error('FILE-MAPPING', `写入映射文件失败: ${err.message}`);
  }
}

/**
 * 获取 extract_file_id
 * @param {string} retrievalFileId - 知识库中文件的 ID
 * @returns {string|null} extract_file_id 或 null
 */
function getExtractFileId(retrievalFileId) {
  const mapping = readAll();
  return mapping[retrievalFileId]?.extract_file_id || null;
}

/**
 * 获取完整映射信息
 * @param {string} retrievalFileId
 * @returns {object|null}
 */
function get(retrievalFileId) {
  const mapping = readAll();
  return mapping[retrievalFileId] || null;
}

/**
 * 保存映射
 * @param {string} retrievalFileId - retrieval-text 文件的 ID
 * @param {string} extractFileId - file-extract 文件的 ID
 * @param {object} meta - 额外信息 { filename, kb_id }
 */
function set(retrievalFileId, extractFileId, meta = {}) {
  const mapping = readAll();
  mapping[retrievalFileId] = {
    extract_file_id: extractFileId,
    filename: meta.filename || '',
    kb_id: meta.kb_id || '',
    created_at: Math.floor(Date.now() / 1000)
  };
  writeAll(mapping);
  logger.info('FILE-MAPPING', `保存映射: retrieval="${retrievalFileId}" -> extract="${extractFileId}", filename="${meta.filename || ''}"`);
}

/**
 * 删除映射
 * @param {string} retrievalFileId
 */
function remove(retrievalFileId) {
  const mapping = readAll();
  if (mapping[retrievalFileId]) {
    delete mapping[retrievalFileId];
    writeAll(mapping);
    logger.info('FILE-MAPPING', `删除映射: retrieval="${retrievalFileId}"`);
  }
}

module.exports = {
  getExtractFileId,
  get,
  set,
  remove
};
