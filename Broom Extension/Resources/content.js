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
const LAUNCHER_ID = "broom-launcher";
const SWEEP_ID = "broom-sweep";
const OUR_UI_SELECTOR = `#${PANEL_ID},#${HIGHLIGHT_ID},#${LAUNCHER_ID},[id^="${SWEEP_ID}"]`;

let pickerActive = false;
let pickerTarget = null;
let broomCursorDataUrl = null;

// Draw 🧹 onto a canvas and export as a CSS cursor data URL.
function getBroomCursorUrl() {
  if (broomCursorDataUrl) return broomCursorDataUrl;
  try {
    const size = 40;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    ctx.font = `${size * 0.85}px serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("🧹", size / 2, size / 2);
    broomCursorDataUrl = canvas.toDataURL();
  } catch {
    broomCursorDataUrl = null;
  }
  return broomCursorDataUrl;
}

function startPicker() {
  if (pickerActive) return;
  pickerActive = true;
  pickerTarget = null;
  document.documentElement.classList.add("broom-picking");
  document.getElementById(LAUNCHER_ID)?.classList.add("active");
  ensureHighlight();
  document.addEventListener("mouseover", onOver, true);
  document.addEventListener("click", onClick, true);
}

function stopPicker() {
  if (!pickerActive) return;
  pickerActive = false;
  pickerTarget = null;
  document.documentElement.classList.remove("broom-picking");
  document.getElementById(LAUNCHER_ID)?.classList.remove("active");
  document.getElementById(HIGHLIGHT_ID)?.remove();
  document.removeEventListener("mouseover", onOver, true);
  document.removeEventListener("click", onClick, true);
}

function togglePicker() {
  if (pickerActive) stopPicker();
  else startPicker();
}

function ensurePickerStyles() {
  const cursorUrl = getBroomCursorUrl();
  // hotspot at bottom-left of broom (tip of the handle): 4px from left, 36px down
  const cursorValue = cursorUrl
    ? `url('${cursorUrl}') 4 36, crosshair`
    : "crosshair";

  let s = document.getElementById(OVERLAY_STYLE_ID);
  if (!s) {
    s = document.createElement("style");
    s.id = OVERLAY_STYLE_ID;
    document.documentElement.appendChild(s);
  }
  s.textContent = pickerStylesheet(cursorValue);
}

function pickerStylesheet(cursorValue) {
  return `
    html.broom-picking, html.broom-picking * {
      cursor: ${cursorValue} !important;
      user-select: none !important;
    }
    #${HIGHLIGHT_ID} {
      position: fixed; pointer-events: none; z-index: 2147483645;
      border: 2px solid #2563eb;
      background: rgba(37,99,235,0.10);
      border-radius: 4px;
      box-shadow: 0 0 0 1px rgba(37,99,235,0.18), 0 4px 16px rgba(37,99,235,0.14);
      transition: top 55ms ease-out, left 55ms ease-out, width 55ms ease-out, height 55ms ease-out;
    }
    /* ── Panel ─────────────────────────────── */
    #${PANEL_ID} {
      all: initial;
      position: fixed !important;
      z-index: 2147483647 !important;
      bottom: 20px !important;
      right: 20px !important;
      width: 360px !important;
      font: 13px/1.45 -apple-system, system-ui, sans-serif !important;
      color-scheme: light dark !important;

      /* glass card — matches semai onboarding cards */
      background: rgba(255,255,255,0.88) !important;
      border: 1px solid rgba(148,163,184,0.28) !important;
      border-radius: 20px !important;
      box-shadow: 0 24px 60px rgba(15,23,42,0.20), 0 2px 8px rgba(15,23,42,0.08) !important;
      backdrop-filter: blur(18px) saturate(1.4) !important;
      -webkit-backdrop-filter: blur(18px) saturate(1.4) !important;
      padding: 18px !important;
      box-sizing: border-box !important;

      /* slide-in animation */
      animation: broom-panel-in 0.22s cubic-bezier(0.22,1,0.36,1) both !important;
    }
    @keyframes broom-panel-in {
      from { opacity: 0; transform: translateY(12px) scale(0.97); }
      to   { opacity: 1; transform: translateY(0)   scale(1); }
    }
    #${PANEL_ID} * { all: revert; box-sizing: border-box; }

    #${PANEL_ID} .bp-header {
      display: flex; align-items: center; gap: 8px; margin-bottom: 12px;
    }
    #${PANEL_ID} .bp-icon { font-size: 20px; line-height: 1; }
    #${PANEL_ID} .bp-title {
      font-size: 14px; font-weight: 700; color: #0f172a; margin: 0; flex: 1;
    }
    #${PANEL_ID} .bp-close {
      all: unset; cursor: pointer; font-size: 18px; line-height: 1;
      color: #94a3b8; padding: 2px 4px; border-radius: 6px;
    }
    #${PANEL_ID} .bp-close:hover { color: #475569; background: rgba(0,0,0,0.06); }

    #${PANEL_ID} .bp-sel {
      font-family: ui-monospace, "Cascadia Code", monospace;
      font-size: 11px; color: #64748b; word-break: break-all;
      background: rgba(241,245,249,0.9); border: 1px solid rgba(148,163,184,0.22);
      padding: 5px 8px; border-radius: 8px; margin-bottom: 14px;
      max-height: 48px; overflow: hidden;
    }

    #${PANEL_ID} .bp-actions {
      display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 4px;
    }
    #${PANEL_ID} .bp-btn {
      all: unset; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      padding: 7px 14px; border-radius: 999px; font-size: 13px; font-weight: 600;
      border: 1px solid rgba(148,163,184,0.32);
      background: rgba(255,255,255,0.7);
      color: #334155;
      transition: filter 0.12s, box-shadow 0.12s, transform 0.1s;
    }
    #${PANEL_ID} .bp-btn:hover { filter: brightness(0.96); box-shadow: 0 2px 8px rgba(0,0,0,0.10); }
    #${PANEL_ID} .bp-btn:active { transform: scale(0.97); }
    #${PANEL_ID} .bp-btn.primary {
      background: linear-gradient(135deg, #2563eb, #7c3aed);
      color: #fff; border-color: transparent;
      box-shadow: 0 6px 18px rgba(37,99,235,0.28);
    }
    #${PANEL_ID} .bp-btn.primary:hover { filter: brightness(1.08); box-shadow: 0 8px 22px rgba(37,99,235,0.36); }

    #${PANEL_ID} .bp-llm { margin-top: 14px; }
    #${PANEL_ID} .bp-label {
      font-size: 11px; font-weight: 600; color: #64748b;
      text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px;
    }
    #${PANEL_ID} textarea {
      all: unset; display: block; width: 100%; box-sizing: border-box;
      min-height: 64px; padding: 10px 12px;
      font: 13px/1.5 -apple-system, system-ui, sans-serif; color: #0f172a;
      background: rgba(255,255,255,0.8); border: 1px solid rgba(148,163,184,0.32);
      border-radius: 12px; resize: vertical; outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
      user-select: text !important; -webkit-user-select: text !important; cursor: text !important;
    }
    #${PANEL_ID} textarea:focus {
      border-color: rgba(37,99,235,0.5);
      box-shadow: 0 0 0 3px rgba(37,99,235,0.12);
    }
    #${PANEL_ID} textarea::placeholder { color: #94a3b8; }
    #${PANEL_ID} .bp-submit-row {
      display: flex; align-items: center; gap: 10px; margin-top: 10px;
    }
    #${PANEL_ID} .bp-status { font-size: 12px; color: #64748b; }
    #${PANEL_ID} .bp-err {
      margin-top: 8px; padding: 8px 10px; border-radius: 10px;
      background: rgba(254,226,226,0.8); border: 1px solid rgba(239,68,68,0.2);
      color: #b91c1c; font-size: 12px; line-height: 1.4;
    }

    @media (prefers-color-scheme: dark) {
      #${PANEL_ID} {
        background: rgba(15,23,42,0.82) !important;
        border-color: rgba(148,163,184,0.18) !important;
        color: #f8fafc !important;
      }
      #${PANEL_ID} .bp-title { color: #f1f5f9; }
      #${PANEL_ID} .bp-sel { background: rgba(30,41,59,0.8); border-color: rgba(148,163,184,0.16); color: #94a3b8; }
      #${PANEL_ID} .bp-btn { background: rgba(30,41,59,0.7); color: #e2e8f0; border-color: rgba(148,163,184,0.22); }
      #${PANEL_ID} textarea { background: rgba(15,23,42,0.7); border-color: rgba(148,163,184,0.22); color: #f1f5f9; }
      #${PANEL_ID} .bp-err { background: rgba(127,29,29,0.4); border-color: rgba(239,68,68,0.3); color: #fca5a5; }
      #${LAUNCHER_ID} { background: rgba(15,23,42,0.78) !important; border-color: rgba(148,163,184,0.18) !important; }
    }

    /* ── Persistent launcher ─────────────────── */
    #${LAUNCHER_ID} {
      all: initial !important;
      position: fixed !important;
      bottom: 22px !important;
      right: 22px !important;
      width: 52px !important;
      height: 52px !important;
      border-radius: 50% !important;
      border: 1px solid rgba(148,163,184,0.32) !important;
      background: rgba(255,255,255,0.92) !important;
      backdrop-filter: blur(18px) saturate(1.4) !important;
      -webkit-backdrop-filter: blur(18px) saturate(1.4) !important;
      box-shadow: 0 8px 24px rgba(15,23,42,0.18), 0 2px 6px rgba(15,23,42,0.08) !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      font-size: 26px !important;
      line-height: 1 !important;
      cursor: pointer !important;
      user-select: none !important;
      z-index: 2147483640 !important;
      transition: transform 0.2s cubic-bezier(.4,1.6,.5,1), box-shadow 0.18s !important;
      font-family: -apple-system, system-ui, sans-serif !important;
      padding: 0 !important;
    }
    #${LAUNCHER_ID}:hover { transform: scale(1.1) rotate(-8deg) !important; box-shadow: 0 12px 30px rgba(15,23,42,0.24) !important; }
    #${LAUNCHER_ID}:active { transform: scale(0.95) !important; }
    #${LAUNCHER_ID}.active {
      background: linear-gradient(135deg, #2563eb, #7c3aed) !important;
      border-color: transparent !important;
      box-shadow: 0 10px 28px rgba(37,99,235,0.42) !important;
      animation: bsweep-launcher-wiggle 0.7s ease-in-out infinite alternate !important;
    }
    @keyframes bsweep-launcher-wiggle {
      from { transform: rotate(-10deg); }
      to   { transform: rotate(10deg); }
    }

    /* ── Sweep animation ─────────────────────── */
    .${SWEEP_ID} { contain: layout style; }
    .${SWEEP_ID} .bsweep-broom {
      animation: bsweep-broom 0.95s cubic-bezier(.45,.05,.55,.95) forwards;
      filter: drop-shadow(0 4px 8px rgba(37,99,235,0.35));
    }
    .${SWEEP_ID} .bsweep-sparkle {
      will-change: transform, opacity;
      filter: drop-shadow(0 0 6px rgba(250,204,21,0.7));
    }
    @keyframes bsweep-broom {
      0%   { transform: translate(120%, -50%) rotate(35deg);   opacity: 0; }
      8%   { transform: translate(110%, -50%) rotate(35deg);   opacity: 1; }
      30%  { transform: translate(70%, -55%) rotate(-15deg); }
      52%  { transform: translate(40%, -45%) rotate(28deg); }
      72%  { transform: translate(10%, -55%) rotate(-18deg); }
      90%  { transform: translate(-30%, -50%) rotate(25deg);  opacity: 1; }
      100% { transform: translate(-130%, -50%) rotate(40deg); opacity: 0; }
    }
    @keyframes bsweep-sparkle {
      0%   { opacity: 0; transform: translate(-50%, -50%) scale(0.3) rotate(0deg); }
      18%  { opacity: 1; transform: translate(-50%, -50%) scale(1.1) rotate(60deg); }
      100% { opacity: 0; transform: translate(calc(-50% + var(--bx,0px)), calc(-50% + var(--by,0px))) scale(0.4) rotate(280deg); }
    }
    @keyframes bsweep-target {
      0%   { opacity: 1; filter: blur(0); transform: scale(1); }
      40%  { opacity: 0.85; filter: blur(0.5px); transform: scale(0.99); }
      100% { opacity: 0; filter: blur(8px); transform: scale(0.92); }
    }
  `;
}

function ensureHighlight() {
  if (!document.getElementById(HIGHLIGHT_ID)) {
    const h = document.createElement("div");
    h.id = HIGHLIGHT_ID;
    document.documentElement.appendChild(h);
  }
}

function isOurUI(el) { return !!el?.closest?.(OUR_UI_SELECTOR); }

function onOver(e) {
  if (!pickerActive || isOurUI(e.target)) return;
  pickerTarget = e.target;
  const r = e.target.getBoundingClientRect();
  const h = document.getElementById(HIGHLIGHT_ID);
  if (h) {
    Object.assign(h.style, {
      top: `${r.top}px`, left: `${r.left}px`,
      width: `${r.width}px`, height: `${r.height}px`,
    });
  }
}

function onClick(e) {
  if (!pickerActive || isOurUI(e.target)) return;
  e.preventDefault(); e.stopPropagation();
  pickerTarget = e.target;
  const target = e.target;
  stopPicker();
  openPanel(target);
}

// Global keydown — always active. Esc exits brooming/closes panel.
// Enter while a target is highlighted instantly hides it with a sweep animation.
function globalKeydown(e) {
  if (e.key === "Escape") {
    let handled = false;
    if (pickerActive) { stopPicker(); handled = true; }
    if (document.getElementById(PANEL_ID)) { closePanel(); handled = true; }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
    return;
  }
  if (e.key === "Enter" && pickerActive && pickerTarget && !isOurUI(e.target)) {
    e.preventDefault();
    e.stopPropagation();
    const target = pickerTarget;
    const selector = buildSelector(target);
    stopPicker();
    void playSweepAndHide(target, selector);
  }
}

// ── Always-present launcher ───────────────────────────────────────────────────

function installLauncher() {
  if (document.getElementById(LAUNCHER_ID)) return;
  ensurePickerStyles();
  const btn = document.createElement("button");
  btn.id = LAUNCHER_ID;
  btn.type = "button";
  btn.title = "Broom — click to pick element  ·  Enter to wipe  ·  Esc to cancel";
  btn.textContent = "🧹";
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    togglePicker();
  }, true);
  document.documentElement.appendChild(btn);
}

// ── Sweep animation — broom passes over the element, sparkles fly out ─────────

async function playSweepAndHide(el, selector) {
  if (!el || !el.isConnected) {
    // Element gone — just persist the rule.
    const rule = makeHideRule(selector);
    await upsertRuleLocal(rule);
    applyRule(rule);
    return;
  }
  ensurePickerStyles();
  const rect = el.getBoundingClientRect();
  // Skip animation for tiny or off-screen elements.
  const tooSmall = rect.width < 8 || rect.height < 8;
  const offscreen = rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth;
  if (tooSmall || offscreen) {
    const rule = makeHideRule(selector);
    await upsertRuleLocal(rule);
    applyRule(rule);
    return;
  }

  const overlay = document.createElement("div");
  overlay.id = `${SWEEP_ID}-${Date.now()}`;
  overlay.className = SWEEP_ID;
  Object.assign(overlay.style, {
    position: "fixed",
    top: `${rect.top}px`,
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    pointerEvents: "none",
    zIndex: "2147483647",
    overflow: "visible",
  });

  // Broom that sweeps across
  const broomSize = Math.max(28, Math.min(rect.height * 0.9, 56));
  const broom = document.createElement("div");
  broom.className = "bsweep-broom";
  broom.textContent = "🧹";
  Object.assign(broom.style, {
    position: "absolute",
    top: "50%",
    left: "0",
    fontSize: `${broomSize}px`,
    lineHeight: "1",
    transformOrigin: "50% 50%",
    willChange: "transform, opacity",
  });
  overlay.appendChild(broom);

  // Sparkles
  const glyphs = ["✨", "✦", "✧", "⭐", "💨"];
  const sparkleCount = Math.min(18, Math.max(8, Math.round(rect.width / 28)));
  for (let i = 0; i < sparkleCount; i++) {
    const s = document.createElement("div");
    s.className = "bsweep-sparkle";
    s.textContent = glyphs[i % glyphs.length];
    const dx = (Math.random() - 0.3) * Math.max(rect.width, 120);
    const dy = -20 - Math.random() * 80;
    const startX = 80 + Math.random() * 20; // start near the right side, where broom enters
    const startY = 30 + Math.random() * 40;
    const delay = Math.random() * 600;
    Object.assign(s.style, {
      position: "absolute",
      top: `${startY}%`,
      left: `${startX}%`,
      fontSize: `${10 + Math.random() * 12}px`,
      opacity: "0",
      animation: `bsweep-sparkle 0.7s cubic-bezier(.2,.8,.4,1) ${delay}ms forwards`,
    });
    s.style.setProperty("--bx", `${dx}px`);
    s.style.setProperty("--by", `${dy}px`);
    overlay.appendChild(s);
  }

  document.documentElement.appendChild(overlay);

  // Fade the actual element. Save inline styles to restore if the element
  // doesn't survive the rule application (unlikely, but defensive).
  const prevAnim = el.style.animation;
  el.style.animation = "bsweep-target 0.95s ease-in forwards";

  await new Promise((r) => setTimeout(r, 950));

  // Persist rule (display:none takes over from the animation).
  const rule = makeHideRule(selector);
  await upsertRuleLocal(rule);
  applyRule(rule);

  // Cleanup overlay; restore element styles in case the rule was rejected.
  overlay.remove();
  if (el.isConnected) el.style.animation = prevAnim;
}

function openPanel(el) {
  closePanel();
  const selector = buildSelector(el);
  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.innerHTML = `
    <div class="bp-header">
      <span class="bp-icon">🧹</span>
      <span class="bp-title">Modify element</span>
      <button class="bp-close" id="broom-cancel" title="Close (Esc)">✕</button>
    </div>
    <div class="bp-sel"></div>
    <div class="bp-actions">
      <button class="bp-btn primary" data-type="hide">Hide</button>
      <button class="bp-btn" data-type="restyle">Restyle…</button>
      <button class="bp-btn" data-type="inject">Inject…</button>
    </div>
    <div class="bp-llm" id="broom-llm" style="display:none">
      <div class="bp-label" id="broom-llm-label">Describe the change</div>
      <textarea id="broom-instruction" placeholder="e.g. make the font larger and blue, remove the sidebar…"></textarea>
      <div class="bp-submit-row">
        <button class="bp-btn primary" id="broom-submit">Generate</button>
        <span class="bp-status" id="broom-status"></span>
      </div>
      <div class="bp-err" id="broom-err" style="display:none"></div>
    </div>`;

  panel.querySelector(".bp-sel").textContent = selector;
  document.documentElement.appendChild(panel);

  const llmBox = panel.querySelector("#broom-llm");
  const llmLabel = panel.querySelector("#broom-llm-label");
  const instruction = panel.querySelector("#broom-instruction");
  const statusEl = panel.querySelector("#broom-status");
  const errEl = panel.querySelector("#broom-err");
  let pendingType = null;

  panel.querySelectorAll("button[data-type]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const t = btn.dataset.type;
      if (t === "hide") {
        closePanel();
        await playSweepAndHide(el, selector);
        return;
      }
      pendingType = t;
      const labels = { restyle: "Describe the style change", inject: "What text should appear?" };
      llmLabel.textContent = labels[t] || "Describe the change";
      llmBox.style.display = "block";
      instruction.focus();
    });
  });

  panel.querySelector("#broom-cancel").addEventListener("click", closePanel);

  panel.querySelector("#broom-submit").addEventListener("click", async () => {
    errEl.style.display = "none";
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
      applyRule(res.rule);
      closePanel();
    } catch (e) {
      errEl.textContent = e.message;
      errEl.style.display = "block";
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

  // Persistent UI: launcher + global keyboard handler
  ensurePickerStyles();
  const mountUI = () => {
    installLauncher();
  };
  if (document.body) mountUI();
  else document.addEventListener("DOMContentLoaded", mountUI, { once: true });
  document.addEventListener("keydown", globalKeydown, true);

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
