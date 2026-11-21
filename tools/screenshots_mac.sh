#!/bin/bash
# Walk through installing the app on a clean Mac (as if downloaded from the web) and screenshot each step.
# Usage (CI): tools/screenshots_mac.sh PresetPicker-macOS-AppleSilicon.zip shots
set -u
ZIP="$1"; OUT="$2"
mkdir -p "$OUT"

# Run a command but give up after N seconds: Gatekeeper and permission prompts can block forever.
limit() { local t=$1; shift; "$@" & local pid=$!; ( sleep "$t"; kill -9 "$pid" 2>/dev/null ) & local w=$!; wait "$pid" 2>/dev/null; kill "$w" 2>/dev/null; return 0; }
shot() { sleep "${2:-4}"; limit 20 screencapture -x "$OUT/$1.png"; echo "shot $1"; }
mark() { xattr -w com.apple.quarantine "0083;$(printf %x "$(date +%s)");Safari;$(uuidgen)" "$1"; }

DL="$HOME/Downloads"
mkdir -p "$DL"
cp "$ZIP" "$DL/"
mark "$DL/$(basename "$ZIP")"                   # as Safari/Chrome mark a download
ditto -x -k "$DL/$(basename "$ZIP")" "$DL"      # what double-clicking the zip does
APP="$DL/Preset Picker.app"
mark "$APP"

# 1. The unzipped app in Finder, ready to drag to Applications.
limit 20 osascript -e 'tell application "Finder"
  activate
  close every window
  set w to make new Finder window to (POSIX file "'"$DL"'" as alias)
  set current view of w to icon view
  set bounds of w to {150, 110, 830, 520}
end tell'
shot mac-1-finder 5

# 2. First open: Gatekeeper's "not opened" warning. (open waits on the dialog, so don't wait on open.)
open "$APP" &
shot mac-2-blocked 10

# 3. Click "Done", then System Settings > Privacy & Security shows "Open Anyway" near the bottom.
limit 20 osascript -e 'tell application "System Events" to tell process "CoreServicesUIAgent" to click button "Done" of window 1'
sleep 2
open "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension" &
sleep 10
limit 90 osascript -e 'tell application "System Events" to tell process "System Settings"
  set frontmost to true
  set found to 0
  repeat with x in (entire contents of window 1)
    try
      if class of x is scroll bar and orientation of x is "AXVerticalOrientation" then set value of x to 1.0
    end try
  end repeat
  delay 1
  repeat with x in (entire contents of window 1)
    try
      if class of x is button and name of x contains "Open Anyway" then
        perform action "AXScrollToVisible" of x
        set found to found + 1
      end if
    end try
  end repeat
  return "Open Anyway buttons: " & found
end tell'
shot mac-3-open-anyway 3

# 4. Clicking "Open Anyway" asks once more to confirm.
limit 90 osascript -e 'tell application "System Events" to tell process "System Settings"
  repeat with x in (entire contents of window 1)
    try
      if class of x is button and name of x contains "Open Anyway" then
        click x
        return "clicked"
      end if
    end try
  end repeat
  return "no button"
end tell'
shot mac-4-confirm 5
exit 0
