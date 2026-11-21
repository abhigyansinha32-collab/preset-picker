#!/bin/bash
# Walk through installing the app on a clean Mac (as if downloaded from the web) and screenshot each step.
# Usage (CI): tools/screenshots_mac.sh PresetPicker-macOS-AppleSilicon.zip shots
set -u
ZIP="$1"; OUT="$2"
mkdir -p "$OUT"
shot() { sleep "${2:-4}"; screencapture -x "$OUT/$1.png" && echo "shot $1"; }

DL="$HOME/Downloads"
mkdir -p "$DL"
cp "$ZIP" "$DL/"
# Mark the download the way Safari/Chrome do, so Gatekeeper treats it as from the internet.
xattr -w com.apple.quarantine "0083;$(printf %x "$(date +%s)");Safari;$(uuidgen)" "$DL/$(basename "$ZIP")"
ditto -x -k "$DL/$(basename "$ZIP")" "$DL"      # what double-clicking the zip does (keeps the mark)
APP="$DL/Preset Picker.app"
xattr -w com.apple.quarantine "0083;$(printf %x "$(date +%s)");Safari;$(uuidgen)" "$APP"

# 1. The unzipped app in Finder, ready to drag to Applications.
osascript -e 'tell application "Finder"
  activate
  set w to make new Finder window to (POSIX file "'"$DL"'" as alias)
  set current view of w to icon view
  set bounds of w to {200, 140, 1100, 640}
end tell' || open "$DL"
shot mac-1-finder 5

# 2. First open: Gatekeeper's "not opened" warning.
open "$APP"
shot mac-2-blocked 8

# 3. System Settings > Privacy & Security, which now offers "Open Anyway".
open "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension"
shot mac-3-privacy 8
# Scroll down to the Security section where the button is.
osascript -e 'tell application "System Events" to tell process "System Settings"
  set frontmost to true
  repeat 30 times
    key code 125
  end repeat
end tell' 2>/dev/null
osascript -e 'tell application "System Events" to scroll (scroll area 1 of group 1 of group 3 of splitter group 1 of group 1 of window 1 of process "System Settings") by 2000' 2>/dev/null
shot mac-4-open-anyway 4
