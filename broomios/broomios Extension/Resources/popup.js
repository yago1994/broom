// Kept self-contained: Xcode flattens Resources/lib/ into the bundle root on
// iOS, so relative imports like "./lib/storage.js" fail to load there.
const PREFS_KEY = "prefs";
const TOAST_MS = 4000;

const showLauncherEl = document.getElementById("show-launcher");
const toastEl = document.getElementById("toast");
let toastTimer = null;

chrome.storage.local.get(PREFS_KEY).then((r) => {
  showLauncherEl.checked = r[PREFS_KEY]?.showLauncher !== false;
});

showLauncherEl.addEventListener("change", async () => {
  const visible = showLauncherEl.checked;
  showToast(`Refresh the page to ${visible ? "show" : "hide"} the broom`);

  const r = await chrome.storage.local.get(PREFS_KEY);
  const prefs = r[PREFS_KEY] ?? {};
  await chrome.storage.local.set({ [PREFS_KEY]: { ...prefs, showLauncher: visible } });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "CONTENT_SET_LAUNCHER_VISIBLE", visible }).catch(() => {});
});

function showToast(text) {
  toastEl.textContent = text;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), TOAST_MS);
}
