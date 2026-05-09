// Broom content script — classic script (MV3 content scripts don't support ES modules).
// All helpers are inlined so there are no import statements.
"use strict";

// ── UUID ─────────────────────────────────────────────────────────────────────

function uuid() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return "xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ── Storage (chrome.storage.local) ───────────────────────────────────────────

const RULES_KEY = "rules";

async function getRulesForHost(hostname) {
  const r = await chrome.storage.local.get(RULES_KEY);
  const map = r[RULES_KEY] ?? {};
  return map[hostname] ?? [];
}

async function upsertRuleLocal(rule) {
  const r = await chrome.storage.local.get(RULES_KEY);
  const map = r[RULES_KEY] ?? {};
  const list = map[rule.hostname] ?? [];
  const idx = list.findIndex((x) => x.id === rule.id);
  if (idx >= 0) list[idx] = rule;
  else list.push(rule);
  map[rule.hostname] = list;
  await chrome.storage.local.set({ [RULES_KEY]: map });
}

async function deleteRuleLocal(hostname, ruleId) {
  const r = await chrome.storage.local.get(RULES_KEY);
  const map = r[RULES_KEY] ?? {};
  map[hostname] = (map[hostname] ?? []).filter((x) => x.id !== ruleId);
  await chrome.storage.local.set({ [RULES_KEY]: map });
}

// ── CSS selector finder ───────────────────────────────────────────────────────

function buildSelector(el) {
  if (el.id && isSafeId(el.id) && document.querySelectorAll(`#${cssEscape(el.id)}`).length === 1) {
    return `#${cssEscape(el.id)}`;
  }
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== document.documentElement) {
    let part = node.tagName.toLowerCase();
    if (node.id && isSafeId(node.id)) { parts.unshift(`#${cssEscape(node.id)}`); break; }
    const stable = Array.from(node.classList).filter(isStableClass).slice(0, 2);
    if (stable.length) part += "." + stable.map(cssEscape).join(".");
    const parent = node.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = parent;
    try { if (document.querySelectorAll(parts.join(" > ")).length === 1) return parts.join(" > "); } catch { /* */ }
  }
  return parts.join(" > ");
}

function isStableClass(c) {
  if (!c || c.length > 40) return false;
  if (!/^[a-z0-9_-]+$/i.test(c)) return false;
  if (/(^|[-_])[a-f0-9]{6,}$/i.test(c)) return false;
  return true;
}
function isSafeId(id) { return /^[A-Za-z][\w-]*$/.test(id); }
function cssEscape(s) { return CSS && typeof CSS.escape === "function" ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, "\\$&"); }

// ── Rule applier ──────────────────────────────────────────────────────────────

const STYLE_ID = "broom-rules-style";
const INJECTED_ATTR = "data-broom-injected";
const styleCache = new Map(); // ruleId → css string

function rebuildStyleTag() {
  const css = Array.from(styleCache.entries()).map(([id, c]) => `/* ${id} */\n${c}`).join("\n\n");
  let style = document.getElementById(STYLE_ID);
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    (document.head || document.documentElement).appendChild(style);
  }
  style.textContent = css;
}

function applyRule(rule) {
  if (!rule.enabled) { removeRule(rule.id); return; }
  const { kind } = rule.payload;
  if (kind === "hide") {
    styleCache.set(rule.id, `${rule.selector.primary} { display: none !important; }`);
    rebuildStyleTag();
  } else if (kind === "restyle") {
    styleCache.set(rule.id, scopeCss(rule.selector.primary, rule.payload.css));
    rebuildStyleTag();
  } else if (kind === "inject") {
    applyInject(rule);
  }
}

function removeRule(ruleId) {
  styleCache.delete(ruleId);
  rebuildStyleTag();
  document.querySelectorAll(`[${INJECTED_ATTR}="${ruleId.replace(/"/g, '\\"')}"]`).forEach((n) => n.remove());
}

function applyInject(rule) {
  const anchor = resolveSelector(rule.selector.primary, rule.selector.fallbacks);
  if (!anchor) return;
  if (document.querySelector(`[${INJECTED_ATTR}="${rule.id.replace(/"/g, '\\"')}"]`)) return;
  const wrapper = document.createElement("div");
  wrapper.setAttribute(INJECTED_ATTR, rule.id);
  wrapper.textContent = rule.payload.html; // plain text only — safe
  const pos = rule.payload.position;
  if (pos === "before") anchor.parentNode?.insertBefore(wrapper, anchor);
  else if (pos === "after") anchor.parentNode?.insertBefore(wrapper, anchor.nextSibling);
  else if (pos === "prepend") anchor.insertBefore(wrapper, anchor.firstChild);
  else anchor.appendChild(wrapper);
}

function resolveSelector(primary, fallbacks = []) {
  for (const sel of [primary, ...fallbacks]) {
    if (!sel) continue;
    try { const el = document.querySelector(sel); if (el) return el; } catch { /* */ }
  }
  return null;
}

function scopeCss(selector, css) {
  const t = css.trim();
  if (!t) return "";
  if (!t.includes("{")) return `${selector} { ${t} }`;
  return t.replace(/(^|\})([^{}]+)\{/g, (_, pre, sel) => {
    const prefixed = sel.split(",").map((s) => `${selector} ${s.trim()}`.trim()).join(", ");
    return `${pre}${prefixed} {`;
  });
}

// ── Picker ────────────────────────────────────────────────────────────────────

const OVERLAY_STYLE_ID = "broom-picker-style";
const HIGHLIGHT_ID = "broom-picker-highlight";
const PANEL_ID = "broom-panel";

let pickerActive = false;
let pickerTarget = null;

function startPicker() {
  if (pickerActive) return;
  pickerActive = true;
  document.documentElement.classList.add("broom-picking");
  injectPickerStyles();
  ensureHighlight();
  document.addEventListener("mouseover", onOver, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
}

function stopPicker() {
  if (!pickerActive) return;
  pickerActive = false;
  document.documentElement.classList.remove("broom-picking");
  document.getElementById(HIGHLIGHT_ID)?.remove();
  document.removeEventListener("mouseover", onOver, true);
  document.removeEventListener("click", onClick, true);
  document.removeEventListener("keydown", onKey, true);
}

function injectPickerStyles() {
  if (document.getElementById(OVERLAY_STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = OVERLAY_STYLE_ID;
  s.textContent = `
    html.broom-picking, html.broom-picking * { cursor: crosshair !important; user-select: none !important; }
    #${HIGHLIGHT_ID} { position:fixed; pointer-events:none; z-index:2147483646; border:2px solid #2563eb; background:rgba(37,99,235,0.12); border-radius:2px; transition:top 60ms,left 60ms,width 60ms,height 60ms; }
    #${PANEL_ID} { position:fixed; z-index:2147483647; bottom:16px; right:16px; width:340px; background:#fff; color:#111; border:1px solid #ddd; border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,.18); font:13px -apple-system,system-ui,sans-serif; padding:12px; }
    #${PANEL_ID} h3 { margin:0 0 6px; font-size:13px; font-weight:600; }
    #${PANEL_ID} .broom-sel { font-family:ui-monospace,monospace; font-size:11px; color:#444; word-break:break-all; background:#f6f6f6; padding:4px 6px; border-radius:3px; }
    #${PANEL_ID} .broom-row { display:flex; gap:6px; margin-top:8px; flex-wrap:wrap; align-items:center; }
    #${PANEL_ID} button { font:inherit; padding:5px 9px; border:1px solid #ccc; background:#f7f7f7; border-radius:4px; cursor:pointer; }
    #${PANEL_ID} button.primary { background:#2563eb; color:#fff; border-color:#2563eb; }
    #${PANEL_ID} textarea { width:100%; box-sizing:border-box; min-height:56px; margin-top:8px; font:inherit; padding:6px; border:1px solid #ccc; border-radius:4px; resize:vertical; }
    #${PANEL_ID} .broom-err { color:#b00; font-size:12px; margin-top:6px; }
    #${PANEL_ID} .broom-muted { color:#666; font-size:11px; }
  `;
  document.documentElement.appendChild(s);
}

function ensureHighlight() {
  if (!document.getElementById(HIGHLIGHT_ID)) {
    const h = document.createElement("div");
    h.id = HIGHLIGHT_ID;
    document.documentElement.appendChild(h);
  }
}

function isOurUI(el) { return !!el?.closest?.(`#${PANEL_ID},#${HIGHLIGHT_ID}`); }

function onOver(e) {
  if (!pickerActive || isOurUI(e.target)) return;
  pickerTarget = e.target;
  const r = e.target.getBoundingClientRect();
  const h = document.getElementById(HIGHLIGHT_ID);
  if (h) { h.style.cssText = `position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #2563eb;background:rgba(37,99,235,0.12);border-radius:2px;top:${r.top}px;left:${r.left}px;width:${r.width}px;height:${r.height}px;`; }
}

function onClick(e) {
  if (!pickerActive || isOurUI(e.target)) return;
  e.preventDefault(); e.stopPropagation();
  pickerTarget = e.target;
  stopPicker();
  openPanel(pickerTarget);
}

function onKey(e) { if (e.key === "Escape") { stopPicker(); closePanel(); } }

function openPanel(el) {
  closePanel();
  const selector = buildSelector(el);
  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.innerHTML = `
    <h3>Modify this element</h3>
    <div class="broom-sel"></div>
    <div class="broom-row">
      <button data-type="hide" class="primary">Hide</button>
      <button data-type="restyle">Restyle…</button>
      <button data-type="inject">Inject text…</button>
      <button id="broom-cancel">Cancel</button>
    </div>
    <div id="broom-llm" style="display:none">
      <textarea id="broom-instruction" placeholder="Describe what you want…"></textarea>
      <div class="broom-row">
        <button class="primary" id="broom-submit">Generate</button>
        <span class="broom-muted" id="broom-status"></span>
      </div>
      <div class="broom-err" id="broom-err"></div>
    </div>`;
  panel.querySelector(".broom-sel").textContent = selector;
  document.documentElement.appendChild(panel);

  const llmBox = panel.querySelector("#broom-llm");
  const instruction = panel.querySelector("#broom-instruction");
  const statusEl = panel.querySelector("#broom-status");
  const errEl = panel.querySelector("#broom-err");
  let pendingType = null;

  panel.querySelectorAll("button[data-type]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const t = btn.dataset.type;
      if (t === "hide") {
        const rule = makeHideRule(selector);
        await upsertRuleLocal(rule);
        applyRule(rule);
        closePanel();
        return;
      }
      pendingType = t;
      llmBox.style.display = "block";
      instruction.focus();
    });
  });

  panel.querySelector("#broom-cancel").addEventListener("click", closePanel);

  panel.querySelector("#broom-submit").addEventListener("click", async () => {
    errEl.textContent = "";
    statusEl.textContent = "Thinking…";
    try {
      const res = await chrome.runtime.sendMessage({
        type: "BG_GENERATE_RULE",
        instruction: instruction.value,
        ruleType: pendingType,
        element: collectContext(el, selector),
        hostname: location.hostname,
      });
      if (!res?.ok) throw new Error(res?.error || "Unknown error");
      if (!safeQueryAll(res.rule.selector.primary).length) throw new Error(`Selector matched nothing: ${res.rule.selector.primary}`);
      applyRule(res.rule); // already persisted by background worker
      closePanel();
    } catch (e) {
      errEl.textContent = e.message;
      statusEl.textContent = "";
    }
  });
}

function closePanel() { document.getElementById(PANEL_ID)?.remove(); }

function makeHideRule(selector) {
  return { id: uuid(), hostname: location.hostname, type: "hide", selector: { primary: selector, fallbacks: [], semantic: "" }, payload: { kind: "hide" }, enabled: true, createdAt: Date.now(), lastAppliedAt: null, lastFailedAt: null, failCount: 0 };
}

function collectContext(el, selectorGuess) {
  return {
    outerHTML: el.outerHTML.slice(0, 2048),
    tagName: el.tagName.toLowerCase(),
    id: el.id || null,
    classes: Array.from(el.classList),
    selectorGuess,
    parentSelectorGuess: el.parentElement ? buildSelector(el.parentElement) : null,
    textSnippet: (el.textContent || "").trim().slice(0, 200),
  };
}

function safeQueryAll(sel) { try { return Array.from(document.querySelectorAll(sel)); } catch { return []; } }

// ── Replay & SPA handling ─────────────────────────────────────────────────────

let appliedRules = [];
let lastUrl = location.href;

async function init() {
  appliedRules = await getRulesForHost(location.hostname);
  for (const r of appliedRules) applyRule(r);

  const mo = new MutationObserver(debounce(onMutate, 120));
  const observe = () => mo.observe(document.body, { childList: true, subtree: true });
  if (document.body) observe();
  else document.addEventListener("DOMContentLoaded", observe, { once: true });

  // SPA navigation hooks
  const origPush = history.pushState;
  history.pushState = function (...args) { const r = origPush.apply(this, args); queueMicrotask(checkNav); return r; };
  window.addEventListener("popstate", checkNav);
}

function checkNav() {
  if (location.href !== lastUrl) { lastUrl = location.href; void refreshRules(); }
}

function onMutate() {
  checkNav();
  for (const r of appliedRules) {
    if (r.payload.kind === "inject") applyRule(r);
  }
}

async function refreshRules() {
  const fresh = await getRulesForHost(location.hostname);
  const freshIds = new Set(fresh.map((r) => r.id));
  for (const r of appliedRules) if (!freshIds.has(r.id)) removeRule(r.id);
  appliedRules = fresh;
  for (const r of appliedRules) applyRule(r);
}

// ── Message listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "CONTENT_START_PICKER") { startPicker(); sendResponse({ type: "ACK" }); return true; }
  if (msg?.type === "CONTENT_APPLY_RULE") { applyRule(msg.rule); void refreshRules(); sendResponse({ type: "ACK" }); return true; }
  if (msg?.type === "CONTENT_REMOVE_RULE") { removeRule(msg.ruleId); void refreshRules(); sendResponse({ type: "ACK" }); return true; }
  return false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[RULES_KEY]) void refreshRules();
});

// ── Utils ─────────────────────────────────────────────────────────────────────

function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ── Boot ──────────────────────────────────────────────────────────────────────

void init();
