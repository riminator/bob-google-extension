# Bob Browser Extension

AI-powered Chrome sidebar extension that reads page context, calls the Bob Inference API,
and can answer questions about local files — with graceful fallback to browser automation
when no proxy is configured.

---

## Project Structure

```
extension/          ← Chrome extension (load unpacked in Chrome)
  manifest.json
  content.js        ← captures selected text + page context
  background.js     ← LLM calls, browser automation
  sidebar.html      ← chat UI
  sidebar.js        ← renders responses, fallback search, action buttons

local-server/       ← Node.js file system bridge (run locally, optional)
  server.js
  package.json

proxy/              ← Tiny Node proxy — deployed once to the cloud
  server.js
  render.yaml       ← one-click deploy to Render.com
```

---

## What works with and without a proxy

The proxy is only required to reach the Bob Inference API (Cloudflare blocks
`chrome-extension://` origins). Everything that doesn't involve the LLM works
without it.

| Feature | No proxy | With proxy |
|---|:---:|:---:|
| **File browser** — grant folder access, read & browse local files | ✅ | ✅ |
| **Sessions tab** — save and reopen folder workspaces | ✅ | ✅ |
| **Browser automation** — tab switching, navigation, scrolling, clicking | ✅ | ✅ |
| **Page context capture** — selected text, page URL, page content | ✅ | ✅ |
| **Search fallback** — if message looks like a search/nav request, opens Google and navigates to the top result automatically | ✅ | ✅ |
| **AI chat** — understand questions, summarize pages, answer from file context | ❌ | ✅ |
| **Agentic research loop** — multi-step browse → read → answer | ❌ | ✅ |
| **File Q&A** — ask questions about attached local files | ❌ | ✅ |
| **Smart navigation** — LLM picks the right link from the page to click | ❌ | ✅ |

### Search fallback (no proxy)

When the proxy is unreachable or not configured, the extension doesn't just
show an error. If your message contains search or navigation intent keywords
(find, search, docs, how to, what is, open, navigate, etc.), the extension:

1. Strips conversational openers (`"can you find me the…"` → `"React docs"`)
2. Shows a brief ⚠️ notice that AI is unavailable
3. Fires a Google search and automatically navigates to the top organic result

Messages that aren't search-like (e.g. *"summarize this page"*) fall through
to the normal error display.

---

## Why a proxy is required for AI features

The Bob Inference API sits behind Cloudflare, which rejects any request carrying
an `Origin: chrome-extension://…` header — a header Chrome automatically adds to
all `fetch()` calls made from an extension. The proxy strips that header and
forwards the request. **There is no way to call the Bob API directly from the
extension without a proxy.**

---

## Quick Start (for yourself)

### 1. Deploy the proxy (one-time)

The proxy only needs to be deployed once. It doesn't store your API key — it
just relays requests.

**Option A — Render.com (free tier, recommended)**

1. Fork this repo on GitHub
2. Go to [render.com](https://render.com) → **New → Web Service** → connect your fork
3. Render auto-detects `proxy/render.yaml` and configures everything
4. In the Render dashboard, set these environment variables:
   - `BOB_INSTANCE_ID` — from your Bob workspace settings
   - `BOB_TEAM_ID` — from your Bob workspace settings
   - `PROXY_SECRET` — click **Generate** (Render creates a random value for you)
5. Deploy. Copy the service URL (e.g. `https://bob-llm-proxy.onrender.com`)

**Option B — Run locally (no deployment needed, but only works on your machine)**

```bash
cd local-server
npm install
node server.js
# → Bob local file server running at http://127.0.0.1:3333
```

### 2. Load the extension in Chrome

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** → select the `extension/` folder
4. The **Bob Assistant** extension appears in your toolbar

### 3. Configure the extension

1. Click the Bob icon to open the sidebar
2. Go to the **Settings** tab
3. Fill in:
   - **Proxy URL** — your Render URL (or `http://localhost:3333` for local)
   - **Proxy Secret** — the secret from your Render env vars
   - **Bob API Key** — your personal Bob Inference API key
4. Click **Save Settings** — the status indicator should turn green

> **No proxy yet?** You can still load the extension and use file browsing,
> sessions, browser automation, and the search fallback immediately.
> Add the proxy later to unlock AI features.

---

## Sharing the extension with others

### Option A — Share your deployed proxy (easiest)

You've already done the hard part by deploying the proxy. Other users just need
the extension and your proxy credentials — **they do not need to deploy anything**.

Give each person:

| What | Where to find it |
|------|-----------------|
| Proxy URL | Your Render service URL, e.g. `https://bob-llm-proxy.onrender.com` |
| Proxy Secret | Render dashboard → your service → **Environment** tab → `PROXY_SECRET` value |

Each person then:
1. Loads the `extension/` folder in Chrome (unpacked), or installs from the Chrome Web Store once published
2. Opens the **Settings** tab
3. Enters the **shared proxy URL**, **shared proxy secret**, and **their own Bob API key**
4. Clicks **Save Settings**

> **Note:** `BOB_INSTANCE_ID` and `BOB_TEAM_ID` are set in your proxy's env vars.
> All users who share your proxy will route through your Bob workspace. If each
> person needs their own workspace context, they should deploy their own proxy.

### Option B — Each person deploys their own proxy

Each user follows the same **Quick Start** steps above (fork → Render → load extension).
Use this when users need their own Bob workspace/team context.

### Option C — Use with no proxy at all

Users who don't have a proxy can still install the extension and get value from:
- Browsing and reading local files (Files tab)
- Managing folder sessions (Sessions tab)
- Direct browser tab control
- Automatic Google search fallback for search/navigation requests

They just won't get AI-generated answers until a proxy is configured.

---

## Publishing to the Chrome Web Store

Once published, users install with one click and skip the "Load unpacked" step.

1. Zip the `extension/` folder (not the whole repo — just that folder)
2. Go to [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
3. **New Item** → upload the zip
4. Fill in the store listing, screenshots, and privacy policy
5. Submit for review (usually 1–3 business days)

After approval, the install URL works for anyone. Users can start using file
browsing and search fallback immediately — AI features unlock once they add
a proxy URL, proxy secret, and Bob API key in Settings.

---

## Usage

| Action | Proxy needed? | How |
|--------|:---:|-----|
| Browse local files | No | **Files** tab → grant a folder → browse and attach files |
| Manage folder sessions | No | **Sessions** tab → pick a folder → open chat session |
| Tab switching / browser control | No | Ask Bob to "switch to the Gmail tab", "go back", etc. |
| Search & navigate (fallback) | No | Ask "find React docs" — extension Googles it and navigates automatically |
| Summarize highlighted text | Yes | Select text → type "summarize this" |
| Answer questions about a file | Yes | Attach a file in Files tab → ask your question |
| Find similar articles (AI) | Yes | Ask "find similar articles about [topic]" |
| Agentic research loop | Yes | Ask a research question — Bob browses, reads, and reports back |
| Open suggested links | Yes | Click action buttons that appear under Bob's response |

---

## How it works

### With proxy (full AI mode)

```
User sends a message
    ↓
background.js builds prompt:
  system prompt + chat history + page context + file context
    ↓
POST → <proxy>/chat   { messages, apiKey }
    ↓
proxy/server.js strips chrome-extension Origin header,
  adds Bob API headers (instance-id, team-id), forwards to Bob Inference API
    ↓
Bob API returns LLM response
    ↓
proxy returns { answer, actions[] } to extension
    ↓
sidebar.js renders answer + action buttons
    ↓
background.js executes browser automation actions
```

### Without proxy (fallback mode)

```
User sends a message
    ↓
LLM call fails (proxy unreachable / not configured)
    ↓
sidebar.js checks for search/navigation intent keywords
    ↓
  if search-like → strips opener → fires navigate_search action
      ↓
      background.js opens Google → finds top organic result → navigates
    ↓
  if not search-like → shows error
```

---

## Local Server Endpoints (optional file access)

The local server (`local-server/`) provides file-system access when running on
your machine. All endpoints listen on `http://127.0.0.1:3333` (localhost only).

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

- The proxy validates `X-Proxy-Secret` on every request — without it, the request is rejected
- Your Bob API key is never logged or stored by the proxy — it's forwarded in-flight only
- The local server binds to `127.0.0.1` only — not accessible from other machines
- Path traversal is resolved via `path.resolve()` before any file access
- Your API key is stored in `chrome.storage.local` (sandboxed to this extension only)

---

## Phase 4 (optional): Semantic search

To add vector/semantic search over workspace files, you can:
1. Run an embedding model locally (e.g. via Ollama)
2. Index files into a local vector DB (e.g. LanceDB or Chroma)
3. Add a `/semantic-search` endpoint to the local server
4. Call it from `background.js` instead of (or alongside) `/search-workspace`
