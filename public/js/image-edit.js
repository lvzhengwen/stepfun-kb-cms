/* ===== StepFun 图片编辑 ===== */

let originalImage = null;  // { dataUrl, name, size, width, height }
let latestResult = null;   // { dataUrl, prompt, originalAt, revised }
let history = [];          // 历史编辑结果
let editing = false;

// ---------- 工具 ----------
function showToast(msg, type) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = 'toast ' + (type === 'error' ? 'error' : 'success');
  toast.style.display = 'block';
  setTimeout(() => { toast.style.display = 'none'; toast.className = 'toast'; }, 3500);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

// ---------- Seed 输入联动 ----------
function toggleSeedInput() {
  const checked = document.getElementById('cfgUseSeed').checked;
  document.getElementById('cfgSeed').disabled = !checked;
}

// ---------- 图片上传 ----------
document.getElementById('uploadZone').addEventListener('click', () => {
  document.getElementById('fileInput').click();
});

document.getElementById('fileInput').addEventListener('change', function () {
  if (this.files[0]) handleFile(this.files[0]);
  this.value = '';
});

['uploadZone'].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('dragover'); });
  el.addEventListener('dragleave', () => el.classList.remove('dragover'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('dragover');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });
});

function handleFile(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
    showToast('仅支持 JPG / PNG / WebP 图片', 'error');
    return;
  }
  if (file.size > 20 * 1024 * 1024) {
    showToast(`图片过大（${fmtSize(file.size)}），建议先用图片生成页的压缩功能处理`, 'error');
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    const img = new Image();
    img.onload = () => {
      originalImage = {
        dataUrl,
        name: file.name,
        size: file.size,
        width: img.width,
        height: img.height
      };
      renderEditor();
    };
    img.onerror = () => showToast('图片加载失败', 'error');
    img.src = dataUrl;
  };
  reader.onerror = () => showToast('文件读取失败', 'error');
  reader.readAsDataURL(file);
}

// ---------- 渲染 ----------
function renderEditor() {
  if (!originalImage) {
    document.getElementById('uploadCard').style.display = '';
    document.getElementById('editorCard').style.display = 'none';
    return;
  }
  document.getElementById('uploadCard').style.display = 'none';
  document.getElementById('editorCard').style.display = '';
  document.getElementById('originalImg').src = originalImage.dataUrl;
}

function renderResult() {
  const wrap = document.getElementById('resultWrap');
  const img = document.getElementById('resultImg');
  const actions = document.getElementById('resultActions');
  if (latestResult) {
    img.src = latestResult.dataUrl;
    img.style.display = '';
    wrap.querySelector('.ie-result-empty').style.display = 'none';
    actions.style.display = '';
  } else {
    img.style.display = 'none';
    wrap.querySelector('.ie-result-empty').style.display = '';
    actions.style.display = 'none';
  }
}

function renderHistory() {
  const wrap = document.getElementById('historyWrap');
  const list = document.getElementById('history');
  document.getElementById('historyCount').textContent = `${history.length} 次`;

  if (history.length === 0) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = '';
  // 倒序：最新在前
  list.innerHTML = history.map((item, i) => `
    <div class="ie-history-item">
      <img class="ie-history-img" src="${item.dataUrl}" alt="结果${history.length - i}" onclick="viewHistory(${history.length - 1 - i})">
      <div class="ie-history-prompt">${escapeHtml(item.prompt)}</div>
      <div class="ie-history-actions">
        <button class="btn btn-ghost" onclick="viewHistory(${history.length - 1 - i})">查看</button>
        <button class="btn btn-ghost" onclick="downloadHistory(${history.length - 1 - i})">下载</button>
      </div>
    </div>
  `).join('');
}

// ---------- 大图查看 ----------
function viewLatest() {
  if (!latestResult) return;
  document.getElementById('viewerImg').src = latestResult.dataUrl;
  document.getElementById('imageViewer').style.display = 'flex';
}

function viewHistory(i) {
  document.getElementById('viewerImg').src = history[i].dataUrl;
  document.getElementById('imageViewer').style.display = 'flex';
}

function closeViewer() {
  document.getElementById('imageViewer').style.display = 'none';
}

function downloadLatest() {
  downloadDataUrl(latestResult.dataUrl, `edit_${Date.now()}.png`);
}

function downloadHistory(i) {
  downloadDataUrl(history[i].dataUrl, `edit_${Date.now()}_${i + 1}.png`);
}

function downloadDataUrl(dataUrl, filename) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  a.click();
}

// ---------- 提示词计数 ----------
document.getElementById('prompt').addEventListener('input', function () {
  document.getElementById('promptCount').textContent = this.value.length;
});

// ---------- 编辑 ----------
async function edit() {
  if (editing) return;
  const promptText = document.getElementById('prompt').value.trim();
  if (!promptText) {
    showToast('请输入编辑指令', 'error');
    document.getElementById('prompt').focus();
    return;
  }
  if (!originalImage) {
    showToast('请先上传图片', 'error');
    return;
  }

  editing = true;
  const btn = document.getElementById('editBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-inline"></span> 编辑中...';

  const body = {
    image: originalImage.dataUrl,
    prompt: promptText,
    negative_prompt: document.getElementById('negativePrompt').value.trim(),
    cfg_scale: parseFloat(document.getElementById('cfgCfgScale').value) || 1.0,
    steps: parseInt(document.getElementById('cfgSteps').value, 10),
    text_mode: document.getElementById('cfgTextMode').checked,
    seed: document.getElementById('cfgUseSeed').checked
      ? parseInt(document.getElementById('cfgSeed').value, 10) || 0
      : 0,
    response_format: 'b64_json'
  };

  try {
    const res = await fetch('/api/image/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error && data.error.message ? data.error.message : `HTTP ${res.status}`);
    }
    const images = data.images || [];
    if (images.length === 0 || !images[0].dataUrl) {
      throw new Error('返回结果为空');
    }
    latestResult = {
      dataUrl: images[0].dataUrl,
      prompt: promptText,
      revised: images[0].revised_prompt || null
    };
    history.push({ ...latestResult, at: Date.now() });
    renderResult();
    renderHistory();
    showToast('编辑完成');
  } catch (err) {
    showToast('编辑失败: ' + err.message, 'error');
  }

  editing = false;
  btn.disabled = false;
  btn.innerHTML = `
<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 20h9"/>
  <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z"/>
</svg> 开始编辑`;
}

// ---------- 清空 ----------
function clearAll() {
  if (!originalImage && history.length === 0) return;
  if (!confirm('确定清空原图和所有编辑历史？')) return;
  originalImage = null;
  latestResult = null;
  history = [];
  document.getElementById('prompt').value = '';
  document.getElementById('negativePrompt').value = '';
  document.getElementById('promptCount').textContent = '0';
  renderEditor();
  renderResult();
  renderHistory();
}

// ---------- 服务状态 ----------
async function checkApiStatus() {
  const badge = document.getElementById('apiStatus');
  try {
    const res = await fetch('/api/health');
    if (res.ok) {
      badge.textContent = '服务正常';
      badge.className = 'api-badge connected';
    } else throw new Error();
  } catch {
    badge.textContent = '服务异常';
    badge.className = 'api-badge disconnected';
  }
}

checkApiStatus();

// 注入 inline spinner 样式
const style = document.createElement('style');
style.textContent = `
.spinner-inline {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid var(--gray-300);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  vertical-align: middle;
  margin-right: 6px;
}
@keyframes spin { to { transform: rotate(360deg); } }
`;
document.head.appendChild(style);