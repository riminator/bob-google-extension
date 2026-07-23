// sidebar.js — Bob Chrome Extension v1.3.0
// Chat UI · File Browser (FSAA, full computer access) · Sessions · Settings

// ════════════════════════════════
// DOM REFS
// ════════════════════════════════
const messagesEl       = document.getElementById('messages');
const userInput        = document.getElementById('user-input');
const sendBtn          = document.getElementById('send-btn');
const contextBar       = document.getElementById('context-bar');
const contextPill      = document.getElementById('context-pill');
const clearContextBtn  = document.getElementById('clear-context');
const clearChatBtn     = document.getElementById('clear-chat-btn');
const apiKeyInput      = document.getElementById('api-key-input');
const saveSettingsBtn  = document.getElementById('save-settings-btn');
const workspaceListEl  = document.getElementById('workspace-list');
const tabs             = document.querySelectorAll('.tab');
const panels           = {
  chat:     document.getElementById('chat-panel'),
  files:    document.getElementById('files-panel'),
  sessions: document.getElementById('sessions-panel'),
  settings: document.getElementById('settings-panel-wrapper'),
};

// File browser DOM
const fbList       = document.getElementById('fb-list');
const fbBreadcrumb = document.getElementById('fb-breadcrumb');
const fbBackBtn    = document.getElementById('fb-back-btn');
const fbHiddenBtn  = document.getElementById('fb-hidden-btn');
const fbRoots      = document.getElementById('fb-roots');
const fbFooterPath = document.getElementById('fb-footer-path');
const fbAskBtn     = document.getElementById('fb-ask-btn');
const fbSearch     = document.getElementById('fb-search');

// Settings DOM
const serverStatusEl   = document.getElementById('server-status');
const serverStatusText = document.getElementById('server-status-text');
const proxyUrlInput    = document.getElementById('proxy-url-input');
const proxySecretInput = document.getElementById('proxy-secret-input');

// Sessions DOM
const sessionPathInput = document.getElementById('session-path-input');
const sessionBrowseBtn = document.getElementById('session-browse-btn');
const sessionOpenBtn   = document.getElementById('session-open-btn');
const sessionHint      = document.getElementById('session-hint');
const sessionsToast    = document.getElementById('sessions-toast');
const sessionsFolderList = document.getElementById('sessions-folder-list');

// ════════════════════════════════
// STATE
// ════════════════════════════════
let pageContext    = null;
let fileContext    = null;   // { label, content, path, type }

// File browser state
let fbRootHandles  = [];    // [{ name, handle, needsGrant }]
let fbStack        = [];    // [{ name, handle }]
let fbShowHidden   = false;
let fbSelectedItem = null;  // { name, type, handle }
let fbCurrentEntries = [];  // all entries in current dir (for filtering)

// Conversation history — kept in memory, cleared with chat
let chatHistory = [];       // [{ role: 'user'|'assistant', content: string }]

// ════════════════════════════════
// IndexedDB — persist FileSystemDirectoryHandles
// ════════════════════════════════
const IDB_NAME    = 'bob-fs-handles';
const IDB_STORE   = 'roots';
const IDB_VERSION = 1;

function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (e) => e.target.result.createObjectStore(IDB_STORE, { keyPath: 'name' });
    req.onsuccess  = (e) => resolve(e.target.result);
    req.onerror    = (e) => reject(e.target.error);
  });
}
async function idbSaveHandle(name, handle) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put({ name, handle });
    tx.oncomplete = resolve;
    tx.onerror    = (e) => reject(e.target.error);
  });
}
async function idbLoadHandles() {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).getAll();
    req.onsuccess = (e) => resolve(e.target.result || []);
    req.onerror   = (e) => reject(e.target.error);
  });
}
async function idbRemoveHandle(name) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(name);
    tx.oncomplete = resolve;
    tx.onerror    = (e) => reject(e.target.error);
  });
}

// ════════════════════════════════
// TAB SWITCHING
// ════════════════════════════════
tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    tabs.forEach((t) => t.classList.remove('active'));
    Object.values(panels).forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    const key = tab.dataset.tab;
    panels[key].classList.add('active');
    if (key === 'settings')  { checkServerStatus(); renderWorkspaceList(); }
    if (key === 'files')     initFileBrowser();
    if (key === 'sessions')  renderSessionsPanel();
  });
});

// ════════════════════════════════
// SERVER STATUS CHECK
// ════════════════════════════════
function getSavedProxyUrl() {
  return new Promise((resolve) =>
    chrome.storage.local.get('proxyUrl', (r) => resolve(r.proxyUrl || 'http://localhost:3333'))
  );
}

async function checkServerStatus() {
  const proxyUrl = (proxyUrlInput.value.trim() || await getSavedProxyUrl()).replace(/\/$/, '');
  serverStatusEl.className = 'server-status';
  serverStatusText.textContent = 'Checking…';
  try {
    const res = await fetch(`${proxyUrl}/health`, { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const isLocal = proxyUrl.includes('localhost') || proxyUrl.includes('127.0.0.1');
      serverStatusEl.className = 'server-status online';
      serverStatusText.textContent = isLocal
        ? 'Local proxy running ✓'
        : `Cloud proxy reachable ✓ — ${proxyUrl}`;
      return;
    }
  } catch (_) {}
  const isLocal = proxyUrl.includes('localhost') || proxyUrl.includes('127.0.0.1');
  serverStatusEl.className = 'server-status offline';
  serverStatusText.textContent = isLocal
    ? 'Local proxy offline — run: cd local-server && node server.js'
    : `Cannot reach ${proxyUrl}`;
}

// ════════════════════════════════
// SETTINGS — load & save
// ════════════════════════════════
chrome.storage.local.get(['bobApiKey', 'proxyUrl', 'proxySecret'], (r) => {
  if (r.bobApiKey)    apiKeyInput.value       = r.bobApiKey;
  if (r.proxyUrl)     proxyUrlInput.value     = r.proxyUrl;
  if (r.proxySecret)  proxySecretInput.value  = r.proxySecret;
});

saveSettingsBtn.addEventListener('click', () => {
  const key    = apiKeyInput.value.trim();
  const url    = proxyUrlInput.value.trim();
  const secret = proxySecretInput.value.trim();
  chrome.storage.local.set({ bobApiKey: key, proxyUrl: url || '', proxySecret: secret }, () => {
    saveSettingsBtn.textContent = 'Saved ✓';
    saveSettingsBtn.classList.add('saved');
    checkServerStatus();
    setTimeout(() => {
      saveSettingsBtn.textContent = 'Save Settings';
      saveSettingsBtn.classList.remove('saved');
    }, 2000);
  });
});

function renderWorkspaceList() {
  workspaceListEl.innerHTML = '';
  if (fbRootHandles.length === 0) {
    workspaceListEl.innerHTML = '<li style="color:var(--muted);font-size:12px;padding:4px 2px;">No folders added yet. Use the Files tab to grant folder access.</li>';
    return;
  }
  fbRootHandles.forEach(({ name }) => {
    const li = document.createElement('li');
    li.className = 'workspace-item';
    li.innerHTML = `<span title="${name}">📁 ${name}</span><button title="Remove">✕</button>`;
    li.querySelector('button').addEventListener('click', async () => {
      fbRootHandles = fbRootHandles.filter((h) => h.name !== name);
      await idbRemoveHandle(name);
      renderWorkspaceList();
      renderRootChips();
    });
    workspaceListEl.appendChild(li);
  });
}

// ════════════════════════════════
// FILE BROWSER — File System Access API
// ════════════════════════════════
async function initFileBrowser() {
  if (fbRootHandles.length === 0) {
    const saved = await idbLoadHandles().catch(() => []);
    for (const { name, handle } of saved) {
      const perm = await handle.queryPermission({ mode: 'read' });
      fbRootHandles.push({ name, handle, needsGrant: perm !== 'granted' });
    }
    renderWorkspaceList();
  }

  renderRootChips();

  if (fbStack.length === 0 && fbRootHandles.length > 0) {
    const first = fbRootHandles.find((h) => !h.needsGrant);
    if (first) {
      fbStack = [{ name: first.name, handle: first.handle }];
      await browseHandle(first.handle, first.name);
      return;
    }
  }

  if (fbRootHandles.length === 0) {
    fbList.innerHTML = `
      <div class="fb-empty">
        <div class="fb-empty-icon">📂</div>
        <div class="fb-empty-title">No folders added yet</div>
        <div class="fb-empty-sub">
          Click <strong>+ Add Folder</strong> above to grant Bob access<br>
          to any folder on your computer.<br><br>
          You can add your home folder <code>~/</code> to access everything.
        </div>
      </div>`;
    updateFbToolbar(null, false);
  }
}

function renderRootChips() {
  // Remember which root is currently active
  const activeRoot = fbStack.length > 0 ? fbStack[0].name : null;
  fbRoots.innerHTML = '';

  // "Add Folder" chip
  const addChip = document.createElement('button');
  addChip.className = 'fb-root-chip fb-root-add';
  addChip.textContent = '+ Add Folder';
  addChip.title = 'Grant Bob access to a folder on your computer (you can add your home folder ~/  for full access)';
  addChip.addEventListener('click', grantNewFolder);
  fbRoots.appendChild(addChip);

  // One chip per granted root
  fbRootHandles.forEach(({ name, handle, needsGrant }) => {
    const chip = document.createElement('button');
    chip.className = 'fb-root-chip'
      + (needsGrant ? ' needs-grant' : '')
      + (name === activeRoot ? ' active' : '');
    chip.textContent = (needsGrant ? '⚠ ' : '') + name;
    chip.title = needsGrant
      ? `Click to re-grant access to "${name}" (permissions reset on browser restart)`
      : name;
    chip.addEventListener('click', async () => {
      if (needsGrant) {
        const perm = await handle.requestPermission({ mode: 'read' });
        if (perm !== 'granted') return;
        const h = fbRootHandles.find((h) => h.name === name);
        if (h) h.needsGrant = false;
        renderRootChips();
      }
      // Clear search when switching roots
      fbSearch.value = '';
      fbStack = [{ name, handle }];
      await browseHandle(handle, name);
    });
    fbRoots.appendChild(chip);
  });
}

async function grantNewFolder() {
  let dirHandle;
  try {
    // No startIn restriction — user can pick any folder including ~/
    dirHandle = await window.showDirectoryPicker({ mode: 'read' });
  } catch (e) {
    if (e.name !== 'AbortError') console.warn('showDirectoryPicker:', e);
    return;
  }

  const name = dirHandle.name;
  if (!fbRootHandles.find((h) => h.name === name)) {
    fbRootHandles.push({ name, handle: dirHandle, needsGrant: false });
    await idbSaveHandle(name, dirHandle);
    renderWorkspaceList();
    renderRootChips();
  }

  fbSearch.value = '';
  fbStack = [{ name, handle: dirHandle }];
  await browseHandle(dirHandle, name);
}

async function browseHandle(dirHandle, displayName) {
  fbSelectedItem = null;
  fbAskBtn.style.display  = 'none';
  fbList.innerHTML = '<div class="fb-empty"><span class="spinner"></span></div>';

  try {
    const entries = [];
    for await (const [entryName, entryHandle] of dirHandle.entries()) {
      if (!fbShowHidden && entryName.startsWith('.')) continue;
      entries.push({ name: entryName, type: entryHandle.kind, handle: entryHandle });
    }

    // Sort: dirs first, then alphabetical (case-insensitive)
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    fbCurrentEntries = entries;
    renderFbList(entries);
    updateFbToolbar(displayName, fbStack.length > 1);
    fbFooterPath.textContent = fbStack.map((s) => s.name).join(' / ');

    // Apply current search filter if any
    const q = fbSearch.value.trim();
    if (q) applyFbFilter(q);

  } catch (err) {
    fbList.innerHTML = `<div class="fb-empty">⚠ ${err.message}</div>`;
    updateFbToolbar(displayName, fbStack.length > 1);
  }
}

function updateFbToolbar(displayName, canGoBack) {
  // Build clickable breadcrumb segments
  const parts = fbStack.length > 0 ? fbStack : (displayName ? [{ name: displayName }] : []);
  fbBreadcrumb.innerHTML = parts.map((seg, i) => {
    const isLast = i === parts.length - 1;
    return isLast
      ? `<span class="bc-seg bc-current">${seg.name}</span>`
      : `<span class="bc-seg bc-link" data-idx="${i}">${seg.name}</span><span class="bc-sep">/</span>`;
  }).join('') || '<span>—</span>';

  // Clickable breadcrumb navigation
  fbBreadcrumb.querySelectorAll('.bc-link').forEach((el) => {
    el.addEventListener('click', async () => {
      const idx = parseInt(el.dataset.idx);
      fbStack = fbStack.slice(0, idx + 1);
      fbSearch.value = '';
      const top = fbStack[fbStack.length - 1];
      if (top) await browseHandle(top.handle, top.name);
    });
  });

  fbBackBtn.disabled = !canGoBack;
  fbBackBtn.onclick = canGoBack ? async () => {
    fbSearch.value = '';
    fbStack.pop();
    const top = fbStack[fbStack.length - 1];
    if (top) await browseHandle(top.handle, top.name);
  } : null;
  // Highlight active root chip
  fbRoots.querySelectorAll('.fb-root-chip:not(.fb-root-add)').forEach((chip, i) => {
    const rootName = fbStack.length > 0 ? fbStack[0].name : null;
    chip.classList.toggle('active', fbRootHandles[i]?.name === rootName);
  });
}

function renderFbList(entries) {
  fbList.innerHTML = '';
  if (entries.length === 0) {
    fbList.innerHTML = '<div class="fb-empty"><div class="fb-empty-icon">📭</div><div class="fb-empty-title">Empty folder</div></div>';
    return;
  }

  entries.forEach((entry) => {
    const item = document.createElement('div');
    item.className = `fb-item ${entry.type === 'directory' ? 'dir' : 'file'}`;
    item.dataset.name = entry.name.toLowerCase();

    const icon = document.createElement('div');
    icon.className = 'fb-item-icon';
    icon.textContent = entry.type === 'directory' ? '📁' : getFileIcon(entry.name);

    const name = document.createElement('div');
    name.className = 'fb-item-name';
    name.textContent = entry.name;

    const meta = document.createElement('div');
    meta.className = 'fb-item-meta';

    item.appendChild(icon);
    item.appendChild(name);
    item.appendChild(meta);

    // Single click → select
    item.addEventListener('click', () => {
      document.querySelectorAll('.fb-item.selected').forEach((el) => el.classList.remove('selected'));
      if (fbSelectedItem?.name === entry.name) {
        fbSelectedItem = null;
        fbAskBtn.style.display = 'none';
        fbFooterPath.textContent = fbStack.map((s) => s.name).join(' / ');
      } else {
        item.classList.add('selected');
        fbSelectedItem = entry;
        fbFooterPath.textContent = [...fbStack.map((s) => s.name), entry.name].join(' / ');
        fbAskBtn.style.display = '';
      }
    });

    // Double click on dir → navigate in
    item.addEventListener('dblclick', () => {
      if (entry.type === 'directory') {
        fbSelectedItem = null;
        fbAskBtn.style.display = 'none';
        fbSearch.value = '';
        fbStack.push({ name: entry.name, handle: entry.handle });
        browseHandle(entry.handle, entry.name);
      }
    });

    // Async file size
    if (entry.type === 'file') {
      entry.handle.getFile().then((f) => { meta.textContent = formatBytes(f.size); }).catch(() => {});
    }

    fbList.appendChild(item);
  });
}

// ── Search / filter ──
fbSearch.addEventListener('input', () => {
  applyFbFilter(fbSearch.value.trim());
});

function applyFbFilter(query) {
  const q = query.toLowerCase();
  fbList.querySelectorAll('.fb-item').forEach((item) => {
    const match = !q || (item.dataset.name || '').includes(q);
    item.classList.toggle('filtered-out', !match);
  });
  // Deselect if filtered out
  if (q && fbSelectedItem && !fbSelectedItem.name.toLowerCase().includes(q)) {
    fbSelectedItem = null;
    fbAskBtn.style.display = 'none';
    fbFooterPath.textContent = fbStack.map((s) => s.name).join(' / ');
  }
}

// ── "Ask about this" ──
fbAskBtn.addEventListener('click', async () => {
  if (!fbSelectedItem) return;
  const origText = fbAskBtn.textContent;
  fbAskBtn.textContent = 'Loading…';
  fbAskBtn.disabled = true;

  try {
    let label, content;

    if (fbSelectedItem.type === 'file') {
      const file = await fbSelectedItem.handle.getFile();
      const MAX = 500_000;
      if (file.size > MAX) throw new Error(`File too large (${formatBytes(file.size)}). Max 500 KB.`);
      content = await file.text();
      label   = fbSelectedItem.name;
    } else {
      content = await buildTreeText(fbSelectedItem.handle, '', 0, 3);
      label   = fbSelectedItem.name + '/';
    }

    fileContext = {
      label,
      content,
      path: fbStack.map((s) => s.name).join('/') + '/' + fbSelectedItem.name,
      type: fbSelectedItem.type === 'directory' ? 'dir' : 'file',
    };

    showContextBar(`${label}`);

    // Switch to Chat tab
    tabs.forEach((t) => t.classList.remove('active'));
    Object.values(panels).forEach((p) => p.classList.remove('active'));
    document.querySelector('.tab[data-tab="chat"]').classList.add('active');
    panels.chat.classList.add('active');
    userInput.focus();
  } catch (err) {
    fbFooterPath.textContent = '⚠ ' + err.message;
  } finally {
    fbAskBtn.textContent = origText;
    fbAskBtn.disabled = false;
  }
});

// ── Build recursive tree text ──
async function buildTreeText(dirHandle, indent, depth, maxDepth) {
  let out = '';
  const IGNORED = new Set(['node_modules', '.git', '__pycache__', '.next', 'dist', 'build', '.cache', '.DS_Store', 'vendor', 'venv', '.venv']);
  try {
    const entries = [];
    for await (const [name, handle] of dirHandle.entries()) {
      if (name.startsWith('.') || IGNORED.has(name)) continue;
      entries.push({ name, handle });
    }
    entries.sort((a, b) => {
      const aDir = a.handle.kind === 'directory';
      const bDir = b.handle.kind === 'directory';
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    for (const { name, handle } of entries) {
      if (handle.kind === 'directory') {
        out += `${indent}${name}/\n`;
        if (depth < maxDepth) out += await buildTreeText(handle, indent + '  ', depth + 1, maxDepth);
      } else {
        out += `${indent}${name}\n`;
      }
    }
  } catch {}
  return out;
}

// ── Toggle hidden files ──
fbHiddenBtn.addEventListener('click', () => {
  fbShowHidden = !fbShowHidden;
  fbHiddenBtn.style.opacity = fbShowHidden ? '1' : '0.45';
  const top = fbStack[fbStack.length - 1];
  if (top) browseHandle(top.handle, top.name);
});

// ════════════════════════════════
// FILE UTILITIES
// ════════════════════════════════
function getFileIcon(name) {
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  const map = {
    'js':'📄','ts':'📄','jsx':'📄','tsx':'📄','mjs':'📄','cjs':'📄',
    'py':'🐍','go':'🔵','java':'☕','rb':'💎','rs':'🦀','cpp':'📄','c':'📄','cs':'📄',
    'json':'📋','yaml':'📋','yml':'📋','toml':'📋','xml':'📋',
    'md':'📝','txt':'📝','rst':'📝','log':'📝','csv':'📝',
    'html':'🌐','htm':'🌐','css':'🎨','scss':'🎨','sass':'🎨','less':'🎨',
    'sh':'⚙','bash':'⚙','zsh':'⚙','fish':'⚙','ps1':'⚙',
    'png':'🖼','jpg':'🖼','jpeg':'🖼','gif':'🖼','svg':'🖼','webp':'🖼','ico':'🖼',
    'pdf':'📕','docx':'📘','xlsx':'📗','pptx':'📙',
    'zip':'🗜','tar':'🗜','gz':'🗜','7z':'🗜','rar':'🗜',
    'env':'🔑','pem':'🔑','key':'🔑',
    'lock':'🔒','gitignore':'📋','dockerfile':'🐳',
    'mp4':'🎬','mov':'🎬','avi':'🎬','webm':'🎬',
    'mp3':'🎵','wav':'🎵','flac':'🎵',
  };
  return map[ext] || '📄';
}

function formatBytes(bytes) {
  if (bytes < 1024)           return bytes + ' B';
  if (bytes < 1024 * 1024)    return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ════════════════════════════════
// SESSIONS PANEL
// ════════════════════════════════
function renderSessionsPanel() {
  if (!sessionsFolderList) return;

  if (fbRootHandles.length === 0) {
    sessionsFolderList.innerHTML = `
      <div class="sessions-empty">
        <div class="sessions-empty-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M3 7a2 2 0 0 1 2-2h3.17a2 2 0 0 1 1.42.59L10.83 7H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
        </div>
        <div class="sessions-empty-title">No saved folders</div>
        <div class="sessions-empty-sub">Use "Pick Any Folder" above, or add folders in the Files tab to see them here.</div>
      </div>`;
    return;
  }

  sessionsFolderList.innerHTML = '';
  fbRootHandles.forEach(({ name, handle, needsGrant }) => {
    const item = document.createElement('div');
    item.className = 'sessions-folder-item';
    item.innerHTML = `
      <div class="sessions-folder-icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M3 7a2 2 0 0 1 2-2h3.17a2 2 0 0 1 1.42.59L10.83 7H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" stroke="var(--accent)" stroke-width="1.5" stroke-linejoin="round"/></svg>
      </div>
      <div class="sessions-folder-info">
        <div class="sessions-folder-name" title="${name}">${name}</div>
        <div class="sessions-folder-hint">${needsGrant ? '⚠ Re-grant needed' : 'Ready · click to start a session'}</div>
      </div>
      <div class="sessions-folder-actions">
        <button class="sessions-action-btn" data-action="browse" title="Browse files in this folder">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M2 4a1 1 0 0 1 1-1h2.5L6.5 5H13a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
          Files
        </button>
        <button class="sessions-action-btn primary" data-action="bob" title="Open Bob chat with this folder as context">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M2 3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H5l-4 3V3z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>
          Chat
        </button>
      </div>`;

    item.querySelector('[data-action="browse"]').addEventListener('click', async () => {
      if (needsGrant) {
        const perm = await handle.requestPermission({ mode: 'read' }).catch(() => 'denied');
        if (perm !== 'granted') { showToast('Permission denied', 'err'); return; }
        const h = fbRootHandles.find((r) => r.name === name);
        if (h) h.needsGrant = false;
        renderSessionsPanel();
      }
      tabs.forEach((t) => t.classList.remove('active'));
      Object.values(panels).forEach((p) => p.classList.remove('active'));
      document.querySelector('.tab[data-tab="files"]').classList.add('active');
      panels.files.classList.add('active');
      const root = fbRootHandles.find((h) => h.name === name);
      if (root) {
        fbSearch.value = '';
        fbStack = [{ name: root.name, handle: root.handle }];
        browseHandle(root.handle, root.name);
      }
    });

    item.querySelector('[data-action="bob"]').addEventListener('click', async () => {
      if (needsGrant) {
        const perm = await handle.requestPermission({ mode: 'read' }).catch(() => 'denied');
        if (perm !== 'granted') { showToast('Permission denied — re-grant the folder first', 'err'); return; }
        const h = fbRootHandles.find((r) => r.name === name);
        if (h) h.needsGrant = false;
      }
      await openBobSession(name, handle);
    });

    sessionsFolderList.appendChild(item);
  });
}

// Open Bob session: load folder tree into context and switch to Chat tab
async function openBobSession(folderName, handle) {
  let treeText = '';
  if (handle) {
    treeText = await buildTreeText(handle, '', 0, 2).catch(() => '');
  }

  fileContext = {
    label:   folderName + '/',
    content: treeText || `Folder: ${folderName}`,
    path:    folderName,
    type:    'dir',
  };
  showContextBar(`📁 ${folderName}/`);

  tabs.forEach((t) => t.classList.remove('active'));
  Object.values(panels).forEach((p) => p.classList.remove('active'));
  document.querySelector('.tab[data-tab="chat"]').classList.add('active');
  panels.chat.classList.add('active');

  showToast(`Session started: ${folderName}`, 'ok');
  userInput.focus();
}

// Sessions "Browse…" button → pick any folder and store it
sessionBrowseBtn.addEventListener('click', async () => {
  let dirHandle;
  try {
    dirHandle = await window.showDirectoryPicker({ mode: 'read' });
  } catch (e) {
    if (e.name !== 'AbortError') console.warn('showDirectoryPicker:', e);
    return;
  }

  const name = dirHandle.name;
  sessionPathInput.value = name;

  if (!fbRootHandles.find((h) => h.name === name)) {
    fbRootHandles.push({ name, handle: dirHandle, needsGrant: false });
    await idbSaveHandle(name, dirHandle);
    renderWorkspaceList();
    renderRootChips();
    renderSessionsPanel();
  }
});

// Sessions "Open Bob Session" button
sessionOpenBtn.addEventListener('click', async () => {
  const folderName = sessionPathInput.value.trim();
  if (!folderName) {
    showToast('Select a folder first using Browse…', 'err');
    return;
  }
  const root = fbRootHandles.find((h) => h.name === folderName);
  // If no saved handle, still open session with just the name
  await openBobSession(folderName, root?.handle || null);
});

function showToast(msg, type) {
  sessionsToast.textContent = msg;
  sessionsToast.className = `sessions-toast ${type}`;
  setTimeout(() => { sessionsToast.className = 'sessions-toast'; }, 3500);
}

// ════════════════════════════════
// CONTEXT BAR
// ════════════════════════════════
function showContextBar(text) {
  contextPill.textContent = text;
  contextBar.classList.add('visible');
}

clearContextBtn.addEventListener('click', () => {
  pageContext  = null;
  fileContext  = null;
  contextBar.classList.remove('visible');
  userInput.value = '';
});

// ════════════════════════════════
// CHAT — page context
// ════════════════════════════════
function getActiveTab() {
  return new Promise((resolve) =>
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, ([tab]) => resolve(tab || null))
  );
}

async function fetchPageContext() {
  const tab = await getActiveTab();
  if (!tab) return null;

  const ctx = await new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, { type: 'GET_CONTEXT' }, (response) => {
      if (chrome.runtime.lastError || !response) resolve(null);
      else resolve(response);
    });
  });
  if (ctx) return ctx;

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  } catch (_) { return null; }

  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, { type: 'GET_CONTEXT' }, (response) => {
      if (chrome.runtime.lastError || !response) resolve(null);
      else resolve(response);
    });
  });
}

function loadPageContext() {
  fetchPageContext().then((ctx) => {
    if (!ctx) return;
    pageContext = ctx;
    if (ctx.selectedText) {
      userInput.value = ctx.selectedText.slice(0, 200);
      userInput.setSelectionRange(0, userInput.value.length);
      showContextBar(`"${ctx.selectedText.slice(0, 60)}${ctx.selectedText.length > 60 ? '…' : ''}"`);
    } else if (ctx.pageTitle) {
      showContextBar(`Page: ${ctx.pageTitle}`);
    }
  });
}

function applyPendingSelection(selectedText) {
  chrome.storage.local.remove('pendingAskBob');
  fetchPageContext().then((ctx) => {
    pageContext = ctx || { selectedText: '', pageTitle: '', pageUrl: '', pageText: '' };
    pageContext.selectedText = selectedText;
    userInput.value = selectedText.slice(0, 200);
    userInput.setSelectionRange(0, userInput.value.length);
    showContextBar(`"${selectedText.slice(0, 60)}${selectedText.length > 60 ? '…' : ''}"`);
    userInput.focus();
  });
}

chrome.storage.local.get('pendingAskBob', (result) => {
  if (result.pendingAskBob?.selectedText) applyPendingSelection(result.pendingAskBob.selectedText);
  else loadPageContext();
});

// Initial proxy status check
checkServerStatus();

chrome.runtime.onMessage.addListener((req) => {
  if (req.type === 'ASK_BOB_SELECTION') applyPendingSelection(req.selectedText || '');
});

// ════════════════════════════════
// CHAT — input handling
// ════════════════════════════════
userInput.addEventListener('input', () => {
  userInput.style.height = 'auto';
  userInput.style.height = Math.min(userInput.scrollHeight, 120) + 'px';
});

userInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

sendBtn.addEventListener('click', sendMessage);

clearChatBtn.addEventListener('click', () => {
  messagesEl.innerHTML = '';
  chatHistory = [];
  appendMessage('assistant', 'Chat cleared. How can I help?', []);
});

// ════════════════════════════════
// CHAT — send / receive
// ════════════════════════════════

// Fetch all links from the active tab, return as a compact text block
async function fetchPageLinks() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'EXECUTE_ACTIONS', actions: [{ type: 'get_links' }] },
      (resp) => {
        const links = resp?.results?.[0]?.result;
        if (!Array.isArray(links) || links.length === 0) return resolve('');
        const lines = links
          .filter(l => l.href && l.text)
          .map(l => `- ${l.text.trim()} → ${l.href}`)
          .join('\n');
        resolve(lines);
      }
    );
  });
}

// Nav-intent keywords — if present, we inject page links into the prompt
const NAV_INTENT = /\b(navigate|go to|open|click|find|take me|show me|visit|tab|page|section|link|getting started|using|how to use)\b/i;

// Keywords that suggest the user wants to search/find something online
const SEARCH_INTENT = /\b(find|search|look up|look for|get|fetch|show me|open|go to|navigate|documentation|docs|tutorial|guide|how to|how do|what is|explain|help with|learn about|article|page|site|website)\b/i;

// Extract a clean search query from the user's raw message.
// Strips imperative openers like "find me", "search for", "can you look up" etc.
function extractSearchQuery(msg) {
  return msg
    .replace(/^(hey bob[,\s]*|bob[,\s]*)/i, '')
    .replace(/^(can you|could you|please|would you)[,\s]*/i, '')
    .replace(/^(find( me)?|search( for)?|look( up| for)?|get( me)?|show me|open|navigate to|go to|fetch)[,\s]*/i, '')
    .replace(/^(the |a |an )/i, '')
    .trim() || msg.trim();
}

// Called when the LLM is unreachable. Tries to do something useful based purely
// on keywords — no AI involved. If the message looks like a search/navigation
// request, fires a Google search directly. Otherwise shows the original error.
async function fallbackSearch(userText, originalError) {
  if (!SEARCH_INTENT.test(userText)) {
    appendError(originalError);
    return;
  }
  const query = extractSearchQuery(userText);
  appendMessage('assistant',
    `⚠️ *AI unavailable* (${originalError.split('\n')[0]})\n\nNo proxy configured — falling back to a Google search for: **${query}**`,
    []
  );
  await runBrowserActions([{ type: 'navigate_search', query }]);
}

async function sendMessage() {
  const text = userInput.value.trim();
  if (!text) return;

  lastUserMessage = text;
  appendMessage('user', text, []);
  userInput.value = '';
  userInput.style.height = 'auto';
  sendBtn.disabled = true;

  const typingEl = appendTyping();

  try {
    const freshCtx = await fetchPageContext();
    if (freshCtx) pageContext = freshCtx;

    // If the user wants to navigate somewhere on the current page, inject the page's
    // link list so the LLM has concrete URLs to emit in navigate actions
    let pageLinkContext = '';
    if (NAV_INTENT.test(text) && pageContext?.pageUrl) {
      const linkList = await fetchPageLinks();
      if (linkList) {
        pageLinkContext = `\n\n[PAGE LINKS — use these exact hrefs in navigate actions]\n${linkList}\n[END PAGE LINKS]`;
      }
    }

    const augmentedMessage = pageLinkContext ? text + pageLinkContext : text;

    const response = await Promise.race([
      new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { type: 'CHAT', userMessage: augmentedMessage, pageContext, fileContext, history: chatHistory },
          (resp) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(resp);
          }
        );
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Request timed out after 60s')), 60_000)),
    ]);

    typingEl.remove();

    if (!response) {
      appendError('No response from background worker. Try reloading the extension.');
    } else if (response.error) {
      // Proxy not configured or auth failure — try a dumb search fallback
      await fallbackSearch(text, response.error);
    } else {
      // Sanitize answer — strip any raw JSON objects the LLM accidentally put in the answer field
      const rawAnswer = response.answer || '(no answer)';
      const answer = sanitizeAnswer(rawAnswer);

      const browserActions = (response.actions || []).filter((a) => a.type && a.type !== 'url');
      const urlButtons     = (response.actions || []).filter((a) => !a.type || a.type === 'url');
      appendMessage('assistant', answer, urlButtons);
      if (browserActions.length > 0) await runBrowserActions(browserActions);

      // Record turn in history (store clean text without page context blobs)
      chatHistory.push({ role: 'user',      content: text });
      chatHistory.push({ role: 'assistant', content: answer });
      // Cap history at 20 messages (10 turns) to avoid token bloat
      if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);
    }
  } catch (err) {
    typingEl.remove();
    await fallbackSearch(text, err.message);
  } finally {
    sendBtn.disabled = false;
    userInput.focus();
  }
}

// Strip raw JSON objects/arrays the LLM sometimes leaks into the answer string.
// Handles both well-formed JSON and truncated/malformed responses.
function sanitizeAnswer(text) {
  if (!text) return text;
  const trimmed = text.trim();

  // Case 1: entire response is a JSON object (well-formed or truncated)
  if (trimmed.startsWith('{')) {
    // Try well-formed parse first
    if (trimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed.answer === 'string') return parsed.answer;
      } catch {}
    }
    // Regex fallback: extract "answer": "..." even from truncated/malformed JSON
    // Handles escaped quotes and multiline values
    const m = trimmed.match(/"answer"\s*:\s*"([\s\S]*)$/);
    if (m) {
      // Unescape the extracted string content
      return m[1]
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'")
        .replace(/\\\\/g, '\\')
        // strip trailing closing `"}` or `"` that may remain
        .replace(/"\s*,?\s*"actions"[\s\S]*$/, '')
        .replace(/"\s*\}\s*$/, '')
        .trim();
    }
  }

  // Case 2: starts with ```json fence wrapping the whole response
  const fenceMatch = trimmed.match(/^```(?:json)?\s*(\{[\s\S]*)/);
  if (fenceMatch) {
    return sanitizeAnswer(fenceMatch[1].replace(/```\s*$/, '').trim());
  }

  // Case 3: trailing ```json ... ``` blocks appended after real answer
  return text
    .replace(/\n*```json[\s\S]*?```\s*$/g, '')
    .replace(/\n*\{[\s\S]{0,2000}\}\s*$/g, (m) => {
      try { const p = JSON.parse(m); return p.answer ? '\n' + p.answer : ''; } catch { return m; }
    })
    .trim();
}

// ════════════════════════════════
// BROWSER AUTOMATION UI
// ════════════════════════════════

// Saved by sendMessage so the follow-up knows what the user originally asked
let lastUserMessage = '';

// Pause flag — set to true by the pause button to stop the agentic loop
let agentPaused = false;

// Keywords that indicate the user wants content from the page after navigation
const INFO_INTENT = /\b(summar|explain|tell me|what does|what is|describe|read|show me|how to|overview|detail|content|learn|understand|find out|what('s| is) on|about|guide|setup|install|document)\b/i;

function userWantsPageContent(msg) {
  return INFO_INTENT.test(msg);
}

// ── Agent progress card ──
function createProgressCard() {
  const card = document.createElement('div');
  card.className = 'agent-progress';
  card.innerHTML = `
    <span class="spinner-sm"></span>
    <span class="agent-progress-text">Researching…</span>
    <span class="agent-progress-sub"></span>
    <button class="pause-btn">⏸ Pause</button>`;

  const pauseBtn = card.querySelector('.pause-btn');
  pauseBtn.addEventListener('click', () => {
    agentPaused = !agentPaused;
    pauseBtn.textContent = agentPaused ? '▶ Resume' : '⏸ Pause';
    pauseBtn.classList.toggle('paused', agentPaused);
    card.querySelector('.agent-progress-text').textContent =
      agentPaused ? 'Paused — click Resume to continue' : 'Researching…';
  });

  return card;
}

function updateProgressCard(card, text, sub) {
  if (!card) return;
  const t = card.querySelector('.agent-progress-text');
  const s = card.querySelector('.agent-progress-sub');
  if (t && !agentPaused) t.textContent = text;
  if (s) s.textContent = sub || '';
}

function finaliseProgressCard(card, text) {
  if (!card) return;
  card.style.background = 'var(--surface)';
  card.style.borderColor = 'var(--border)';
  card.style.color = 'var(--muted)';
  const spinner = card.querySelector('.spinner-sm');
  if (spinner) spinner.replaceWith(Object.assign(document.createElement('span'), { textContent: '✓', style: 'font-size:11px;color:#16a34a;' }));
  const t = card.querySelector('.agent-progress-text');
  if (t) t.textContent = text;
  const s = card.querySelector('.agent-progress-sub');
  if (s) s.textContent = '';
  const btn = card.querySelector('.pause-btn');
  if (btn) btn.remove();
}

async function runBrowserActions(actions) {
  const wrapper = document.createElement('div');
  wrapper.className = 'action-steps';

  const hdr = document.createElement('div');
  hdr.className = 'action-steps-header';
  hdr.textContent = `Running ${actions.length} action${actions.length !== 1 ? 's' : ''}`;
  wrapper.appendChild(hdr);

  const stepEls = actions.map((action) => {
    const row    = document.createElement('div');
    row.className = 'action-step running';
    const icon   = document.createElement('span');
    icon.className = 'step-icon';
    icon.innerHTML = '<span class="spinner-sm"></span>';
    const label  = document.createElement('span');
    label.className = 'step-label';
    label.textContent = describeAction(action);
    const detail = document.createElement('span');
    detail.className = 'step-detail';
    row.appendChild(icon); row.appendChild(label); row.appendChild(detail);
    wrapper.appendChild(row);
    return { row, icon, detail };
  });

  messagesEl.appendChild(wrapper);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  // Execute all actions sequentially and wait
  const results = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'EXECUTE_ACTIONS', actions }, (resp) => {
      resolve(resp?.results || []);
    });
  });

  // Update step indicators
  results.forEach((r, i) => {
    const els = stepEls[i];
    if (!els) return;
    if (r.ok) {
      els.row.className = 'action-step done';
      els.icon.textContent = '✓';
      if (typeof r.result === 'string') els.detail.textContent = r.result.slice(0, 90);
      else if (Array.isArray(r.result)) els.detail.textContent = `${r.result.length} items`;
    } else {
      els.row.className = 'action-step failed';
      els.icon.textContent = '✗';
      els.detail.textContent = r.error?.slice(0, 90) || 'Failed';
    }
  });
  for (let i = results.length; i < stepEls.length; i++) {
    stepEls[i].row.className = 'action-step skipped';
    stepEls[i].icon.textContent = '—';
    stepEls[i].detail.textContent = 'skipped';
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;

  // ── Read-then-answer ──
  // Conditions: user asked for info AND the actions included navigation/click
  // AND the last action wasn't already get_page_text (avoid double-read)
  const hasNavOrClick = actions.some(a =>
    ['navigate','navigate_search','click','open_link','new_tab'].includes(a.type)
  );
  const lastActionType = actions[actions.length - 1]?.type;
  const allActionsOk   = results.length > 0 && results.every(r => r.ok);
  const alreadyRead    = lastActionType === 'get_page_text';

  if (hasNavOrClick && allActionsOk && !alreadyRead && userWantsPageContent(lastUserMessage)) {
    await readPageAndAnswer();
  }
}

// ── Full multi-step agentic research loop ──
// Up to MAX_AGENT_STEPS iterations. Each step:
//   1. Read page text
//   2. Ask LLM: "do you have enough to answer, or navigate further?"
//   3. If LLM emits navigate action → execute it, loop
//   4. If no actions → emit final answer, done
// The pause button suspends the loop; resume continues.
const MAX_AGENT_STEPS = 6;
let agentRunning = false; // re-entrancy guard

async function readPageAndAnswer() {
  if (agentRunning) return; // prevent re-entrancy
  agentRunning = true;
  agentPaused  = false;
  sendBtn.disabled = true;

  const card = createProgressCard();
  messagesEl.appendChild(card);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  try {
    for (let step = 0; step < MAX_AGENT_STEPS; step++) {
      // ── Pause check ──
      if (agentPaused) {
        await new Promise((resolve) => {
          const interval = setInterval(() => {
            if (!agentPaused) { clearInterval(interval); resolve(); }
          }, 300);
        });
      }

      updateProgressCard(card, `Reading page… (step ${step + 1}/${MAX_AGENT_STEPS})`, '');

      // Wait for page to settle on first step
      if (step === 0) await new Promise(r => setTimeout(r, 800));

      // Read current page text
      const pageTextResp = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          { type: 'EXECUTE_ACTIONS', actions: [{ type: 'get_page_text' }] },
          (resp) => resolve(resp?.results?.[0] || null)
        );
      });

      if (!pageTextResp?.ok || !pageTextResp.result) {
        finaliseProgressCard(card, 'Could not read page');
        appendError('Could not read page content after navigation.');
        return;
      }

      const pageText = pageTextResp.result;
      const freshCtx = await fetchPageContext();
      if (freshCtx) pageContext = freshCtx;

      const pageLabel = freshCtx?.pageTitle
        ? `"${freshCtx.pageTitle}" (${freshCtx.pageUrl})`
        : 'the current page';

      updateProgressCard(card, `Analysing ${pageLabel}…`, `Step ${step + 1} of ${MAX_AGENT_STEPS}`);

      // Build the research prompt
      const researchPrompt =
        `The user asked: "${lastUserMessage}"\n\n` +
        `You are on step ${step + 1} of ${MAX_AGENT_STEPS}. You are on ${pageLabel}.\n\n` +
        `Page content:\n${pageText.slice(0, 6000)}\n\n` +
        (step < MAX_AGENT_STEPS - 1
          ? `If this page has enough information to answer the user's question, ` +
            `respond with your answer and set "actions" to [].\n` +
            `If you need to navigate to a more specific page to answer, emit ONE navigate action and leave "answer" empty or say "Navigating…".\n` +
            `Do NOT emit more than one navigate action per step.`
          : `This is your LAST step. You MUST answer now based on what you've found. Set "actions" to [].`
        );

      // Pause check before LLM call
      if (agentPaused) {
        await new Promise((resolve) => {
          const interval = setInterval(() => {
            if (!agentPaused) { clearInterval(interval); resolve(); }
          }, 300);
        });
      }

      updateProgressCard(card, `Thinking… (step ${step + 1})`, pageLabel);

      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { type: 'CHAT', userMessage: researchPrompt, pageContext, fileContext, history: chatHistory },
          (resp) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(resp);
          }
        );
      });

      if (response?.error) {
        finaliseProgressCard(card, 'Error');
        appendError(response.error);
        return;
      }

      const answer = sanitizeAnswer(response?.answer || '');
      const navActions = (response?.actions || []).filter(a =>
        ['navigate', 'navigate_search', 'new_tab', 'open_link'].includes(a.type)
      );

      // If there's a real substantive answer with no navigation → done
      const hasAnswer = answer && answer.trim() && !/^(navigating|going|loading|opening)/i.test(answer.trim());
      if (hasAnswer && navActions.length === 0) {
        finaliseProgressCard(card, `Done after ${step + 1} step${step !== 0 ? 's' : ''}`);
        appendMessage('assistant', answer, []);
        chatHistory.push({ role: 'assistant', content: answer });
        if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);
        return;
      }

      // If there's a nav action, execute it and loop
      if (navActions.length > 0) {
        updateProgressCard(card, `Navigating… (step ${step + 1})`, navActions[0].url || navActions[0].query || '');
        await new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: 'EXECUTE_ACTIONS', actions: [navActions[0]] }, () => resolve());
        });
        continue; // next step reads the new page
      }

      // No nav, no answer — break and output whatever we have
      if (answer) {
        finaliseProgressCard(card, `Done (step ${step + 1})`);
        appendMessage('assistant', answer, []);
        chatHistory.push({ role: 'assistant', content: answer });
        if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);
      }
      return;
    }

    // Exhausted all steps without a clean answer — run one final forced pass
    updateProgressCard(card, 'Wrapping up…', '');
    const pageTextResp = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'EXECUTE_ACTIONS', actions: [{ type: 'get_page_text' }] },
        (resp) => resolve(resp?.results?.[0] || null)
      );
    });
    const finalCtx = await fetchPageContext();
    if (finalCtx) pageContext = finalCtx;
    const finalPrompt =
      `The user asked: "${lastUserMessage}"\n\n` +
      `You have now visited several pages. Here is the last page content:\n` +
      `${pageTextResp?.result?.slice(0, 5000) || '(unavailable)'}\n\n` +
      `Provide the best answer you can. Set "actions" to [].`;
    const finalResp = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: 'CHAT', userMessage: finalPrompt, pageContext, fileContext, history: chatHistory },
        (resp) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(resp);
        }
      );
    });
    finaliseProgressCard(card, `Done after ${MAX_AGENT_STEPS} steps`);
    const finalAnswer = sanitizeAnswer(finalResp?.answer || '(no answer)');
    appendMessage('assistant', finalAnswer, []);
    chatHistory.push({ role: 'assistant', content: finalAnswer });
    if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);

  } catch (err) {
    finaliseProgressCard(card, 'Error');
    appendError(err.message);
  } finally {
    agentRunning = false;
    agentPaused  = false;
    sendBtn.disabled = false;
    userInput.focus();
  }
}

function describeAction(action) {
  switch (action.type) {
    case 'navigate':        return `Go to ${action.url}`;
    case 'navigate_search': return `Search: "${action.query}"`;
    case 'new_tab':         return `Open new tab${action.url ? ': ' + action.url : ''}`;
    case 'close_tab':       return 'Close current tab';
    case 'go_back':         return 'Go back';
    case 'go_forward':      return 'Go forward';
    case 'reload':          return 'Reload page';
    case 'duplicate_tab':   return 'Duplicate tab';
    case 'pin_tab':         return 'Pin/unpin tab';
    case 'list_tabs':       return 'List open tabs';
    case 'switch_tab':      return `Switch to tab: "${action.title || action.index}"`;
    case 'bookmark':        return 'Bookmark this page';
    case 'click':           return `Click: "${action.selector}"`;
    case 'fill':            return `Fill "${action.selector}" → "${action.value}"`;
    case 'press_key':       return `Press ${action.key || 'Enter'}`;
    case 'scroll':          return `Scroll ${action.direction || 'down'}`;
    case 'open_link':       return `Click link: "${action.label}"`;
    case 'extract':         return `Extract: "${action.selector || 'body'}"`;
    case 'get_links':       return 'Get page links';
    case 'get_page_text':   return 'Read page text';
    default:                return `Action: ${action.type}`;
  }
}

// ════════════════════════════════
// MARKDOWN RENDERER
// Supports: **bold**, *italic*, ~~strike~~, `code`, ```fences```,
//           # ## ### headings, - / * bullets, 1. numbered, ---,
//           GFM tables (| col | col |)
// ════════════════════════════════
function renderMarkdown(text) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // ── Inline formatter (declared first — used by table extraction too) ──
  const inlineFmt = (s) => {
    s = esc(s);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__(.+?)__/g, '<strong>$1</strong>');
    s = s.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
    s = s.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, '<em>$1</em>');
    s = s.replace(/~~(.+?)~~/g, '<del>$1</del>');
    return s;
  };

  // ── Step 1: extract code fences so their content is never processed ──
  const fences = [];
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const idx = fences.length;
    fences.push({ lang: lang || '', code: code.trim() });
    return `\x00FENCE${idx}\x00`;
  });

  // ── Step 2: extract GFM tables ──
  const tables = [];
  text = text.replace(
    /((?:\|.+\|\r?\n)+\|[\s:|-]+\|\r?\n(?:\|.+\|\r?\n?)*)/g,
    (block) => {
      const rows = block.trim().split('\n').map(r => r.trim());
      const parseCells = (row) =>
        row.replace(/^\||\|$/g, '').split('|').map(c => c.trim());

      const header = parseCells(rows[0]);
      const body   = rows.slice(2).filter(r => r.startsWith('|'));

      let thtml = '<div class="md-table-wrap"><table class="md-table"><thead><tr>';
      header.forEach(h => { thtml += `<th>${inlineFmt(h)}</th>`; });
      thtml += '</tr></thead><tbody>';
      body.forEach(row => {
        const cells = parseCells(row);
        thtml += '<tr>';
        cells.forEach(c => { thtml += `<td>${inlineFmt(c)}</td>`; });
        thtml += '</tr>';
      });
      thtml += '</tbody></table></div>';

      const idx = tables.length;
      tables.push(thtml);
      return `\x00TABLE${idx}\x00`;
    }
  );

  const lines = text.split('\n');
  let html = '', inOl = false, inUl = false;

  const closeList = () => {
    if (inOl) { html += '</ol>'; inOl = false; }
    if (inUl) { html += '</ul>'; inUl = false; }
  };

  for (const raw of lines) {
    const trimmed = raw.trim();

    // Fence placeholder
    if (trimmed.startsWith('\x00FENCE') && trimmed.endsWith('\x00')) {
      const idx = parseInt(trimmed.slice(6, -1));
      const { lang, code } = fences[idx];
      closeList();
      const langLabel = lang || 'code';
      html += `<div class="code-block-header" data-code-idx="${idx}"><span>${esc(langLabel)}</span><button class="code-copy-btn">Copy</button></div>`;
      html += `<pre class="code-block">${esc(code)}</pre>`;
      continue;
    }

    // Table placeholder
    if (trimmed.startsWith('\x00TABLE') && trimmed.endsWith('\x00')) {
      const idx = parseInt(trimmed.slice(6, -1));
      closeList();
      html += tables[idx];
      continue;
    }

    // Headings — h1/h2 become h3, h3/h4 become h4 (keeps hierarchy in small sidebar)
    const h4m = trimmed.match(/^####\s+(.+)/);
    if (h4m) { closeList(); html += `<h4>${inlineFmt(h4m[1])}</h4>`; continue; }
    const h3m = trimmed.match(/^###\s+(.+)/);
    if (h3m) { closeList(); html += `<h4>${inlineFmt(h3m[1])}</h4>`; continue; }
    const h2m = trimmed.match(/^##\s+(.+)/);
    if (h2m) { closeList(); html += `<h3>${inlineFmt(h2m[1])}</h3>`; continue; }
    const h1m = trimmed.match(/^#\s+(.+)/);
    if (h1m) { closeList(); html += `<h3>${inlineFmt(h1m[1])}</h3>`; continue; }

    // HR — must be 3+ dashes/stars/underscores only (not list items)
    if (/^[-*_]{3,}$/.test(trimmed)) { closeList(); html += '<hr>'; continue; }

    // Ordered list
    const olMatch = trimmed.match(/^(\d+)[.)]\s+(.+)/);
    if (olMatch) {
      if (!inOl) { closeList(); html += '<ol>'; inOl = true; }
      html += `<li>${inlineFmt(olMatch[2])}</li>`;
      continue;
    }

    // Unordered list
    const ulMatch = trimmed.match(/^[-*+]\s+(.+)/);
    if (ulMatch) {
      if (!inUl) { closeList(); html += '<ul>'; inUl = true; }
      html += `<li>${inlineFmt(ulMatch[1])}</li>`;
      continue;
    }

    // Blank line — section break
    if (trimmed === '') { closeList(); html += '<div class="md-spacer"></div>'; continue; }

    closeList();
    html += `<p>${inlineFmt(trimmed)}</p>`;
  }

  closeList();
  return html
    .replace(/^(<div class="md-spacer"><\/div>)+/, '')
    .replace(/(<div class="md-spacer"><\/div>)+$/, '')
    .replace(/(<div class="md-spacer"><\/div>){2,}/g, '<div class="md-spacer"></div>');
}

// ════════════════════════════════
// CHAT — message rendering
// ════════════════════════════════
function formatTime() {
  const d = new Date();
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function appendMessage(role, text, actions) {
  const wrapper = document.createElement('div');
  wrapper.className = `message ${role}`;

  const meta = document.createElement('div');
  meta.className = 'message-meta';
  meta.textContent = role === 'user' ? `You · ${formatTime()}` : `Bob · ${formatTime()}`;
  wrapper.appendChild(meta);

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  if (role === 'assistant') {
    bubble.innerHTML = renderMarkdown(text);
    // Code block copy buttons (event delegation — CSP-safe)
    bubble.querySelectorAll('.code-copy-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const header = btn.closest('.code-block-header');
        const pre    = header?.nextElementSibling;
        if (pre) {
          navigator.clipboard.writeText(pre.textContent).then(() => {
            btn.textContent = 'Copied!';
            setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
          });
        }
      });
    });
    // Bubble copy button
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      });
    });
    bubble.appendChild(copyBtn);
  } else {
    bubble.textContent = text;
  }

  wrapper.appendChild(bubble);

  if (actions?.length > 0) {
    const row = document.createElement('div');
    row.className = 'actions-row';
    actions.forEach((action) => {
      const btn = document.createElement('button');
      btn.className = 'action-btn';
      btn.textContent = action.label;
      btn.addEventListener('click', () => { if (action.url) chrome.tabs.create({ url: action.url }); });
      row.appendChild(btn);
    });
    wrapper.appendChild(row);
  }

  messagesEl.appendChild(wrapper);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return wrapper;
}

function appendTyping() {
  const wrapper = document.createElement('div');
  wrapper.className = 'message assistant';
  wrapper.innerHTML = `<div class="message-meta">Bob · thinking…</div><div class="typing"><span></span><span></span><span></span></div>`;
  messagesEl.appendChild(wrapper);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return wrapper;
}

function appendError(msg) {
  const el = document.createElement('div');
  el.className = 'error-bubble';
  el.textContent = '⚠ ' + msg;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}
