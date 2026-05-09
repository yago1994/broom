import { getSettings, upsertRule } from "../lib/storage";
import { generateRule } from "./llm";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "BG_GENERATE_RULE") {
    void (async () => {
      try {
        const settings = await getSettings();
        const rule = await generateRule(
          {
            hostname: msg.hostname,
            ruleType: msg.ruleType,
            instruction: msg.instruction,
            element: msg.element,
          },
          settings,
        );
        await upsertRule(rule);
        sendResponse({ type: "BG_GENERATE_RULE_RESULT", ok: true, rule });
      } catch (e: unknown) {
        const error = e instanceof Error ? e.message : String(e);
        sendResponse({ type: "BG_GENERATE_RULE_RESULT", ok: false, error });
      }
    })();
    return true; // keep channel open for async response
  }
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  console.log("[broom] installed");
});
