/* ===== StepFun 图片理解 ===== */

// 待发送图片队列（压缩后的 data URL）
let pendingImages = [];
// 对话历史（多模态 messages）
let history = [];
let sending = false;

const MAX_IMAGES = 10;

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

// ---------- 图片压缩 ----------
// detail=high → 最长边 1008（504 的倍数）；detail=low → 728
// 统一转白底 JPEG quality 0.8（透明 PNG 会被模型当黑底处理，转白底避免偏差）
function compressImage(file) {
  const detail = document.getElementById('cfgDetail').value;
  const maxEdge = detail === 'high' ? 1008 : 728;

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(img.src);
      let { width, height } = img;
      const longest = Math.max(width, height);
      if (longest > maxEdge) {
        const scale = maxEdge / longest;
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => { URL.revokeObjectURL(img.src); reject(new Error('图片加载失败')); };
    img.src = URL.createObjectURL(file);
  });
}

// ---------- 图片添加（文件选择 / 拖拽 / 粘贴） ----------
async function addImages(files) {
  const list = Array.from(files).filter(f => /^image\/(jpeg|png|gif|webp)$/.test(f.type));
  if (list.length === 0) {
    showToast('仅支持 JPG / PNG / GIF / WebP 图片', 'error');
    return;
  }
  if (pendingImages.length + list.length > MAX_IMAGES) {
    showToast(`最多同时上传 ${MAX_IMAGES} 张图片`, 'error');
    return;
  }
  for (const file of list) {
    try {
      const dataUrl = await compressImage(file);
      pendingImages.push(dataUrl);
    } catch (e) {
      showToast('图片处理失败: ' + file.name, 'error');
    }
  }
  renderPreviewBar();
}

function removeImage(idx) {
  pendingImages.splice(idx, 1);
  renderPreviewBar();
}

function renderPreviewBar() {
  const bar = document.getElementById('previewBar');
  if (pendingImages.length === 0) {
    bar.style.display = 'none';
    bar.innerHTML = '';
    return;
  }
  bar.style.display = 'flex';
  bar.innerHTML = pendingImages.map((url, i) => `
    <div class="vs-preview-item">
      <img src="${url}" onclick="viewImage(${i})" alt="图片${i + 1}">
      <button class="vs-preview-del" onclick="removeImage(${i})" title="移除">×</button>
    </div>
  `).join('');
}

function viewImage(idx) {
  document.getElementById('viewerImg').src = pendingImages[idx];
  document.getElementById('imageViewer').style.display = 'flex';
}

// 事件绑定
document.getElementById('attachBtn').addEventListener('click', () => {
  document.getElementById('fileInput').click();
});
document.getElementById('fileInput').addEventListener('change', function () {
  addImages(this.files);
  this.value = '';
});

// 拖拽
const conv = document.querySelector('.rt-conversation');
conv.addEventListener('dragover', (e) => { e.preventDefault(); conv.classList.add('dragover'); });
conv.addEventListener('dragleave', () => conv.classList.remove('dragover'));
conv.addEventListener('drop', (e) => {
  e.preventDefault();
  conv.classList.remove('dragover');
  if (e.dataTransfer.files.length) addImages(e.dataTransfer.files);
});

// 粘贴截图
document.addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  const files = [];
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  }
  if (files.length) {
    e.preventDefault();
    addImages(files);
  }
});

// ---------- 对话 UI ----------
function clearEmptyHint() {
  const empty = document.querySelector('.rt-empty');
  if (empty) empty.remove();
}

function scrollTranscript() {
  const t = document.getElementById('transcript');
  t.scrollTop = t.scrollHeight;
}

function addUserMsg(text, images) {
  clearEmptyHint();
  const el = document.createElement('div');
  el.className = 'rt-msg user';
  let html = '<div class="rt-msg-label">我</div>';
  if (images && images.length) {
    html += '<div class="vs-msg-images">' + images.map(u =>
      `<img src="${u}" onclick="viewHistoryImage(this.src)" alt="图片">`).join('') + '</div>';
  }
  html += `<span class="rt-msg-text">${escapeHtml(text)}</span>`;
  el.innerHTML = html;
  document.getElementById('transcript').appendChild(el);
  scrollTranscript();
}

function viewHistoryImage(src) {
  document.getElementById('viewerImg').src = src;
  document.getElementById('imageViewer').style.display = 'flex';
}

function addAssistantMsg() {
  clearEmptyHint();
  const el = document.createElement('div');
  el.className = 'rt-msg assistant streaming';
  el.innerHTML = '<div class="rt-msg-label">AI</div><div class="md-content rt-msg-text"></div>';
  document.getElementById('transcript').appendChild(el);
  scrollTranscript();
  return el;
}

function addSystemMsg(text) {
  clearEmptyHint();
  const el = document.createElement('div');
  el.className = 'rt-msg system';
  el.textContent = text;
  document.getElementById('transcript').appendChild(el);
  scrollTranscript();
}

// 轻量 markdown 渲染
function renderMarkdown(text) {
  let html = escapeHtml(text);
  // 代码块
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (m, lang, code) => `<pre><code>${code.trim()}</code></pre>`);
  // 行内代码
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  // 标题
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // 粗体
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // 无序列表
  html = html.replace(/^\s*[-*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>');
  html = html.replace(/<\/ul>\s*<ul>/g, '');
  // 有序列表
  html = html.replace(/^\s*\d+\. (.+)$/gm, '<oli>$1</oli>');
  html = html.replace(/(<oli>[\s\S]*?<\/oli>)/g, '<ol>$1</ol>');
  html = html.replace(/<oli>/g, '<li>').replace(/<\/oli>/g, '</li>');
  html = html.replace(/<\/ol>\s*<ol>/g, '');
  // 换行
  html = html.replace(/\n/g, '<br>');
  html = html.replace(/<br>(\s*)<h/g, '<h').replace(/<\/h(\d)><br>/g, '</h$1>');
  html = html.replace(/<br>(\s*)<(ul|ol|pre)/g, '<$2').replace(/<\/(ul|ol|pre)><br>/g, '</$1>');
  return html;
}

// ---------- 发送 ----------
async function send() {
  if (sending) return;
  const input = document.getElementById('textInput');
  const text = input.value.trim();
  if (!text && pendingImages.length === 0) {
    showToast('请输入问题或上传图片', 'error');
    return;
  }
  if (pendingImages.length > 0 && !text) {
    showToast('请输入对图片的问题或描述要求', 'error');
    return;
  }

  sending = true;
  setSendingUI(true);

  const images = [...pendingImages];
  pendingImages = [];
  renderPreviewBar();
  input.value = '';
  autoResize(input);

  const detail = document.getElementById('cfgDetail').value;

  // 构造多模态 content：图片在前、指令在后（官方建议，提升指令跟随）
  const content = images.map(url => ({ type: 'image_url', image_url: { url, detail } }));
  content.push({ type: 'text', text });

  history.push({ role: 'user', content });
  addUserMsg(text, images);

  const systemPrompt = document.getElementById('cfgSystem').value.trim();
  const messages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...history]
    : [...history];

  const assistantEl = addAssistantMsg();
  const textEl = assistantEl.querySelector('.rt-msg-text');
  let fullText = '';

  try {
    const res = await fetch('/api/vision/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        model: document.getElementById('cfgModel').value,
        temperature: parseFloat(document.getElementById('cfgTemperature').value) || 0.7,
        stream: true
      })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error && err.error.message ? err.error.message : `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const delta = json.choices && json.choices[0] && json.choices[0].delta;
          if (delta && delta.content) {
            fullText += delta.content;
            textEl.innerHTML = renderMarkdown(fullText);
            scrollTranscript();
          }
        } catch (e) { /* 忽略解析错误 */ }
      }
    }

    assistantEl.classList.remove('streaming');
    if (!fullText) {
      textEl.textContent = '（无响应内容）';
    }
    // 写入历史（多轮对话）
    history.push({ role: 'assistant', content: fullText });
  } catch (err) {
    assistantEl.classList.remove('streaming');
    textEl.textContent = '请求失败: ' + err.message;
    showToast('请求失败: ' + err.message, 'error');
    // 请求失败时移除刚加入的用户消息，避免历史污染
    history.pop();
  }

  sending = false;
  setSendingUI(false);
}

function setSendingUI(isSending) {
  document.getElementById('sendBtn').disabled = isSending;
  document.getElementById('textInput').disabled = isSending;
  document.getElementById('attachBtn').disabled = isSending;
}

// ---------- 清空对话 ----------
function clearConversation() {
  history = [];
  pendingImages = [];
  renderPreviewBar();
  document.getElementById('transcript').innerHTML = `
    <div class="rt-empty">
      <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.3;margin-bottom:12px;">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
        <circle cx="8.5" cy="8.5" r="1.5"/>
        <polyline points="21 15 16 10 5 21"/>
      </svg>
      <p>上传图片并提问，体验 StepFun 图片理解能力</p>
      <p class="rt-empty-hint">支持点击选择 / 拖拽 / 直接粘贴截图</p>
    </div>`;
  showToast('对话已清空');
}

// ---------- 输入框 ----------
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

document.getElementById('textInput').addEventListener('input', function () { autoResize(this); });
document.getElementById('textInput').addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
document.getElementById('sendBtn').addEventListener('click', send);

// ---------- API 状态检查 ----------
async function checkApiStatus() {
  const badge = document.getElementById('apiStatus');
  try {
    const res = await fetch('/api/health');
    if (res.ok) {
      badge.textContent = '服务正常';
      badge.className = 'api-badge connected';
    } else {
      throw new Error();
    }
  } catch {
    badge.textContent = '服务异常';
    badge.className = 'api-badge disconnected';
  }
}

checkApiStatus();
