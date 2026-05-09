import { deleteRule, getRulesForHost, setRuleEnabled } from "../lib/storage";
import type { Rule } from "../lib/types";

const hostEl = document.getElementById("host")!;
const rulesEl = document.getElementById("rules") as HTMLUListElement;
const pickBtn = document.getElementById("pick") as HTMLButtonElement;
const optionsBtn = document.getElementById("options") as HTMLButtonElement;

void render();

pickBtn.addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  await chrome.tabs.sendMessage(tab.id, { type: "CONTENT_START_PICKER" }).catch(() => {
    // Likely a chrome:// or web store page where content scripts can't run.
    alert("Broom can't run on this page.");
  });
  window.close();
});

optionsBtn.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

async function render(): Promise<void> {
  const tab = await getActiveTab();
  const url = tab?.url ? safeUrl(tab.url) : null;
  const hostname = url?.hostname || "(no host)";
  hostEl.textContent = hostname;

  const rules = url ? await getRulesForHost(hostname) : [];
  rulesEl.innerHTML = "";
  if (rules.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No rules yet for this site.";
    rulesEl.appendChild(empty);
    return;
  }
  for (const r of rules) rulesEl.appendChild(renderRule(r, hostname, tab?.id));
}

function renderRule(r: Rule, hostname: string, tabId: number | undefined): HTMLLIElement {
  const li = document.createElement("li");
  if (r.failCount >= 3) li.classList.add("rule-broken");

  const meta = document.createElement("div");
  meta.className = "rule-meta";
  const typeSpan = document.createElement("span");
  typeSpan.className = "rule-type";
  typeSpan.textContent = r.type;
  const sel = document.createElement("div");
  sel.className = "rule-sel";
  sel.textContent = r.selector.primary;
  meta.appendChild(typeSpan);
  meta.appendChild(sel);

  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.checked = r.enabled;
  toggle.title = "Enable/disable";
  toggle.addEventListener("change", async () => {
    await setRuleEnabled(hostname, r.id, toggle.checked);
    if (tabId) await chrome.tabs.sendMessage(tabId, { type: "CONTENT_APPLY_RULE", rule: { ...r, enabled: toggle.checked } }).catch(() => {});
  });

  const del = document.createElement("button");
  del.className = "icon-btn";
  del.textContent = "✕";
  del.title = "Delete rule";
  del.addEventListener("click", async () => {
    await deleteRule(hostname, r.id);
    if (tabId) await chrome.tabs.sendMessage(tabId, { type: "CONTENT_REMOVE_RULE", ruleId: r.id }).catch(() => {});
    void render();
  });

  li.appendChild(toggle);
  li.appendChild(meta);
  li.appendChild(del);
  return li;
}

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function safeUrl(s: string): URL | null {
  try { return new URL(s); } catch { return null; }
}
