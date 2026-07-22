// background.js — service worker: LLM proxy + browser automation
// LLM calls are routed through a proxy (local or cloud) because Cloudflare
// blocks requests with Origin: chrome-extension://... headers.
// File access uses the native File System Access API — no proxy needed.

// ── Config ──
const DEFAULT_PROXY   = 'http://localhost:3333';

// ── Storage helpers ──
async function getProxySettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['bobApiKey', 'proxyUrl', 'proxySecret'], (r) => {
      resolve({
        apiKey:      r.bobApiKey    || '',
        proxyUrl:    (r.proxyUrl    || DEFAULT_PROXY).replace(/\/$/, ''),
        proxySecret: r.proxySecret  || '',
      });
    });
  });
}

// Keep a simpler alias for places that only need the API key
async function getBobApiKey() {
  return new Promise((resolve) => {
    chrome.storage.local.get('bobApiKey', (r) => resolve(r.bobApiKey || ''));
  });
}

// ── LLM — proxied to avoid Cloudflare Origin block ──
async function callLLM(messages) {
  const { apiKey, proxyUrl, proxySecret } = await getProxySettings();

  if (!apiKey) {
    throw new Error('No API key set. Open Settings and enter your Bob API key.');
  }

  const headers = { 'Content-Type': 'application/json' };
  if (proxySecret) headers['X-Proxy-Secret'] = proxySecret;

  let res;
  try {
    res = await fetch(`${proxyUrl}/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ messages, apiKey }),
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    const isLocal = proxyUrl.includes('localhost') || proxyUrl.includes('127.0.0.1');
    throw new Error(isLocal
      ? 'Local proxy not running. Start it: cd local-server && node server.js\n(Or set a cloud proxy URL in Settings.)'
      : `Could not reach proxy at ${proxyUrl}: ${err.message}`
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Proxy error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  if (data.answer !== undefined) return data;

  // Fallback: raw OpenAI-format response
  const raw = data.choices?.[0]?.message?.content || '{}';
  try {
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, raw];
    return JSON.parse(jsonMatch[1].trim());
  } catch {
    return { answer: raw, actions: [] };
  }
}

// ── Tab helpers ──
function getActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, ([tab]) => resolve(tab || null));
  });
}

async function ensureContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js'],
  }).catch(() => {});
}

function waitForTabLoad(tabId, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);

    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 600);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function runContentAction(tabId, action) {
  await ensureContentScript(tabId);
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'EXECUTE_ACTION', action }, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(resp || { ok: false, error: 'No response from content script' });
      }
    });
  });
}

// ── Browser action executor ──
async function executeBrowserAction(action) {
  const type = action.type;

  if (type === 'navigate') {
    // Open in a new tab so the user's current tab is never hijacked
    const tab = await chrome.tabs.create({ url: action.url, active: true });
    await waitForTabLoad(tab.id);
    return `Opened ${action.url}`;
  }

  if (type === 'navigate_search') {
    const query = encodeURIComponent(action.query);
    // Open Google search in a new tab
    const tab = await chrome.tabs.create({
      url: `https://www.google.com/search?q=${query}`,
      active: true,
    });
    await waitForTabLoad(tab.id);
    const linksResp = await runContentAction(tab.id, { type: 'get_links' });
    if (linksResp.ok && Array.isArray(linksResp.result)) {
      const organic = linksResp.result.find(
        (l) => l.href?.startsWith('http') &&
               !l.href.includes('google.com') &&
               !l.href.includes('accounts.google') &&
               l.text.trim().length > 3
      );
      if (organic) {
        // Navigate the same new tab to the top result
        await chrome.tabs.update(tab.id, { url: organic.href });
        await waitForTabLoad(tab.id);
        return `Searched "${action.query}" → ${organic.href}`;
      }
    }
    return `Searched "${action.query}" — showing Google results`;
  }

  if (type === 'new_tab') {
    const tab = await chrome.tabs.create({ url: action.url || 'chrome://newtab', active: true });
    if (action.url) await waitForTabLoad(tab.id);
    return `Opened new tab: ${action.url || 'new tab'}`;
  }

  if (type === 'close_tab') {
    const tab = await getActiveTab();
    if (tab) await chrome.tabs.remove(tab.id);
    return 'Closed current tab';
  }

  if (type === 'go_back') {
    const tab = await getActiveTab();
    if (tab) await chrome.tabs.goBack(tab.id).catch(() => {});
    return 'Went back';
  }

  if (type === 'go_forward') {
    const tab = await getActiveTab();
    if (tab) await chrome.tabs.goForward(tab.id).catch(() => {});
    return 'Went forward';
  }

  if (type === 'reload') {
    const tab = await getActiveTab();
    if (tab) { await chrome.tabs.reload(tab.id); await waitForTabLoad(tab.id); }
    return 'Reloaded page';
  }

  if (type === 'duplicate_tab') {
    const tab = await getActiveTab();
    if (tab) await chrome.tabs.duplicate(tab.id);
    return 'Duplicated tab';
  }

  if (type === 'pin_tab') {
    const tab = await getActiveTab();
    if (tab) await chrome.tabs.update(tab.id, { pinned: !tab.pinned });
    return tab?.pinned ? 'Unpinned tab' : 'Pinned tab';
  }

  if (type === 'list_tabs') {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    return tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active }));
  }

  if (type === 'switch_tab') {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    let target;
    if (action.index !== undefined) target = tabs[action.index];
    else if (action.title) {
      const q = action.title.toLowerCase();
      target = tabs.find((t) => t.title?.toLowerCase().includes(q) || t.url?.toLowerCase().includes(q));
    }
    if (!target) throw new Error(`Tab not found: ${JSON.stringify(action)}`);
    await chrome.tabs.update(target.id, { active: true });
    return `Switched to tab: "${target.title}"`;
  }

  if (type === 'bookmark') {
    const tab = await getActiveTab();
    if (!tab) throw new Error('No active tab');
    const existing = await chrome.bookmarks.search({ url: tab.url }).catch(() => []);
    if (existing.length > 0) return `Already bookmarked: ${tab.title}`;
    await chrome.bookmarks.create({ title: tab.title, url: tab.url });
    return `Bookmarked: ${tab.title}`;
  }

  if (type === 'get_page_text') {
    const tab = await getActiveTab();
    if (!tab) throw new Error('No active tab');
    // Use main content selector for cleaner extraction
    const resp = await runContentAction(tab.id, {
      type: 'extract',
      selector: 'main, [role="main"], article, .content, #content, .topic-content, .bodydiv, body',
    });
    if (!resp.ok) throw new Error(resp.error);
    return resp.result;
  }

  // open_link: find the link's href via content script, then navigate in a new tab
  if (type === 'open_link') {
    const tab = await getActiveTab();
    if (!tab) throw new Error('No active tab');
    // Ask content script to find the best matching link and return its href
    const resp = await runContentAction(tab.id, action);
    if (!resp.ok) throw new Error(resp.error);
    const href = resp.result;
    if (href && href.startsWith('http')) {
      // Navigate to the href in a new tab (reliable — bypasses SPA click issues)
      const newTab = await chrome.tabs.create({ url: href, active: true });
      await waitForTabLoad(newTab.id);
      return `Opened: ${href}`;
    }
    return `Followed link: ${href || action.label}`;
  }

  const contentTypes = ['click', 'fill', 'scroll', 'extract', 'get_links', 'focus', 'press_key'];
  if (contentTypes.includes(type)) {
    const tab = await getActiveTab();
    if (!tab) throw new Error('No active tab');
    const resp = await runContentAction(tab.id, action);
    if (!resp.ok) throw new Error(resp.error);
    return resp.result;
  }

  throw new Error(`Unknown action type: "${type}"`);
}

// ── System prompt ──
function buildSystemPrompt() {
  return `You are Bob, a helpful AI assistant embedded in a browser extension with full browser automation capabilities.

You can both answer questions AND control the browser. When the user asks you to do something that requires browser interaction, include ALL required actions together in a single response.

CONTEXT BLOCKS: Messages may include [PAGE CONTEXT] (current tab content) and/or [LOCAL FILE CONTEXT] (a local file or folder the user loaded). Use both when present.

CRITICAL — always respond with valid JSON in exactly this shape:
{
  "answer": "Your response using markdown — plain text only, NO JSON objects here",
  "actions": [ ...action objects... ]
}

Rules:
- "answer" must be a plain markdown string. Never put JSON objects, curly braces, or action arrays inside "answer".
- "actions" contains ALL browser actions for this response in one array. Never split actions across multiple responses.
- If the user asks to do N things, include all N actions in the same "actions" array.
- "actions" can be [] when no browser control is needed.
- When the message contains a [PAGE LINKS] block, those are the real links on the page. Pick the most relevant href and use { "type": "navigate", "url": "<exact href>" } — do not make up URLs.

BROWSER ACTIONS — include in "actions" when needed:

Navigation (opens in a new tab — current tab is never replaced):
  { "type": "navigate", "url": "https://..." }
  { "type": "navigate_search", "query": "search terms" }
  { "type": "new_tab", "url": "https://..." }
  { "type": "close_tab" }
  { "type": "go_back" } / { "type": "go_forward" }
  { "type": "reload" }
  { "type": "duplicate_tab" }

Tab management:
  { "type": "list_tabs" }
  { "type": "switch_tab", "title": "partial title" }
  { "type": "pin_tab" }
  { "type": "bookmark" }

Page interaction:
  { "type": "click", "selector": "visible text or CSS selector" }
  { "type": "fill", "selector": "...", "value": "text to type" }
  { "type": "press_key", "key": "Enter", "selector": "..." }
  { "type": "scroll", "direction": "down", "amount": 400 }
  { "type": "open_link", "label": "link text" }  ← finds link by text and navigates to its href

Data extraction:
  { "type": "extract", "selector": "CSS selector" }
  { "type": "get_links" }   ← returns [{text, href}] for all links on page
  { "type": "get_page_text" }

IMPORTANT — navigating within a page (docs sites, SPAs):
- Do NOT use "click" to follow documentation links. Those sites use client-side routing and click() may not work.
- Instead use "open_link" with the visible link text, which reliably navigates to the link's href.
- If you already know the full URL, use "navigate" directly — it is the most reliable method.
- If unsure of the URL, use "get_links" first to find it, then "navigate" to the exact href.

Markdown rules for "answer":
- Use **bold** for key terms
- Use numbered lists (1. 2. 3.) for steps, bullets (- item) for lists
- Use \`backticks\` for code, filenames, paths
- Keep responses concise — no filler`;
}

// ── Message handler ──
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {

  if (req.type === 'CHAT') {
    (async () => {
      try { sendResponse(await handleChat(req)); }
      catch (err) { sendResponse({ error: err.message }); }
    })();
    return true;
  }

  if (req.type === 'EXECUTE_ACTIONS') {
    (async () => {
      const results = [];
      for (let i = 0; i < req.actions.length; i++) {
        const action = req.actions[i];
        try {
          const result = await executeBrowserAction(action);
          results.push({ index: i, ok: true, result, action });
        } catch (err) {
          results.push({ index: i, ok: false, error: err.message, action });
          if (!action.continueOnError) break;
        }
        chrome.storage.session.set({ actionProgress: { results, done: false } }).catch(() => {});
      }
      chrome.storage.session.set({ actionProgress: { results, done: true } }).catch(() => {});
      sendResponse({ results });
    })();
    return true;
  }

  if (req.type === 'OPEN_SIDE_PANEL') {
    chrome.sidePanel.open({ tabId: req.tabId });
    return false;
  }
});

// ── Chat handler ──
async function handleChat({ userMessage, pageContext, fileContext, history }) {
  let extraContext = '';

  if (fileContext?.content) {
    const kind = fileContext.type === 'dir' ? 'folder tree' : 'file contents';
    extraContext += `\n\n[LOCAL FILE CONTEXT — ${kind}: ${fileContext.label}]\n${fileContext.content.slice(0, 8000)}\n[END LOCAL FILE CONTEXT]`;
  }

  const pageInfo = pageContext
    ? `\n\n[PAGE CONTEXT]\nTitle: ${pageContext.pageTitle}\nURL: ${pageContext.pageUrl}` +
      (pageContext.selectedText ? `\nHighlighted text: "${pageContext.selectedText}"` : '') +
      (pageContext.pageText     ? `\nPage text:\n${pageContext.pageText}`              : '') +
      `\n[END PAGE CONTEXT]`
    : '';

  // Build messages: system + conversation history (last 10 turns) + new user message
  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    ...((history || []).slice(-10)),
    { role: 'user', content: userMessage + pageInfo + extraContext },
  ];

  return await callLLM(messages);
}

// ── Extension icon → open side panel ──
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// ── Context menu ──
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'ask-bob', title: 'Ask Bob about "%s"', contexts: ['selection'] });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'ask-bob') return;
  const selectedText = info.selectionText || '';
  chrome.storage.local.set({ pendingAskBob: { selectedText, tabId: tab.id } }, () => {
    chrome.runtime.sendMessage({ type: 'ASK_BOB_SELECTION', selectedText }).catch(() => {});
  });
});
