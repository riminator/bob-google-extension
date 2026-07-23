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

local-server/       ← Node.js file system bridge (run locally, optional)
  server.js
  package.json

proxy/              ← Tiny Node proxy — deployed once to the cloud
  server.js
  render.yaml       ← one-click deploy to Render.com
```

---

## Why a proxy is required

The Bob Inference API sits behind Cloudflare, which rejects any request carrying an
`Origin: chrome-extension://…` header — a header Chrome automatically adds to all
`fetch()` calls made from an extension. The proxy simply strips that header and
forwards the request. **There is no way to call the Bob API directly from the
extension without a proxy.**

---

## Quick Start (for yourself)

### 1. Deploy the proxy (one-time)

The proxy only needs to be deployed once. It doesn't store your API key — it just
relays requests.

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

---

## Sharing the extension with others

### Option A — Share your deployed proxy (easiest)

You've already done the hard part by deploying the proxy. Other users just need the
extension and your proxy credentials — **they do not need to deploy anything**.

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

> **Note:** `BOB_INSTANCE_ID` and `BOB_TEAM_ID` are set in your proxy's env. All users
> who share your proxy will route through your Bob workspace. If each person should use
> their own workspace, they should deploy their own proxy (Option B below).

### Option B — Each person deploys their own proxy

Each user follows the same **Quick Start** steps above (fork → Render → load extension).
Use this when users need their own Bob workspace/team context.

---

## Publishing to the Chrome Web Store

Once published, users install with one click and skip the "Load unpacked" step entirely.

1. Zip the `extension/` folder (not the whole repo — just that folder)
2. Go to [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
3. **New Item** → upload the zip
4. Fill in the store listing, screenshots, and privacy policy
5. Submit for review (usually 1–3 business days)

After approval, the install URL works for anyone. Users still need to enter a proxy URL,
proxy secret, and their own Bob API key in Settings before the extension works.

---

## Usage

| Action | How |
|--------|-----|
| Summarize highlighted text | Select text on any page → click extension icon → type "summarize this" |
| Find similar articles | Ask "find similar articles about [topic]" |
| Browse local files | Use the **Files** tab to grant folder access, then attach files to your question |
| Open Bob sessions | Use the **Sessions** tab to open a saved Bob workspace session |
| Open suggested links | Click the action buttons that appear under Bob's response |

---

## How it works

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
User clicks action → background.js executes browser automation
```

---

## Local Server Endpoints (optional file access)

The local server (`local-server/`) provides file-system access when running on your
machine. All endpoints listen on `http://127.0.0.1:3333` (localhost only).

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
