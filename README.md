# Broom

Chrome extension (MV3). Point at any element, describe what you want changed, and the modification persists per-hostname.

## Status: v1 prototype

Implemented:
- Picker mode (overlay, hover highlight, click capture)
- `hide` rules without LLM (selector from local finder)
- `restyle` and `inject` rules via LLM (Anthropic Messages API)
- Replay at `document_start` with synchronous CSS injection (no FOUC)
- `MutationObserver` + `pushState`/`popstate` hook for SPAs
- Popup: per-hostname rule list, toggle/delete
- Options: API key, model, export/import

Not yet:
- `replace` rules (component catalog renderer)
- Healing flow (selector re-resolution after repeated failures)
- Cross-frame, Shadow DOM
- Safari packaging

## Build

```sh
npm install
npm run build      # outputs dist/
npm run watch      # dev mode
npm run typecheck
```

## Load in Chrome

1. `npm run build`
2. `chrome://extensions` → Developer mode → Load unpacked → pick `dist/`
3. Open the extension's Options page, paste your Anthropic API key.
4. Visit any site, click the toolbar icon, hit "Edit this page", click an element.

## Safari (build via Xcode)

Targets Safari 16.4+ (MV3 service worker support). The `dist/` output is the unpacked extension; convert it to an Xcode project:

```sh
npm run build
xcrun safari-web-extension-converter dist --project-location ./safari --app-name Broom --bundle-identifier com.yourname.broom
```

Open the generated Xcode project, build/run the host app, then enable the extension in **Safari → Settings → Extensions**. Grant access to "All Websites" (or per-site) since the extension uses `<all_urls>`.

Notes:
- Background script is IIFE (not ESM) so it loads on Safari without `"type": "module"`.
- LLM calls go from the background service worker to `api.anthropic.com` with the `anthropic-dangerous-direct-browser-access: true` header. Required because the request originates from a browser-extension origin.
- After changes, re-run `npm run build` and Xcode rebuild — the converter symlinks `dist/`, so most rebuilds don't need re-conversion.

## Architecture

Three layers, strict separation:

- `src/content/` — runs at `document_start`. Owns DOM. Picker, applier, replay loop. No network, no API key.
- `src/background/` — service worker. Holds API key. Makes LLM calls. Validates and persists rules.
- `src/lib/storage.ts` — `chrome.storage.local`, keyed by hostname.

Messages flow: popup → content (start picker), content → background (generate rule), background → storage → content (apply).

## Rule shape

See `src/lib/types.ts`. CSS-based rules (`hide`, `restyle`) consolidate into one `<style>` tag re-built on every change. DOM-mutation rules (`inject`) re-run when the `MutationObserver` fires.

## Notes

- `inject.html` is rendered as **plain text** in v1. Arbitrary HTML injection from an LLM is unsafe; the architecture spec calls for schema-based `replace` rules for richer content — that's the next milestone.
- The Anthropic call uses `anthropic-dangerous-direct-browser-access: true` because the worker is browser-side. Treat it as such; the key sits in `chrome.storage.local`.
- Selector validation: after the LLM returns a selector, the picker verifies it matches at least one element on the current page before persisting. Stricter "matches exactly the picked element" check is a TODO.
