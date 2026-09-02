/* ===== StepFun 聊天对话 ===== */

/* ================== 状态 ================== */
let sending = false;
let abortController = null;
let messages = []; // [{role, content}, ...]，不含 system
let modelList = [];
const LS_PROMPTS = 'stepfun_chat_prompts_v1';      // { model -> systemPrompt }
const LS_DEFAULTS = 'stepfun_chat_defaults_v1';    // { model, customModel, temperature, maxTokens, stream, system }
const LS_HISTORY = 'stepfun_chat_history_v1';      // messages[]

const TEMPLATES = {
  assist: '你是一个友善、专业的 AI 助手，回答使用中文。回答时尽量结构化、给出关键要点；如果不确定请明确告知。',
  coder: '你是一位资深软件工程师，擅长多语言开发、调试和架构设计。回答时给出完整可运行的代码示例，关键处加注释；遇到不确定的 API 请明确指出。',
  writer: '你是一位中文写作高手，擅长润色、改写、扩写、缩写和不同风格的写作。请用清晰、生动、自然的中文输出。',
  translator: '你是一位专业的中英/英中翻译。能保留原文的语气和专业术语，遇到文化差异请加简短注释。',
  empty: '',
};

/* ================== 工具函数 ================== */
function $(id) { return document.getElementById(id); }

function showToast(msg, type) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast ' + (type === 'error' ? 'error' : 'success');
  t.style.display = 'block';
  setTimeout(() => { t.style.display = 'none'; t.className = 'toast'; }, 3000);
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
}

function getCurrentModel() {
  const sel = $('cfgModel').value;
  if (sel === '__custom__') {
    const v = $('cfgModelCustom').value.trim();
    return v || 'step-3.7-flash';
  }
  return sel;
}

function setStatus(text, cls) {
  const el = $('apiStatus');
  el.textContent = text;
  el.className = 'api-badge ' + (cls || 'checking');
}

/* ================== localStorage ================== */
function loadPrompts() {
  try { return JSON.parse(localStorage.getItem(LS_PROMPTS) || '{}') || {}; }
  catch { return {}; }
}
function savePrompts(obj) {
  localStorage.setItem(LS_PROMPTS, JSON.stringify(obj || {}));
}
function loadDefaults() {
  try { return JSON.parse(localStorage.getItem(LS_DEFAULTS) || '{}') || {}; }
  catch { return {}; }
}
function saveDefaults(obj) {
  localStorage.setItem(LS_DEFAULTS, JSON.stringify(obj || {}));
}
function loadHistory() {
  try { return JSON.parse(localStorage.getItem(LS_HISTORY) || '[]') || []; }
  catch { return []; }
}
function saveHistory(arr) {
  localStorage.setItem(LS_HISTORY, JSON.stringify(arr || []));
}

/* ================== UI 渲染 ================== */
function updateTurnCount() {
  $('turnCount').textContent = `当前对话 ${Math.floor(messages.filter(m => m.role === 'user').length)} 轮`;
  $('nowModel').textContent = `当前模型：${getCurrentModel()}`;
}

function updateSystemBadge() {
  const model = getCurrentModel();
  const prompts = loadPrompts();
  const saved = prompts[model] || '';
  const cur = $('cfgSystem').value;
  const badge = $('cfgSystemBadge');
  if (!saved && !cur) {
    badge.textContent = '未保存';
    badge.classList.remove('saved');
  } else if (saved === cur) {
    badge.textContent = `已保存（${saved.length} 字）`;
    badge.classList.add('saved');
  } else {
    badge.textContent = '有未保存的修改';
    badge.classList.remove('saved');
  }
}

function refreshPresetSelect() {
  const prompts = loadPrompts();
  const model = getCurrentModel();
  const sel = $('cfgPresetSelect');
  const names = Object.keys(prompts).sort();
  if (names.length === 0) {
    sel.innerHTML = '<option value="">（暂无预设）</option>';
    return;
  }
  sel.innerHTML = '<option value="">（选择预设）</option>' +
    names.map(n => `<option value="${escapeHtml(n)}" ${n === model ? 'selected' : ''}>${escapeHtml(n)} — ${prompts[n].length} 字</option>`).join('');
}

function appendTranscript(role, htmlOrText) {
  let empty = document.querySelector('.rt-empty');
  if (empty) empty.remove();
  const el = document.createElement('div');
  el.className = 'rt-msg ' + role;
  const label = role === 'user' ? '我' : role === 'assistant' ? 'AI' : role;
  el.innerHTML = `<div class="rt-msg-label">${escapeHtml(label)}</div><div class="md-content rt-msg-text">${htmlOrText}</div>`;
  $('transcript').appendChild(el);
  scrollTranscript();
  return el;
}

function scrollTranscript() {
  const t = $('transcript');
  t.scrollTop = t.scrollHeight;
}

function rerenderTranscript() {
  const t = $('transcript');
  t.innerHTML = '';
  if (messages.length === 0) {
    t.innerHTML = `
      <div class="rt-empty">
        <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.3;margin-bottom:12px;">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        <p>和 Step Plan 模型对话</p>
        <p class="rt-empty-hint">左侧切换模型 / 编辑提示词，右侧输入消息开始对话</p>
      </div>`;
    return;
  }
  for (const m of messages) {
    if (m.role === 'user' || m.role === 'assistant') {
      const html = m.role === 'user'
        ? escapeHtml(m.content).replace(/\n/g, '<br>')
        : renderMarkdown(m.content);
      appendTranscript(m.role, html);
    }
  }
}

function renderMarkdown(text) {
  let html = escapeHtml(text || '');
  // 代码块（保留 language 标签）
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (m, lang, code) =>
    `<pre><code data-lang="${escapeHtml(lang)}">${code.replace(/^\n+|\n+$/g, '')}</code></pre>`);
  // 行内代码
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  // 标题
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // 粗体 / 斜体
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  // 链接
  html = html.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // 无序列表
  html = html.replace(/(^|\n)([-*] .+(?:\n[-*] .+)*)/g, (m, pre, block) => {
    return pre + '<ul>' + block.split('\n').map(l => `<li>${l.replace(/^[-*] /, '')}</li>`).join('') + '</ul>';
  });
  // 有序列表
  html = html.replace(/(^|\n)(\d+\. .+(?:\n\d+\. .+)*)/g, (m, pre, block) => {
    return pre + '<ol>' + block.split('\n').map(l => `<li>${l.replace(/^\d+\. /, '')}</li>`).join('') + '</ol>';
  });
  // 段落（双换行分段）；单换行转 <br>
  html = html.split(/\n{2,}/).map(p => {
    if (/^<(h\d|ul|ol|pre|blockquote)/.test(p.trim())) return p;
    return '<p>' + p.replace(/\n/g, '<br>') + '</p>';
  }).join('\n');
  return html;
}

/* ================== 模型下拉 ================== */
async function loadModelList() {
  try {
    const r = await fetch('/api/plan-chat/models');
    const j = await r.json();
    modelList = Array.isArray(j.models) ? j.models : [];
  } catch (e) {
    modelList = [
      { id: 'step-3.7-flash', name: 'step-3.7-flash', desc: '官方推荐验证模型' },
    ];
  }
  renderModelSelect();
}

function renderModelSelect() {
  const sel = $('cfgModel');
  const defs = loadDefaults();
  const savedModel = defs.model || 'step-3.7-flash';
  sel.innerHTML = modelList.map(m =>
    `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}（${escapeHtml(m.desc || '')}）</option>`
  ).join('') + '<option value="__custom__">自定义模型…</option>';

  const knownIds = modelList.map(m => m.id);
  if (knownIds.includes(savedModel)) {
    sel.value = savedModel;
    $('cfgModelCustom').value = '';
  } else if (savedModel) {
    sel.value = '__custom__';
    $('cfgModelCustom').value = savedModel;
  }
  updateModelHint();
}

function updateModelHint() {
  const id = getCurrentModel();
  const m = modelList.find(x => x.id === id);
  $('modelHint').textContent = m ? `介绍：${m.desc || m.name}` : `当前使用模型：${id}`;
}

/* ================== 模型切换 ================== */
function onModelChange() {
  const sel = $('cfgModel').value;
  const custom = $('cfgModelCustom');
  if (sel === '__custom__') {
    custom.disabled = false;
    custom.focus();
  } else {
    custom.disabled = true;
    custom.value = '';
  }
  applySystemPromptForCurrentModel();
  refreshPresetSelect();
  saveDefaultsLazy();
  updateTurnCount();
  updateModelHint();
  updateSystemBadge();
}

function onCustomModelInput() {
  if ($('cfgModel').value !== '__custom__') $('cfgModel').value = '__custom__';
  const v = $('cfgModelCustom').value.trim();
  if (!v) return;
  saveDefaultsLazy();
  applySystemPromptForCurrentModel(/*forceSet*/ false); // 有则加载，无则不动
  refreshPresetSelect();
  updateTurnCount();
  updateSystemBadge();
}

function applySystemPromptForCurrentModel(forceSet = true) {
  const model = getCurrentModel();
  const prompts = loadPrompts();
  const saved = prompts[model] || '';
  if (forceSet || !$('cfgSystem').value) {
    $('cfgSystem').value = saved;
    updateSystemBadge();
  }
}

/* ================== 流式发送 ================== */
async function send() {
  if (sending) return;
  const input = $('textInput');
  const text = input.value.trim();
  if (!text) { showToast('请输入消息', 'error'); return; }

  const model = getCurrentModel();
  if (!model) { showToast('请选择或输入模型', 'error'); return; }

  abortController = new AbortController();

  sending = true;
  setSendingUI(true);

  const userMsg = { role: 'user', content: text };
  messages.push(userMsg);
  appendTranscript('user', escapeHtml(text).replace(/\n/g, '<br>'));
  input.value = '';
  autoResize(input);
  saveHistory(messages);
  updateTurnCount();

  const temperature = parseFloat($('cfgTemperature').value) || 0.7;
  const maxTokensRaw = $('cfgMaxTokens').value;
  const maxTokens = maxTokensRaw ? parseInt(maxTokensRaw, 10) : undefined;
  const stream = $('cfgStream').checked;
  const systemPrompt = $('cfgSystem').value.trim();

  const assistantEl = appendTranscript('assistant', '');
  assistantEl.classList.add('streaming');
  const textEl = assistantEl.querySelector('.md-content');
  let fullText = '';

  try {
    const body = {
      model,
      messages: systemPrompt ? [{ role: 'system', content: systemPrompt }, ...messages] : [...messages],
      temperature,
      stream,
    };
    if (Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens;

    const r = await fetch('/api/plan-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: abortController.signal,
    });

    if (!r.ok) {
      let err = 'HTTP ' + r.status;
      try { const j = await r.json(); err = j.error?.message || j.error || err; } catch {}
      throw new Error(err);
    }

    if (!stream) {
      const j = await r.json();
      fullText = j.choices?.[0]?.message?.content || '';
      textEl.innerHTML = renderMarkdown(fullText);
    } else {
      // 流式 SSE
      const reader = r.body.getReader();
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
            const j = JSON.parse(data);
            const delta = j.choices?.[0]?.delta;
            if (delta && delta.content) {
              fullText += delta.content;
              textEl.innerHTML = renderMarkdown(fullText);
              scrollTranscript();
            }
          } catch {}
        }
      }
    }

    if (!fullText) textEl.textContent = '（无响应内容）';
    // 成功后才推 history
    messages.push({ role: 'assistant', content: fullText });
    saveHistory(messages);
  } catch (err) {
    if (err.name === 'AbortError') {
      textEl.innerHTML = (fullText ? renderMarkdown(fullText) + '<br><em style="color:var(--warning,#d97706)">（已手动停止）</em>' : '<em style="color:var(--warning,#d97706)">已停止</em>');
      if (fullText) messages.push({ role: 'assistant', content: fullText });
    } else {
      textEl.innerHTML = `<em style="color:var(--danger,#dc2626)">请求失败：${escapeHtml(err.message)}</em>`;
      // 出错时把这轮 user 撤掉，避免历史污染
      messages.pop();
    }
    saveHistory(messages);
    showToast(err.name === 'AbortError' ? '已停止' : ('请求失败：' + err.message), err.name === 'AbortError' ? 'success' : 'error');
  } finally {
    assistantEl.classList.remove('streaming');
    sending = false;
    setSendingUI(false);
    abortController = null;
    updateTurnCount();
  }
}

function stop() {
  if (abortController) abortController.abort();
}

function setSendingUI(b) {
  $('sendBtn').disabled = b;
  $('sendBtnText').textContent = b ? '生成中…' : '发送';
  $('stopBtn').disabled = !b;
  $('textInput').disabled = b;
}

/* ================== 事件绑定 ================== */
function onInputKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
}

function saveCurrentSystemPrompt() {
  const model = getCurrentModel();
  const text = $('cfgSystem').value;
  if (!text || !text.trim()) { showToast('当前提示词为空，无法保存', 'error'); return; }
  const prompts = loadPrompts();
  prompts[model] = text;
  savePrompts(prompts);
  showToast(`已为 ${model} 保存提示词（${text.length} 字）`, 'success');
  refreshPresetSelect();
  updateSystemBadge();
}

function resetSystemPrompt() {
  if (!$('cfgSystem').value) return;
  if (!confirm('确定要清空当前系统提示词？\n（不会删除已保存的预设）')) return;
  $('cfgSystem').value = '';
  updateSystemBadge();
}

function deleteSelectedPreset() {
  const key = $('cfgPresetSelect').value;
  if (!key) { showToast('请先选择要删除的预设', 'error'); return; }
  if (!confirm(`确定要删除模型 "${key}" 的提示词预设？`)) return;
  const prompts = loadPrompts();
  delete prompts[key];
  savePrompts(prompts);
  showToast(`已删除 ${key} 的预设`, 'success');
  refreshPresetSelect();
}

function applySelectedPreset() {
  const key = $('cfgPresetSelect').value;
  if (!key) { showToast('请先选择预设', 'error'); return; }
  const prompts = loadPrompts();
  const text = prompts[key];
  if (text === undefined) { showToast('预设不存在', 'error'); return; }
  $('cfgSystem').value = text;
  // 自动切到对应模型（若不是当前）
  const known = modelList.some(m => m.id === key);
  if (known) {
    $('cfgModel').value = key;
    $('cfgModelCustom').value = '';
    $('cfgModelCustom').disabled = true;
    onModelChange();
  } else {
    $('cfgModel').value = '__custom__';
    $('cfgModelCustom').value = key;
    $('cfgModelCustom').disabled = false;
    onModelChange();
    $('cfgSystem').value = text; // onModelChange 会重置，再写一次
  }
  showToast(`已应用 ${key} 的预设`, 'success');
}

function fillTemplate(name) {
  const text = TEMPLATES[name];
  if (text === undefined) return;
  $('cfgSystem').value = text;
  updateSystemBadge();
  showToast(`已填入模板：${name}${text ? '' : '（清空）'}`, 'success');
}

function clearConversation() {
  if (messages.length === 0) return;
  if (!confirm('确定清空当前对话？')) return;
  messages = [];
  saveHistory(messages);
  rerenderTranscript();
  updateTurnCount();
  showToast('已清空对话', 'success');
}

function exportMarkdown() {
  if (messages.length === 0) { showToast('当前没有对话可导出', 'error'); return; }
  const lines = [
    `# StepFun 聊天对话导出`,
    ``,
    `模型：${getCurrentModel()}`,
    `时间：${new Date().toISOString()}`,
    `轮数：${messages.filter(m => m.role === 'user').length}`,
    ``,
    `---`,
    ``,
  ];
  for (const m of messages) {
    if (m.role === 'user') {
      lines.push(`## 👤 User`);
      lines.push(m.content);
      lines.push('');
    } else if (m.role === 'assistant') {
      lines.push(`## 🤖 Assistant`);
      lines.push(m.content);
      lines.push('');
    }
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.href = url;
  a.download = `chat-${getCurrentModel()}-${ts}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('已下载对话 Markdown', 'success');
}

/* ================== 默认值持久化 ================== */
function saveDefaultsLazy() {
  const d = {
    model: getCurrentModel(),
    temperature: parseFloat($('cfgTemperature').value) || 0.7,
    maxTokens: $('cfgMaxTokens').value,
    stream: $('cfgStream').checked,
  };
  saveDefaults(d);
}

function applyDefaultsOnLoad() {
  const d = loadDefaults();
  if (Number.isFinite(d.temperature)) $('cfgTemperature').value = d.temperature;
  if (d.maxTokens) $('cfgMaxTokens').value = d.maxTokens;
  if (typeof d.stream === 'boolean') $('cfgStream').checked = d.stream;
  // 渲染 model select（renderModelSelect 已经使用 saved model 设置 selected）
}

/* ================== 启动 ================== */
async function init() {
  await loadModelList();
  applyDefaultsOnLoad();
  renderModelSelect();
  applySystemPromptForCurrentModel();
  refreshPresetSelect();
  updateTurnCount();
  updateSystemBadge();

  messages = loadHistory();
  rerenderTranscript();
  updateTurnCount();

  // 事件
  $('cfgModel').addEventListener('change', onModelChange);
  $('cfgModelCustom').addEventListener('input', onCustomModelInput);
  $('cfgSystem').addEventListener('input', updateSystemBadge);
  $('cfgSystemSave').addEventListener('click', saveCurrentSystemPrompt);
  $('cfgSystemReset').addEventListener('click', resetSystemPrompt);
  $('cfgPresetApply').addEventListener('click', applySelectedPreset);
  $('cfgPresetDel').addEventListener('click', deleteSelectedPreset);
  $('cfgTemperature').addEventListener('change', saveDefaultsLazy);
  $('cfgMaxTokens').addEventListener('change', saveDefaultsLazy);
  $('cfgStream').addEventListener('change', saveDefaultsLazy);
  $('clearBtn').addEventListener('click', clearConversation);
  $('exportBtn').addEventListener('click', exportMarkdown);
  $('sendBtn').addEventListener('click', send);
  $('stopBtn').addEventListener('click', stop);

  $('textInput').addEventListener('input', function () { autoResize(this); });

  document.querySelectorAll('[data-tpl]').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      fillTemplate(a.dataset.tpl);
    });
  });

  // 输入框自动 resize
  autoResize($('textInput'));

  // 连接状态显示
  setStatus('Step Plan 就绪', 'connected');
}

document.addEventListener('DOMContentLoaded', init);
