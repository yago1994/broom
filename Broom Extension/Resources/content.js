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

async function clearRulesForHost(hostname) {
  const r = await chrome.storage.local.get(RULES_KEY);
  const map = r[RULES_KEY] ?? {};
  delete map[hostname];
  await chrome.storage.local.set({ [RULES_KEY]: map });
}

// ── Prefs (sound on/off, etc.) ───────────────────────────────────────────────

const PREFS_KEY = "prefs";
const DEFAULT_PREFS = { soundEnabled: true, showChanges: true };
let cachedPrefs = { ...DEFAULT_PREFS };

async function loadPrefs() {
  try {
    const r = await chrome.storage.local.get(PREFS_KEY);
    cachedPrefs = { ...DEFAULT_PREFS, ...(r[PREFS_KEY] || {}) };
  } catch { cachedPrefs = { ...DEFAULT_PREFS }; }
  return cachedPrefs;
}

async function setPref(key, value) {
  cachedPrefs = { ...cachedPrefs, [key]: value };
  await chrome.storage.local.set({ [PREFS_KEY]: cachedPrefs });
}

function getVersionAndBuild() {
  const raw = String(chrome.runtime?.getManifest?.()?.version || "0").trim();
  const paren = raw.match(/^([\d.]+)\s*\((\d+)\)$/);
  if (paren) return { version: paren[1], build: paren[2] };
  const parts = raw.split(".");
  const build = parts.length >= 4 ? parts[3] : "1";
  let head = parts.slice(0, Math.min(3, parts.length));
  while (head.length > 2 && head[head.length - 1] === "0") head.pop();
  return { version: head.join("."), build };
}

// Plant catalog (POT_SVGS, PLANT_SVGS, PLANT_NAMES) is defined in lib/plants.js

const SHOVEL_CURSOR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path d="M22 3 l7 7 -3 3 -2 -2 -10 10 -3 -3 10 -10 -2 -2 z" fill="#caa376" stroke="#5a4424" stroke-width="1.4" stroke-linejoin="round"/><path d="M11 17 l-5 5 q-3 3 -1 5 q2 2 5 -1 l5 -5 z" fill="#7e8a96" stroke="#3a4047" stroke-width="1.4" stroke-linejoin="round"/></svg>`;

// Fertile soil mound with a tiny sprout — shown inside empty plant slots
// to clearly signal "plantable area" before any plant is placed.
const SOIL_MOUND_SVG = `<svg viewBox="0 0 100 60" preserveAspectRatio="xMidYMax meet" aria-hidden="true">
  <ellipse cx="50" cy="56" rx="42" ry="6" fill="#2a1c10" opacity="0.22"/>
  <path d="M10 52 Q22 28 50 24 Q78 28 90 52 Q70 58 50 58 Q30 58 10 52 Z" fill="#6b4423"/>
  <path d="M14 50 Q26 32 50 28 Q74 32 86 50 Q70 46 50 44 Q30 46 14 50 Z" fill="#825330"/>
  <g fill="#4a2f1a"><circle cx="28" cy="44" r="2.2"/><circle cx="40" cy="36" r="1.6"/><circle cx="60" cy="34" r="1.8"/><circle cx="72" cy="42" r="2"/><circle cx="50" cy="42" r="1.6"/><circle cx="34" cy="50" r="1.4"/><circle cx="66" cy="50" r="1.4"/></g>
  <g fill="#9a6b3e"><circle cx="22" cy="48" r="1"/><circle cx="46" cy="32" r="1"/><circle cx="68" cy="38" r="1"/><circle cx="80" cy="48" r="1"/></g>
  <g stroke="#3a7a3f" stroke-width="1.4" fill="none" stroke-linecap="round"><path d="M50 28 Q50 18 50 12"/></g>
  <path d="M50 18 q-7 -4 -10 -10 q4 -1 10 4 z" fill="#5db867" stroke="#2e6b35" stroke-width="0.8"/>
  <path d="M50 14 q7 -3 10 -8 q-3 -1 -10 4 z" fill="#7bd180" stroke="#2e6b35" stroke-width="0.8"/>
</svg>`;
const SHOVEL_CURSOR_DATA_URL = `url('data:image/svg+xml;utf8,${encodeURIComponent(SHOVEL_CURSOR_SVG)}') 6 26, pointer`;

function randomFrom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function chooseRandomPlant(hideRule) {
  const box = (hideRule.payload && hideRule.payload.originalBox) || { width: 120, height: 120 };
  const h = box.height;
  const small = ["succulent", "fern", "snake-plant", "cactus", "aloe", "lavender", "pine", "tulips", "topiary", "air-plant"];
  const medium = ["pothos", "fern", "snake-plant", "monstera", "cactus", "aloe", "peace-lily", "calathea", "orchid", "zz-plant", "spider-plant", "cherry-blossom", "eucalyptus", "tulips", "sunflower", "topiary", "string-of-pearls"];
  const large = ["bird-of-paradise", "monstera", "pothos", "bamboo", "palm", "fiddle-leaf", "orchid", "zz-plant", "spider-plant", "pampas", "cherry-blossom", "eucalyptus", "sunflower"];
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
  if (cachedPrefs.showChanges === false) { removeRule(rule.id); return; }
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

// Plants render in-page: an inline-block .broom-plant-slot wrapper is
// inserted as a sibling of the (now display:none) anchor, and the plant
// SVG lives inside it. The slot caps to the original swept element's
// dimensions so the plant can never visually exceed the area the user
// cleared. Inside, the plant scales down via max-width/max-height: 100%.

function applyPlant(rule, options) {
  const anchor = resolveSelector(rule.selector.primary, rule.selector.fallbacks);
  if (!anchor) return;
  const escId = rule.id.replace(/"/g, '\\"');
  if (document.querySelector(`[${INJECTED_ATTR}="${escId}"]`)) return;

  const slot = document.createElement("div");
  slot.setAttribute(INJECTED_ATTR, rule.id);
  slot.className = "broom-plant-slot";

  const box = (rule.payload && rule.payload.originalBox)
    || (() => {
      const hide = appliedRules.find((r) => r.id === (rule.payload && rule.payload.sourceRuleId));
      return hide && hide.payload && hide.payload.originalBox;
    })()
    || null;
  if (box && box.width && box.height) {
    slot.style.maxWidth = `${box.width}px`;
    slot.style.maxHeight = `${box.height}px`;
  }

  const plant = renderPlant(rule.payload.plant);
  if (options && options.enterAnimation) {
    plant.classList.add("broom-plant-enter");
    // Sound and soil burst sync with foliage emergence (~350ms after pot)
    setTimeout(() => {
      playPlantSound();
      [
        { px: -22, py: -14, color: "#825330", dur: 460, delay: 0  },
        { px: -11, py: -25, color: "#6b4423", dur: 490, delay: 20 },
        {  px: 2,  py: -28, color: "#9a6b3e", dur: 510, delay: 40 },
        { px:  14, py: -23, color: "#7e5530", dur: 470, delay: 20 },
        { px:  23, py: -12, color: "#4a2f1a", dur: 450, delay: 10 },
      ].forEach(({ px, py, color, dur, delay }) => {
        const p = document.createElement("span");
        p.className = "broom-plant-particle";
        p.style.cssText = `--px:${px}px;--py:${py}px;background:${color};--dur:${dur}ms;--delay:${delay}ms`;
        slot.appendChild(p);
      });
    }, 350);
  }
  slot.appendChild(plant);

  slot.addEventListener("mouseenter", () => {
    if (document.documentElement.dataset.broomMode === "broom") return;
    if (plant.classList.contains("broom-plant-enter")) return;
    plant.classList.remove("broom-plant-hovering");
    void plant.offsetWidth;
    plant.classList.add("broom-plant-hovering");
  });
  slot.addEventListener("mouseleave", () => {
    plant.classList.remove("broom-plant-hovering");
  });
  slot.addEventListener("click", (e) => {
    if (activeMode !== null) return;
    if (plant.classList.contains("broom-plant-enter")) return;
    spawnRaindrop(slot, plant, e);
  });
  plant.addEventListener("animationend", (e) => {
    if (e.animationName === "broom-plant-popin") {
      plant.classList.remove("broom-plant-enter");
    }
  });

  if (anchor.parentNode) anchor.parentNode.insertBefore(slot, anchor.nextSibling);
}

const RAINDROP_SVG = `<svg viewBox="0 0 12 18" aria-hidden="true"><path d="M6 1 Q11 9 11 13 Q11 17 6 17 Q1 17 1 13 Q1 9 6 1 Z" fill="#5aa8e8" stroke="#3a78b8" stroke-width="0.8"/><ellipse cx="4" cy="6" rx="1.2" ry="2" fill="#a8d4f0" opacity="0.7"/></svg>`;

function spawnRaindrop(slot, plant, event) {
  const rect = slot.getBoundingClientRect();
  const clickX = event && typeof event.clientX === "number"
    ? Math.max(8, Math.min(rect.width - 8, event.clientX - rect.left))
    : rect.width / 2;
  const foliage = plant.querySelector(".broom-plant-foliage");
  const pot = plant.querySelector(".broom-plant-pot");
  const hasPot = !plant.classList.contains("broom-plant-pot-none") && pot;
  let landingY;
  if (hasPot) {
    // Land 6px above the top of the pot
    const potRect = pot.getBoundingClientRect();
    landingY = (potRect.top - rect.top) - 6;
  } else {
    // No pot: land 12px above the bottom of the foliage
    const foliageRect = foliage ? foliage.getBoundingClientRect() : rect;
    landingY = (foliageRect.top - rect.top) + foliageRect.height - 12;
  }

  const drop = document.createElement("span");
  drop.className = "broom-raindrop";
  drop.innerHTML = RAINDROP_SVG;
  drop.style.cssText = `left:${clickX}px;--fall-y:${landingY}px`;
  slot.appendChild(drop);

  try {
    const audio = new Audio(chrome.runtime.getURL("pop.mp3"));
    audio.volume = 0.3;
    audio.playbackRate = 1.4;
    if (cachedPrefs.soundEnabled !== false) audio.play().catch(() => {});
  } catch (_) {}

  drop.addEventListener("animationend", () => {
    drop.remove();
    if (foliage) {
      foliage.classList.remove("broom-plant-watered");
      void foliage.offsetWidth;
      foliage.classList.add("broom-plant-watered");
    }
    [
      { px: -10, py: -4, dur: 420, delay: 0 },
      { px:  -4, py: -8, dur: 460, delay: 30 },
      { px:   4, py: -8, dur: 460, delay: 20 },
      { px:  10, py: -4, dur: 420, delay: 40 },
    ].forEach(({ px, py, dur, delay }) => {
      const s = document.createElement("span");
      s.className = "broom-plant-particle broom-plant-splash";
      s.style.cssText = `left:${clickX}px;bottom:auto;top:${landingY}px;--px:${px}px;--py:${py}px;background:#7ab8e8;--dur:${dur}ms;--delay:${delay}ms`;
      slot.appendChild(s);
      s.addEventListener("animationend", () => s.remove(), { once: true });
    });
  }, { once: true });

  if (foliage) {
    foliage.addEventListener("animationend", function onWater(e) {
      if (e.animationName === "broom-plant-wiggle") {
        foliage.classList.remove("broom-plant-watered");
        foliage.removeEventListener("animationend", onWater);
      }
    });
  }
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
const LAUNCHER_WRAP_ID = "broom-launcher-wrap";
const SWEEP_ID = "broom-sweep";
const UNDO_TOAST_ID = "broom-undo-toast";
const SETTINGS_ID = "broom-settings";
const BROOM_CURSOR_ID = "broom-cursor-follower";
const OUR_UI_SELECTOR = `#${PANEL_ID},#${HIGHLIGHT_ID},#${LAUNCHER_ID},#${LAUNCHER_WRAP_ID},#${UNDO_TOAST_ID},#${SETTINGS_ID},#${BROOM_CURSOR_ID},[id^="${SWEEP_ID}"]`;

let undoToastTimer = null;
let broomSession = []; // rules swept in the current/most-recent broom session

let activeMode = null; // "broom" | "plant" | "restore" | null
let pickerTarget = null;

// Restore-mode state
const RESTORE_OVERLAY_ATTR = "data-broom-restore-for";
let restoreSuspended = new Map(); // ruleId → suspended hide CSS
let restoreReposition = null;
let restoreScrollHandler = null;
let restoreResizeHandler = null;
let restoreObserver = null;

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
  if (launcher) launcher.textContent = mode === "plant" ? "🌱" : mode === "restore" ? "♻️" : "🧹";

  if (mode === "broom") {
    broomSession = [];
    hideUndoToast();
    document.documentElement.classList.add("broom-picking");
    ensureHighlight();
    ensureBroomCursor();
    document.addEventListener("mouseover", onOver, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("mousemove", onCursorMove, true);
  } else if (mode === "plant") {
    renderEmptySlotAffordances();
  } else if (mode === "restore") {
    enterRestoreMode();
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
  if (launcher) launcher.textContent = "🧹";
  document.getElementById(HIGHLIGHT_ID)?.remove();
  document.getElementById(BROOM_CURSOR_ID)?.remove();
  hideSelectorTag();
  document.removeEventListener("mouseover", onOver, true);
  document.removeEventListener("click", onClick, true);
  document.removeEventListener("mousemove", onCursorMove, true);
  if (prev === "plant") removeEmptySlotAffordances();
  if (prev === "restore") exitRestoreMode();
}

// Backward-compat aliases (popup still sends CONTENT_START_PICKER → broom mode)
function startPicker() { startMode("broom"); }
function stopPicker() { stopMode(); }

function ensurePickerStyles() {
  let s = document.getElementById(OVERLAY_STYLE_ID);
  if (!s) {
    s = document.createElement("style");
    s.id = OVERLAY_STYLE_ID;
    document.documentElement.appendChild(s);
  }
  s.textContent = pickerStylesheet();
}

function pickerStylesheet() {
  return `
    html.broom-picking, html.broom-picking * {
      cursor: none !important;
      user-select: none !important;
    }
    #${BROOM_CURSOR_ID} {
      position: fixed !important;
      top: 0 !important; left: 0 !important;
      pointer-events: none !important;
      z-index: 2147483646 !important;
      width: 64px !important; height: 64px !important;
      will-change: transform;
      transform: translate3d(-100px, -100px, 0);
    }
    #${BROOM_CURSOR_ID} .broom-cursor-glyph {
      display: block;
      width: 64px; height: 64px;
      font: 60px/64px "Apple Color Emoji", "Segoe UI Emoji", serif;
      text-align: center;
      transform-origin: 6px 58px;
      transform: rotate(0deg);
      will-change: transform;
    }
    #${BROOM_CURSOR_ID} .broom-cursor-glyph.wiggling {
      animation: bsweep-cursor-wiggle 420ms cubic-bezier(.22, 1.4, .36, 1) both;
    }
    @keyframes bsweep-cursor-wiggle {
      0%   { transform: rotate(0deg); }
      18%  { transform: rotate(-14deg); }
      42%  { transform: rotate(10deg); }
      64%  { transform: rotate(-6deg); }
      82%  { transform: rotate(3deg); }
      100% { transform: rotate(0deg); }
    }
    @media (prefers-reduced-motion: reduce) {
      #${BROOM_CURSOR_ID} .broom-cursor-glyph.wiggling { animation: none !important; }
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
    }

    /* ── Persistent launcher ─────────────────── */
    #${LAUNCHER_WRAP_ID} {
      all: initial !important;
      position: fixed !important;
      bottom: 22px !important;
      right: 22px !important;
      width: 54px !important;
      height: 54px !important;
      z-index: 2147483640 !important;
      font-family: -apple-system, system-ui, sans-serif !important;
    }
    #${LAUNCHER_ID} {
      all: initial !important;
      position: relative !important;
      width: 54px !important;
      height: 54px !important;
      border-radius: 50% !important;
      border: 1px solid rgba(107, 67, 33, 0.28) !important;
      background: rgba(255,255,255,0.98) !important;
      backdrop-filter: blur(18px) saturate(1.4) !important;
      -webkit-backdrop-filter: blur(18px) saturate(1.4) !important;
      box-shadow:
        0 14px 36px rgba(15,23,42,0.28),
        0 4px 10px rgba(15,23,42,0.14),
        inset 0 0 0 1px rgba(255,255,255,0.6) !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      font-size: 28px !important;
      line-height: 1 !important;
      cursor: pointer !important;
      user-select: none !important;
      transition: transform 0.2s cubic-bezier(.4,1.6,.5,1), box-shadow 0.18s, background 0.18s, border-color 0.18s !important;
      font-family: -apple-system, system-ui, sans-serif !important;
      padding: 0 !important;
      animation: bsweep-launcher-enter 0.85s cubic-bezier(.34,1.56,.64,1) both !important;
    }
    #${LAUNCHER_ID}:hover {
      transform: scale(1.12) rotate(-8deg) !important;
      box-shadow:
        0 18px 42px rgba(15,23,42,0.34),
        0 6px 14px rgba(15,23,42,0.18),
        inset 0 0 0 1px rgba(255,255,255,0.7) !important;
      border-color: rgba(107, 67, 33, 0.55) !important;
    }
    #${LAUNCHER_ID}:active { transform: scale(0.92) rotate(-12deg) !important; }
    #${LAUNCHER_ID}.squash { animation: bsweep-launcher-squash 0.32s cubic-bezier(.34,1.56,.64,1) !important; }
    #${LAUNCHER_ID}.active {
      background: linear-gradient(135deg, rgba(176,122,69,0.32), rgba(107,67,33,0.32)) !important;
      border-color: rgba(107,67,33,0.55) !important;
      box-shadow:
        0 14px 32px rgba(107,67,33,0.32),
        0 4px 10px rgba(107,67,33,0.18),
        inset 0 0 0 1px rgba(255,255,255,0.45) !important;
      animation: bsweep-launcher-wiggle 0.7s ease-in-out infinite alternate !important;
    }
    #${LAUNCHER_ID}[data-mode="plant"] {
      background: linear-gradient(135deg, rgba(56,161,105,0.32), rgba(108,197,81,0.32)) !important;
      border-color: rgba(56,161,105,0.5) !important;
      box-shadow:
        0 14px 32px rgba(56,161,105,0.30),
        0 4px 10px rgba(56,161,105,0.16),
        inset 0 0 0 1px rgba(255,255,255,0.45) !important;
    }
    #${LAUNCHER_ID}[data-mode="restore"] {
      background: linear-gradient(135deg, rgba(20,184,166,0.32), rgba(14,165,233,0.32)) !important;
      border-color: rgba(14,165,233,0.5) !important;
      box-shadow:
        0 14px 32px rgba(14,165,233,0.30),
        0 4px 10px rgba(14,165,233,0.16),
        inset 0 0 0 1px rgba(255,255,255,0.45) !important;
    }
    #${LAUNCHER_ID}[data-mode="broom"] {
      background: linear-gradient(135deg, rgba(176,122,69,0.36), rgba(107,67,33,0.36)) !important;
      border-color: rgba(107,67,33,0.6) !important;
      box-shadow:
        0 14px 32px rgba(107,67,33,0.32),
        0 4px 10px rgba(107,67,33,0.18),
        inset 0 0 0 1px rgba(255,255,255,0.45) !important;
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
      height: 42px !important;
      padding: 0 16px 0 14px !important;
      border-radius: 999px !important;
      background: rgba(255,255,255,0.99) !important;
      border: 1px solid rgba(107,67,33,0.24) !important;
      box-shadow:
        0 10px 24px rgba(15,23,42,0.22),
        0 3px 6px rgba(15,23,42,0.12),
        inset 0 0 0 1px rgba(255,255,255,0.6) !important;
      backdrop-filter: blur(14px) saturate(1.3) !important;
      -webkit-backdrop-filter: blur(14px) saturate(1.3) !important;
      font: 600 13px/1 -apple-system, system-ui, sans-serif !important;
      color: #1f2937 !important;
      cursor: pointer !important;
      user-select: none !important;
      opacity: 0 !important;
      transform: translateX(8px) translateY(8px) scale(0.85) !important;
      transition: opacity 0.18s ease, transform 0.24s cubic-bezier(.34,1.56,.64,1), box-shadow 0.18s, background 0.18s, border-color 0.18s, color 0.18s !important;
      pointer-events: none !important;
    }
    #${LAUNCHER_WRAP_ID} .broom-fan-chip:hover {
      box-shadow:
        0 14px 28px rgba(15,23,42,0.26),
        0 4px 8px rgba(15,23,42,0.14),
        inset 0 0 0 1px rgba(255,255,255,0.7) !important;
      transform: translateX(-2px) translateY(-2px) scale(1.05) !important;
    }
    #${LAUNCHER_WRAP_ID} .broom-fan-chip:active {
      transform: translateX(0) translateY(0) scale(0.97) !important;
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
    #${LAUNCHER_WRAP_ID}.broom-fan-open .broom-fan-chip:nth-child(1) { transition-delay: 180ms; }
    #${LAUNCHER_WRAP_ID}.broom-fan-open .broom-fan-chip:nth-child(2) { transition-delay: 120ms; }
    #${LAUNCHER_WRAP_ID}.broom-fan-open .broom-fan-chip:nth-child(3) { transition-delay: 60ms; }
    #${LAUNCHER_WRAP_ID}.broom-fan-open .broom-fan-chip:nth-child(4) { transition-delay: 0ms; }
    #${LAUNCHER_WRAP_ID} .broom-fan-chip[data-mode="plant"]:hover {
      background: linear-gradient(135deg, rgba(108,197,81,0.22), rgba(56,161,105,0.22)) !important;
      border-color: rgba(56,161,105,0.6) !important;
      color: #14532d !important;
    }
    #${LAUNCHER_WRAP_ID} .broom-fan-chip[data-mode="broom"]:hover {
      background: linear-gradient(135deg, rgba(176,122,69,0.24), rgba(107,67,33,0.24)) !important;
      border-color: rgba(107,67,33,0.6) !important;
      color: #4a2f15 !important;
    }
    #${LAUNCHER_WRAP_ID} .broom-fan-chip[data-mode="restore"]:hover {
      background: linear-gradient(135deg, rgba(20,184,166,0.22), rgba(14,165,233,0.22)) !important;
      border-color: rgba(14,165,233,0.6) !important;
      color: #0c4a6e !important;
    }
    #${LAUNCHER_WRAP_ID} .broom-fan-chip[data-action="settings"]:hover {
      background: linear-gradient(135deg, rgba(100,116,139,0.22), rgba(71,85,105,0.22)) !important;
      border-color: rgba(71,85,105,0.6) !important;
      color: #1e293b !important;
    }

    /* ── Settings popover ────────────────────── */
    #${SETTINGS_ID} {
      all: initial !important;
      position: fixed !important;
      right: 22px !important;
      bottom: 96px !important;
      z-index: 2147483647 !important;
      width: 280px !important;
      padding: 14px !important;
      border-radius: 16px !important;
      background: rgba(255,255,255,0.98) !important;
      border: 1px solid rgba(148,163,184,0.28) !important;
      box-shadow: 0 16px 40px rgba(15,23,42,0.18), 0 2px 8px rgba(15,23,42,0.08) !important;
      backdrop-filter: blur(14px) saturate(1.3) !important;
      -webkit-backdrop-filter: blur(14px) saturate(1.3) !important;
      font: 500 13px/1.35 -apple-system, system-ui, sans-serif !important;
      color: #1f2937 !important;
      animation: bsweep-settings-in 0.22s cubic-bezier(.34,1.56,.64,1) !important;
    }
    #${SETTINGS_ID}.bs-leaving { animation: bsweep-settings-out 0.16s ease-in forwards !important; }
    @keyframes bsweep-settings-in {
      0%   { opacity: 0; transform: translateY(8px) scale(0.94); }
      100% { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes bsweep-settings-out {
      to { opacity: 0; transform: translateY(6px) scale(0.96); }
    }
    #${SETTINGS_ID} .bs-version {
      font: 500 11px/1 -apple-system, system-ui, sans-serif !important;
      color: #94a3b8 !important;
      text-align: center !important;
      margin: 10px 0 2px !important;
      letter-spacing: 0.02em !important;
    }
    #${SETTINGS_ID} .bs-row {
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;
      gap: 10px !important;
      padding: 8px 4px !important;
    }
    #${SETTINGS_ID} .bs-row-label {
      flex: 1 1 auto !important;
      color: #1f2937 !important;
      font-weight: 600 !important;
    }
    #${SETTINGS_ID} .bs-row-hint {
      display: block !important;
      font-weight: 400 !important;
      color: #64748b !important;
      font-size: 11px !important;
      margin-top: 2px !important;
    }
    #${SETTINGS_ID} .bs-switch {
      position: relative !important;
      width: 38px !important;
      height: 22px !important;
      flex: 0 0 auto !important;
    }
    #${SETTINGS_ID} .bs-switch input { all: unset !important; position: absolute !important; opacity: 0 !important; inset: 0 !important; cursor: pointer !important; }
    #${SETTINGS_ID} .bs-switch-track {
      position: absolute !important;
      inset: 0 !important;
      background: rgba(122, 74, 37, 0.22) !important;
      border-radius: 999px !important;
      transition: background 0.18s ease !important;
      cursor: pointer !important;
    }
    #${SETTINGS_ID} .bs-switch-track::after {
      content: "" !important;
      position: absolute !important;
      top: 2px !important;
      left: 2px !important;
      width: 18px !important;
      height: 18px !important;
      border-radius: 50% !important;
      background: #fff !important;
      box-shadow: 0 1px 3px rgba(15,23,42,0.2) !important;
      transition: transform 0.18s cubic-bezier(.34,1.56,.64,1) !important;
    }
    #${SETTINGS_ID} .bs-switch input:checked ~ .bs-switch-track {
      background: linear-gradient(135deg, #b07a45, #6b4321) !important;
    }
    #${SETTINGS_ID} .bs-switch input:checked ~ .bs-switch-track::after {
      transform: translateX(16px) !important;
    }
    #${SETTINGS_ID} .bs-divider { height: 1px !important; background: rgba(148,163,184,0.22) !important; margin: 8px 0 !important; }
    #${SETTINGS_ID} .bs-btn {
      all: unset !important;
      display: flex !important;
      align-items: center !important;
      gap: 8px !important;
      width: 100% !important;
      box-sizing: border-box !important;
      padding: 9px 10px !important;
      border-radius: 10px !important;
      cursor: pointer !important;
      font: 600 13px/1 -apple-system, system-ui, sans-serif !important;
      color: #1f2937 !important;
      transition: background 0.12s, transform 0.1s !important;
    }
    #${SETTINGS_ID} .bs-btn:hover { background: rgba(99,102,241,0.10) !important; }
    #${SETTINGS_ID} .bs-btn:active { transform: scale(0.98) !important; }
    #${SETTINGS_ID} .bs-btn-glyph { font-size: 15px !important; }
    #${SETTINGS_ID} .bs-btn[data-act="reset"] { color: #b91c1c !important; }
    #${SETTINGS_ID} .bs-btn[data-act="reset"]:hover { background: rgba(220,38,38,0.10) !important; }
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
      filter: drop-shadow(0 4px 8px rgba(37,99,235,0.35));
    }
    .${SWEEP_ID} .bsweep-sparkle {
      will-change: transform, opacity;
      filter: drop-shadow(0 0 6px rgba(250,204,21,0.7));
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
      align-items: flex-end !important;
      justify-content: center !important;
      box-sizing: border-box !important;
      vertical-align: top !important;
      margin: 4px 0 !important;
      border-radius: 14px !important;
      outline: 2px dashed rgba(80,160,100,0.35) !important;
      outline-offset: -4px !important;
      background: rgba(80,160,100,0.06) !important;
      cursor: ${SHOVEL_CURSOR_DATA_URL} !important;
      transition: outline-color 160ms ease, background 160ms ease, transform 160ms ease, box-shadow 160ms ease !important;
      animation: broom-slot-breathe 3.2s ease-in-out infinite !important;
      position: relative !important;
      overflow: visible !important;
    }
    .broom-empty-slot:hover, .broom-empty-slot:focus-visible {
      outline-color: rgba(80,160,100,0.85) !important;
      background: rgba(80,160,100,0.12) !important;
      box-shadow: 0 6px 20px rgba(56,161,105,0.18) !important;
      transform: translateY(-1px) !important;
    }
    .broom-empty-slot:focus-visible { outline-style: solid !important; }
    .broom-empty-slot-soil {
      position: absolute !important;
      left: 50% !important;
      bottom: 8% !important;
      transform: translateX(-50%) !important;
      width: clamp(40px, 60%, 110px) !important;
      max-height: 70% !important;
      pointer-events: none !important;
      filter: drop-shadow(0 3px 4px rgba(74,47,26,0.32)) !important;
      animation: broom-soil-bob 4.8s ease-in-out infinite !important;
    }
    .broom-empty-slot-soil svg { display: block !important; width: 100% !important; height: auto !important; }
    .broom-empty-slot:hover .broom-empty-slot-soil,
    .broom-empty-slot:focus-visible .broom-empty-slot-soil {
      animation: broom-soil-wiggle 0.9s ease-in-out infinite !important;
    }
    @keyframes broom-soil-bob {
      0%, 100% { transform: translate(-50%, 0); }
      50%      { transform: translate(-50%, -2px); }
    }
    @keyframes broom-soil-wiggle {
      0%, 100% { transform: translate(-50%, 0) rotate(-1.2deg); }
      50%      { transform: translate(-50%, -3px) rotate(1.2deg); }
    }
    .broom-empty-slot-label {
      position: absolute !important;
      top: 8px !important;
      left: 50% !important;
      transform: translateX(-50%) translateY(4px) !important;
      display: inline-flex !important;
      align-items: center !important;
      gap: 6px !important;
      padding: 5px 12px !important;
      border-radius: 999px !important;
      background: rgba(56,161,105,0.95) !important;
      color: #fff !important;
      font: 600 12px/1 -apple-system, system-ui, sans-serif !important;
      letter-spacing: 0.01em !important;
      box-shadow: 0 4px 12px rgba(56,161,105,0.3) !important;
      opacity: 0 !important;
      transition: opacity 160ms ease, transform 160ms ease !important;
      pointer-events: none !important;
      white-space: nowrap !important;
    }
    .broom-empty-slot:hover .broom-empty-slot-label,
    .broom-empty-slot:focus-visible .broom-empty-slot-label {
      opacity: 1 !important;
      transform: translateX(-50%) translateY(0) !important;
    }
    .broom-empty-slot-icon { font-size: 14px !important; }
    @keyframes broom-slot-breathe {
      0%, 100% { background: rgba(80,160,100,0.06); }
      50%      { background: rgba(80,160,100,0.14); }
    }

    /* ── Planted decoration ──────────────────── */
    /* In-page wrapper that holds the plant. Caps to the swept element's
       original size (set inline) so the plant can't visually exceed the
       cleared area. */
    .broom-plant-slot {
      display: inline-block !important;
      vertical-align: top !important;
      pointer-events: auto !important;
      line-height: 0 !important;
      overflow: visible !important;
      position: relative !important;
    }
    /* Plant element — sized intrinsically by .sm/.md/.lg, but constrained
       to its slot via max-width/height: 100%. Slot's inline max-width/
       max-height (set from the original swept rect) caps the plant inside
       the area the user actually cleared. */
    .broom-plant {
      display: inline-flex !important;
      flex-direction: column !important;
      align-items: center !important;
      justify-content: flex-end !important;
      transform-origin: bottom center !important;
      user-select: none !important;
      pointer-events: none !important;
      max-width: 100% !important;
      max-height: 100% !important;
      filter: drop-shadow(0 4px 6px rgba(15,23,42,0.18)) !important;
      transition: filter 200ms ease !important;
    }
    .broom-plant-foliage {
      position: relative !important;
      display: block !important;
      width: 100% !important;
      flex: 1 1 auto !important;
      min-height: 0 !important;
      transform-origin: bottom center !important;
    }
    .broom-plant-foliage svg { display: block; width: 100%; height: 100%; }
    .broom-plant-pot {
      position: relative !important;
      display: block !important;
      width: 70% !important;
      margin-top: -6% !important;
      flex: 0 0 auto !important;
    }
    .broom-plant-pot svg { display: block; width: 100%; height: 100%; }
    .broom-plant-pot-none .broom-plant-pot { display: none !important; }
    .broom-plant-sm { width: 44px !important; height: 54px !important; }
    .broom-plant-md { width: 68px !important; height: 84px !important; }
    .broom-plant-lg { width: 96px !important; height: 118px !important; }
    /* Sway and wiggle apply to foliage only — pot stays still */
    .broom-plant-anim-gentle-sway .broom-plant-foliage {
      animation: broom-plant-sway 5.5s ease-in-out infinite !important;
    }
    /* Entry: pot bounces in first, foliage grows ~350ms later */
    .broom-plant-enter .broom-plant-pot {
      animation: broom-plant-pot-enter 400ms cubic-bezier(.2,1.4,.4,1) 0ms both !important;
    }
    .broom-plant-enter .broom-plant-foliage {
      animation:
        broom-plant-popin 580ms linear 350ms both,
        broom-plant-sway 5.5s ease-in-out infinite 930ms !important;
    }
    @keyframes broom-plant-pot-enter {
      0%   { opacity: 0; transform: translateY(18px) scale(0.78); }
      55%  { opacity: 1; transform: translateY(-5px) scale(1.08); }
      78%  { transform: translateY(3px) scale(0.96); }
      92%  { transform: translateY(-1px) scale(1.02); }
      100% { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes broom-plant-popin {
      0%   { opacity: 0; transform: scaleX(1.35) scaleY(0.05) translateY(6px); }
      18%  { opacity: 1; transform: scaleX(0.80) scaleY(1.22) translateY(-10px); }
      50%  { opacity: 1; transform: scaleX(1.07) scaleY(0.93) translateY(4px); }
      72%  { opacity: 1; transform: scaleX(0.97) scaleY(1.04) translateY(-2px); }
      88%  { opacity: 1; transform: scaleX(1.01) scaleY(0.99) translateY(1px); }
      100% { opacity: 1; transform: scaleX(1)    scaleY(1)    translateY(0); }
    }
    @keyframes broom-plant-sway {
      0%   { transform: rotate(-1.4deg); }
      50%  { transform: rotate(1.4deg); }
      100% { transform: rotate(-1.4deg); }
    }
    @keyframes broom-plant-wiggle {
      0%   { transform: rotate(0deg)    scale(1); }
      12%  { transform: rotate(13deg)   scale(1.06); }
      28%  { transform: rotate(-9deg)   scale(1.03); }
      44%  { transform: rotate(6deg)    scale(1.01); }
      58%  { transform: rotate(-3.5deg) scale(1); }
      72%  { transform: rotate(1.8deg); }
      100% { transform: rotate(0deg); }
    }
    /* Hover: foliage gets a sharp wiggle "snap" then continuous strong sway */
    .broom-plant-hovering .broom-plant-foliage {
      animation:
        broom-plant-wiggle 680ms ease-out,
        broom-plant-hover-sway 0.8s ease-in-out infinite 680ms !important;
    }
    @keyframes broom-plant-hover-sway {
      0%   { transform: rotate(-5deg) scale(1.04); }
      50%  { transform: rotate(5deg)  scale(1.04); }
      100% { transform: rotate(-5deg) scale(1.04); }
    }
    @keyframes broom-particle-burst {
      0%   { opacity: 1; transform: translate(0, 0) scale(1.2); }
      100% { opacity: 0; transform: translate(var(--px), var(--py)) scale(0.2); }
    }
    .broom-plant-particle {
      position: absolute !important;
      bottom: 20% !important;
      left: 50% !important;
      width: 5px !important;
      height: 5px !important;
      border-radius: 50% !important;
      pointer-events: none !important;
      margin-left: -2.5px !important;
      margin-bottom: -2.5px !important;
      animation: broom-particle-burst var(--dur, 480ms) ease-out var(--delay, 0ms) both !important;
    }
    .broom-plant-splash {
      box-shadow: 0 0 4px rgba(90,168,232,0.6) !important;
    }
    /* Raindrop: falls from above the plant onto the foliage on click */
    .broom-raindrop {
      position: absolute !important;
      top: 0 !important;
      width: 10px !important;
      height: 16px !important;
      margin-left: -5px !important;
      pointer-events: none !important;
      transform: translateY(-30px) scaleY(1);
      filter: drop-shadow(0 1px 1px rgba(58,120,184,0.4));
      animation: broom-raindrop-fall 520ms cubic-bezier(.45,.05,.55,.95) forwards !important;
    }
    .broom-raindrop svg { display: block; width: 100%; height: 100%; }
    @keyframes broom-raindrop-fall {
      0%   { transform: translateY(-30px) scaleY(1)    scaleX(1); opacity: 0; }
      15%  { opacity: 1; }
      85%  { transform: translateY(calc(var(--fall-y, 50px) - 4px)) scaleY(1.15) scaleX(0.9); opacity: 1; }
      96%  { transform: translateY(var(--fall-y, 50px)) scaleY(0.4) scaleX(1.4); opacity: 1; }
      100% { transform: translateY(var(--fall-y, 50px)) scaleY(0.2) scaleX(1.6); opacity: 0; }
    }
    /* Watering reaction — leaves do a one-shot wiggle */
    .broom-plant-watered {
      animation: broom-plant-wiggle 600ms ease-out !important;
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

    /* ── Undo toast ──────────────────────────── */
    #${UNDO_TOAST_ID} {
      all: initial !important;
      position: fixed !important;
      bottom: 22px !important;
      left: 22px !important;
      z-index: 2147483647 !important;
      display: inline-flex !important;
      align-items: center !important;
      gap: 10px !important;
      padding: 10px 14px 10px 12px !important;
      border-radius: 14px !important;
      background: rgba(15,23,42,0.92) !important;
      color: #f1f5f9 !important;
      border: 1px solid rgba(125,151,255,0.4) !important;
      border-left: 4px solid #7d97ff !important;
      box-shadow: 0 16px 40px rgba(15,23,42,0.32), 0 2px 8px rgba(15,23,42,0.18) !important;
      font: 600 13px/1.2 -apple-system, system-ui, sans-serif !important;
      backdrop-filter: blur(14px) saturate(1.3) !important;
      -webkit-backdrop-filter: blur(14px) saturate(1.3) !important;
      animation: broom-toast-in 0.32s cubic-bezier(.34,1.56,.64,1) !important;
    }
    #${UNDO_TOAST_ID}.but-leaving {
      animation: broom-toast-out 0.22s ease-in forwards !important;
    }
    #${UNDO_TOAST_ID} .but-icon { font-size: 16px !important; }
    #${UNDO_TOAST_ID} .but-msg { flex: 1 1 auto !important; color: #f8fafc !important; }
    html.broom-picking #${UNDO_TOAST_ID},
    html.broom-picking #${UNDO_TOAST_ID} * { cursor: default !important; }
    html.broom-picking #${UNDO_TOAST_ID} .but-btn { cursor: pointer !important; }
    #${UNDO_TOAST_ID} .but-btn {
      all: unset;
      cursor: pointer;
      padding: 5px 10px;
      border-radius: 8px;
      font: 600 12px/1 -apple-system, system-ui, sans-serif;
      color: #dbe5ff;
      background: rgba(125,151,255,0.18);
      border: 1px solid rgba(125,151,255,0.4);
      transition: background 0.12s, transform 0.1s;
    }
    #${UNDO_TOAST_ID} .but-btn:hover { background: rgba(125,151,255,0.32); }
    #${UNDO_TOAST_ID} .but-btn:active { transform: scale(0.96); }

    /* ── Restore-mode overlay ────────────────── */
    .broom-restore-overlay {
      position: fixed !important;
      z-index: 2147483646 !important;
      pointer-events: auto !important;
      box-sizing: border-box !important;
      border: 2px dashed rgba(37,99,235,0.85) !important;
      background: rgba(37,99,235,0.14) !important;
      border-radius: 6px !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      animation: broom-restore-in 220ms cubic-bezier(.2,1.4,.4,1) both !important;
      transition: opacity 220ms ease, transform 220ms ease !important;
    }
    .broom-restore-overlay.broom-restore-leaving {
      opacity: 0 !important;
      transform: scale(0.94) !important;
    }
    .broom-restore-plus {
      all: unset;
      width: 36px !important;
      height: 36px !important;
      border-radius: 50% !important;
      background: #2563eb !important;
      color: #fff !important;
      font: 700 22px/1 -apple-system, system-ui, sans-serif !important;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      cursor: pointer !important;
      box-shadow: 0 6px 18px rgba(37,99,235,0.42), 0 0 0 3px rgba(255,255,255,0.9) !important;
      transition: transform 120ms ease, box-shadow 120ms ease, background 120ms ease !important;
    }
    .broom-restore-plus:hover {
      background: #1d4fd8 !important;
      transform: scale(1.08) !important;
    }
    .broom-restore-plus:active { transform: scale(0.94) !important; }
    .broom-restore-plus:focus-visible {
      box-shadow: 0 6px 18px rgba(37,99,235,0.42), 0 0 0 3px #fff, 0 0 0 6px rgba(37,99,235,0.45) !important;
    }
    @keyframes broom-restore-in {
      0%   { opacity: 0; transform: scale(0.96); }
      100% { opacity: 1; transform: scale(1); }
    }

    /* ── Reduced motion ──────────────────────── */
    @media (prefers-reduced-motion: reduce) {
      #${LAUNCHER_ID}, #${LAUNCHER_ID}.active, #${LAUNCHER_ID}.squash,
      .${SWEEP_ID} .bsweep-broom, .${SWEEP_ID} .bsweep-sparkle,
      #broom-tag, html.broom-picking #${HIGHLIGHT_ID},
      html.bsweep-shake, .bsweep-puff,
      #${PANEL_ID}, #${PANEL_ID}.thinking .bp-btn.primary, #${PANEL_ID}.success,
      #${LAUNCHER_WRAP_ID} .broom-fan-chip,
      .broom-empty-slot, .broom-empty-slot-label, .broom-empty-slot-soil,
      .broom-plant, .broom-plant-enter, .broom-plant-anim-gentle-sway, .broom-plant-particle, .broom-plant-hovering, .broom-raindrop, .broom-plant-watered,
      .broom-restore-overlay, .broom-restore-overlay.broom-restore-leaving, .broom-restore-plus,
      #${UNDO_TOAST_ID}, #${UNDO_TOAST_ID}.but-leaving,
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

function ensureBroomCursor() {
  let el = document.getElementById(BROOM_CURSOR_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = BROOM_CURSOR_ID;
    const glyph = document.createElement("span");
    glyph.className = "broom-cursor-glyph";
    glyph.textContent = "🧹";
    el.appendChild(glyph);
    document.documentElement.appendChild(el);
  }
  return el;
}

function onCursorMove(e) {
  const el = document.getElementById(BROOM_CURSOR_ID);
  if (!el) return;
  // hotspot at the broom-handle tip: 4px from left, 28px down
  el.style.transform = `translate3d(${e.clientX - 6}px, ${e.clientY - 58}px, 0)`;
}

function triggerCursorWiggle() {
  const el = document.getElementById(BROOM_CURSOR_ID);
  const glyph = el?.firstElementChild;
  if (!glyph) return;
  glyph.classList.remove("wiggling");
  // Force reflow so removing+adding the class restarts the animation.
  void glyph.offsetWidth;
  glyph.classList.add("wiggling");
}

function isOurUI(el) { return !!el?.closest?.(OUR_UI_SELECTOR + ",#broom-tag,.bsweep-puff"); }

// ── Juice helpers ─────────────────────────────────────────────────────────────

const SPARKLE_GLYPHS = ["✨", "✦", "✧", "⭐", "💫"];

// Spawn a small burst of sparkles at viewport coords (for clicks/successes).
function playBroomSound() {
  if (cachedPrefs.soundEnabled === false) return;
  try {
    const url = chrome.runtime.getURL("magic-swoosh.m4a");
    console.log("[broom] playing sound:", url);
    const audio = new Audio(url);
    audio.volume = 0.6;
    audio.play().catch(() => {});
  } catch (_) {}
}

function playPlantSound() {
  if (cachedPrefs.soundEnabled === false) return;
  try {
    const audio = new Audio(chrome.runtime.getURL("pop.mp3"));
    audio.volume = 0.5;
    audio.play().catch(() => {});
  } catch (_) {}
}

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

// Show a custom label (e.g. "🌱 Pothos") instead of the tag.class string.
function showSelectorTagText(text, anchorEl) {
  if (!tagEl) {
    tagEl = document.createElement("div");
    tagEl.id = "broom-tag";
    document.documentElement.appendChild(tagEl);
  }
  tagEl.textContent = text;
  const r = anchorEl.getBoundingClientRect();
  const top = Math.max(8, r.top - 26);
  const left = Math.max(8, Math.min(innerWidth - 200, r.left));
  tagEl.style.top = `${top}px`;
  tagEl.style.left = `${left}px`;
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

// Resolve a hover/click target. If the user is pointing at one of our
// own planted decorations, return the plant frame (so the highlight box
// snaps to the plant's visible footprint instead of jittering between
// foliage / pot / SVG paths). Returns { target, plantRule? }.
function resolveBroomTarget(rawTarget) {
  if (!rawTarget) return null;
  const slot = rawTarget.closest && rawTarget.closest(".broom-plant-slot");
  if (slot) {
    const ruleId = slot.getAttribute(INJECTED_ATTR);
    const rule = appliedRules.find((r) => r.id === ruleId && r.payload && r.payload.kind === "plant");
    return { target: slot, plantRule: rule || null };
  }
  return { target: rawTarget, plantRule: null };
}

function onOver(e) {
  if (activeMode !== "broom") return;
  const resolved = resolveBroomTarget(e.target);
  if (!resolved) return;
  if (!resolved.plantRule && isOurUI(e.target)) return;
  const prevTarget = pickerTarget;
  pickerTarget = resolved.target;
  if (prevTarget !== resolved.target) triggerCursorWiggle();
  const r = resolved.target.getBoundingClientRect();
  const h = document.getElementById(HIGHLIGHT_ID);
  if (h) {
    Object.assign(h.style, {
      top: `${r.top}px`, left: `${r.left}px`,
      width: `${r.width}px`, height: `${r.height}px`,
    });
  }
  if (resolved.plantRule) {
    const name = PLANT_NAMES[resolved.plantRule.payload.plant.kind] || "plant";
    showSelectorTagText(`🌱 ${name}`, resolved.target);
  } else {
    showSelectorTag(resolved.target);
  }
}

function onClick(e) {
  if (activeMode !== "broom") return;
  const resolved = resolveBroomTarget(e.target);
  if (!resolved) return;
  if (!resolved.plantRule && isOurUI(e.target)) return;
  e.preventDefault(); e.stopPropagation();

  if (resolved.plantRule) {
    spawnSparklePuff(e.clientX, e.clientY, 6, 50);
    pickerTarget = null;
    document.getElementById(HIGHLIGHT_ID)?.style.setProperty("opacity", "0");
    hideSelectorTag();
    void sweepAwayPlant(resolved.plantRule).then(() => {
      document.getElementById(HIGHLIGHT_ID)?.style.removeProperty("opacity");
    });
    return;
  }

  const target = resolved.target;
  const selector = buildSelector(target);
  spawnSparklePuff(e.clientX, e.clientY, 6, 50);
  // Stay in brooming mode so multiple elements can be wiped in a row.
  // Clear the current target/visuals; mouseover will repopulate after the sweep.
  pickerTarget = null;
  document.getElementById(HIGHLIGHT_ID)?.style.setProperty("opacity", "0");
  hideSelectorTag();
  void playSweepAndHide(target, selector, { x: e.clientX, y: e.clientY }).then(() => {
    document.getElementById(HIGHLIGHT_ID)?.style.removeProperty("opacity");
  });
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
    if (e.repeat) return; // ignore key auto-repeat — one wipe per press
    e.preventDefault();
    e.stopPropagation();
    const target = pickerTarget;
    const plantSlot = target.closest && target.closest(".broom-plant-slot");
    if (plantSlot) {
      const ruleId = plantSlot.getAttribute(INJECTED_ATTR);
      const rule = appliedRules.find((r) => r.id === ruleId && r.payload && r.payload.kind === "plant");
      stopMode();
      if (rule) void sweepAwayPlant(rule);
      return;
    }
    const selector = buildSelector(target);
    // Stay in brooming mode so the user can wipe multiple elements in a row.
    // Just clear the current target + visuals; the next mouseover repopulates.
    pickerTarget = null;
    document.getElementById(HIGHLIGHT_ID)?.style.setProperty("opacity", "0");
    hideSelectorTag();
    const r = target.getBoundingClientRect();
    void playSweepAndHide(target, selector, { x: r.right - 8, y: r.top + r.height / 2 }).then(() => {
      document.getElementById(HIGHLIGHT_ID)?.style.removeProperty("opacity");
    });
  }
}

// ── Always-present launcher ───────────────────────────────────────────────────

function installLauncher() {
  if (document.getElementById(LAUNCHER_WRAP_ID)) return;
  ensurePickerStyles();

  const wrap = document.createElement("div");
  wrap.id = LAUNCHER_WRAP_ID;

  const fan = document.createElement("div");
  fan.className = "broom-fan";
  fan.innerHTML = `
    <button class="broom-fan-chip" data-action="settings" type="button" aria-label="Settings">
      <span class="broom-fan-glyph">⚙️</span>
      <span class="broom-fan-label">Settings</span>
    </button>
    <button class="broom-fan-chip" data-mode="restore" type="button" aria-label="Restore mode">
      <span class="broom-fan-glyph">♻️</span>
      <span class="broom-fan-label">Restore</span>
    </button>
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
      const r = chip.getBoundingClientRect();
      spawnSparklePuff(r.left + r.width / 2, r.top + r.height / 2, 6, 50);
      wrap.classList.remove("broom-fan-open");
      if (chip.dataset.action === "settings") {
        toggleSettingsPopover();
        return;
      }
      const mode = chip.dataset.mode;
      if (activeMode === mode) stopMode();
      else startMode(mode);
    }, true);
  });

  document.documentElement.appendChild(wrap);
}

// ── Settings popover ──────────────────────────────────────────────────────────

function toggleSettingsPopover() {
  const existing = document.getElementById(SETTINGS_ID);
  if (existing) { closeSettingsPopover(); return; }
  openSettingsPopover();
}

function openSettingsPopover() {
  ensurePickerStyles();
  if (activeMode) stopMode();

  const pop = document.createElement("div");
  pop.id = SETTINGS_ID;
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Broom settings");
  const { version, build } = getVersionAndBuild();
  pop.innerHTML = `
    <label class="bs-row">
      <span class="bs-row-label">Sound effects</span>
      <span class="bs-switch">
        <input type="checkbox" data-pref="soundEnabled" ${cachedPrefs.soundEnabled === false ? "" : "checked"} />
        <span class="bs-switch-track"></span>
      </span>
    </label>
    <label class="bs-row">
      <span class="bs-row-label">Show my changes</span>
      <span class="bs-switch">
        <input type="checkbox" data-pref="showChanges" ${cachedPrefs.showChanges === false ? "" : "checked"} />
        <span class="bs-switch-track"></span>
      </span>
    </label>
    <div class="bs-divider"></div>
    <button class="bs-btn" data-act="reset" type="button">
      <span class="bs-btn-glyph">🗑️</span><span>Restore original</span>
    </button>
    <div class="bs-version">Version ${version} (${build})</div>
  `;
  document.documentElement.appendChild(pop);

  pop.querySelector('input[data-pref="soundEnabled"]').addEventListener("change", async (e) => {
    const enabled = !!e.currentTarget.checked;
    await setPref("soundEnabled", enabled);
    if (enabled) playBroomSound();
  });

  pop.querySelector('input[data-pref="showChanges"]').addEventListener("change", async (e) => {
    const enabled = !!e.currentTarget.checked;
    await setPref("showChanges", enabled);
    if (enabled) {
      for (const r of appliedRules) applyRule(r);
    } else {
      for (const r of appliedRules) removeRule(r.id);
    }
  });

  pop.querySelector('[data-act="reset"]').addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const host = location.hostname;
    if (!confirm(`Restore ${host} to its original state? All your Broom changes on this site will be undone.`)) return;
    await clearRulesForHost(host);
    for (const r of [...appliedRules]) removeRule(r.id);
    appliedRules = [];
    closeSettingsPopover();
  });

  // Click outside to dismiss
  setTimeout(() => {
    document.addEventListener("click", onSettingsOutsideClick, true);
    document.addEventListener("keydown", onSettingsKeydown, true);
  }, 0);
}

function onSettingsOutsideClick(e) {
  const pop = document.getElementById(SETTINGS_ID);
  if (!pop) { document.removeEventListener("click", onSettingsOutsideClick, true); return; }
  if (pop.contains(e.target)) return;
  if (e.target.closest && e.target.closest(`#${LAUNCHER_WRAP_ID}`)) return;
  closeSettingsPopover();
}

function onSettingsKeydown(e) {
  if (e.key === "Escape") closeSettingsPopover();
}

function closeSettingsPopover() {
  document.removeEventListener("click", onSettingsOutsideClick, true);
  document.removeEventListener("keydown", onSettingsKeydown, true);
  const pop = document.getElementById(SETTINGS_ID);
  if (!pop) return;
  pop.classList.add("bs-leaving");
  setTimeout(() => pop.remove(), 160);
}

// ── Sweep animation — broom passes over the element, sparkles fly out ─────────

async function playSweepAndHide(el, selector, from = null) {
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

  playBroomSound();

  // Hide the cursor follower for the duration of the sweep — the sweep broom
  // takes over visually so the user perceives one broom doing the work.
  const cursorEl = document.getElementById(BROOM_CURSOR_ID);
  const prevCursorVis = cursorEl?.style.visibility;
  if (cursorEl) cursorEl.style.visibility = "hidden";

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

  // Broom that sweeps across — starts at the click point, sweeps off the left.
  const broomBox = 64;
  const broomFont = 60;
  const hotspotX = 6;   // tip of broom handle within the box
  const hotspotY = 58;
  const broom = document.createElement("div");
  broom.className = "bsweep-broom";
  broom.textContent = "🧹";
  Object.assign(broom.style, {
    position: "absolute",
    top: "0",
    left: "0",
    width: `${broomBox}px`,
    height: `${broomBox}px`,
    fontSize: `${broomFont}px`,
    lineHeight: `${broomBox}px`,
    textAlign: "center",
    transformOrigin: `${hotspotX}px ${hotspotY}px`,
    willChange: "transform, opacity",
  });
  overlay.appendChild(broom);

  // Compute start position relative to overlay (= element rect). Default to
  // the right edge if no click point was supplied (e.g. panel-driven hides).
  const startClientX = from ? from.x : rect.right - 8;
  const startClientY = from ? from.y : rect.top + rect.height / 2;
  const sx = startClientX - rect.left - hotspotX;
  const sy = startClientY - rect.top - hotspotY;
  const exitX = -broomBox - 40;
  const totalDx = sx - exitX;
  broom.animate(
    [
      { transform: `translate(${sx}px, ${sy}px) rotate(15deg)`, opacity: 0 },
      { transform: `translate(${sx}px, ${sy - 4}px) rotate(15deg)`, opacity: 1, offset: 0.06 },
      { transform: `translate(${sx - totalDx * 0.30}px, ${sy + 6}px) rotate(-12deg)`, offset: 0.32 },
      { transform: `translate(${sx - totalDx * 0.55}px, ${sy - 4}px) rotate(22deg)`, offset: 0.55 },
      { transform: `translate(${sx - totalDx * 0.78}px, ${sy + 4}px) rotate(-14deg)`, offset: 0.78 },
      { transform: `translate(${exitX}px, ${sy}px) rotate(35deg)`, opacity: 0, offset: 1 },
    ],
    { duration: 950, easing: "cubic-bezier(.45,.05,.55,.95)", fill: "forwards" },
  );

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

  broomSession.push(rule);
  showUndoToast([rule]);

  // Cleanup overlay; restore element styles in case the rule was rejected.
  overlay.remove();
  if (el.isConnected) el.style.animation = prevAnim;
  if (cursorEl) cursorEl.style.visibility = prevCursorVis || "";
}

// Sweep an existing plant decoration away with the same broom animation
// as a regular hide, then delete the decorate rule. The underlying hide
// rule (and the empty plant slot it created) stays in place — the user
// can replant something else later.
async function sweepAwayPlant(rule) {
  const escId = rule.id.replace(/"/g, '\\"');
  const slotEl = document.querySelector(`[${INJECTED_ATTR}="${escId}"]`);
  const innerEl = slotEl && slotEl.querySelector(".broom-plant");

  const cleanup = async () => {
    appliedRules = appliedRules.filter((r) => r.id !== rule.id);
    document.querySelectorAll(`[${INJECTED_ATTR}="${escId}"]`).forEach((n) => n.remove());
    await deleteRuleLocal(rule.hostname, rule.id);
  };

  if (!slotEl || !slotEl.isConnected) {
    await cleanup();
    return;
  }

  ensurePickerStyles();
  const rect = slotEl.getBoundingClientRect();
  const tooSmall = rect.width < 8 || rect.height < 8;
  const offscreen = rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth;
  if (tooSmall || offscreen) {
    await cleanup();
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

  const broomBox = 64;
  const broomFont = 60;
  const hotspotX = 6;
  const hotspotY = 58;
  const broom = document.createElement("div");
  broom.className = "bsweep-broom";
  broom.textContent = "🧹";
  Object.assign(broom.style, {
    position: "absolute",
    top: "0",
    left: "0",
    width: `${broomBox}px`,
    height: `${broomBox}px`,
    fontSize: `${broomFont}px`,
    lineHeight: `${broomBox}px`,
    textAlign: "center",
    transformOrigin: `${hotspotX}px ${hotspotY}px`,
    willChange: "transform, opacity",
  });
  overlay.appendChild(broom);

  const sx = rect.width - 8 - hotspotX;
  const sy = rect.height / 2 - hotspotY;
  const exitX = -broomBox - 40;
  const totalDx = sx - exitX;
  broom.animate(
    [
      { transform: `translate(${sx}px, ${sy}px) rotate(15deg)`, opacity: 0 },
      { transform: `translate(${sx}px, ${sy - 4}px) rotate(15deg)`, opacity: 1, offset: 0.06 },
      { transform: `translate(${sx - totalDx * 0.30}px, ${sy + 6}px) rotate(-12deg)`, offset: 0.32 },
      { transform: `translate(${sx - totalDx * 0.55}px, ${sy - 4}px) rotate(22deg)`, offset: 0.55 },
      { transform: `translate(${sx - totalDx * 0.78}px, ${sy + 4}px) rotate(-14deg)`, offset: 0.78 },
      { transform: `translate(${exitX}px, ${sy}px) rotate(35deg)`, opacity: 0, offset: 1 },
    ],
    { duration: 950, easing: "cubic-bezier(.45,.05,.55,.95)", fill: "forwards" },
  );

  const glyphs = ["🍃", "✨", "✦", "🌿", "💨"];
  const sparkleCount = Math.min(14, Math.max(6, Math.round(rect.width / 28)));
  for (let i = 0; i < sparkleCount; i++) {
    const s = document.createElement("div");
    s.className = "bsweep-sparkle";
    s.textContent = glyphs[i % glyphs.length];
    const dx = (Math.random() - 0.3) * Math.max(rect.width, 120);
    const dy = -20 - Math.random() * 80;
    const startX = 80 + Math.random() * 20;
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
  // Fade the inner plant element (which has no centering transform of its
  // own, so the bsweep-target keyframe's transforms don't displace it).
  if (innerEl) innerEl.style.animation = "bsweep-target 0.95s ease-in forwards";

  setTimeout(() => {
    const cx = rect.left + rect.width * 0.2;
    const cy = rect.top + rect.height / 2;
    spawnSparklePuff(cx, cy, 8, Math.max(60, rect.width * 0.4));
  }, 760);

  await new Promise((r) => setTimeout(r, 950));
  overlay.remove();
  await cleanup();
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
    </div>`;

  panel.querySelector(".bp-sel").textContent = selector;
  document.documentElement.appendChild(panel);

  panel.querySelectorAll("button[data-type]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const t = btn.dataset.type;
      if (t === "hide") {
        closePanel();
        await playSweepAndHide(el, selector);
      }
    });
  });

  panel.querySelector("#broom-cancel").addEventListener("click", closePanel);
}

function closePanel() { document.getElementById(PANEL_ID)?.remove(); }

function makeHideRule(selector, originalBox) {
  const payload = { kind: "hide" };
  if (originalBox && originalBox.width && originalBox.height) {
    payload.originalBox = { width: originalBox.width, height: originalBox.height };
  }
  return { id: uuid(), hostname: location.hostname, type: "hide", selector: { primary: selector, fallbacks: [], semantic: "" }, payload, enabled: true, createdAt: Date.now(), lastAppliedAt: null, lastFailedAt: null, failCount: 0 };
}

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

// ── Restore mode ─────────────────────────────────────────────────────────────

function enterRestoreMode() {
  restoreSuspended = new Map();
  for (const rule of appliedRules) {
    if (rule.payload && rule.payload.kind === "hide" && rule.enabled && styleCache.has(rule.id)) {
      restoreSuspended.set(rule.id, styleCache.get(rule.id));
      styleCache.delete(rule.id);
    }
  }
  rebuildStyleTag();
  // Let layout settle before measuring positions.
  requestAnimationFrame(() => renderRestoreOverlays());

  restoreReposition = rafDebounce(repositionRestoreOverlays);
  restoreScrollHandler = restoreReposition;
  restoreResizeHandler = restoreReposition;
  window.addEventListener("scroll", restoreScrollHandler, { capture: true, passive: true });
  window.addEventListener("resize", restoreResizeHandler, { passive: true });
  restoreObserver = new MutationObserver(restoreReposition);
  if (document.body) restoreObserver.observe(document.body, { childList: true, subtree: true, attributes: true });
}

function exitRestoreMode() {
  removeRestoreOverlays();
  if (restoreScrollHandler) window.removeEventListener("scroll", restoreScrollHandler, { capture: true });
  if (restoreResizeHandler) window.removeEventListener("resize", restoreResizeHandler);
  if (restoreObserver) restoreObserver.disconnect();
  restoreScrollHandler = null;
  restoreResizeHandler = null;
  restoreObserver = null;
  restoreReposition = null;

  // Re-apply any hide rules that were suspended (and not deleted via +).
  for (const [ruleId, css] of restoreSuspended) {
    styleCache.set(ruleId, css);
  }
  rebuildStyleTag();
  restoreSuspended = new Map();
}

function rafDebounce(fn) {
  let queued = false;
  return function () {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn();
    });
  };
}

function renderRestoreOverlays() {
  removeRestoreOverlays();
  for (const rule of appliedRules) {
    if (!restoreSuspended.has(rule.id)) continue;
    const el = resolveSelector(rule.selector.primary, rule.selector.fallbacks);
    if (!el) continue;
    const overlay = createRestoreOverlay(rule);
    document.documentElement.appendChild(overlay);
    positionRestoreOverlay(overlay, el);
  }
}

function createRestoreOverlay(rule) {
  const overlay = document.createElement("div");
  overlay.className = "broom-restore-overlay";
  overlay.setAttribute(RESTORE_OVERLAY_ATTR, rule.id);

  const plus = document.createElement("button");
  plus.type = "button";
  plus.className = "broom-restore-plus";
  plus.setAttribute("aria-label", "Restore this element");
  plus.textContent = "＋";
  plus.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void onRestorePlusClick(rule, overlay, e);
  });

  overlay.appendChild(plus);
  return overlay;
}

function positionRestoreOverlay(overlay, el) {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) {
    overlay.style.display = "none";
    return;
  }
  overlay.style.display = "";
  overlay.style.top = `${r.top}px`;
  overlay.style.left = `${r.left}px`;
  overlay.style.width = `${r.width}px`;
  overlay.style.height = `${r.height}px`;
}

function repositionRestoreOverlays() {
  document.querySelectorAll(`.broom-restore-overlay[${RESTORE_OVERLAY_ATTR}]`).forEach((overlay) => {
    const ruleId = overlay.getAttribute(RESTORE_OVERLAY_ATTR);
    const rule = appliedRules.find((r) => r.id === ruleId);
    if (!rule) { overlay.remove(); return; }
    const el = resolveSelector(rule.selector.primary, rule.selector.fallbacks);
    if (!el) { overlay.remove(); return; }
    positionRestoreOverlay(overlay, el);
  });
}

function removeRestoreOverlays() {
  document.querySelectorAll(`.broom-restore-overlay[${RESTORE_OVERLAY_ATTR}]`).forEach((n) => n.remove());
}

async function onRestorePlusClick(rule, overlay, evt) {
  // Drop from suspended map so it stays visible after exiting restore mode.
  restoreSuspended.delete(rule.id);
  appliedRules = appliedRules.filter((r) => r.id !== rule.id);
  styleCache.delete(rule.id);
  rebuildStyleTag();

  if (evt && typeof evt.clientX === "number") {
    spawnSparklePuff(evt.clientX, evt.clientY, 6, 50);
  }
  overlay.classList.add("broom-restore-leaving");
  setTimeout(() => overlay.remove(), 220);

  await deleteRuleLocal(rule.hostname, rule.id);
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

  const soil = document.createElement("div");
  soil.className = "broom-empty-slot-soil";
  soil.innerHTML = SOIL_MOUND_SVG;
  slot.appendChild(soil);

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
      originalBox: (hideRule.payload && hideRule.payload.originalBox) || null,
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

// ── Undo toast (revive the just-swept element) ──────────────────────────────

function showUndoToast(rules) {
  hideUndoToast();
  if (!rules.length) return;
  const count = rules.length;
  const label = count === 1 ? "Swept" : `Swept ${count}`;
  const toast = document.createElement("div");
  toast.id = UNDO_TOAST_ID;
  toast.innerHTML = `
    <span class="but-icon">🧹</span>
    <span class="but-msg">${label}</span>
    <button class="but-btn" data-act="undo" type="button">Undo</button>
  `;
  document.documentElement.appendChild(toast);

  toast.querySelector('[data-act="undo"]').addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    hideUndoToast();
    const ids = new Set(rules.map((r) => r.id));
    broomSession = broomSession.filter((r) => !ids.has(r.id));
    appliedRules = appliedRules.filter((r) => !ids.has(r.id));
    for (const r of rules) styleCache.delete(r.id);
    rebuildStyleTag();
    for (const r of rules) {
      document.querySelectorAll(`.broom-restore-overlay[${RESTORE_OVERLAY_ATTR}="${r.id.replace(/"/g, '\\"')}"]`).forEach((n) => n.remove());
    }
    if (count === 1) {
      spawnSparklePuff(window.innerWidth / 2, window.innerHeight / 2, 8, 80);
    }
    for (const r of rules) {
      try { await deleteRuleLocal(r.hostname, r.id); } catch { /* best-effort */ }
    }
    if (broomSession.length > 0) {
      showUndoToast([broomSession[broomSession.length - 1]]);
    }
  });

  toast.addEventListener("mouseenter", () => clearTimeout(undoToastTimer));
  toast.addEventListener("mouseleave", armUndoToastDismiss);
  armUndoToastDismiss();
}

function armUndoToastDismiss() {
  clearTimeout(undoToastTimer);
  undoToastTimer = setTimeout(hideUndoToast, 6000);
}

function hideUndoToast() {
  clearTimeout(undoToastTimer);
  undoToastTimer = null;
  const toast = document.getElementById(UNDO_TOAST_ID);
  if (!toast) return;
  toast.classList.add("but-leaving");
  setTimeout(() => toast.remove(), 220);
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
    document.querySelectorAll(`[${INJECTED_ATTR}="${decorateRule.id.replace(/"/g, '\\"')}"]`).forEach((n) => n.remove());
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
    document.querySelectorAll(`[${INJECTED_ATTR}="${decorateRule.id.replace(/"/g, '\\"')}"]`).forEach((n) => n.remove());
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
  await loadPrefs();
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
  if (msg?.type === "CONTENT_TOGGLE_MODE") {
    const m = msg.mode;
    if (activeMode === m) stopMode();
    else startMode(m);
    sendResponse({ type: "ACK" });
    return true;
  }
  if (msg?.type === "CONTENT_APPLY_RULE") { applyRule(msg.rule); void refreshRules(); sendResponse({ type: "ACK" }); return true; }
  if (msg?.type === "CONTENT_REMOVE_RULE") { removeRule(msg.ruleId); void refreshRules(); sendResponse({ type: "ACK" }); return true; }
  return false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[RULES_KEY]) void refreshRules();
  if (area === "local" && changes[PREFS_KEY]) {
    const prevShow = cachedPrefs.showChanges !== false;
    cachedPrefs = { ...DEFAULT_PREFS, ...(changes[PREFS_KEY].newValue || {}) };
    const nextShow = cachedPrefs.showChanges !== false;
    if (prevShow !== nextShow) {
      if (nextShow) for (const r of appliedRules) applyRule(r);
      else for (const r of appliedRules) removeRule(r.id);
    }
  }
});

// ── Utils ─────────────────────────────────────────────────────────────────────

function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ── Boot ──────────────────────────────────────────────────────────────────────

void init();
