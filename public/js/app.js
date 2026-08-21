/* ===== State ===== */
let currentKB = null;
let listPageInfo = { hasMore: false, firstId: null, lastId: null, direction: 'desc' };
let filePageInfo = { hasMore: false, firstId: null, lastId: null };
let selectedFile = null;
let createFile = null;
let deleteCallback = null;
let ragHistory = []; // RAG 聊天历史（多轮对话）

/* ===== API Helpers ===== */
async function apiCall(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || data.error || `请求失败 (${response.status})`);
  }
  return data;
}

/* ===== Toast ===== */
function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast ${type}`;
  toast.style.display = 'block';
  setTimeout(() => { toast.style.display = 'none'; }, 3000);
}

/* ===== Loading ===== */
function showLoading(text = '加载中...') {
  document.getElementById('loadingText').textContent = text;
  document.getElementById('loadingOverlay').style.display = 'flex';
}

function hideLoading() {
  document.getElementById('loadingOverlay').style.display = 'none';
}

/* ===== Utils ===== */
function formatDate(timestamp) {
  const d = new Date(timestamp * 1000);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function getFileExt(filename) {
  const parts = filename.split('.');
  return parts.length > 1 ? parts.pop().toLowerCase() : 'file';
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}

/* ===== API Status Check ===== */
async function checkApiStatus() {
  const badge = document.getElementById('apiStatus');
  badge.className = 'api-badge checking';
  badge.textContent = '检查中...';
  try {
    const data = await apiCall('/api/health');
    badge.className = 'api-badge connected';
    badge.textContent = '服务运行中';
  } catch (e) {
    badge.className = 'api-badge disconnected';
    badge.textContent = '服务异常';
  }
}

/* ===== View Management ===== */
function showListView() {
  document.getElementById('listView').classList.add('active');
  document.getElementById('detailView').classList.remove('active');
  loadKBList();
}

function showDetailView() {
  document.getElementById('listView').classList.remove('active');
  document.getElementById('detailView').classList.add('active');
}

/* ===== Knowledge Base List ===== */
async function loadKBList(direction = 'initial') {
  showLoading('加载知识库列表...');
  try {
    let url = '/api/vector-stores?limit=20&order=desc';
    if (direction === 'next' && listPageInfo.lastId) {
      url += `&after=${listPageInfo.lastId}`;
    } else if (direction === 'prev' && listPageInfo.firstId) {
      url += `&before=${listPageInfo.firstId}&order=asc`;
    }

    const data = await apiCall(url);
    renderKBList(data);

    // Determine if we have prev/next pages
    const items = data.data || [];
    listPageInfo.hasMore = data.has_more || false;

    if (items.length > 0) {
      listPageInfo.firstId = data.first_id || items[0].id;
      listPageInfo.lastId = data.last_id || items[items.length - 1].id;
    }

    const pagination = document.getElementById('listPagination');
    const prevBtn = document.getElementById('prevPageBtn');
    const nextBtn = document.getElementById('nextPageBtn');

    if (direction === 'initial') {
      pagination.style.display = listPageInfo.hasMore ? 'flex' : 'none';
      prevBtn.disabled = true;
      nextBtn.disabled = !listPageInfo.hasMore;
    } else if (direction === 'next') {
      pagination.style.display = 'flex';
      prevBtn.disabled = false;
      nextBtn.disabled = !listPageInfo.hasMore;
    } else if (direction === 'prev') {
      pagination.style.display = 'flex';
      prevBtn.disabled = false;
      nextBtn.disabled = !listPageInfo.hasMore;
    }
  } catch (e) {
    showToast(e.message, 'error');
    document.getElementById('kbGrid').innerHTML = `
      <div class="empty-state">
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <p>加载失败: ${escapeHtml(e.message)}</p>
      </div>`;
  } finally {
    hideLoading();
  }
}

function loadNextPage() {
  loadKBList('next');
}

function loadPrevPage() {
  loadKBList('prev');
}

function renderKBList(data) {
  const grid = document.getElementById('kbGrid');
  const items = data.data || [];

  if (items.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
          <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
        </svg>
        <p>暂无知识库，点击右上角创建第一个知识库</p>
      </div>`;
    return;
  }

  grid.innerHTML = items.map(kb => {
    const type = kb.type || 'text';
    const counts = kb.file_counts || {};
    const iconSvg = type === 'image'
      ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`
      : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`;

    return `
      <div class="kb-card" onclick="viewKBDetail('${kb.id}', '${escapeHtml(kb.name)}', '${type}')">
        <div class="kb-card-header">
          <div class="kb-card-icon ${type}">${iconSvg}</div>
          <span class="kb-type-tag ${type}">${type === 'image' ? '图片知识库' : '文本知识库'}</span>
        </div>
        <div class="kb-card-title">${escapeHtml(kb.name)}</div>
        <div class="kb-card-id">ID: ${kb.id}</div>
        <div class="kb-card-stats">
          <div class="kb-stat">
            <div class="kb-stat-num">${counts.total || 0}</div>
            <div class="kb-stat-label">总文件</div>
          </div>
          <div class="kb-stat">
            <div class="kb-stat-num completed">${counts.completed || 0}</div>
            <div class="kb-stat-label">已完成</div>
          </div>
          <div class="kb-stat">
            <div class="kb-stat-num in-progress">${counts.in_progress || 0}</div>
            <div class="kb-stat-label">处理中</div>
          </div>
          <div class="kb-stat">
            <div class="kb-stat-num failed">${counts.failed || 0}</div>
            <div class="kb-stat-label">失败</div>
          </div>
        </div>
        <div class="kb-card-date">创建时间: ${formatDate(kb.created_at)}</div>
      </div>`;
  }).join('');
}

/* ===== KB Detail ===== */
async function viewKBDetail(id, name, type) {
  currentKB = { id, name, type };
  document.getElementById('detailTitle').textContent = name;
  document.getElementById('detailSubtitle').textContent = `类型: ${type === 'image' ? '图片知识库' : '文本知识库'} | ID: ${id}`;

  showDetailView();

  // Load detail
  showLoading('加载知识库详情...');
  try {
    const detail = await apiCall(`/api/vector-stores/${id}`);
    renderStats(detail.file_counts || {});
  } catch (e) {
    // If detail fails, still show the page with zero stats
    renderStats({});
  } finally {
    hideLoading();
  }

  // Load files
  loadFileList();
}

function renderStats(counts) {
  document.getElementById('statsRow').innerHTML = `
    <div class="stat-card">
      <div class="stat-num">${counts.total || 0}</div>
      <div class="stat-label">总文件数</div>
    </div>
    <div class="stat-card completed">
      <div class="stat-num">${counts.completed || 0}</div>
      <div class="stat-label">已处理完成</div>
    </div>
    <div class="stat-card in-progress">
      <div class="stat-num">${counts.in_progress || 0}</div>
      <div class="stat-label">处理中</div>
    </div>
    <div class="stat-card failed">
      <div class="stat-num">${counts.failed || 0}</div>
      <div class="stat-label">处理失败</div>
    </div>
    <div class="stat-card">
      <div class="stat-num">${counts.cancelled || 0}</div>
      <div class="stat-label">已取消</div>
    </div>`;
}

/* ===== File List ===== */
async function loadFileList(direction = 'initial') {
  showLoading('加载文件列表...');
  try {
    let url = `/api/vector-stores/${currentKB.id}/files?limit=20&order=desc`;
    if (direction === 'next' && filePageInfo.lastId) {
      url += `&after=${filePageInfo.lastId}`;
    } else if (direction === 'prev' && filePageInfo.firstId) {
      url += `&before=${filePageInfo.firstId}&order=asc`;
    }

    const data = await apiCall(url);
    renderFileList(data);

    const items = data.data || [];
    filePageInfo.hasMore = data.has_more || false;
    if (items.length > 0) {
      filePageInfo.firstId = data.first_id || items[0].id;
      filePageInfo.lastId = data.last_id || items[items.length - 1].id;
    }

    const pagination = document.getElementById('filePagination');
    const prevBtn = document.getElementById('filePrevBtn');
    const nextBtn = document.getElementById('fileNextBtn');

    if (direction === 'initial') {
      pagination.style.display = filePageInfo.hasMore ? 'flex' : 'none';
      prevBtn.disabled = true;
      nextBtn.disabled = !filePageInfo.hasMore;
    } else if (direction === 'next') {
      pagination.style.display = 'flex';
      prevBtn.disabled = false;
      nextBtn.disabled = !filePageInfo.hasMore;
    } else if (direction === 'prev') {
      pagination.style.display = 'flex';
      prevBtn.disabled = false;
      nextBtn.disabled = !filePageInfo.hasMore;
    }
  } catch (e) {
    showToast(e.message, 'error');
    document.getElementById('fileList').innerHTML = `<p style="color:var(--gray-400);text-align:center;padding:40px;">加载失败: ${escapeHtml(e.message)}</p>`;
  } finally {
    hideLoading();
  }
}

function loadFileNextPage() {
  loadFileList('next');
}

function loadFilePrevPage() {
  loadFileList('prev');
}

function renderFileList(data) {
  const list = document.getElementById('fileList');
  const items = data.data || [];

  if (items.length === 0) {
    list.innerHTML = `
      <div class="empty-state" style="padding:40px;">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
        </svg>
        <p>知识库中暂无文件，点击右上角上传文件</p>
      </div>`;
    return;
  }

  list.innerHTML = items.map(file => {
    const desc = file.metadata?.description;
    return `
      <div class="file-item">
        <div class="file-item-info">
          <div class="file-item-icon default">${getFileExt(file.id).substring(0, 4) || 'FILE'}</div>
          <div class="file-item-details">
            <div class="file-item-name">${escapeHtml(file.id)}</div>
            <div class="file-item-meta">
              <span>创建: ${formatDate(file.created_at)}</span>
              <span>知识库 ID: ${escapeHtml(file.vector_store_id)}</span>
            </div>
            ${desc ? `<div class="file-item-desc">描述: ${escapeHtml(desc)}</div>` : ''}
          </div>
        </div>
        <div class="file-item-actions">
          <button class="btn btn-ghost btn-sm" onclick="viewFileContent('${file.id}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
            查看内容
          </button>
          <button class="btn btn-ghost btn-sm" onclick="confirmRemoveFile('${file.id}')">移除</button>
        </div>
      </div>`;
  }).join('');
}

/* ===== View File Content ===== */
async function viewFileContent(fileId) {
  // 显示加载中
  document.getElementById('fileContentModal').style.display = 'flex';
  document.getElementById('fileContentTitle').textContent = `文件内容 - ${fileId}`;
  document.getElementById('fileContentBody').innerHTML = `
    <div class="content-loading">
      <div class="progress-spinner"></div>
      <span>正在获取文件内容...</span>
    </div>`;
  document.getElementById('fileContentFooter').style.display = 'none';

  try {
    const response = await fetch(`/api/files/${encodeURIComponent(fileId)}/content`);
    const contentType = response.headers.get('content-type') || '';

    if (!response.ok) {
      // 错误情况
      let err;
      try { err = await response.json(); } catch { err = { error: { message: '未知错误' } }; }
      const hint = err.hint || err.error?.message || '获取失败';
      document.getElementById('fileContentBody').innerHTML = `
        <div class="content-error">
          <div class="content-error-icon">⚠️</div>
          <div class="content-error-title">无法获取文件内容</div>
          <div class="content-error-msg">${escapeHtml(hint)}</div>
          <div class="content-error-tip">
            <strong>原因：</strong>此文件上传时未创建 <code>file-extract</code> 副本，
            StepFun 的 <code>GET /files/:id/content</code> 接口仅支持 <code>purpose=file-extract</code> 的文件。
            <br><br>
            <strong>解决方案：</strong>删除此文件后重新上传，新版本会自动创建 <code>file-extract</code> 副本以支持内容查看。
            或者直接使用 RAG 检索测试功能向知识库提问。
          </div>
          <div style="margin-top: 16px; display: flex; gap: 8px; justify-content: center;">
            <button class="btn btn-primary" onclick="closeFileContentModal(); showRAGModal();">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="11" cy="11" r="8"/>
                <line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              使用 RAG 检索查询此文件
            </button>
          </div>
        </div>`;
      return;
    }

    if (contentType.includes('application/json')) {
      const data = await response.json();
      document.getElementById('fileContentBody').innerHTML = `
        <pre class="content-pre">${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
    } else {
      const text = await response.text();
      document.getElementById('fileContentBody').innerHTML = `
        <pre class="content-pre">${escapeHtml(text)}</pre>`;
      document.getElementById('fileContentFooter').style.display = 'flex';
      document.getElementById('fileContentSize').textContent = `${text.length.toLocaleString()} 字符`;
    }
  } catch (e) {
    document.getElementById('fileContentBody').innerHTML = `
      <div class="content-error">
        <div class="content-error-icon">⚠️</div>
        <div class="content-error-msg">${escapeHtml(e.message)}</div>
      </div>`;
  }
}

function closeFileContentModal() {
  document.getElementById('fileContentModal').style.display = 'none';
}

function copyFileContent() {
  const pre = document.querySelector('#fileContentBody .content-pre');
  if (!pre) return;
  const text = pre.textContent;
  navigator.clipboard.writeText(text).then(() => {
    showToast('已复制到剪贴板');
  }).catch(() => {
    showToast('复制失败', 'error');
  });
}

function downloadFileContent() {
  const pre = document.querySelector('#fileContentBody .content-pre');
  if (!pre) return;
  const text = pre.textContent;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${document.getElementById('fileContentTitle').textContent.replace(/[^\w\u4e00-\u9fa5-]/g, '_')}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ===== Create KB ===== */
function showCreateModal() {
  document.getElementById('createModal').style.display = 'flex';
  document.getElementById('kbName').value = '';
  document.getElementById('kbType').value = 'text';
  document.getElementById('createError').style.display = 'none';
  clearCreateFile();
  setTimeout(() => document.getElementById('kbName').focus(), 100);
}

function closeCreateModal() {
  document.getElementById('createModal').style.display = 'none';
}

function handleCreateFile(file) {
  if (!file) return;
  createFile = file;
  document.getElementById('createPreviewName').textContent = file.name;
  document.getElementById('createPreviewSize').textContent = formatSize(file.size);

  const ext = getFileExt(file.name);
  document.getElementById('createPreviewIcon').className = `file-item-icon ${ext}`;
  document.getElementById('createPreviewIcon').textContent = ext.substring(0, 4);

  document.getElementById('createUploadZone').style.display = 'none';
  document.getElementById('createFilePreview').style.display = 'flex';
  document.getElementById('createDescGroup').style.display = 'block';

  // Default description: filename without extension
  const defaultDesc = file.name.replace(/\.[^/.]+$/, '');
  document.getElementById('createFileDesc').value = defaultDesc;
}

function clearCreateFile() {
  createFile = null;
  const input = document.getElementById('createFileInput');
  if (input) input.value = '';
  document.getElementById('createFilePreview').style.display = 'none';
  document.getElementById('createUploadZone').style.display = 'block';
  document.getElementById('createDescGroup').style.display = 'none';
  document.getElementById('createFileDesc').value = '';
}

async function createKB() {
  const name = document.getElementById('kbName').value.trim();
  const type = document.getElementById('kbType').value;
  const errorEl = document.getElementById('createError');
  const btn = document.getElementById('createBtn');

  if (!name) {
    errorEl.textContent = '请输入知识库名称';
    errorEl.style.display = 'block';
    return;
  }

  // Validate name format
  if (!/^[a-zA-Z0-9_]+$/.test(name) || name.startsWith('_')) {
    errorEl.textContent = '名称仅支持英文、数字和下划线，且不能以下划线开头';
    errorEl.style.display = 'block';
    return;
  }

  // Validate file description (required by API when adding files)
  let fileDesc = '';
  if (createFile) {
    fileDesc = document.getElementById('createFileDesc').value.trim();
    if (!fileDesc) {
      errorEl.textContent = '请输入文件描述（API 要求必填）';
      errorEl.style.display = 'block';
      return;
    }
    if (fileDesc.length > 255) {
      errorEl.textContent = '文件描述不能超过 255 个字符';
      errorEl.style.display = 'block';
      return;
    }
  }

  errorEl.style.display = 'none';
  btn.disabled = true;

  let progressTimer = null;
  let elapsed = 0;

  try {
    // Step 1: Create the knowledge base
    btn.textContent = '创建知识库...';
    const kb = await apiCall('/api/vector-stores', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type })
    });

    // Step 2: If a file was provided, upload it and attach to the KB
    if (createFile) {
      btn.textContent = '上传文件中...';
      const purpose = type === 'image' ? 'retrieval-image' : 'retrieval-text';
      const formData = new FormData();
      formData.append('purpose', purpose);
      formData.append('also_extract', 'true'); // 同时上传 file-extract 副本用于查看内容
      formData.append('file', createFile);

      const fileData = await apiCall('/api/files', {
        method: 'POST',
        body: formData
      });

      btn.textContent = '等待文件解析...';

      // 启动进度计时器（后端在重试时显示已等待秒数）
      progressTimer = setInterval(() => {
        elapsed++;
        btn.textContent = `等待文件解析... (${elapsed}秒)`;
      }, 1000);

      await apiCall(`/api/vector-stores/${kb.id}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: [{ file_id: fileData.id, description: fileDesc }] })
      });

      if (progressTimer) clearInterval(progressTimer);

      closeCreateModal();
      showToast(`知识库创建成功，已导入文件 "${createFile.name}"`);
    } else {
      closeCreateModal();
      showToast('知识库创建成功');
    }

    loadKBList('initial');
  } catch (e) {
    if (progressTimer) clearInterval(progressTimer);
    errorEl.textContent = e.message;
    errorEl.style.display = 'block';
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    btn.disabled = false;
    btn.textContent = '创建';
  }
}

/* ===== Delete KB ===== */
function confirmDeleteKB() {
  showDeleteModal(
    '删除知识库',
    `确定要删除知识库 <strong>"${escapeHtml(currentKB.name)}"</strong> 吗？此操作不可撤销，知识库中的所有文件都将被移除。`,
    async () => {
      showLoading('删除知识库...');
      try {
        await apiCall(`/api/vector-stores/${currentKB.id}`, { method: 'DELETE' });
        showToast('知识库已删除');
        closeDeleteModal();
        showListView();
      } catch (e) {
        showToast(e.message, 'error');
        hideLoading();
      }
    }
  );
}

/* ===== Remove File ===== */
function confirmRemoveFile(fileId) {
  showDeleteModal(
    '移除文件',
    `确定要从知识库中移除文件 <strong>"${escapeHtml(fileId)}"</strong> 吗？`,
    async () => {
      showLoading('移除文件...');
      try {
        await apiCall(`/api/vector-stores/${currentKB.id}/files/${fileId}`, { method: 'DELETE' });
        showToast('文件已移除');
        closeDeleteModal();
        loadFileList('initial');
        // Refresh KB detail stats
        const detail = await apiCall(`/api/vector-stores/${currentKB.id}`);
        renderStats(detail.file_counts || {});
      } catch (e) {
        showToast(e.message, 'error');
        hideLoading();
      }
    }
  );
}

function showDeleteModal(title, message, callback) {
  document.getElementById('deleteTitle').textContent = title;
  document.getElementById('deleteMessage').innerHTML = message;
  deleteCallback = callback;
  document.getElementById('deleteModal').style.display = 'flex';
  document.getElementById('deleteConfirmBtn').onclick = () => {
    if (deleteCallback) deleteCallback();
  };
}

function closeDeleteModal() {
  document.getElementById('deleteModal').style.display = 'none';
  deleteCallback = null;
  hideLoading();
}

/* ===== Upload File ===== */
function showUploadModal() {
  document.getElementById('uploadModal').style.display = 'flex';
  clearFile();
  document.getElementById('uploadError').style.display = 'none';

  // Update hint based on KB type
  const hint = document.getElementById('uploadHint');
  if (currentKB.type === 'image') {
    hint.textContent = '支持 jpg、png 格式图片（最大 64MB）';
    document.getElementById('descGroup').querySelector('.form-hint').textContent = '图片知识库上传时描述为必填项';
  } else {
    hint.textContent = '支持 txt, md, pdf, doc, docx, xls, xlsx, ppt, pptx, csv, html, htm, xml（最大 64MB）';
    document.getElementById('descGroup').querySelector('.form-hint').textContent = '文件的描述信息，可选';
  }
}

function closeUploadModal() {
  document.getElementById('uploadModal').style.display = 'none';
  clearFile();
}

function clearFile() {
  selectedFile = null;
  document.getElementById('fileInput').value = '';
  document.getElementById('filePreview').style.display = 'none';
  document.getElementById('uploadZone').style.display = 'block';
  document.getElementById('uploadBtn').disabled = true;
  document.getElementById('fileDesc').value = '';
}

function handleFileSelect(file) {
  if (!file) return;
  selectedFile = file;
  document.getElementById('previewName').textContent = file.name;
  document.getElementById('previewSize').textContent = formatSize(file.size);

  const ext = getFileExt(file.name);
  document.getElementById('previewIcon').className = `file-item-icon ${ext}`;
  document.getElementById('previewIcon').textContent = ext.substring(0, 4);

  document.getElementById('uploadZone').style.display = 'none';
  document.getElementById('filePreview').style.display = 'flex';
  document.getElementById('uploadBtn').disabled = false;
}

// File input events
document.addEventListener('DOMContentLoaded', () => {
  const fileInput = document.getElementById('fileInput');
  const uploadZone = document.getElementById('uploadZone');

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleFileSelect(e.target.files[0]);
    }
  });

  uploadZone.addEventListener('click', () => {
    fileInput.click();
  });

  uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadZone.classList.add('dragover');
  });

  uploadZone.addEventListener('dragleave', () => {
    uploadZone.classList.remove('dragover');
  });

  uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      handleFileSelect(e.dataTransfer.files[0]);
    }
  });

  // Create modal file upload events
  const createFileInput = document.getElementById('createFileInput');
  const createUploadZone = document.getElementById('createUploadZone');

  createFileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleCreateFile(e.target.files[0]);
    }
  });

  createUploadZone.addEventListener('click', () => {
    createFileInput.click();
  });

  createUploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    createUploadZone.classList.add('dragover');
  });

  createUploadZone.addEventListener('dragleave', () => {
    createUploadZone.classList.remove('dragover');
  });

  createUploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    createUploadZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      handleCreateFile(e.dataTransfer.files[0]);
    }
  });

  // Enter key on KB name input
  document.getElementById('kbName').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') createKB();
  });

  // RAG input: Enter to send, Shift+Enter for newline
  document.getElementById('ragInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!document.getElementById('ragSendBtn').disabled) {
        sendRAGQuery();
      }
    }
  });

  // Close modal on overlay click
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.style.display = 'none';
      }
    });
  });

  // Init
  checkApiStatus();
  loadKBList('initial');
});

async function uploadFile() {
  if (!selectedFile) return;
  const desc = document.getElementById('fileDesc').value.trim();
  const errorEl = document.getElementById('uploadError');
  const btn = document.getElementById('uploadBtn');
  const progressEl = document.getElementById('uploadProgress');
  const progressText = document.getElementById('progressText');
  const progressHint = document.getElementById('progressHint');

  // Validate description for image KB
  if (currentKB.type === 'image' && !desc) {
    errorEl.textContent = '图片知识库上传时描述为必填项';
    errorEl.style.display = 'block';
    return;
  }

  errorEl.style.display = 'none';
  btn.disabled = true;
  btn.textContent = '上传中...';
  progressEl.style.display = 'flex';

  // 启动进度提示定时器
  let elapsed = 0;
  let progressTimer = null;
  function showProgress(text, hint) {
    progressText.textContent = text;
    progressHint.textContent = hint;
  }

  try {
    // Step 1: Upload file to StepFun Files service
    showProgress('上传文件中...', `⏱ ${elapsed}秒`);
    progressTimer = setInterval(() => {
      elapsed++;
      const currentText = progressText.textContent;
      progressHint.textContent = `⏱ ${elapsed}秒`;
    }, 1000);

    const purpose = currentKB.type === 'image' ? 'retrieval-image' : 'retrieval-text';
    const formData = new FormData();
    formData.append('purpose', purpose);
    formData.append('also_extract', 'true'); // 同时上传 file-extract 副本用于查看内容
    formData.append('file', selectedFile);

    const fileData = await apiCall('/api/files', {
      method: 'POST',
      body: formData
    });

    // Step 2: Add file to vector store (后端会自动重试等待文件解析)
    showProgress('等待文件解析...', `⏱ ${elapsed}秒`);
    const fileObj = { file_id: fileData.id };
    if (desc) fileObj.description = desc;

    await apiCall(`/api/vector-stores/${currentKB.id}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [fileObj] })
    });

    showProgress('添加成功！', `共 ${elapsed}秒`);
    if (progressTimer) clearInterval(progressTimer);

    // 短暂显示成功状态后关闭
    await new Promise(r => setTimeout(r, 800));

    closeUploadModal();
    showToast('文件上传并添加成功');
    loadFileList('initial');

    // Refresh stats
    const detail = await apiCall(`/api/vector-stores/${currentKB.id}`);
    renderStats(detail.file_counts || {});
  } catch (e) {
    if (progressTimer) clearInterval(progressTimer);
    errorEl.textContent = e.message;
    errorEl.style.display = 'block';
    progressEl.style.display = 'none';
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    btn.disabled = false;
    btn.textContent = '上传并添加';
  }
}

/* ===== RAG Search ===== */
let ragController = null; // AbortController for canceling stream

function showRAGModal() {
  document.getElementById('ragModal').style.display = 'flex';
  document.getElementById('ragSubtitle').textContent = `知识库: ${currentKB.name} | ID: ${currentKB.id}`;
  // 官方文档强调：description 必须清晰描述知识库内容，否则检索命中率低
  document.getElementById('ragKBDesc').value = `本文档存储了 ${currentKB.name} 知识库的所有内容。请基于这些已上传文件中的信息回答用户问题。`;
  document.getElementById('ragSystemPrompt').value = `你是一个专业的知识库助手。请严格遵循以下规则：

1. **必须基于知识库回答**：所有回答必须基于知识库中检索到的内容，不要凭空编造或依赖你已有的训练数据。

2. **整理而非搬运**：理解用户的问题，从知识库中提炼、组织相关信息，用清晰、友好的方式回答。

3. **回答格式**：使用 markdown 格式让内容更易理解。

4. **诚实告知**：如果知识库中没有相关信息，明确告诉用户"知识库中未找到相关信息"。

5. **多轮对话**：记住之前的对话内容，结合上下文回答用户的后续问题。`;
  document.getElementById('ragModel').value = 'step-3.7-flash';
  document.getElementById('ragTemperature').value = '0.5';
  document.getElementById('ragInput').value = '';
  document.getElementById('ragInput').style.height = 'auto';

  // Reset history
  ragHistory = [];

  // Reset chat
  document.getElementById('ragChat').innerHTML = `
    <div class="rag-empty">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.3;margin-bottom:12px;">
        <circle cx="11" cy="11" r="8"/>
        <line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
      <p>输入问题，对知识库进行 RAG 检索测试</p>
      <p style="font-size:12px;color:var(--gray-400);margin-top:8px;">StepFun 的检索增强由服务端自动完成，无需客户端工具调用</p>
    </div>`;

  setTimeout(() => document.getElementById('ragInput').focus(), 100);
}

function closeRAGModal() {
  if (ragController) {
    ragController.abort();
    ragController = null;
  }
  document.getElementById('ragModal').style.display = 'none';
}

function autoResize(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
}

function appendRAGMessage(role, content) {
  const chat = document.getElementById('ragChat');
  // Remove empty state if present
  const empty = chat.querySelector('.rag-empty');
  if (empty) empty.remove();

  const avatar = role === 'user' ? '你' : 'AI';
  const msgEl = document.createElement('div');
  msgEl.className = `rag-msg ${role}`;
  const renderedContent = role === 'user' ? escapeHtml(content) : renderMarkdown(content);
  msgEl.innerHTML = `
    <div class="rag-msg-avatar">${avatar}</div>
    <div class="rag-msg-bubble">${renderedContent}</div>`;
  chat.appendChild(msgEl);
  chat.scrollTop = chat.scrollHeight;
  return msgEl;
}

// 简易 Markdown 渲染（支持 #、##、### 标题、列表、加粗、代码块、表格、链接）
function renderMarkdown(text) {
  if (!text) return '';
  let html = escapeHtml(text);
  // 代码块
  html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
  // 行内代码
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // 标题
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // 粗体
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // 列表
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
  // 换行
  html = html.replace(/\n/g, '<br>');
  return html;
}

function appendRAGTyping() {
  const chat = document.getElementById('ragChat');
  const empty = chat.querySelector('.rag-empty');
  if (empty) empty.remove();

  const msgEl = document.createElement('div');
  msgEl.className = 'rag-msg assistant';
  msgEl.id = 'ragTypingMsg';
  msgEl.innerHTML = `
    <div class="rag-msg-avatar">AI</div>
    <div class="rag-msg-bubble">
      <div class="rag-typing"><span></span><span></span><span></span></div>
    </div>`;
  chat.appendChild(msgEl);
  chat.scrollTop = chat.scrollHeight;
}

async function sendRAGQuery() {
  const input = document.getElementById('ragInput');
  const query = input.value.trim();
  if (!query) return;

  const btn = document.getElementById('ragSendBtn');
  const model = document.getElementById('ragModel').value;
  const systemPrompt = document.getElementById('ragSystemPrompt').value.trim();
  const kbDesc = document.getElementById('ragKBDesc').value.trim();
  const temperature = parseFloat(document.getElementById('ragTemperature').value) || 0.5;

  // Show user message
  appendRAGMessage('user', query);
  input.value = '';
  input.style.height = 'auto';
  input.disabled = true;
  btn.disabled = true;

  // 追加到历史（保留多轮对话）
  ragHistory.push({ role: 'user', content: query });

  // Show typing indicator
  appendRAGTyping();

  ragController = new AbortController();

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vector_store_id: currentKB.id,
        messages: ragHistory.slice(), // 发送完整历史（包含当前问题）
        model,
        system_prompt: systemPrompt,
        kb_description: kbDesc,
        temperature,
        stream: true
      }),
      signal: ragController.signal
    });

    if (!response.ok) {
      let err;
      try { err = await response.json(); } catch { err = { error: { message: '请求失败' } }; }
      throw new Error(err.error?.message || `请求失败 (${response.status})`);
    }

    // Remove typing indicator, create assistant message
    const typingEl = document.getElementById('ragTypingMsg');
    if (typingEl) typingEl.remove();

    const chat = document.getElementById('ragChat');
    const msgEl = document.createElement('div');
    msgEl.className = 'rag-msg assistant';
    msgEl.innerHTML = `
      <div class="rag-msg-avatar">AI</div>
      <div class="rag-msg-bubble" id="ragStreamingContent"></div>`;
    chat.appendChild(msgEl);
    chat.scrollTop = chat.scrollHeight;

    const contentEl = document.getElementById('ragStreamingContent');
    let fullContent = '';
    let totalTokens = null;

    // Read SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;

        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta;
          if (delta?.content) {
            fullContent += delta.content;
            contentEl.innerHTML = renderMarkdown(fullContent);
            chat.scrollTop = chat.scrollHeight;
          }
          if (json.usage) {
            totalTokens = json.usage.total_tokens;
          }
        } catch (e) {
          // Ignore JSON parse errors for partial data
        }
      }
    }

    // 保存 AI 回复到历史
    if (fullContent) {
      ragHistory.push({ role: 'assistant', content: fullContent });
    }

    // Stream completed: Detect "未找到" 关键词，添加提示标签
    const notFoundKeywords = ['未找到相关', '未找到', '没有找到', '无法找到', '找不到相关', '知识库中没', '知识库中没有', '知识库里没有', '未能找到', '未在知识库'];
    const hasNotFound = notFoundKeywords.some(k => fullContent.includes(k));

    // 在 AI 消息头部加一个"已基于知识库"标识徽章
    if (fullContent) {
      const badge = document.createElement('div');
      badge.className = 'rag-kb-badge';
      badge.innerHTML = hasNotFound
        ? '🔍 已检索知识库 · 未找到匹配内容'
        : '🔍 已基于知识库回答';
      msgEl.querySelector('.rag-msg-bubble').before(badge);
    }

    // Add meta info (token usage + RAG status)
    if (totalTokens) {
      const metaEl = document.createElement('div');
      metaEl.className = 'rag-msg-meta';
      const parts = [];
      if (totalTokens) parts.push(`Tokens: ${totalTokens}`);
      parts.push('StepFun retrieval · 服务端自动增强');
      metaEl.textContent = parts.join(' · ');
      msgEl.querySelector('.rag-msg-bubble').after(metaEl);
    }

    if (!fullContent) {
      contentEl.innerHTML = '<span style="color:var(--gray-400);font-style:italic;">（模型未返回内容，可能是网络问题或 StepFun 服务繁忙）</span>';
    }

  } catch (e) {
    // Remove typing indicator
    const typingEl = document.getElementById('ragTypingMsg');
    if (typingEl) typingEl.remove();

    if (e.name === 'AbortError') {
      appendRAGMessage('assistant', '（已取消）');
    } else {
      appendRAGMessage('assistant', `❌ 错误: ${e.message}`);
    }
  } finally {
    ragController = null;
    input.disabled = false;
    btn.disabled = false;
    input.focus();
  }
}
