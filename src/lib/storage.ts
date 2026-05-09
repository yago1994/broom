import type { Rule, Settings } from "./types";

const RULES_KEY = "rules"; // { [hostname]: Rule[] }
const SETTINGS_KEY = "settings";

type RulesMap = Record<string, Rule[]>;

export async function getRulesMap(): Promise<RulesMap> {
  const r = await chrome.storage.local.get(RULES_KEY);
  return (r[RULES_KEY] as RulesMap) ?? {};
}

export async function getRulesForHost(hostname: string): Promise<Rule[]> {
  const map = await getRulesMap();
  return map[hostname] ?? [];
}

export async function upsertRule(rule: Rule): Promise<void> {
  const map = await getRulesMap();
  const list = map[rule.hostname] ?? [];
  const idx = list.findIndex((r) => r.id === rule.id);
  if (idx >= 0) list[idx] = rule;
  else list.push(rule);
  map[rule.hostname] = list;
  await chrome.storage.local.set({ [RULES_KEY]: map });
}

export async function deleteRule(hostname: string, ruleId: string): Promise<void> {
  const map = await getRulesMap();
  const list = map[hostname] ?? [];
  map[hostname] = list.filter((r) => r.id !== ruleId);
  await chrome.storage.local.set({ [RULES_KEY]: map });
}

export async function setRuleEnabled(hostname: string, ruleId: string, enabled: boolean): Promise<void> {
  const map = await getRulesMap();
  const list = map[hostname] ?? [];
  const r = list.find((x) => x.id === ruleId);
  if (r) {
    r.enabled = enabled;
    await chrome.storage.local.set({ [RULES_KEY]: map });
  }
}

export async function getSettings(): Promise<Settings> {
  const r = await chrome.storage.local.get(SETTINGS_KEY);
  const s = r[SETTINGS_KEY] as Partial<Settings> | undefined;
  return {
    provider: "anthropic",
    model: s?.model || "claude-sonnet-4-6",
    apiKey: s?.apiKey || "",
  };
}

export async function setSettings(s: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: s });
}

export async function exportAll(): Promise<string> {
  const map = await getRulesMap();
  return JSON.stringify(map, null, 2);
}

export async function importAll(json: string): Promise<void> {
  const parsed = JSON.parse(json) as RulesMap;
  await chrome.storage.local.set({ [RULES_KEY]: parsed });
}
