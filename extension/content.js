// content.js — page context capture + browser action executor

// ── Context capture ──
chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (req.type === 'GET_CONTEXT') {
    sendResponse({
      selectedText: window.getSelection().toString(),
      pageTitle:    document.title,
      pageUrl:      location.href,
      pageText:     getCleanPageText(8000),
    });
    return true;
  }

  if (req.type === 'EXECUTE_ACTION') {
    (async () => {
      try {
        const result = await executeAction(req.action);
        sendResponse({ ok: true, result });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
});

// ── Get clean page text (strips nav/header/footer boilerplate) ──
function getCleanPageText(maxChars) {
  // Prefer main content area if available
  const main = document.querySelector('main, [role="main"], article, .content, #content, .topic-content, .bodydiv');
  const root = main || document.body;
  return (root.innerText || root.textContent || '').replace(/\s{3,}/g, '\n\n').trim().slice(0, maxChars);
}

// ── Find element — broad search across all interactive + text elements ──
function findElement(selector) {
  // 1. Try as CSS selector first
  try {
    const el = document.querySelector(selector);
    if (el) return el;
  } catch {}

  const needle = selector.toLowerCase().trim();

  // 2. Score-based search across all meaningful element types
  // Prefer: exact match > starts-with > includes; prefer links/buttons over divs
  const TAGS = 'a, button, [role=button], [role=link], [role=menuitem], [role=tab], [role=treeitem], label, summary, li, span, div, h1, h2, h3, h4, td';
  const candidates = Array.from(document.querySelectorAll(TAGS));

  let best = null;
  let bestScore = -1;

  for (const el of candidates) {
    // Skip hidden elements
    if (!isVisible(el)) continue;

    const elText = getElementText(el).toLowerCase();
    if (!elText) continue;

    let score = 0;

    if (elText === needle)            score = 100;
    else if (elText.startsWith(needle)) score = 80;
    else if (elText.includes(needle))   score = 50;
    else continue;

    // Bonus for interactive element types
    const tag = el.tagName.toLowerCase();
    if (tag === 'a')      score += 20;
    if (tag === 'button') score += 15;
    if (el.getAttribute('role') === 'link')   score += 18;
    if (el.getAttribute('role') === 'button') score += 13;

    // Penalty for very long text (means it's a container, not the target)
    if (elText.length > needle.length * 3) score -= 20;

    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }

  return best;
}

function getElementText(el) {
  // Use aria-label if present (more reliable than textContent for icon buttons)
  const aria = el.getAttribute('aria-label');
  if (aria) return aria.trim();
  // Use title attribute as fallback
  const title = el.getAttribute('title');
  // Use direct text — but only shallow (avoid pulling in all child text of containers)
  const direct = Array.from(el.childNodes)
    .filter(n => n.nodeType === Node.TEXT_NODE)
    .map(n => n.textContent.trim())
    .join(' ')
    .trim();
  if (direct.length > 1) return direct;
  // Fall back to full innerText for leaf-ish elements
  const inner = (el.innerText || el.textContent || title || '').trim();
  return inner;
}

function isVisible(el) {
  if (!el.getBoundingClientRect) return true;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  return true;
}

function waitForElement(selector, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const existing = findElement(selector);
    if (existing) return resolve(existing);

    const observer = new MutationObserver(() => {
      const el = findElement(selector);
      if (el) { observer.disconnect(); resolve(el); }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Element not found: "${selector}"`));
    }, timeoutMs);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Simulate a real click with pointer events (works on JS-rendered nav) ──
function simulateClick(el) {
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy };
  el.dispatchEvent(new PointerEvent('pointerover', opts));
  el.dispatchEvent(new PointerEvent('pointerenter', { ...opts, bubbles: false }));
  el.dispatchEvent(new MouseEvent('mouseover', opts));
  el.dispatchEvent(new MouseEvent('mouseenter', { ...opts, bubbles: false }));
  el.dispatchEvent(new PointerEvent('pointerdown', opts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new PointerEvent('pointerup', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.dispatchEvent(new MouseEvent('click', opts));
  // Also call .click() as a fallback
  try { el.click(); } catch {}
}

// ── Action implementations ──
async function executeAction(action) {
  switch (action.type) {

    case 'click': {
      const el = await waitForElement(action.selector);
      await sleep(100);
      simulateClick(el);
      await sleep(300);
      return `Clicked "${action.selector}"`;
    }

    case 'fill': {
      const el = await waitForElement(action.selector);
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.focus();
      const nativeInputValueSetter =
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,  'value')?.set ||
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(el, action.value);
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        el.value = action.value;
      }
      return `Filled "${action.selector}" with "${action.value}"`;
    }

    case 'scroll': {
      const amount = action.amount || 400;
      const dir    = (action.direction || 'down').toLowerCase();
      const dy = dir === 'up' ? -amount : dir === 'down' ? amount : 0;
      const dx = dir === 'left' ? -amount : dir === 'right' ? amount : 0;
      window.scrollBy({ top: dy, left: dx, behavior: 'smooth' });
      return `Scrolled ${dir} by ${amount}px`;
    }

    case 'extract': {
      const selector = action.selector || 'body';
      const nodes = selector === 'body'
        ? [document.body]
        : Array.from(document.querySelectorAll(selector));
      if (nodes.length === 0) throw new Error(`No elements matched: "${selector}"`);
      const text = nodes.map(n => n.innerText || n.textContent || '').join('\n').trim().slice(0, 6000);
      return text;
    }

    case 'get_links': {
      // Return up to 80 links, filtering out utility/nav noise
      const links = Array.from(document.querySelectorAll('a[href]'))
        .filter(a => {
          const href = a.href || '';
          const text = (a.textContent || '').trim();
          return href && !href.startsWith('javascript') && text.length > 1 && text.length < 200;
        })
        .map(a => ({ text: (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100), href: a.href }))
        .slice(0, 80);
      return links;
    }

    case 'open_link': {
      const needle = (action.label || '').toLowerCase().trim();
      const anchors = Array.from(document.querySelectorAll('a[href]'));
      let best = null, bestScore = -1;
      for (const a of anchors) {
        const text = (a.textContent || '').trim().toLowerCase();
        if (!text) continue;
        let score = 0;
        if (text === needle)              score = 100;
        else if (text.startsWith(needle)) score = 80;
        else if (text.includes(needle))   score = 50;
        else continue;
        if (text.length > needle.length * 4) score -= 15;
        if (score > bestScore) { bestScore = score; best = a; }
      }
      if (!best) throw new Error(`Link with text "${action.label}" not found`);
      // Return the href — background will open it in a new tab (reliable for SPAs/doc sites)
      return best.href;
    }

    case 'focus': {
      const el = await waitForElement(action.selector);
      el.focus();
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return `Focused "${action.selector}"`;
    }

    case 'press_key': {
      const target = action.selector ? (await waitForElement(action.selector)) : document.activeElement;
      const key = action.key || 'Enter';
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      target.dispatchEvent(new KeyboardEvent('keypress',{ key, bubbles: true, cancelable: true }));
      target.dispatchEvent(new KeyboardEvent('keyup',   { key, bubbles: true, cancelable: true }));
      return `Pressed "${key}"`;
    }

    default:
      throw new Error(`Unknown action type: "${action.type}"`);
  }
}
