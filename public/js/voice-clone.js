/* ===== StepFun 音色复刻独立页面 ===== */

const REC_SAMPLE_RATE = 24000;
const LS_KEY = 'stepfun_cloned_voices_v1';

// ---------- 全局状态 ----------
let currentSource = null;       // { dataUrl, filename, mime, size, durationSec, fromRecording }
let clonedVoice = null;         // 最新复刻成功的 { id, model, ... }
let recStream = null, recCtx = null, recNode = null;
let recChunks = [], recTotalSamples = 0;
let recording = false, recTimer = null, recStartTime = 0;
let cloning = false;

const REC_WORKLET = `
class RecProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) this.port.postMessage(input[0].slice(0));
    return true;
  }
}
registerProcessor('rec-processor', RecProcessor);
`;

// ---------- 工具 ----------
function showToast(msg, type, duration) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = 'toast ' + (type === 'error' ? 'error' : 'success');
  toast.style.display = 'block';
  if (toast._timer) clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.style.display = 'none'; toast.className = 'toast'; }, duration || 3500);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function fmtDate(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function extractBase64(dataUrl) {
  if (!dataUrl) return '';
  const m = dataUrl.match(/^data:[^;]+;base64,(.+)$/);
  return m ? m[1] : dataUrl;
}

// 把 StepFun 原始错误转成对用户友好的中文提示
function formatCloneError(rawMsg) {
  if (!rawMsg) return '复刻失败：未知错误';
  if (rawMsg.includes('CER_NOT_PASS') || rawMsg.includes('cer is too high')) {
    const cerMatch = rawMsg.match(/cer is too high:?\s*([\d.]+)%?/i);
    const cer = cerMatch ? cerMatch[1] : '高';
    let msg = `音频内容与填写文本字符错误率过高（CER ${cer}%）。\n建议：①录音时按填写的文本逐字说；②清空"音频对应文本"让系统自动识别。`;
    return msg;
  }
  if (rawMsg.length > 200) rawMsg = rawMsg.slice(0, 200) + '...';
  return `${rawMsg}`;
}

// ---------- 音频源：上传 ----------
document.getElementById('uploadZone').addEventListener('click', () => {
  document.getElementById('fileInput').click();
});
document.getElementById('fileInput').addEventListener('change', function () {
  if (this.files[0]) handleUploadedFile(this.files[0]);
  this.value = '';
});
const uploadZoneEl = document.getElementById('uploadZone');
uploadZoneEl.addEventListener('dragover', (e) => { e.preventDefault(); uploadZoneEl.classList.add('dragover'); });
uploadZoneEl.addEventListener('dragleave', () => uploadZoneEl.classList.remove('dragover'));
uploadZoneEl.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadZoneEl.classList.remove('dragover');
  if (e.dataTransfer.files[0]) handleUploadedFile(e.dataTransfer.files[0]);
});

function handleUploadedFile(file) {
  if (!/^audio\/(mpeg|wav|x-wav|wave)$/.test(file.type) && !/\.(mp3|wav)$/i.test(file.name)) {
    showToast('仅支持 mp3 / wav 音频', 'error');
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    showToast('音频过大（建议 5~10 秒，≤10MB）', 'error');
    return;
  }
  // 如果正在录音，先停止
  if (recording) stopRecording();
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    // 探测时长
    const audio = new Audio();
    audio.src = dataUrl;
    audio.addEventListener('loadedmetadata', () => {
      setCurrentSource({
        dataUrl,
        filename: file.name,
        mime: file.type || 'audio/mpeg',
        size: file.size,
        durationSec: audio.duration,
        fromRecording: false
      });
    });
  };
  reader.readAsDataURL(file);
}

// ---------- 音频源：录音 ----------
async function toggleRecording() {
  if (recording) await stopRecording();
  else await startRecording();
}

async function startRecording() {
  // 清掉已有的源
  if (currentSource) clearSource();
  try {
    recStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, sampleRate: REC_SAMPLE_RATE, echoCancellation: true, noiseSuppression: true }
    });
  } catch (err) {
    showToast('无法访问麦克风: ' + err.message, 'error');
    return;
  }
  recCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: REC_SAMPLE_RATE });
  if (recCtx.state === 'suspended') await recCtx.resume();
  const source = recCtx.createMediaStreamSource(recStream);
  const blob = new Blob([REC_WORKLET], { type: 'application/javascript' });
  const workletUrl = URL.createObjectURL(blob);
  await recCtx.audioWorklet.addModule(workletUrl);
  URL.revokeObjectURL(workletUrl);
  recNode = new AudioWorkletNode(recCtx, 'rec-processor');
  recChunks = [];
  recTotalSamples = 0;
  recNode.port.onmessage = (e) => {
    if (!recording) return;
    recChunks.push(e.data);
    recTotalSamples += e.data.length;
  };
  source.connect(recNode);
  recNode.connect(recCtx.destination);
  recording = true;
  recStartTime = Date.now();
  updateRecordUI();
  recTimer = setInterval(() => {
    const secs = (Date.now() - recStartTime) / 1000;
    document.getElementById('recordTimer').textContent = secs.toFixed(1) + 's';
    if (secs >= 10) stopRecording();
  }, 100);
  showToast('开始录音，请清晰地说 5~10 秒');
}

async function stopRecording() {
  recording = false;
  if (recTimer) { clearInterval(recTimer); recTimer = null; }
  if (recNode) { recNode.disconnect(); recNode = null; }
  if (recCtx) { recCtx.close().catch(() => {}); recCtx = null; }
  if (recStream) { recStream.getTracks().forEach(t => t.stop()); recStream = null; }
  updateRecordUI();

  const secs = recTotalSamples / REC_SAMPLE_RATE;
  if (secs < 0.5) {
    showToast('录音太短，请重新录制', 'error');
    return;
  }
  if (secs < 2) showToast(`录音仅 ${secs.toFixed(1)} 秒，建议 5~10 秒以获得更好效果`, 'error');

  const wavBlob = float32ToWavBlob(recChunks, REC_SAMPLE_RATE);
  const reader = new FileReader();
  reader.onload = () => {
    setCurrentSource({
      dataUrl: reader.result,
      filename: `recording_${Date.now()}.wav`,
      mime: 'audio/wav',
      size: wavBlob.size,
      durationSec: secs,
      fromRecording: true
    });
  };
  reader.readAsDataURL(wavBlob);
}

function float32ToWavBlob(chunks, sampleRate) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const buffer = new ArrayBuffer(44 + total * 2);
  const view = new DataView(buffer);
  const ws = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); view.setUint32(4, 36 + total * 2, true); ws(8, 'WAVE');
  ws(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ws(36, 'data'); view.setUint32(40, total * 2, true);
  let off = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      let s = Math.max(-1, Math.min(1, chunk[i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function updateRecordUI() {
  const btn = document.getElementById('recordBtn');
  btn.classList.toggle('recording', recording);
  document.getElementById('recordBtnText').textContent = recording ? '点击停止' : '点击开始说话 5~10 秒';
  document.getElementById('recordTimer').style.display = recording ? '' : 'none';
}

// ---------- 当前音频源展示 ----------
function setCurrentSource(src) {
  currentSource = src;
  document.getElementById('previewSection').style.display = '';
  document.getElementById('cloneSection').style.display = '';
  document.getElementById('resultSection').style.display = 'none';
  const audio = document.getElementById('previewAudio');
  audio.src = src.dataUrl;
  document.getElementById('previewName').textContent = src.filename;
  document.getElementById('previewSize').textContent = fmtSize(src.size);
  document.getElementById('previewDuration').textContent = src.durationSec ? src.durationSec.toFixed(1) + 's' : '-';
  // 自动建议填文本：取前 60 字符
  const cfgText = document.getElementById('cfgText');
  if (!cfgText.value.trim() && !src.fromRecording) {
    cfgText.placeholder = '（可选）音频里说的内容，如：智能阶跃，十倍每一个人的可能';
  }
}

function clearSource() {
  currentSource = null;
  document.getElementById('previewSection').style.display = 'none';
  document.getElementById('cloneSection').style.display = 'none';
  document.getElementById('resultSection').style.display = 'none';
  document.getElementById('previewAudio').src = '';
}

// ---------- 复刻 ----------
async function cloneVoice() {
  if (cloning) return;
  if (!currentSource) {
    showToast('请先提供音频', 'error');
    return;
  }
  cloning = true;
  const btn = document.getElementById('cloneBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-inline"></span> 复刻中...';

  try {
    const res = await fetch('/api/tts/clone-voice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audio: currentSource.dataUrl,
        filename: currentSource.filename,
        mime: currentSource.mime,
        model: document.getElementById('cfgModel').value,
        text: document.getElementById('cfgText').value.trim()
      })
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error && data.error.message ? data.error.message : `HTTP ${res.status}`);
    }
    clonedVoice = {
      id: data.id,
      model: document.getElementById('cfgModel').value,
      text: document.getElementById('cfgText').value.trim(),
      sourceName: currentSource.filename,
      sourceDataUrl: currentSource.dataUrl,
      sourceMime: currentSource.mime,
      sourceSize: currentSource.size,
      sourceDuration: currentSource.durationSec,
      fromRecording: currentSource.fromRecording,
      duplicated: !!data.duplicated,
      at: Date.now()
    };
    // 保存到音色库
    saveToLibrary(clonedVoice);
    renderResult();
    renderLibrary();
    showToast(data.duplicated ? '音色已存在，复用成功' : '音色复刻成功');
  } catch (err) {
    showToast('复刻失败：' + formatCloneError(err.message), 'error', 8000);
  }
  cloning = false;
  btn.disabled = false;
  btn.innerHTML = `
<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 20h9"/>
  <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z"/>
</svg> 开始复刻`;
}

function renderResult() {
  if (!clonedVoice) {
    document.getElementById('resultSection').style.display = 'none';
    return;
  }
  document.getElementById('resultSection').style.display = '';
  document.getElementById('resultVoiceId').textContent = clonedVoice.id;
  document.getElementById('resultModel').textContent = `模型：${clonedVoice.model}${clonedVoice.duplicated ? '（已存在，复用）' : ''}`;
}

async function copyVoiceId() {
  if (!clonedVoice) return;
  try {
    await navigator.clipboard.writeText(clonedVoice.id);
    showToast('音色 ID 已复制');
  } catch {
    showToast('复制失败，请手动选择', 'error');
  }
}

// 跳转到 TTS 页面，自动填入复刻音色
function useInTTS() {
  if (!clonedVoice) return;
  // 把 voice id 暂存到 localStorage，tts.html 启动时读
  localStorage.setItem('stepfun_pending_voice_id', clonedVoice.id);
  window.location.href = '/tts.html?voice=' + encodeURIComponent(clonedVoice.id);
}

// ---------- 音色库（localStorage） ----------
function loadLibrary() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '[]');
  } catch { return []; }
}

function saveLibrary(list) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(list));
  } catch (e) {
    showToast('音色库保存失败：' + e.message, 'error');
  }
}

function saveToLibrary(voice) {
  const list = loadLibrary();
  // 去重（同一 voice id 不重复）
  const idx = list.findIndex(v => v.id === voice.id);
  if (idx >= 0) list[idx] = voice;
  else list.unshift(voice);
  saveLibrary(list);
}

function removeFromLibrary(voiceId) {
  const list = loadLibrary().filter(v => v.id !== voiceId);
  saveLibrary(list);
}

function clearLibrary() {
  if (!confirm('确定清空所有复刻的音色？此操作不可恢复。')) return;
  saveLibrary([]);
  renderLibrary();
  showToast('音色库已清空');
}

function renderLibrary() {
  const list = loadLibrary();
  const wrap = document.getElementById('library');
  document.getElementById('libraryCount').textContent = list.length;
  if (list.length === 0) {
    wrap.innerHTML = '<div class="vc-library-empty">还没有复刻的音色。在上方提供音频并点击"开始复刻"试试。</div>';
    return;
  }
  wrap.innerHTML = list.map((v, i) => `
    <div class="vc-lib-item">
      <button class="vc-lib-icon" onclick="toggleLibPlay(${i}, event)" title="试听原音" aria-label="试听">
        <svg class="vc-play-icon" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <polygon points="6 4 20 12 6 20 6 4"/>
        </svg>
      </button>
      <div class="vc-lib-info">
        <div class="vc-lib-id" onclick="copyLibId(${i})" title="点击复制">${escapeHtml(v.id)}</div>
        <div class="vc-lib-meta">${escapeHtml(v.model)} · ${v.text ? '文本：' + escapeHtml(v.text.slice(0, 30)) + (v.text.length > 30 ? '...' : '') : '自动识别'} · ${fmtDate(v.at)} · ${v.sourceName || ''} ${v.sourceSize ? '· ' + fmtSize(v.sourceSize) : ''}</div>
      </div>
      <div class="vc-lib-actions">
        <button class="btn btn-ghost" onclick="downloadLibAudio(${i})">下载原音</button>
        <button class="btn btn-ghost" onclick="useLibInTTS(${i})">用 TTS</button>
        <button class="btn btn-ghost" onclick="removeLibItem(${i})">删除</button>
      </div>
    </div>
  `).join('');
}

// 试听音色库中的原始音频（一个时刻只能播一个）
let currentLibAudio = null;
const PLAY_ICON = '<svg class="vc-play-icon" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>';
const PAUSE_ICON = '<svg class="vc-play-icon" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';

function toggleLibPlay(i, ev) {
  if (ev) ev.stopPropagation();
  const v = loadLibrary()[i];
  if (!v || !v.sourceDataUrl) {
    showToast('该音色没有保存原始音频', 'error');
    return;
  }
  const btn = ev ? ev.currentTarget : null;
  // 如果已经在播这个，暂停
  if (currentLibAudio && currentLibAudio.dataset.libIdx === String(i) && !currentLibAudio.paused) {
    currentLibAudio.pause();
    return;
  }
  // 暂停其他
  if (currentLibAudio) {
    currentLibAudio.pause();
  }
  // 创建/复用 audio
  if (!currentLibAudio) {
    currentLibAudio = new Audio();
    currentLibAudio.addEventListener('ended', resetAllPlayIcons);
    currentLibAudio.addEventListener('pause', () => {
      // 同步所有按钮状态
      document.querySelectorAll('.vc-lib-icon').forEach(b => {
        b.classList.remove('playing');
        b.innerHTML = PLAY_ICON;
      });
    });
  }
  currentLibAudio.src = v.sourceDataUrl;
  currentLibAudio.dataset.libIdx = String(i);
  // 重置所有按钮状态
  document.querySelectorAll('.vc-lib-icon').forEach(b => {
    b.classList.remove('playing');
    b.innerHTML = PLAY_ICON;
  });
  currentLibAudio.play().then(() => {
    if (btn) {
      btn.classList.add('playing');
      btn.innerHTML = PAUSE_ICON;
    }
  }).catch(err => showToast('播放失败: ' + err.message, 'error'));
}

function resetAllPlayIcons() {
  document.querySelectorAll('.vc-lib-icon').forEach(b => {
    b.classList.remove('playing');
    b.innerHTML = PLAY_ICON;
  });
}

function downloadLibAudio(i) {
  const v = loadLibrary()[i];
  if (!v || !v.sourceDataUrl) {
    showToast('该音色没有保存原始音频', 'error');
    return;
  }
  const a = document.createElement('a');
  a.href = v.sourceDataUrl;
  a.download = v.sourceName || `voice_${i + 1}.wav`;
  a.click();
}

async function copyLibId(i) {
  const v = loadLibrary()[i];
  if (!v) return;
  try {
    await navigator.clipboard.writeText(v.id);
    showToast('音色 ID 已复制');
  } catch { showToast('复制失败，请手动选择', 'error'); }
}

function useLibInTTS(i) {
  const v = loadLibrary()[i];
  if (!v) return;
  localStorage.setItem('stepfun_pending_voice_id', v.id);
  window.location.href = '/tts.html?voice=' + encodeURIComponent(v.id);
}

function removeLibItem(i) {
  const list = loadLibrary();
  if (!list[i]) return;
  if (!confirm(`确定删除音色 ${list[i].id}？`)) return;
  list.splice(i, 1);
  saveLibrary(list);
  renderLibrary();
}

// ---------- 填写文本联动 ----------
document.getElementById('cfgText').addEventListener('input', function () {
  const hint = document.getElementById('textHint');
  hint.textContent = this.value.trim()
    ? '💡 录音请按上方文本逐字清晰地说，复刻效果最好'
    : '录音时按这里填的文本逐字说，匹配度最高';
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
renderLibrary();

// 卸载时停止录音
window.addEventListener('beforeunload', () => {
  if (recording) stopRecording();
});

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
