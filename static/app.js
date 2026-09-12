const modelSelect = document.querySelector('#model');
const refreshModelsButton = document.querySelector('#refresh-models');
const clearChatButton = document.querySelector('#clear-chat');
const stopGenerationButton = document.querySelector('#stop-generation');
const copyLastButton = document.querySelector('#copy-last');
const newChatButton = document.querySelector('#new-chat');
const chatList = document.querySelector('#chat-list');
const messages = document.querySelector('#messages');
const welcome = document.querySelector('#welcome-message');
const composer = document.querySelector('#composer');
const promptInput = document.querySelector('#prompt');
const sendButton = document.querySelector('.send-button');
const statusDot = document.querySelector('#status-dot');
const statusLabel = document.querySelector('#status-label');
const STORAGE_KEY = 'local-ollama-chat:sessions';
const SETTINGS_KEY = 'local-ollama-chat:settings';
let chatSessions = loadChats();
let activeChatId = null;
let isStreaming = false;
let currentAbortController = null;
let currentAssistantBubble = null;
let currentAnswer = '';

function setStatus(connected, label) {
  statusDot.classList.toggle('connected', connected);
  statusLabel.textContent = label;
}

function saveChats() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(chatSessions));
}

function loadChats() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(stored) ? stored : [];
  } catch (error) {
    return [];
  }
}

function normalizeSession(session) {
  return {
    id: session.id || `chat-${Date.now()}`,
    title: session.title || 'New chat',
    messages: Array.isArray(session.messages) ? session.messages : [],
    updatedAt: session.updatedAt || Date.now(),
  };
}

function getActiveSession() {
  if (!chatSessions.length) {
    chatSessions = [{ id: `chat-${Date.now()}`, title: 'New chat', messages: [], updatedAt: Date.now() }];
    activeChatId = chatSessions[0].id;
    saveChats();
  }

  if (!activeChatId || !chatSessions.some((session) => session.id === activeChatId)) {
    activeChatId = chatSessions[0].id;
  }

  return chatSessions.find((session) => session.id === activeChatId) || chatSessions[0];
}

function ensureDefaultChat() {
  if (!chatSessions.length) {
    chatSessions = [normalizeSession({ id: `chat-${Date.now()}`, title: 'New chat', messages: [] })];
    activeChatId = chatSessions[0].id;
    saveChats();
  }
}

function escapeHtml(value) {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[character]);
}

function renderInlineMarkdown(value) {
  const tokens = [];
  const withTokens = value.replace(/`([^`]+)`/g, (_, code) => {
    tokens.push(`<code>${escapeHtml(code)}</code>`);
    return `@@TOKEN${tokens.length - 1}@@`;
  });
  let html = escapeHtml(withTokens)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/_([^_]+)_/g, '<em>$1</em>');

  tokens.forEach((token, index) => {
    html = html.replace(`@@TOKEN${index}@@`, token);
  });
  return html;
}

function renderMarkdown(text) {
  const lines = text.split('\n');
  const output = [];
  let inCodeBlock = false;
  let codeLines = [];
  let listType = null;

  const closeList = () => {
    if (listType) {
      output.push(`</${listType}>`);
      listType = null;
    }
  };

  lines.forEach((line) => {
    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        output.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        codeLines = [];
        inCodeBlock = false;
      } else {
        closeList();
        inCodeBlock = true;
      }
      return;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      return;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    const unorderedItem = line.match(/^\s*[-*]\s+(.+)$/);
    const orderedItem = line.match(/^\s*\d+\.\s+(.+)$/);

    if (heading) {
      closeList();
      const level = heading[1].length;
      output.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
    } else if (unorderedItem || orderedItem) {
      const nextListType = unorderedItem ? 'ul' : 'ol';
      if (listType !== nextListType) {
        closeList();
        listType = nextListType;
        output.push(`<${listType}>`);
      }
      output.push(`<li>${renderInlineMarkdown((unorderedItem || orderedItem)[1])}</li>`);
    } else if (line.trim()) {
      closeList();
      output.push(`<p>${renderInlineMarkdown(line)}</p>`);
    } else {
      closeList();
    }
  });

  if (inCodeBlock) output.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  closeList();
  return output.join('');
}

function renderAssistantBubble(bubble, text) {
  bubble.classList.add('markdown');
  bubble.innerHTML = renderMarkdown(text);
}

function addMessage(role, text = '') {
  if (welcome) welcome.remove();
  const message = document.createElement('div');
  message.className = `message ${role}`;
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = role === 'user' ? 'YOU' : 'AI';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (role === 'assistant') {
    renderAssistantBubble(bubble, text);
  } else {
    bubble.textContent = text;
  }
  message.append(avatar, bubble);
  messages.append(message);
  messages.scrollTop = messages.scrollHeight;
  return bubble;
}

function renderChatList() {
  const sessions = [...chatSessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  chatList.innerHTML = '';

  sessions.forEach((session) => {
    const item = document.createElement('div');
    item.className = `chat-item ${session.id === activeChatId ? 'active' : ''}`;

    const title = document.createElement('button');
    title.type = 'button';
    title.className = 'chat-item-title';
    title.textContent = session.title || 'New chat';
    title.addEventListener('click', () => {
      activeChatId = session.id;
      renderChatList();
      renderMessages();
    });
    title.addEventListener('dblclick', () => {
      renameChat(session.id);
    });

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'chat-item-delete';
    deleteButton.textContent = '×';
    deleteButton.setAttribute('aria-label', `Delete ${session.title || 'chat'}`);
    deleteButton.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteChat(session.id);
    });

    item.append(title, deleteButton);
    chatList.append(item);
  });
}

function renameChat(sessionId) {
  const session = chatSessions.find((entry) => entry.id === sessionId);
  if (!session) return;

  const nextTitle = prompt('Rename this chat', session.title || 'New chat');
  if (nextTitle === null) return;

  const trimmedTitle = nextTitle.trim();
  session.title = trimmedTitle || 'New chat';
  session.updatedAt = Date.now();
  saveChats();
  renderChatList();
}

function deleteChat(sessionId) {
  chatSessions = chatSessions.filter((session) => session.id !== sessionId);
  if (!chatSessions.length) {
    const newSession = normalizeSession({ id: `chat-${Date.now()}`, title: 'New chat', messages: [] });
    chatSessions.push(newSession);
  }

  if (activeChatId === sessionId) {
    activeChatId = chatSessions[0].id;
  }

  saveChats();
  renderChatList();
  renderMessages();
}

function renderMessages() {
  const session = getActiveSession();
  messages.innerHTML = '';

  if (!session.messages.length) {
    if (welcome) messages.append(welcome);
    return;
  }

  session.messages.forEach(({ role, content }) => {
    addMessage(role, content);
  });
}

function restoreConversation() {
  chatSessions = chatSessions.map(normalizeSession);
  ensureDefaultChat();
  activeChatId = activeChatId || chatSessions[0].id;
  renderChatList();
  renderMessages();
}

function clearChat() {
  const session = getActiveSession();
  session.messages = [];
  session.title = 'New chat';
  session.updatedAt = Date.now();
  saveChats();
  renderChatList();
  renderMessages();
  promptInput.focus();
  stopGenerationButton.disabled = true;
  copyLastButton.disabled = true;
  currentAssistantBubble = null;
  currentAnswer = '';
}

function updateTitleFromMessage(session, text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  session.title = trimmed.slice(0, 26) || 'New chat';
  if (session.title.length === 26) session.title += '…';
}

function showTypingIndicator() {
  if (document.querySelector('.typing-indicator')) return;
  const indicator = document.createElement('div');
  indicator.className = 'typing-indicator';
  indicator.setAttribute('aria-live', 'polite');
  indicator.innerHTML = '<span></span><span></span><span></span>';
  messages.append(indicator);
  messages.scrollTop = messages.scrollHeight;
}

function hideTypingIndicator() {
  const indicator = document.querySelector('.typing-indicator');
  if (indicator) indicator.remove();
}

async function loadModels() {
  try {
    const response = await fetch('/api/models');
    if (!response.ok) throw new Error('Ollama is not reachable');

    const data = await response.json();
    const models = data.models || [];
    modelSelect.replaceChildren();

    if (!models.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No models found';
      modelSelect.append(option);
      modelSelect.disabled = true;
      setStatus(false, 'No models found');
      return;
    }

    models.forEach((model) => {
      const option = document.createElement('option');
      option.value = model.name;
      option.textContent = model.name;
      modelSelect.append(option);
    });

    modelSelect.disabled = false;
    setStatus(true, 'Ollama connected');
  } catch (error) {
    modelSelect.replaceChildren();
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Ollama offline';
    modelSelect.append(option);
    modelSelect.disabled = true;
    setStatus(false, 'Ollama offline');

    if (!chatSessions.length && welcome) {
      addMessage('assistant', 'I cannot reach Ollama. Start it with `ollama serve`, then refresh this page.');
    }
  }
}

function updateActionButtons() {
  stopGenerationButton.disabled = !isStreaming;
  copyLastButton.disabled = !currentAssistantBubble || !currentAssistantBubble.textContent.trim();
}

function finalizeStreamingState() {
  hideTypingIndicator();
  isStreaming = false;
  currentAbortController = null;
  sendButton.disabled = false;
  updateActionButtons();
  currentAssistantBubble = null;
  currentAnswer = '';
  promptInput.focus();
}

function stopGeneration() {
  if (!currentAbortController || !isStreaming) return;
  isStreaming = false;
  stopGenerationButton.disabled = true;
  currentAbortController.abort();
  hideTypingIndicator();
  updateActionButtons();
}

async function copyLastResponse() {
  if (!currentAssistantBubble || !currentAssistantBubble.textContent.trim()) return;
  try {
    await navigator.clipboard.writeText(currentAssistantBubble.textContent.trim());
    const originalText = copyLastButton.textContent;
    copyLastButton.textContent = 'Copied';
    setTimeout(() => {
      copyLastButton.textContent = originalText;
    }, 1200);
  } catch (error) {
    console.error('Clipboard copy failed:', error);
  }
}

function buildChatRequest(session) {
  return {
    model: modelSelect.value,
    messages: session.messages,
  };
}

async function sendMessage(text) {
  if (isStreaming || !modelSelect.value) return;
  const session = getActiveSession();
  isStreaming = true;
  currentAbortController = new AbortController();
  currentAnswer = '';
  updateActionButtons();

  addMessage('user', text);
  currentAssistantBubble = addMessage('assistant');
  showTypingIndicator();
  session.messages.push({ role: 'user', content: text });
  updateTitleFromMessage(session, text);
  session.updatedAt = Date.now();
  saveChats();
  renderChatList();
  promptInput.value = '';
  promptInput.style.height = 'auto';
  sendButton.disabled = true;

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildChatRequest(session)),
      signal: currentAbortController.signal,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(error.error || 'Request failed');
    }

    if (!response.body) {
      throw new Error('Streaming response is unavailable.');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let streamComplete = false;

    const flushBufferedChunk = () => {
      if (!buffer.trim()) return;

      try {
        const chunk = JSON.parse(buffer);
        currentAnswer += chunk.message?.content || '';
        if (currentAssistantBubble) {
          renderAssistantBubble(currentAssistantBubble, currentAnswer);
          messages.scrollTop = messages.scrollHeight;
        }
      } catch (error) {
        console.warn('Skipped partial streaming chunk.', buffer);
      }

      buffer = '';
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line);
          currentAnswer += chunk.message?.content || '';
          renderAssistantBubble(currentAssistantBubble, currentAnswer);
          messages.scrollTop = messages.scrollHeight;
          if (chunk.done) {
            streamComplete = true;
            break;
          }
        } catch (error) {
          console.warn('Skipped malformed streaming chunk.', line);
        }
      }
      if (streamComplete) {
        break;
      }
    }

    flushBufferedChunk();

    if (!currentAnswer.trim()) {
      currentAssistantBubble.classList.add('error');
      currentAssistantBubble.textContent = 'The model returned an empty response.';
    } else {
      session.messages.push({ role: 'assistant', content: currentAnswer });
      session.updatedAt = Date.now();
      saveChats();
      renderChatList();
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      currentAssistantBubble.textContent = currentAnswer || 'Stopped.';
      if (!currentAnswer.trim()) {
        session.messages.pop();
      } else {
        session.messages.push({ role: 'assistant', content: currentAnswer });
      }
      session.updatedAt = Date.now();
      saveChats();
      renderChatList();
    } else {
      currentAssistantBubble.classList.add('error');
      currentAssistantBubble.textContent = error.message;
      session.messages.pop();
      saveChats();
    }
  } finally {
    finalizeStreamingState();
  }
}

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = promptInput.value.trim();
  if (text && !sendButton.disabled && modelSelect.value && !isStreaming) sendMessage(text);
});
promptInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    composer.requestSubmit();
  }
});
promptInput.addEventListener('input', () => {
  promptInput.style.height = 'auto';
  promptInput.style.height = `${Math.min(promptInput.scrollHeight, 140)}px`;
});
document.querySelectorAll('[data-prompt]').forEach((button) => {
  button.addEventListener('click', () => {
    promptInput.value = button.dataset.prompt;
    promptInput.focus();
  });
});
newChatButton.addEventListener('click', () => {
  const session = normalizeSession({
    id: `chat-${Date.now()}`,
    title: 'New chat',
    messages: [],
    updatedAt: Date.now(),
  });
  chatSessions.unshift(session);
  activeChatId = session.id;
  saveChats();
  renderChatList();
  renderMessages();
  promptInput.focus();
});
refreshModelsButton.addEventListener('click', loadModels);
clearChatButton.addEventListener('click', clearChat);
stopGenerationButton.addEventListener('click', stopGeneration);
copyLastButton.addEventListener('click', copyLastResponse);
updateActionButtons();
restoreConversation();
loadModels();
