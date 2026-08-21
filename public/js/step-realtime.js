/* ===== StepFun Realtime 实时语音对话 ===== */

// ---------- 全局状态 ----------
let ws = null;
let connected = false;
let sessionReady = false;

// 麦克风采集
let micStream = null;
let captureCtx = null;
let captureNode = null;
let micOn = false;

// 音频播放
let playbackCtx = null;
let nextPlayTime = 0;
let activeSources = [];

// 对话 UI
let currentAssistantMsg = null; // 正在流式输出的 assistant 气泡
const userMsgEls = {};          // item_id -> 用户气泡 DOM 元素（占位 → 转录回填）

// 响应状态
let responding = false;         // AI 响应进行中（response.created → response.done/audio.done）
let cancelWatchdog = null;      // response.cancel 看门狗

// 本地打断检测（不依赖服务端 speech_started）
const BARGE_IN_RMS = 0.045;     // 能量阈值（回声消除后的人声明显高于此值）
const BARGE_IN_FRAMES = 5;      // 持续帧数（约 100ms）
let loudFrames = 0;

const SAMPLE_RATE = 24000;

// ---------- 工具函数 ----------
function showToast(msg, type) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = 'toast ' + (type === 'error' ? 'error' : 'success');
  toast.style.display = 'block';
  setTimeout(() => { toast.style.display = 'none'; toast.className = 'toast'; }, 3000);
}

function logEvent(text, isErr) {
  const log = document.getElementById('eventLog');
  if (!log || log.style.display === 'none') return;
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const line = document.createElement('div');
  if (isErr) line.className = 'log-err';
  line.innerHTML = `<span class="log-time">[${time}]</span> ${escapeHtml(text)}`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
  // 限制日志条数
  while (log.children.length > 300) log.removeChild(log.firstChild);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function base64FromBytes(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function bytesFromBase64(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function float32ToPCM16Base64(float32) {
  const buffer = new ArrayBuffer(float32.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < float32.length; i++) {
    let s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return base64FromBytes(new Uint8Array(buffer));
}

// ---------- 状态栏 ----------
function setState(state, text) {
  const dot = document.getElementById('rtStateDot');
  dot.className = 'rt-state-dot' + (state ? ' ' + state : '');
  document.getElementById('rtStateText').textContent = text;
  const badge = document.getElementById('wsStatus');
  badge.textContent = text;
  badge.className = 'api-badge ' + (state === 'connected' || state === 'listening' || state === 'speaking'
    ? 'connected' : state === 'connecting' ? 'connecting' : state === 'error' ? 'error' : 'disconnected');
}

// ---------- 会话配置 ----------
function buildSessionConfig() {
  const vadOn = document.getElementById('cfgVad').checked;
  const webSearchOn = document.getElementById('cfgWebSearch').checked;

  // web_search 开启时，在系统指令中强力引导模型联网查询
  //（实测：弱引导会被模型忽略，它会凭过时记忆自信作答）
  let instructions = document.getElementById('cfgInstructions').value.trim();
  if (webSearchOn) {
    instructions += '\n注意：你的训练知识可能已过时。凡涉及具体时间、日期、赛事结果、天气、新闻、汇率等信息的问题，无论你是否觉得知道答案，都必须先使用网络搜索工具查询，再基于搜索结果回答。';
  }

  const config = {
    modalities: ['text', 'audio'],
    instructions: instructions || undefined,
    voice: document.getElementById('cfgVoice').value,
    input_audio_format: 'pcm16',
    output_audio_format: 'pcm16',
    turn_detection: vadOn ? {
      type: 'server_vad',
      prefix_padding_ms: 500,
      silence_duration_ms: parseInt(document.getElementById('cfgSilence').value, 10) || 500,
      energy_awakeness_threshold: parseInt(document.getElementById('cfgEnergy').value, 10) || 2500
    } : null
  };

  // 组装工具列表：web_search + retrieval + 自定义函数
  const tools = [];

  // 内置网络搜索工具（description 需明确触发条件，否则模型不调用）
  if (webSearchOn) {
    tools.push({
      type: 'web_search',
      function: {
        description: '当用户问题涉及实时信息、新闻、天气、赛事结果、最新动态等需要联网查询的内容时，使用此工具搜索答案',
        options: {
          top_k: parseInt(document.getElementById('cfgWsTopK').value, 10) || 5,
          timeout_seconds: parseInt(document.getElementById('cfgWsTimeout').value, 10) || 3
        }
      }
    });
  }

  // 知识库检索工具
  const kbEnable = document.getElementById('cfgKbEnable').checked;
  const kbId = document.getElementById('cfgKbSelect').value;
  const kbDesc = document.getElementById('cfgKbDesc').value.trim();
  if (kbEnable && kbId && kbDesc) {
    tools.push({
      type: 'retrieval',
      function: {
        description: kbDesc,
        options: {
          vector_store_id: kbId,
          prompt_template: '从文档{{knowledge}}中找到问题{{query}}的答案。根据文档内容中的语句找到答案，如果文档中没有答案则告诉用户找不到相关信息。'
        }
      }
    });
  }

  // 自定义函数工具
  for (const fn of collectFunctionTools()) {
    tools.push({
      type: 'function',
      function: { name: fn.name, description: fn.description, parameters: fn.parameters }
    });
  }

  if (tools.length > 0) config.tools = tools;
  return config;
}

function sendEvent(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    obj.event_id = 'evt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

// ---------- 连接管理 ----------
function toggleConnection() {
  if (connected || (ws && ws.readyState === WebSocket.CONNECTING)) {
    disconnect();
  } else {
    connect();
  }
}

// 获取或生成用户标识（用于记忆功能），存 localStorage 持久化
function getUserOrCreateId() {
  var KEY = 'memory_user_id';
  var id = localStorage.getItem(KEY);
  if (!id) {
    id = (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'usr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
    localStorage.setItem(KEY, id);
  }
  return id;
}

function connect() {
  const model = document.getElementById('cfgModel').value;
  const kbEnable = document.getElementById('cfgKbEnable').checked;
  if (kbEnable) {
    if (!document.getElementById('cfgKbSelect').value) {
      showToast('请选择要挂载的知识库', 'error');
      return;
    }
    if (!document.getElementById('cfgKbDesc').value.trim()) {
      showToast('请填写知识库检索触发描述', 'error');
      return;
    }
  }

  // 连接前校验自定义函数配置（格式错误直接提示，不发起连接）
  try {
    collectFunctionTools();
  } catch (e) {
    showToast(e.message, 'error');
    return;
  }

  setState('connecting', '连接中...');
  updateConnectBtn(true);

  // 对接 WebSocket 中转代理（服务端 product-config.json 统一管理配置）
  // 中转地址可在页面配置，默认本地，可切到服务器
  // 自动带 userId — 用于记忆功能，无感知
  const wsBase = (document.getElementById('cfgWsUrl')?.value || '').trim() || 'ws://127.0.0.1:8080';
  const userId = getUserOrCreateId();
  const wsUrl = wsBase + (wsBase.includes('?') ? '&' : '?') + 'userId=' + encodeURIComponent(userId);
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    logEvent('WebSocket 已连接（中转 ' + wsBase + '），等待 session.created ...');
  };

  ws.onmessage = (e) => {
    let evt;
    try { evt = JSON.parse(e.data); } catch { return; }
    handleServerEvent(evt);
  };

  ws.onclose = (e) => {
    const reason = e.reason ? ` (${e.reason})` : '';
    logEvent(`连接已关闭 code=${e.code}${reason}`);
    if (e.code !== 1000 && connected) {
      showToast(`连接已断开${reason ? ': ' + e.reason : ''}，请重新连接`, 'error');
    }
    onDisconnected();
  };

  ws.onerror = () => {
    setState('error', '连接错误');
    showToast('WebSocket 连接失败', 'error');
  };
}

function disconnect() {
  if (ws) {
    ws.onclose = null;
    ws.close();
    ws = null;
  }
  stopMic();
  onDisconnected();
  logEvent('已主动断开连接');
}

function onDisconnected() {
  connected = false;
  sessionReady = false;
  setState('', '未连接');
  updateConnectBtn(false);
  document.getElementById('micBtn').disabled = true;
  document.getElementById('interruptBtn').disabled = true;
  document.getElementById('greetBtn').disabled = true;
  document.getElementById('textInput').disabled = true;
  document.getElementById('textSendBtn').disabled = true;
  document.getElementById('commitBtn').disabled = true;
  finalizeAssistantMsg();
  stopPlayback();
  // 清理函数调用状态
  funcCallQueue.length = 0;
  funcCallActive = null;
  for (const k of Object.keys(funcCallArgBuf)) delete funcCallArgBuf[k];
  document.getElementById('funcCallModal').style.display = 'none';
}

function updateConnectBtn(isConnected) {
  const btn = document.getElementById('connectBtn');
  btn.innerHTML = isConnected
    ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/></svg> 断开'
    : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> 连接';
  btn.className = isConnected ? 'btn btn-danger' : 'btn btn-primary';
}

// ---------- 服务器事件处理 ----------
function handleServerEvent(evt) {
  const type = evt.type;

  // 音频增量不逐条打日志（太频繁）
  if (type !== 'response.audio.delta') {
    logEvent('← ' + type);
  }

  switch (type) {
    case 'session.created': {
      connected = true;
      // 发送会话配置
      const cfg = buildSessionConfig();
      const toolSummary = cfg.tools && cfg.tools.length
        ? cfg.tools.map(t => t.type === 'function' ? 'function:' + t.function.name : t.type).join(', ')
        : '(无)';
      logEvent('→ session.update tools=[' + toolSummary + ']');
      sendEvent({ type: 'session.update', session: cfg });
      break;
    }

    case 'session.updated':
      // 日志中显示已生效的工具，便于确认配置是否下发成功
      const tools = evt.session && evt.session.tools;
      logEvent('  已生效工具: ' + (tools && tools.length
        ? tools.map(t => t.type === 'function' ? 'function:' + (t.function && t.function.name) : t.type).join(', ')
        : '(无)'));
      sessionReady = true;
      setState('connected', '已连接');
      document.getElementById('micBtn').disabled = false;
      document.getElementById('interruptBtn').disabled = false;
      document.getElementById('greetBtn').disabled = false;
      document.getElementById('textInput').disabled = false;
      document.getElementById('textSendBtn').disabled = false;
      if (!document.getElementById('cfgVad').checked) {
        document.getElementById('commitBtn').style.display = '';
      }
      addSystemMsg('会话已建立，可以开始说话了');
      break;

    case 'input_audio_buffer.speech_started':
      // 用户开始说话 —— 打断场景：清空本地播放缓冲
      stopPlayback();
      finalizeAssistantMsg();
      setState('listening', '正在聆听...');
      // 立即显示占位气泡，保证对话顺序与实时反馈
      if (evt.item_id) addUserPlaceholder(evt.item_id);
      break;

    case 'input_audio_buffer.speech_stopped':
      setState('connected', '思考中...');
      break;

    case 'conversation.item.input_audio_transcription.completed':
      // 转录是异步的，可能在响应之前或之后到达 —— 回填占位气泡
      updateUserMsg(evt.item_id, evt.transcript || '（语音）');
      break;

    case 'conversation.item.created':
      // 函数调用项创建（模型发起 Tool Call 的第一个信号）
      if (evt.item && evt.item.type === 'function_call') {
        logEvent(`← 🔧 函数调用项创建: ${evt.item.name}() call_id=${evt.item.call_id}`);
        addToolCallMsg(`🔧 模型请求调用 ${evt.item.name || 'function'}() ...`);
      }
      // 用户语音 item 创建（兜底：speech_started 没带 item_id 时）
      if (evt.item && evt.item.role === 'user' && evt.item.id && !userMsgEls[evt.item.id]) {
        const hasAudio = (evt.item.content || []).some(c => c.type === 'input_audio');
        if (hasAudio) addUserPlaceholder(evt.item.id);
      }
      break;

    case 'response.created':
      responding = true;
      loudFrames = 0;
      setState('speaking', 'AI 回复中...');
      ensureAssistantMsg();
      break;

    case 'response.audio.delta':
      playPCMDelta(evt.delta);
      break;

    case 'response.audio_transcript.delta':
      appendAssistantText(evt.delta);
      break;

    case 'response.text.delta':
      appendAssistantText(evt.delta);
      break;

    case 'response.audio_transcript.done':
    case 'response.text.done':
      finalizeAssistantMsg();
      break;

    case 'response.audio.done':
      // 部分场景 response.done 可能迟到或缺失，音频结束即收尾本轮
      onResponseFinished('audio.done');
      break;

    case 'response.done': {
      const status = evt.response && evt.response.status;
      logEvent('  response.done status=' + status, status && status !== 'completed');
      if (status && status !== 'completed') {
        addSystemMsg(`本轮响应未正常完成（${status}），可尝试重新提问`);
      }
      onResponseFinished('done');
      break;
    }

    case 'response.cancelled':
      stopPlayback();
      onResponseFinished('cancelled');
      break;

    case 'input_audio_buffer.committed':
      setState('connected', '思考中...');
      break;

    case 'response.function_call_arguments.delta':
      // 累积函数调用参数（按 call_id 分组）
      if (evt.call_id) {
        funcCallArgBuf[evt.call_id] = (funcCallArgBuf[evt.call_id] || '') + (evt.delta || '');
      }
      break;

    case 'response.function_call_arguments.done': {
      const callId = evt.call_id || '';
      const argsText = evt.arguments || funcCallArgBuf[callId] || '{}';
      delete funcCallArgBuf[callId];
      let argsPretty = argsText;
      try { argsPretty = JSON.stringify(JSON.parse(argsText), null, 2); } catch { /* 原样展示 */ }
      addToolCallMsg(`🔧 ${evt.name || 'function'}(${truncate(argsText.replace(/\s+/g, ' '), 100)})`);
      enqueueFunctionCall({ call_id: callId, name: evt.name || '', arguments: argsPretty });
      break;
    }

    case 'error': {
      const err = evt.error || {};
      logEvent(`← error: ${err.type || ''} ${err.message || ''}`, true);
      showToast(err.message || '发生错误', 'error');
      if (err.type === 'config_error') {
        setState('error', '配置错误');
      }
      break;
    }
  }
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// ---------- 对话气泡 ----------
function clearEmptyHint() {
  const empty = document.querySelector('.rt-empty');
  if (empty) empty.remove();
}

function addUserMsg(text) {
  clearEmptyHint();
  const el = document.createElement('div');
  el.className = 'rt-msg user';
  el.innerHTML = `<div class="rt-msg-label">我</div><span class="rt-msg-text">${escapeHtml(text)}</span>`;
  document.getElementById('transcript').appendChild(el);
  scrollTranscript();
}

// 语音开始时先显示占位气泡（保证对话顺序 + 实时反馈）
function addUserPlaceholder(itemId) {
  clearEmptyHint();
  const el = document.createElement('div');
  el.className = 'rt-msg user streaming';
  el.innerHTML = '<div class="rt-msg-label">我</div><span class="rt-msg-text">🎤 正在聆听...</span>';
  document.getElementById('transcript').appendChild(el);
  userMsgEls[itemId] = el;
  scrollTranscript();
}

// 转录返回后回填占位气泡（转录与响应异步，可能迟到）
function updateUserMsg(itemId, text) {
  const el = itemId && userMsgEls[itemId];
  if (el) {
    el.classList.remove('streaming');
    el.querySelector('.rt-msg-text').textContent = text;
    delete userMsgEls[itemId];
  } else {
    addUserMsg(text);
  }
  scrollTranscript();
}

// 一轮响应结束后，把仍是"正在聆听"的占位气泡标记为（语音）
// 不删除映射：转录若迟到仍会回填真实文字
function sweepUserPlaceholders() {
  for (const id of Object.keys(userMsgEls)) {
    const el = userMsgEls[id];
    const span = el.querySelector('.rt-msg-text');
    if (span && span.textContent === '🎤 正在聆听...') {
      el.classList.remove('streaming');
      span.textContent = '（语音）';
    }
  }
}

function ensureAssistantMsg() {
  if (!currentAssistantMsg) {
    clearEmptyHint();
    const el = document.createElement('div');
    el.className = 'rt-msg assistant streaming';
    el.innerHTML = '<div class="rt-msg-label">AI</div><span class="rt-msg-text"></span>';
    document.getElementById('transcript').appendChild(el);
    currentAssistantMsg = el;
    scrollTranscript();
  }
}

function appendAssistantText(delta) {
  if (!delta) return;
  ensureAssistantMsg();
  const span = currentAssistantMsg.querySelector('.rt-msg-text');
  span.textContent += delta;
  scrollTranscript();
}

function finalizeAssistantMsg() {
  if (currentAssistantMsg) {
    currentAssistantMsg.classList.remove('streaming');
    // 没有任何文本内容的气泡（纯音频无转录）给个占位
    const span = currentAssistantMsg.querySelector('.rt-msg-text');
    if (span && !span.textContent.trim()) {
      span.textContent = '（语音回复）';
    }
    currentAssistantMsg = null;
  }
}

function addSystemMsg(text) {
  clearEmptyHint();
  const el = document.createElement('div');
  el.className = 'rt-msg system';
  el.textContent = text;
  document.getElementById('transcript').appendChild(el);
  scrollTranscript();
}

function scrollTranscript() {
  const t = document.getElementById('transcript');
  t.scrollTop = t.scrollHeight;
}

// ---------- 麦克风采集 ----------
const WORKLET_CODE = `
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = [];
    this.bufLen = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length > 0) {
      this.buf.push(input[0].slice(0));
      this.bufLen += input[0].length;
      // 约 21ms（512 采样 @24kHz）发一次
      while (this.bufLen >= 512) {
        const out = new Float32Array(512);
        let offset = 0;
        while (offset < 512) {
          const head = this.buf[0];
          const need = 512 - offset;
          if (head.length <= need) {
            out.set(head, offset);
            offset += head.length;
            this.buf.shift();
          } else {
            out.set(head.subarray(0, need), offset);
            this.buf[0] = head.subarray(need);
            offset += need;
          }
        }
        this.bufLen -= 512;
        this.port.postMessage(out);
      }
    }
    return true;
  }
}
registerProcessor('pcm-processor', PCMProcessor);
`;

async function startMic() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: SAMPLE_RATE,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
  } catch (err) {
    showToast('无法访问麦克风: ' + err.message, 'error');
    return false;
  }

  captureCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
  if (captureCtx.state === 'suspended') await captureCtx.resume();

  const source = captureCtx.createMediaStreamSource(micStream);
  const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
  const workletUrl = URL.createObjectURL(blob);
  await captureCtx.audioWorklet.addModule(workletUrl);
  URL.revokeObjectURL(workletUrl);

  captureNode = new AudioWorkletNode(captureCtx, 'pcm-processor');
  captureNode.port.onmessage = (e) => {
    if (!micOn || !sessionReady) return;
    const chunk = e.data;
    const b64 = float32ToPCM16Base64(chunk);
    sendEvent({ type: 'input_audio_buffer.append', audio: b64 });

    // 本地打断检测：AI 回复中检测到持续人声（约 100ms），不等服务端 speech_started
    if (responding) {
      let sum = 0;
      for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
      const rms = Math.sqrt(sum / chunk.length);
      if (rms > BARGE_IN_RMS) {
        loudFrames++;
        if (loudFrames >= BARGE_IN_FRAMES) {
          loudFrames = 0;
          logEvent('本地检测到人声，自动打断 AI 回复');
          interrupt();
          setState('listening', '正在聆听...');
        }
      } else {
        loudFrames = 0;
      }
    }
  };

  source.connect(captureNode);
  captureNode.connect(captureCtx.destination); // worklet 需要输出链路才会运行（无声音输出）

  micOn = true;
  updateMicBtn();
  setState('listening', document.getElementById('cfgVad').checked ? '聆听中（VAD 自动检测）' : '录音中（点击「说完发送」提交）');
  logEvent('麦克风已开启');
  return true;
}

function stopMic() {
  micOn = false;
  if (captureNode) { captureNode.disconnect(); captureNode = null; }
  if (captureCtx) { captureCtx.close().catch(() => {}); captureCtx = null; }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  updateMicBtn();
  if (connected) setState('connected', '已连接');
}

async function toggleMic() {
  if (!sessionReady) return;
  if (micOn) {
    stopMic();
    logEvent('麦克风已关闭');
  } else {
    await startMic();
  }
}

function updateMicBtn() {
  const btn = document.getElementById('micBtn');
  btn.className = 'btn rt-mic-btn' + (micOn ? ' active' : '');
  document.getElementById('micBtnText').textContent = micOn ? '关闭麦克风' : '开启麦克风';
  const commitBtn = document.getElementById('commitBtn');
  const vadOn = document.getElementById('cfgVad').checked;
  commitBtn.disabled = !(micOn && !vadOn);
}

// 手动模式：提交音频并请求响应
function manualCommit() {
  if (!sessionReady || !micOn) return;
  sendEvent({ type: 'input_audio_buffer.commit' });
  sendEvent({ type: 'response.create' });
  logEvent('→ input_audio_buffer.commit + response.create');
  setState('connected', '思考中...');
}

// ---------- 音频播放 ----------
function ensurePlaybackCtx() {
  if (!playbackCtx) {
    playbackCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
    nextPlayTime = 0;
  }
  if (playbackCtx.state === 'suspended') playbackCtx.resume();
}

function playPCMDelta(b64) {
  if (!b64) return;
  ensurePlaybackCtx();

  const bytes = bytesFromBase64(b64);
  const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

  const audioBuf = playbackCtx.createBuffer(1, float32.length, SAMPLE_RATE);
  audioBuf.getChannelData(0).set(float32);

  const source = playbackCtx.createBufferSource();
  source.buffer = audioBuf;
  source.connect(playbackCtx.destination);

  const now = playbackCtx.currentTime;
  if (nextPlayTime < now + 0.05) nextPlayTime = now + 0.05; // 50ms 缓冲防抖
  source.start(nextPlayTime);
  nextPlayTime += audioBuf.duration;
  activeSources.push(source);
  source.onended = () => {
    activeSources = activeSources.filter(s => s !== source);
  };
}

function stopPlayback() {
  for (const s of activeSources) {
    try { s.stop(); } catch (e) { /* 已停止 */ }
  }
  activeSources = [];
  nextPlayTime = 0;
}

// ---------- 响应收尾（幂等） ----------
function onResponseFinished(reason) {
  if (!responding) return; // 已收尾过（done/audio.done/cancelled 可能多次到达）
  responding = false;
  if (cancelWatchdog) { clearTimeout(cancelWatchdog); cancelWatchdog = null; }
  finalizeAssistantMsg();
  restoreInstructions();
  sweepUserPlaceholders();
  setState('connected', micOn ? '已连接（麦克风开启）' : '已连接');
}

// ---------- 打断 / 开场白 / 文本 ----------
function interrupt() {
  if (!sessionReady) return;
  sendEvent({ type: 'response.cancel' });
  stopPlayback();
  finalizeAssistantMsg();
  logEvent('→ response.cancel（打断）');
  setState('connected', '已连接');
  // 看门狗：1.5 秒内服务端未确认 cancelled，本地强制收尾，避免卡死在"AI 回复中"
  if (responding) {
    if (cancelWatchdog) clearTimeout(cancelWatchdog);
    cancelWatchdog = setTimeout(() => {
      if (responding) {
        logEvent('response.cancel 未获服务端确认，本地强制收尾', true);
        onResponseFinished('watchdog');
      }
    }, 1500);
  }
}

let greetingPending = false; // 开场白响应结束后需要恢复原始 instructions

function sendGreeting() {
  if (!sessionReady) return;
  greetingPending = true;
  sendEvent({
    type: 'response.create',
    session: { instructions: '请你原样无修改地输出下面的话：你好，我是阶跃星辰开发的AI助手，有什么可以帮你的吗？' }
  });
  logEvent('→ 发送开场白');
}

// 开场白的 response.create 会覆盖 session.instructions，
// 结束后立即恢复为用户配置的指令，避免影响后续对话
function restoreInstructions() {
  if (!greetingPending) return;
  greetingPending = false;
  const original = document.getElementById('cfgInstructions').value.trim();
  sendEvent({ type: 'session.update', session: { instructions: original || ' ' } });
  logEvent('→ session.update（恢复原始 instructions）');
}

function sendText() {
  if (!sessionReady) return;
  if (responding) {
    logEvent('⚠ AI 正在回复中，请等待');
    return;
  }
  const input = document.getElementById('textInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';

  sendEvent({
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }]
    }
  });
  sendEvent({ type: 'response.create' });
  addUserMsg(text);
  logEvent('→ 发送文本: ' + truncate(text, 50));
}

// ---------- 自定义函数工具（Tool Call） ----------
const funcCallArgBuf = {};       // call_id -> 累积的参数 JSON 片段
const funcCallQueue = [];        // 待处理的函数调用队列
let funcCallActive = null;       // 当前弹窗中的函数调用

const FUNC_TEMPLATE = {
  name: 'get_weather',
  description: '获取指定城市的天气信息',
  parameters: {
    type: 'object',
    properties: {
      location: { type: 'string', description: '城市名称，如：北京、上海' }
    },
    required: ['location']
  }
};

// 添加一个函数编辑卡片（首次添加时预置 get_weather 模板）
function addFunctionTool() {
  const list = document.getElementById('funcList');
  const idx = list.children.length;
  const tpl = idx === 0 ? FUNC_TEMPLATE : { name: '', description: '', parameters: { type: 'object', properties: {} } };

  const item = document.createElement('div');
  item.className = 'rt-func-item';
  item.innerHTML = `
    <div class="rt-func-head">
      <span class="rt-func-title">函数 #${idx + 1}</span>
      <button class="rt-func-del" title="删除" onclick="this.closest('.rt-func-item').remove()">×</button>
    </div>
    <input type="text" class="form-input form-input-sm rt-func-name" placeholder="函数名（英文，如 get_weather）" value="${escapeHtml(tpl.name)}">
    <input type="text" class="form-input form-input-sm rt-func-desc" placeholder="描述（模型据此判断何时调用）" value="${escapeHtml(tpl.description)}">
    <textarea class="form-input rt-func-params" rows="4" placeholder='参数 JSON Schema'>${escapeHtml(JSON.stringify(tpl.parameters, null, 2))}</textarea>
  `;
  list.appendChild(item);
}

// 收集并校验自定义函数配置
function collectFunctionTools() {
  const tools = [];
  const items = document.querySelectorAll('#funcList .rt-func-item');
  for (const item of items) {
    const name = item.querySelector('.rt-func-name').value.trim();
    const description = item.querySelector('.rt-func-desc').value.trim();
    const paramsText = item.querySelector('.rt-func-params').value.trim();
    if (!name && !description && !paramsText) continue; // 跳过完全空的卡片
    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new Error('函数名必填且只能包含英文、数字、_、-：' + (name || '(空)'));
    }
    if (!description) {
      throw new Error(`函数 ${name} 缺少描述`);
    }
    let parameters;
    try {
      parameters = paramsText ? JSON.parse(paramsText) : { type: 'object', properties: {} };
    } catch (e) {
      throw new Error(`函数 ${name} 的参数 JSON 格式错误: ${e.message}`);
    }
    tools.push({ name, description, parameters });
  }
  return tools;
}

// 函数调用入队（可能同轮多个调用，逐个弹窗处理）
function enqueueFunctionCall(call) {
  funcCallQueue.push(call);
  logEvent(`← 函数调用请求: ${call.name} call_id=${call.call_id}`);
  processFuncCallQueue();
}

function processFuncCallQueue() {
  if (funcCallActive || funcCallQueue.length === 0) return;
  funcCallActive = funcCallQueue.shift();
  document.getElementById('funcCallName').textContent = funcCallActive.name + '()';
  document.getElementById('funcCallArgs').textContent = funcCallActive.arguments;
  document.getElementById('funcCallOutput').value = '';
  document.getElementById('funcCallModal').style.display = 'flex';
}

function closeFuncCallModal() {
  document.getElementById('funcCallModal').style.display = 'none';
  funcCallActive = null;
  // 处理队列中的下一个
  setTimeout(processFuncCallQueue, 100);
}

// 提交函数结果 → function_call_output → 等语音播完 → response.create
function submitFunctionOutput() {
  if (!funcCallActive) return;
  const output = document.getElementById('funcCallOutput').value.trim();
  if (!output) {
    showToast('请填写函数返回结果', 'error');
    return;
  }
  const call = funcCallActive;
  closeFuncCallModal();
  sendFunctionOutput(call, output);
}

// 取消调用：也要回传一个 output，否则模型会一直等结果
function cancelFunctionCall() {
  if (!funcCallActive) return;
  const call = funcCallActive;
  closeFuncCallModal();
  sendFunctionOutput(call, '（该函数调用已被用户取消，请直接告知用户无法获取结果）');
}

function sendFunctionOutput(call, output) {
  addToolCallMsg(`↩ ${call.name} → ${truncate(output, 80)}`);
  sendEvent({
    type: 'conversation.item.create',
    item: { type: 'function_call_output', call_id: call.call_id, output }
  });
  logEvent(`→ function_call_output: ${call.name} = ${truncate(output, 60)}`);
  // 文档要求：函数调用可能与语音同轮出现，需等当前语音播完再触发最终响应
  triggerToolResponseWhenReady(0);
}

function playbackDrained() {
  return !playbackCtx || playbackCtx.currentTime >= nextPlayTime - 0.1;
}

function triggerToolResponseWhenReady(waited) {
  if (!sessionReady) return;
  if (playbackDrained() || waited > 10000) {
    sendEvent({ type: 'response.create' });
    logEvent('→ response.create（基于函数结果生成回答）');
  } else {
    setTimeout(() => triggerToolResponseWhenReady(waited + 300), 300);
  }
}

// 函数调用气泡（居中、等宽字体）
function addToolCallMsg(text) {
  clearEmptyHint();
  const el = document.createElement('div');
  el.className = 'rt-msg toolcall';
  el.textContent = text;
  document.getElementById('transcript').appendChild(el);
  scrollTranscript();
}

// ---------- web_search 开关 ----------
document.getElementById('cfgWebSearch').addEventListener('change', function () {
  document.getElementById('webSearchParams').style.display = this.checked ? '' : 'none';
  checkWebSearchModel();
  pushSessionUpdate();
});

// 实测 stepaudio-2.5-realtime 不触发 web_search（凭记忆作答），给出警示
function checkWebSearchModel() {
  const warn = document.getElementById('wsModelWarning');
  const wsOn = document.getElementById('cfgWebSearch').checked;
  const model = document.getElementById('cfgModel').value;
  warn.style.display = (wsOn && model === 'stepaudio-2.5-realtime') ? '' : 'none';
}
document.getElementById('cfgModel').addEventListener('change', checkWebSearchModel);

// ---------- 配置热更新（连接状态下修改配置即时生效） ----------
// voice 在产生音频后不可修改，热更新时剔除 voice 字段
function pushSessionUpdate() {
  if (!sessionReady) return;
  let cfg;
  try {
    cfg = buildSessionConfig();
  } catch (e) {
    showToast(e.message, 'error');
    return;
  }
  delete cfg.voice;
  sendEvent({ type: 'session.update', session: cfg });
  logEvent('→ session.update（配置热更新）');
}

// 知识库 / 指令 / VAD 配置变化时即时下发
document.getElementById('cfgKbEnable').addEventListener('change', pushSessionUpdate);
document.getElementById('cfgKbSelect').addEventListener('change', pushSessionUpdate);
document.getElementById('cfgKbDesc').addEventListener('change', pushSessionUpdate);
document.getElementById('cfgInstructions').addEventListener('change', pushSessionUpdate);
document.getElementById('cfgVad').addEventListener('change', pushSessionUpdate);
document.getElementById('cfgSilence').addEventListener('change', pushSessionUpdate);
document.getElementById('cfgEnergy').addEventListener('change', pushSessionUpdate);
// 函数卡片的输入变化（事件委托）
document.getElementById('funcList').addEventListener('change', pushSessionUpdate);

// ---------- 事件日志开关 ----------
function toggleEventLog() {
  const show = document.getElementById('cfgShowLog').checked;
  document.getElementById('eventLog').style.display = show ? 'block' : 'none';
}

// ---------- VAD 参数区显示 ----------
document.getElementById('cfgVad').addEventListener('change', function () {
  document.getElementById('vadParams').style.display = this.checked ? '' : 'none';
  updateMicBtn();
});

// ---------- 知识库开关 ----------
document.getElementById('cfgKbEnable').addEventListener('change', function () {
  document.getElementById('kbConfig').style.display = this.checked ? '' : 'none';
});

// ---------- 加载知识库列表 ----------
async function loadKBList() {
  const select = document.getElementById('cfgKbSelect');
  try {
    const res = await fetch('/api/vector-stores?limit=100');
    const data = await res.json();
    const list = data.data || [];
    select.innerHTML = '<option value="">-- 选择知识库 --</option>';
    for (const kb of list) {
      const opt = document.createElement('option');
      opt.value = kb.id;
      opt.textContent = `${kb.name}（${kb.file_counts ? kb.file_counts.total : 0} 个文件）`;
      select.appendChild(opt);
    }
    if (list.length === 0) {
      select.innerHTML = '<option value="">（暂无知识库，请先到知识库管理创建）</option>';
    }
  } catch (err) {
    select.innerHTML = '<option value="">加载失败: ' + escapeHtml(err.message) + '</option>';
  }
}

// ---------- 自动执行内置函数 ----------
// 某些函数无需用户输入，由前端自动计算并返回结果
const AUTO_FUNCTIONS = {
  get_current_date: function() {
    var now = new Date();
    var options = { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' };
    return '今天是' + now.toLocaleDateString('zh-CN', options) +
      ' ' + now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) +
      '，星期' + ['日','一','二','三','四','五','六'][now.getDay()];
  }
};

// 拦截 enqueueFunctionCall：自动执行的函数直接返回结果，不走弹窗
var _origEnqueue = enqueueFunctionCall;
enqueueFunctionCall = function(call) {
  if (AUTO_FUNCTIONS[call.name]) {
    try {
      var result = AUTO_FUNCTIONS[call.name]();
      logEvent('↩ ' + call.name + ' 自动执行 → ' + result);
      addToolCallMsg('↩ ' + call.name + ' → ' + result);
      sendFunctionOutput(call, result);
    } catch(e) {
      logEvent('↩ ' + call.name + ' 执行失败: ' + e.message, true);
      sendFunctionOutput(call, '执行出错: ' + e.message);
    }
    return;
  }
  _origEnqueue(call);
};

// ---------- 页面卸载清理 ----------
window.addEventListener('beforeunload', () => {
  if (ws) ws.close();
  stopMic();
});

// 初始化
loadKBList();
setState('', '未连接');
