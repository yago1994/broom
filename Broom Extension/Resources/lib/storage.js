const RULES_KEY = "rules";
const SETTINGS_KEY = "settings";

export async function getRulesMap() {
  const r = await chrome.storage.local.get(RULES_KEY);
  return r[RULES_KEY] ?? {};
}

export async function getRulesForHost(hostname) {
  const map = await getRulesMap();
  return map[hostname] ?? [];
}

export async function upsertRule(rule) {
  const map = await getRulesMap();
  const list = map[rule.hostname] ?? [];
  const idx = list.findIndex((r) => r.id === rule.id);
  if (idx >= 0) list[idx] = rule;
  else list.push(rule);
  map[rule.hostname] = list;
  await chrome.storage.local.set({ [RULES_KEY]: map });
}

export async function deleteRule(hostname, ruleId) {
  const map = await getRulesMap();
  const list = map[hostname] ?? [];
  map[hostname] = list.filter((r) => r.id !== ruleId);
  await chrome.storage.local.set({ [RULES_KEY]: map });
}

export async function setRuleEnabled(hostname, ruleId, enabled) {
  const map = await getRulesMap();
  const list = map[hostname] ?? [];
  const rule = list.find((r) => r.id === ruleId);
  if (rule) {
    rule.enabled = enabled;
    await chrome.storage.local.set({ [RULES_KEY]: map });
  }
}

export async function getSettings() {
  const r = await chrome.storage.local.get(SETTINGS_KEY);
  const s = r[SETTINGS_KEY];
  return {
    provider: "anthropic",
    model: s?.model || "claude-sonnet-4-6",
    apiKey: s?.apiKey || "",
  };
}

export async function setSettings(s) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: s });
}

export async function exportAll() {
  const map = await getRulesMap();
  return JSON.stringify(map, null, 2);
}

export async function importAll(json) {
  const parsed = JSON.parse(json);
  await chrome.storage.local.set({ [RULES_KEY]: parsed });
}
