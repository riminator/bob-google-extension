// local-server/server.js
// Run with: node server.js
// Exposes the local file system to the Chrome extension via HTTP on port 3333.
// Also proxies LLM calls to Bob Inference API to avoid CORS/MV3 issues.

const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const { execSync, exec } = require('child_process');
const cors     = require('cors');

const app  = express();
const PORT = 3333;

// ── Config — edit these or set as environment variables ──
const BOB_API_URL     = process.env.BOB_API_URL     || 'https://api.us-east.bob.ibm.com/inference/v1/chat/completions';
const BOB_API_KEY     = process.env.BOB_API_KEY     || '';
const BOB_MODEL       = process.env.BOB_MODEL       || 'premium-shell';
const BOB_INSTANCE_ID = process.env.BOB_INSTANCE_ID || '';
const BOB_TEAM_ID     = process.env.BOB_TEAM_ID     || '';
const BOB_KEY_TYPE    = process.env.BOB_KEY_TYPE    || 'inference'; // 'inference' or 'general'

// ── Middleware ──
app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Helpers ──
function safePath(inputPath) {
  return path.resolve(inputPath);
}

const IGNORED = new Set([
  'node_modules', '.git', '.DS_Store', '__pycache__', '.next',
  'dist', 'build', '.cache', 'coverage', '.venv', 'venv',
]);

function buildTree(dirPath, depth = 0, maxDepth = 3) {
  if (depth > maxDepth) return [];
  let entries;
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((e) => !IGNORED.has(e.name) && !e.name.startsWith('.'))
    .map((e) => {
      const fullPath = path.join(dirPath, e.name);
      if (e.isDirectory()) {
        return {
          name: e.name,
          type: 'dir',
          path: fullPath,
          children: depth < maxDepth ? buildTree(fullPath, depth + 1, maxDepth) : [],
        };
      }
      let size = 0;
      try { size = fs.statSync(fullPath).size; } catch {}
      return { name: e.name, type: 'file', path: fullPath, size };
    });
}

// ── GET /health ──
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '2.0.0', llmConfigured: !!BOB_API_KEY });
});

// ── POST /chat ── (LLM proxy)
app.post('/chat', async (req, res) => {
  const { messages, apiKey } = req.body || {};
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  const key = apiKey || BOB_API_KEY;
  if (!key) {
    return res.status(401).json({
      error: 'No API key configured. Set BOB_API_KEY env var when starting the server, or enter it in the extension settings.',
    });
  }

  try {
    const authPrefix = BOB_KEY_TYPE === 'general' ? 'Bearer' : 'Apikey';
    const headers = {
      'Authorization': `${authPrefix} ${key}`,
      'Content-Type': 'application/json',
      'User-Agent': 'bobshell/1.0.6',
      'x-instance-id': BOB_INSTANCE_ID,
      'x-team-id': BOB_TEAM_ID,
    };

    const response = await fetch(BOB_API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: BOB_MODEL,
        messages,
        temperature: 0.3,
        max_tokens: 1024,
      }),
    });

    const text = await response.text();

    if (!response.ok) {
      console.error(`LLM API error ${response.status}:`, text.slice(0, 300));
      return res.status(response.status).json({
        error: `LLM API returned ${response.status}: ${text.slice(0, 200)}`,
      });
    }

    let llmJson;
    try { llmJson = JSON.parse(text); }
    catch { return res.status(502).json({ error: 'LLM returned non-JSON: ' + text.slice(0, 200) }); }

    const raw = llmJson.choices?.[0]?.message?.content || '{}';

    let parsed;
    try {
      const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, raw];
      parsed = JSON.parse(jsonMatch[1].trim());
    } catch {
      parsed = { answer: raw, actions: [] };
    }

    res.json(parsed);
  } catch (err) {
    console.error('Fetch to LLM failed:', err.message);
    res.status(502).json({ error: `Could not reach LLM API: ${err.message}` });
  }
});

// ── GET /fs/roots ── (list filesystem roots / home directory)
// Returns top-level entry points: home dir + common locations
app.get('/fs/roots', (_req, res) => {
  const home = os.homedir();
  const platform = os.platform();

  const roots = [];

  // Always include home
  roots.push({ name: '~  Home', path: home, type: 'dir' });

  // Common directories under home
  for (const sub of ['Desktop', 'Documents', 'Downloads', 'Projects', 'code', 'dev', 'src', 'workspace']) {
    const p = path.join(home, sub);
    if (fs.existsSync(p)) roots.push({ name: sub, path: p, type: 'dir' });
  }

  // Filesystem root
  if (platform === 'win32') {
    // On Windows list drive letters
    try {
      const drives = execSync('wmic logicaldisk get name', { timeout: 3000 }).toString()
        .split('\n').map(s => s.trim()).filter(s => /^[A-Z]:$/.test(s));
      for (const d of drives) roots.push({ name: d + '\\', path: d + '\\', type: 'dir' });
    } catch {}
  } else {
    roots.push({ name: '/ Root filesystem', path: '/', type: 'dir' });
  }

  res.json({ roots, home });
});

// ── POST /fs/browse ── (browse any directory, one level)
// Body: { path: "/some/dir", showHidden?: false }
// Returns: { entries: [...], path, parent }
app.post('/fs/browse', (req, res) => {
  const { path: inputPath, showHidden = false } = req.body || {};
  if (!inputPath) return res.status(400).json({ error: 'path is required' });

  const dirPath = safePath(inputPath);

  if (!fs.existsSync(dirPath)) {
    return res.status(404).json({ error: `Path not found: ${dirPath}` });
  }
  if (!fs.statSync(dirPath).isDirectory()) {
    return res.status(400).json({ error: `Not a directory: ${dirPath}` });
  }

  let rawEntries;
  try {
    rawEntries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (err) {
    return res.status(403).json({ error: `Cannot read directory: ${err.message}` });
  }

  const entries = rawEntries
    .filter((e) => showHidden || !e.name.startsWith('.'))
    .map((e) => {
      const fullPath = path.join(dirPath, e.name);
      const isDir = e.isDirectory();
      let size = 0;
      let mtime = null;
      try {
        const stat = fs.statSync(fullPath);
        size = stat.size;
        mtime = stat.mtime.toISOString();
      } catch {}
      return {
        name: e.name,
        type: isDir ? 'dir' : 'file',
        path: fullPath,
        size,
        mtime,
        ext: isDir ? null : path.extname(e.name).toLowerCase(),
      };
    })
    .sort((a, b) => {
      // Dirs first, then alphabetical
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

  const parent = dirPath === path.parse(dirPath).root ? null : path.dirname(dirPath);
  res.json({ entries, path: dirPath, parent });
});

// ── POST /list-files ── (tree listing, kept for backward compat)
app.post('/list-files', (req, res) => {
  const { path: inputPath, maxDepth = 3 } = req.body || {};
  if (!inputPath) return res.status(400).json({ error: 'path is required' });

  const dirPath = safePath(inputPath);

  if (!fs.existsSync(dirPath)) {
    return res.status(404).json({ error: `Path not found: ${dirPath}` });
  }
  if (!fs.statSync(dirPath).isDirectory()) {
    return res.status(400).json({ error: `Not a directory: ${dirPath}` });
  }

  const tree = buildTree(dirPath, 0, Math.min(maxDepth, 6));
  res.json({ tree, root: dirPath });
});

// ── POST /read-file ──
app.post('/read-file', (req, res) => {
  const { path: inputPath } = req.body || {};
  if (!inputPath) return res.status(400).json({ error: 'path is required' });

  const filePath = safePath(inputPath);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: `File not found: ${filePath}` });
  }
  if (!fs.statSync(filePath).isFile()) {
    return res.status(400).json({ error: `Not a file: ${filePath}` });
  }

  const MAX_BYTES = 500_000;
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_BYTES) {
    return res.status(413).json({ error: `File too large (${stat.size} bytes). Max 500 KB.` });
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    res.json({ content, size: stat.size, path: filePath });
  } catch (err) {
    res.status(500).json({ error: `Failed to read file: ${err.message}` });
  }
});

// ── POST /search-workspace ──
app.post('/search-workspace', (req, res) => {
  const { path: inputPath, query, maxResults = 20 } = req.body || {};
  if (!inputPath) return res.status(400).json({ error: 'path is required' });
  if (!query)     return res.status(400).json({ error: 'query is required' });

  const dirPath = safePath(inputPath);
  if (!fs.existsSync(dirPath)) {
    return res.status(404).json({ error: `Path not found: ${dirPath}` });
  }

  const matches = [];

  try {
    const escapedQuery = query.replace(/['"\\]/g, '\\$&');
    const grepCmd = `grep -rn --include="*.{js,ts,jsx,tsx,py,go,java,rb,md,txt,json,yaml,yml,sh,css,html,env}" -i -m 3 "${escapedQuery}" "${dirPath}" 2>/dev/null | head -${maxResults * 3}`;
    const output = execSync(grepCmd, { maxBuffer: 1024 * 1024, timeout: 8000 }).toString();
    const lines = output.split('\n').filter(Boolean);
    for (const line of lines) {
      const colonIdx  = line.indexOf(':');
      const colonIdx2 = line.indexOf(':', colonIdx + 1);
      if (colonIdx === -1 || colonIdx2 === -1) continue;
      const file    = line.slice(0, colonIdx);
      const lineNum = parseInt(line.slice(colonIdx + 1, colonIdx2), 10);
      const snippet = line.slice(colonIdx2 + 1).trim().slice(0, 200);
      if (!isNaN(lineNum) && snippet) {
        matches.push({ file: path.relative(dirPath, file), absolutePath: file, line: lineNum, snippet });
      }
      if (matches.length >= maxResults) break;
    }
  } catch (_) {
    jsSearch(dirPath, query, matches, maxResults);
  }

  res.json({ matches, total: matches.length, query, root: dirPath });
});

// ── POST /open-bob ── (launch Bob in a specific folder)
// Body: { path: "/absolute/folder", mode?: "agent" }
// Opens a new terminal window running `bob` in the given directory (macOS/Linux).
app.post('/open-bob', (req, res) => {
  const { path: inputPath, mode = 'agent' } = req.body || {};
  if (!inputPath) return res.status(400).json({ error: 'path is required' });

  const dirPath = safePath(inputPath);
  if (!fs.existsSync(dirPath)) {
    return res.status(404).json({ error: `Path not found: ${dirPath}` });
  }
  if (!fs.statSync(dirPath).isDirectory()) {
    return res.status(400).json({ error: `Not a directory: ${dirPath}` });
  }

  const platform = os.platform();

  if (platform === 'darwin') {
    // Pass the script via a temp file to avoid all shell-quoting issues
    const tmpScript = path.join(os.tmpdir(), 'bob_open.applescript');
    const safeDir = dirPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    fs.writeFileSync(tmpScript,
      `tell application "Terminal"\n  activate\n  do script "cd \\"${safeDir}\\" && bob"\nend tell\n`
    );
    exec(`osascript "${tmpScript}"`, (err) => {
      try { fs.unlinkSync(tmpScript); } catch {}
      if (err) {
        console.error('open-bob error:', err.message);
        return res.status(500).json({ error: `Failed to open terminal: ${err.message}` });
      }
      res.json({ ok: true, path: dirPath, message: `Bob launched in ${dirPath}` });
    });
  } else if (platform === 'linux') {
    const terminals = ['gnome-terminal', 'xterm', 'konsole', 'xfce4-terminal'];
    let cmd = null;
    for (const term of terminals) {
      try {
        execSync(`which ${term}`, { timeout: 1000 });
        if (term === 'gnome-terminal') {
          cmd = `${term} --working-directory=${JSON.stringify(dirPath)} -- bash -c "bob; exec bash"`;
        } else {
          cmd = `${term} -e ${JSON.stringify(`bash -c 'cd ${JSON.stringify(dirPath)} && bob; exec bash'`)}`;
        }
        break;
      } catch {}
    }
    if (!cmd) return res.status(500).json({ error: 'No terminal emulator found (tried gnome-terminal, xterm, konsole, xfce4-terminal).' });
    exec(cmd, (err) => {
      if (err) return res.status(500).json({ error: `Failed to open terminal: ${err.message}` });
      res.json({ ok: true, path: dirPath, message: `Bob launched in ${dirPath}` });
    });
  } else if (platform === 'win32') {
    const cmd = `start cmd /k "cd /d "${dirPath}" && bob"`;
    exec(cmd, (err) => {
      if (err) return res.status(500).json({ error: `Failed to open terminal: ${err.message}` });
      res.json({ ok: true, path: dirPath, message: `Bob launched in ${dirPath}` });
    });
  } else {
    res.status(500).json({ error: `Unsupported platform: ${platform}` });
  }
});

// Pure-JS fallback search
const TEXT_EXTENSIONS = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.java', '.rb',
  '.md', '.txt', '.json', '.yaml', '.yml', '.sh', '.css', '.html',
]);

function jsSearch(dirPath, query, results, maxResults) {
  if (results.length >= maxResults) return;
  let entries;
  try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); }
  catch { return; }

  for (const entry of entries) {
    if (IGNORED.has(entry.name) || entry.name.startsWith('.')) continue;
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      jsSearch(fullPath, query, results, maxResults);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!TEXT_EXTENSIONS.has(ext)) continue;
      try {
        const stat = fs.statSync(fullPath);
        if (stat.size > 500_000) continue;
        const content = fs.readFileSync(fullPath, 'utf8');
        const lines   = content.split('\n');
        const lq      = query.toLowerCase();
        lines.forEach((line, i) => {
          if (results.length >= maxResults) return;
          if (line.toLowerCase().includes(lq)) {
            results.push({
              file: path.relative(dirPath, fullPath),
              absolutePath: fullPath,
              line: i + 1,
              snippet: line.trim().slice(0, 200),
            });
          }
        });
      } catch {}
    }
    if (results.length >= maxResults) return;
  }
}

// ── Start server ──
app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n✅  Bob local server v2.0 running at http://127.0.0.1:${PORT}`);
  console.log(`   Endpoints: /health  /fs/roots  /fs/browse  /list-files  /read-file  /search-workspace  /open-bob\n`);
});
