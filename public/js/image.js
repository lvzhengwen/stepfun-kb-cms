/* ===== StepFun 图片生成 ===== */

// 各模型对应尺寸 + n 上限（实测 step-image-edit-2 仅支持 1 张）
const SIZE_OPTIONS = {
  'step-image-edit-2': ['1024x1024', '768x1360', '896x1184', '1360x768', '1184x896'],
  'step-2x-large': ['256x256', '512x512', '768x768', '1024x1024', '1280x800', '800x1280']
};
const MAX_N = {
  'step-image-edit-2': 1,
  'step-2x-large': 4
};

// 画廊中的图片项
let gallery = []; // [{dataUrl, prompt, createdAt}]

// ---------- 工具 ----------
function showToast(msg, type) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = 'toast ' + (type === 'error' ? 'error' : 'success');
  toast.style.display = 'block';
  setTimeout(() => { toast.style.display = 'none'; toast.className = 'toast'; }, 3000);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---------- 模型/seed 联动 ----------
function onModelChange() {
  const model = document.getElementById('cfgModel').value;
  const sizeSelect = document.getElementById('cfgSize');
  const nSelect = document.getElementById('cfgN');
  const sizes = SIZE_OPTIONS[model] || SIZE_OPTIONS['step-image-edit-2'];
  const maxN = MAX_N[model] || 1;
  sizeSelect.innerHTML = sizes.map(s => `<option value="${s}">${s}</option>`).join('');
  sizeSelect.value = sizes[0];
  // n 选项按模型上限调整
  nSelect.innerHTML = Array.from({ length: maxN }, (_, i) => i + 1)
    .map(n => `<option value="${n}" ${n === 1 ? 'selected' : ''}>${n} 张</option>`).join('');
}

function toggleSeedInput() {
  const checked = document.getElementById('cfgUseSeed').checked;
  const seedInput = document.getElementById('cfgSeed');
  seedInput.disabled = !checked;
}

// ---------- 提示词计数 ----------
document.getElementById('prompt').addEventListener('input', function () {
  document.getElementById('promptCount').textContent = this.value.length;
});

// ---------- 画廊渲染 ----------
function renderGallery() {
  const wrap = document.getElementById('gallery');
  document.getElementById('galleryCount').textContent = `${gallery.length} 张`;

  if (gallery.length === 0) {
    wrap.innerHTML = `
      <div class="ig-empty">
        <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <polyline points="21 15 16 10 5 21"/>
        </svg>
        <p>输入提示词，点击生成</p>
      </div>`;
    return;
  }

  wrap.innerHTML = gallery.map((item, i) => `
    <div class="ig-card" id="card-${i}">
      <div class="ig-card-img-wrap" onclick="viewImage(${i})">
        <img src="${item.dataUrl}" alt="图片${i + 1}" loading="lazy">
      </div>
      <div class="ig-card-prompt">${escapeHtml(item.prompt)}</div>
      <div class="ig-card-actions">
        <button class="btn btn-ghost" onclick="viewImage(${i})">查看</button>
        <button class="btn btn-ghost" onclick="downloadImage(${i})">下载</button>
        <button class="btn btn-ghost" onclick="copyPrompt(${i})">复制 prompt</button>
        <button class="btn btn-ghost" onclick="removeCard(${i})">删除</button>
      </div>
    </div>
  `).join('');
}

function viewImage(i) {
  document.getElementById('viewerImg').src = gallery[i].dataUrl;
  document.getElementById('imageViewer').style.display = 'flex';
}

function closeViewer() {
  document.getElementById('imageViewer').style.display = 'none';
}

function downloadImage(i) {
  const a = document.createElement('a');
  a.href = gallery[i].dataUrl;
  a.download = `stepfun_${Date.now()}_${i + 1}.png`;
  a.click();
}

async function copyPrompt(i) {
  try {
    await navigator.clipboard.writeText(gallery[i].prompt);
    showToast('提示词已复制');
  } catch {
    showToast('复制失败，请手动选择', 'error');
  }
}

function removeCard(i) {
  gallery.splice(i, 1);
  renderGallery();
}

function clearGallery() {
  if (gallery.length === 0) return;
  if (!confirm('确定清空所有生成结果？')) return;
  gallery = [];
  renderGallery();
}

// ---------- 生成 ----------
let generating = false;

async function generate() {
  if (generating) return;
  const promptText = document.getElementById('prompt').value.trim();
  if (!promptText) {
    showToast('请输入提示词', 'error');
    document.getElementById('prompt').focus();
    return;
  }

  const body = {
    prompt: promptText,
    negative_prompt: document.getElementById('negativePrompt').value.trim(),
    model: document.getElementById('cfgModel').value,
    n: parseInt(document.getElementById('cfgN').value, 10),
    size: document.getElementById('cfgSize').value,
    steps: parseInt(document.getElementById('cfgSteps').value, 10),
    cfg_scale: parseFloat(document.getElementById('cfgCfgScale').value),
    text_mode: document.getElementById('cfgTextMode').checked,
    seed: document.getElementById('cfgUseSeed').checked
      ? parseInt(document.getElementById('cfgSeed').value, 10) || 0
      : 0
  };

  generating = true;
  const btn = document.getElementById('generateBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-inline"></span> 生成中...';

  // 占位卡片
  const placeholderStart = gallery.length;
  for (let i = 0; i < body.n; i++) {
    gallery.push({ dataUrl: '', prompt: promptText, loading: true });
  }
  renderGallery();

  try {
    const res = await fetch('/api/image/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await res.json();
    if (!res.ok) {
      // 回滚占位
      gallery.splice(placeholderStart, body.n);
      renderGallery();
      throw new Error(data.error && data.error.message ? data.error.message : `HTTP ${res.status}`);
    }

    const images = data.images || [];
    if (images.length === 0) {
      gallery.splice(placeholderStart, body.n);
      renderGallery();
      throw new Error('返回结果为空');
    }

    // 替换占位
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const idx = placeholderStart + i;
      if (img.dataUrl) {
        gallery[idx] = { dataUrl: img.dataUrl, prompt: promptText, revised: img.revised_prompt || null };
      } else if (img.url) {
        // 兜底：URL 形式（有时效限制）
        gallery[idx] = { dataUrl: img.url, prompt: promptText, isUrl: true, revised: img.revised_prompt || null };
      } else {
        gallery.splice(idx, 1);
      }
    }
    // 清理多余占位
    while (gallery.length > placeholderStart + images.length) {
      gallery.pop();
    }
    renderGallery();
    showToast(`生成 ${images.length} 张成功`);
  } catch (err) {
    showToast('生成失败: ' + err.message, 'error');
  }

  generating = false;
  btn.disabled = false;
  btn.innerHTML = `
<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>
  <path d="M20 3v4"/><path d="M22 5h-4"/>
</svg> 生成图片`;
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

// ---------- 初始化 ----------
onModelChange();
checkApiStatus();

// 注入 inline spinner 样式（直接加一个全局）
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