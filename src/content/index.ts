import { getRulesForHost } from "../lib/storage";
import type { Rule } from "../lib/types";
import { applyRule, removeRule } from "./apply";
import { startPicker } from "./picker";

// Replay flow: at document_start, load rules for this host and inject the
// CSS-based ones synchronously (hide, restyle). Defer DOM-mutation rules
// (inject, replace) until selectors resolve via MutationObserver.

let appliedRules: Rule[] = [];
let observer: MutationObserver | null = null;
let lastUrl = location.href;

void init();

async function init(): Promise<void> {
  const hostname = location.hostname;
  appliedRules = await getRulesForHost(hostname);
  for (const rule of appliedRules) applyRule(rule);

  // Listen for re-application opportunities (DOM-dependent rules + SPA navs).
  observer = new MutationObserver(debounce(onMutate, 100));
  // Wait for body if not yet present at document_start.
  if (document.body) observer.observe(document.body, { childList: true, subtree: true });
  else document.addEventListener("DOMContentLoaded", () => {
    observer?.observe(document.body, { childList: true, subtree: true });
  });

  installSpaHooks();
}

function onMutate(): void {
  // URL change check (SPA).
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    void refreshFromStorage();
    return;
  }
  // Re-attempt DOM-dependent rules.
  for (const rule of appliedRules) {
    if (rule.payload.kind === "inject" || rule.payload.kind === "replace") applyRule(rule);
  }
}

async function refreshFromStorage(): Promise<void> {
  const fresh = await getRulesForHost(location.hostname);
  // Remove rules no longer present.
  const freshIds = new Set(fresh.map((r) => r.id));
  for (const r of appliedRules) if (!freshIds.has(r.id)) removeRule(r.id);
  appliedRules = fresh;
  for (const r of appliedRules) applyRule(r);
}

function installSpaHooks(): void {
  const fire = () => onMutate();
  const orig = history.pushState;
  history.pushState = function (...args: Parameters<typeof history.pushState>) {
    const r = orig.apply(this, args);
    queueMicrotask(fire);
    return r;
  };
  window.addEventListener("popstate", fire);
}

// Messages from popup / background.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "CONTENT_START_PICKER") {
    startPicker();
    sendResponse({ type: "ACK" });
    return true;
  }
  if (msg?.type === "CONTENT_APPLY_RULE") {
    applyRule(msg.rule);
    void refreshFromStorage();
    sendResponse({ type: "ACK" });
    return true;
  }
  if (msg?.type === "CONTENT_REMOVE_RULE") {
    removeRule(msg.ruleId);
    void refreshFromStorage();
    sendResponse({ type: "ACK" });
    return true;
  }
  return false;
});

// Storage updates (e.g., toggled from popup) → re-apply.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.rules) return;
  void refreshFromStorage();
});

function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let t: ReturnType<typeof setTimeout> | null = null;
  return ((...args: unknown[]) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  }) as T;
}
