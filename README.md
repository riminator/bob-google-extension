# Bob Browser Extension

AI-powered Chrome sidebar extension that reads page context, calls the Bob Inference API, and can answer questions about local files.

---

## Project Structure

```
extension/          ← Chrome extension (load unpacked in Chrome)
  manifest.json
  content.js        ← captures selected text + page context
  background.js     ← LLM calls, local server bridge
  sidebar.html      ← chat UI
  sidebar.js        ← renders responses + action buttons

local-server/       ← Node.js file system bridge (run locally)
  server.js
  package.json
```

---

## Quick Start

### 1. Install and run the local server

```bash
cd local-server
npm install
node server.js
# → Bob local file server running at http://127.0.0.1:3333
```

### 2. Load the extension in Chrome

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked** → select the `extension/` folder
4. The **Bob Assistant** extension will appear in your toolbar

### 3. Configure your API key

1. Click the Bob Assistant icon to open the sidebar
2. Go to the **Settings** tab
3. Paste your Bob Inference API key
4. Optionally add local workspace folder paths (e.g. `/Users/you/projects/myapp`)
5. Click **Save Settings**

---

## Usage

| Action | How |
|--------|-----|
| Summarize highlighted text | Select text on any page → click extension icon → type "summarize this" |
| Find similar articles | Ask "find similar articles about [topic]" |
| Answer file questions | Add a workspace path in Settings, enable "Search local workspace files", then ask |
| Open suggested links | Click the action buttons that appear under Bob's response |

---

## How it works

```
User highlights text
    ↓
content.js captures: selectedText, pageTitle, pageUrl, pageText
    ↓
sidebar.js pre-fills input + sends CHAT message to background.js
    ↓
background.js:
  1. (optional) calls localhost:3333/search-workspace for file snippets
  2. builds prompt: user message + page context + file context
  3. calls Bob Inference API → gets { answer, actions[] }
    ↓
sidebar.js renders answer + action buttons
    ↓
User clicks action → chrome.tabs.create({ url })
```

---

## Local Server Endpoints

All endpoints listen on `http://127.0.0.1:3333` (localhost only).

### `GET /health`
Returns `{ status: "ok" }` — used by the sidebar to check if the server is running.

### `POST /list-files`
```json
{ "path": "/absolute/folder/path", "maxDepth": 4 }
```
Returns a recursive file tree (excludes `node_modules`, `.git`, `dist`, etc.)

### `POST /read-file`
```json
{ "path": "/absolute/path/to/file.js" }
```
Returns file content as a string. Capped at 500 KB.

### `POST /search-workspace`
```json
{ "path": "/absolute/folder", "query": "search term", "maxResults": 20 }
```
Runs `grep` (or pure-JS fallback on Windows) across text files. Returns:
```json
{
  "matches": [
    { "file": "relative/path.js", "line": 42, "snippet": "matching line content" }
  ],
  "total": 5
}
```
Searches: `.js .ts .jsx .tsx .py .go .java .rb .md .txt .json .yaml .yml .sh .css .html`

---

## Security notes

- The local server binds to `127.0.0.1` only — not accessible from other machines
- Path traversal is resolved via `path.resolve()` before any file access
- The extension only has `host_permissions` for `<all_urls>` and `http://localhost/*`
- Your API key is stored in `chrome.storage.local` (sandboxed to this extension)

---

## Phase 4 (optional): Semantic search

To add vector/semantic search over workspace files, you can:
1. Run an embedding model locally (e.g. via Ollama)
2. Index files into a local vector DB (e.g. LanceDB or Chroma)
3. Add a `/semantic-search` endpoint to the local server
4. Call it from `background.js` instead of (or alongside) `/search-workspace`
