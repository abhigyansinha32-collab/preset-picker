#!/bin/zsh
# Build "Preset Picker.app" into dist/. Usage: ./build.sh  (add --install to copy it to /Applications)
# Windows builds are made by .github/workflows/build.yml (or: pyinstaller preset_picker.spec on Windows).
set -e
cd "$(dirname "$0")"

if [[ ! -d .venv ]]; then
  python3 -m venv .venv
fi
./.venv/bin/pip install -q -r requirements.txt pyinstaller

./.venv/bin/python tools/make_icon.py
rm -rf build dist
./.venv/bin/pyinstaller preset_picker.spec --noconfirm

echo "Built: dist/Preset Picker.app"
if [[ "$1" == "--install" ]]; then
  rm -rf "/Applications/Preset Picker.app"
  cp -R "dist/Preset Picker.app" /Applications/
  echo "Installed to /Applications"
fi
