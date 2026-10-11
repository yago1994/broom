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

// ── Analytics ────────────────────────────────────────────────────────────────

const ANALYTICS_URL = "https://broom-analytics.pasalacabra.workers.dev/analytics";
const INSTALL_ID_KEY = "installId";
let _installId = null;

async function getInstallId() {
  if (_installId) return _installId;
  const r = await chrome.storage.local.get(INSTALL_ID_KEY);
  if (r[INSTALL_ID_KEY]) { _installId = r[INSTALL_ID_KEY]; return _installId; }
  _installId = uuid();
  await chrome.storage.local.set({ [INSTALL_ID_KEY]: _installId });
  return _installId;
}

async function trackEvent(event) {
  try {
    const install_id = await getInstallId();
    const extension_version = String(chrome.runtime?.getManifest?.()?.version || "0");
    await fetch(ANALYTICS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, install_id, extension_version }),
    });
  } catch { /* never break the app */ }
}

const ANALYTICS_INSTALL_FLAG = "analyticsInstalled";
const ANALYTICS_DAILY_KEY = "analyticsDailyDate";

async function trackFirstInstallAndDaily() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const r = await chrome.storage.local.get([ANALYTICS_INSTALL_FLAG, ANALYTICS_DAILY_KEY]);
    if (!r[ANALYTICS_INSTALL_FLAG]) {
      await chrome.storage.local.set({ [ANALYTICS_INSTALL_FLAG]: true });
      void trackEvent("install");
    }
    if (r[ANALYTICS_DAILY_KEY] !== today) {
      await chrome.storage.local.set({ [ANALYTICS_DAILY_KEY]: today });
      void trackEvent("daily_active");
    }
  } catch { /* never break the app */ }
}

async function trackSiteSavedIfNew(hostname) {
  try {
    const key = `analyticsSite_${hostname}`;
    const r = await chrome.storage.local.get(key);
    if (!r[key]) {
      await chrome.storage.local.set({ [key]: true });
      void trackEvent("site_saved");
    }
  } catch { /* never break the app */ }
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
const DEFAULT_PREFS = { soundEnabled: true, showChanges: true, showLauncher: true, suspendKey: "KeyB", activePackId: null, launcherPos: null };
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

// ── Custom bloom packs ───────────────────────────────────────────────────────
//
// Users can drop a folder of SVGs into Settings → Blooms; the pack becomes the
// active plant pool when selected (built-in pool returns when "Default" is
// active or the active pack is deleted). Each SVG is sanitized at upload time
// — we strip <script>, <foreignObject>, on* handlers, javascript: URLs, and
// any non-fragment external href so a malicious pack can't run code on the
// host page.
//
// Storage layout:
//   customPacksIndex   → [{ id, name, count, createdAt, thumb }]
//   customPack:${id}   → { [plantId]: svgString }
//
// At runtime, all packs are loaded into the existing PLANT_SVGS/PLANT_NAMES
// registries under namespaced kinds ("custom:packId:plantId"), so the
// renderer at applyPlant() doesn't need to know packs exist. The "active"
// pack only affects which kinds chooseRandomPlant draws from.

const CUSTOM_PACKS_INDEX_KEY = "customPacksIndex";
const CUSTOM_PACK_PREFIX = "customPack:";
const MAX_PACK_FILES = 50;
const MAX_PACK_BYTES = 2 * 1024 * 1024; // ~2MB per pack
const BROOMPACK_FORMAT = "broompack";
const BROOMPACK_VERSION = 1;

let customPacksIndex = [];
// packId → { plantId → { svg, name } }
//
// Older saves stored a bare svg string under each plantId. normalizePackBlobs
// (called on load) coerces both shapes into the { svg, name } record so the
// rest of the code can assume one schema.
let customPacksData = {};

function customKind(packId, plantId) {
  return `custom:${packId}:${plantId}`;
}

// Prettify a raw filename into a display label: drop the extension, replace
// underscores/dashes with spaces, collapse whitespace, capitalize the first
// letter. "fiddle-leaf.svg" → "Fiddle leaf". Returns "" for empty/cryptic
// input so callers can fall back to the pack name.
function prettifyPlantName(filename) {
  if (typeof filename !== "string") return "";
  let s = filename.replace(/\.svg$/i, "").replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function normalizePackBlobs(raw) {
  const out = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") {
      out[k] = { svg: v, name: "" };
    } else if (v && typeof v === "object" && typeof v.svg === "string") {
      out[k] = { svg: v.svg, name: typeof v.name === "string" ? v.name : "" };
    }
  }
  return out;
}

// Pull the active pack's kinds for the picker. Returns null when none is
// active so the caller falls back to the built-in pool.
function activePackKinds() {
  const id = cachedPrefs.activePackId;
  if (!id) return null;
  const data = customPacksData[id];
  if (!data) return null;
  const kinds = Object.keys(data).map((plantId) => customKind(id, plantId));
  return kinds.length ? kinds : null;
}

// Register a pack's SVGs into PLANT_SVGS/PLANT_NAMES. Idempotent — calling
// again with the same pack overwrites prior entries cleanly.
//
// Per-plant `name` (from the SVG filename at upload time) is preferred; we
// fall back to the pack name so the hover label always reads like a real
// thing, never an empty string.
function registerPackInRegistry(packId, packMeta, blobs) {
  const fallback = packMeta?.name || "Custom plant";
  for (const [plantId, entry] of Object.entries(blobs)) {
    const k = customKind(packId, plantId);
    PLANT_SVGS[k] = entry.svg;
    PLANT_NAMES[k] = entry.name && entry.name.trim() ? entry.name : fallback;
  }
}

function unregisterPackFromRegistry(packId) {
  const prefix = `custom:${packId}:`;
  for (const k of Object.keys(PLANT_SVGS)) {
    if (k.startsWith(prefix)) {
      delete PLANT_SVGS[k];
      delete PLANT_NAMES[k];
    }
  }
}

async function loadAllCustomPacks() {
  try {
    const r = await chrome.storage.local.get(CUSTOM_PACKS_INDEX_KEY);
    customPacksIndex = Array.isArray(r[CUSTOM_PACKS_INDEX_KEY]) ? r[CUSTOM_PACKS_INDEX_KEY] : [];
  } catch { customPacksIndex = []; }

  if (!customPacksIndex.length) { customPacksData = {}; return; }

  const keys = customPacksIndex.map((p) => CUSTOM_PACK_PREFIX + p.id);
  let blobs = {};
  try { blobs = await chrome.storage.local.get(keys); } catch { blobs = {}; }

  customPacksData = {};
  for (const pack of customPacksIndex) {
    const raw = blobs[CUSTOM_PACK_PREFIX + pack.id];
    if (raw && typeof raw === "object") {
      const data = normalizePackBlobs(raw);
      customPacksData[pack.id] = data;
      registerPackInRegistry(pack.id, pack, data);
    }
  }

  // Active pack referenced but missing → reset to Default so the user never
  // ends up planting fallback pothoses without knowing why.
  if (cachedPrefs.activePackId && !customPacksData[cachedPrefs.activePackId]) {
    await setPref("activePackId", null);
  }
}

// SVG sanitizer. Returns a cleaned SVG string or null if the input doesn't
// parse as SVG. Aggressive allowlist — we'd rather reject a fancy SVG than
// let a script element through to the host page.
const SVG_TAG_ALLOWLIST = new Set([
  "svg", "g", "defs", "title", "desc", "metadata",
  "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "linearGradient", "radialGradient", "stop",
  "pattern", "clipPath", "mask", "use", "symbol",
  "text", "tspan", "textPath", "image",
  "filter", "feGaussianBlur", "feOffset", "feMerge", "feMergeNode",
  "feColorMatrix", "feFlood", "feComposite", "feMorphology", "feBlend",
  "feTurbulence", "feDisplacementMap", "feSpecularLighting", "feDiffuseLighting",
  "feDistantLight", "fePointLight", "feSpotLight",
  "animate", "animateTransform", "animateMotion", "mpath", "set"
]);

const SVG_URL_ATTRS = new Set(["href", "xlink:href", "src"]);

function isSafeUrl(value) {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v.startsWith("#")) return true;
  if (/^data:image\//i.test(v)) return true;
  return false;
}

function sanitizeSvg(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  let doc;
  try {
    doc = new DOMParser().parseFromString(text, "image/svg+xml");
  } catch { return null; }
  // image/svg+xml puts a <parsererror> at the root on failure
  if (doc.querySelector("parsererror")) return null;

  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== "svg") return null;

  // Walk the tree depth-first, mutating in place. We collect nodes first
  // because removing during traversal would skip siblings.
  const all = [];
  (function collect(n) {
    all.push(n);
    for (const c of Array.from(n.children)) collect(c);
  })(root);

  for (const node of all) {
    if (!node.isConnected) continue;
    const tag = node.tagName;
    // tagName casing: HTML parsers lowercase, XML parsers preserve. We compare
    // case-insensitively against the allowlist.
    const lower = tag.toLowerCase();
    // Find canonical-cased match (e.g. "lineargradient" → "linearGradient").
    let allowed = false;
    if (SVG_TAG_ALLOWLIST.has(lower)) allowed = true;
    else {
      for (const t of SVG_TAG_ALLOWLIST) {
        if (t.toLowerCase() === lower) { allowed = true; break; }
      }
    }
    if (!allowed) { node.remove(); continue; }

    for (const attr of Array.from(node.attributes)) {
      const name = attr.name;
      const lname = name.toLowerCase();
      const value = attr.value;

      // Strip every on* handler attribute.
      if (lname.startsWith("on")) { node.removeAttribute(name); continue; }

      // Strip URL-carrying attributes that point anywhere risky.
      if (SVG_URL_ATTRS.has(lname) && !isSafeUrl(value)) {
        node.removeAttribute(name);
        continue;
      }

      // Reject any attribute value that contains a javascript: URL anywhere.
      if (/javascript:/i.test(value)) { node.removeAttribute(name); continue; }

      // <animate>/<set> can mutate dangerous attributes — restrict the names
      // they target so an animation can't, say, animate-set an `href` into
      // a javascript: URL post-load.
      if ((lower === "animate" || lower === "set" || lower === "animatetransform") && lname === "attributename") {
        if (/^on/i.test(value) || /href/i.test(value)) { node.removeAttribute(name); continue; }
      }

      // Inline style: strip if it tries to load external resources or use
      // CSS expressions. Cheap-and-safe approach: drop the whole style attr
      // when anything suspicious is present.
      if (lname === "style" && /(expression\s*\(|url\s*\(\s*(?!#))/i.test(value)) {
        node.removeAttribute(name);
      }
    }
  }

  // Normalize the root <svg>: ensure a viewBox so the plant scales to its
  // slot, drop fixed width/height so it isn't pinned to author dimensions.
  if (!root.getAttribute("viewBox")) {
    const w = parseFloat(root.getAttribute("width")) || 100;
    const h = parseFloat(root.getAttribute("height")) || 100;
    root.setAttribute("viewBox", `0 0 ${w} ${h}`);
  }
  root.removeAttribute("width");
  root.removeAttribute("height");
  root.setAttribute("preserveAspectRatio", root.getAttribute("preserveAspectRatio") || "xMidYMid meet");
  root.setAttribute("aria-hidden", "true");

  try { return new XMLSerializer().serializeToString(root); }
  catch { return null; }
}

// Slugify a folder name into a safe pack id. Lowercase, hyphens, no leading/
// trailing dashes. We append a short random suffix so two packs with the same
// name can coexist.
function slugifyPackName(name) {
  const base = String(name || "pack")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "pack";
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${base}-${suffix}`;
}

// Save a new pack from a list of { plantId, name, svg } entries. The caller
// is responsible for sanitizing first; this is just storage. Returns the
// stored pack metadata.
async function saveCustomPack({ name, entries }) {
  const id = slugifyPackName(name);
  const blobs = {};
  for (const e of entries) {
    blobs[e.plantId] = { svg: e.svg, name: typeof e.name === "string" ? e.name : "" };
  }
  const meta = {
    id,
    name: String(name || "Custom pack").slice(0, 64),
    count: entries.length,
    createdAt: Date.now(),
    thumb: entries[0]?.svg || ""
  };
  customPacksIndex = [...customPacksIndex, meta];
  customPacksData[id] = blobs;
  registerPackInRegistry(id, meta, blobs);
  await chrome.storage.local.set({
    [CUSTOM_PACKS_INDEX_KEY]: customPacksIndex,
    [CUSTOM_PACK_PREFIX + id]: blobs
  });
  return meta;
}

// Build the JSON payload for a .broompack export. The format is intentionally
// minimal — name + entries list of { id, name, svg } — and versioned so we
// can extend it without breaking older builds.
function buildBroompackPayload(pack, blobs) {
  return {
    format: BROOMPACK_FORMAT,
    version: BROOMPACK_VERSION,
    type: "plants",
    name: pack.name,
    createdAt: pack.createdAt || Date.now(),
    entries: Object.entries(blobs).map(([id, entry]) => ({
      id,
      name: entry.name || "",
      svg: entry.svg
    }))
  };
}

function exportPackAsBroompack(packId) {
  const pack = customPacksIndex.find((p) => p.id === packId);
  const blobs = customPacksData[packId];
  if (!pack || !blobs) return;
  const payload = buildBroompackPayload(pack, blobs);
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  // Keep filenames filesystem-safe; the user can rename on save if they want.
  const safe = String(pack.name || "pack").replace(/[^a-zA-Z0-9 _\-]/g, "").trim() || "pack";
  a.download = `${safe}.broompack`;
  document.documentElement.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Parse and validate a dropped .broompack file. The SVGs are re-sanitized
// here — we never trust a file just because it claims our format. Returns
// { name, entries } ready to hand to saveCustomPack.
async function importBroompackFile(file) {
  let parsed;
  try {
    const text = await file.text();
    parsed = JSON.parse(text);
  } catch {
    throw new Error("That doesn't look like a valid .broompack file.");
  }
  if (!parsed || parsed.format !== BROOMPACK_FORMAT) {
    throw new Error("File isn't in the broompack format.");
  }
  if (typeof parsed.version === "number" && parsed.version > BROOMPACK_VERSION) {
    throw new Error("This pack was made by a newer Broom — please update first.");
  }
  if (parsed.type && parsed.type !== "plants") {
    throw new Error(`Pack type "${parsed.type}" isn't supported yet.`);
  }
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  if (!entries.length) throw new Error("Pack contains no blooms.");
  if (entries.length > MAX_PACK_FILES) {
    throw new Error(`Pack has ${entries.length} blooms — limit is ${MAX_PACK_FILES}.`);
  }
  const cleaned = [];
  for (const e of entries) {
    if (!e || typeof e.svg !== "string") continue;
    const safe = sanitizeSvg(e.svg);
    if (!safe) continue;
    cleaned.push({
      plantId: String(cleaned.length),
      name: typeof e.name === "string" ? e.name : "",
      svg: safe
    });
  }
  if (!cleaned.length) throw new Error("None of the blooms in that pack survived sanitization.");
  return {
    name: typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : "Imported pack",
    entries: cleaned
  };
}

async function deleteCustomPack(packId) {
  const idx = customPacksIndex.findIndex((p) => p.id === packId);
  if (idx < 0) return;
  customPacksIndex = customPacksIndex.filter((p) => p.id !== packId);
  delete customPacksData[packId];
  unregisterPackFromRegistry(packId);

  // Without the pack, the saved plant rules referencing custom:${packId}:*
  // would still try to render and fall back to pothos. The user explicitly
  // chose this pack — losing the pack means losing the planting. Delete
  // those rules across every host so reloading any tab won't resurrect a
  // dangling reference. The underlying hide rule is left intact (the user
  // can re-plant there later).
  const prefix = `custom:${packId}:`;
  const isFromDeletedPack = (r) =>
    r?.payload?.kind === "plant" &&
    typeof r?.payload?.plant?.kind === "string" &&
    r.payload.plant.kind.startsWith(prefix);

  // Current host: remove from DOM + in-memory list.
  for (const r of [...appliedRules]) {
    if (isFromDeletedPack(r)) removeRule(r.id);
  }
  appliedRules = appliedRules.filter((r) => !isFromDeletedPack(r));

  try {
    // All-hosts storage sweep.
    const all = await chrome.storage.local.get(RULES_KEY);
    const map = all[RULES_KEY] || {};
    let changed = false;
    for (const host of Object.keys(map)) {
      const before = map[host] || [];
      const after = before.filter((r) => !isFromDeletedPack(r));
      if (after.length !== before.length) {
        map[host] = after;
        changed = true;
      }
    }
    if (changed) await chrome.storage.local.set({ [RULES_KEY]: map });
    await chrome.storage.local.set({ [CUSTOM_PACKS_INDEX_KEY]: customPacksIndex });
    await chrome.storage.local.remove(CUSTOM_PACK_PREFIX + packId);
  } catch { /* */ }

  if (cachedPrefs.activePackId === packId) {
    await setPref("activePackId", null);
  }
  // If plant mode is open, the cleared slots should immediately show their
  // "empty plantable" affordance again.
  if (activeMode === "plant") renderEmptySlotAffordances();
}

function getVersionAndBuild() {
  // Prefer version_name (free-form, may include "1.0 (2)") over version (strict numeric).
  const manifest = chrome.runtime?.getManifest?.() || {};
  const raw = String(manifest.version_name || manifest.version || "0").trim();
  const paren = raw.match(/^([\d.]+)\s*\((\d+)\)$/);
  if (paren) return { version: paren[1], build: paren[2] };
  const parts = raw.split(".");
  const build = parts.length >= 4 ? parts[3] : "1";
  let head = parts.slice(0, Math.min(3, parts.length));
  while (head.length > 2 && head[head.length - 1] === "0") head.pop();
  return { version: head.join("."), build };
}

// ── Update check ──────────────────────────────────────────────────────────────
const BROOM_DOWNLOAD_URL = "https://yagoarconada.com/apps/broom.html";

// Numeric dot-segment compare (treats non-numeric as 0). 1.10 > 1.9.
function compareSemver(a, b) {
  const pa = String(a).split(".").map((s) => parseInt(s, 10) || 0);
  const pb = String(b).split(".").map((s) => parseInt(s, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va !== vb) return va < vb ? -1 : 1;
  }
  return 0;
}

const UPDATE_REFRESH_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15.5-6.3"/><path d="M21 4v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.3"/><path d="M3 20v-5h5"/></svg>`;
const UPDATE_CHECK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="5 12 10 17 19 7"/></svg>`;
const UPDATE_DOWNLOAD_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v12"/><polyline points="6 12 12 18 18 12"/><path d="M5 20h14"/></svg>`;

function setUpdateButtonState(btn, state, opts = {}) {
  if (!btn) return;
  btn.className = "bs-update-btn";
  btn.dataset.state = state;
  btn.disabled = false;
  let statusMessage = "";
  switch (state) {
    case "checking":
      btn.classList.add("is-checking");
      btn.innerHTML = UPDATE_REFRESH_SVG;
      btn.title = "Checking for updates…";
      btn.setAttribute("aria-label", "Checking for updates");
      btn.disabled = true;
      break;
    case "uptodate":
      btn.classList.add("is-uptodate");
      btn.innerHTML = UPDATE_CHECK_SVG;
      btn.title = "You're on the latest version";
      btn.setAttribute("aria-label", "Up to date");
      statusMessage = "You're on the latest version";
      break;
    case "available":
      btn.classList.add("has-update");
      btn.innerHTML = `${UPDATE_DOWNLOAD_SVG}<span class="bs-update-label">Update</span>`;
      btn.title = opts.latest ? `Download Broom ${opts.latest}` : "Download update";
      btn.setAttribute("aria-label", "Download update");
      break;
    case "error":
      btn.innerHTML = UPDATE_REFRESH_SVG;
      btn.title = opts.message || "Couldn't check for updates — click to retry";
      btn.setAttribute("aria-label", "Update check failed");
      statusMessage = "Couldn't check for updates — try again later";
      break;
    default:
      btn.innerHTML = UPDATE_REFRESH_SVG;
      btn.title = "Check for updates";
      btn.setAttribute("aria-label", "Check for updates");
  }
  const versionContainer = btn.closest(".bs-version");
  const status = versionContainer && versionContainer.querySelector(".bs-update-status");
  if (status) {
    if (statusMessage) {
      status.textContent = statusMessage;
      status.classList.add("is-visible");
    } else {
      status.classList.remove("is-visible");
      status.textContent = "";
    }
  }
}

function requestUpdateCheck() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "broom:checkUpdate" }, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(resp || { ok: false, error: "No response" });
      });
    } catch (e) {
      resolve({ ok: false, error: String((e && e.message) || e) });
    }
  });
}

// Plant catalog (POT_SVGS, PLANT_SVGS, PLANT_NAMES) is inlined further down
// just above renderPlant. It used to live in lib/plants.js but iOS Safari's
// content-script runtime didn't expose its top-level const bindings here.

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

// Map a swept-element box to a plant size class. Shared by initial planting
// (chooseRandomPlant) and by drag-and-drop moves so a plant always matches
// its current slot's footprint.
function plantSizeForBox(box) {
  const h = (box && box.height) || 120;
  return h > 180 ? "lg" : h > 90 ? "md" : "sm";
}

function chooseRandomPlant(hideRule) {
  const box = (hideRule.payload && hideRule.payload.originalBox) || { width: 120, height: 120 };
  const h = box.height;

  // If the user has activated a custom bloom pack, draw from that pool
  // exclusively. Pots still get rolled the same way as built-ins so the
  // custom plant looks like it belongs in the same garden.
  const customKinds = activePackKinds();
  if (customKinds) {
    return {
      kind: randomFrom(customKinds),
      size: plantSizeForBox(box),
      animation: "gentle-sway",
      pot: randomFrom(["terracotta", "ceramic"])
    };
  }

  const small = ["succulent", "fern", "snake-plant", "cactus", "aloe", "lavender", "pine", "tulips", "topiary", "air-plant", "daisies", "pilea"];
  const medium = ["pothos", "fern", "snake-plant", "monstera", "cactus", "aloe", "peace-lily", "calathea", "orchid", "zz-plant", "spider-plant", "cherry-blossom", "eucalyptus", "tulips", "sunflower", "topiary", "string-of-pearls", "rose-bush", "hydrangea", "bonsai", "daisies", "pilea", "maple"];
  const large = ["bird-of-paradise", "monstera", "pothos", "bamboo", "palm", "fiddle-leaf", "orchid", "zz-plant", "spider-plant", "pampas", "cherry-blossom", "eucalyptus", "sunflower", "rose-bush", "hydrangea", "bonsai", "maple"];
  const pool = h < 90 ? small : h > 180 ? large : medium;
  return {
    kind: randomFrom(pool),
    size: plantSizeForBox(box),
    animation: "gentle-sway",
    pot: randomFrom(["terracotta", "ceramic"])
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

// Hide rules are page-wide CSS, and buildSelector can return something as broad
// as `span` when it was unique at sweep time, so keep them off Broom's own UI
// (settings, launcher, toasts, plants), which didn't exist when the rule was made.
function hideRuleCss(selector) {
  const ours = `${OUR_UI_SELECTOR},#broom-tag,#${PLANT_TOAST_ID},[${INJECTED_ATTR}]`;
  return `:is(${selector}):not(${ours}):not(:is(${ours}) *) { display: none !important; }`;
}

function applyRule(rule, options) {
  if (!rule.enabled) { removeRule(rule.id); return; }
  if (cachedPrefs.showChanges === false) { removeRule(rule.id); return; }
  const { kind } = rule.payload;
  if (kind === "hide") {
    styleCache.set(rule.id, hideRuleCss(rule.selector.primary));
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

// Returns a short, human-friendly relative time like "just now", "3 days
// ago", "last month". Used for the handwritten name-note that appears
// below a plant on hover (e.g. "planted 3 days ago"). Pure local logic,
// no Intl.RelativeTimeFormat dependency so behavior is identical across
// all the browsers the extension ships into.
function formatPlantedAgo(createdAt) {
  const ts = typeof createdAt === "number" ? createdAt : Date.parse(createdAt);
  if (!ts || Number.isNaN(ts)) return "";
  const diffMs = Math.max(0, Date.now() - ts);
  const sec = Math.floor(diffMs / 1000);
  if (sec < 45) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 2)  return "a minute ago";
  if (min < 60) return `${min} minutes ago`;
  const hr = Math.floor(min / 60);
  if (hr < 2)   return "an hour ago";
  if (hr < 24)  return `${hr} hours ago`;
  const day = Math.floor(hr / 24);
  if (day < 2)  return "yesterday";
  if (day < 7)  return `${day} days ago`;
  const wk = Math.floor(day / 7);
  if (wk < 2)   return "last week";
  if (wk < 5)   return `${wk} weeks ago`;
  const mo = Math.floor(day / 30);
  if (mo < 2)   return "last month";
  if (mo < 12)  return `${mo} months ago`;
  const yr = Math.floor(day / 365);
  if (yr < 2)   return "a year ago";
  return `${yr} years ago`;
}

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
    const w = Math.max(80, Math.min(box.width, 480));
    slot.style.width = `${w}px`;
    slot.style.maxWidth = `${w}px`;
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

  // Handwritten name-note: hangs below the pot on hover and gently expands
  // (revealing "planted N days ago") when the user moves onto the note
  // itself. Visibility is gated purely in CSS by `html:not([data-broom-mode])`
  // so the note never collides with the broom-mode selector tag or the
  // plant-mode "Plant here" affordance.
  const note = document.createElement("div");
  note.className = "broom-plant-note";
  note.setAttribute("aria-hidden", "true");
  const noteName = document.createElement("span");
  noteName.className = "broom-plant-note-name";
  noteName.textContent = PLANT_NAMES[rule.payload.plant.kind] || "plant";
  const noteDate = document.createElement("span");
  noteDate.className = "broom-plant-note-date";
  const ago = formatPlantedAgo(rule.createdAt);
  noteDate.textContent = ago ? `planted ${ago}` : "";
  note.appendChild(noteName);
  if (noteDate.textContent) note.appendChild(noteDate);
  slot.appendChild(note);

  slot.addEventListener("mouseenter", () => {
    if (document.documentElement.dataset.broomMode === "broom") return;
    if (activePlantDrag) return;
    if (plant.classList.contains("broom-plant-enter")) return;
    plant.classList.remove("broom-plant-hovering");
    void plant.offsetWidth;
    plant.classList.add("broom-plant-hovering");
  });
  slot.addEventListener("mouseleave", () => {
    plant.classList.remove("broom-plant-hovering");
  });
  slot.addEventListener("click", (e) => {
    // Suppress click that immediately follows a drag (pointer-event ordering:
    // pointerup → click). The drag flow sets this flag synchronously on the
    // slot so the next click is consumed without watering the plant.
    if (slot._broomDragJustEnded) {
      delete slot._broomDragJustEnded;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (activeMode !== null && activeMode !== "plant") return;
    if (plant.classList.contains("broom-plant-enter")) return;
    e.preventDefault();
    e.stopPropagation();
    spawnRaindrop(slot, plant, e);
  });
  plant.addEventListener("animationend", (e) => {
    if (e.animationName === "broom-plant-popin") {
      plant.classList.remove("broom-plant-enter");
    }
  });

  attachPlantDragHandlers(slot, plant, rule);

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
      s.style.cssText = `bottom:auto;top:${landingY}px;--px:${px}px;--py:${py}px;background:#7ab8e8;--dur:${dur}ms;--delay:${delay}ms`;
      s.style.setProperty("left", `${clickX}px`, "important");
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


// ── Plant & pot catalog (inlined from former lib/plants.js so content.js
//    is self-contained; iOS Safari's content-script runtime didn't expose
//    the lib/plants.js top-level const bindings to this script). ──────────
const POT_SVGS = {
  terracotta: `<svg viewBox="0 0 100 60" preserveAspectRatio="none" aria-hidden="true"><path d="M14 6 L86 6 L78 56 Q50 60 22 56 Z" fill="#c2683a"/><path d="M14 6 L86 6 L82 18 Q50 22 18 18 Z" fill="#a8542a"/><rect x="10" y="2" width="80" height="6" rx="2" fill="#b85a30"/></svg>`,
  ceramic: `<svg viewBox="0 0 100 60" preserveAspectRatio="none" aria-hidden="true"><path d="M16 4 Q50 0 84 4 L78 56 Q50 60 22 56 Z" fill="#ece7dd"/><ellipse cx="50" cy="6" rx="34" ry="4" fill="#d8d2c4"/><path d="M22 56 Q50 60 78 56 L78 50 Q50 54 22 50 Z" fill="#c8c2b3"/></svg>`,
  none: ""
};

const PLANT_SVGS = {
  // ── Original 6 ────────────────────────────────────────────────────────────
  pothos: `<svg viewBox="0 0 100 100" aria-hidden="true"><g fill="none" stroke="#3a7a3f" stroke-width="2.5" stroke-linecap="round"><path d="M50 92 Q42 70 30 52 Q20 38 14 22"/><path d="M50 92 Q58 70 70 52 Q80 38 86 22"/><path d="M50 92 Q50 72 48 50 Q44 30 40 14"/><path d="M50 92 Q56 80 64 70 Q72 60 76 50"/></g><g fill="#5cb262" stroke="#2e6b35" stroke-width="1.2" stroke-linejoin="round"><path d="M14 22 q-8 -1 -10 6 q3 7 11 5 q5 -3 -1 -11 z"/><path d="M40 14 q-9 1 -9 9 q6 5 13 2 q3 -4 -4 -11 z"/><path d="M30 52 q-10 0 -10 8 q5 6 13 3 q4 -4 -3 -11 z"/><path d="M48 50 q-9 -2 -11 6 q5 7 13 4 q4 -4 -2 -10 z"/><path d="M70 52 q10 0 10 8 q-5 6 -13 3 q-4 -4 3 -11 z"/><path d="M86 22 q8 -1 10 6 q-3 7 -11 5 q-5 -3 1 -11 z"/><path d="M76 50 q9 -1 10 7 q-5 5 -12 3 q-3 -4 2 -10 z"/></g></svg>`,
  "bird-of-paradise": `<svg viewBox="0 0 100 100" aria-hidden="true"><g stroke="#2e6b35" stroke-width="1.2" stroke-linejoin="round"><path d="M50 95 Q38 70 30 40 Q26 22 32 8 Q42 26 46 56 Q47 78 50 95 Z" fill="#4ea05a"/><path d="M50 95 Q62 70 70 40 Q74 22 68 8 Q58 26 54 56 Q53 78 50 95 Z" fill="#4ea05a"/><path d="M50 95 Q50 60 50 30 Q52 14 56 4 Q54 30 52 60 Q51 80 50 95 Z" fill="#3f8a4d"/><path d="M50 95 Q42 78 38 60 Q34 44 36 26 Q42 44 44 64 Q45 80 50 95 Z" fill="#5db867"/><path d="M50 95 Q58 78 62 60 Q66 44 64 26 Q58 44 56 64 Q55 80 50 95 Z" fill="#5db867"/></g><g stroke="#a64a1a" stroke-width="1"><path d="M48 56 q-8 -4 -10 -12 q6 0 10 6 z" fill="#e8723a"/><path d="M52 56 q8 -4 10 -12 q-6 0 -10 6 z" fill="#d6a23a"/></g></svg>`,
  "snake-plant": `<svg viewBox="0 0 100 100" aria-hidden="true"><g stroke="#2e6b35" stroke-width="1.2" stroke-linejoin="round"><path d="M50 95 Q44 60 40 30 Q38 14 44 4 Q48 24 50 60 Q50 80 50 95 Z" fill="#5fa55a"/><path d="M50 95 Q56 60 60 30 Q62 14 56 4 Q52 24 50 60 Q50 80 50 95 Z" fill="#4f944c"/><path d="M50 95 Q42 70 36 50 Q30 32 28 18 Q38 36 44 60 Q47 80 50 95 Z" fill="#6db768"/><path d="M50 95 Q58 70 64 50 Q70 32 72 18 Q62 36 56 60 Q53 80 50 95 Z" fill="#3f7e3d"/></g><g stroke="#d4d77a" stroke-width="1.4" fill="none" opacity="0.55"><path d="M44 14 q1 8 0 18"/><path d="M50 8 q0 12 0 22"/><path d="M56 14 q-1 8 0 18"/></g></svg>`,
  monstera: `<svg viewBox="0 0 100 100" aria-hidden="true"><g stroke="#2e6b35" stroke-width="1.2" stroke-linejoin="round"><path d="M28 70 Q12 50 14 30 Q26 22 38 32 Q44 18 50 22 Q44 38 46 56 Q40 70 28 70 Z" fill="#4fa358"/><path d="M72 65 Q88 48 86 28 Q74 20 62 30 Q58 16 52 20 Q56 36 54 54 Q60 68 72 65 Z" fill="#5db867"/><path d="M50 90 Q42 78 42 64 Q42 50 50 36 Q58 50 58 64 Q58 78 50 90 Z" fill="#3f8a4d"/></g><g stroke="#2e6b35" stroke-width="1.2" fill="none" stroke-linecap="round"><path d="M22 36 q5 4 8 4"/><path d="M26 50 q5 3 9 3"/><path d="M78 36 q-5 4 -8 4"/><path d="M74 50 q-5 3 -9 3"/></g><path d="M50 90 Q50 70 50 50 Q50 30 50 18" stroke="#2e6b35" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>`,
  fern: `<svg viewBox="0 0 100 100" aria-hidden="true"><g stroke="#2e6b35" stroke-width="1.4" stroke-linecap="round" fill="none"><path d="M50 95 Q42 70 26 50 Q16 38 8 30"/><path d="M50 95 Q58 70 74 50 Q84 38 92 30"/><path d="M50 95 Q48 70 44 40 Q42 22 40 8"/><path d="M50 95 Q52 70 56 40 Q58 22 60 8"/><path d="M50 95 Q50 70 50 40 Q50 22 50 4"/></g><g fill="#5db867" stroke="#3a7a3f" stroke-width="0.8"><ellipse cx="14" cy="34" rx="6" ry="2.4" transform="rotate(-30 14 34)"/><ellipse cx="22" cy="44" rx="6" ry="2.4" transform="rotate(-22 22 44)"/><ellipse cx="32" cy="54" rx="6" ry="2.4" transform="rotate(-15 32 54)"/><ellipse cx="86" cy="34" rx="6" ry="2.4" transform="rotate(30 86 34)"/><ellipse cx="78" cy="44" rx="6" ry="2.4" transform="rotate(22 78 44)"/><ellipse cx="68" cy="54" rx="6" ry="2.4" transform="rotate(15 68 54)"/><ellipse cx="42" cy="20" rx="5" ry="2.2" transform="rotate(-10 42 20)"/><ellipse cx="58" cy="20" rx="5" ry="2.2" transform="rotate(10 58 20)"/><ellipse cx="44" cy="36" rx="5" ry="2.2" transform="rotate(-10 44 36)"/><ellipse cx="56" cy="36" rx="5" ry="2.2" transform="rotate(10 56 36)"/><ellipse cx="50" cy="14" rx="5" ry="2.2"/><ellipse cx="50" cy="30" rx="5" ry="2.2"/><ellipse cx="50" cy="48" rx="5" ry="2.2"/></g></svg>`,
  succulent: `<svg viewBox="0 0 100 100" aria-hidden="true"><g stroke="#2e6b35" stroke-width="1.2" stroke-linejoin="round"><ellipse cx="50" cy="80" rx="24" ry="10" fill="#6dbf68"/><ellipse cx="30" cy="64" rx="10" ry="14" transform="rotate(-30 30 64)" fill="#5db35e"/><ellipse cx="70" cy="64" rx="10" ry="14" transform="rotate(30 70 64)" fill="#5db35e"/><ellipse cx="38" cy="50" rx="9" ry="14" transform="rotate(-15 38 50)" fill="#7bc97a"/><ellipse cx="62" cy="50" rx="9" ry="14" transform="rotate(15 62 50)" fill="#7bc97a"/><ellipse cx="50" cy="42" rx="8" ry="14" fill="#8fd687"/><ellipse cx="50" cy="58" rx="6" ry="10" fill="#a2dd92"/></g></svg>`,

  // ── New 10 (fill-the-square designs) ──────────────────────────────────────

  // Columnar cactus with two arms spreading wide, ribs and spines to edges
  cactus: `<svg viewBox="0 0 100 100" aria-hidden="true"><g fill="#5a9e4a" stroke="#2e6b35" stroke-width="1.2" stroke-linejoin="round"><path d="M42 96 Q38 70 38 50 Q38 30 42 10 Q44 6 50 6 Q56 6 58 10 Q62 30 62 50 Q62 70 58 96 Z"/><path d="M38 44 Q20 40 8 38 Q4 44 8 50 Q20 52 38 50 Z"/><path d="M62 38 Q80 34 92 32 Q96 38 92 44 Q80 46 62 44 Z"/></g><g stroke="#1a4a1a" stroke-width="0.8" fill="none"><line x1="44" y1="20" x2="40" y2="20"/><line x1="44" y1="32" x2="40" y2="32"/><line x1="44" y1="44" x2="40" y2="44"/><line x1="44" y1="56" x2="40" y2="56"/><line x1="44" y1="68" x2="40" y2="68"/><line x1="44" y1="80" x2="40" y2="80"/><line x1="56" y1="20" x2="60" y2="20"/><line x1="56" y1="32" x2="60" y2="32"/><line x1="56" y1="44" x2="60" y2="44"/><line x1="56" y1="56" x2="60" y2="56"/><line x1="56" y1="68" x2="60" y2="68"/><line x1="56" y1="80" x2="60" y2="80"/><line x1="14" y1="42" x2="14" y2="38"/><line x1="20" y1="44" x2="20" y2="40"/><line x1="26" y1="45" x2="26" y2="41"/><line x1="86" y1="36" x2="86" y2="32"/><line x1="80" y1="38" x2="80" y2="34"/><line x1="74" y1="39" x2="74" y2="35"/></g></svg>`,

  // Tall bamboo stalks with leaves spreading to both sides
  bamboo: `<svg viewBox="0 0 100 100" aria-hidden="true"><g fill="#6aaa48" stroke="#3a6e28" stroke-width="1.4"><rect x="38" y="4" width="10" height="92" rx="3"/><rect x="52" y="10" width="9" height="86" rx="3"/><rect x="26" y="16" width="9" height="80" rx="3"/></g><g stroke="#3a6e28" stroke-width="1.2" fill="none"><line x1="38" y1="20" x2="48" y2="20"/><line x1="38" y1="36" x2="48" y2="36"/><line x1="38" y1="52" x2="48" y2="52"/><line x1="38" y1="68" x2="48" y2="68"/><line x1="38" y1="84" x2="48" y2="84"/><line x1="52" y1="26" x2="61" y2="26"/><line x1="52" y1="42" x2="61" y2="42"/><line x1="52" y1="58" x2="61" y2="58"/><line x1="52" y1="74" x2="61" y2="74"/><line x1="26" y1="32" x2="35" y2="32"/><line x1="26" y1="48" x2="35" y2="48"/><line x1="26" y1="64" x2="35" y2="64"/></g><g fill="#4d9630" stroke="#2e6b1a" stroke-width="0.9" stroke-linejoin="round"><path d="M48 22 Q62 16 78 10 Q74 22 62 26 Q54 26 48 22 Z"/><path d="M48 38 Q60 32 74 28 Q72 40 60 42 Q52 42 48 38 Z"/><path d="M38 54 Q24 48 8 44 Q12 56 24 58 Q34 58 38 54 Z"/><path d="M61 44 Q76 38 94 34 Q90 46 78 48 Q68 48 61 44 Z"/><path d="M35 66 Q20 60 4 56 Q8 68 20 70 Q30 70 35 66 Z"/><path d="M61 60 Q76 54 96 50 Q92 62 80 64 Q70 64 61 60 Z"/></g></svg>`,

  // Wide tropical palm with arching fronds filling the full square
  palm: `<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M50 96 Q50 70 50 44" stroke="#6b4c28" stroke-width="5" fill="none" stroke-linecap="round"/><g fill="#4fa83a" stroke="#2e6b1a" stroke-width="1.1" stroke-linejoin="round"><path d="M50 44 Q36 28 6 8 Q16 8 28 20 Q40 30 50 44 Z"/><path d="M50 44 Q64 28 94 8 Q84 8 72 20 Q60 30 50 44 Z"/><path d="M50 44 Q28 38 2 42 Q8 52 24 52 Q40 50 50 44 Z"/><path d="M50 44 Q72 38 98 42 Q92 52 76 52 Q60 50 50 44 Z"/><path d="M50 44 Q40 24 34 4 Q44 10 48 26 Q50 36 50 44 Z"/><path d="M50 44 Q60 24 66 4 Q56 10 52 26 Q50 36 50 44 Z"/><path d="M50 44 Q18 52 4 68 Q16 64 30 56 Q42 50 50 44 Z"/><path d="M50 44 Q82 52 96 68 Q84 64 70 56 Q58 50 50 44 Z"/></g></svg>`,

  // Aloe vera with thick spiky leaves radiating from base, filling the square
  aloe: `<svg viewBox="0 0 100 100" aria-hidden="true"><g stroke="#2a6e32" stroke-width="1.2" stroke-linejoin="round"><path d="M50 92 Q34 70 20 40 Q16 22 20 8 Q30 24 36 52 Q42 72 50 92 Z" fill="#6bb84a"/><path d="M50 92 Q66 70 80 40 Q84 22 80 8 Q70 24 64 52 Q58 72 50 92 Z" fill="#5aa83c"/><path d="M50 92 Q40 68 28 44 Q18 28 14 12 Q28 30 40 56 Q46 74 50 92 Z" fill="#7dca5a"/><path d="M50 92 Q60 68 72 44 Q82 28 86 12 Q72 30 60 56 Q54 74 50 92 Z" fill="#4e9634"/><path d="M50 92 Q46 72 38 54 Q28 36 22 20 Q34 38 44 60 Q48 76 50 92 Z" fill="#8ed468"/><path d="M50 92 Q54 72 62 54 Q72 36 78 20 Q66 38 56 60 Q52 76 50 92 Z" fill="#63b04a"/></g><g stroke="#c8d86a" stroke-width="1" fill="none" opacity="0.5"><path d="M26 28 q3 10 2 20"/><path d="M36 18 q1 12 0 24"/><path d="M64 18 q-1 12 0 24"/><path d="M74 28 q-3 10 -2 20"/></g></svg>`,

  // Orchid with tall arching stem, blooms spread wide
  orchid: `<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M50 96 Q50 80 52 64 Q56 48 62 34 Q68 20 72 8" stroke="#5a8a3e" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M50 96 Q50 80 48 64 Q44 48 38 34 Q32 20 28 8" stroke="#5a8a3e" stroke-width="1.6" fill="none" stroke-linecap="round" opacity="0.7"/><g fill="#e8a0c8" stroke="#c06090" stroke-width="1"><path d="M72 8 q-6 -6 -12 0 q-2 6 6 8 q8 0 6 -8 z"/><path d="M72 8 q6 -4 8 4 q0 8 -8 6 q-4 -4 0 -10 z"/><path d="M72 8 q2 8 -2 12 q-6 2 -8 -4 q2 -8 10 -8 z"/></g><circle cx="72" cy="10" r="3" fill="#f5d020" stroke="#c8a010" stroke-width="0.8"/><g fill="#e8a0c8" stroke="#c06090" stroke-width="1"><path d="M62 34 q-6 -6 -12 0 q-2 6 6 8 q8 0 6 -8 z"/><path d="M62 34 q6 -4 8 4 q0 8 -8 6 q-4 -4 0 -10 z"/><path d="M62 34 q2 8 -2 12 q-6 2 -8 -4 q2 -8 10 -8 z"/></g><circle cx="62" cy="36" r="3" fill="#f5d020" stroke="#c8a010" stroke-width="0.8"/><g fill="#f0b8d8" stroke="#c06090" stroke-width="1"><path d="M38 34 q-6 -6 -12 0 q-2 6 6 8 q8 0 6 -8 z"/><path d="M38 34 q6 -4 8 4 q0 8 -8 6 q-4 -4 0 -10 z"/><path d="M38 34 q2 8 -2 12 q-6 2 -8 -4 q2 -8 10 -8 z"/></g><circle cx="38" cy="36" r="3" fill="#f5d020" stroke="#c8a010" stroke-width="0.8"/><g fill="#4e8a38" stroke="#2e6b1a" stroke-width="1.2" stroke-linejoin="round"><path d="M50 80 Q30 80 8 86 Q14 96 30 92 Q44 88 50 80 Z"/><path d="M50 80 Q70 80 92 86 Q86 96 70 92 Q56 88 50 80 Z"/></g></svg>`,

  // Peace lily with broad dark leaves and white spathe, fills entire square
  "peace-lily": `<svg viewBox="0 0 100 100" aria-hidden="true"><g fill="#2d6e35" stroke="#1a4a22" stroke-width="1.2" stroke-linejoin="round"><path d="M50 94 Q30 72 10 46 Q6 28 14 12 Q28 34 38 62 Q44 80 50 94 Z"/><path d="M50 94 Q70 72 90 46 Q94 28 86 12 Q72 34 62 62 Q56 80 50 94 Z"/><path d="M50 94 Q36 76 18 56 Q8 40 8 22 Q24 42 38 66 Q46 82 50 94 Z"/><path d="M50 94 Q64 76 82 56 Q92 40 92 22 Q76 42 62 66 Q54 82 50 94 Z"/><path d="M50 94 Q44 74 40 52 Q34 32 34 14 Q44 36 48 60 Q50 78 50 94 Z"/><path d="M50 94 Q56 74 60 52 Q66 32 66 14 Q56 36 52 60 Q50 78 50 94 Z"/></g><g><path d="M50 88 Q50 68 50 50 Q50 36 52 22" stroke="#3a7a3e" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M52 22 Q44 12 38 4 Q50 6 56 14 Q58 20 52 22 Z" fill="#f5f5ee" stroke="#c8c8b8" stroke-width="1"/><ellipse cx="52" cy="10" rx="2" ry="8" fill="#f0e870" stroke="#c8c020" stroke-width="0.8" transform="rotate(-8 52 10)"/></g></svg>`,

  // Fiddle leaf fig with large violin-shaped leaves filling wide and tall
  "fiddle-leaf": `<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M50 98 Q50 72 50 46 Q50 22 50 6" stroke="#6b4c28" stroke-width="3" fill="none" stroke-linecap="round"/><g fill="#3a8e40" stroke="#1e5e28" stroke-width="1.2" stroke-linejoin="round"><path d="M50 46 Q26 42 4 52 Q2 66 14 72 Q30 76 46 64 Q52 56 50 46 Z"/><path d="M50 46 Q74 42 96 52 Q98 66 86 72 Q70 76 54 64 Q48 56 50 46 Z"/><path d="M50 26 Q28 18 6 24 Q4 38 18 44 Q34 48 48 36 Q52 30 50 26 Z"/><path d="M50 26 Q72 18 94 24 Q96 38 82 44 Q66 48 52 36 Q48 30 50 26 Z"/><path d="M50 66 Q34 64 16 74 Q14 86 26 90 Q40 92 50 80 Q54 74 50 66 Z"/><path d="M50 66 Q66 64 84 74 Q86 86 74 90 Q60 92 50 80 Q46 74 50 66 Z"/></g><g stroke="#1e5e28" stroke-width="0.9" fill="none" opacity="0.6"><path d="M18 56 Q26 60 34 58"/><path d="M82 56 Q74 60 66 58"/><path d="M14 30 Q22 34 30 32"/><path d="M86 30 Q78 34 70 32"/></g></svg>`,

  // Calathea with broad oval leaves, striped patterns, fanned wide
  calathea: `<svg viewBox="0 0 100 100" aria-hidden="true"><g fill="#3e9448" stroke="#1e6230" stroke-width="1.2" stroke-linejoin="round"><path d="M50 92 Q26 76 6 52 Q4 34 16 22 Q32 40 42 66 Q46 80 50 92 Z"/><path d="M50 92 Q74 76 94 52 Q96 34 84 22 Q68 40 58 66 Q54 80 50 92 Z"/><path d="M50 92 Q32 78 14 60 Q6 44 8 28 Q26 46 40 70 Q46 82 50 92 Z"/><path d="M50 92 Q68 78 86 60 Q94 44 92 28 Q74 46 60 70 Q54 82 50 92 Z"/></g><g stroke="#8fcc5a" stroke-width="1.4" fill="none" opacity="0.6"><path d="M22 38 Q28 46 30 56"/><path d="M78 38 Q72 46 70 56"/><path d="M18 52 Q24 58 26 66"/><path d="M82 52 Q76 58 74 66"/></g><g stroke="#cc6680" stroke-width="1.4" fill="none" opacity="0.4"><path d="M26 44 Q30 50 32 58"/><path d="M74 44 Q70 50 68 58"/></g></svg>`,

  // ZZ plant with arching stems bearing glossy oval leaflets, very wide spread
  "zz-plant": `<svg viewBox="0 0 100 100" aria-hidden="true"><g stroke="#2e6b35" stroke-width="1.6" fill="none" stroke-linecap="round"><path d="M50 96 Q38 78 20 58 Q8 44 4 26"/><path d="M50 96 Q62 78 80 58 Q92 44 96 26"/><path d="M50 96 Q42 80 30 68 Q14 56 6 42"/><path d="M50 96 Q58 80 70 68 Q86 56 94 42"/></g><g fill="#4aaa50" stroke="#1e6e28" stroke-width="1"><ellipse cx="6" cy="24" rx="7" ry="4.5" transform="rotate(-50 6 24)"/><ellipse cx="14" cy="36" rx="7" ry="4.5" transform="rotate(-44 14 36)"/><ellipse cx="24" cy="48" rx="7" ry="4.5" transform="rotate(-36 24 48)"/><ellipse cx="36" cy="60" rx="7" ry="4.5" transform="rotate(-26 36 60)"/><ellipse cx="94" cy="24" rx="7" ry="4.5" transform="rotate(50 94 24)"/><ellipse cx="86" cy="36" rx="7" ry="4.5" transform="rotate(44 86 36)"/><ellipse cx="76" cy="48" rx="7" ry="4.5" transform="rotate(36 76 48)"/><ellipse cx="64" cy="60" rx="7" ry="4.5" transform="rotate(26 64 60)"/><ellipse cx="8" cy="40" rx="7" ry="4.5" transform="rotate(-46 8 40)"/><ellipse cx="18" cy="52" rx="7" ry="4.5" transform="rotate(-38 18 52)"/><ellipse cx="30" cy="62" rx="7" ry="4.5" transform="rotate(-28 30 62)"/><ellipse cx="92" cy="40" rx="7" ry="4.5" transform="rotate(46 92 40)"/><ellipse cx="82" cy="52" rx="7" ry="4.5" transform="rotate(38 82 52)"/><ellipse cx="70" cy="62" rx="7" ry="4.5" transform="rotate(28 70 62)"/></g></svg>`,

  // Lavender with many thin stems topped with purple flower spikes, fills full height
  lavender: `<svg viewBox="0 0 100 100" aria-hidden="true"><g stroke="#7a8a3e" stroke-width="1.4" fill="none" stroke-linecap="round"><path d="M26 96 Q24 76 20 56 Q18 40 16 22"/><path d="M34 96 Q34 76 32 56 Q32 40 30 24"/><path d="M42 96 Q42 76 42 56 Q42 40 42 20"/><path d="M50 96 Q50 76 50 56 Q50 40 50 18"/><path d="M58 96 Q58 76 58 56 Q58 40 58 20"/><path d="M66 96 Q66 76 68 56 Q68 40 70 24"/><path d="M74 96 Q76 76 80 56 Q82 40 84 22"/></g><g fill="#9060c8" stroke="#6040a0" stroke-width="0.8"><ellipse cx="16" cy="18" rx="3" ry="6"/><ellipse cx="20" cy="12" rx="3" ry="5"/><ellipse cx="24" cy="8" rx="2.5" ry="4.5"/><ellipse cx="30" cy="20" rx="3" ry="6"/><ellipse cx="34" cy="14" rx="3" ry="5"/><ellipse cx="38" cy="8" rx="2.5" ry="4.5"/><ellipse cx="42" cy="16" rx="3" ry="6"/><ellipse cx="46" cy="10" rx="3" ry="5"/><ellipse cx="50" cy="4" rx="2.5" ry="5"/><ellipse cx="54" cy="10" rx="3" ry="5"/><ellipse cx="58" cy="16" rx="3" ry="6"/><ellipse cx="62" cy="8" rx="2.5" ry="4.5"/><ellipse cx="66" cy="14" rx="3" ry="5"/><ellipse cx="70" cy="20" rx="3" ry="6"/><ellipse cx="76" cy="8" rx="2.5" ry="4.5"/><ellipse cx="80" cy="14" rx="3" ry="5"/><ellipse cx="84" cy="18" rx="3" ry="6"/></g><g fill="#b888e8" stroke="none" opacity="0.5"><ellipse cx="16" cy="14" rx="2" ry="4"/><ellipse cx="30" cy="16" rx="2" ry="4"/><ellipse cx="42" cy="12" rx="2" ry="4"/><ellipse cx="50" cy="6" rx="2" ry="3.5"/><ellipse cx="58" cy="12" rx="2" ry="4"/><ellipse cx="70" cy="16" rx="2" ry="4"/><ellipse cx="84" cy="14" rx="2" ry="4"/></g></svg>`,

  // ── Batch 3: another 10 (fill-the-square designs) ────────────────────────

  // Spider plant: arching striped leaves cascading from center, spilling over edges
  "spider-plant": `<svg viewBox="0 0 100 100" aria-hidden="true"><g stroke="#2a6e3a" stroke-width="1.1" stroke-linejoin="round"><path d="M50 60 Q30 50 14 30 Q8 14 12 2 Q22 22 36 42 Q44 56 50 60 Z" fill="#5fa84e"/><path d="M50 60 Q70 50 86 30 Q92 14 88 2 Q78 22 64 42 Q56 56 50 60 Z" fill="#5fa84e"/><path d="M50 60 Q40 46 26 26 Q14 8 6 2 Q22 18 38 38 Q46 54 50 60 Z" fill="#7dca5a"/><path d="M50 60 Q60 46 74 26 Q86 8 94 2 Q78 18 62 38 Q54 54 50 60 Z" fill="#7dca5a"/><path d="M50 60 Q42 80 26 94 Q14 98 4 96 Q22 86 36 78 Q46 66 50 60 Z" fill="#4a9038"/><path d="M50 60 Q58 80 74 94 Q86 98 96 96 Q78 86 64 78 Q54 66 50 60 Z" fill="#4a9038"/><path d="M50 60 Q44 84 38 96 Q44 92 50 88 Q56 92 62 96 Q56 84 50 60 Z" fill="#6dbf68"/></g><g stroke="#f5f0c8" stroke-width="0.8" fill="none" opacity="0.7"><path d="M22 14 q4 14 14 28"/><path d="M78 14 q-4 14 -14 28"/><path d="M14 30 q8 8 16 14"/><path d="M86 30 q-8 8 -16 14"/><path d="M26 88 q6 -8 16 -14"/><path d="M74 88 q-6 -8 -16 -14"/></g></svg>`,

  // Pampas grass: tall stalks topped with feathery plumes reaching the top edge
  pampas: `<svg viewBox="0 0 100 100" aria-hidden="true"><g stroke="#a8946a" stroke-width="1.2" fill="none" stroke-linecap="round"><path d="M30 96 Q26 60 22 30 Q20 16 18 4"/><path d="M50 96 Q50 60 50 30 Q50 14 50 2"/><path d="M70 96 Q74 60 78 30 Q80 16 82 4"/><path d="M40 96 Q38 70 36 44 Q34 28 32 14"/><path d="M60 96 Q62 70 64 44 Q66 28 68 14"/></g><g fill="#e8d8a0" stroke="#b89e60" stroke-width="0.6" stroke-linejoin="round"><path d="M18 4 q-12 4 -12 22 q5 -2 9 -10 q5 -6 3 -12 z"/><path d="M18 4 q12 4 12 22 q-5 -2 -9 -10 q-5 -6 -3 -12 z"/><path d="M50 2 q-14 4 -14 24 q6 -2 10 -10 q6 -8 4 -14 z"/><path d="M50 2 q14 4 14 24 q-6 -2 -10 -10 q-6 -8 -4 -14 z"/><path d="M82 4 q-12 4 -12 22 q5 -2 9 -10 q5 -6 3 -12 z"/><path d="M82 4 q12 4 12 22 q-5 -2 -9 -10 q-5 -6 -3 -12 z"/><path d="M32 14 q-9 3 -9 16 q4 -2 7 -7 q4 -5 2 -9 z"/><path d="M32 14 q9 3 9 16 q-4 -2 -7 -7 q-4 -5 -2 -9 z"/><path d="M68 14 q-9 3 -9 16 q4 -2 7 -7 q4 -5 2 -9 z"/><path d="M68 14 q9 3 9 16 q-4 -2 -7 -7 q-4 -5 -2 -9 z"/></g><g fill="#f5e8b8" opacity="0.6"><ellipse cx="18" cy="14" rx="3" ry="8"/><ellipse cx="50" cy="12" rx="4" ry="10"/><ellipse cx="82" cy="14" rx="3" ry="8"/></g></svg>`,

  // Cherry blossom: branching trunk with clusters of pink flowers reaching corners
  "cherry-blossom": `<svg viewBox="0 0 100 100" aria-hidden="true"><g stroke="#5a3a20" stroke-width="2.4" fill="none" stroke-linecap="round"><path d="M50 96 Q50 70 50 50"/><path d="M50 50 Q40 38 26 24 Q18 18 10 12"/><path d="M50 50 Q60 38 74 24 Q82 18 90 12"/><path d="M50 50 Q48 30 46 14 Q44 8 42 2"/><path d="M50 50 Q52 30 54 14 Q56 8 58 2"/><path d="M50 70 Q40 60 28 56"/><path d="M50 70 Q60 60 72 56"/></g><g fill="#f5b6cc" stroke="#d088a0" stroke-width="0.6"><circle cx="10" cy="12" r="6"/><circle cx="20" cy="20" r="5"/><circle cx="90" cy="12" r="6"/><circle cx="80" cy="20" r="5"/><circle cx="42" cy="2" r="5"/><circle cx="58" cy="2" r="5"/><circle cx="50" cy="8" r="5.5"/><circle cx="28" cy="56" r="6"/><circle cx="72" cy="56" r="6"/><circle cx="36" cy="38" r="5"/><circle cx="64" cy="38" r="5"/><circle cx="46" cy="30" r="4"/><circle cx="54" cy="30" r="4"/></g><g fill="#fce8ee"><circle cx="10" cy="12" r="2"/><circle cx="90" cy="12" r="2"/><circle cx="50" cy="8" r="2"/><circle cx="28" cy="56" r="2"/><circle cx="72" cy="56" r="2"/><circle cx="36" cy="38" r="1.5"/><circle cx="64" cy="38" r="1.5"/></g><g fill="#f0d860"><circle cx="10" cy="12" r="0.8"/><circle cx="90" cy="12" r="0.8"/><circle cx="50" cy="8" r="0.8"/><circle cx="28" cy="56" r="0.8"/><circle cx="72" cy="56" r="0.8"/></g></svg>`,

  // Pine tree: triangular conifer shape filling the whole square
  pine: `<svg viewBox="0 0 100 100" aria-hidden="true"><rect x="46" y="84" width="8" height="14" fill="#5a3a20"/><g fill="#2d6e35" stroke="#1a4a22" stroke-width="1" stroke-linejoin="round"><path d="M50 2 L24 32 L36 30 L14 56 L28 54 L6 84 L94 84 L72 54 L86 56 L64 30 L76 32 Z"/></g><g fill="#3d8e45" opacity="0.5"><path d="M50 2 L30 28 L38 26 L22 48 L32 46 L18 72 L82 72 L68 46 L78 48 L62 26 L70 28 Z"/></g><g fill="#a8946a" stroke="#6a4a28" stroke-width="0.6"><ellipse cx="32" cy="60" rx="3" ry="5"/><ellipse cx="68" cy="60" rx="3" ry="5"/><ellipse cx="50" cy="44" rx="2.5" ry="4"/><ellipse cx="42" cy="74" rx="2.8" ry="4.5"/><ellipse cx="58" cy="74" rx="2.8" ry="4.5"/></g><g fill="#c8e8d0" opacity="0.5"><circle cx="38" cy="40" r="1"/><circle cx="62" cy="40" r="1"/><circle cx="50" cy="22" r="1"/><circle cx="28" cy="68" r="1"/><circle cx="72" cy="68" r="1"/></g></svg>`,

  // Eucalyptus: arching long stems with rounded paired leaves filling the square
  eucalyptus: `<svg viewBox="0 0 100 100" aria-hidden="true"><g stroke="#5a7060" stroke-width="1.2" fill="none" stroke-linecap="round"><path d="M50 96 Q44 70 30 46 Q20 30 12 14"/><path d="M50 96 Q56 70 70 46 Q80 30 88 14"/><path d="M50 96 Q48 72 46 50 Q44 30 42 8"/><path d="M50 96 Q52 72 54 50 Q56 30 58 8"/></g><g fill="#9bbaa0" stroke="#6a8a70" stroke-width="0.7"><ellipse cx="14" cy="16" rx="6" ry="4" transform="rotate(60 14 16)"/><ellipse cx="22" cy="26" rx="6" ry="4" transform="rotate(50 22 26)"/><ellipse cx="30" cy="38" rx="6" ry="4" transform="rotate(40 30 38)"/><ellipse cx="38" cy="52" rx="6" ry="4" transform="rotate(30 38 52)"/><ellipse cx="86" cy="16" rx="6" ry="4" transform="rotate(-60 86 16)"/><ellipse cx="78" cy="26" rx="6" ry="4" transform="rotate(-50 78 26)"/><ellipse cx="70" cy="38" rx="6" ry="4" transform="rotate(-40 70 38)"/><ellipse cx="62" cy="52" rx="6" ry="4" transform="rotate(-30 62 52)"/><ellipse cx="42" cy="10" rx="5" ry="3.5"/><ellipse cx="44" cy="24" rx="5" ry="3.5"/><ellipse cx="44" cy="38" rx="5" ry="3.5"/><ellipse cx="46" cy="52" rx="5" ry="3.5"/><ellipse cx="58" cy="10" rx="5" ry="3.5"/><ellipse cx="56" cy="24" rx="5" ry="3.5"/><ellipse cx="56" cy="38" rx="5" ry="3.5"/><ellipse cx="54" cy="52" rx="5" ry="3.5"/></g><g fill="#bcd8c2" opacity="0.5"><ellipse cx="44" cy="24" rx="2" ry="1.5"/><ellipse cx="56" cy="24" rx="2" ry="1.5"/><ellipse cx="22" cy="26" rx="2" ry="1.5"/><ellipse cx="78" cy="26" rx="2" ry="1.5"/></g></svg>`,

  // Tulips: cluster of colorful tulips with arching leaves
  tulips: `<svg viewBox="0 0 100 100" aria-hidden="true"><g stroke="#3a8038" stroke-width="2" fill="none" stroke-linecap="round"><path d="M20 96 Q18 60 16 26 Q15 14 14 6"/><path d="M40 96 Q38 60 36 26 Q35 14 34 4"/><path d="M60 96 Q62 60 64 26 Q65 14 66 4"/><path d="M80 96 Q82 60 84 26 Q85 14 86 6"/><path d="M50 96 Q50 70 50 40 Q50 24 50 12"/></g><g stroke="#2a5e28" stroke-width="0.9" fill="#5fa84e" stroke-linejoin="round"><path d="M16 60 Q4 50 0 30 Q8 38 18 50 Q20 56 16 60 Z"/><path d="M84 60 Q96 50 100 30 Q92 38 82 50 Q80 56 84 60 Z"/><path d="M36 70 Q24 60 18 40 Q28 50 38 62 Q40 68 36 70 Z"/><path d="M64 70 Q76 60 82 40 Q72 50 62 62 Q60 68 64 70 Z"/></g><g stroke="#a04060" stroke-width="0.8" stroke-linejoin="round"><path d="M14 6 Q8 4 6 12 Q8 18 14 18 Q20 18 22 12 Q20 4 14 6 Z" fill="#e84074"/><path d="M34 4 Q28 2 26 10 Q28 16 34 16 Q40 16 42 10 Q40 2 34 4 Z" fill="#f5d020"/><path d="M50 12 Q44 10 42 18 Q44 24 50 24 Q56 24 58 18 Q56 10 50 12 Z" fill="#e84074"/><path d="M66 4 Q60 2 58 10 Q60 16 66 16 Q72 16 74 10 Q72 2 66 4 Z" fill="#9c54e0"/><path d="M86 6 Q80 4 78 12 Q80 18 86 18 Q92 18 94 12 Q92 4 86 6 Z" fill="#f5d020"/></g><g stroke="#80304a" stroke-width="0.4" fill="none"><path d="M14 8 q0 6 0 8"/><path d="M34 6 q0 6 0 8"/><path d="M50 14 q0 6 0 8"/><path d="M66 6 q0 6 0 8"/><path d="M86 8 q0 6 0 8"/></g></svg>`,

  // Sunflower: large yellow flower head with petals filling the square
  sunflower: `<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M50 96 Q50 80 50 64" stroke="#3a7a3f" stroke-width="2.4" fill="none" stroke-linecap="round"/><g fill="#5fa84e" stroke="#3a7a3f" stroke-width="0.9" stroke-linejoin="round"><path d="M50 80 Q26 74 4 80 Q14 92 32 90 Q46 86 50 80 Z"/><path d="M50 86 Q72 80 96 86 Q86 96 68 94 Q54 92 50 86 Z"/></g><g fill="#f5b820" stroke="#c08010" stroke-width="0.8" stroke-linejoin="round"><ellipse cx="50" cy="8" rx="6" ry="14"/><ellipse cx="76" cy="16" rx="6" ry="14" transform="rotate(45 76 16)"/><ellipse cx="92" cy="36" rx="6" ry="14" transform="rotate(80 92 36)"/><ellipse cx="88" cy="56" rx="6" ry="14" transform="rotate(120 88 56)"/><ellipse cx="68" cy="68" rx="6" ry="14" transform="rotate(155 68 68)"/><ellipse cx="32" cy="68" rx="6" ry="14" transform="rotate(-155 32 68)"/><ellipse cx="12" cy="56" rx="6" ry="14" transform="rotate(-120 12 56)"/><ellipse cx="8" cy="36" rx="6" ry="14" transform="rotate(-80 8 36)"/><ellipse cx="24" cy="16" rx="6" ry="14" transform="rotate(-45 24 16)"/></g><circle cx="50" cy="40" r="14" fill="#6b3a1a" stroke="#3a1a08" stroke-width="1"/><g fill="#a86838"><circle cx="46" cy="36" r="1.5"/><circle cx="54" cy="36" r="1.5"/><circle cx="50" cy="42" r="1.5"/><circle cx="44" cy="44" r="1.2"/><circle cx="56" cy="44" r="1.2"/><circle cx="50" cy="32" r="1.2"/></g></svg>`,

  // Topiary: trimmed sphere shrub filling the square
  topiary: `<svg viewBox="0 0 100 100" aria-hidden="true"><rect x="46" y="80" width="8" height="18" fill="#6b4c28"/><circle cx="50" cy="46" r="44" fill="#3a8e40" stroke="#1e5e28" stroke-width="1.4"/><g fill="#5db867" stroke="#3a7a3f" stroke-width="0.6"><circle cx="28" cy="28" r="7"/><circle cx="50" cy="14" r="7"/><circle cx="72" cy="28" r="7"/><circle cx="86" cy="48" r="6"/><circle cx="74" cy="68" r="7"/><circle cx="50" cy="78" r="7"/><circle cx="26" cy="68" r="7"/><circle cx="14" cy="48" r="6"/><circle cx="40" cy="40" r="5.5"/><circle cx="60" cy="40" r="5.5"/><circle cx="40" cy="56" r="5.5"/><circle cx="60" cy="56" r="5.5"/><circle cx="50" cy="46" r="5.5"/></g><g fill="#7dca5a" opacity="0.5"><circle cx="32" cy="26" r="2"/><circle cx="52" cy="16" r="2"/><circle cx="68" cy="32" r="2"/><circle cx="44" cy="46" r="2"/><circle cx="56" cy="50" r="2"/></g></svg>`,

  // String of pearls: cascading vines covered in green beads, fills the whole square
  "string-of-pearls": `<svg viewBox="0 0 100 100" aria-hidden="true"><g stroke="#4a8060" stroke-width="0.9" fill="none" stroke-linecap="round"><path d="M40 14 Q30 30 22 50 Q14 72 8 92"/><path d="M50 12 Q46 32 44 56 Q42 78 42 96"/><path d="M60 14 Q70 30 78 50 Q86 72 92 92"/><path d="M44 14 Q40 36 38 60 Q36 82 30 96"/><path d="M56 14 Q60 36 62 60 Q64 82 70 96"/></g><g fill="#9ad08a" stroke="#5a8a55" stroke-width="0.6"><circle cx="36" cy="22" r="3"/><circle cx="30" cy="32" r="3"/><circle cx="26" cy="44" r="3"/><circle cx="22" cy="56" r="3"/><circle cx="18" cy="68" r="3"/><circle cx="14" cy="80" r="3"/><circle cx="10" cy="92" r="3"/><circle cx="64" cy="22" r="3"/><circle cx="70" cy="32" r="3"/><circle cx="74" cy="44" r="3"/><circle cx="78" cy="56" r="3"/><circle cx="82" cy="68" r="3"/><circle cx="86" cy="80" r="3"/><circle cx="90" cy="92" r="3"/><circle cx="46" cy="24" r="3"/><circle cx="44" cy="40" r="3"/><circle cx="42" cy="56" r="3"/><circle cx="42" cy="72" r="3"/><circle cx="42" cy="88" r="3"/><circle cx="54" cy="24" r="3"/><circle cx="56" cy="40" r="3"/><circle cx="58" cy="56" r="3"/><circle cx="58" cy="72" r="3"/><circle cx="58" cy="88" r="3"/><circle cx="40" cy="32" r="3"/><circle cx="60" cy="32" r="3"/><circle cx="38" cy="48" r="3"/><circle cx="62" cy="48" r="3"/><circle cx="36" cy="64" r="3"/><circle cx="64" cy="64" r="3"/><circle cx="32" cy="80" r="3"/><circle cx="68" cy="80" r="3"/></g><g fill="#bce8ad" opacity="0.7"><circle cx="35" cy="21" r="0.9"/><circle cx="29" cy="31" r="0.9"/><circle cx="63" cy="21" r="0.9"/><circle cx="69" cy="31" r="0.9"/><circle cx="45" cy="23" r="0.9"/><circle cx="55" cy="23" r="0.9"/><circle cx="43" cy="39" r="0.9"/><circle cx="57" cy="39" r="0.9"/></g></svg>`,

  // Air plant (tillandsia): spiky tendrils radiating in every direction to the corners
  "air-plant": `<svg viewBox="0 0 100 100" aria-hidden="true"><g fill="#8eb088" stroke="#4a7048" stroke-width="0.9" stroke-linejoin="round"><path d="M50 50 L4 24 Q12 26 22 32 Q40 42 50 50 Z"/><path d="M50 50 L96 24 Q88 26 78 32 Q60 42 50 50 Z"/><path d="M50 50 L4 76 Q12 74 22 68 Q40 58 50 50 Z"/><path d="M50 50 L96 76 Q88 74 78 68 Q60 58 50 50 Z"/><path d="M50 50 L20 4 Q26 14 32 22 Q42 38 50 50 Z"/><path d="M50 50 L80 4 Q74 14 68 22 Q58 38 50 50 Z"/><path d="M50 50 L20 96 Q26 86 32 78 Q42 62 50 50 Z"/><path d="M50 50 L80 96 Q74 86 68 78 Q58 62 50 50 Z"/><path d="M50 50 L4 50 Q14 48 26 49 Q40 50 50 50 Z"/><path d="M50 50 L96 50 Q86 48 74 49 Q60 50 50 50 Z"/><path d="M50 50 L50 4 Q48 14 49 26 Q50 40 50 50 Z"/><path d="M50 50 L50 96 Q48 86 49 74 Q50 60 50 50 Z"/></g><g fill="#a8c8a0" stroke="#5a8060" stroke-width="0.5"><path d="M50 50 L36 18 Q40 28 44 36 Q48 46 50 50 Z"/><path d="M50 50 L64 18 Q60 28 56 36 Q52 46 50 50 Z"/><path d="M50 50 L36 82 Q40 72 44 64 Q48 54 50 50 Z"/><path d="M50 50 L64 82 Q60 72 56 64 Q52 54 50 50 Z"/></g><circle cx="50" cy="50" r="6" fill="#7090c0" stroke="#506890" stroke-width="0.6"/><circle cx="50" cy="50" r="3" fill="#a8c0e0"/></svg>`,

  // ── Batch 4: 6 more (potted plants) ───────────────────────────────────────

  // Rose bush: thorny stems with deep red roses
  "rose-bush": `<svg viewBox="0 0 100 100" aria-hidden="true"><g stroke="#3a6028" stroke-width="2" fill="none" stroke-linecap="round"><path d="M50 96 Q48 70 40 50 Q30 30 20 14"/><path d="M50 96 Q52 70 60 50 Q70 30 80 14"/><path d="M50 96 Q50 70 50 48 Q50 24 50 8"/><path d="M50 96 Q44 80 32 70"/><path d="M50 96 Q56 80 68 70"/></g><g fill="#4a8038" stroke="#2a5e20" stroke-width="0.8" stroke-linejoin="round"><path d="M40 50 Q30 48 24 54 Q32 60 42 52 Z"/><path d="M60 50 Q70 48 76 54 Q68 60 58 52 Z"/><path d="M50 48 Q40 42 34 46 Q42 54 50 52 Z"/><path d="M50 24 Q40 20 36 24 Q44 30 50 28 Z"/><path d="M50 24 Q60 20 64 24 Q56 30 50 28 Z"/></g><g fill="#c43840" stroke="#7a1a20" stroke-width="0.8"><circle cx="20" cy="14" r="9"/><circle cx="80" cy="14" r="9"/><circle cx="50" cy="8" r="10"/><circle cx="32" cy="70" r="7"/><circle cx="68" cy="70" r="7"/></g><g fill="#e85060"><circle cx="20" cy="14" r="5"/><circle cx="80" cy="14" r="5"/><circle cx="50" cy="8" r="5.5"/><circle cx="32" cy="70" r="3.5"/><circle cx="68" cy="70" r="3.5"/></g><g fill="#a02030"><circle cx="20" cy="14" r="1.5"/><circle cx="80" cy="14" r="1.5"/><circle cx="50" cy="8" r="1.8"/></g><g fill="#7a1a20"><circle cx="44" cy="60" r="1.2"/><circle cx="56" cy="60" r="1.2"/><circle cx="48" cy="36" r="1.2"/><circle cx="52" cy="36" r="1.2"/><circle cx="34" cy="82" r="1.1"/><circle cx="66" cy="82" r="1.1"/></g></svg>`,

  // Hydrangea: large fluffy pastel flower clusters with broad leaves
  hydrangea: `<svg viewBox="0 0 100 100" aria-hidden="true"><g stroke="#3a6028" stroke-width="1.6" fill="none" stroke-linecap="round"><path d="M50 96 Q50 80 50 60"/><path d="M50 78 Q40 70 28 64"/><path d="M50 78 Q60 70 72 64"/></g><g fill="#3a7a40" stroke="#1e4a20" stroke-width="0.8" stroke-linejoin="round"><path d="M28 64 Q12 62 4 74 Q14 84 28 78 Q34 70 28 64 Z"/><path d="M72 64 Q88 62 96 74 Q86 84 72 78 Q66 70 72 64 Z"/></g><g fill="#a890e8" stroke="#7060a8" stroke-width="0.6"><circle cx="22" cy="28" r="6"/><circle cx="32" cy="22" r="6"/><circle cx="42" cy="28" r="6"/><circle cx="28" cy="38" r="6"/><circle cx="38" cy="36" r="6"/><circle cx="32" cy="14" r="6"/><circle cx="22" cy="16" r="5"/></g><g fill="#c8a8e8" stroke="#9080b8" stroke-width="0.6"><circle cx="78" cy="28" r="6"/><circle cx="68" cy="22" r="6"/><circle cx="58" cy="28" r="6"/><circle cx="72" cy="38" r="6"/><circle cx="62" cy="36" r="6"/><circle cx="68" cy="14" r="6"/><circle cx="78" cy="16" r="5"/></g><g fill="#90b8e8" stroke="#6080b8" stroke-width="0.6"><circle cx="50" cy="36" r="6.5"/><circle cx="44" cy="48" r="6"/><circle cx="56" cy="48" r="6"/><circle cx="50" cy="56" r="5.5"/><circle cx="50" cy="46" r="5.5"/><circle cx="50" cy="22" r="6"/></g><g fill="#f5edff" opacity="0.7"><circle cx="32" cy="22" r="1.6"/><circle cx="68" cy="22" r="1.6"/><circle cx="50" cy="36" r="1.6"/><circle cx="22" cy="28" r="1.2"/><circle cx="78" cy="28" r="1.2"/><circle cx="38" cy="36" r="1.2"/><circle cx="62" cy="36" r="1.2"/></g></svg>`,

  // Bonsai: twisted trunk with wide canopy
  bonsai: `<svg viewBox="0 0 100 100" aria-hidden="true"><g stroke="#5a3a20" stroke-width="6" fill="none" stroke-linecap="round"><path d="M50 96 Q44 80 50 64 Q58 50 50 38"/></g><g stroke="#5a3a20" stroke-width="3" fill="none" stroke-linecap="round"><path d="M50 56 Q34 50 20 44"/><path d="M50 50 Q66 46 82 40"/><path d="M50 38 Q56 30 60 22"/><path d="M50 38 Q44 30 40 22"/></g><g fill="#3a8e40" stroke="#1e5e28" stroke-width="1.2" stroke-linejoin="round"><ellipse cx="18" cy="38" rx="18" ry="10"/><ellipse cx="82" cy="34" rx="18" ry="10"/><ellipse cx="40" cy="18" rx="14" ry="8"/><ellipse cx="62" cy="14" rx="14" ry="8"/><ellipse cx="50" cy="28" rx="14" ry="7"/></g><g fill="#5ab067" opacity="0.55"><ellipse cx="18" cy="36" rx="10" ry="4"/><ellipse cx="82" cy="32" rx="10" ry="4"/><ellipse cx="50" cy="26" rx="8" ry="3"/><ellipse cx="40" cy="16" rx="6" ry="3"/><ellipse cx="62" cy="12" rx="6" ry="3"/></g><g fill="#1e5e28"><circle cx="12" cy="42" r="1.5"/><circle cx="88" cy="38" r="1.5"/><circle cx="46" cy="20" r="1.2"/><circle cx="56" cy="16" r="1.2"/></g><g fill="#f0d860" opacity="0.7"><circle cx="22" cy="34" r="1"/><circle cx="78" cy="32" r="1"/><circle cx="50" cy="24" r="1"/></g></svg>`,

  // Daisies: bunch of white daisies on thin stems, yellow centers
  daisies: `<svg viewBox="0 0 100 100" aria-hidden="true"><g stroke="#3a8038" stroke-width="1.6" fill="none" stroke-linecap="round"><path d="M22 96 Q20 70 18 40 Q17 22 16 10"/><path d="M42 96 Q40 70 38 40 Q37 22 36 6"/><path d="M62 96 Q64 70 66 40 Q67 22 68 14"/><path d="M82 96 Q84 70 86 40 Q87 22 88 18"/><path d="M50 96 Q50 70 50 40 Q50 22 50 6"/></g><g fill="#5fa84e" stroke="#3a6e28" stroke-width="0.8" stroke-linejoin="round"><path d="M18 52 Q8 48 4 38 Q14 40 22 48 Z"/><path d="M86 52 Q96 48 96 38 Q86 40 82 48 Z"/><path d="M50 64 Q40 60 36 50 Q46 54 50 60 Z"/><path d="M38 60 Q28 58 24 50 Q34 50 40 56 Z"/><path d="M62 60 Q72 58 76 50 Q66 50 60 56 Z"/></g><g fill="#fafaf0" stroke="#c8c2b3" stroke-width="0.5"><ellipse cx="16" cy="4" rx="2.5" ry="5"/><ellipse cx="20" cy="9" rx="2.5" ry="5" transform="rotate(60 20 9)"/><ellipse cx="12" cy="9" rx="2.5" ry="5" transform="rotate(-60 12 9)"/><ellipse cx="20" cy="16" rx="2.5" ry="5" transform="rotate(120 20 16)"/><ellipse cx="12" cy="16" rx="2.5" ry="5" transform="rotate(-120 12 16)"/><ellipse cx="36" cy="0" rx="2.5" ry="5"/><ellipse cx="40" cy="5" rx="2.5" ry="5" transform="rotate(60 40 5)"/><ellipse cx="32" cy="5" rx="2.5" ry="5" transform="rotate(-60 32 5)"/><ellipse cx="40" cy="12" rx="2.5" ry="5" transform="rotate(120 40 12)"/><ellipse cx="32" cy="12" rx="2.5" ry="5" transform="rotate(-120 32 12)"/><ellipse cx="50" cy="0" rx="3" ry="6"/><ellipse cx="55" cy="6" rx="3" ry="6" transform="rotate(60 55 6)"/><ellipse cx="45" cy="6" rx="3" ry="6" transform="rotate(-60 45 6)"/><ellipse cx="55" cy="14" rx="3" ry="6" transform="rotate(120 55 14)"/><ellipse cx="45" cy="14" rx="3" ry="6" transform="rotate(-120 45 14)"/><ellipse cx="68" cy="8" rx="2.5" ry="5"/><ellipse cx="72" cy="13" rx="2.5" ry="5" transform="rotate(60 72 13)"/><ellipse cx="64" cy="13" rx="2.5" ry="5" transform="rotate(-60 64 13)"/><ellipse cx="72" cy="20" rx="2.5" ry="5" transform="rotate(120 72 20)"/><ellipse cx="64" cy="20" rx="2.5" ry="5" transform="rotate(-120 64 20)"/><ellipse cx="88" cy="12" rx="2.5" ry="5"/><ellipse cx="92" cy="17" rx="2.5" ry="5" transform="rotate(60 92 17)"/><ellipse cx="84" cy="17" rx="2.5" ry="5" transform="rotate(-60 84 17)"/></g><g fill="#f5c020" stroke="#c8a010" stroke-width="0.5"><circle cx="16" cy="10" r="2.4"/><circle cx="36" cy="6" r="2.4"/><circle cx="50" cy="7" r="3"/><circle cx="68" cy="14" r="2.4"/><circle cx="88" cy="18" r="2.4"/></g></svg>`,

  // Pilea (Chinese money plant): round coin-shaped leaves on thin stems
  pilea: `<svg viewBox="0 0 100 100" aria-hidden="true"><g stroke="#5a8a3e" stroke-width="1.6" fill="none" stroke-linecap="round"><path d="M50 96 Q50 80 50 64"/><path d="M50 64 Q40 50 20 36"/><path d="M50 64 Q60 50 80 36"/><path d="M50 64 Q42 50 30 16"/><path d="M50 64 Q58 50 70 16"/><path d="M50 64 Q50 44 50 8"/><path d="M50 64 Q36 60 16 64"/><path d="M50 64 Q64 60 84 64"/><path d="M50 64 Q44 56 36 48"/><path d="M50 64 Q56 56 64 48"/></g><g fill="#5fb84a" stroke="#2e6b28" stroke-width="0.9"><circle cx="20" cy="36" r="10"/><circle cx="80" cy="36" r="10"/><circle cx="30" cy="16" r="9"/><circle cx="70" cy="16" r="9"/><circle cx="50" cy="8" r="10"/><circle cx="16" cy="64" r="8"/><circle cx="84" cy="64" r="8"/><circle cx="36" cy="48" r="7"/><circle cx="64" cy="48" r="7"/><circle cx="50" cy="34" r="7"/></g><g fill="#3a7a28"><circle cx="20" cy="36" r="1.6"/><circle cx="80" cy="36" r="1.6"/><circle cx="30" cy="16" r="1.5"/><circle cx="70" cy="16" r="1.5"/><circle cx="50" cy="8" r="1.6"/><circle cx="16" cy="64" r="1.4"/><circle cx="84" cy="64" r="1.4"/><circle cx="36" cy="48" r="1.2"/><circle cx="64" cy="48" r="1.2"/><circle cx="50" cy="34" r="1.2"/></g><g fill="#a0e090" opacity="0.55"><circle cx="16" cy="32" r="2.5"/><circle cx="76" cy="32" r="2.5"/><circle cx="26" cy="12" r="2"/><circle cx="66" cy="12" r="2"/><circle cx="46" cy="4" r="2"/><circle cx="32" cy="44" r="1.5"/><circle cx="68" cy="44" r="1.5"/></g></svg>`,

  // Maple sapling: red/orange star-shaped leaves on branching limbs
  maple: `<svg viewBox="0 0 100 100" aria-hidden="true"><g stroke="#5a3a20" stroke-width="3" fill="none" stroke-linecap="round"><path d="M50 96 Q50 74 50 54"/></g><g stroke="#5a3a20" stroke-width="2" fill="none" stroke-linecap="round"><path d="M50 60 Q36 48 22 36"/><path d="M50 60 Q64 48 78 36"/><path d="M50 54 Q44 38 38 22"/><path d="M50 54 Q56 38 62 22"/><path d="M50 54 Q50 30 50 10"/><path d="M50 70 Q40 64 28 60"/><path d="M50 70 Q60 64 72 60"/></g><g fill="#e85a28" stroke="#a03818" stroke-width="0.7" stroke-linejoin="round"><path d="M22 36 l-4 -6 l5 1 l-3 -7 l5 3 l-1 -7 l5 5 l3 -5 l1 7 l5 -3 l-2 7 l5 -1 l-4 6 l5 4 l-7 1 l3 6 l-7 -3 l-1 7 l-4 -6 l-4 6 l-1 -7 l-7 3 l3 -6 l-7 -1 z"/><path d="M78 36 l4 -6 l-5 1 l3 -7 l-5 3 l1 -7 l-5 5 l-3 -5 l-1 7 l-5 -3 l2 7 l-5 -1 l4 6 l-5 4 l7 1 l-3 6 l7 -3 l1 7 l4 -6 l4 6 l1 -7 l7 3 l-3 -6 l7 -1 z"/></g><g fill="#f0a040" stroke="#c06820" stroke-width="0.6" stroke-linejoin="round"><path d="M38 22 l-3 -5 l4 1 l-2 -5 l4 2 l-1 -5 l4 4 l2 -4 l1 5 l4 -2 l-2 5 l4 -1 l-3 5 l4 3 l-6 1 l3 4 l-6 -2 l-1 5 l-3 -4 l-3 4 l-1 -5 l-6 2 l3 -4 l-6 -1 z"/><path d="M62 22 l3 -5 l-4 1 l2 -5 l-4 2 l1 -5 l-4 4 l-2 -4 l-1 5 l-4 -2 l2 5 l-4 -1 l3 5 l-4 3 l6 1 l-3 4 l6 -2 l1 5 l3 -4 l3 4 l1 -5 l6 2 l-3 -4 l6 -1 z"/></g><g fill="#f5c020" stroke="#c08000" stroke-width="0.6" stroke-linejoin="round"><path d="M50 10 l-3 -4 l4 1 l-2 -4 l4 2 l4 -2 l-2 4 l4 -1 l-3 4 l4 3 l-6 1 l3 4 l-6 -1 l-1 4 l-1 -4 l-6 1 l3 -4 l-6 -1 z"/></g><g fill="#e85a28" stroke="#a03818" stroke-width="0.6"><path d="M28 60 l-3 -4 l4 1 l4 4 l4 -2 l-3 5 l-6 1 l3 4 l-6 -2 z"/><path d="M72 60 l3 -4 l-4 1 l-4 4 l-4 -2 l3 5 l6 1 l-3 4 l6 -2 z"/></g></svg>`
};

const PLANT_NAMES = {
  pothos: "Pothos",
  "bird-of-paradise": "Bird of paradise",
  "snake-plant": "Snake plant",
  monstera: "Monstera",
  fern: "Fern",
  succulent: "Succulent",
  cactus: "Cactus",
  bamboo: "Bamboo",
  palm: "Palm",
  aloe: "Aloe vera",
  orchid: "Orchid",
  "peace-lily": "Peace lily",
  "fiddle-leaf": "Fiddle leaf fig",
  calathea: "Calathea",
  "zz-plant": "ZZ plant",
  lavender: "Lavender",
  "spider-plant": "Spider plant",
  pampas: "Pampas grass",
  "cherry-blossom": "Cherry blossom",
  pine: "Pine",
  eucalyptus: "Eucalyptus",
  tulips: "Tulips",
  sunflower: "Sunflower",
  topiary: "Topiary",
  "string-of-pearls": "String of pearls",
  "air-plant": "Air plant",
  "rose-bush": "Rose bush",
  hydrangea: "Hydrangea",
  bonsai: "Bonsai",
  daisies: "Daisies",
  pilea: "Pilea",
  maple: "Maple sapling"
};

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

// ── Plant drag-and-drop ──────────────────────────────────────────────────────
// In plant mode the user can drag a planted plant onto any empty slot to move
// it there. Implementation notes:
//   • Pointer Events drive the gesture so mouse + touch work uniformly.
//   • A small movement threshold prevents stealing the existing click→water.
//   • A cloned plant element acts as the drag ghost (fixed-position, follows
//     the cursor). The source slot stays in place but is dimmed so its
//     emptied location is still visible while the user decides.
//   • `document.elementFromPoint` finds candidate `.broom-empty-slot`s; the
//     ghost has `pointer-events: none` so it never blocks hit-testing.
//   • On drop, the decorate rule is rewritten to point at the new hide slot
//     (selector + sourceRuleId + originalBox), then re-applied so the plant
//     refits to the destination's box. Source slot reappears as empty via
//     the standard `renderEmptySlotAffordances()` reconciliation.

const PLANT_DRAG_THRESHOLD_PX = 5;
let activePlantDrag = null;

function attachPlantDragHandlers(slot, plantEl, rule) {
  slot.addEventListener("pointerdown", (e) => {
    if (activeMode !== "plant") return;
    if (broomSuspended) return;
    if (e.button !== undefined && e.button !== 0) return;
    if (plantEl.classList.contains("broom-plant-enter")) return;
    if (activePlantDrag) return;

    const state = {
      rule,
      slotEl: slot,
      plantEl,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      dragging: false,
      currentTarget: null,
      ghost: null,
      offsetX: 0,
      offsetY: 0
    };

    const onMove = (mv) => {
      if (mv.pointerId !== state.pointerId) return;
      if (!state.dragging) {
        const dx = mv.clientX - state.startX;
        const dy = mv.clientY - state.startY;
        if (dx * dx + dy * dy < PLANT_DRAG_THRESHOLD_PX * PLANT_DRAG_THRESHOLD_PX) return;
        beginPlantDrag(state, mv);
      } else {
        updatePlantDragPosition(state, mv);
        updatePlantDragTarget(state, mv);
      }
    };

    const onUp = (up) => {
      if (up.pointerId !== state.pointerId) return;
      cleanupListeners();
      if (state.dragging) {
        up.preventDefault?.();
        up.stopPropagation?.();
        completePlantDrop(state);
      }
    };

    const onCancel = (cn) => {
      if (cn.pointerId !== state.pointerId) return;
      cleanupListeners();
      if (state.dragging) abortPlantDrag(state);
    };

    const onEsc = (ke) => {
      if (ke.key === "Escape" && state.dragging) {
        ke.preventDefault();
        ke.stopPropagation();
        cleanupListeners();
        abortPlantDrag(state);
      }
    };

    const cleanupListeners = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
      window.removeEventListener("keydown", onEsc, true);
    };

    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
    window.addEventListener("keydown", onEsc, true);
  });
}

function beginPlantDrag(state, mv) {
  state.dragging = true;
  activePlantDrag = state;
  try { state.slotEl.setPointerCapture(state.pointerId); } catch { /* */ }

  state.slotEl.classList.add("broom-dragging");
  state.plantEl.classList.remove("broom-plant-hovering");
  document.documentElement.classList.add("broom-plant-dragging");

  // Belt-and-suspenders against text/page selection during the drag:
  //   • Clear any selection that may have begun during the 5px threshold.
  //   • Block selectstart and the legacy HTML5 dragstart for the rest of
  //     the gesture so even sites that force user-select: text can't paint
  //     highlights as the cursor crosses paragraphs.
  try { window.getSelection?.()?.removeAllRanges?.(); } catch { /* */ }
  const swallow = (ev) => { ev.preventDefault(); };
  state._suppressSelect = swallow;
  document.addEventListener("selectstart", swallow, true);
  document.addEventListener("dragstart", swallow, true);

  const rect = state.plantEl.getBoundingClientRect();
  const ghost = state.plantEl.cloneNode(true);
  // Strip transient/animation classes so the ghost reads as a stable preview.
  ghost.classList.remove(
    "broom-plant-hovering",
    "broom-plant-enter",
    "broom-plant-watered",
    "broom-plant-anim-gentle-sway"
  );
  // Remove any leftover particle/raindrop nodes that may have been cloned.
  ghost.querySelectorAll(".broom-plant-particle, .broom-raindrop").forEach((n) => n.remove());
  ghost.classList.add("broom-drag-ghost");
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;

  state.ghost = ghost;
  state.offsetX = state.startX - rect.left;
  state.offsetY = state.startY - rect.top;
  document.documentElement.appendChild(ghost);
  positionPlantGhost(ghost, mv.clientX - state.offsetX, mv.clientY - state.offsetY);
}

function positionPlantGhost(ghost, left, top) {
  ghost.style.left = `${left}px`;
  ghost.style.top = `${top}px`;
}

function releasePlantDragSelectionGuards(state) {
  if (state && state._suppressSelect) {
    document.removeEventListener("selectstart", state._suppressSelect, true);
    document.removeEventListener("dragstart", state._suppressSelect, true);
    state._suppressSelect = null;
  }
  // Clear any selection that crept in despite the guards (e.g., from a focus
  // change in the middle of the drag).
  try { window.getSelection?.()?.removeAllRanges?.(); } catch { /* */ }
}

function updatePlantDragPosition(state, mv) {
  if (!state.ghost) return;
  positionPlantGhost(state.ghost, mv.clientX - state.offsetX, mv.clientY - state.offsetY);
}

function updatePlantDragTarget(state, mv) {
  if (!state.ghost) return;
  // Hide ghost while hit-testing so elementFromPoint sees the slot below.
  const prevVisibility = state.ghost.style.visibility;
  state.ghost.style.visibility = "hidden";
  const el = document.elementFromPoint(mv.clientX, mv.clientY);
  state.ghost.style.visibility = prevVisibility;

  let target = null;
  if (el) {
    const empty = el.closest && el.closest(".broom-empty-slot");
    if (empty) target = empty;
  }

  if (target !== state.currentTarget) {
    if (state.currentTarget) state.currentTarget.classList.remove("broom-drop-target");
    state.currentTarget = target;
    if (target) target.classList.add("broom-drop-target");
  }
}

function completePlantDrop(state) {
  const target = state.currentTarget;
  if (target) target.classList.remove("broom-drop-target");

  if (!target) { abortPlantDrag(state); return; }

  const destHideId = target.getAttribute(EMPTY_SLOT_ATTR);
  const destHide = appliedRules.find(
    (r) => r.id === destHideId && r.payload && r.payload.kind === "hide"
  );
  if (!destHide) { abortPlantDrag(state); return; }

  // Sanity: anchor still in DOM (mutations during drag).
  const destAnchor = resolveSelector(destHide.selector.primary, destHide.selector.fallbacks);
  if (!destAnchor) { abortPlantDrag(state); return; }

  // Dropping on the slot the plant already lives in is a no-op.
  const currentSourceId = state.rule.payload && state.rule.payload.sourceRuleId;
  if (currentSourceId && currentSourceId === destHide.id) { abortPlantDrag(state); return; }

  void performPlantMove(state, destHide);
}

async function performPlantMove(state, destHide) {
  const oldRule = state.rule;
  const newBox = (destHide.payload && destHide.payload.originalBox) || null;
  // Re-fit the plant to the destination's footprint by recomputing the size
  // class. The slot itself is already capped by `originalBox` in applyPlant;
  // updating `plant.size` rescales the SVG (.broom-plant-sm/md/lg widths) so
  // a small succulent grows when moved to a large slot and vice versa.
  const oldPlant = (oldRule.payload && oldRule.payload.plant) || {};
  const nextPlant = { ...oldPlant, size: plantSizeForBox(newBox) };
  const updated = {
    ...oldRule,
    selector: {
      primary: destHide.selector.primary,
      fallbacks: Array.isArray(destHide.selector.fallbacks) ? [...destHide.selector.fallbacks] : [],
      semantic: destHide.selector.semantic || ""
    },
    payload: {
      ...oldRule.payload,
      sourceRuleId: destHide.id,
      originalBox: newBox,
      plant: nextPlant
    }
  };

  // Tear down ghost + drag chrome before mutating the DOM.
  if (state.ghost) state.ghost.remove();
  state.ghost = null;
  state.slotEl.classList.remove("broom-dragging");
  state.slotEl._broomDragJustEnded = true;
  document.documentElement.classList.remove("broom-plant-dragging");
  releasePlantDragSelectionGuards(state);

  // Remove old plant slot DOM and replace it with one re-applied at the new anchor.
  removeRule(oldRule.id);
  const idx = appliedRules.findIndex((r) => r.id === oldRule.id);
  if (idx >= 0) appliedRules[idx] = updated;
  applyPlant(updated, { enterAnimation: false });

  // Play the drop sequence (settle + dust + delayed sound) on the destination.
  const newSlot = document.querySelector(
    `[${INJECTED_ATTR}="${updated.id.replace(/"/g, '\\"')}"]`
  );
  playPlantDropAnimation(newSlot);

  if (activeMode === "plant") renderEmptySlotAffordances();

  activePlantDrag = null;

  await upsertRuleLocal(updated);
  void trackEvent("plant_moved");
}

// Shared drop choreography: settle keyframe + dust poof from the pot base +
// delayed move-pot sound (so the "thunk" lands with the impact squash).
// Used both for cross-slot moves and for cancelled drags that land back on
// the original slot, so the audiovisual signature of "a pot landing" is
// consistent regardless of where it lands.
function playPlantDropAnimation(slot) {
  if (!slot || !slot.isConnected) return;
  // Restart cleanly if a previous settle is still in flight on this slot.
  slot.classList.remove("broom-plant-settle");
  void slot.offsetWidth;
  slot.classList.add("broom-plant-settle");

  [
    { px: -26, py: -6,  color: "#8a6a3a", dur: 380, delay: 190 },
    { px: -14, py: -12, color: "#a07a48", dur: 420, delay: 210 },
    { px:  14, py: -12, color: "#a07a48", dur: 420, delay: 210 },
    { px:  26, py: -6,  color: "#8a6a3a", dur: 380, delay: 190 },
    { px: -18, py:  4,  color: "#6b4423", dur: 320, delay: 230 },
    { px:  18, py:  4,  color: "#6b4423", dur: 320, delay: 230 }
  ].forEach(({ px, py, color, dur, delay }) => {
    const p = document.createElement("span");
    p.className = "broom-plant-particle broom-plant-dust";
    p.style.cssText = `--px:${px}px;--py:${py}px;background:${color};--dur:${dur}ms;--delay:${delay}ms`;
    slot.appendChild(p);
    p.addEventListener("animationend", () => p.remove(), { once: true });
  });

  setTimeout(playMovePotSound, 50);
  setTimeout(() => slot.classList.remove("broom-plant-settle"), 580);
}

function abortPlantDrag(state) {
  if (state.currentTarget) state.currentTarget.classList.remove("broom-drop-target");
  state.currentTarget = null;
  state.slotEl.classList.remove("broom-dragging");
  // Mark for click-suppression and self-clear in case the browser doesn't
  // dispatch a synthetic click after the drag (varies by platform).
  state.slotEl._broomDragJustEnded = true;
  setTimeout(() => { delete state.slotEl._broomDragJustEnded; }, 300);
  document.documentElement.classList.remove("broom-plant-dragging");
  releasePlantDragSelectionGuards(state);

  // Ghost fades out quickly wherever the user released — the drop animation
  // on the source slot is the primary "your pot landed back home" feedback,
  // so we don't need the long snap-back flight (which used to leave two
  // overlapping plants visible for ~220ms).
  if (state.ghost) {
    const ghost = state.ghost;
    ghost.style.transition = "opacity 140ms ease, transform 140ms ease";
    ghost.style.opacity = "0";
    ghost.style.transform = "scale(0.88) rotate(-1deg)";
    const removeGhost = () => ghost.remove();
    ghost.addEventListener("transitionend", removeGhost, { once: true });
    setTimeout(removeGhost, 200);
  }
  state.ghost = null;

  // Replay the same drop sequence on the source slot so a cancelled drag
  // feels consistent with a successful move: the pot always "lands".
  if (state.slotEl.isConnected) {
    playPlantDropAnimation(state.slotEl);
  }

  if (activePlantDrag === state) activePlantDrag = null;
}

function cancelActivePlantDrag() {
  if (!activePlantDrag) return;
  abortPlantDrag(activePlantDrag);
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
const TOUCH_HINT_ID = "broom-touch-hint";
const OUR_UI_SELECTOR = `#${PANEL_ID},#${HIGHLIGHT_ID},#${LAUNCHER_ID},#${LAUNCHER_WRAP_ID},#${UNDO_TOAST_ID},#${SETTINGS_ID},#${BROOM_CURSOR_ID},#${TOUCH_HINT_ID},[id^="${SWEEP_ID}"]`;

let undoToastTimer = null;
let broomSession = []; // rules swept in the current/most-recent broom session

let activeMode = null; // "broom" | "plant" | "restore" | null
let pickerTarget = null;
let broomSuspended = false; // true while the user holds the configured suspend key

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
    document.addEventListener("pointerdown", onPickerPointerDown, true);
    void maybeShowTouchHint();
  } else if (mode === "plant") {
    renderEmptySlotAffordances();
  } else if (mode === "restore") {
    enterRestoreMode();
  }
}

function stopMode() {
  if (!activeMode) return;
  cancelActivePlantDrag();
  cancelTouchAim();
  clearSuspended();
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
  // Cursor element is gone — drop any pending hide refs so the next broom
  // session starts with a clean, visible follower.
  cursorHideRefCount = 0;
  hideSelectorTag();
  document.removeEventListener("mouseover", onOver, true);
  document.removeEventListener("click", onClick, true);
  document.removeEventListener("mousemove", onCursorMove, true);
  document.removeEventListener("pointerdown", onPickerPointerDown, true);
  hideTouchHint();
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
      -webkit-touch-callout: none !important;
    }
    /* Touch aiming: freeze the page while the finger slides across targets.
       touch-action alone is unreliable once a gesture is already in flight on
       iOS, so beginTouchAim() also swallows touchmove non-passively. */
    html.broom-aiming, html.broom-aiming body {
      touch-action: none !important;
      overscroll-behavior: none !important;
    }
    /* Hold-to-suspend: hide our chrome and re-enable native cursor/selection
       so the user can open native menus, then resume brooming on key release. */
    html[data-broom-suspended] #${HIGHLIGHT_ID},
    html[data-broom-suspended] #${BROOM_CURSOR_ID},
    html[data-broom-suspended] #broom-tag,
    html[data-broom-suspended] .broom-empty-slot,
    html[data-broom-suspended] .broom-restore-overlay {
      display: none !important;
    }
    html[data-broom-suspended].broom-picking,
    html[data-broom-suspended].broom-picking * {
      cursor: auto !important;
      user-select: auto !important;
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
    #${LAUNCHER_WRAP_ID}[data-broom-hidden="true"] { display: none !important; }
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
    #${LAUNCHER_WRAP_ID}.broom-fan-open .broom-fan-chip[data-broom-off="true"] {
      opacity: 0.35 !important;
      cursor: not-allowed !important;
      pointer-events: auto !important;
      transform: none !important;
      box-shadow: none !important;
      filter: grayscale(0.6) !important;
    }
    #${LAUNCHER_WRAP_ID}.broom-fan-open .broom-fan-chip[data-broom-off="true"]:hover {
      background: rgba(255,255,255,0.99) !important;
      border-color: rgba(107,67,33,0.24) !important;
      color: #1f2937 !important;
      transform: none !important;
      box-shadow: none !important;
    }
    /* Fan reorientation: when the launcher is dragged to a non-default corner,
       flip the fan's horizontal/vertical anchor so chips never expand off-screen. */
    #${LAUNCHER_WRAP_ID}[data-broom-anchor-x="left"] .broom-fan {
      right: auto !important;
      left: 0 !important;
      align-items: flex-start !important;
    }
    #${LAUNCHER_WRAP_ID}[data-broom-anchor-y="top"] .broom-fan {
      bottom: auto !important;
      top: 60px !important;
      flex-direction: column-reverse !important;
    }
    #${LAUNCHER_WRAP_ID}[data-broom-anchor-y="top"].broom-fan-open .broom-fan-chip:nth-child(1) { transition-delay: 0ms; }
    #${LAUNCHER_WRAP_ID}[data-broom-anchor-y="top"].broom-fan-open .broom-fan-chip:nth-child(2) { transition-delay: 60ms; }
    #${LAUNCHER_WRAP_ID}[data-broom-anchor-y="top"].broom-fan-open .broom-fan-chip:nth-child(3) { transition-delay: 120ms; }
    #${LAUNCHER_WRAP_ID}[data-broom-anchor-y="top"].broom-fan-open .broom-fan-chip:nth-child(4) { transition-delay: 180ms; }
    #${LAUNCHER_WRAP_ID}.broom-dragging #${LAUNCHER_ID} {
      box-shadow:
        0 22px 50px rgba(15,23,42,0.38),
        0 8px 18px rgba(15,23,42,0.22),
        inset 0 0 0 1px rgba(255,255,255,0.7) !important;
      border-color: rgba(107, 67, 33, 0.55) !important;
      animation: none !important;
    }
    html.broom-launcher-dragging, html.broom-launcher-dragging * {
      cursor: grabbing !important;
      touch-action: none !important;
      -webkit-touch-callout: none !important;
    }
    #${LAUNCHER_ID} {
      touch-action: none !important;
      -webkit-touch-callout: none !important;
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
      overflow-y: auto !important;
      overscroll-behavior: contain !important;
      -webkit-overflow-scrolling: touch !important;
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
      display: flex !important;
      flex-direction: column !important;
      align-items: center !important;
      gap: 4px !important;
      font: 500 11px/1 -apple-system, system-ui, sans-serif !important;
      color: #94a3b8 !important;
      margin: 10px 0 2px !important;
      letter-spacing: 0.02em !important;
    }
    #${SETTINGS_ID} .bs-version-row {
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      gap: 6px !important;
    }
    #${SETTINGS_ID} .bs-version-text { line-height: 1 !important; }
    #${SETTINGS_ID} .bs-update-status {
      font: 500 10.5px/1.35 -apple-system, system-ui, sans-serif !important;
      color: #94a3b8 !important;
      text-align: center !important;
      letter-spacing: 0.01em !important;
      max-width: 100% !important;
      max-height: 0 !important;
      opacity: 0 !important;
      overflow: hidden !important;
      white-space: normal !important;
      overflow-wrap: anywhere !important;
      word-break: normal !important;
      transition: opacity 0.18s ease, max-height 0.22s ease, padding 0.22s ease !important;
    }
    #${SETTINGS_ID} .bs-update-status.is-visible {
      max-height: 120px !important;
      padding-top: 2px !important;
      opacity: 1 !important;
    }
    #${SETTINGS_ID} .bs-update-btn {
      all: unset !important;
      box-sizing: border-box !important;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      gap: 4px !important;
      width: 28px !important;
      height: 28px !important;
      padding: 0 !important;
      border-radius: 50% !important;
      cursor: pointer !important;
      color: #94a3b8 !important;
      background: transparent !important;
      transition: color 0.14s ease, transform 0.12s ease, background 0.18s ease, width 0.18s ease, padding 0.18s ease, border-radius 0.18s ease !important;
      flex: 0 0 auto !important;
    }
    #${SETTINGS_ID} .bs-update-btn:hover { color: #475569 !important; }
    #${SETTINGS_ID} .bs-update-btn:active { transform: scale(0.92) !important; }
    #${SETTINGS_ID} .bs-update-btn:disabled { cursor: progress !important; }
    #${SETTINGS_ID} .bs-update-btn svg { width: 16px !important; height: 16px !important; display: block !important; pointer-events: none !important; }
    #${SETTINGS_ID} .bs-update-btn.is-checking svg { animation: bsweep-update-spin 0.85s linear infinite !important; }
    #${SETTINGS_ID} .bs-update-btn.is-uptodate { color: #15803d !important; }
    #${SETTINGS_ID} .bs-update-btn.is-uptodate:hover { color: #15803d !important; }
    #${SETTINGS_ID} .bs-update-btn.has-update {
      width: auto !important;
      height: 28px !important;
      padding: 0 12px !important;
      border-radius: 999px !important;
      gap: 6px !important;
      background: linear-gradient(135deg, #b07a45, #6b4321) !important;
      color: #fff !important;
      font: 700 12px/1 -apple-system, system-ui, sans-serif !important;
      letter-spacing: 0.02em !important;
      box-shadow: 0 4px 12px rgba(107,67,33,0.28) !important;
    }
    #${SETTINGS_ID} .bs-update-btn.has-update:hover { filter: brightness(1.08) !important; color: #fff !important; }
    #${SETTINGS_ID} .bs-update-btn.has-update svg { width: 14px !important; height: 14px !important; }
    #${SETTINGS_ID} .bs-update-btn .bs-update-label { font-weight: 700 !important; }
    @keyframes bsweep-update-spin { to { transform: rotate(360deg); } }
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
    #${SETTINGS_ID} .bs-keycap {
      all: unset !important;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
      min-width: 32px !important;
      height: 26px !important;
      padding: 0 8px !important;
      border-radius: 6px !important;
      background: rgba(241,245,249,0.9) !important;
      border: 1px solid rgba(148,163,184,0.4) !important;
      box-shadow: 0 1px 0 rgba(15,23,42,0.08), inset 0 -1px 0 rgba(15,23,42,0.06) !important;
      font: 700 12px/1 ui-monospace, "Cascadia Code", monospace !important;
      color: #1f2937 !important;
      cursor: pointer !important;
      transition: background 0.12s, transform 0.08s !important;
      flex: 0 0 auto !important;
    }
    #${SETTINGS_ID} .bs-keycap:hover { background: rgba(226,232,240,0.95) !important; }
    #${SETTINGS_ID} .bs-keycap:active { transform: translateY(1px) !important; }
    #${SETTINGS_ID} .bs-keycap.is-recording {
      background: linear-gradient(135deg, #fde68a, #fbbf24) !important;
      color: #78350f !important;
      border-color: rgba(180, 83, 9, 0.45) !important;
    }
    /* ── Blooms carousel ──────────────────── */
    #${SETTINGS_ID} .bs-blooms { padding: 4px 0 !important; }
    #${SETTINGS_ID} .bs-blooms-title {
      color: #1f2937 !important;
      font-weight: 600 !important;
      font-size: 13px !important;
      padding: 0 4px 6px !important;
    }
    #${SETTINGS_ID} .bs-blooms-track {
      display: flex !important;
      flex-direction: row !important;
      gap: 10px !important;
      overflow-x: auto !important;
      overflow-y: hidden !important;
      padding: 10px 10px 14px !important;
      scroll-snap-type: x mandatory !important;
      scrollbar-width: thin !important;
      -webkit-overflow-scrolling: touch !important;
    }
    #${SETTINGS_ID} .bs-blooms-track::-webkit-scrollbar { height: 6px !important; }
    #${SETTINGS_ID} .bs-blooms-track::-webkit-scrollbar-thumb {
      background: rgba(148,163,184,0.45) !important;
      border-radius: 999px !important;
    }
    #${SETTINGS_ID} .bs-bloom-card {
      all: unset !important;
      flex: 0 0 auto !important;
      box-sizing: border-box !important;
      width: 56px !important;
      height: 56px !important;
      border-radius: 10px !important;
      background: rgba(255,255,255,0.7) !important;
      border: 1.5px solid rgba(148,163,184,0.35) !important;
      cursor: pointer !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      scroll-snap-align: start !important;
      transition: transform 0.12s, border-color 0.12s, background 0.12s !important;
      position: relative !important;
      overflow: visible !important;
    }
    #${SETTINGS_ID} .bs-bloom-card:hover { transform: translateY(-1px) !important; background: rgba(255,255,255,0.95) !important; }
    #${SETTINGS_ID} .bs-bloom-card.is-active {
      border-color: #6b4321 !important;
      background: linear-gradient(180deg, #fff7ec, #ffe8c8) !important;
      box-shadow: 0 0 0 2px rgba(176, 122, 69, 0.22) !important;
    }
    #${SETTINGS_ID} .bs-bloom-thumb {
      width: 42px !important;
      height: 42px !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      overflow: hidden !important;
      pointer-events: none !important;
    }
    #${SETTINGS_ID} .bs-bloom-thumb svg { width: 100% !important; height: 100% !important; display: block !important; }
    /* Hidden by default — surfaces as an overlay across the card on hover.
       word-spacing: 100vw is the classic CSS trick to force one word per
       line: every space is wider than the box so the layout always breaks
       at whitespace, fitting more pack names without truncation. */
    #${SETTINGS_ID} .bs-bloom-label {
      position: absolute !important;
      inset: 0 !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      padding: 4px !important;
      background: rgba(15,23,42,0.78) !important;
      color: #fff !important;
      font: 600 10px/1.2 -apple-system, system-ui, sans-serif !important;
      text-align: center !important;
      overflow: hidden !important;
      word-spacing: 100vw !important;
      overflow-wrap: break-word !important;
      border-radius: inherit !important;
      pointer-events: none !important;
      opacity: 0 !important;
      transition: opacity 0.12s ease !important;
    }
    #${SETTINGS_ID} .bs-bloom-card:hover .bs-bloom-label,
    #${SETTINGS_ID} .bs-bloom-card:focus-visible .bs-bloom-label {
      opacity: 1 !important;
    }
    /* Round chip buttons in the corners. Inline SVG inside guarantees a crisp
       glyph that doesn't get clipped by the small bounding box. */
    #${SETTINGS_ID} .bs-bloom-chip {
      all: unset !important;
      position: absolute !important;
      width: 18px !important;
      height: 18px !important;
      border-radius: 50% !important;
      background: rgba(15,23,42,0.65) !important;
      color: #fff !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      cursor: pointer !important;
      opacity: 0 !important;
      transition: opacity 0.12s, background 0.12s, transform 0.12s !important;
      box-shadow: 0 1px 3px rgba(15,23,42,0.35) !important;
    }
    #${SETTINGS_ID} .bs-bloom-chip svg {
      width: 11px !important;
      height: 11px !important;
      display: block !important;
      pointer-events: none !important;
    }
    #${SETTINGS_ID} .bs-bloom-card:hover .bs-bloom-chip { opacity: 1 !important; }
    #${SETTINGS_ID} .bs-bloom-chip:hover { transform: scale(1.08) !important; }
    #${SETTINGS_ID} .bs-bloom-export {
      top: -6px !important;
      left: -6px !important;
    }
    #${SETTINGS_ID} .bs-bloom-export:hover { background: #1d4ed8 !important; }
    #${SETTINGS_ID} .bs-bloom-delete {
      top: -6px !important;
      right: -6px !important;
    }
    #${SETTINGS_ID} .bs-bloom-delete:hover { background: #b91c1c !important; }
    #${SETTINGS_ID} .bs-bloom-card.is-add { border-style: dashed !important; }
    #${SETTINGS_ID} .bs-bloom-card.is-add .bs-bloom-thumb {
      font: 300 26px/1 -apple-system, system-ui, sans-serif !important;
      color: #94a3b8 !important;
    }
    #${SETTINGS_ID} .bs-bloom-card.is-add:hover { border-color: #6b4321 !important; }
    #${SETTINGS_ID} .bs-bloom-card.is-add:hover .bs-bloom-thumb { color: #6b4321 !important; }
    /* ── Bloom upload modal ──────────────────── */
    #broom-bloom-modal {
      position: fixed !important;
      inset: 0 !important;
      z-index: 2147483647 !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      background: rgba(15,23,42,0.45) !important;
      backdrop-filter: blur(4px) !important;
      -webkit-backdrop-filter: blur(4px) !important;
      animation: bsweep-modal-in 0.18s ease-out both !important;
    }
    @keyframes bsweep-modal-in {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
    #broom-bloom-modal .bm-card {
      all: initial !important;
      background: rgba(255,255,255,0.96) !important;
      border-radius: 18px !important;
      box-shadow: 0 24px 60px rgba(15,23,42,0.32) !important;
      width: 380px !important;
      max-width: calc(100vw - 32px) !important;
      padding: 22px !important;
      box-sizing: border-box !important;
      font: 13px/1.45 -apple-system, system-ui, sans-serif !important;
      color: #0f172a !important;
      animation: bsweep-modal-card-in 0.22s cubic-bezier(0.22,1,0.36,1) both !important;
    }
    @keyframes bsweep-modal-card-in {
      from { opacity: 0; transform: translateY(8px) scale(0.97); }
      to   { opacity: 1; transform: translateY(0)   scale(1); }
    }
    #broom-bloom-modal .bm-card * { all: revert; box-sizing: border-box; }
    #broom-bloom-modal h2 {
      margin: 0 0 6px !important;
      font-size: 16px !important;
      font-weight: 700 !important;
    }
    #broom-bloom-modal p { margin: 0 0 14px !important; color: #475569 !important; }
    #broom-bloom-modal .bm-rules {
      list-style: disc !important;
      padding-left: 18px !important;
      margin: 0 0 14px !important;
      color: #334155 !important;
    }
    #broom-bloom-modal .bm-rules li { margin: 2px 0 !important; }
    #broom-bloom-modal .bm-rules code {
      font: 500 12px/1 ui-monospace, "Cascadia Code", monospace !important;
      background: rgba(241,245,249,0.9) !important;
      border: 1px solid rgba(148,163,184,0.28) !important;
      padding: 1px 5px !important;
      border-radius: 5px !important;
      color: #334155 !important;
    }
    #broom-bloom-modal label.bm-name {
      display: block !important;
      font-weight: 600 !important;
      margin-bottom: 4px !important;
      color: #1f2937 !important;
    }
    #broom-bloom-modal input.bm-name-input {
      all: unset !important;
      display: block !important;
      width: 100% !important;
      box-sizing: border-box !important;
      padding: 8px 10px !important;
      border: 1px solid rgba(148,163,184,0.4) !important;
      border-radius: 8px !important;
      font: 500 13px/1.3 -apple-system, system-ui, sans-serif !important;
      color: #0f172a !important;
      background: #fff !important;
      margin-bottom: 12px !important;
    }
    #broom-bloom-modal input.bm-name-input:focus { border-color: #6b4321 !important; outline: 2px solid rgba(176,122,69,0.25) !important; }
    #broom-bloom-modal .bm-drop {
      border: 2px dashed rgba(148,163,184,0.55) !important;
      border-radius: 12px !important;
      padding: 22px 12px !important;
      text-align: center !important;
      color: #64748b !important;
      cursor: pointer !important;
      transition: background 0.14s, border-color 0.14s, color 0.14s !important;
    }
    #broom-bloom-modal .bm-drop:hover, #broom-bloom-modal .bm-drop.is-dragover {
      background: rgba(176,122,69,0.07) !important;
      border-color: #6b4321 !important;
      color: #6b4321 !important;
    }
    #broom-bloom-modal .bm-drop strong { color: #1f2937 !important; display: block !important; margin-bottom: 4px !important; font-size: 14px !important; }
    #broom-bloom-modal .bm-status {
      margin-top: 10px !important;
      font-size: 12px !important;
      min-height: 16px !important;
      color: #475569 !important;
    }
    #broom-bloom-modal .bm-status.is-error { color: #b91c1c !important; }
    #broom-bloom-modal .bm-actions {
      display: flex !important;
      gap: 8px !important;
      justify-content: flex-end !important;
      margin-top: 16px !important;
    }
    #broom-bloom-modal .bm-btn {
      all: unset !important;
      padding: 8px 14px !important;
      border-radius: 8px !important;
      font: 600 13px/1 -apple-system, system-ui, sans-serif !important;
      cursor: pointer !important;
      transition: background 0.12s !important;
    }
    #broom-bloom-modal .bm-btn.bm-secondary { color: #475569 !important; }
    #broom-bloom-modal .bm-btn.bm-secondary:hover { background: rgba(15,23,42,0.06) !important; }
    #broom-bloom-modal .bm-btn.bm-primary {
      background: linear-gradient(135deg, #b07a45, #6b4321) !important;
      color: #fff !important;
    }
    #broom-bloom-modal .bm-btn.bm-primary:hover { filter: brightness(1.08) !important; }
    #broom-bloom-modal .bm-btn.bm-primary[disabled] { opacity: 0.45 !important; cursor: not-allowed !important; }
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
      display: inline-flex !important;
      justify-content: center !important;
      align-items: flex-end !important;
      vertical-align: top !important;
      pointer-events: auto !important;
      line-height: 0 !important;
      overflow: visible !important;
      position: relative !important;
      margin: 4px 0 !important;
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

    /* ── Handwritten name-note ───────────────── */
    /* A small paper-tag label that hangs just below the pot when the user
       hovers a plant. Hidden while any Brooming/Planting/Restoring mode is
       active (the gate is html:not([data-broom-mode])) so it never piles
       on top of the broom-mode selector tag or the plant-mode "Plant here"
       affordance. Hovering the note itself slightly enlarges it and fades
       in a second line ("planted N days ago"). */
    .broom-plant-note {
      all: initial !important;
      position: absolute !important;
      left: 50% !important;
      top: calc(100% + 2px) !important;
      transform: translateX(-50%) translateY(-4px) rotate(-2deg) !important;
      transform-origin: top center !important;
      opacity: 0 !important;
      pointer-events: none !important;
      /* Bottom padding is generous because handwriting fonts (Caveat,
         Bradley Hand, etc.) have long descenders — names like "Daisies"
         and the always-present "y" in "days ago" would otherwise sit
         flush against the note's bottom edge. */
      padding: 5px 12px 8px !important;
      border-radius: 8px !important;
      background: rgba(253, 251, 240, 0.96) !important;
      box-shadow: 0 2px 6px rgba(15,23,42,0.18) !important;
      font-family: 'Caveat', 'Bradley Hand', 'Patrick Hand', 'Marker Felt', 'Segoe Script', cursive !important;
      color: #2f3a2a !important;
      text-align: center !important;
      white-space: nowrap !important;
      transition:
        opacity 160ms ease,
        transform 180ms ease,
        padding 180ms ease !important;
      z-index: 2 !important;
    }
    .broom-plant-note-name {
      display: block !important;
      font-size: 16px !important;
      line-height: 1.25 !important;
      letter-spacing: 0.01em !important;
    }
    .broom-plant-note-date {
      display: block !important;
      font-size: 12px !important;
      line-height: 1.4 !important;
      color: #5a6650 !important;
      opacity: 0 !important;
      max-height: 0 !important;
      overflow: hidden !important;
      margin-top: 0 !important;
      transition:
        opacity 160ms ease,
        max-height 200ms ease,
        margin-top 200ms ease !important;
    }
    /* Reveal the note on plant hover — only when no mode is active OR
       brooming is suspended (hold-to-suspend key held down). */
    html:not([data-broom-mode]) .broom-plant-slot:hover .broom-plant-note,
    html[data-broom-suspended] .broom-plant-slot:hover .broom-plant-note {
      opacity: 1 !important;
      transform: translateX(-50%) translateY(0) rotate(-2deg) !important;
      pointer-events: auto !important;
    }
    /* Expanded state: hover the note itself. */
    html:not([data-broom-mode]) .broom-plant-slot .broom-plant-note:hover,
    html[data-broom-suspended] .broom-plant-slot .broom-plant-note:hover {
      transform: translateX(-50%) translateY(0) rotate(-1deg) scale(1.08) !important;
      padding: 7px 14px 10px !important;
    }
    html:not([data-broom-mode]) .broom-plant-slot .broom-plant-note:hover .broom-plant-note-date,
    html[data-broom-suspended] .broom-plant-slot .broom-plant-note:hover .broom-plant-note-date {
      opacity: 1 !important;
      /* 12px * 1.4 line-height = 16.8px text box, plus a little slack
         so the descender of "y" in "days" / "yesterday" never clips. */
      max-height: 24px !important;
      margin-top: 2px !important;
    }
    /* While dragging a plant, suppress the note so it doesn't trail the
       ghost or flash on the source slot. */
    .broom-plant-slot.broom-dragging .broom-plant-note,
    html.broom-plant-dragging .broom-plant-note {
      opacity: 0 !important;
      pointer-events: none !important;
      transition: opacity 80ms ease !important;
    }

    /* ── Plant drag-and-drop ─────────────────── */
    /* Source slot while being dragged: dim it so the user sees the plant has
       lifted off without losing the original footprint as a reference. */
    .broom-plant-slot.broom-dragging {
      opacity: 0.32 !important;
      transition: opacity 140ms ease !important;
      touch-action: none !important;
    }
    .broom-plant-slot.broom-dragging .broom-plant {
      filter: drop-shadow(0 2px 3px rgba(15,23,42,0.12)) !important;
    }
    /* While any plant drag is active, suppress the existing custom shovel
       cursor on empty slots so the browser shows the default grabbing cursor
       and the drop target reads as inviting rather than fiddly. Also kill
       text-selection across the page so dragging over paragraphs doesn't
       leave highlights behind. */
    html.broom-plant-dragging, html.broom-plant-dragging * {
      cursor: grabbing !important;
      user-select: none !important;
      -webkit-user-select: none !important;
      -moz-user-select: none !important;
      -ms-user-select: none !important;
      -webkit-touch-callout: none !important;
    }
    html.broom-plant-dragging .broom-empty-slot {
      outline-color: rgba(80,160,100,0.65) !important;
      background: rgba(80,160,100,0.10) !important;
    }
    /* Make the planted slot show a grab cursor in plant mode to advertise
       draggability before the user even attempts it. */
    html[data-broom-mode="plant"] .broom-plant-slot {
      cursor: grab !important;
    }
    /* Highlighted drop target: stronger green ring + soft glow + lift. */
    .broom-empty-slot.broom-drop-target {
      outline-color: rgba(80,160,100,0.95) !important;
      background: rgba(80,160,100,0.22) !important;
      box-shadow:
        0 0 0 4px rgba(80,160,100,0.18),
        0 12px 28px rgba(56,161,105,0.32) !important;
      transform: translateY(-2px) scale(1.02) !important;
      animation: none !important;
    }
    .broom-empty-slot.broom-drop-target .broom-empty-slot-label {
      opacity: 1 !important;
      transform: translateX(-50%) translateY(0) !important;
    }
    /* The drag ghost: a clone of the plant, positioned by JS to follow the
       cursor. pointer-events:none keeps it from blocking hit-testing. */
    .broom-drag-ghost {
      position: fixed !important;
      pointer-events: none !important;
      z-index: 2147483647 !important;
      margin: 0 !important;
      opacity: 0.92 !important;
      transform: scale(1.06) rotate(-2deg) !important;
      transform-origin: bottom center !important;
      filter: drop-shadow(0 12px 24px rgba(15,23,42,0.32)) !important;
      will-change: left, top, opacity, transform !important;
      transition: transform 120ms ease, filter 120ms ease !important;
    }
    /* Safety: nuke any inherited animations on cloned children of the ghost. */
    .broom-drag-ghost, .broom-drag-ghost * {
      animation: none !important;
    }
    .broom-drag-ghost-returning {
      transition: left 220ms cubic-bezier(.34,1.56,.64,1),
                  top  220ms cubic-bezier(.34,1.56,.64,1),
                  opacity 220ms ease,
                  transform 220ms ease !important;
      transform: scale(1) rotate(0deg) !important;
    }
    /* Drop-into-new-home animation. Triggered when a plant lands at a new
       slot via drag-and-drop; visually matches the move-pot.m4a sound.
         · .broom-plant body: falls from above with an impact squash.
         · .broom-plant-foliage: whips/wobbles after the impact, then resumes sway.
         · Dust particles (.broom-plant-particle) are spawned in JS to burst
           from the pot base at the impact moment.
       Higher specificity than the default sway/sm/md/lg rules so the
       transition cleanly overrides them while the class is present. */
    .broom-plant-slot.broom-plant-settle > .broom-plant {
      animation: broom-plant-settle-body 460ms cubic-bezier(.2,1.6,.32,1) both !important;
      transform-origin: bottom center !important;
    }
    .broom-plant-slot.broom-plant-settle > .broom-plant > .broom-plant-foliage {
      animation:
        broom-plant-settle-foliage 540ms cubic-bezier(.18,1.2,.36,1.05) both,
        broom-plant-sway 5.5s ease-in-out infinite 540ms !important;
      transform-origin: bottom center !important;
    }
    @keyframes broom-plant-settle-body {
      0%   { transform: translateY(-16px) scale(0.94, 1.10); }
      40%  { transform: translateY(2px)   scale(1.14, 0.86); }   /* impact squash */
      58%  { transform: translateY(-4px)  scale(0.96, 1.05); }
      76%  { transform: translateY(1px)   scale(1.02, 0.99); }
      90%  { transform: translateY(0)     scale(1.005, 0.998); }
      100% { transform: translateY(0)     scale(1, 1); }
    }
    @keyframes broom-plant-settle-foliage {
      0%   { transform: rotate(-2deg) translateY(-2px) scale(0.97); }
      28%  { transform: rotate(6deg)   translateY(-1px) scale(1.03); }   /* whip back */
      48%  { transform: rotate(-5deg)  translateY(0)    scale(1.015); }
      66%  { transform: rotate(3deg)   translateY(0)    scale(1.005); }
      82%  { transform: rotate(-1.5deg) translateY(0)   scale(1); }
      100% { transform: rotate(0)      translateY(0)    scale(1); }
    }
    /* Soil/dust particles use the existing .broom-plant-particle keyframe;
       these tweaks shape them as a small impact poof rather than an upward
       eruption: smaller, rounder, with a soft brown edge. Anchored at the
       slot's bottom edge (= pot base, since .broom-plant-slot is
       align-items: flex-end and the pot is the last child of .broom-plant),
       so the burst reads as dust kicked up where the pot meets the ground
       rather than soil erupting from inside the pot. */
    .broom-plant-particle.broom-plant-dust {
      width: 4px !important;
      height: 4px !important;
      margin-left: -2px !important;
      margin-bottom: -2px !important;
      bottom: 0 !important;
      box-shadow: 0 0 2px rgba(74,47,26,0.45) !important;
      opacity: 0.92 !important;
    }

    /* ── Plant toast ─────────────────────────── */
    #${PLANT_TOAST_ID} {
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
    #${PLANT_TOAST_ID} .bpt-close {
      all: unset;
      cursor: pointer;
      width: 22px;
      height: 22px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      font: 600 16px/1 -apple-system, system-ui, sans-serif;
      color: rgba(248,250,252,0.7);
      background: rgba(248,250,252,0.08);
      margin-left: 2px;
      transition: background 0.12s, color 0.12s, transform 0.1s;
    }
    #${PLANT_TOAST_ID} .bpt-close:hover { background: rgba(248,250,252,0.18); color: #f8fafc; }
    #${PLANT_TOAST_ID} .bpt-close:active { transform: scale(0.9); }
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
    #${UNDO_TOAST_ID} .but-close {
      all: unset;
      cursor: pointer;
      width: 22px;
      height: 22px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      font: 600 16px/1 -apple-system, system-ui, sans-serif;
      color: rgba(248,250,252,0.7);
      background: rgba(248,250,252,0.08);
      margin-left: 2px;
      transition: background 0.12s, color 0.12s, transform 0.1s;
    }
    #${UNDO_TOAST_ID} .but-close:hover { background: rgba(248,250,252,0.18); color: #f8fafc; }
    #${UNDO_TOAST_ID} .but-close:active { transform: scale(0.9); }
    html.broom-picking #${UNDO_TOAST_ID} .but-close { cursor: pointer !important; }

    /* ── First-run touch hint ────────────────── */
    #${TOUCH_HINT_ID} {
      all: initial !important;
      position: fixed !important;
      top: max(12px, env(safe-area-inset-top)) !important;
      left: 12px !important;
      right: 12px !important;
      margin: 0 auto !important;
      max-width: 340px !important;
      box-sizing: border-box !important;
      z-index: 2147483647 !important;
      display: block !important;
      padding: 14px 16px !important;
      border-radius: 16px !important;
      background: rgba(15,23,42,0.94) !important;
      color: #f1f5f9 !important;
      border: 1px solid rgba(56,161,105,0.4) !important;
      box-shadow: 0 16px 40px rgba(15,23,42,0.32), 0 2px 8px rgba(15,23,42,0.18) !important;
      font: 400 14px/1.4 -apple-system, system-ui, sans-serif !important;
      backdrop-filter: blur(14px) saturate(1.3) !important;
      -webkit-backdrop-filter: blur(14px) saturate(1.3) !important;
      animation: broom-toast-in 0.32s cubic-bezier(.34,1.56,.64,1) !important;
    }
    #${TOUCH_HINT_ID}.bth-leaving {
      animation: broom-toast-out 0.22s ease-in forwards !important;
    }
    #${TOUCH_HINT_ID} * { all: unset; box-sizing: border-box; font: inherit; color: inherit; }
    html.broom-picking #${TOUCH_HINT_ID},
    html.broom-picking #${TOUCH_HINT_ID} * { cursor: default !important; }
    #${TOUCH_HINT_ID} .bth-title { display: block; font-weight: 700; font-size: 15px; color: #f8fafc; margin-bottom: 8px; }
    #${TOUCH_HINT_ID} .bth-step { display: flex; gap: 8px; align-items: baseline; margin-top: 4px; }
    #${TOUCH_HINT_ID} .bth-num {
      flex: none;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: rgba(56,161,105,0.28);
      color: #cdfbe2;
      font-size: 11px;
      font-weight: 700;
      line-height: 18px;
      text-align: center;
    }
    #${TOUCH_HINT_ID} .bth-note { display: block; margin-top: 8px; font-size: 12px; color: rgba(241,245,249,0.7); }
    #${TOUCH_HINT_ID} .bth-actions { display: flex; justify-content: flex-end; margin-top: 10px; }
    #${TOUCH_HINT_ID} .bth-btn {
      padding: 7px 14px;
      border-radius: 9px;
      font-size: 13px;
      font-weight: 600;
      color: #cdfbe2;
      background: rgba(56,161,105,0.22);
      border: 1px solid rgba(56,161,105,0.4);
      transition: background 0.12s, transform 0.1s;
    }
    html.broom-picking #${TOUCH_HINT_ID} .bth-btn { cursor: pointer !important; }
    #${TOUCH_HINT_ID} .bth-btn:active { transform: scale(0.96); background: rgba(56,161,105,0.36); }

    /* When the broom is dragged to the bottom-left (where toasts normally live),
       flip toasts to the bottom-right so the icon doesn't cover them. */
    html[data-broom-toast-side="right"] #${PLANT_TOAST_ID},
    html[data-broom-toast-side="right"] #${UNDO_TOAST_ID} {
      left: auto !important;
      right: 22px !important;
    }

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
      .broom-plant-note, .broom-plant-note-name, .broom-plant-note-date,
      .broom-plant-slot.broom-dragging, .broom-empty-slot.broom-drop-target,
      .broom-drag-ghost, .broom-drag-ghost-returning,
      .broom-plant-slot.broom-plant-settle,
      .broom-plant-slot.broom-plant-settle > .broom-plant,
      .broom-plant-slot.broom-plant-settle > .broom-plant > .broom-plant-foliage,
      .broom-restore-overlay, .broom-restore-overlay.broom-restore-leaving, .broom-restore-plus,
      #${UNDO_TOAST_ID}, #${UNDO_TOAST_ID}.but-leaving,
      #${TOUCH_HINT_ID}, #${TOUCH_HINT_ID}.bth-leaving,
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

// Reference-counted visibility for the broom cursor follower. Multiple sweeps
// can overlap when the user broomsweeps several elements in quick succession;
// without a counter, a naïve save/restore would capture the already-hidden
// state and leave the follower permanently invisible.
let cursorHideRefCount = 0;
function hideBroomCursorForSweep() {
  cursorHideRefCount++;
  const cursorEl = document.getElementById(BROOM_CURSOR_ID);
  if (cursorEl) cursorEl.style.visibility = "hidden";
}
function showBroomCursorAfterSweep() {
  cursorHideRefCount = Math.max(0, cursorHideRefCount - 1);
  if (cursorHideRefCount === 0) {
    const cursorEl = document.getElementById(BROOM_CURSOR_ID);
    if (cursorEl) cursorEl.style.visibility = "";
  }
}

function onCursorMove(e) {
  // Touch drives the follower from the aim point, not the raw contact point —
  // ignore the synthetic mousemove iOS fires alongside the touch stream.
  if (lastPointerWasTouch) return;
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

function playMovePotSound() {
  if (cachedPrefs.soundEnabled === false) return;
  try {
    const audio = new Audio(chrome.runtime.getURL("move-pot.m4a"));
    audio.volume = 0.55;
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
  if (broomSuspended) return;
  // Touch aims via hold-and-slide (onPickerPointerDown), so the synthetic
  // mouseover iOS fires on contact must not move the highlight.
  if (lastPointerWasTouch) return;
  const resolved = resolveBroomTarget(e.target);
  if (!resolved) return;
  if (!resolved.plantRule && isOurUI(e.target)) return;
  const prevTarget = pickerTarget;
  pickerTarget = resolved.target;
  if (prevTarget !== resolved.target) triggerCursorWiggle();
  const r = resolved.target.getBoundingClientRect();
  const h = document.getElementById(HIGHLIGHT_ID);
  if (h) {
    // Touch parks the highlight at opacity 0 between gestures; clear that so a
    // mouse hover on a hybrid device (iPad + trackpad) gets its box back.
    h.style.removeProperty("opacity");
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
  if (broomSuspended) return;
  // Touch commits on release of the aim gesture. Swallow the tap so a stray
  // touch neither sweeps nor activates the link underneath it.
  if (lastPointerWasTouch) {
    if (!isOurUI(e.target)) { e.preventDefault(); e.stopPropagation(); }
    return;
  }
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

// ── Touch aiming (hold-to-hover) ─────────────────────────────────────────────
// Touch has no hover, so a tap used to select and sweep in one gesture: no
// preview, and a lot of undos. Instead the user presses and holds, then slides
// to scan targets and lifts to sweep whatever is lit up.
//
//   • The hit-test point sits AIM_OFFSET_Y *above* the fingertip so the target
//     is never under the thumb. The broom follower parks on that point so it's
//     always obvious where you're actually pointing. (Elements in the bottom
//     AIM_OFFSET_Y of the viewport are unreachable — accepted tradeoff. The top
//     edge is clamped instead, so the first row of the page stays reachable.)
//   • The hold threshold separates aiming from scrolling: move before the timer
//     fires and it was a scroll — we never called preventDefault, so the page
//     scrolls untouched. Stay put and we capture the pointer and lock the page.
//   • <body>/<html> are not aimable, so sliding to blank page area and lifting
//     is a free cancel — and a sloppy aim can't hide the entire document.
//   • `lastPointerWasTouch` stands the mouse path down for the synthetic events
//     iOS fires alongside touch, so hybrid devices (iPad + trackpad) keep both
//     interaction models rather than having to pick one at startup.

const AIM_OFFSET_Y = 40;        // hit-test this far above the fingertip
const AIM_HOLD_MS = 220;        // press duration before aiming engages
const AIM_MOVE_TOLERANCE = 10;  // px of slop tolerated during the hold

let lastPointerWasTouch = false;
let touchAim = null;

// Hit-test row for a given fingertip Y, clamped into the viewport.
function aimY(clientY) { return Math.max(2, clientY - AIM_OFFSET_Y); }

function onPickerPointerDown(e) {
  lastPointerWasTouch = e.pointerType === "touch" || e.pointerType === "pen";
  if (!lastPointerWasTouch) return;
  if (activeMode !== "broom" || broomSuspended) return;
  if (touchAim) return;           // one finger at a time
  if (isOurUI(e.target)) return;  // launcher / settings stay tappable

  const state = {
    pointerId: e.pointerId,
    startX: e.clientX, startY: e.clientY,
    x: e.clientX, y: e.clientY,
    aiming: false,
    target: null,
    plantRule: null,
    holdTimer: null,
    swallow: (ev) => { ev.preventDefault(); },
  };

  const onMove = (mv) => {
    if (mv.pointerId !== state.pointerId) return;
    state.x = mv.clientX;
    state.y = mv.clientY;
    if (state.aiming) { updateTouchAim(state); return; }
    const dx = mv.clientX - state.startX;
    const dy = mv.clientY - state.startY;
    if (dx * dx + dy * dy > AIM_MOVE_TOLERANCE * AIM_MOVE_TOLERANCE) {
      teardown(); // travelled before the hold landed — the user is scrolling
    }
  };

  const onUp = (up) => {
    if (up.pointerId !== state.pointerId) return;
    const wasAiming = state.aiming;
    const target = state.target;
    const plantRule = state.plantRule;
    const ax = state.x;
    const ay = aimY(state.y);
    teardown();
    if (!wasAiming) return;
    up.preventDefault?.();
    up.stopPropagation?.();
    commitTouchAim(target, plantRule, ax, ay);
  };

  const onCancel = (cn) => {
    if (cn.pointerId !== state.pointerId) return;
    teardown();
  };

  const teardown = () => {
    clearTimeout(state.holdTimer);
    state.holdTimer = null;
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onCancel, true);
    if (state.aiming) endTouchAim(state);
    if (touchAim === state) touchAim = null;
  };

  state.teardown = teardown;
  touchAim = state;
  state.holdTimer = setTimeout(() => beginTouchAim(state), AIM_HOLD_MS);
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onCancel, true);
}

function beginTouchAim(state) {
  state.aiming = true;
  state.holdTimer = null;
  try { document.documentElement.setPointerCapture(state.pointerId); } catch { /* */ }
  document.documentElement.classList.add("broom-aiming");
  // Same belt-and-suspenders as the plant drag: block scroll, the iOS callout
  // and any selection the hold may have started.
  document.addEventListener("touchmove", state.swallow, { capture: true, passive: false });
  document.addEventListener("selectstart", state.swallow, true);
  document.addEventListener("contextmenu", state.swallow, true);
  try { window.getSelection?.()?.removeAllRanges?.(); } catch { /* */ }
  ensureBroomCursor();
  triggerCursorWiggle();
  updateTouchAim(state);
}

function endTouchAim(state) {
  state.aiming = false;
  try { document.documentElement.releasePointerCapture(state.pointerId); } catch { /* */ }
  document.documentElement.classList.remove("broom-aiming");
  document.removeEventListener("touchmove", state.swallow, true);
  document.removeEventListener("selectstart", state.swallow, true);
  document.removeEventListener("contextmenu", state.swallow, true);
  pickerTarget = null;
  hideSelectorTag();
  // Leave the highlight hidden: with no hover there's nothing to repopulate it
  // between gestures, so the next updateTouchAim() is what brings it back.
  document.getElementById(HIGHLIGHT_ID)?.style.setProperty("opacity", "0");
  const cursorEl = document.getElementById(BROOM_CURSOR_ID);
  if (cursorEl) cursorEl.style.transform = "translate3d(-100px, -100px, 0)";
}

function updateTouchAim(state) {
  const ax = state.x;
  const ay = aimY(state.y);
  const cursorEl = document.getElementById(BROOM_CURSOR_ID);
  if (cursorEl) cursorEl.style.transform = `translate3d(${ax - 6}px, ${ay - 58}px, 0)`;

  // All of our overlays are pointer-events: none, so this hit-tests the page.
  const resolved = resolveBroomTarget(document.elementFromPoint(ax, ay));
  const el = resolved?.target;
  const aimable = !!el
    && (resolved.plantRule || !isOurUI(el))
    && el !== document.body
    && el !== document.documentElement;
  const h = document.getElementById(HIGHLIGHT_ID);

  if (!aimable) {
    state.target = null;
    state.plantRule = null;
    pickerTarget = null;
    hideSelectorTag();
    h?.style.setProperty("opacity", "0");
    return;
  }

  if (state.target !== el) triggerCursorWiggle();
  state.target = el;
  state.plantRule = resolved.plantRule;
  pickerTarget = el;
  const r = el.getBoundingClientRect();
  if (h) {
    h.style.removeProperty("opacity");
    Object.assign(h.style, {
      top: `${r.top}px`, left: `${r.left}px`,
      width: `${r.width}px`, height: `${r.height}px`,
    });
  }
  if (resolved.plantRule) {
    const name = PLANT_NAMES[resolved.plantRule.payload.plant.kind] || "plant";
    showSelectorTagText(`🌱 ${name}`, el);
  } else {
    showSelectorTag(el);
  }
}

function commitTouchAim(target, plantRule, ax, ay) {
  if (!target?.isConnected) return;
  void markTouchHintSeen();
  // Sparkles land on the aimed element rather than down at the fingertip.
  spawnSparklePuff(ax, ay, 6, 50);
  if (plantRule) { void sweepAwayPlant(plantRule); return; }
  void playSweepAndHide(target, buildSelector(target), { x: ax, y: ay });
}

function cancelTouchAim() {
  touchAim?.teardown?.();
  touchAim = null;
}

// Hold-to-suspend: while the configured key is held inside an active broom
// mode, brooming is paused so the user can interact with native page UI
// (open a dropdown, expand a menu) and then sweep / plant / restore *inside*
// what they just opened on release.
function isEditableTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (typeof target.isContentEditable === "boolean" && target.isContentEditable) return true;
  return false;
}

function applySuspended() {
  if (broomSuspended) return;
  broomSuspended = true;
  document.documentElement.setAttribute("data-broom-suspended", "");
  // Drop any in-progress highlight/tag so the page reads as native immediately.
  document.getElementById(HIGHLIGHT_ID)?.style.setProperty("opacity", "0");
  hideSelectorTag();
  pickerTarget = null;
}

function clearSuspended() {
  if (!broomSuspended) return;
  broomSuspended = false;
  document.documentElement.removeAttribute("data-broom-suspended");
  document.getElementById(HIGHLIGHT_ID)?.style.removeProperty("opacity");
}

// State for the settings "press a key" recorder — when non-null, the next
// letter key captured by globalKeydown becomes the new suspendKey instead of
// triggering suspend.
let suspendKeyRecorder = null;

// Render "KeyB" → "B" for the settings keycap. Falls back to the raw code
// for anything non-letter so the user can see what's currently stored.
function suspendKeyLabel(code) {
  const c = code || "KeyB";
  const m = /^Key([A-Z])$/.exec(c);
  return m ? m[1] : c;
}

// Build a single card DOM node for the Blooms carousel. Static markup —
// click handlers are wired by the caller via event delegation.
function makeBloomCard({ packId, label, svg, isActive, isAdd }) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "bs-bloom-card" + (isActive ? " is-active" : "") + (isAdd ? " is-add" : "");
  if (packId) card.dataset.packId = packId;
  if (isAdd) card.dataset.act = "add-pack";
  const thumb = document.createElement("span");
  thumb.className = "bs-bloom-thumb";
  if (isAdd) thumb.textContent = "+";
  else thumb.innerHTML = svg || "";
  card.appendChild(thumb);
  const lbl = document.createElement("span");
  lbl.className = "bs-bloom-label";
  lbl.textContent = label;
  card.appendChild(lbl);
  if (packId && packId !== "__default__") {
    const exp = document.createElement("span");
    exp.className = "bs-bloom-chip bs-bloom-export";
    exp.dataset.act = "export-pack";
    exp.dataset.packId = packId;
    exp.title = "Download as .broompack";
    exp.setAttribute("role", "button");
    exp.setAttribute("aria-label", `Download ${label} as .broompack`);
    exp.innerHTML = BLOOM_CHIP_EXPORT_SVG;
    card.appendChild(exp);

    const del = document.createElement("span");
    del.className = "bs-bloom-chip bs-bloom-delete";
    del.dataset.act = "delete-pack";
    del.dataset.packId = packId;
    del.title = "Remove pack";
    del.setAttribute("role", "button");
    del.setAttribute("aria-label", `Remove ${label}`);
    del.innerHTML = BLOOM_CHIP_CLOSE_SVG;
    card.appendChild(del);
  }
  return card;
}

const BLOOM_CHIP_CLOSE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>`;
const BLOOM_CHIP_EXPORT_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v12"/><polyline points="6 10 12 16 18 10"/><path d="M5 20h14"/></svg>`;

// Repopulate the carousel inside the open settings popover. Safe to call
// repeatedly — wipes children first.
function renderBloomsCarousel() {
  const track = document.querySelector(`#${SETTINGS_ID} [data-bs-blooms]`);
  if (!track) return;
  track.innerHTML = "";

  // Default (built-in) card — always present, leads the carousel.
  const activeId = cachedPrefs.activePackId || null;
  const defaultThumb = PLANT_SVGS.pothos || "";
  track.appendChild(makeBloomCard({
    packId: "__default__",
    label: "Default",
    svg: defaultThumb,
    isActive: !activeId
  }));

  for (const pack of customPacksIndex) {
    track.appendChild(makeBloomCard({
      packId: pack.id,
      label: pack.name,
      svg: pack.thumb,
      isActive: activeId === pack.id
    }));
  }

  // Trailing add button.
  track.appendChild(makeBloomCard({ packId: null, label: "Add", isAdd: true }));
}

const BLOOM_MODAL_ID = "broom-bloom-modal";

// Open the "Add a bloom pack" modal. Lets the user drop or pick a folder of
// SVGs, names the pack, sanitizes every file, and saves it. The settings
// popover is left open underneath so when the modal closes we just refresh
// the carousel — no special re-mount needed.
function openBloomUploadModal() {
  closeBloomUploadModal();
  const overlay = document.createElement("div");
  overlay.id = BLOOM_MODAL_ID;
  overlay.innerHTML = `
    <div class="bm-card" role="dialog" aria-label="Add a bloom pack">
      <h2>Add a bloom pack</h2>
      <p>Drop a folder of SVGs to use as your planting pool.</p>
      <ul class="bm-rules">
        <li>SVG files only — other formats are ignored.</li>
        <li>Up to ${MAX_PACK_FILES} files per pack.</li>
        <li>Total size under ${Math.round(MAX_PACK_BYTES / (1024 * 1024))} MB.</li>
        <li>Each SVG's filename becomes that bloom's label on hover.</li>
        <li>Already have a <code>.broompack</code> file? Drop it here to import.</li>
      </ul>
      <label class="bm-name" for="bm-pack-name">Pack name</label>
      <input id="bm-pack-name" class="bm-name-input" type="text" maxlength="64" placeholder="e.g. Pixel garden" />
      <div class="bm-drop" tabindex="0" role="button" aria-label="Drop a folder of SVGs or click to choose one">
        <strong>Drop a folder here</strong>
        <span>or click to choose one</span>
      </div>
      <input type="file" class="bm-file-input" webkitdirectory directory multiple accept=".svg,image/svg+xml" hidden />
      <div class="bm-status" aria-live="polite"></div>
      <div class="bm-actions">
        <button class="bm-btn bm-secondary" type="button" data-act="cancel">Cancel</button>
        <button class="bm-btn bm-primary" type="button" data-act="save" disabled>Save pack</button>
      </div>
    </div>
  `;
  document.documentElement.appendChild(overlay);

  const nameInput = overlay.querySelector(".bm-name-input");
  const drop = overlay.querySelector(".bm-drop");
  const fileInput = overlay.querySelector(".bm-file-input");
  const status = overlay.querySelector(".bm-status");
  const saveBtn = overlay.querySelector('[data-act="save"]');
  const cancelBtn = overlay.querySelector('[data-act="cancel"]');

  // Sanitized entries staged for save. Populated by handleFiles().
  let staged = []; // { plantId, name, svg }

  function setStatus(msg, isError) {
    status.textContent = msg || "";
    status.classList.toggle("is-error", !!isError);
  }

  function setSaveEnabled(on) {
    if (on) saveBtn.removeAttribute("disabled");
    else saveBtn.setAttribute("disabled", "");
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    const svgFiles = files.filter((f) => /\.svg$/i.test(f.name));
    if (!svgFiles.length) {
      staged = [];
      setSaveEnabled(false);
      setStatus("No SVG files found in that selection.", true);
      return;
    }
    if (svgFiles.length > MAX_PACK_FILES) {
      staged = [];
      setSaveEnabled(false);
      setStatus(`Too many files: ${svgFiles.length} found, limit is ${MAX_PACK_FILES}.`, true);
      return;
    }
    const totalBytes = svgFiles.reduce((n, f) => n + f.size, 0);
    if (totalBytes > MAX_PACK_BYTES) {
      staged = [];
      setSaveEnabled(false);
      setStatus(`Folder is too large: ${(totalBytes / (1024 * 1024)).toFixed(2)} MB, limit is ${MAX_PACK_BYTES / (1024 * 1024)} MB.`, true);
      return;
    }
    // Default the pack name from the top-level folder if the field is empty
    // and we have webkitRelativePath data.
    const rel = svgFiles[0].webkitRelativePath;
    if (!nameInput.value && rel) {
      const top = rel.split("/")[0];
      if (top) nameInput.value = top;
    }

    setStatus("Processing…");
    const out = [];
    let rejected = 0;
    for (let i = 0; i < svgFiles.length; i++) {
      const f = svgFiles[i];
      let text;
      try { text = await f.text(); } catch { rejected++; continue; }
      const cleaned = sanitizeSvg(text);
      if (!cleaned) { rejected++; continue; }
      out.push({ plantId: String(i), name: prettifyPlantName(f.name), svg: cleaned });
    }
    if (!out.length) {
      staged = [];
      setSaveEnabled(false);
      setStatus("None of the SVGs in that folder were valid.", true);
      return;
    }
    staged = out;
    setSaveEnabled(true);
    const msg = rejected
      ? `${out.length} SVGs ready · ${rejected} skipped (invalid or unsafe).`
      : `${out.length} SVGs ready.`;
    setStatus(msg, false);
  }

  drop.addEventListener("click", () => fileInput.click());
  drop.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
  });
  fileInput.addEventListener("change", () => handleFiles(fileInput.files));
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("is-dragover");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("is-dragover"));
  drop.addEventListener("drop", async (e) => {
    e.preventDefault();
    drop.classList.remove("is-dragover");
    const dt = e.dataTransfer;
    if (!dt) return;

    // Single .broompack file → import path (skip the folder walker entirely).
    const files = Array.from(dt.files || []);
    if (files.length === 1 && /\.broompack$/i.test(files[0].name)) {
      await handleBroompackDrop(files[0]);
      return;
    }

    // Otherwise walk whatever was dropped as a directory tree of SVGs.
    const items = dt.items;
    if (items && items.length && items[0].webkitGetAsEntry) {
      const collected = [];
      const walks = [];
      for (const item of Array.from(items)) {
        const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
        if (entry) walks.push(walkEntry(entry, collected));
      }
      await Promise.all(walks);
      await handleFiles(collected);
    } else if (files.length) {
      await handleFiles(files);
    }
  });

  async function handleBroompackDrop(file) {
    setStatus("Importing pack…");
    try {
      const imported = await importBroompackFile(file);
      if (!nameInput.value) nameInput.value = imported.name;
      staged = imported.entries;
      setSaveEnabled(true);
      setStatus(`${imported.entries.length} bloom${imported.entries.length === 1 ? "" : "s"} ready from the pack.`);
    } catch (err) {
      staged = [];
      setSaveEnabled(false);
      setStatus((err && err.message) || String(err), true);
    }
  }

  cancelBtn.addEventListener("click", () => closeBloomUploadModal());
  saveBtn.addEventListener("click", async () => {
    if (!staged.length) return;
    saveBtn.setAttribute("disabled", "");
    const name = nameInput.value.trim() || "Custom pack";
    try {
      await saveCustomPack({ name, entries: staged });
      closeBloomUploadModal();
      renderBloomsCarousel();
    } catch (err) {
      setStatus(`Save failed: ${(err && err.message) || err}`, true);
      saveBtn.removeAttribute("disabled");
    }
  });

  // Close on backdrop click + Esc
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeBloomUploadModal();
  });
  document.addEventListener("keydown", onBloomModalKeydown, true);

  // Focus the name input so the user can type immediately if they prefer.
  setTimeout(() => nameInput.focus(), 50);
}

function onBloomModalKeydown(e) {
  if (e.key === "Escape" && document.getElementById(BLOOM_MODAL_ID)) {
    e.preventDefault();
    e.stopPropagation();
    closeBloomUploadModal();
  }
}

function closeBloomUploadModal() {
  document.removeEventListener("keydown", onBloomModalKeydown, true);
  document.getElementById(BLOOM_MODAL_ID)?.remove();
}

// Recursively read every .svg File inside a DataTransfer FileSystemEntry.
// Used for folder drag-and-drop where the browser hands us a directory tree.
function walkEntry(entry, out) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file((file) => {
        if (/\.svg$/i.test(file.name)) out.push(file);
        resolve();
      }, () => resolve());
      return;
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      const readAll = (acc) => {
        reader.readEntries((entries) => {
          if (!entries.length) {
            Promise.all(acc.map((c) => walkEntry(c, out))).then(() => resolve());
            return;
          }
          readAll(acc.concat(entries));
        }, () => resolve());
      };
      readAll([]);
      return;
    }
    resolve();
  });
}

function globalKeyup(e) {
  if (!broomSuspended) return;
  const suspendCode = cachedPrefs.suspendKey || "KeyB";
  // Match on either code (preferred) or fall back to clearing on any keyup
  // for safety when keyboards remap mid-press.
  if (e.code === suspendCode) {
    clearSuspended();
  }
}

// Global keydown — always active. Esc exits brooming/closes panel.
// Enter while a target is highlighted instantly hides it with a sweep animation.
function globalKeydown(e) {
  // Suspend-key recorder takes priority: capture the next letter keypress.
  // stopImmediatePropagation prevents the settings popover's own Esc handler
  // from closing the popover when the user is just canceling the recorder.
  if (suspendKeyRecorder) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      suspendKeyRecorder.cancel();
      return;
    }
    if (/^Key[A-Z]$/.test(e.code)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      suspendKeyRecorder.commit(e.code);
    } else {
      // Swallow other keys during recording so the host page doesn't react.
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    return;
  }

  // Hold-to-suspend trigger. Only inside an active broom mode; ignore
  // auto-repeat, modifier-laden chords, and keys typed into form fields.
  const suspendCode = cachedPrefs.suspendKey || "KeyB";
  if (
    activeMode &&
    e.code === suspendCode &&
    !e.repeat &&
    !e.ctrlKey && !e.metaKey && !e.altKey &&
    !isEditableTarget(e.target)
  ) {
    e.preventDefault();
    e.stopPropagation();
    applySuspended();
    return;
  }

  if (e.key === "Escape") {
    let handled = false;
    if (activeMode) { stopMode(); handled = true; }
    if (document.getElementById(PANEL_ID)) { closePanel(); handled = true; }
    if (document.getElementById(PLANT_TOAST_ID)) { hidePlantToast(); handled = true; }
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

// Drag-to-reposition state. Position is stored in cachedPrefs.launcherPos as
// corner-relative offsets, so the icon "sticks" to the nearest corner across
// resizes and reloads. Default-null = bottom-right via CSS.
const LAUNCHER_MARGIN_PX = 8;
const LAUNCHER_SIZE_PX = 54;
let launcherDragJustEnded = false;
let activeLauncherDrag = null;

function applyToastSide(anchorX, anchorY) {
  if (anchorY === "bottom" && anchorX === "left") {
    document.documentElement.setAttribute("data-broom-toast-side", "right");
  } else {
    document.documentElement.removeAttribute("data-broom-toast-side");
  }
}

function applyLauncherPlacement(wrap) {
  const target = wrap || document.getElementById(LAUNCHER_WRAP_ID);
  if (!target) return;
  const pos = cachedPrefs.launcherPos;
  if (!pos) {
    target.style.removeProperty("top");
    target.style.removeProperty("left");
    target.style.removeProperty("right");
    target.style.removeProperty("bottom");
    target.removeAttribute("data-broom-anchor-x");
    target.removeAttribute("data-broom-anchor-y");
    applyToastSide("right", "bottom");
    positionSettingsPopover(document.getElementById(SETTINGS_ID));
    return;
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const maxX = Math.max(LAUNCHER_MARGIN_PX, vw - LAUNCHER_SIZE_PX - LAUNCHER_MARGIN_PX);
  const maxY = Math.max(LAUNCHER_MARGIN_PX, vh - LAUNCHER_SIZE_PX - LAUNCHER_MARGIN_PX);
  const offsetX = Math.min(Math.max(pos.offsetX, LAUNCHER_MARGIN_PX), maxX);
  const offsetY = Math.min(Math.max(pos.offsetY, LAUNCHER_MARGIN_PX), maxY);
  const ax = pos.anchorX === "left" ? "left" : "right";
  const ay = pos.anchorY === "top" ? "top" : "bottom";
  target.style.setProperty(ax, `${offsetX}px`, "important");
  target.style.setProperty(ay, `${offsetY}px`, "important");
  target.style.setProperty(ax === "left" ? "right" : "left", "auto", "important");
  target.style.setProperty(ay === "top" ? "bottom" : "top", "auto", "important");
  target.setAttribute("data-broom-anchor-x", ax);
  target.setAttribute("data-broom-anchor-y", ay);
  applyToastSide(ax, ay);
  positionSettingsPopover(document.getElementById(SETTINGS_ID));
}

const SETTINGS_POPOVER_GAP_PX = 20;
const SETTINGS_POPOVER_WIDTH_PX = 280;
// Padding + border outside width/max-height: the popover is content-box (all: initial).
const SETTINGS_POPOVER_CHROME_PX = 30;

function positionSettingsPopover(pop) {
  if (!pop) return;
  const launcher = document.getElementById(LAUNCHER_WRAP_ID);
  if (!launcher) return;
  const lr = launcher.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const placeAbove = (lr.top + lr.height / 2) >= vh / 2;
  const alignRight = (lr.left + lr.width / 2) >= vw / 2;
  // Narrow viewports (Safari page zoom, small phones) shrink the popover to fit.
  const popWidth = Math.min(SETTINGS_POPOVER_WIDTH_PX, vw - 2 * LAUNCHER_MARGIN_PX - SETTINGS_POPOVER_CHROME_PX);
  pop.style.setProperty("width", `${popWidth}px`, "important");
  const maxOffset = Math.max(LAUNCHER_MARGIN_PX, vw - popWidth - SETTINGS_POPOVER_CHROME_PX - LAUNCHER_MARGIN_PX);

  if (placeAbove) {
    pop.style.setProperty("bottom", `${Math.max(LAUNCHER_MARGIN_PX, vh - lr.top + SETTINGS_POPOVER_GAP_PX)}px`, "important");
    pop.style.setProperty("top", "auto", "important");
  } else {
    pop.style.setProperty("top", `${Math.max(LAUNCHER_MARGIN_PX, lr.bottom + SETTINGS_POPOVER_GAP_PX)}px`, "important");
    pop.style.setProperty("bottom", "auto", "important");
  }
  // Short viewports (iPhone landscape, Safari toolbars showing) can't fit the
  // whole popover, so cap it to the room on its side and let it scroll.
  const room = placeAbove
    ? lr.top - SETTINGS_POPOVER_GAP_PX - LAUNCHER_MARGIN_PX
    : vh - lr.bottom - SETTINGS_POPOVER_GAP_PX - LAUNCHER_MARGIN_PX;
  pop.style.setProperty("max-height", `${Math.max(120, room - SETTINGS_POPOVER_CHROME_PX)}px`, "important");
  if (alignRight) {
    const right = Math.min(maxOffset, Math.max(LAUNCHER_MARGIN_PX, vw - lr.right));
    pop.style.setProperty("right", `${right}px`, "important");
    pop.style.setProperty("left", "auto", "important");
  } else {
    const left = Math.min(maxOffset, Math.max(LAUNCHER_MARGIN_PX, lr.left));
    pop.style.setProperty("left", `${left}px`, "important");
    pop.style.setProperty("right", "auto", "important");
  }
}

function attachLauncherDragHandlers(wrap, main, closeFan) {
  main.addEventListener("pointerdown", (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    if (activeLauncherDrag) return;

    const state = {
      wrap,
      main,
      closeFan,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      dragging: false,
      offsetX: 0,
      offsetY: 0,
      _suppressSelect: null
    };

    const onMove = (mv) => {
      if (mv.pointerId !== state.pointerId) return;
      if (!state.dragging) {
        const dx = mv.clientX - state.startX;
        const dy = mv.clientY - state.startY;
        if (dx * dx + dy * dy < PLANT_DRAG_THRESHOLD_PX * PLANT_DRAG_THRESHOLD_PX) return;
        beginLauncherDrag(state, mv);
      } else {
        updateLauncherDragPosition(state, mv);
      }
    };

    const onUp = (up) => {
      if (up.pointerId !== state.pointerId) return;
      cleanupListeners();
      if (state.dragging) {
        up.preventDefault?.();
        up.stopPropagation?.();
        completeLauncherDrop(state);
      }
    };

    const onCancel = (cn) => {
      if (cn.pointerId !== state.pointerId) return;
      cleanupListeners();
      if (state.dragging) abortLauncherDrag(state);
    };

    const onEsc = (ke) => {
      if (ke.key === "Escape" && state.dragging) {
        ke.preventDefault();
        ke.stopPropagation();
        cleanupListeners();
        abortLauncherDrag(state);
      }
    };

    const cleanupListeners = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
      window.removeEventListener("keydown", onEsc, true);
    };

    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
    window.addEventListener("keydown", onEsc, true);
  });
}

function beginLauncherDrag(state, mv) {
  state.dragging = true;
  activeLauncherDrag = state;
  try { state.main.setPointerCapture(state.pointerId); } catch { /* */ }

  state.closeFan?.();
  state.wrap.classList.add("broom-dragging");
  document.documentElement.classList.add("broom-launcher-dragging");

  try { window.getSelection?.()?.removeAllRanges?.(); } catch { /* */ }
  const swallow = (ev) => { ev.preventDefault(); };
  state._suppressSelect = swallow;
  document.addEventListener("selectstart", swallow, true);
  document.addEventListener("dragstart", swallow, true);

  const rect = state.wrap.getBoundingClientRect();
  state.offsetX = mv.clientX - rect.left;
  state.offsetY = mv.clientY - rect.top;
  state.wrap.style.setProperty("right", "auto", "important");
  state.wrap.style.setProperty("bottom", "auto", "important");
  updateLauncherDragPosition(state, mv);
}

function updateLauncherDragPosition(state, mv) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = mv.clientX - state.offsetX;
  let top = mv.clientY - state.offsetY;
  const maxX = Math.max(LAUNCHER_MARGIN_PX, vw - LAUNCHER_SIZE_PX - LAUNCHER_MARGIN_PX);
  const maxY = Math.max(LAUNCHER_MARGIN_PX, vh - LAUNCHER_SIZE_PX - LAUNCHER_MARGIN_PX);
  left = Math.min(Math.max(left, LAUNCHER_MARGIN_PX), maxX);
  top = Math.min(Math.max(top, LAUNCHER_MARGIN_PX), maxY);
  state.wrap.style.setProperty("left", `${left}px`, "important");
  state.wrap.style.setProperty("top", `${top}px`, "important");
}

function completeLauncherDrop(state) {
  releaseLauncherDragGuards(state);
  state.wrap.classList.remove("broom-dragging");
  document.documentElement.classList.remove("broom-launcher-dragging");
  activeLauncherDrag = null;

  const rect = state.wrap.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const anchorX = cx < vw / 2 ? "left" : "right";
  const anchorY = cy < vh / 2 ? "top" : "bottom";
  const offsetX = Math.round(anchorX === "left" ? rect.left : vw - rect.right);
  const offsetY = Math.round(anchorY === "top" ? rect.top : vh - rect.bottom);
  const nextPos = { anchorX, anchorY, offsetX, offsetY };

  launcherDragJustEnded = true;
  queueMicrotask(() => { launcherDragJustEnded = false; });

  void setPref("launcherPos", nextPos);
  applyLauncherPlacement(state.wrap);
}

function abortLauncherDrag(state) {
  releaseLauncherDragGuards(state);
  state.wrap.classList.remove("broom-dragging");
  document.documentElement.classList.remove("broom-launcher-dragging");
  activeLauncherDrag = null;
  applyLauncherPlacement(state.wrap);
}

function releaseLauncherDragGuards(state) {
  if (state && state._suppressSelect) {
    document.removeEventListener("selectstart", state._suppressSelect, true);
    document.removeEventListener("dragstart", state._suppressSelect, true);
    state._suppressSelect = null;
  }
  try { window.getSelection?.()?.removeAllRanges?.(); } catch { /* */ }
}

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
  const closeFan = () => {
    clearTimeout(collapseTimer);
    wrap.classList.remove("broom-fan-open");
  };

  wrap.addEventListener("mouseenter", expand);
  wrap.addEventListener("mouseleave", collapse);
  wrap.addEventListener("focusin", expand);
  wrap.addEventListener("focusout", (e) => {
    if (!wrap.contains(e.relatedTarget)) collapse();
  });

  attachLauncherDragHandlers(wrap, main, closeFan);

  // Hovering the floating broom icon dismisses the settings popover so the
  // user can click whatever's behind it without having to reach for an Esc.
  // We attach to `main` (not the wrap) so navigating into the fan chips
  // doesn't trigger a dismiss the user didn't intend.
  main.addEventListener("mouseenter", () => {
    if (document.getElementById(SETTINGS_ID)) closeSettingsPopover();
  });

  main.addEventListener("click", (e) => {
    if (launcherDragJustEnded) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    main.classList.remove("squash");
    void main.offsetWidth;
    main.classList.add("squash");
    setTimeout(() => main.classList.remove("squash"), 360);
    hidePlantToast();
    if (activeMode) {
      stopMode();
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
      if (chip.dataset.broomOff === "true") return;
      const r = chip.getBoundingClientRect();
      spawnSparklePuff(r.left + r.width / 2, r.top + r.height / 2, 6, 50);
      wrap.classList.remove("broom-fan-open");
      if (chip.dataset.action === "settings") {
        toggleSettingsPopover();
        return;
      }
      if (document.getElementById(SETTINGS_ID)) closeSettingsPopover();
      const mode = chip.dataset.mode;
      if (activeMode === mode) stopMode();
      else startMode(mode);
    }, true);
  });

  document.documentElement.appendChild(wrap);
  applyLauncherPlacement(wrap);
  window.addEventListener("resize", debounce(() => applyLauncherPlacement(wrap), 80));
  updateLauncherForShowChanges();
  updateLauncherVisibility();
}

function updateLauncherVisibility() {
  const wrap = document.getElementById(LAUNCHER_WRAP_ID);
  if (!wrap) return;
  if (cachedPrefs.showLauncher !== false) {
    wrap.removeAttribute("data-broom-hidden");
    return;
  }
  wrap.setAttribute("data-broom-hidden", "true");
  wrap.classList.remove("broom-fan-open");
  if (document.getElementById(SETTINGS_ID)) closeSettingsPopover();
  if (activeMode) stopMode();
}

function updateLauncherForShowChanges() {
  const wrap = document.getElementById(LAUNCHER_WRAP_ID);
  if (!wrap) return;
  const off = cachedPrefs.showChanges === false;
  wrap.querySelectorAll(".broom-fan-chip[data-mode]").forEach((chip) => {
    if (off) chip.setAttribute("data-broom-off", "true");
    else chip.removeAttribute("data-broom-off");
  });
  if (off && activeMode) stopMode();
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
    <div class="bs-row">
      <span class="bs-row-label">
        Hold to pause brooming
        <span class="bs-row-hint" data-bs-suspend-hint>Lets you open menus, then keep brooming.</span>
      </span>
      <button class="bs-keycap" data-act="record-suspend-key" type="button" aria-label="Change pause-brooming key">${suspendKeyLabel(cachedPrefs.suspendKey)}</button>
    </div>
    <div class="bs-divider"></div>
    <div class="bs-blooms">
      <div class="bs-blooms-title">Blooms</div>
      <div class="bs-blooms-track" data-bs-blooms></div>
    </div>
    <div class="bs-divider"></div>
    <button class="bs-btn" data-act="reset" type="button">
      <span class="bs-btn-glyph">🗑️</span><span>Restore original</span>
    </button>
    <div class="bs-version">
      <div class="bs-version-row">
        <span class="bs-version-text">Version ${version} (${build})</span>
        <button class="bs-update-btn" data-state="idle" type="button" title="Check for updates" aria-label="Check for updates">${UPDATE_REFRESH_SVG}</button>
      </div>
      <div class="bs-update-status" aria-live="polite"></div>
    </div>
  `;
  document.documentElement.appendChild(pop);
  positionSettingsPopover(pop);

  pop.querySelector('input[data-pref="soundEnabled"]').addEventListener("change", async (e) => {
    const enabled = !!e.currentTarget.checked;
    await setPref("soundEnabled", enabled);
    if (enabled) playBroomSound();
  });

  pop.querySelector('input[data-pref="showChanges"]').addEventListener("change", async (e) => {
    const enabled = !!e.currentTarget.checked;
    await setPref("showChanges", enabled);
    updateLauncherForShowChanges();
    if (enabled) {
      for (const r of appliedRules) applyRule(r);
    } else {
      for (const r of appliedRules) removeRule(r.id);
    }
  });

  const keycap = pop.querySelector('[data-act="record-suspend-key"]');
  const suspendHint = pop.querySelector("[data-bs-suspend-hint]");
  const defaultHintText = suspendHint ? suspendHint.textContent : "";
  const RECORDING_HINT_TEXT = "Select a letter key for this action.";
  keycap.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (suspendKeyRecorder) { suspendKeyRecorder.cancel(); return; }
    keycap.classList.add("is-recording");
    keycap.textContent = "…";
    if (suspendHint) suspendHint.textContent = RECORDING_HINT_TEXT;
    suspendKeyRecorder = {
      commit: async (code) => {
        suspendKeyRecorder = null;
        await setPref("suspendKey", code);
        if (keycap.isConnected) {
          keycap.classList.remove("is-recording");
          keycap.textContent = suspendKeyLabel(code);
        }
        if (suspendHint && suspendHint.isConnected) suspendHint.textContent = defaultHintText;
      },
      cancel: () => {
        suspendKeyRecorder = null;
        if (keycap.isConnected) {
          keycap.classList.remove("is-recording");
          keycap.textContent = suspendKeyLabel(cachedPrefs.suspendKey);
        }
        if (suspendHint && suspendHint.isConnected) suspendHint.textContent = defaultHintText;
      }
    };
  });

  // Blooms carousel — render initial state and wire click delegation so the
  // Default card, each custom pack, the trailing + button, and the per-card
  // delete affordance all funnel through one handler.
  renderBloomsCarousel();
  const bloomsTrack = pop.querySelector("[data-bs-blooms]");
  bloomsTrack.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const exportBtn = e.target.closest('[data-act="export-pack"]');
    if (exportBtn) {
      exportPackAsBroompack(exportBtn.dataset.packId);
      return;
    }
    const deleteBtn = e.target.closest('[data-act="delete-pack"]');
    if (deleteBtn) {
      const id = deleteBtn.dataset.packId;
      const pack = customPacksIndex.find((p) => p.id === id);
      if (!pack) return;
      if (!confirm(`Remove the "${pack.name}" pack? Any blooms you've already planted from this pack will be removed too.`)) return;
      await deleteCustomPack(id);
      renderBloomsCarousel();
      return;
    }
    const card = e.target.closest(".bs-bloom-card");
    if (!card) return;
    if (card.dataset.act === "add-pack") {
      openBloomUploadModal();
      return;
    }
    const packId = card.dataset.packId;
    const next = packId === "__default__" ? null : packId;
    if (cachedPrefs.activePackId === next) return;
    await setPref("activePackId", next);
    renderBloomsCarousel();
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

  const updateBtn = pop.querySelector(".bs-update-btn");
  updateBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const state = updateBtn.dataset.state;
    if (state === "checking") return;
    if (state === "available") {
      window.open(BROOM_DOWNLOAD_URL, "_blank", "noopener,noreferrer");
      return;
    }
    setUpdateButtonState(updateBtn, "checking");
    const resp = await requestUpdateCheck();
    if (!updateBtn.isConnected) return;
    if (!resp || !resp.ok) {
      setUpdateButtonState(updateBtn, "error", { message: resp && resp.error });
      return;
    }
    const latest = resp.data && resp.data.latestVersion;
    if (!latest) {
      setUpdateButtonState(updateBtn, "error", { message: "Couldn't read update manifest" });
      return;
    }
    if (compareSemver(latest, version) > 0) {
      setUpdateButtonState(updateBtn, "available", { latest });
    } else {
      setUpdateButtonState(updateBtn, "uptodate");
    }
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
  // Don't treat clicks inside the bloom-upload modal as "outside" — the modal
  // is a sibling of the popover but conceptually part of the same UI.
  if (e.target.closest && e.target.closest(`#${BLOOM_MODAL_ID}`)) return;
  closeSettingsPopover();
}

function onSettingsKeydown(e) {
  // While the bloom modal is open, its own Esc handler takes over.
  if (document.getElementById(BLOOM_MODAL_ID)) return;
  if (e.key === "Escape") closeSettingsPopover();
}

function closeSettingsPopover() {
  document.removeEventListener("click", onSettingsOutsideClick, true);
  document.removeEventListener("keydown", onSettingsKeydown, true);
  // Drop any in-flight suspend-key recorder so the next keystroke isn't
  // swallowed into a popover that no longer exists.
  if (suspendKeyRecorder) suspendKeyRecorder.cancel();
  closeBloomUploadModal();
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
    void trackEvent("sweep");
    void trackSiteSavedIfNew(location.hostname);
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
    void trackEvent("sweep");
    void trackSiteSavedIfNew(location.hostname);
    return;
  }

  playBroomSound();

  // Hide the cursor follower for the duration of the sweep — the sweep broom
  // takes over visually so the user perceives one broom doing the work.
  // Ref-counted so overlapping sweeps don't leave the follower stuck hidden.
  hideBroomCursorForSweep();

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
  void trackEvent("sweep");
  void trackSiteSavedIfNew(location.hostname);

  broomSession.push(rule);
  showUndoToast([rule]);

  // Cleanup overlay; restore element styles in case the rule was rejected.
  overlay.remove();
  if (el.isConnected) el.style.animation = prevAnim;
  showBroomCursorAfterSweep();
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

  playBroomSound();
  ensurePickerStyles();
  const rect = slotEl.getBoundingClientRect();
  const tooSmall = rect.width < 8 || rect.height < 8;
  const offscreen = rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth;
  if (tooSmall || offscreen) {
    await cleanup();
    return;
  }

  hideBroomCursorForSweep();

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
  showBroomCursorAfterSweep();
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

  // iOS Safari only synthesizes `click` on tap for non-interactive elements
  // when their cursor is `pointer`; the shovel data-URL cursor here doesn't
  // qualify, so a tap on the slot never fires click. Pointer events bypass
  // that heuristic and work uniformly across mouse, pen, and touch — guard
  // against the follow-up synth click with a tiny timestamp dedup.
  let lastActivate = 0;
  const activate = (e) => {
    const now = performance.now();
    if (now - lastActivate < 300) return;
    lastActivate = now;
    e.preventDefault();
    e.stopPropagation();
    void onEmptySlotClick(hideRule, slot, e);
  };
  slot.addEventListener("pointerup", (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    activate(e);
  });
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
  void trackEvent("plant_added");
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
    <button class="but-close" data-act="close" type="button" aria-label="Close">×</button>
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

  toast.querySelector('[data-act="close"]').addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    hideUndoToast();
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
    <button class="bpt-close" data-act="close" type="button" aria-label="Close">×</button>
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

  toast.querySelector('[data-act="close"]').addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
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

// ── First-run touch hint ────────────────────────────────────────────────────
// Hold-to-aim isn't discoverable (a plain tap does nothing in broom mode), so
// the card keeps reappearing on entering broom mode until the user either
// taps "Got it" or completes their first touch sweep.

const TOUCH_HINT_SEEN_KEY = "touchHintSeen";
let touchHintSeen = null; // null = not loaded yet

async function maybeShowTouchHint() {
  if (touchHintSeen === null) {
    try {
      const r = await chrome.storage.local.get(TOUCH_HINT_SEEN_KEY);
      touchHintSeen = !!r[TOUCH_HINT_SEEN_KEY];
    } catch { touchHintSeen = false; }
  }
  if (touchHintSeen || activeMode !== "broom") return;
  if (document.getElementById(TOUCH_HINT_ID)) return;

  const card = document.createElement("div");
  card.id = TOUCH_HINT_ID;
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "How to sweep");
  card.innerHTML = `
    <span class="bth-title">🧹 How to sweep</span>
    <span class="bth-step"><span class="bth-num">1</span><span>Press and hold on anything you want gone.</span></span>
    <span class="bth-step"><span class="bth-num">2</span><span>Slide to aim. The highlight sits just above your finger.</span></span>
    <span class="bth-step"><span class="bth-num">3</span><span>Lift your finger to sweep it away.</span></span>
    <span class="bth-note">Quick swipes still scroll. Lift on empty space to cancel.</span>
    <span class="bth-actions"><button class="bth-btn" type="button">Got it</button></span>
  `;
  card.querySelector(".bth-btn").addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void markTouchHintSeen();
  });
  document.documentElement.appendChild(card);
}

async function markTouchHintSeen() {
  hideTouchHint();
  if (touchHintSeen) return;
  touchHintSeen = true;
  try { await chrome.storage.local.set({ [TOUCH_HINT_SEEN_KEY]: true }); } catch { /* best-effort */ }
}

function hideTouchHint() {
  const card = document.getElementById(TOUCH_HINT_ID);
  if (!card || card.classList.contains("bth-leaving")) return;
  card.classList.add("bth-leaving");
  setTimeout(() => card.remove(), 220);
}

// ── Replay & SPA handling ─────────────────────────────────────────────────────

let appliedRules = [];
let lastUrl = location.href;

async function init() {
  await loadPrefs();
  // Load before applying rules so existing plants referencing custom:*
  // kinds find their SVG in PLANT_SVGS and don't fall back to pothos.
  await loadAllCustomPacks();
  appliedRules = await getRulesForHost(location.hostname);
  for (const r of appliedRules) applyRule(r);

  void trackFirstInstallAndDaily();

  // Persistent UI: launcher + global keyboard handler
  ensurePickerStyles();
  const mountUI = () => {
    installLauncher();
  };
  if (document.body) mountUI();
  else document.addEventListener("DOMContentLoaded", mountUI, { once: true });
  document.addEventListener("keydown", globalKeydown, true);
  document.addEventListener("keyup", globalKeyup, true);
  // Focus/visibility safety: if the window loses focus while the suspend key
  // is held, no keyup will ever fire — without these we'd be stuck suspended.
  window.addEventListener("blur", clearSuspended);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearSuspended();
  });
  // iOS Safari doesn't reliably deliver storage.onChanged to content scripts,
  // so background tabs re-read the launcher pref when they come back into view.
  document.addEventListener("visibilitychange", async () => {
    if (document.hidden) return;
    try {
      const r = await chrome.storage.local.get(PREFS_KEY);
      cachedPrefs = { ...cachedPrefs, showLauncher: r[PREFS_KEY]?.showLauncher !== false };
    } catch { return; }
    updateLauncherVisibility();
  });

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
  if (msg?.type === "CONTENT_SET_LAUNCHER_VISIBLE") {
    cachedPrefs = { ...cachedPrefs, showLauncher: msg.visible !== false };
    updateLauncherVisibility();
    sendResponse({ type: "ACK" });
    return true;
  }
  return false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[RULES_KEY]) void refreshRules();
  if (changes[PREFS_KEY]) {
    const prevShow = cachedPrefs.showChanges !== false;
    const prevShowLauncher = cachedPrefs.showLauncher !== false;
    const prevPos = cachedPrefs.launcherPos;
    cachedPrefs = { ...DEFAULT_PREFS, ...(changes[PREFS_KEY].newValue || {}) };
    const nextShow = cachedPrefs.showChanges !== false;
    if (prevShow !== nextShow) {
      updateLauncherForShowChanges();
      if (nextShow) for (const r of appliedRules) applyRule(r);
      else for (const r of appliedRules) removeRule(r.id);
    }
    if (prevShowLauncher !== (cachedPrefs.showLauncher !== false)) updateLauncherVisibility();
    if (JSON.stringify(prevPos) !== JSON.stringify(cachedPrefs.launcherPos)) {
      applyLauncherPlacement();
    }
  }
  // Pack changes from another tab: re-sync the local mirror + registries.
  if (changes[CUSTOM_PACKS_INDEX_KEY] || Object.keys(changes).some((k) => k.startsWith(CUSTOM_PACK_PREFIX))) {
    void loadAllCustomPacks();
  }
});

// ── Utils ─────────────────────────────────────────────────────────────────────

function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ── Boot ──────────────────────────────────────────────────────────────────────

void init();
