# Preset Picker

A small app for Windows and macOS for choosing a Lightroom preset for each photo straight off your camera card.

**Download:** see the [Releases](../../releases/latest) page: Windows (x64; also runs on Windows 11 ARM PCs through emulation) and macOS (Apple Silicon).

1. **Setup.** Pick a camera card (detected when inserted) or folder, a shoot day or date range, and your folder of `.xmp` presets.
2. **Pick.** Browse the shoot as a grid and choose a preset per photo, or select several and apply one to all. Double-click a photo (or press Space) for a large before/after preview with a draggable split.
3. **Export.** Each chosen photo is copied to a new folder with an `.xmp` sidecar holding its preset. Import that folder into Lightroom and raw files open with the preset applied.

The before/after preview is an approximation for judging a look. Exports carry the exact preset settings, so Lightroom renders the real result. Lightroom only reads sidecars for **raw** files (NEF, CR3, ARW, DNG…); for JPEG/HEIC, apply the preset inside Lightroom.

## Run from source

```bash
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
./.venv/bin/python main.py
```

Set `PRESETPICKER_DEBUG=1` to open the web inspector.

## Build the app

macOS (Apple Silicon):

```bash
./build.sh            # -> dist/Preset Picker.app
./build.sh --install  # also copies it to /Applications
```

Windows (x64):

```powershell
py -m pip install -r requirements.txt pyinstaller
py tools\make_icon.py
py -m PyInstaller preset_picker.spec --noconfirm   # -> dist\Preset Picker\Preset Picker.exe
```

## Releases

`.github/workflows/build.yml` builds both versions on GitHub. Push a tag (`git tag v1.0.1 && git push --tags`) to publish a release; the website in `site/` (published by `pages.yml`) always links to the latest one.

## Keyboard

| Key | Grid | Large preview |
| --- | --- | --- |
| Space | open preview of last clicked photo | |
| ⌘A / Esc | select all / clear selection | Esc closes |
| ← → | | previous / next photo |
| B or \\ | | toggle before |

## Layout

- `presetpicker/app.py`: window and the Python API the UI calls
- `presetpicker/photos.py`: scanning, capture dates, previews (ImageIO on macOS; Pillow + exifread on Windows)
- `presetpicker/presets.py`: reading presets, writing sidecars
- `presetpicker/render.py`: approximate preset preview
- `presetpicker/ui/`: HTML/CSS/JS interface
- `site/`: the download website
