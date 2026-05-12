# Broom — Chrome & Firefox extension

Cross-browser (Chrome + Firefox) port of the Safari Web Extension under [../Broom Extension/](../Broom%20Extension/). Same JS/HTML/CSS, different manifest.

## Build

```sh
bash build.sh
```

This produces:

- `dist/chrome/` — load in Chrome at `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick this folder.
- `dist/firefox/` — run with `web-ext run -s dist/firefox/`, or load at `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick `dist/firefox/manifest.json`.

Firefox requires version **121+** (MV3 `service_worker` support).

## Layout

```
src/                    shared source (background, content, popup, lib/, assets)
manifest.chrome.json    Chrome manifest
manifest.firefox.json   Firefox manifest (adds browser_specific_settings)
build.sh                copies src/ + the matching manifest into dist/<browser>/
```

## Keeping in sync with the Safari extension

The files under `src/` are duplicated from `Broom Extension/Resources/`. When you change extension logic, update both trees. The two extensions share no build pipeline today.
