// Broom background service worker.
"use strict";

const BROOM_UPDATE_MANIFEST_URL = "https://yagoarconada.com/apps/broom_files/app-update.json";

chrome.runtime.onInstalled.addListener(() => {
  console.log("[broom] installed");
});

// Content scripts can't reliably do cross-origin fetches across browsers,
// so we proxy the update check through the background service worker.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "broom:checkUpdate") return false;
  fetch(BROOM_UPDATE_MANIFEST_URL, { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true; // keep the message channel open for async sendResponse
});
