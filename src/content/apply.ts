import type { Rule } from "../lib/types";

const STYLE_ID = "broom-rules-style";
const INJECTED_ATTR = "data-broom-injected";

// Hide and restyle rules turn into one consolidated <style> block, injected
// at document_start to prevent flash. Inject and replace are deferred until
// the selector resolves.

interface RuleStyleEntry {
  id: string;
  css: string;
}

const styleCache = new Map<string, RuleStyleEntry>(); // ruleId -> entry

export function rebuildStyleTag(): void {
  const css = Array.from(styleCache.values())
    .map((e) => `/* ${e.id} */\n${e.css}`)
    .join("\n\n");
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = STYLE_ID;
    (document.head || document.documentElement).appendChild(style);
  }
  style.textContent = css;
}

export function applyRule(rule: Rule): void {
  if (!rule.enabled) {
    removeRule(rule.id);
    return;
  }
  switch (rule.payload.kind) {
    case "hide":
      styleCache.set(rule.id, {
        id: rule.id,
        css: `${rule.selector.primary} { display: none !important; }`,
      });
      rebuildStyleTag();
      return;
    case "restyle":
      styleCache.set(rule.id, {
        id: rule.id,
        css: scopeCss(rule.selector.primary, rule.payload.css),
      });
      rebuildStyleTag();
      return;
    case "inject":
      applyInject(rule);
      return;
    case "replace":
      // TODO: implement replace via component catalog.
      console.warn("[broom] replace rules not yet implemented", rule.id);
      return;
  }
}

export function removeRule(ruleId: string): void {
  styleCache.delete(ruleId);
  rebuildStyleTag();
  document
    .querySelectorAll(`[${INJECTED_ATTR}="${cssEscapeAttr(ruleId)}"]`)
    .forEach((n) => n.remove());
}

function applyInject(rule: Rule): void {
  if (rule.payload.kind !== "inject") return;
  const anchor = resolveSelector(rule.selector.primary, rule.selector.fallbacks);
  if (!anchor) return;

  // Idempotency: if we already injected for this rule near this anchor, skip.
  const existing = document.querySelector(`[${INJECTED_ATTR}="${cssEscapeAttr(rule.id)}"]`);
  if (existing) return;

  const wrapper = document.createElement("div");
  wrapper.setAttribute(INJECTED_ATTR, rule.id);
  // Sanitize: only set as text. HTML injection is unsafe; the spec calls for
  // schema-based replace for that case. We treat `inject.html` as plain text
  // for v1 to be safe. (Future: sanitize via DOMPurify or use schema too.)
  wrapper.textContent = rule.payload.html;

  const pos = rule.payload.position;
  if (pos === "before") anchor.parentNode?.insertBefore(wrapper, anchor);
  else if (pos === "after") anchor.parentNode?.insertBefore(wrapper, anchor.nextSibling);
  else if (pos === "prepend") anchor.insertBefore(wrapper, anchor.firstChild);
  else if (pos === "append") anchor.appendChild(wrapper);
}

export function resolveSelector(primary: string, fallbacks: string[] = []): Element | null {
  for (const sel of [primary, ...fallbacks]) {
    if (!sel) continue;
    try {
      const el = document.querySelector(sel);
      if (el) return el;
    } catch {
      // ignore invalid selector
    }
  }
  return null;
}

// Scope user-supplied CSS by prefixing each rule with the selector. Naive but
// adequate for v1: handles flat declarations and rule blocks.
function scopeCss(selector: string, css: string): string {
  const trimmed = css.trim();
  if (!trimmed) return "";
  // If user wrote raw declarations (no `{`), wrap once.
  if (!trimmed.includes("{")) {
    return `${selector} { ${trimmed} }`;
  }
  // Otherwise prefix each rule's selector list.
  return trimmed.replace(/(^|\})([^{}]+)\{/g, (_m, pre: string, sel: string) => {
    const prefixed = sel
      .split(",")
      .map((s) => `${selector} ${s.trim()}`.trim())
      .join(", ");
    return `${pre}${prefixed} {`;
  });
}

function cssEscapeAttr(s: string): string {
  return s.replace(/"/g, '\\"');
}
