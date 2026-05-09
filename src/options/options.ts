import { exportAll, getSettings, importAll, setSettings } from "../lib/storage";

const providerEl = document.getElementById("provider") as HTMLSelectElement;
const modelEl = document.getElementById("model") as HTMLInputElement;
const keyEl = document.getElementById("apiKey") as HTMLInputElement;
const statusEl = document.getElementById("status")!;
const saveBtn = document.getElementById("save") as HTMLButtonElement;
const exportBtn = document.getElementById("export") as HTMLButtonElement;
const importBtn = document.getElementById("import") as HTMLButtonElement;
const importFile = document.getElementById("importFile") as HTMLInputElement;

void load();

async function load(): Promise<void> {
  const s = await getSettings();
  providerEl.value = s.provider;
  modelEl.value = s.model;
  keyEl.value = s.apiKey;
}

saveBtn.addEventListener("click", async () => {
  await setSettings({
    provider: "anthropic",
    model: modelEl.value.trim() || "claude-sonnet-4-6",
    apiKey: keyEl.value.trim(),
  });
  flash("Saved.");
});

exportBtn.addEventListener("click", async () => {
  const json = await exportAll();
  const blob = new Blob([json], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `broom-rules-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

importBtn.addEventListener("click", () => importFile.click());
importFile.addEventListener("change", async () => {
  const f = importFile.files?.[0];
  if (!f) return;
  try {
    const text = await f.text();
    await importAll(text);
    flash("Imported.");
  } catch (e: unknown) {
    flash(`Import failed: ${e instanceof Error ? e.message : String(e)}`, true);
  }
});

function flash(msg: string, isError = false): void {
  statusEl.textContent = msg;
  statusEl.style.color = isError ? "#b00" : "#2a7a2a";
  setTimeout(() => (statusEl.textContent = ""), 2500);
}
