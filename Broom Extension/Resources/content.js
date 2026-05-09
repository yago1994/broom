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

// ── Plant catalog (trusted inline SVGs) ──────────────────────────────────────

const POT_SVGS = {
  terracotta: `<svg viewBox="0 0 100 60" preserveAspectRatio="none" aria-hidden="true"><path d="M14 6 L86 6 L78 56 Q50 60 22 56 Z" fill="#c2683a"/><path d="M14 6 L86 6 L82 18 Q50 22 18 18 Z" fill="#a8542a"/><rect x="10" y="2" width="80" height="6" rx="2" fill="#b85a30"/></svg>`,
  ceramic: `<svg viewBox="0 0 100 60" preserveAspectRatio="none" aria-hidden="true"><path d="M16 4 Q50 0 84 4 L78 56 Q50 60 22 56 Z" fill="#ece7dd"/><ellipse cx="50" cy="6" rx="34" ry="4" fill="#d8d2c4"/><path d="M22 56 Q50 60 78 56 L78 50 Q50 54 22 50 Z" fill="#c8c2b3"/></svg>`,
  none: ""
};

const PLANT_SVGS = {
  pothos: `<svg viewBox="0 0 100 100" aria-hidden="true"><g fill="none" stroke="#3a7a3f" stroke-width="2.5" stroke-linecap="round"><path d="M50 92 Q42 70 30 52 Q20 38 14 22"/><path d="M50 92 Q58 70 70 52 Q80 38 86 22"/><path d="M50 92 Q50 72 48 50 Q44 30 40 14"/><path d="M50 92 Q56 80 64 70 Q72 60 76 50"/></g><g fill="#5cb262" stroke="#2e6b35" stroke-width="1.2" stroke-linejoin="round"><path d="M14 22 q-8 -1 -10 6 q3 7 11 5 q5 -3 -1 -11 z"/><path d="M40 14 q-9 1 -9 9 q6 5 13 2 q3 -4 -4 -11 z"/><path d="M30 52 q-10 0 -10 8 q5 6 13 3 q4 -4 -3 -11 z"/><path d="M48 50 q-9 -2 -11 6 q5 7 13 4 q4 -4 -2 -10 z"/><path d="M70 52 q10 0 10 8 q-5 6 -13 3 q-4 -4 3 -11 z"/><path d="M86 22 q8 -1 10 6 q-3 7 -11 5 q-5 -3 1 -11 z"/><path d="M76 50 q9 -1 10 7 q-5 5 -12 3 q-3 -4 2 -10 z"/></g></svg>`,
  "bird-of-paradise": `<svg viewBox="0 0 100 100" aria-hidden="true"><g stroke="#2e6b35" stroke-width="1.2" stroke-linejoin="round"><path d="M50 95 Q38 70 30 40 Q26 22 32 8 Q42 26 46 56 Q47 78 50 95 Z" fill="#4ea05a"/><path d="M50 95 Q62 70 70 40 Q74 22 68 8 Q58 26 54 56 Q53 78 50 95 Z" fill="#4ea05a"/><path d="M50 95 Q50 60 50 30 Q52 14 56 4 Q54 30 52 60 Q51 80 50 95 Z" fill="#3f8a4d"/><path d="M50 95 Q42 78 38 60 Q34 44 36 26 Q42 44 44 64 Q45 80 50 95 Z" fill="#5db867"/><path d="M50 95 Q58 78 62 60 Q66 44 64 26 Q58 44 56 64 Q55 80 50 95 Z" fill="#5db867"/></g><g stroke="#a64a1a" stroke-width="1"><path d="M48 56 q-8 -4 -10 -12 q6 0 10 6 z" fill="#e8723a"/><path d="M52 56 q8 -4 10 -12 q-6 0 -10 6 z" fill="#d6a23a"/></g></svg>`,
  "snake-plant": `<svg viewBox="0 0 100 100" aria-hidden="true"><g stroke="#2e6b35" stroke-width="1.2" stroke-linejoin="round"><path d="M50 95 Q44 60 40 30 Q38 14 44 4 Q48 24 50 60 Q50 80 50 95 Z" fill="#5fa55a"/><path d="M50 95 Q56 60 60 30 Q62 14 56 4 Q52 24 50 60 Q50 80 50 95 Z" fill="#4f944c"/><path d="M50 95 Q42 70 36 50 Q30 32 28 18 Q38 36 44 60 Q47 80 50 95 Z" fill="#6db768"/><path d="M50 95 Q58 70 64 50 Q70 32 72 18 Q62 36 56 60 Q53 80 50 95 Z" fill="#3f7e3d"/></g><g stroke="#d4d77a" stroke-width="1.4" fill="none" opacity="0.55"><path d="M44 14 q1 8 0 18"/><path d="M50 8 q0 12 0 22"/><path d="M56 14 q-1 8 0 18"/></g></svg>`,
  monstera: `<svg viewBox="0 0 100 100" aria-hidden="true"><g stroke="#2e6b35" stroke-width="1.2" stroke-linejoin="round"><path d="M28 70 Q12 50 14 30 Q26 22 38 32 Q44 18 50 22 Q44 38 46 56 Q40 70 28 70 Z" fill="#4fa358"/><path d="M72 65 Q88 48 86 28 Q74 20 62 30 Q58 16 52 20 Q56 36 54 54 Q60 68 72 65 Z" fill="#5db867"/><path d="M50 90 Q42 78 42 64 Q42 50 50 36 Q58 50 58 64 Q58 78 50 90 Z" fill="#3f8a4d"/></g><g stroke="#2e6b35" stroke-width="1.2" fill="none" stroke-linecap="round"><path d="M22 36 q5 4 8 4"/><path d="M26 50 q5 3 9 3"/><path d="M78 36 q-5 4 -8 4"/><path d="M74 50 q-5 3 -9 3"/></g><path d="M50 90 Q50 70 50 50 Q50 30 50 18" stroke="#2e6b35" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>`,
  fern: `<svg viewBox="0 0 100 100" aria-hidden="true"><g stroke="#2e6b35" stroke-width="1.4" stroke-linecap="round" fill="none"><path d="M50 95 Q42 70 26 50 Q16 38 8 30"/><path d="M50 95 Q58 70 74 50 Q84 38 92 30"/><path d="M50 95 Q48 70 44 40 Q42 22 40 8"/><path d="M50 95 Q52 70 56 40 Q58 22 60 8"/><path d="M50 95 Q50 70 50 40 Q50 22 50 4"/></g><g fill="#5db867" stroke="#3a7a3f" stroke-width="0.8"><ellipse cx="14" cy="34" rx="6" ry="2.4" transform="rotate(-30 14 34)"/><ellipse cx="22" cy="44" rx="6" ry="2.4" transform="rotate(-22 22 44)"/><ellipse cx="32" cy="54" rx="6" ry="2.4" transform="rotate(-15 32 54)"/><ellipse cx="86" cy="34" rx="6" ry="2.4" transform="rotate(30 86 34)"/><ellipse cx="78" cy="44" rx="6" ry="2.4" transform="rotate(22 78 44)"/><ellipse cx="68" cy="54" rx="6" ry="2.4" transform="rotate(15 68 54)"/><ellipse cx="42" cy="20" rx="5" ry="2.2" transform="rotate(-10 42 20)"/><ellipse cx="58" cy="20" rx="5" ry="2.2" transform="rotate(10 58 20)"/><ellipse cx="44" cy="36" rx="5" ry="2.2" transform="rotate(-10 44 36)"/><ellipse cx="56" cy="36" rx="5" ry="2.2" transform="rotate(10 56 36)"/><ellipse cx="50" cy="14" rx="5" ry="2.2"/><ellipse cx="50" cy="30" rx="5" ry="2.2"/><ellipse cx="50" cy="48" rx="5" ry="2.2"/></g></svg>`,
  succulent: `<svg viewBox="0 0 100 100" aria-hidden="true"><g stroke="#2e6b35" stroke-width="1.2" stroke-linejoin="round"><ellipse cx="50" cy="80" rx="24" ry="10" fill="#6dbf68"/><ellipse cx="30" cy="64" rx="10" ry="14" transform="rotate(-30 30 64)" fill="#5db35e"/><ellipse cx="70" cy="64" rx="10" ry="14" transform="rotate(30 70 64)" fill="#5db35e"/><ellipse cx="38" cy="50" rx="9" ry="14" transform="rotate(-15 38 50)" fill="#7bc97a"/><ellipse cx="62" cy="50" rx="9" ry="14" transform="rotate(15 62 50)" fill="#7bc97a"/><ellipse cx="50" cy="42" rx="8" ry="14" fill="#8fd687"/><ellipse cx="50" cy="58" rx="6" ry="10" fill="#a2dd92"/></g></svg>`
};

const PLANT_NAMES = {
  pothos: "Pothos",
  "bird-of-paradise": "Bird of paradise",
  "snake-plant": "Snake plant",
  monstera: "Monstera",
  fern: "Fern",
  succulent: "Succulent"
};

const SHOVEL_CURSOR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path d="M22 3 l7 7 -3 3 -2 -2 -10 10 -3 -3 10 -10 -2 -2 z" fill="#caa376" stroke="#5a4424" stroke-width="1.4" stroke-linejoin="round"/><path d="M11 17 l-5 5 q-3 3 -1 5 q2 2 5 -1 l5 -5 z" fill="#7e8a96" stroke="#3a4047" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
const SHOVEL_CURSOR_DATA_URL = `url('data:image/svg+xml;utf8,${encodeURIComponent(SHOVEL_CURSOR_SVG)}') 6 26, pointer`;

function randomFrom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function chooseRandomPlant(hideRule) {
  const box = (hideRule.payload && hideRule.payload.originalBox) || { width: 120, height: 120 };
  const h = box.height;
  const small = ["succulent", "fern", "snake-plant"];
  const medium = ["pothos", "fern", "snake-plant", "monstera"];
  const large = ["bird-of-paradise", "monstera", "pothos"];
  const pool = h < 90 ? small : h > 180 ? large : medium;
  return {
    kind: randomFrom(pool),
    size: h > 180 ? "lg" : h > 90 ? "md" : "sm",
    animation: "gentle-sway",
    pot: randomFrom(["terracotta", "ceramic", "none"])
  };
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

function applyRule(rule, options) {
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
  } else if (kind === "plant") {
    applyPlant(rule, options);
  }
}

function applyPlant(rule, options) {
  const anchor = resolveSelector(rule.selector.primary, rule.selector.fallbacks);
  if (!anchor) return;
  const escId = rule.id.replace(/"/g, '\\"');
  if (document.querySelector(`[${INJECTED_ATTR}="${escId}"]`)) return;
  const slot = document.createElement("div");
  slot.setAttribute(INJECTED_ATTR, rule.id);
  slot.className = "broom-plant-slot";
  const plant = renderPlant(rule.payload.plant);
  if (options && options.enterAnimation) plant.classList.add("broom-plant-enter");
  slot.appendChild(plant);
  if (anchor.parentNode) anchor.parentNode.insertBefore(slot, anchor.nextSibling);
}

function renderPlant(props) {
  const wrapper = document.createElement("div");
  const animClass = props.animation && props.animation !== "none" ? `broom-plant-anim-${props.animation}` : "";
  wrapper.className = `broom-plant broom-plant-${props.kind} broom-plant-${props.size} broom-plant-pot-${props.pot} ${animClass}`.trim();
  wrapper.setAttribute("aria-hidden", "true");
  const potSvg = POT_SVGS[props.pot] || "";
  const plantSvg = PLANT_SVGS[props.kind] || PLANT_SVGS.pothos;
  wrapper.innerHTML = `<div class="broom-plant-foliage">${plantSvg}</div>${potSvg ? `<div class="broom-plant-pot">${potSvg}</div>` : ""}`;
  return wrapper;
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

let activeMode = null; // "broom" | "plant" | null
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

function startMode(mode) {
  if (activeMode === mode) return;
  if (activeMode) stopMode();
  activeMode = mode;
  pickerTarget = null;
  ensurePickerStyles();
  document.documentElement.setAttribute("data-broom-mode", mode);
  const launcher = document.getElementById(LAUNCHER_ID);
  launcher?.classList.add("active");
  launcher?.setAttribute("data-mode", mode);

  if (mode === "broom") {
    document.documentElement.classList.add("broom-picking");
    ensureHighlight();
    document.addEventListener("mouseover", onOver, true);
    document.addEventListener("click", onClick, true);
  } else if (mode === "plant") {
    renderEmptySlotAffordances();
  }
}

function stopMode() {
  if (!activeMode) return;
  const prev = activeMode;
  activeMode = null;
  pickerTarget = null;
  document.documentElement.classList.remove("broom-picking");
  document.documentElement.removeAttribute("data-broom-mode");
  const launcher = document.getElementById(LAUNCHER_ID);
  launcher?.classList.remove("active");
  launcher?.removeAttribute("data-mode");
  document.getElementById(HIGHLIGHT_ID)?.remove();
  hideSelectorTag();
  document.removeEventListener("mouseover", onOver, true);
  document.removeEventListener("click", onClick, true);
  if (prev === "plant") removeEmptySlotAffordances();
}

// Backward-compat aliases (popup still sends CONTENT_START_PICKER → broom mode)
function startPicker() { startMode("broom"); }
function stopPicker() { stopMode(); }

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
    #${LAUNCHER_WRAP_ID} {
      all: initial !important;
      position: fixed !important;
      bottom: 22px !important;
      right: 22px !important;
      width: 52px !important;
      height: 52px !important;
      z-index: 2147483640 !important;
      font-family: -apple-system, system-ui, sans-serif !important;
    }
    #${LAUNCHER_ID} {
      all: initial !important;
      position: relative !important;
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
      transition: transform 0.2s cubic-bezier(.4,1.6,.5,1), box-shadow 0.18s, background 0.18s, border-color 0.18s !important;
      font-family: -apple-system, system-ui, sans-serif !important;
      padding: 0 !important;
      animation: bsweep-launcher-enter 0.85s cubic-bezier(.34,1.56,.64,1) both !important;
    }
    #${LAUNCHER_ID}:hover { transform: scale(1.1) rotate(-8deg) !important; box-shadow: 0 12px 30px rgba(15,23,42,0.24) !important; }
    #${LAUNCHER_ID}:active { transform: scale(0.92) rotate(-12deg) !important; }
    #${LAUNCHER_ID}.squash { animation: bsweep-launcher-squash 0.32s cubic-bezier(.34,1.56,.64,1) !important; }
    #${LAUNCHER_ID}.active {
      background: linear-gradient(135deg, #2563eb, #7c3aed) !important;
      border-color: transparent !important;
      box-shadow: 0 10px 28px rgba(37,99,235,0.42) !important;
      animation: bsweep-launcher-wiggle 0.7s ease-in-out infinite alternate !important;
    }
    #${LAUNCHER_ID}[data-mode="plant"] {
      background: linear-gradient(135deg, #38a169, #6cc551) !important;
      box-shadow: 0 10px 28px rgba(56,161,105,0.42) !important;
    }

    /* ── Hover fan menu ──────────────────────── */
    #${LAUNCHER_WRAP_ID} .broom-fan {
      position: absolute !important;
      right: 0 !important;
      bottom: 60px !important;
      display: flex !important;
      flex-direction: column !important;
      align-items: flex-end !important;
      gap: 8px !important;
      pointer-events: none !important;
    }
    #${LAUNCHER_WRAP_ID} .broom-fan-chip {
      all: initial !important;
      display: inline-flex !important;
      align-items: center !important;
      gap: 8px !important;
      height: 40px !important;
      padding: 0 14px 0 12px !important;
      border-radius: 999px !important;
      background: rgba(255,255,255,0.96) !important;
      border: 1px solid rgba(148,163,184,0.28) !important;
      box-shadow: 0 6px 18px rgba(15,23,42,0.14), 0 1px 3px rgba(15,23,42,0.06) !important;
      backdrop-filter: blur(14px) saturate(1.3) !important;
      -webkit-backdrop-filter: blur(14px) saturate(1.3) !important;
      font: 600 13px/1 -apple-system, system-ui, sans-serif !important;
      color: #1f2937 !important;
      cursor: pointer !important;
      user-select: none !important;
      opacity: 0 !important;
      transform: translateX(8px) translateY(8px) scale(0.85) !important;
      transition: opacity 0.18s ease, transform 0.24s cubic-bezier(.34,1.56,.64,1), box-shadow 0.15s !important;
      pointer-events: none !important;
    }
    #${LAUNCHER_WRAP_ID} .broom-fan-chip:hover {
      box-shadow: 0 10px 24px rgba(15,23,42,0.22), 0 2px 6px rgba(15,23,42,0.10) !important;
      transform: translateX(0) translateY(-2px) scale(1.04) !important;
    }
    #${LAUNCHER_WRAP_ID} .broom-fan-glyph {
      font-size: 18px !important;
      line-height: 1 !important;
    }
    #${LAUNCHER_WRAP_ID} .broom-fan-label {
      font-weight: 600 !important;
      letter-spacing: 0.01em !important;
    }
    #${LAUNCHER_WRAP_ID}.broom-fan-open .broom-fan { pointer-events: auto !important; }
    #${LAUNCHER_WRAP_ID}.broom-fan-open .broom-fan-chip {
      opacity: 1 !important;
      transform: translateX(0) translateY(0) scale(1) !important;
      pointer-events: auto !important;
    }
    #${LAUNCHER_WRAP_ID}.broom-fan-open .broom-fan-chip:nth-child(1) { transition-delay: 60ms; }
    #${LAUNCHER_WRAP_ID}.broom-fan-open .broom-fan-chip:nth-child(2) { transition-delay: 0ms; }
    #${LAUNCHER_WRAP_ID} .broom-fan-chip[data-mode="plant"]:hover {
      background: linear-gradient(135deg, rgba(108,197,81,0.18), rgba(56,161,105,0.18)) !important;
      border-color: rgba(56,161,105,0.5) !important;
    }
    #${LAUNCHER_WRAP_ID} .broom-fan-chip[data-mode="broom"]:hover {
      background: linear-gradient(135deg, rgba(124,58,237,0.14), rgba(37,99,235,0.14)) !important;
      border-color: rgba(37,99,235,0.5) !important;
    }
    @keyframes bsweep-launcher-enter {
      0%   { transform: translateY(-140px) rotate(-25deg) scale(0.6); opacity: 0; }
      55%  { transform: translateY(8px)    rotate(8deg)   scale(1.08); opacity: 1; }
      75%  { transform: translateY(-3px)   rotate(-4deg)  scale(0.97); }
      100% { transform: translateY(0)      rotate(0)      scale(1); opacity: 1; }
    }
    @keyframes bsweep-launcher-wiggle {
      from { transform: rotate(-10deg); }
      to   { transform: rotate(10deg); }
    }
    @keyframes bsweep-launcher-squash {
      0%   { transform: scale(1); }
      35%  { transform: scale(1.25, 0.78); }
      70%  { transform: scale(0.86, 1.16); }
      100% { transform: scale(1); }
    }

    /* ── Selector tooltip ────────────────────── */
    #broom-tag {
      all: initial !important;
      position: fixed !important;
      pointer-events: none !important;
      z-index: 2147483646 !important;
      padding: 4px 8px !important;
      border-radius: 6px !important;
      background: rgba(15,23,42,0.92) !important;
      color: #fff !important;
      font: 600 11px/1.2 ui-monospace, "Cascadia Code", monospace !important;
      letter-spacing: 0.02em !important;
      box-shadow: 0 4px 12px rgba(0,0,0,0.18) !important;
      animation: bsweep-tag-pop 0.18s cubic-bezier(.34,1.56,.64,1) !important;
      white-space: nowrap !important;
      max-width: 320px !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
    }
    @keyframes bsweep-tag-pop {
      from { opacity: 0; transform: translateY(4px) scale(0.92); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }

    /* Pulsing highlight while picking */
    html.broom-picking #${HIGHLIGHT_ID} {
      animation: bsweep-highlight-pulse 1.4s ease-in-out infinite !important;
    }
    @keyframes bsweep-highlight-pulse {
      0%, 100% { box-shadow: 0 0 0 1px rgba(37,99,235,0.18), 0 4px 16px rgba(37,99,235,0.14); }
      50%      { box-shadow: 0 0 0 4px rgba(37,99,235,0.28), 0 8px 24px rgba(37,99,235,0.30); }
    }

    /* Element click "pop" acknowledgment */
    @keyframes bsweep-target-pop {
      0%   { transform: scale(1); }
      40%  { transform: scale(0.95); }
      100% { transform: scale(1); }
    }

    /* Sparkle puffs spawned at click points */
    .bsweep-puff {
      position: fixed !important;
      pointer-events: none !important;
      z-index: 2147483645 !important;
      font-size: 14px !important;
      line-height: 1 !important;
      opacity: 0 !important;
      animation: bsweep-puff 0.7s cubic-bezier(.2,.8,.4,1) forwards !important;
      filter: drop-shadow(0 0 6px rgba(250,204,21,0.7)) !important;
      will-change: transform, opacity !important;
    }
    @keyframes bsweep-puff {
      0%   { opacity: 0; transform: translate(-50%, -50%) scale(0.3); }
      20%  { opacity: 1; transform: translate(-50%, -50%) scale(1); }
      100% { opacity: 0; transform: translate(calc(-50% + var(--bx,0px)), calc(-50% + var(--by,0px))) scale(0.5) rotate(180deg); }
    }

    /* Screen shake — used at sweep finale */
    html.bsweep-shake { animation: bsweep-shake 0.32s cubic-bezier(.36,.07,.19,.97) !important; }
    @keyframes bsweep-shake {
      10%, 90%  { transform: translate(-1px, 0); }
      20%, 80%  { transform: translate(2px, 0); }
      30%, 50%, 70% { transform: translate(-3px, 1px); }
      40%, 60%  { transform: translate(3px, -1px); }
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

    /* ── Panel feedback states ───────────────── */
    #${PANEL_ID}.thinking .bp-btn.primary {
      background: linear-gradient(110deg, #2563eb 30%, #93c5fd 50%, #7c3aed 70%) !important;
      background-size: 220% 100% !important;
      animation: bsweep-shimmer 1.1s linear infinite !important;
      pointer-events: none !important;
    }
    @keyframes bsweep-shimmer {
      from { background-position: 220% 0; }
      to   { background-position: -120% 0; }
    }
    #${PANEL_ID}.success {
      animation: bsweep-success 0.55s ease-out !important;
    }
    @keyframes bsweep-success {
      0%, 100% { box-shadow: 0 24px 60px rgba(15,23,42,0.20), 0 2px 8px rgba(15,23,42,0.08); }
      40%      { box-shadow: 0 0 0 4px rgba(34,197,94,0.45), 0 24px 60px rgba(15,23,42,0.20); }
    }

    /* ── Empty plant slot (visible in plant mode) ─── */
    .broom-empty-slot {
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      box-sizing: border-box !important;
      vertical-align: top !important;
      margin: 4px 0 !important;
      border-radius: 14px !important;
      outline: 2px dashed rgba(80,160,100,0.0) !important;
      outline-offset: -4px !important;
      background: rgba(80,160,100,0.04) !important;
      cursor: ${SHOVEL_CURSOR_DATA_URL} !important;
      transition: outline-color 160ms ease, background 160ms ease, transform 160ms ease, box-shadow 160ms ease !important;
      animation: broom-slot-breathe 3.2s ease-in-out infinite !important;
      position: relative !important;
      overflow: hidden !important;
    }
    .broom-empty-slot:hover, .broom-empty-slot:focus-visible {
      outline-color: rgba(80,160,100,0.7) !important;
      background: rgba(80,160,100,0.10) !important;
      box-shadow: 0 6px 20px rgba(56,161,105,0.18) !important;
      transform: translateY(-1px) !important;
    }
    .broom-empty-slot:focus-visible { outline-style: solid !important; }
    .broom-empty-slot-label {
      display: inline-flex !important;
      align-items: center !important;
      gap: 6px !important;
      padding: 5px 12px !important;
      border-radius: 999px !important;
      background: rgba(56,161,105,0.92) !important;
      color: #fff !important;
      font: 600 12px/1 -apple-system, system-ui, sans-serif !important;
      letter-spacing: 0.01em !important;
      box-shadow: 0 4px 12px rgba(56,161,105,0.3) !important;
      opacity: 0 !important;
      transform: translateY(4px) !important;
      transition: opacity 160ms ease, transform 160ms ease !important;
      pointer-events: none !important;
    }
    .broom-empty-slot:hover .broom-empty-slot-label,
    .broom-empty-slot:focus-visible .broom-empty-slot-label {
      opacity: 1 !important;
      transform: translateY(0) !important;
    }
    .broom-empty-slot-icon { font-size: 14px !important; }
    @keyframes broom-slot-breathe {
      0%, 100% { background: rgba(80,160,100,0.04); }
      50%      { background: rgba(80,160,100,0.10); }
    }

    /* ── Planted decoration ──────────────────── */
    .broom-plant-slot {
      display: inline-block !important;
      vertical-align: top !important;
      pointer-events: none !important;
      line-height: 1 !important;
      overflow: visible !important;
    }
    .broom-plant {
      position: relative !important;
      display: inline-flex !important;
      flex-direction: column !important;
      align-items: center !important;
      justify-content: flex-end !important;
      transform-origin: bottom center !important;
      user-select: none !important;
      pointer-events: none !important;
      filter: drop-shadow(0 6px 8px rgba(15,23,42,0.16)) !important;
    }
    .broom-plant-foliage {
      position: relative !important;
      display: block !important;
      width: 100% !important;
      flex: 1 1 auto !important;
    }
    .broom-plant-foliage svg { display: block; width: 100%; height: 100%; }
    .broom-plant-pot {
      position: relative !important;
      display: block !important;
      width: 70% !important;
      margin-top: -6% !important;
    }
    .broom-plant-pot svg { display: block; width: 100%; height: 100%; }
    .broom-plant-pot-none .broom-plant-pot { display: none !important; }
    .broom-plant-sm { width: 60px !important; height: 72px !important; }
    .broom-plant-md { width: 96px !important; height: 120px !important; }
    .broom-plant-lg { width: 140px !important; height: 176px !important; }
    .broom-plant-anim-gentle-sway {
      animation: broom-plant-sway 5.5s ease-in-out infinite !important;
    }
    .broom-plant-enter {
      animation:
        broom-plant-popin 480ms cubic-bezier(.2,1.4,.4,1) both,
        broom-plant-sway 5.5s ease-in-out infinite 480ms !important;
    }
    @keyframes broom-plant-popin {
      0%   { opacity: 0; transform: scale(0.78) translateY(10px) rotate(-3deg); }
      55%  { opacity: 1; transform: scale(1.08) translateY(-3px) rotate(2deg); }
      100% { opacity: 1; transform: scale(1) translateY(0) rotate(0); }
    }
    @keyframes broom-plant-sway {
      0%   { transform: rotate(-1.4deg); }
      50%  { transform: rotate(1.4deg); }
      100% { transform: rotate(-1.4deg); }
    }

    /* ── Plant toast ─────────────────────────── */
    #${PLANT_TOAST_ID} {
      all: initial !important;
      position: fixed !important;
      bottom: 96px !important;
      right: 22px !important;
      z-index: 2147483647 !important;
      display: inline-flex !important;
      align-items: center !important;
      gap: 10px !important;
      padding: 10px 14px 10px 12px !important;
      border-radius: 14px !important;
      background: rgba(15,23,42,0.92) !important;
      color: #f1f5f9 !important;
      border: 1px solid rgba(56,161,105,0.4) !important;
      border-left: 4px solid #38a169 !important;
      box-shadow: 0 16px 40px rgba(15,23,42,0.32), 0 2px 8px rgba(15,23,42,0.18) !important;
      font: 600 13px/1.2 -apple-system, system-ui, sans-serif !important;
      backdrop-filter: blur(14px) saturate(1.3) !important;
      -webkit-backdrop-filter: blur(14px) saturate(1.3) !important;
      animation: broom-toast-in 0.32s cubic-bezier(.34,1.56,.64,1) !important;
    }
    #${PLANT_TOAST_ID}.bpt-leaving {
      animation: broom-toast-out 0.22s ease-in forwards !important;
    }
    #${PLANT_TOAST_ID} .bpt-leaf { font-size: 16px !important; }
    #${PLANT_TOAST_ID} .bpt-msg { flex: 1 1 auto !important; color: #f8fafc !important; }
    #${PLANT_TOAST_ID} .bpt-btn {
      all: unset;
      cursor: pointer;
      padding: 5px 10px;
      border-radius: 8px;
      font: 600 12px/1 -apple-system, system-ui, sans-serif;
      color: #cdfbe2;
      background: rgba(56,161,105,0.18);
      border: 1px solid rgba(56,161,105,0.35);
      transition: background 0.12s, transform 0.1s;
    }
    #${PLANT_TOAST_ID} .bpt-btn:hover { background: rgba(56,161,105,0.32); }
    #${PLANT_TOAST_ID} .bpt-btn:active { transform: scale(0.96); }
    @keyframes broom-toast-in {
      0%   { opacity: 0; transform: translateY(12px) scale(0.95); }
      100% { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes broom-toast-out {
      0%   { opacity: 1; transform: translateY(0) scale(1); }
      100% { opacity: 0; transform: translateY(8px) scale(0.96); }
    }

    /* ── Reduced motion ──────────────────────── */
    @media (prefers-reduced-motion: reduce) {
      #${LAUNCHER_ID}, #${LAUNCHER_ID}.active, #${LAUNCHER_ID}.squash,
      .${SWEEP_ID} .bsweep-broom, .${SWEEP_ID} .bsweep-sparkle,
      #broom-tag, html.broom-picking #${HIGHLIGHT_ID},
      html.bsweep-shake, .bsweep-puff,
      #${PANEL_ID}, #${PANEL_ID}.thinking .bp-btn.primary, #${PANEL_ID}.success,
      #${LAUNCHER_WRAP_ID} .broom-fan-chip,
      .broom-empty-slot, .broom-empty-slot-label,
      .broom-plant, .broom-plant-enter, .broom-plant-anim-gentle-sway,
      #${PLANT_TOAST_ID}, #${PLANT_TOAST_ID}.bpt-leaving {
        animation: none !important;
        transition: none !important;
      }
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

function isOurUI(el) { return !!el?.closest?.(OUR_UI_SELECTOR + ",#broom-tag,.bsweep-puff"); }

// ── Juice helpers ─────────────────────────────────────────────────────────────

const SPARKLE_GLYPHS = ["✨", "✦", "✧", "⭐", "💫"];

// Spawn a small burst of sparkles at viewport coords (for clicks/successes).
function spawnSparklePuff(x, y, count = 6, spread = 60) {
  for (let i = 0; i < count; i++) {
    const s = document.createElement("div");
    s.className = "bsweep-puff";
    s.textContent = SPARKLE_GLYPHS[i % SPARKLE_GLYPHS.length];
    const angle = (i / count) * Math.PI * 2 + Math.random() * 0.6;
    const dist = spread * (0.6 + Math.random() * 0.8);
    s.style.left = `${x}px`;
    s.style.top = `${y}px`;
    s.style.fontSize = `${10 + Math.random() * 8}px`;
    s.style.setProperty("--bx", `${Math.cos(angle) * dist}px`);
    s.style.setProperty("--by", `${Math.sin(angle) * dist - 10}px`);
    s.style.animationDelay = `${Math.random() * 80}ms`;
    document.documentElement.appendChild(s);
    setTimeout(() => s.remove(), 900);
  }
}

let tagEl = null;
function showSelectorTag(el) {
  if (!tagEl) {
    tagEl = document.createElement("div");
    tagEl.id = "broom-tag";
    document.documentElement.appendChild(tagEl);
  }
  // Compact label: tag + first stable class or id
  const tag = el.tagName.toLowerCase();
  let extra = "";
  if (el.id) extra = `#${el.id}`;
  else if (el.classList.length) extra = `.${[...el.classList].slice(0, 2).join(".")}`;
  tagEl.textContent = `${tag}${extra}`;
  // Position above the target rect; clamp to viewport
  const r = el.getBoundingClientRect();
  const top = Math.max(8, r.top - 26);
  const left = Math.max(8, Math.min(innerWidth - 200, r.left));
  tagEl.style.top = `${top}px`;
  tagEl.style.left = `${left}px`;
}
function hideSelectorTag() {
  tagEl?.remove();
  tagEl = null;
}

function screenShake() {
  const html = document.documentElement;
  html.classList.remove("bsweep-shake");
  // force reflow so the animation restarts
  void html.offsetWidth;
  html.classList.add("bsweep-shake");
  setTimeout(() => html.classList.remove("bsweep-shake"), 360);
}

// Brief pop on the target element to acknowledge selection, then call cb.
function popTargetThen(el, cb) {
  if (!el?.isConnected) { cb(); return; }
  const prev = el.style.animation;
  el.style.animation = "bsweep-target-pop 0.22s cubic-bezier(.34,1.56,.64,1)";
  setTimeout(() => {
    if (el.isConnected) el.style.animation = prev;
    cb();
  }, 180);
}

function onOver(e) {
  if (activeMode !== "broom" || isOurUI(e.target)) return;
  pickerTarget = e.target;
  const r = e.target.getBoundingClientRect();
  const h = document.getElementById(HIGHLIGHT_ID);
  if (h) {
    Object.assign(h.style, {
      top: `${r.top}px`, left: `${r.left}px`,
      width: `${r.width}px`, height: `${r.height}px`,
    });
  }
  showSelectorTag(e.target);
}

function onClick(e) {
  if (activeMode !== "broom" || isOurUI(e.target)) return;
  e.preventDefault(); e.stopPropagation();
  pickerTarget = e.target;
  const target = e.target;
  spawnSparklePuff(e.clientX, e.clientY, 6, 50);
  const selector = buildSelector(target);
  stopPicker();
  void playSweepAndHide(target, selector);
}

// Global keydown — always active. Esc exits brooming/closes panel.
// Enter while a target is highlighted instantly hides it with a sweep animation.
function globalKeydown(e) {
  if (e.key === "Escape") {
    let handled = false;
    if (activeMode) { stopMode(); handled = true; }
    if (document.getElementById(PANEL_ID)) { closePanel(); handled = true; }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
    return;
  }
  if (e.key === "Enter" && activeMode === "broom" && pickerTarget && !isOurUI(e.target)) {
    e.preventDefault();
    e.stopPropagation();
    const target = pickerTarget;
    const selector = buildSelector(target);
    stopPicker();
    void playSweepAndHide(target, selector);
  }
}

// ── Always-present launcher ───────────────────────────────────────────────────

const LAUNCHER_WRAP_ID = "broom-launcher-wrap";

function installLauncher() {
  if (document.getElementById(LAUNCHER_WRAP_ID)) return;
  ensurePickerStyles();

  const wrap = document.createElement("div");
  wrap.id = LAUNCHER_WRAP_ID;

  const fan = document.createElement("div");
  fan.className = "broom-fan";
  fan.innerHTML = `
    <button class="broom-fan-chip" data-mode="plant" type="button" aria-label="Plant mode">
      <span class="broom-fan-glyph">🌱</span>
      <span class="broom-fan-label">Plant</span>
    </button>
    <button class="broom-fan-chip" data-mode="broom" type="button" aria-label="Broom mode">
      <span class="broom-fan-glyph">🧹</span>
      <span class="broom-fan-label">Broom</span>
    </button>
  `;

  const main = document.createElement("button");
  main.id = LAUNCHER_ID;
  main.type = "button";
  main.title = "Broom — hover for actions";
  main.textContent = "🧹";

  wrap.appendChild(fan);
  wrap.appendChild(main);

  let collapseTimer = null;
  const expand = () => {
    clearTimeout(collapseTimer);
    wrap.classList.add("broom-fan-open");
  };
  const collapse = () => {
    clearTimeout(collapseTimer);
    collapseTimer = setTimeout(() => wrap.classList.remove("broom-fan-open"), 220);
  };

  wrap.addEventListener("mouseenter", expand);
  wrap.addEventListener("mouseleave", collapse);
  wrap.addEventListener("focusin", expand);
  wrap.addEventListener("focusout", (e) => {
    if (!wrap.contains(e.relatedTarget)) collapse();
  });

  main.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    main.classList.remove("squash");
    void main.offsetWidth;
    main.classList.add("squash");
    setTimeout(() => main.classList.remove("squash"), 360);
    if (activeMode) {
      stopMode();
      hidePlantToast();
      wrap.classList.remove("broom-fan-open");
    } else {
      // Toggle expand on tap (touch / keyboard)
      wrap.classList.toggle("broom-fan-open");
    }
  }, true);

  fan.querySelectorAll(".broom-fan-chip").forEach((chip) => {
    chip.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const mode = chip.dataset.mode;
      const r = chip.getBoundingClientRect();
      spawnSparklePuff(r.left + r.width / 2, r.top + r.height / 2, 6, 50);
      wrap.classList.remove("broom-fan-open");
      if (activeMode === mode) stopMode();
      else startMode(mode);
    }, true);
  });

  document.documentElement.appendChild(wrap);
}

// ── Sweep animation — broom passes over the element, sparkles fly out ─────────

async function playSweepAndHide(el, selector) {
  if (!el || !el.isConnected) {
    // Element gone — just persist the rule.
    const rule = makeHideRule(selector, null);
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
    const rule = makeHideRule(selector, { width: rect.width, height: rect.height });
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

  // Final burst as the broom exits — fired ~200ms before the rule lands
  setTimeout(() => {
    const cx = rect.left + rect.width * 0.2;
    const cy = rect.top + rect.height / 2;
    spawnSparklePuff(cx, cy, 10, Math.max(60, rect.width * 0.4));
  }, 760);

  await new Promise((r) => setTimeout(r, 950));

  // Persist rule (display:none takes over from the animation).
  const rule = makeHideRule(selector, { width: rect.width, height: rect.height });
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
    panel.classList.add("thinking");
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
      // Success feedback: panel glows green, target sparkles, then close
      panel.classList.remove("thinking");
      panel.classList.add("success");
      const targetEl = safeQueryAll(res.rule.selector.primary)[0];
      if (targetEl) {
        const tr = targetEl.getBoundingClientRect();
        spawnSparklePuff(tr.left + tr.width / 2, tr.top + tr.height / 2, 8, 60);
      }
      setTimeout(() => closePanel(), 480);
    } catch (e) {
      panel.classList.remove("thinking");
      errEl.textContent = e.message;
      errEl.style.display = "block";
      statusEl.textContent = "";
    }
  });
}

function closePanel() { document.getElementById(PANEL_ID)?.remove(); }

function makeHideRule(selector, originalBox) {
  const payload = { kind: "hide" };
  if (originalBox && originalBox.width && originalBox.height) {
    payload.originalBox = { width: originalBox.width, height: originalBox.height };
  }
  return { id: uuid(), hostname: location.hostname, type: "hide", selector: { primary: selector, fallbacks: [], semantic: "" }, payload, enabled: true, createdAt: Date.now(), lastAppliedAt: null, lastFailedAt: null, failCount: 0 };
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

// ── Planting: empty slot affordances + click handler + toast ─────────────────

const EMPTY_SLOT_ATTR = "data-broom-slot-for";

function renderEmptySlotAffordances() {
  const plantedSourceIds = new Set(
    appliedRules
      .filter((r) => r.payload && r.payload.kind === "plant")
      .map((r) => r.payload.sourceRuleId)
  );
  const hideRuleIds = new Set(
    appliedRules.filter((r) => r.payload && r.payload.kind === "hide").map((r) => r.id)
  );

  // Remove slots that got planted or whose hide rule no longer exists
  document.querySelectorAll(`[${EMPTY_SLOT_ATTR}]`).forEach((el) => {
    const id = el.getAttribute(EMPTY_SLOT_ATTR);
    if (plantedSourceIds.has(id) || !hideRuleIds.has(id)) el.remove();
  });

  // Add slots that are missing — never touch ones already in the DOM
  for (const rule of appliedRules) {
    if (!rule.payload || rule.payload.kind !== "hide") continue;
    if (plantedSourceIds.has(rule.id)) continue;
    const escId = rule.id.replace(/"/g, '\\"');
    if (document.querySelector(`[${EMPTY_SLOT_ATTR}="${escId}"]`)) continue;
    const anchor = resolveSelector(rule.selector.primary, rule.selector.fallbacks);
    if (!anchor) continue;
    const slot = createEmptySlot(rule);
    if (anchor.parentNode) anchor.parentNode.insertBefore(slot, anchor.nextSibling);
  }
}

function removeEmptySlotAffordances() {
  document.querySelectorAll(`[${EMPTY_SLOT_ATTR}]`).forEach((n) => n.remove());
}

function createEmptySlot(hideRule) {
  const box = (hideRule.payload && hideRule.payload.originalBox) || { width: 120, height: 120 };
  const w = Math.max(80, Math.min(box.width || 120, 480));
  const h = Math.max(80, Math.min(box.height || 120, 360));
  const slot = document.createElement("div");
  slot.className = "broom-empty-slot";
  slot.setAttribute(EMPTY_SLOT_ATTR, hideRule.id);
  slot.setAttribute("role", "button");
  slot.setAttribute("tabindex", "0");
  slot.setAttribute("aria-label", "Plant something here");
  slot.style.width = `${w}px`;
  slot.style.height = `${h}px`;

  const label = document.createElement("div");
  label.className = "broom-empty-slot-label";
  label.innerHTML = `<span class="broom-empty-slot-icon">🌱</span><span>Plant here</span>`;
  slot.appendChild(label);

  const activate = (e) => {
    e.preventDefault();
    e.stopPropagation();
    void onEmptySlotClick(hideRule, slot, e);
  };
  slot.addEventListener("click", activate);
  slot.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") activate(e);
  });
  return slot;
}

async function onEmptySlotClick(hideRule, slotEl, evt) {
  const plant = chooseRandomPlant(hideRule);
  const decorateRule = makePlantRule(hideRule, plant);

  // Optimistic local apply, then persist.
  appliedRules = [...appliedRules, decorateRule];
  if (slotEl) slotEl.remove();
  applyPlant(decorateRule, { enterAnimation: true });

  if (evt && typeof evt.clientX === "number") {
    spawnSparklePuff(evt.clientX, evt.clientY, 6, 50);
  }

  await upsertRuleLocal(decorateRule);
  showPlantToast(decorateRule, hideRule);
}

function makePlantRule(hideRule, plant) {
  return {
    id: uuid(),
    hostname: location.hostname,
    type: "decorate",
    selector: {
      primary: hideRule.selector.primary,
      fallbacks: Array.isArray(hideRule.selector.fallbacks) ? [...hideRule.selector.fallbacks] : [],
      semantic: hideRule.selector.semantic || ""
    },
    payload: {
      kind: "plant",
      decoration: "plant",
      sourceRuleId: hideRule.id,
      plant,
      generatedBy: "random"
    },
    enabled: true,
    createdAt: Date.now(),
    lastAppliedAt: null,
    lastFailedAt: null,
    failCount: 0
  };
}

const PLANT_TOAST_ID = "broom-plant-toast";
let plantToastTimer = null;

function showPlantToast(decorateRuleInit, hideRule) {
  hidePlantToast();
  let decorateRule = decorateRuleInit;

  const toast = document.createElement("div");
  toast.id = PLANT_TOAST_ID;
  toast.innerHTML = `
    <span class="bpt-leaf">🌱</span>
    <span class="bpt-msg"></span>
    <button class="bpt-btn" data-act="shuffle" type="button">Shuffle</button>
    <button class="bpt-btn" data-act="remove" type="button">Remove</button>
  `;
  document.documentElement.appendChild(toast);
  const msgEl = toast.querySelector(".bpt-msg");
  const setMsg = (kind) => {
    msgEl.textContent = `${PLANT_NAMES[kind] || "Plant"} planted`;
  };
  setMsg(decorateRule.payload.plant.kind);

  toast.querySelector('[data-act="shuffle"]').addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const next = chooseRandomPlant(hideRule);
    const updated = {
      ...decorateRule,
      payload: { ...decorateRule.payload, plant: next, generatedBy: "random" }
    };
    const escId = decorateRule.id.replace(/"/g, '\\"');
    document.querySelectorAll(`[${INJECTED_ATTR}="${escId}"]`).forEach((n) => n.remove());
    const idx = appliedRules.findIndex((r) => r.id === decorateRule.id);
    if (idx >= 0) appliedRules[idx] = updated;
    applyPlant(updated, { enterAnimation: true });
    await upsertRuleLocal(updated);
    decorateRule = updated;
    setMsg(next.kind);
    armPlantToastDismiss();
  });

  toast.querySelector('[data-act="remove"]').addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const escId = decorateRule.id.replace(/"/g, '\\"');
    document.querySelectorAll(`[${INJECTED_ATTR}="${escId}"]`).forEach((n) => n.remove());
    appliedRules = appliedRules.filter((r) => r.id !== decorateRule.id);
    if (activeMode === "plant") renderEmptySlotAffordances();
    await deleteRuleLocal(decorateRule.hostname, decorateRule.id);
    hidePlantToast();
  });

  toast.addEventListener("mouseenter", () => clearTimeout(plantToastTimer));
  toast.addEventListener("mouseleave", armPlantToastDismiss);
  armPlantToastDismiss();
}

function armPlantToastDismiss() {
  clearTimeout(plantToastTimer);
  plantToastTimer = setTimeout(hidePlantToast, 4500);
}

function hidePlantToast() {
  clearTimeout(plantToastTimer);
  plantToastTimer = null;
  const toast = document.getElementById(PLANT_TOAST_ID);
  if (!toast) return;
  toast.classList.add("bpt-leaving");
  setTimeout(() => toast.remove(), 240);
}

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
    if (r.payload.kind === "inject" || r.payload.kind === "plant") applyRule(r);
  }
  if (activeMode === "plant") renderEmptySlotAffordances();
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
