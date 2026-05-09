# Broom

Safari/Chrome extension (MV3). Point at any element, describe what you want changed, and it sticks per-hostname.

No build step — the `public/` directory is the extension, ready to load directly.

## Status: v1 prototype

- Picker mode (overlay, hover highlight, click capture)
- `hide` rules — no LLM, instant
- `restyle` and `inject` rules via Anthropic Claude
- CSS injected at `document_start` (no FOUC for hide/restyle)
- MutationObserver + `pushState`/`popstate` for SPAs
- Popup: per-hostname rule list, toggle/delete
- Options: API key, model, export/import rules

Not yet: `replace` component catalog, healing flow, cross-frame/Shadow DOM.

## Safari — build in Xcode

Targets Safari 16.4+ (MV3 service worker support).

```sh
xcrun safari-web-extension-converter public \
  --project-location ./safari \
  --app-name Broom \
  --bundle-identifier com.yourname.broom \
  --mac-only
```

Open `safari/Broom/Broom.xcodeproj` in Xcode:
1. Select the **Broom (macOS)** scheme → press **▶ Run**
2. A host app window opens — this is expected
3. Go to **Safari → Settings → Extensions**, enable **Broom**, set access to **All Websites**
4. Open the extension's **Options** page and paste your Anthropic API key

After code changes: edit files in `public/`, then ⌘R in Xcode (the converter symlinks `public/` — no re-conversion needed).

## Chrome

`chrome://extensions` → Developer mode → Load unpacked → pick `public/`

## Architecture

Three layers, no build:

| File | Runs in | Notes |
|---|---|---|
| `public/content.js` | Page context (classic script) | Picker, applier, replay, SPA hooks. No network, no API key. Self-contained — no imports. |
| `public/background.js` | Service worker (ES module) | Holds API key. Makes LLM calls. Imports `lib/`. |
| `public/popup.js` | Extension popup (ES module) | Rule list, toggle, delete. |
| `public/options.js` | Options page (ES module) | API key, export/import. |
| `public/lib/storage.js` | Shared | `chrome.storage.local` helpers, keyed by hostname. |

Messages: popup → content (`CONTENT_START_PICKER`), content → background (`BG_GENERATE_RULE`), background persists and returns the rule.

## Notes

- Background uses `anthropic-dangerous-direct-browser-access: true` — required for any browser-extension origin hitting the Anthropic API directly.
- `inject` payload is rendered as **plain text** for safety. Arbitrary HTML from an LLM is unsafe; schema-based `replace` rules (next milestone) handle richer content.
- Content script is a single self-contained classic script because MV3 content scripts don't support ES module imports.
