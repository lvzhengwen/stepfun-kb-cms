/* ===== StepFun TTS 音频合成 ===== */

// 音色清单（按支持范围分组）
const VOICES = [
  // 三个模型通用音色（27 个）
  { id: 'elegantgentle-female', name: '气质温婉', scenarios: '客服、口播、情感陪伴', model: 'all' },
  { id: 'livelybreezy-female', name: '活力轻快', scenarios: '情感陪伴、客服、营销', model: 'all' },
  { id: 'wenrounansheng', name: '温柔男声', scenarios: '口播、情感陪伴、客服', model: 'all' },
  { id: 'wenrougongzi', name: '温柔公子', scenarios: '情感陪伴、有声书', model: 'all' },
  { id: 'yuanqinansheng', name: '元气男声', scenarios: '有声书、口播、客服', model: 'all' },
  { id: 'jingdiannvsheng', name: '经典女声', scenarios: '客服、情感陪伴', model: 'all' },
  { id: 'wenroushunv', name: '温柔熟女', scenarios: '客服、口播、教育培训', model: 'all' },
  { id: 'tianmeinvsheng', name: '甜美女声', scenarios: '情感陪伴、客服', model: 'all' },
  { id: 'qingchunshaonv', name: '清纯少女', scenarios: '客服、语音助手', model: 'all' },
  { id: 'cixingnansheng', name: '磁性男声', scenarios: '有声书、情感陪伴', model: 'all' },
  { id: 'yuanqishaonv', name: '元气少女', scenarios: '有声书、情感陪伴、语音助手', model: 'all' },
  { id: 'linjiajiejie', name: '邻家姐姐', scenarios: '口播、情感陪伴、语音助手', model: 'all' },
  { id: 'zhengpaiqingnian', name: '正派青年', scenarios: '营销、有声书', model: 'all' },
  { id: 'qingniandaxuesheng', name: '青年大学生', scenarios: '口播', model: 'all' },
  { id: 'boyinnansheng', name: '播音男声', scenarios: '有声书、口播', model: 'all' },
  { id: 'ruyananshi', name: '儒雅男士', scenarios: '有声书、情感陪伴、口播、语音助手', model: 'all' },
  { id: 'shenchennanyin', name: '深沉男音', scenarios: '情感陪伴、有声书', model: 'all' },
  { id: 'qinqienvsheng', name: '亲切女声', scenarios: '口播', model: 'all' },
  { id: 'wenrounvsheng', name: '温柔女声', scenarios: '有声书、情感陪伴', model: 'all' },
  { id: 'jilingshaonv', name: '机灵少女', scenarios: '语音助手、口播', model: 'all' },
  { id: 'ruanmengnvsheng', name: '软萌女声', scenarios: '情感陪伴、语音助手', model: 'all' },
  { id: 'youyanvsheng', name: '优雅女声', scenarios: '视频配音', model: 'all' },
  { id: 'lengyanyujie', name: '冷艳御姐', scenarios: '视频配音', model: 'all' },
  { id: 'shuangkuaijiejie', name: '爽快姐姐', scenarios: '口播', model: 'all' },
  { id: 'wenjingxuejie', name: '文静学姐', scenarios: '口播', model: 'all' },
  { id: 'linjiameimei', name: '邻家妹妹', scenarios: '视频配音、口播、语音助手', model: 'all' },
  { id: 'zhixingjiejie', name: '知性姐姐', scenarios: '视频配音、口播、语音助手', model: 'all' },
  // stepaudio-2.5-tts / step-tts-2 独占音色（9 个）
  { id: 'vibrant-youth', name: 'Vibrant Youth', scenarios: '有声书、视频配音', model: 'tts-2' },
  { id: 'lively-girl', name: 'Lively Girl', scenarios: '有声书、视频配音', model: 'tts-2' },
  { id: 'soft-spoken-gentleman', name: 'Soft-spoken Gentleman', scenarios: '情感陪伴、有声书', model: 'tts-2' },
  { id: 'magnetic-voiced-male', name: 'Magnetic-voiced Male', scenarios: '有声书、视频配音', model: 'tts-2' },
  { id: 'zixinnansheng', name: '自信男声', scenarios: '有声书、情感陪伴、教育培训、营销', model: 'tts-2' },
  { id: 'shuangkuainansheng', name: '爽快男声', scenarios: '客服、语音助手', model: 'tts-2' },
  { id: 'ganliannvsheng', name: '干练女声', scenarios: '客服、语音助手', model: 'tts-2' },
  { id: 'qinhenvsheng', name: '亲和女声', scenarios: '客服、语音助手', model: 'tts-2' },
  { id: 'huolinvsheng', name: '活力女声', scenarios: '客服、语音助手', model: 'tts-2' }
];

let latestResult = null;  // {blobUrl, blob, format, text, voice, model, size}
let history = [];
let synthing = false;
let lastBlobUrl = null; // 防止 object URL 内存泄漏

// ---------- 工具 ----------
function showToast(msg, type, duration) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = 'toast ' + (type === 'error' ? 'error' : 'success');
  toast.style.display = 'block';
  // 清除旧 timer（如果有），避免快速连续触发时提前消失
  if (toast._timer) clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.style.display = 'none'; toast.className = 'toast'; }, duration || 3500);
}

// 把 StepFun 原始错误转成对用户友好的中文提示
function formatCloneError(rawMsg) {
  if (!rawMsg) return '复刻失败：未知错误';
  if (rawMsg.includes('CER_NOT_PASS') || rawMsg.includes('cer is too high')) {
    const cerMatch = rawMsg.match(/cer is too high:?\s*([\d.]+)%?/i);
    const cer = cerMatch ? cerMatch[1] : '高';
    return `音频内容与填写文本字符错误率过高（CER ${cer}%）。\n建议：①录音时按填写的文本逐字说；②清空"音频对应文本"让系统自动识别。`;
  }
  if (rawMsg.length > 200) rawMsg = rawMsg.slice(0, 200) + '...';
  return `${rawMsg}`;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

// ---------- 模型变更时联动音色和风格 ----------
document.getElementById('cfgModel').addEventListener('change', onModelChange);
function onModelChange() {
  const model = document.getElementById('cfgModel').value;
  const voiceSelect = document.getElementById('cfgVoice');
  voiceSelect.innerHTML = VOICES.map(v => {
    const label = v.model === 'tts-2' && model === 'step-tts-mini'
      ? `${v.name}（${v.id}） — 仅 step-tts-2 / 2.5-tts`
      : `${v.name}（${v.id}）`;
    const disabled = (v.model === 'tts-2' && model === 'step-tts-mini') ? 'disabled' : '';
    return `<option value="${v.id}" ${disabled}>${label}</option>`;
  }).join('');
  // 默认选第一个可用的
  const firstAvailable = VOICES.find(v => !(v.model === 'tts-2' && model === 'step-tts-mini'));
  if (firstAvailable) voiceSelect.value = firstAvailable.id;
  updateVoiceHint();

  // step-tts-mini 不支持演绎风格（第 19~28）：禁用
  const styleSelect = document.getElementById('cfgStyle');
  Array.from(styleSelect.options).forEach(opt => {
    if (!opt.value) return;
    const isExclusive = ['骄傲','温柔','甜美','豪爽','严肃','傲慢','老年','吼叫','阴阳怪气','磕巴'].includes(opt.value);
    if (model === 'step-tts-mini' && isExclusive) {
      opt.disabled = true;
    } else {
      opt.disabled = false;
    }
  });
}

function updateVoiceHint() {
  const voice = VOICES.find(v => v.id === document.getElementById('cfgVoice').value);
  document.getElementById('voiceHint').textContent = voice ? `推荐：${voice.scenarios}` : '';
}

document.getElementById('cfgVoice').addEventListener('change', updateVoiceHint);

// ---------- 滑块实时显示 ----------
document.getElementById('cfgVolume').addEventListener('input', e => {
  document.getElementById('volumeVal').textContent = parseFloat(e.target.value).toFixed(1);
});
document.getElementById('cfgSpeed').addEventListener('input', e => {
  document.getElementById('speedVal').textContent = parseFloat(e.target.value).toFixed(1);
});

// ---------- 字符计数 ----------
document.getElementById('textInput').addEventListener('input', e => {
  document.getElementById('textCount').textContent = e.target.value.length;
});

// ---------- 合成 ----------
async function synthesize() {
  if (synthing) return;
  const text = document.getElementById('textInput').value.trim();
  if (!text) {
    showToast('请输入要合成的文本', 'error');
    document.getElementById('textInput').focus();
    return;
  }
  if (text.length > 4096) {
    showToast('文本超过 4096 字符', 'error');
    return;
  }

  const body = {
    model: document.getElementById('cfgModel').value,
    input: text,
    voice: document.getElementById('cfgVoice').value,
    volume: parseFloat(document.getElementById('cfgVolume').value),
    speed: parseFloat(document.getElementById('cfgSpeed').value),
    response_format: document.getElementById('cfgFormat').value
  };
  const emotion = document.getElementById('cfgEmotion').value;
  const style = document.getElementById('cfgStyle').value;
  if (emotion || style) {
    body.voice_label = {};
    if (emotion) body.voice_label.emotion = emotion;
    if (style) body.voice_label.style = style;
  }

  synthing = true;
  const btn = document.getElementById('synthBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-inline"></span> 合成中...';

  try {
    const res = await fetch('/api/tts/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error && err.error.message ? err.error.message : `HTTP ${res.status}`);
    }

    const blob = await res.blob();
    const format = res.headers.get('X-Audio-Format') || body.response_format;
    const voice = res.headers.get('X-Audio-Voice') || body.voice;
    const model = res.headers.get('X-Audio-Model') || body.model;

    if (lastBlobUrl) URL.revokeObjectURL(lastBlobUrl);
    lastBlobUrl = URL.createObjectURL(blob);

    latestResult = {
      blob,
      blobUrl: lastBlobUrl,
      format,
      size: blob.size,
      text,
      voice,
      model,
      emotion,
      style,
      at: Date.now()
    };
    history.unshift({ ...latestResult });
    renderPlayer();
    renderHistory();
    showToast(`合成成功（${fmtSize(blob.size)}）`);
  } catch (err) {
    showToast('合成失败: ' + err.message, 'error');
  }

  synthing = false;
  btn.disabled = false;
  btn.innerHTML = `
<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
  <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
  <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
</svg> 合成语音`;
}

// ---------- 渲染 ----------
function renderPlayer() {
  if (!latestResult) {
    document.getElementById('playerCard').style.display = 'none';
    return;
  }
  document.getElementById('playerCard').style.display = '';
  const player = document.getElementById('audioPlayer');
  player.src = latestResult.blobUrl;
  document.getElementById('audioMeta').innerHTML = `
    <span>格式：${latestResult.format.toUpperCase()}</span>
    <span>大小：${fmtSize(latestResult.size)}</span>
    <span>音色：${latestResult.voice}</span>
    ${latestResult.emotion ? `<span>情绪：${latestResult.emotion}</span>` : ''}
    ${latestResult.style ? `<span>风格：${latestResult.style}</span>` : ''}
  `;
}

function renderHistory() {
  const wrap = document.getElementById('historyWrap');
  const list = document.getElementById('history');
  document.getElementById('historyCount').textContent = `${history.length}`;
  if (history.length === 0) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = '';
  list.innerHTML = history.map((item, i) => {
    // 为每个历史项创建一个独立的 blob URL（避免互相覆盖）
    const url = URL.createObjectURL(item.blob);
    setTimeout(() => URL.revokeObjectURL(url), 60000); // 1 分钟后回收
    return `
      <div class="tts-history-item">
        <audio class="tts-history-audio" controls preload="none" src="${url}"></audio>
        <div class="tts-history-text">${escapeHtml(item.text)}</div>
        <div class="tts-history-meta">${item.format.toUpperCase()} · ${fmtSize(item.size)}</div>
        <div class="tts-history-actions">
          <button class="btn btn-ghost" onclick="downloadHistory(${i})">下载</button>
          <button class="btn btn-ghost" onclick="removeHistory(${i})">删除</button>
        </div>
      </div>`;
  }).join('');
}

// ---------- 下载 / 删除 ----------
function downloadLatest() {
  if (!latestResult) return;
  downloadBlob(latestResult.blob, `tts_${Date.now()}.${latestResult.format}`);
}

function downloadHistory(i) {
  const item = history[i];
  downloadBlob(item.blob, `tts_${item.at}.${item.format}`);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function removeHistory(i) {
  history.splice(i, 1);
  renderHistory();
}

// ---------- 清空 ----------
function clearAll() {
  document.getElementById('textInput').value = '';
  document.getElementById('textCount').textContent = '0';
}

// ---------- 接收来自音色复刻页面的 voice id ----------
// voice-clone.html 通过 URL ?voice=xxx 或 localStorage 传入复刻的音色 ID
function applyPendingVoiceId() {
  const params = new URLSearchParams(location.search);
  let voiceId = params.get('voice');
  if (!voiceId) {
    voiceId = localStorage.getItem('stepfun_pending_voice_id');
    if (voiceId) localStorage.removeItem('stepfun_pending_voice_id');
  }
  if (!voiceId) return;

  // 把 voice id 追加为"自定义音色"选项
  const select = document.getElementById('cfgVoice');
  let opt = Array.from(select.options).find(o => o.value === voiceId);
  if (!opt) {
    opt = document.createElement('option');
    opt.value = voiceId;
    opt.textContent = `自定义音色（${voiceId}）`;
    select.appendChild(opt);
  }
  select.value = voiceId;
  updateVoiceHint();
  // 清掉 URL 参数（避免刷新再次触发）
  if (params.has('voice')) {
    const url = new URL(location.href);
    url.searchParams.delete('voice');
    history.replaceState({}, '', url.toString());
  }
  showToast(`已应用复刻音色：${voiceId}`);
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

onModelChange();
checkApiStatus();
applyPendingVoiceId();

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