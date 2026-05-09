import { exportAll, getSettings, importAll, setSettings } from "./lib/storage.js";

const providerEl = document.getElementById("provider");
const modelEl = document.getElementById("model");
const keyEl = document.getElementById("apiKey");
const statusEl = document.getElementById("status");
const importFile = document.getElementById("importFile");

load();

async function load() {
  const s = await getSettings();
  providerEl.value = s.provider;
  modelEl.value = s.model;
  keyEl.value = s.apiKey;
}

document.getElementById("save").addEventListener("click", async () => {
  await setSettings({
    provider: "anthropic",
    model: modelEl.value.trim() || "claude-sonnet-4-6",
    apiKey: keyEl.value.trim(),
  });
  flash("Saved.");
});

document.getElementById("export").addEventListener("click", async () => {
  const json = await exportAll();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  a.download = `broom-rules-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

document.getElementById("import").addEventListener("click", () => importFile.click());
importFile.addEventListener("change", async () => {
  const f = importFile.files?.[0];
  if (!f) return;
  try {
    await importAll(await f.text());
    flash("Imported.");
  } catch (e) {
    flash(`Import failed: ${e.message}`, true);
  }
});

function flash(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.style.color = isError ? "#b00" : "#2a7a2a";
  setTimeout(() => (statusEl.textContent = ""), 2500);
}
