import { buildSelector } from "../lib/finder";
import type { ElementContext, Rule, RuleType } from "../lib/types";
import { uuid } from "../lib/uuid";
import { applyRule } from "./apply";

const OVERLAY_ID = "broom-picker-overlay";
const HIGHLIGHT_ID = "broom-picker-highlight";
const PANEL_ID = "broom-panel";

let active = false;
let currentTarget: Element | null = null;

export function startPicker(): void {
  if (active) return;
  active = true;
  document.documentElement.classList.add("broom-picking");
  installStyles();
  installHighlight();
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("mouseover", onOver, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
}

export function stopPicker(): void {
  if (!active) return;
  active = false;
  document.documentElement.classList.remove("broom-picking");
  document.getElementById(HIGHLIGHT_ID)?.remove();
  document.removeEventListener("mousemove", onMove, true);
  document.removeEventListener("mouseover", onOver, true);
  document.removeEventListener("click", onClick, true);
  document.removeEventListener("keydown", onKey, true);
}

function installStyles(): void {
  if (document.getElementById(OVERLAY_ID)) return;
  const s = document.createElement("style");
  s.id = OVERLAY_ID;
  s.textContent = `
    html.broom-picking, html.broom-picking * { cursor: crosshair !important; }
    #${HIGHLIGHT_ID} {
      position: fixed; pointer-events: none; z-index: 2147483646;
      border: 2px solid #2563eb; background: rgba(37,99,235,0.12);
      border-radius: 2px; transition: all 60ms ease-out;
    }
    #${PANEL_ID} {
      position: fixed; z-index: 2147483647; bottom: 16px; right: 16px;
      width: 340px; background: #fff; color: #111; border: 1px solid #ddd;
      border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.18);
      font: 13px -apple-system, system-ui, sans-serif; padding: 12px;
    }
    #${PANEL_ID} h3 { margin: 0 0 6px; font-size: 13px; font-weight: 600; }
    #${PANEL_ID} .sel { font-family: ui-monospace, monospace; font-size: 11px; color: #444; word-break: break-all; background: #f6f6f6; padding: 4px 6px; border-radius: 3px; }
    #${PANEL_ID} .row { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
    #${PANEL_ID} button { font: inherit; padding: 5px 9px; border: 1px solid #ccc; background: #f7f7f7; border-radius: 4px; cursor: pointer; }
    #${PANEL_ID} button.primary { background: #2563eb; color: #fff; border-color: #2563eb; }
    #${PANEL_ID} button[disabled] { opacity: 0.5; cursor: not-allowed; }
    #${PANEL_ID} textarea { width: 100%; box-sizing: border-box; min-height: 56px; margin-top: 8px; font: inherit; padding: 6px; border: 1px solid #ccc; border-radius: 4px; resize: vertical; }
    #${PANEL_ID} .err { color: #b00; font-size: 12px; margin-top: 6px; }
    #${PANEL_ID} .muted { color: #666; font-size: 11px; }
  `;
  document.documentElement.appendChild(s);
}

function installHighlight(): void {
  if (document.getElementById(HIGHLIGHT_ID)) return;
  const h = document.createElement("div");
  h.id = HIGHLIGHT_ID;
  document.documentElement.appendChild(h);
}

function isOurUI(el: Element | null): boolean {
  if (!el) return false;
  return !!el.closest(`#${PANEL_ID}, #${HIGHLIGHT_ID}`);
}

function onMove(e: MouseEvent): void {
  if (!active) return;
  const el = e.target as Element | null;
  if (!el || isOurUI(el)) return;
  highlight(el);
}

function onOver(e: MouseEvent): void {
  if (!active) return;
  const el = e.target as Element | null;
  if (!el || isOurUI(el)) return;
  currentTarget = el;
  highlight(el);
}

function onClick(e: MouseEvent): void {
  if (!active) return;
  const el = e.target as Element | null;
  if (isOurUI(el)) return;
  e.preventDefault();
  e.stopPropagation();
  if (!el) return;
  currentTarget = el;
  stopPicker();
  openPanel(el);
}

function onKey(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    stopPicker();
    closePanel();
  }
}

function highlight(el: Element): void {
  const h = document.getElementById(HIGHLIGHT_ID);
  if (!h) return;
  const r = el.getBoundingClientRect();
  h.style.top = `${r.top}px`;
  h.style.left = `${r.left}px`;
  h.style.width = `${r.width}px`;
  h.style.height = `${r.height}px`;
}

function openPanel(el: Element): void {
  closePanel();
  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  const selector = buildSelector(el);

  panel.innerHTML = `
    <h3>Modify this element</h3>
    <div class="sel" id="broom-sel"></div>
    <div class="row">
      <button data-type="hide" class="primary">Hide</button>
      <button data-type="restyle">Restyle…</button>
      <button data-type="inject">Inject text…</button>
      <button id="broom-cancel">Cancel</button>
    </div>
    <div id="broom-llm" style="display:none">
      <textarea id="broom-instruction" placeholder="Describe what you want…"></textarea>
      <div class="row">
        <button class="primary" id="broom-submit">Generate</button>
        <span class="muted" id="broom-status"></span>
      </div>
      <div class="err" id="broom-err"></div>
    </div>
  `;
  document.documentElement.appendChild(panel);
  panel.querySelector("#broom-sel")!.textContent = selector;

  const llmBox = panel.querySelector<HTMLDivElement>("#broom-llm")!;
  const instruction = panel.querySelector<HTMLTextAreaElement>("#broom-instruction")!;
  const status = panel.querySelector<HTMLElement>("#broom-status")!;
  const err = panel.querySelector<HTMLElement>("#broom-err")!;
  let pendingType: RuleType | null = null;

  panel.querySelectorAll<HTMLButtonElement>("button[data-type]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const t = btn.dataset.type as RuleType;
      if (t === "hide") {
        await persistAndApply(makeHideRule(el, selector));
        closePanel();
        return;
      }
      pendingType = t;
      llmBox.style.display = "block";
      instruction.focus();
    });
  });

  panel.querySelector<HTMLButtonElement>("#broom-cancel")!.addEventListener("click", closePanel);

  panel.querySelector<HTMLButtonElement>("#broom-submit")!.addEventListener("click", async () => {
    if (!pendingType) return;
    err.textContent = "";
    status.textContent = "Thinking…";
    try {
      const ctx = collectContext(el, selector);
      const res = await chrome.runtime.sendMessage({
        type: "BG_GENERATE_RULE",
        instruction: instruction.value,
        ruleType: pendingType,
        element: ctx,
        hostname: location.hostname,
      });
      if (!res?.ok) throw new Error(res?.error || "Unknown error");
      // Validate selector matches.
      const matches = safeQueryAll(res.rule.selector.primary);
      if (matches.length === 0) {
        throw new Error(`Generated selector matched 0 elements: ${res.rule.selector.primary}`);
      }
      await persistAndApply(res.rule);
      closePanel();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      err.textContent = msg;
      status.textContent = "";
    }
  });
}

function closePanel(): void {
  document.getElementById(PANEL_ID)?.remove();
}

function makeHideRule(_el: Element, selector: string): Rule {
  return {
    id: uuid(),
    hostname: location.hostname,
    type: "hide",
    selector: { primary: selector, fallbacks: [], semantic: "" },
    payload: { kind: "hide" },
    enabled: true,
    createdAt: Date.now(),
    lastAppliedAt: null,
    lastFailedAt: null,
    failCount: 0,
  };
}

async function persistAndApply(rule: Rule): Promise<void> {
  // Storage write must go through the background worker only if we want
  // strict separation; chrome.storage works fine from content though.
  const { upsertRule } = await import("../lib/storage");
  await upsertRule(rule);
  applyRule(rule);
}

function collectContext(el: Element, selectorGuess: string): ElementContext {
  const outerHTML = el.outerHTML.slice(0, 2048);
  const parent = el.parentElement;
  return {
    outerHTML,
    tagName: el.tagName.toLowerCase(),
    id: el.id || null,
    classes: Array.from(el.classList),
    selectorGuess,
    parentSelectorGuess: parent ? buildSelector(parent) : null,
    textSnippet: (el.textContent || "").trim().slice(0, 200),
  };
}

function safeQueryAll(sel: string): Element[] {
  try {
    return Array.from(document.querySelectorAll(sel));
  } catch {
    return [];
  }
}
