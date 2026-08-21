/* ===== StepFun 视频理解 ===== */

const MAX_SIZE_MB = 128;   // StepFun 官方上限
const WARN_SIZE_MB = 100;   // 超过此大小提醒用 URL

// 当前视频：{ type, url, name?, size?, objectUrl? }
let currentVideo = null;
let history = [];
let sending = false;

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

// ---------- 来源切换 ----------
function onSourceChange() {
  const src = document.getElementById('cfgSource').value;
  document.getElementById('sourceFile').style.display = src === 'file' ? '' : 'none';
  document.getElementById('sourceUrl').style.display = src === 'url' ? '' : 'none';
  document.getElementById('sourceStepfile').style.display = src === 'stepfile' ? '' : 'none';
  clearVideo();
}

// ---------- 文件上传 ----------
document.getElementById('uploadZone').addEventListener('click', () => {
  document.getElementById('fileInput').click();
});
document.getElementById('fileInput').addEventListener('change', function () {
  if (this.files[0]) handleFile(this.files[0]);
  this.value = '';
});

const conv = document.querySelector('.rt-conversation');
conv.addEventListener('dragover', (e) => { e.preventDefault(); conv.classList.add('dragover'); });
conv.addEventListener('dragleave', () => conv.classList.remove('dragover'));
conv.addEventListener('drop', (e) => {
  e.preventDefault();
  conv.classList.remove('dragover');
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});

const uploadZone = document.getElementById('uploadZone');
uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.classList.add('dragover'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
uploadZone.addEventListener('drop', (e) => {
  e.preventDefault();
  e.stopPropagation();
  uploadZone.classList.remove('dragover');
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});

function handleFile(file) {
  const validTypes = ['video/mp4', 'video/quicktime', 'video/x-matroska'];
  if (!validTypes.includes(file.type)) {
    showToast('仅支持 MP4 / MOV / MKV 视频', 'error');
    return;
  }
  const sizeMB = file.size / 1024 / 1024;
  if (sizeMB > MAX_SIZE_MB) {
    showToast(`视频过大（${sizeMB.toFixed(1)}MB），官方限制 ${MAX_SIZE_MB}MB。请用 ffmpeg 切割或改用 URL`, 'error');
    return;
  }
  if (sizeMB > WARN_SIZE_MB) {
    showToast(`视频 ${sizeMB.toFixed(1)}MB，传输较慢，建议改用外链 URL`, 'error');
  }

  const reader = new FileReader();
  reader.onload = () => {
    // dataUrl = data:video/mp4;base64,xxxxx
    currentVideo = {
      type: 'file',
      url: reader.result,
      name: file.name,
      size: file.size,
      mime: file.type
    };
    renderVideoPreview();
  };
  reader.onerror = () => showToast('文件读取失败', 'error');
  reader.readAsDataURL(file);
}

// ---------- URL 输入 ----------
document.getElementById('videoUrl').addEventListener('input', function () {
  if (this.value.trim()) {
    currentVideo = { type: 'url', url: this.value.trim() };
    renderVideoPreview();
  } else {
    clearVideo();
  }
});

document.getElementById('videoFileId').addEventListener('input', function () {
  const v = this.value.trim();
  if (v) {
    currentVideo = { type: 'stepfile', url: 'stepfile://' + v };
    renderVideoPreview();
  } else {
    clearVideo();
  }
});

// ---------- 预览 ----------
function renderVideoPreview() {
  const box = document.getElementById('videoPreview');
  const clearBtn = document.getElementById('clearVideoBtn');
  if (!currentVideo) {
    box.style.display = 'none';
    box.innerHTML = '';
    clearBtn.style.display = 'none';
    return;
  }
  clearBtn.style.display = '';
  box.style.display = '';

  if (currentVideo.type === 'file') {
    box.innerHTML = `
      <video controls src="${currentVideo.url}"></video>
      <div class="vd-preview-info">
        <span class="vd-name" title="${escapeHtml(currentVideo.name)}">${escapeHtml(currentVideo.name)}</span>
        <span>${fmtSize(currentVideo.size)}</span>
      </div>`;
  } else if (currentVideo.type === 'url') {
    box.innerHTML = `<div class="vd-preview-info" style="padding:6px 2px;"><span class="vd-name">URL: ${escapeHtml(currentVideo.url)}</span></div>`;
  } else {
    box.innerHTML = `<div class="vd-preview-info" style="padding:6px 2px;"><span class="vd-name">${escapeHtml(currentVideo.url)}</span></div>`;
  }
}

function clearVideo() {
  currentVideo = null;
  document.getElementById('videoUrl').value = '';
  document.getElementById('videoFileId').value = '';
  renderVideoPreview();
}

// ---------- 对话 UI ----------
function clearEmptyHint() {
  const empty = document.querySelector('.rt-empty');
  if (empty) empty.remove();
}

function scrollTranscript() {
  const t = document.getElementById('transcript');
  t.scrollTop = t.scrollHeight;
}

function addUserMsg(text, video) {
  clearEmptyHint();
  const el = document.createElement('div');
  el.className = 'rt-msg user';
  let html = '<div class="rt-msg-label">我</div>';
  if (video) {
    if (video.type === 'file') {
      html += `<video class="vd-msg-video" controls src="${video.url}"></video>`;
    } else {
      html += `<div class="vd-preview-info" style="margin-bottom:6px;"><span class="vd-name" style="background:rgba(255,255,255,0.15);padding:2px 8px;border-radius:4px;">${escapeHtml(video.url)}</span></div>`;
    }
  }
  html += `<span class="rt-msg-text">${escapeHtml(text)}</span>`;
  el.innerHTML = html;
  document.getElementById('transcript').appendChild(el);
  scrollTranscript();
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

// 轻量 markdown（同 vision 页）
function renderMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (m, lang, code) => `<pre><code>${code.trim()}</code></pre>`);
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/^\s*[-*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>');
  html = html.replace(/<\/ul>\s*<ul>/g, '');
  html = html.replace(/^\s*\d+\. (.+)$/gm, '<oli>$1</oli>');
  html = html.replace(/(<oli>[\s\S]*?<\/oli>)/g, '<ol>$1</ol>');
  html = html.replace(/<oli>/g, '<li>').replace(/<\/oli>/g, '</li>');
  html = html.replace(/<\/ol>\s*<ol>/g, '');
  html = html.replace(/\n/g, '<br>');
  html = html.replace(/<br>(\s*)<h/g, '<h').replace(/<\/h(\d)><br>/g, '</h$1>');
  html = html.replace(/<br>(\s*)<(ul|ol|pre)/g, '<$2').replace(/<\/ul>/g, '</ul>').replace(/<\/ol>/g, '</ol>').replace(/<\/pre>/g, '</pre>');
  return html;
}

// ---------- 发送 ----------
async function send() {
  if (sending) return;
  const input = document.getElementById('textInput');
  const text = input.value.trim();
  if (!text) {
    showToast('请输入对视频的提问或描述', 'error');
    input.focus();
    return;
  }
  if (!currentVideo) {
    showToast('请先提供视频（上传 / URL / stepfile）', 'error');
    return;
  }

  sending = true;
  setSendingUI(true);

  const video = currentVideo;
  input.value = '';
  autoResize(input);

  // 视频在前、文本在后（官方建议）
  const userMessageContent = [
    { type: 'video_url', video_url: { url: video.url } },
    { type: 'text', text }
  ];
  history.push({ role: 'user', content: userMessageContent });
  addUserMsg(text, video);

  const systemPrompt = document.getElementById('cfgSystem').value.trim();
  const messages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...history]
    : [...history];

  const assistantEl = addAssistantMsg();
  const textEl = assistantEl.querySelector('.rt-msg-text');
  let fullText = '';

  try {
    const res = await fetch('/api/video/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        model: document.getElementById('cfgModel').value,
        temperature: parseFloat(document.getElementById('cfgTemperature').value) || 0.7,
        max_tokens: parseInt(document.getElementById('cfgMaxTokens').value, 10) || 1024,
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
        } catch (e) { /* ignore */ }
      }
    }

    assistantEl.classList.remove('streaming');
    if (!fullText) textEl.textContent = '（无响应内容）';
    history.push({ role: 'assistant', content: fullText });
  } catch (err) {
    assistantEl.classList.remove('streaming');
    textEl.textContent = '请求失败: ' + err.message;
    showToast('请求失败: ' + err.message, 'error');
    history.pop();
  }

  sending = false;
  setSendingUI(false);
}

function setSendingUI(isSending) {
  document.getElementById('sendBtn').disabled = isSending;
  document.getElementById('textInput').disabled = isSending;
  document.getElementById('cfgSource').disabled = isSending;
}

function clearConversation() {
  history = [];
  document.getElementById('transcript').innerHTML = `
    <div class="rt-empty">
      <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.3;margin-bottom:12px;">
        <path d="M23 7l-7 5 7 5V7z"/>
        <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
      </svg>
      <p>上传视频或输入视频地址，提问视频内容</p>
      <p class="rt-empty-hint">支持 MP4 / MOV / MKV</p>
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
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
document.getElementById('sendBtn').addEventListener('click', send);

// ---------- 粘贴自动识别视频 URL ----------
document.getElementById('textInput').addEventListener('paste', function (e) {
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if (!text) return;
  // 匹配视频 URL（mp4 / mov / mkv / webm / m3u8 等）
  const m = text.match(/https?:\/\/[^\s]+\.(?:mp4|mov|mkv|webm|m3u8)(?:\?[^\s]*)?/i);
  if (!m) return;
  e.preventDefault();
  const url = m[0];

  // 自动切换到 URL 输入模式
  const srcSelect = document.getElementById('cfgSource');
  if (srcSelect.value !== 'url') {
    srcSelect.value = 'url';
    onSourceChange();
  }
  // 填入 URL 输入框（触发 input 事件更新 currentVideo）
  const urlInput = document.getElementById('videoUrl');
  urlInput.value = url;
  urlInput.dispatchEvent(new Event('input'));

  // 文本框保留 URL 后剩余的文字（作为问题）
  const rest = text.replace(url, '').trim();
  setTimeout(() => {
    this.value = rest;
    autoResize(this);
  }, 0);

  // m3u8 特殊提醒
  if (/\.m3u8(\?|$)/i.test(url)) {
    showToast('检测到 m3u8，StepFun 仅支持 MP4/MOV/MKV，请先用 ffmpeg 转码', 'error');
  } else {
    showToast('已自动识别视频 URL，请输入问题后发送');
  }
});

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