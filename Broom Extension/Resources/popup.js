import { deleteRule, getRulesForHost, setRuleEnabled } from "./lib/storage.js";

const hostEl = document.getElementById("host");
const rulesEl = document.getElementById("rules");
const pickBtn = document.getElementById("pick");
const restoreBtn = document.getElementById("restore-toggle");

render();

pickBtn.addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "CONTENT_START_PICKER" }).catch(() => {
    alert("Broom can't run on this page.");
  });
  window.close();
});

restoreBtn.addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "CONTENT_TOGGLE_MODE", mode: "restore" }).catch(() => {
    alert("Broom can't run on this page.");
  });
  window.close();
});

async function render() {
  const tab = await getActiveTab();
  const url = safeUrl(tab?.url);
  const hostname = url?.hostname || "(no host)";
  hostEl.textContent = hostname;

  const rules = url ? await getRulesForHost(hostname) : [];
  rulesEl.innerHTML = "";
  if (!rules.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.innerHTML = `<div class="empty-icon">🧹</div><div>Nothing swept yet.</div><div class="empty-hint">Click <em>Edit this page</em> or use the floating broom.</div>`;
    rulesEl.appendChild(empty);
    return;
  }
  for (const r of rules) rulesEl.appendChild(renderRule(r, hostname, tab?.id));
}

function renderRule(r, hostname, tabId) {
  const li = document.createElement("li");
  if (r.failCount >= 3) li.classList.add("rule-broken");

  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.checked = r.enabled;
  toggle.title = "Enable/disable";
  toggle.addEventListener("change", async () => {
    await setRuleEnabled(hostname, r.id, toggle.checked);
    if (tabId) chrome.tabs.sendMessage(tabId, { type: "CONTENT_APPLY_RULE", rule: { ...r, enabled: toggle.checked } }).catch(() => {});
  });

  const meta = document.createElement("div");
  meta.className = "rule-meta";
  const badge = document.createElement("span");
  badge.className = "rule-type";
  badge.textContent = r.type;
  const sel = document.createElement("div");
  sel.className = "rule-sel";
  sel.textContent = r.selector.primary;
  meta.append(badge, sel);

  const del = document.createElement("button");
  del.className = "icon-btn";
  del.textContent = "✕";
  del.title = "Delete rule";
  del.addEventListener("click", async () => {
    li.classList.add("rule-leaving");
    await new Promise((r) => setTimeout(r, 220));
    await deleteRule(hostname, r.id);
    if (tabId) chrome.tabs.sendMessage(tabId, { type: "CONTENT_REMOVE_RULE", ruleId: r.id }).catch(() => {});
    render();
  });

  li.append(toggle, meta, del);
  return li;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function safeUrl(s) {
  try { return new URL(s); } catch { return null; }
}
