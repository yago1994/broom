import type { ElementContext, Rule, RuleType, Settings } from "../lib/types";
import { uuid } from "../lib/uuid";

interface GenerateInput {
  hostname: string;
  ruleType: RuleType;
  instruction: string;
  element: ElementContext;
}

// Calls Anthropic's Messages API. The content script never has the key —
// it lives only in chrome.storage.local accessed from this worker.
export async function generateRule(input: GenerateInput, settings: Settings): Promise<Rule> {
  if (!settings.apiKey) throw new Error("No API key set. Open Broom Options and add one.");

  const system = SYSTEM_PROMPT;
  const user = buildUserPrompt(input);

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
      system,
      messages: [{ role: "user", content: user }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as { content?: { type: string; text?: string }[] };
  const text = (json.content || []).map((c) => c.text || "").join("");
  const parsed = extractJson(text);
  return validateAndBuildRule(parsed, input);
}

const SYSTEM_PROMPT = `You modify webpage elements based on user requests. You output ONLY a single JSON object — no prose, no markdown fences.

Schema:
{
  "selector": { "primary": "<CSS selector>", "fallbacks": ["<alt CSS>", ...], "semantic": "<short NL description of what this element is>" },
  "payload": <one of below depending on ruleType>
}

For ruleType "hide":     payload = {}
For ruleType "restyle":  payload = { "css": "<CSS declarations only, no selectors, no braces. Example: 'background: #111; color: #fff; font-size: 18px;'>" }
For ruleType "inject":   payload = { "html": "<plain text>", "position": "before"|"after"|"prepend"|"append" }

Rules:
- "primary" must select the SPECIFIC element described, not a broad family. Prefer ids and stable classes; avoid generated/hash classes.
- Provide 1–3 fallback selectors using different strategies (different attributes, structural paths, role/aria attributes).
- Keep CSS minimal and conservative. Use !important only when needed to win specificity.
- Do not include selectors or @rules inside restyle.css — just declarations.`;

function buildUserPrompt(input: GenerateInput): string {
  return `hostname: ${input.hostname}
ruleType: ${input.ruleType}
user instruction: ${input.instruction || "(none — use ruleType default behavior)"}

picked element:
  tag: ${input.element.tagName}
  id: ${input.element.id || "(none)"}
  classes: ${input.element.classes.join(" ") || "(none)"}
  current selector guess: ${input.element.selectorGuess}
  parent selector: ${input.element.parentSelectorGuess || "(unknown)"}
  text: ${JSON.stringify(input.element.textSnippet)}

outerHTML (truncated):
${input.element.outerHTML}

Return ONLY the JSON object.`;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  // Try direct parse first.
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through.
  }
  // Strip markdown fence if present.
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch?.[1]) {
    try { return JSON.parse(fenceMatch[1]); } catch { /* */ }
  }
  // Find first {...} balanced span.
  const start = trimmed.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(trimmed.slice(start, i + 1)); } catch { /* */ }
        }
      }
    }
  }
  throw new Error("Model did not return valid JSON");
}

function validateAndBuildRule(parsed: unknown, input: GenerateInput): Rule {
  if (!isObj(parsed)) throw new Error("Response is not an object");
  const sel = parsed["selector"];
  if (!isObj(sel) || typeof sel["primary"] !== "string") {
    throw new Error("Missing selector.primary");
  }
  const fallbacks = Array.isArray(sel["fallbacks"])
    ? (sel["fallbacks"] as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  const semantic = typeof sel["semantic"] === "string" ? sel["semantic"] : "";
  const payloadIn = parsed["payload"];

  let payload: Rule["payload"];
  if (input.ruleType === "hide") {
    payload = { kind: "hide" };
  } else if (input.ruleType === "restyle") {
    if (!isObj(payloadIn) || typeof payloadIn["css"] !== "string") throw new Error("restyle.payload.css missing");
    payload = { kind: "restyle", css: payloadIn["css"] };
  } else if (input.ruleType === "inject") {
    if (!isObj(payloadIn) || typeof payloadIn["html"] !== "string" || typeof payloadIn["position"] !== "string") {
      throw new Error("inject.payload.{html,position} missing");
    }
    const pos = payloadIn["position"];
    if (pos !== "before" && pos !== "after" && pos !== "prepend" && pos !== "append") {
      throw new Error(`invalid inject position: ${pos}`);
    }
    payload = { kind: "inject", html: payloadIn["html"], position: pos };
  } else {
    throw new Error(`unsupported ruleType: ${input.ruleType}`);
  }

  return {
    id: uuid(),
    hostname: input.hostname,
    type: input.ruleType,
    selector: { primary: sel["primary"], fallbacks, semantic },
    payload,
    enabled: true,
    createdAt: Date.now(),
    lastAppliedAt: null,
    lastFailedAt: null,
    failCount: 0,
  };
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
