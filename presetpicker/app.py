"""Native window (pywebview) and the Python API its JavaScript calls."""
import io
import json
import os
import shutil
import subprocess
import sys
import threading
from collections import OrderedDict
from datetime import datetime
from pathlib import Path

import webview
from PIL import Image

from . import APP_NAME, __version__, photos, presets, render

UI = Path(__file__).parent / "ui" / "index.html"
if sys.platform == "win32":
    SETTINGS_FILE = Path(os.environ.get("APPDATA", Path.home())) / APP_NAME / "settings.json"
else:
    SETTINGS_FILE = Path("~/Library/Application Support").expanduser() / APP_NAME / "settings.json"
DEFAULTS = {"source": "", "presets": "", "output": str(Path("~/Desktop").expanduser())}


class LRU(OrderedDict):
    def __init__(self, size):
        super().__init__()
        self.size = size

    def put(self, key, value):
        self[key] = value
        self.move_to_end(key)
        while len(self) > self.size:
            self.popitem(last=False)
        return value


class Api:
    """Every public method is callable from JS as window.pywebview.api.<name>(...)."""

    def __init__(self):
        self._window = None
        self._lock = threading.Lock()
        self._settings = self._load_settings()
        self._scans = {}            # source path -> [(Path, datetime)]
        self._photos = []           # photos currently shown in the grid
        self._thumbs = {}
        self._thumb_bases = LRU(400)  # i -> small PIL image, for instant preset previews
        self._looks = LRU(600)        # (i, preset id) -> small rendered data URI
        self._bases = LRU(6)        # i -> PIL preview image
        self._renders = LRU(24)     # (i, preset id) -> data URI
        self._preset_settings = {}

    # ------------------------------------------------------------ settings ---

    def _load_settings(self):
        s = dict(DEFAULTS)
        try:
            s.update(json.loads(SETTINGS_FILE.read_text()))
        except (OSError, ValueError):
            pass
        if not s["presets"]:
            s["presets"] = presets.find_preset_dir() or ""
        return s

    def _save_settings(self):
        SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
        SETTINGS_FILE.write_text(json.dumps(self._settings, indent=2))

    def init(self):
        return {
            "version": __version__,
            "platform": sys.platform,
            "settings": self._settings,
            "cards": photos.camera_cards(),
            "presets": self.load_presets(),
        }

    def cards(self):
        return photos.camera_cards()

    def set_setting(self, key, value):
        if key in DEFAULTS:
            self._settings[key] = value
            self._save_settings()
        return self._settings

    def choose_folder(self, key):
        """Folder picker for 'source', 'presets' or 'output'. Returns the new settings or None."""
        start = self._settings.get(key) or str(Path.home())
        kind = getattr(getattr(webview, "FileDialog", None), "FOLDER", None) or webview.FOLDER_DIALOG
        picked = self._window.create_file_dialog(kind, directory=start)
        if not picked:
            return None
        return self.set_setting(key, picked[0] if isinstance(picked, (list, tuple)) else picked)

    def load_presets(self):
        found = presets.load_presets(self._settings["presets"])
        for p in found:
            p["settings"] = presets.summary(self._settings_for(p["id"]))
        return found

    def _settings_for(self, preset_id):
        if preset_id not in self._preset_settings:
            self._preset_settings[preset_id] = presets.read_settings(preset_id)
        return self._preset_settings[preset_id]

    # -------------------------------------------------------------- photos ---

    def scan_source(self, source, rescan=False):
        """Shoot days for a source folder/card: {total, days: [{date, count}]}."""
        if not source or not Path(source).is_dir():
            return {"total": 0, "days": [], "error": "Folder not found"}
        self.set_setting("source", source)
        if rescan or source not in self._scans:
            self._scans[source] = photos.scan(source)
        found = self._scans[source]
        return {"total": len(found), "days": photos.shoot_days(found)}

    def load_photos(self, source, start, end):
        """Photos taken between start and end (YYYY-MM-DD, inclusive) for the grid."""
        if source not in self._scans:
            self.scan_source(source)
        lo = datetime.fromisoformat(start) if start else datetime.min
        hi = datetime.fromisoformat(end).replace(hour=23, minute=59, second=59) if end else datetime.max
        with self._lock:
            self._photos = [p for p, t in self._scans[source] if lo <= t <= hi]
            times = {p: t for p, t in self._scans[source]}
            self._thumbs.clear()
            self._thumb_bases.clear()
            self._looks.clear()
            self._bases.clear()
            self._renders.clear()
        return [{"i": i, "name": p.name, "path": str(p), "raw": photos.is_raw(p), "cloud": photos.in_cloud(p),
                 "ext": p.suffix.upper().lstrip("."), "time": times[p].strftime("%d.%m.%Y %H:%M")}
                for i, p in enumerate(self._photos)]

    def thumb(self, i):
        if i not in self._thumbs:
            jpeg = photos.jpeg_bytes(self._photos[i], 520, 0.8)
            if jpeg:
                self._thumb_bases.put(i, Image.open(io.BytesIO(jpeg)).convert("RGB"))
            self._thumbs[i] = photos.data_uri(jpeg)
        return self._thumbs[i]

    def look(self, i, preset_id):
        """Small preview of photo i with a preset, fast enough for hovering through presets."""
        key = (i, preset_id)
        if key not in self._looks:
            base = self._thumb_bases.get(i)
            if base is None:
                self.thumb(i)
                base = self._thumb_bases.get(i)
            if base is None:
                return None
            out = render.apply_preset(base, self._settings_for(preset_id))
            self._looks.put(key, photos.data_uri(render.to_jpeg(out, 84)))
        return self._looks[key]

    def preview(self, i, preset_id=None):
        """{before, after} data URIs for the large view. after is an approximate render."""
        base = self._bases.get(i)
        if base is None:
            jpeg = photos.jpeg_bytes(self._photos[i], 1600, 0.9)
            if not jpeg:
                return {"error": "This photo is only in iCloud. Download it in Finder to preview it."}
            base = self._bases.put(i, Image.open(io.BytesIO(jpeg)).convert("RGB"))
        before = photos.data_uri(render.to_jpeg(base))
        if not preset_id:
            return {"before": before, "after": before, "settings": ""}
        settings = self._settings_for(preset_id)
        key = (i, preset_id)
        if key not in self._renders:
            out = render.apply_preset(base, settings)
            self._renders.put(key, photos.data_uri(render.to_jpeg(out)))
        return {"before": before, "after": self._renders[key], "settings": presets.summary(settings)}

    # -------------------------------------------------------------- export ---

    def export(self, choices):
        """choices: {index: preset id}. Copies each photo + writes its .xmp sidecar."""
        picked = {int(i): pid for i, pid in choices.items() if pid}
        if not picked:
            return {"error": "No presets chosen"}
        out_dir = Path(self._settings["output"]) / f"{APP_NAME} {datetime.now():%Y-%m-%d %H.%M.%S}"
        out_dir.mkdir(parents=True)
        sidecars = {}
        raw = other = 0
        for i, pid in sorted(picked.items()):
            src = self._photos[i]
            dest = out_dir / src.name
            n = 1
            while dest.exists():
                dest = out_dir / f"{src.stem}_{n}{src.suffix}"
                n += 1
            shutil.copy2(src, dest)
            if pid not in sidecars:
                sidecars[pid] = presets.build_sidecar(pid)
            dest.with_suffix(".xmp").write_bytes(sidecars[pid])
            if photos.is_raw(src):
                raw += 1
            else:
                other += 1
        return {"folder": str(out_dir), "raw": raw, "other": other}

    def reveal(self, path):
        if sys.platform == "win32":
            os.startfile(path)
        else:
            subprocess.run(["open", path])


def main():
    api = Api()
    window = webview.create_window(
        APP_NAME, url=str(UI), js_api=api, width=1320, height=860,
        min_size=(900, 620), text_select=False,
    )
    api._window = window
    webview.start(debug=bool(os.environ.get("PRESETPICKER_DEBUG")))
