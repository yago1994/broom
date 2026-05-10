// Broom background service worker.
"use strict";

chrome.runtime.onInstalled.addListener(() => {
  console.log("[broom] installed");
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "OPEN_ACTION_POPUP") {
    try {
      const p = chrome.action.openPopup?.();
      if (p && typeof p.then === "function") {
        p.then(() => sendResponse({ ok: true }))
         .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
        return true;
      }
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
    return false;
  }
  return false;
});