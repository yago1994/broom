# Broom

Safari/Chrome extension (MV3). Point at any element, sweep it away, and it sticks per-hostname.

No build step — the `public/` directory is the extension, ready to load directly.

## Status: v1 prototype

- Picker mode (overlay, hover highlight, click capture)
- `hide` rules — local and instant
- Restore hidden elements from the page overlay
- Plant decorations in swept spaces
- CSS injected at `document_start` (no FOUC for hide)
- MutationObserver + `pushState`/`popstate` for SPAs
- Popup: per-hostname rule list, toggle/delete

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
4. Use the extension popup to start editing a page

After code changes: edit files in `public/`, then ⌘R in Xcode (the converter symlinks `public/` — no re-conversion needed).

## Chrome

`chrome://extensions` → Developer mode → Load unpacked → pick `public/`

## Architecture

Three layers, no build:

| File | Runs in | Notes |
|---|---|---|
| `public/content.js` | Page context (classic script) | Picker, applier, replay, SPA hooks. No network. Self-contained — no imports. |
| `public/background.js` | Service worker | Extension lifecycle hook. |
| `public/popup.js` | Extension popup (ES module) | Rule list, toggle, delete. |
| `public/lib/storage.js` | Shared | `chrome.storage.local` helpers, keyed by hostname. |

Messages: popup → content (`CONTENT_START_PICKER`, `CONTENT_TOGGLE_MODE`).

## Notes

- Content script is a single self-contained classic script because MV3 content scripts don't support ES module imports.
