#!/usr/bin/env bash
# Build Chrome and Firefox unpacked extension folders from the shared src/.
set -euo pipefail

cd "$(dirname "$0")"

rm -rf dist
mkdir -p dist/chrome dist/firefox

cp -R src/. dist/chrome/
cp manifest.chrome.json dist/chrome/manifest.json

cp -R src/. dist/firefox/
cp manifest.firefox.json dist/firefox/manifest.json

echo "Built:"
echo "  dist/chrome/   -> load in chrome://extensions (Developer mode → Load unpacked)"
echo "  dist/firefox/  -> web-ext run -s dist/firefox/   (or about:debugging → Load Temporary Add-on)"
