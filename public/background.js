import { getSettings, upsertRule } from "./lib/storage.js";
import { uuid } from "./lib/uuid.js";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "BG_GENERATE_RULE") {
    handleGenerate(msg).then(sendResponse).catch((e) => {
      sendResponse({ type: "BG_GENERATE_RULE_RESULT", ok: false, error: e.message });
    });
    return true; // keep channel open
  }
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  console.log("[broom] installed");
});

async function handleGenerate(msg) {
  const settings = await getSettings();
  const rule = await generateRule(msg, settings);
  await upsertRule(rule);
  return { type: "BG_GENERATE_RULE_RESULT", ok: true, rule };
}

async function generateRule(msg, settings) {
  if (!settings.apiKey) throw new Error("No API key — open Broom Options and add one.");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: settings.model || "claude-sonnet-4-6",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(msg) }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = await res.json();
  const text = (json.content || []).map((c) => c.text || "").join("");
  const parsed = extractJson(text);
  return buildRule(parsed, msg);
}

const SYSTEM_PROMPT = `You modify webpage elements based on user requests. Output ONLY a single JSON object — no prose, no markdown fences.

Schema:
{
  "selector": { "primary": "<CSS selector>", "fallbacks": ["<alt CSS>", ...], "semantic": "<NL description>" },
  "payload": <see below>
}

ruleType "hide":    payload = {}
ruleType "restyle": payload = { "css": "<declarations only — no selectors, no braces. E.g. 'background:#111;color:#fff'>" }
ruleType "inject":  payload = { "html": "<plain text>", "position": "before"|"after"|"prepend"|"append" }

Rules:
- primary must select the exact element, not a broad family. Prefer ids and stable classes.
- Provide 1–3 fallback selectors using different strategies.
- For restyle, css is declarations only — no selectors or @rules.`;

function buildUserPrompt(msg) {
  const { hostname, ruleType, instruction, element } = msg;
  return `hostname: ${hostname}
ruleType: ${ruleType}
instruction: ${instruction || "(none)"}

element:
  tag: ${element.tagName}
  id: ${element.id || "(none)"}
  classes: ${element.classes.join(" ") || "(none)"}
  selector guess: ${element.selectorGuess}
  parent selector: ${element.parentSelectorGuess || "(unknown)"}
  text: ${JSON.stringify(element.textSnippet)}

outerHTML (truncated):
${element.outerHTML}

Return ONLY the JSON object.`;
}

function extractJson(text) {
  const t = text.trim();
  try { return JSON.parse(t); } catch { /* */ }
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) { try { return JSON.parse(fence[1]); } catch { /* */ } }
  const start = t.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < t.length; i++) {
      if (t[i] === "{") depth++;
      else if (t[i] === "}") { depth--; if (depth === 0) { try { return JSON.parse(t.slice(start, i + 1)); } catch { /* */ } } }
    }
  }
  throw new Error("Model did not return valid JSON");
}

function buildRule(parsed, msg) {
  if (!parsed || typeof parsed !== "object") throw new Error("Response is not an object");
  const sel = parsed.selector;
  if (!sel || typeof sel.primary !== "string") throw new Error("Missing selector.primary");

  const fallbacks = Array.isArray(sel.fallbacks) ? sel.fallbacks.filter((s) => typeof s === "string") : [];
  const semantic = typeof sel.semantic === "string" ? sel.semantic : "";
  const p = parsed.payload ?? {};

  let payload;
  if (msg.ruleType === "hide") {
    payload = { kind: "hide" };
  } else if (msg.ruleType === "restyle") {
    if (typeof p.css !== "string") throw new Error("restyle payload missing css");
    payload = { kind: "restyle", css: p.css };
  } else if (msg.ruleType === "inject") {
    if (typeof p.html !== "string" || !["before","after","prepend","append"].includes(p.position)) {
      throw new Error("inject payload missing html or position");
    }
    payload = { kind: "inject", html: p.html, position: p.position };
  } else {
    throw new Error(`unsupported ruleType: ${msg.ruleType}`);
  }

  return {
    id: uuid(),
    hostname: msg.hostname,
    type: msg.ruleType,
    selector: { primary: sel.primary, fallbacks, semantic },
    payload,
    enabled: true,
    createdAt: Date.now(),
    lastAppliedAt: null,
    lastFailedAt: null,
    failCount: 0,
  };
}
