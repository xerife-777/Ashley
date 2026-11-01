/**
 * NexusAI — app.js
 * Lógica principal: conexão de API, chat, histórico, TTS, voz, modo pensador
 */

'use strict';

// ============================================================
//  ESTADO GLOBAL
// ============================================================

const State = {
  apiKey: '',
  apiUrl: '',
  provider: 'groq',
  model: '',
  assistantName: 'NexusAI',
  temperature: 0.7,
  maxTokens: 2048,
  currentChatId: null,
  conversations: {},   // { chatId: { title, messages: [], createdAt, updatedAt } }
  thinkMode: false,
  isSpeaking: false,
  speechSynth: window.speechSynthesis || null,
  isListening: false,
  recognition: null,
};

// ============================================================
//  ARMAZENAMENTO LOCAL
// ============================================================

const Storage = {
  KEYS: {
    CONVERSATIONS: 'nexusai_conversations',
    SETTINGS: 'nexusai_settings',
    CREDENTIALS: 'nexusai_credentials',
    RULES: 'nexusai_rules',
  },

  save(key, data) {
    try {
      localStorage.setItem(key, JSON.stringify(data));
    } catch (e) {
      console.warn('Storage.save error:', e);
    }
  },

  load(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      console.warn('Storage.load error:', e);
      return fallback;
    }
  },

  remove(key) {
    try { localStorage.removeItem(key); } catch (e) { /**/ }
  },

  saveAll() {
    this.save(this.KEYS.CONVERSATIONS, State.conversations);
    this.save(this.KEYS.SETTINGS, {
      assistantName: State.assistantName,
      temperature: State.temperature,
      maxTokens: State.maxTokens,
      theme: document.body.classList.contains('light-theme') ? 'light' : 'dark',
    });
    this.save(this.KEYS.CREDENTIALS, {
      apiKey: State.apiKey,
      apiUrl: State.apiUrl,
      provider: State.provider,
      model: State.model,
    });
    this.save(this.KEYS.RULES, getRulesText());
  },

  loadAll() {
    // Credenciais
    const creds = this.load(this.KEYS.CREDENTIALS);
    if (creds) {
      State.apiKey = creds.apiKey || '';
      State.apiUrl = creds.apiUrl || '';
      State.provider = creds.provider || 'groq';
      State.model = creds.model || '';
    }

    // Configurações
    const settings = this.load(this.KEYS.SETTINGS);
    if (settings) {
      State.assistantName = settings.assistantName || 'NexusAI';
      State.temperature = settings.temperature ?? 0.7;
      State.maxTokens = settings.maxTokens || 2048;
      if (settings.theme === 'light') document.body.classList.add('light-theme');
    }

    // Conversas
    State.conversations = this.load(this.KEYS.CONVERSATIONS, {});

    // Regras
    const savedRules = this.load(this.KEYS.RULES);
    if (savedRules) {
      const ta = document.getElementById('system-rules');
      if (ta) ta.value = savedRules;
    }
  },
};

// ============================================================
//  REGRAS DO SISTEMA
// ============================================================

function getRulesText() {
  const el = document.getElementById('system-rules');
  return el ? el.value.trim() : '';
}

function buildSystemPrompt() {
  const rules = getRulesText();
  const name = State.assistantName || 'NexusAI';
  const thinkExtra = State.thinkMode
    ? '\n\nMODO PENSADOR ATIVADO: Antes de responder, analise a pergunta em múltiplos ângulos. Explore diferentes perspectivas, considere possíveis erros e incertezas, pesquise mentalmente tudo que sabe sobre o tópico e só então formule sua resposta completa e fundamentada. Se a pergunta envolver fatos recentes, indique que pode não ter as informações mais atuais.'
    : '';

  return `Você é ${name}, um assistente de inteligência artificial avançado, útil, empático e preciso.

Você SEMPRE se lembra de TODAS as mensagens enviadas nesta conversa atual. Use esse contexto para dar respostas coerentes, relevantes e personalizadas. Nunca finja ter esquecido algo que foi dito anteriormente nesta sessão.

REGRAS OBRIGATÓRIAS:
${rules}

IDIOMA: Responda SEMPRE no mesmo idioma que o usuário usar.
FORMATAÇÃO: Use markdown quando útil (listas, código, negrito). Seja claro e objetivo, mas completo quando necessário.${thinkExtra}`;
}

// ============================================================
//  GERAÇÃO DE IDs
// ============================================================

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ============================================================
//  CHAT — GERENCIAMENTO
// ============================================================

function createNewChat() {
  const id = generateId();
  State.conversations[id] = {
    title: 'Nova conversa',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  State.currentChatId = id;
  return id;
}

function getCurrentChat() {
  if (!State.currentChatId || !State.conversations[State.currentChatId]) {
    createNewChat();
  }
  return State.conversations[State.currentChatId];
}

function switchChat(chatId) {
  if (!State.conversations[chatId]) return;
  State.currentChatId = chatId;
  renderMessages();
  updateChatTitle();
  renderHistoryList();
}

function deleteChat(chatId) {
  delete State.conversations[chatId];
  if (State.currentChatId === chatId) {
    const ids = Object.keys(State.conversations);
    if (ids.length > 0) {
      switchChat(ids[ids.length - 1]);
    } else {
      createNewChat();
      renderMessages();
    }
  }
  Storage.saveAll();
  renderHistoryList();
}

function clearAllChats() {
  if (!confirm('Tem certeza que deseja apagar TODAS as conversas? Esta ação não pode ser desfeita.')) return;
  State.conversations = {};
  createNewChat();
  renderMessages();
  renderHistoryList();
  Storage.saveAll();
  showToast('Todas as conversas foram apagadas.', 'success');
}

// ============================================================
//  API — CHAMADA PRINCIPAL
// ============================================================

async function callAPI(messagesPayload) {
  const headers = {
    'Content-Type': 'application/json',
  };

  // Diferentes provedores podem ter headers distintos
  if (State.provider === 'anthropic') {
    headers['x-api-key'] = State.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers['Authorization'] = `Bearer ${State.apiKey}`;
  }

  const body = {
    model: State.model,
    messages: messagesPayload,
    temperature: State.temperature,
    max_tokens: State.maxTokens,
    stream: false,
  };

  const endpoint = State.apiUrl.replace(/\/$/, '') + '/chat/completions';

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let errMsg = `Erro ${response.status}`;
    try {
      const errData = await response.json();
      errMsg = errData.error?.message || errData.message || errMsg;
    } catch (_) { /* */ }
    throw new Error(errMsg);
  }

  const data = await response.json();

  // Suporte a formato OpenAI padrão
  const content =
    data.choices?.[0]?.message?.content ||
    data.content?.[0]?.text ||
    data.text ||
    '';

  return content.trim();
}

// ============================================================
//  ENVIO DE MENSAGEM
// ============================================================

async function sendMessage(userText) {
  userText = userText.trim();
  if (!userText) return;

  const chat = getCurrentChat();

  // Adicionar mensagem do usuário
  chat.messages.push({ role: 'user', content: userText, ts: Date.now() });
  chat.updatedAt = Date.now();

  // Título automático (primeira mensagem)
  if (chat.messages.length === 1) {
    chat.title = userText.slice(0, 45) + (userText.length > 45 ? '…' : '');
    updateChatTitle();
    renderHistoryList();
  }

  renderMessages();
  scrollToBottom();

  // Mostrar indicador
  setThinkingState(true);
  setSendEnabled(false);

  try {
    // Construir payload mantendo histórico completo (contexto forçado)
    const systemMsg = { role: 'system', content: buildSystemPrompt() };
    const historyMsgs = chat.messages.map(m => ({ role: m.role, content: m.content }));

    let replyText = '';

    if (State.thinkMode) {
      // Modo pensador: dois passos
      setThinkLabel('Analisando e pesquisando…');
      const thinkPayload = [
        systemMsg,
        ...historyMsgs.slice(0, -1),
        {
          role: 'user',
          content: `[MODO PENSADOR] Pense passo a passo e analise profundamente antes de responder: ${userText}\n\nPrimeiro, compartilhe seu raciocínio interno (entre tags <thinking>), depois forneça sua resposta final clara.`
        }
      ];

      const thinkRaw = await callAPI(thinkPayload);
      const thinkMatch = thinkRaw.match(/<thinking>([\s\S]*?)<\/thinking>/i);
      const thinkContent = thinkMatch ? thinkMatch[1].trim() : '';
      replyText = thinkRaw.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();

      if (thinkContent) {
        chat.messages.push({
          role: 'thinking',
          content: thinkContent,
          ts: Date.now(),
        });
      }
    } else {
      replyText = await callAPI([systemMsg, ...historyMsgs]);
    }

    // Adicionar resposta
    chat.messages.push({ role: 'assistant', content: replyText, ts: Date.now() });
    chat.updatedAt = Date.now();

  } catch (err) {
    chat.messages.push({
      role: 'assistant',
      content: `❌ **Erro ao conectar com a IA:**\n\n${err.message}\n\nVerifique sua chave de API e o provedor selecionado.`,
      ts: Date.now(),
      isError: true,
    });
  }

  setThinkingState(false);
  setSendEnabled(true);
  renderMessages();
  scrollToBottom();
  Storage.saveAll();
}

// ============================================================
//  RENDER
// ============================================================

function renderMessages() {
  const area = document.getElementById('messages-area');
  const chat = getCurrentChat();

  // Limpar
  area.innerHTML = '';

  if (chat.messages.length === 0) {
    area.appendChild(buildWelcomeState());
    return;
  }

  chat.messages.forEach((msg, idx) => {
    if (msg.role === 'thinking') {
      area.appendChild(buildThinkingBubble(msg.content));
      return;
    }
    area.appendChild(buildMessageEl(msg, idx));
  });
}

function buildWelcomeState() {
  const div = document.createElement('div');
  div.className = 'welcome-state';
  div.id = 'welcome-state';
  div.innerHTML = `
    <div class="welcome-icon">🧠</div>
    <h2>Olá! Como posso ajudar?</h2>
    <p>Comece uma conversa. Eu me lembrarei de tudo que você disser aqui.</p>
    <div class="suggestion-chips">
      <button class="chip" onclick="fillInput('Me explique o que é inteligência artificial')">O que é IA?</button>
      <button class="chip" onclick="fillInput('Me ajude a criar um plano de estudos para programação')">Plano de estudos</button>
      <button class="chip" onclick="fillInput('Escreva um poema criativo sobre o futuro')">Poema criativo</button>
      <button class="chip" onclick="fillInput('Quais são as últimas tendências em tecnologia?')">Tendências tech</button>
    </div>
  `;
  return div;
}

function buildThinkingBubble(content) {
  const div = document.createElement('div');
  div.className = 'thinking-bubble';
  div.innerHTML = `<div class="thinking-bubble-label">💭 Raciocínio interno</div>${escapeHtml(content).replace(/\n/g, '<br>')}`;
  return div;
}

function buildMessageEl(msg, idx) {
  const group = document.createElement('div');
  group.className = 'message-group';

  const msgDiv = document.createElement('div');
  msgDiv.className = `message ${msg.role}`;

  const avatarInitial = msg.role === 'user' ? 'Eu' : State.assistantName.charAt(0).toUpperCase();
  const avatarEl = document.createElement('div');
  avatarEl.className = 'msg-avatar';
  avatarEl.textContent = avatarInitial;

  const bubbleEl = document.createElement('div');
  bubbleEl.className = 'msg-bubble';
  bubbleEl.innerHTML = renderMarkdown(msg.content);

  msgDiv.appendChild(avatarEl);
  msgDiv.appendChild(bubbleEl);

  // Meta (hora + ações)
  const metaDiv = document.createElement('div');
  metaDiv.className = 'msg-meta';

  const timeSpan = document.createElement('span');
  timeSpan.className = 'msg-time';
  timeSpan.textContent = formatTime(msg.ts);

  const actionsDiv = document.createElement('div');
  actionsDiv.className = 'msg-actions';

  // Botão copiar
  const copyBtn = document.createElement('button');
  copyBtn.className = 'msg-action-btn';
  copyBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copiar`;
  copyBtn.onclick = () => {
    copyToClipboard(msg.content);
    showToast('Copiado!', 'success');
  };

  actionsDiv.appendChild(copyBtn);

  // Botão TTS (só para assistente)
  if (msg.role === 'assistant') {
    const ttsBtn = document.createElement('button');
    ttsBtn.className = 'msg-action-btn';
    ttsBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg> Ouvir`;
    ttsBtn.onclick = () => speakText(msg.content);
    actionsDiv.appendChild(ttsBtn);
  }

  metaDiv.appendChild(timeSpan);
  metaDiv.appendChild(actionsDiv);

  group.appendChild(msgDiv);
  group.appendChild(metaDiv);

  return group;
}

function renderHistoryList() {
  const list = document.getElementById('history-list');
  const ids = Object.keys(State.conversations).sort((a, b) =>
    (State.conversations[b].updatedAt || 0) - (State.conversations[a].updatedAt || 0)
  );

  if (ids.length === 0) {
    list.innerHTML = '<div class="history-empty">Nenhuma conversa ainda.<br>Clique em "Nova conversa" para começar.</div>';
    return;
  }

  list.innerHTML = '';
  ids.forEach(id => {
    const conv = State.conversations[id];
    const item = document.createElement('div');
    item.className = 'history-item' + (id === State.currentChatId ? ' active' : '');
    item.innerHTML = `
      <span class="history-icon">💬</span>
      <span class="history-text">${escapeHtml(conv.title || 'Nova conversa')}</span>
      <span class="history-date">${formatRelativeDate(conv.updatedAt)}</span>
      <button class="delete-history-btn" title="Excluir conversa">✕</button>
    `;
    item.querySelector('.delete-history-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteChat(id);
    });
    item.addEventListener('click', () => {
      switchChat(id);
      closeSidebar();
    });
    list.appendChild(item);
  });
}

function updateChatTitle() {
  const chat = getCurrentChat();
  const titleEl = document.getElementById('current-chat-title');
  if (titleEl) titleEl.textContent = chat.title || 'Nova conversa';
}

// ============================================================
//  MARKDOWN SIMPLES
// ============================================================

function renderMarkdown(text) {
  if (!text) return '';

  // Escape HTML primeiro
  let html = escapeHtml(text);

  // Code blocks
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code class="lang-${lang || 'text'}">${code.trim()}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');

  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/_(.+?)_/g, '<em>$1</em>');

  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Listas não ordenadas
  html = html.replace(/^[*\-•] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`);

  // Listas ordenadas
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Quebras de linha → parágrafos
  const parts = html.split(/\n{2,}/);
  html = parts.map(part => {
    if (part.startsWith('<h') || part.startsWith('<ul') || part.startsWith('<ol') || part.startsWith('<pre')) {
      return part;
    }
    const withBr = part.replace(/\n/g, '<br>');
    return `<p>${withBr}</p>`;
  }).join('');

  return html;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ============================================================
//  TEXT-TO-SPEECH (voz Google via SpeechSynthesis)
// ============================================================

function speakText(text) {
  if (!State.speechSynth) {
    showToast('Síntese de voz não suportada neste navegador.', 'error');
    return;
  }

  stopSpeech();

  // Limpar markdown para leitura
  const clean = text
    .replace(/```[\s\S]*?```/g, 'bloco de código')
    .replace(/`[^`]+`/g, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/^#{1,3} /gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[*\-] /gm, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .trim();

  const utter = new SpeechSynthesisUtterance(clean);
  utter.lang = 'pt-BR';
  utter.rate = 1.0;
  utter.pitch = 1.0;
  utter.volume = 1.0;

  // Preferir voz do Google em pt-BR
  const voices = State.speechSynth.getVoices();
  const googlePtVoice = voices.find(v =>
    v.name.toLowerCase().includes('google') && v.lang.startsWith('pt')
  );
  const ptVoice = voices.find(v => v.lang.startsWith('pt-BR') || v.lang.startsWith('pt'));
  utter.voice = googlePtVoice || ptVoice || null;

  utter.onstart = () => {
    State.isSpeaking = true;
    const stopBtn = document.getElementById('tts-stop-btn');
    if (stopBtn) stopBtn.style.display = 'flex';
  };

  utter.onend = utter.onerror = () => {
    State.isSpeaking = false;
    const stopBtn = document.getElementById('tts-stop-btn');
    if (stopBtn) stopBtn.style.display = 'none';
  };

  State.speechSynth.speak(utter);
}

function stopSpeech() {
  if (State.speechSynth) {
    State.speechSynth.cancel();
    State.isSpeaking = false;
  }
  const stopBtn = document.getElementById('tts-stop-btn');
  if (stopBtn) stopBtn.style.display = 'none';
}

// ============================================================
//  RECONHECIMENTO DE VOZ (Speech Recognition)
// ============================================================

function initVoiceInput() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return;

  State.recognition = new SpeechRecognition();
  State.recognition.lang = 'pt-BR';
  State.recognition.continuous = false;
  State.recognition.interimResults = false;

  State.recognition.onresult = (e) => {
    const transcript = e.results[0][0].transcript;
    const input = document.getElementById('user-input');
    if (input) {
      input.value += (input.value ? ' ' : '') + transcript;
      autoResizeTextarea(input);
      updateCharCount();
    }
  };

  State.recognition.onend = () => {
    State.isListening = false;
    const btn = document.getElementById('voice-input-btn');
    if (btn) btn.classList.remove('recording');
  };

  State.recognition.onerror = () => {
    State.isListening = false;
    const btn = document.getElementById('voice-input-btn');
    if (btn) btn.classList.remove('recording');
    showToast('Não foi possível reconhecer a voz.', 'error');
  };
}

function toggleVoiceInput() {
  if (!State.recognition) {
    showToast('Reconhecimento de voz não suportado neste navegador.', 'error');
    return;
  }

  const btn = document.getElementById('voice-input-btn');

  if (State.isListening) {
    State.recognition.stop();
    State.isListening = false;
    if (btn) btn.classList.remove('recording');
  } else {
    State.recognition.start();
    State.isListening = true;
    if (btn) btn.classList.add('recording');
    showToast('Ouvindo... fale agora!', 'success');
  }
}

// ============================================================
//  EXPORTAR CONVERSA
// ============================================================

function exportCurrentChat() {
  const chat = getCurrentChat();
  if (!chat.messages.length) {
    showToast('Nenhuma mensagem para exportar.', 'error');
    return;
  }

  const lines = [`# ${chat.title}\n`, `Data: ${new Date(chat.createdAt).toLocaleString('pt-BR')}\n\n---\n`];

  chat.messages.forEach(msg => {
    if (msg.role === 'thinking') {
      lines.push(`\n> 💭 **Raciocínio interno:**\n> ${msg.content.replace(/\n/g, '\n> ')}\n`);
    } else {
      const role = msg.role === 'user' ? '👤 Você' : `🤖 ${State.assistantName}`;
      const time = formatTime(msg.ts);
      lines.push(`\n**${role}** _(${time})_\n\n${msg.content}\n\n---`);
    }
  });

  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `nexusai-conversa-${Date.now()}.md`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Conversa exportada!', 'success');
}

// ============================================================
//  UTILITÁRIOS
// ============================================================

function formatTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function formatRelativeDate(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'agora';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function scrollToBottom() {
  const area = document.getElementById('messages-area');
  if (area) {
    setTimeout(() => {
      area.scrollTop = area.scrollHeight;
    }, 50);
  }
}

function setThinkingState(active) {
  const el = document.getElementById('thinking-indicator');
  if (el) el.style.display = active ? 'flex' : 'none';
}

function setThinkLabel(text) {
  const el = document.getElementById('thinking-label');
  if (el) el.textContent = text;
}

function setSendEnabled(enabled) {
  const btn = document.getElementById('send-btn');
  if (btn) btn.disabled = !enabled;
}

function autoResizeTextarea(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 160) + 'px';
}

function updateCharCount() {
  const input = document.getElementById('user-input');
  const counter = document.getElementById('char-count');
  if (input && counter) {
    counter.textContent = `${input.value.length} / 10000`;
  }
}

function copyToClipboard(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}

function showToast(msg, type = '') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.className = `toast ${type} show`;
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    toast.className = 'toast';
  }, 3000);
}

function fillInput(text) {
  const input = document.getElementById('user-input');
  if (input) {
    input.value = text;
    input.focus();
    autoResizeTextarea(input);
    updateCharCount();
  }
}

// ============================================================
//  SIDEBAR
// ============================================================

function openSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (sidebar) sidebar.classList.add('open');
  if (overlay) overlay.classList.add('show');
}

function closeSidebar() {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (sidebar) sidebar.classList.remove('open');
  if (overlay) overlay.classList.remove('show');
}

// ============================================================
//  CONFIGURAÇÕES
// ============================================================

function openSettings() {
  const modal = document.getElementById('settings-modal');
  if (!modal) return;

  // Preencher valores atuais
  const nameEl = document.getElementById('settings-assistant-name');
  if (nameEl) nameEl.value = State.assistantName;

  const tempEl = document.getElementById('temperature-slider');
  if (tempEl) {
    tempEl.value = Math.round(State.temperature * 10);
    document.getElementById('temp-value').textContent = State.temperature.toFixed(1);
  }

  const maxEl = document.getElementById('max-tokens-select');
  if (maxEl) maxEl.value = State.maxTokens;

  modal.style.display = 'flex';
}

function closeSettings() {
  const modal = document.getElementById('settings-modal');
  if (modal) modal.style.display = 'none';
}

function saveSettings() {
  const nameEl = document.getElementById('settings-assistant-name');
  if (nameEl && nameEl.value.trim()) {
    State.assistantName = nameEl.value.trim();
  }

  const tempEl = document.getElementById('temperature-slider');
  if (tempEl) {
    State.temperature = parseInt(tempEl.value) / 10;
  }

  const maxEl = document.getElementById('max-tokens-select');
  if (maxEl) {
    State.maxTokens = parseInt(maxEl.value);
  }

  Storage.saveAll();
  closeSettings();
  showToast('Configurações salvas!', 'success');
}

// ============================================================
//  TELA DE SETUP — PROVIDERS
// ============================================================

function initProviderSelection() {
  const buttons = document.querySelectorAll('.provider-btn');

  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      buttons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const provider = btn.dataset.provider;
      State.provider = provider;

      const customGroup = document.getElementById('custom-url-group');
      const modelSelect = document.getElementById('model-select');

      if (provider === 'custom') {
        customGroup.style.display = 'flex';
        modelSelect.innerHTML = '<option value="gpt-4o">gpt-4o</option><option value="custom">Outro modelo...</option>';
      } else {
        customGroup.style.display = 'none';
        const models = btn.dataset.models.split(',');
        modelSelect.innerHTML = models.map(m =>
          `<option value="${m}">${m}</option>`
        ).join('');
      }
    });
  });
}

// ============================================================
//  INICIALIZAÇÃO
// ============================================================

function showChatScreen() {
  document.getElementById('setup-screen').classList.remove('active');
  document.getElementById('chat-screen').classList.add('active');

  // Atualizar badge do modelo
  const badge = document.getElementById('current-model-badge');
  if (badge) {
    badge.textContent = State.model || State.provider;
  }

  updateChatTitle();
  renderMessages();
  renderHistoryList();

  // Focar input
  setTimeout(() => {
    const input = document.getElementById('user-input');
    if (input) input.focus();
  }, 100);
}

function tryAutoConnect() {
  if (State.apiKey && State.apiUrl && State.model) {
    showChatScreen();
    return true;
  }
  return false;
}

document.addEventListener('DOMContentLoaded', () => {

  // Carregar dados salvos
  Storage.loadAll();

  // Inicializar seleção de provedor
  initProviderSelection();

  // Inicializar reconhecimento de voz
  initVoiceInput();

  // Pré-selecionar provedor salvo
  if (State.provider) {
    const btn = document.querySelector(`[data-provider="${State.provider}"]`);
    if (btn) {
      btn.click();
    }
  }

  // Pré-preencher modelo salvo
  if (State.model) {
    const sel = document.getElementById('model-select');
    if (sel) {
      // Verificar se a opção existe
      const opt = sel.querySelector(`option[value="${State.model}"]`);
      if (!opt) {
        const newOpt = document.createElement('option');
        newOpt.value = State.model;
        newOpt.textContent = State.model;
        sel.appendChild(newOpt);
      }
      sel.value = State.model;
    }
  }

  // Pré-preencher nome do assistente
  if (State.assistantName !== 'NexusAI') {
    const nameEl = document.getElementById('assistant-name');
    if (nameEl) nameEl.value = State.assistantName;
  }

  // Tentar auto-conectar
  if (tryAutoConnect()) return;

  // ---- SETUP SCREEN EVENTS ----

  // Toggle visibilidade da chave
  document.getElementById('toggle-key').addEventListener('click', () => {
    const input = document.getElementById('api-key-input');
    const btn = document.getElementById('toggle-key');
    input.type = input.type === 'password' ? 'text' : 'password';
    btn.innerHTML = input.type === 'password'
      ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`
      : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
  });

  // Conectar
  document.getElementById('connect-btn').addEventListener('click', () => {
    const keyInput = document.getElementById('api-key-input');
    const modelSel = document.getElementById('model-select');
    const nameInput = document.getElementById('assistant-name');

    const key = keyInput ? keyInput.value.trim() : '';
    const model = modelSel ? modelSel.value : '';

    if (!key) {
      showToast('Por favor, insira sua chave API.', 'error');
      keyInput.focus();
      return;
    }

    // Pegar URL do provedor ativo
    const activeBtn = document.querySelector('.provider-btn.active');
    let apiUrl = activeBtn ? activeBtn.dataset.url : '';
    if (State.provider === 'custom') {
      apiUrl = document.getElementById('custom-url')?.value.trim() || '';
    }

    if (!apiUrl) {
      showToast('Insira a URL da API.', 'error');
      return;
    }

    State.apiKey = key;
    State.apiUrl = apiUrl;
    State.model = model || 'llama-3.3-70b-versatile';

    if (nameInput && nameInput.value.trim()) {
      State.assistantName = nameInput.value.trim();
    }

    // Garantir conversa inicial
    if (!State.currentChatId) createNewChat();

    Storage.saveAll();
    showChatScreen();
    showToast(`Conectado com sucesso! Modelo: ${State.model}`, 'success');
  });

  // ---- CHAT SCREEN EVENTS ----

  // Enviar mensagem
  const sendBtn = document.getElementById('send-btn');
  const userInput = document.getElementById('user-input');

  sendBtn.addEventListener('click', () => {
    const text = userInput.value.trim();
    if (!text) return;
    userInput.value = '';
    autoResizeTextarea(userInput);
    updateCharCount();
    sendMessage(text);
  });

  userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendBtn.click();
    }
  });

  userInput.addEventListener('input', () => {
    autoResizeTextarea(userInput);
    updateCharCount();
  });

  // Sidebar
  document.getElementById('open-sidebar').addEventListener('click', openSidebar);
  document.getElementById('close-sidebar').addEventListener('click', closeSidebar);
  document.getElementById('sidebar-overlay').addEventListener('click', closeSidebar);

  // Nova conversa
  document.getElementById('new-chat-btn').addEventListener('click', () => {
    createNewChat();
    renderMessages();
    updateChatTitle();
    renderHistoryList();
    closeSidebar();
    setTimeout(() => document.getElementById('user-input')?.focus(), 100);
  });

  // Modo pensador
  document.getElementById('think-toggle').addEventListener('click', function () {
    State.thinkMode = !State.thinkMode;
    this.dataset.active = String(State.thinkMode);
    this.classList.toggle('active', State.thinkMode);
    showToast(State.thinkMode ? '🧠 Modo Pensador ativado!' : 'Modo Pensador desativado.', State.thinkMode ? 'success' : '');
  });

  // Exportar
  document.getElementById('export-chat-btn').addEventListener('click', exportCurrentChat);

  // Desconectar
  document.getElementById('disconnect-btn').addEventListener('click', () => {
    if (!confirm('Trocar a chave API? Você voltará para a tela inicial (conversas são mantidas).')) return;
    Storage.remove(Storage.KEYS.CREDENTIALS);
    State.apiKey = '';
    State.apiUrl = '';
    document.getElementById('chat-screen').classList.remove('active');
    document.getElementById('setup-screen').classList.add('active');
    document.getElementById('api-key-input').value = '';
  });

  // Configurações
  document.getElementById('settings-btn').addEventListener('click', () => {
    closeSidebar();
    openSettings();
  });
  document.getElementById('close-settings').addEventListener('click', closeSettings);
  document.getElementById('close-settings-2').addEventListener('click', closeSettings);
  document.getElementById('save-settings').addEventListener('click', saveSettings);
  document.getElementById('settings-modal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('settings-modal')) closeSettings();
  });

  // Limpar tudo
  document.getElementById('clear-all-btn').addEventListener('click', () => {
    closeSidebar();
    clearAllChats();
  });

  // Slider temperatura
  const tempSlider = document.getElementById('temperature-slider');
  if (tempSlider) {
    tempSlider.addEventListener('input', () => {
      document.getElementById('temp-value').textContent = (parseInt(tempSlider.value) / 10).toFixed(1);
    });
  }

  // Troca de tema
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (btn.dataset.theme === 'light') {
        document.body.classList.add('light-theme');
      } else {
        document.body.classList.remove('light-theme');
      }
    });
  });

  // Botão de voz (entrada)
  document.getElementById('voice-input-btn').addEventListener('click', toggleVoiceInput);

  // Botão parar TTS
  document.getElementById('tts-stop-btn').addEventListener('click', stopSpeech);

  // Carregar vozes TTS quando disponíveis
  if (window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = () => { /* Vozes carregadas */ };
  }

  // Expor função global para chips
  window.fillInput = fillInput;
});
