"""Find photos, read their capture time, and make upright JPEG previews.

macOS uses ImageIO (fast, handles every raw format). Windows uses Pillow, exifread and the
JPEG preview every camera embeds in its raw files, so it needs no native raw decoder.
"""
import base64
import io
import os
import string
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

RAW_EXTS = {".arw", ".cr2", ".cr3", ".nef", ".nrw", ".raf", ".orf", ".rw2", ".dng",
            ".pef", ".srw", ".3fr", ".iiq"}
OTHER_EXTS = {".jpg", ".jpeg", ".tif", ".tiff", ".heic", ".heif", ".png"}
PHOTO_EXTS = RAW_EXTS | OTHER_EXTS

MAC = sys.platform == "darwin" and os.environ.get("PRESETPICKER_BACKEND") != "portable"


def is_raw(path):
    return Path(path).suffix.lower() in RAW_EXTS


def in_cloud(path):
    """True for iCloud / OneDrive placeholders: reading them triggers a download."""
    st = os.stat(path)
    if sys.platform == "darwin":
        return bool(getattr(st, "st_flags", 0) & 0x40000000)        # SF_DATALESS
    # RECALL_ON_DATA_ACCESS | RECALL_ON_OPEN | OFFLINE
    return bool(getattr(st, "st_file_attributes", 0) & (0x400000 | 0x40000 | 0x1000))


def _mtime(path):
    return datetime.fromtimestamp(os.stat(path).st_mtime)


# ------------------------------------------------------------------- macOS ---

if MAC:
    from Foundation import NSMutableData, NSURL
    from Quartz import (
        CGImageDestinationAddImage, CGImageDestinationCreateWithData, CGImageDestinationFinalize,
        CGImageSourceCopyPropertiesAtIndex, CGImageSourceCreateThumbnailAtIndex,
        CGImageSourceCreateWithURL, kCGImageDestinationLossyCompressionQuality,
        kCGImagePropertyExifDateTimeOriginal, kCGImagePropertyExifDictionary,
        kCGImageSourceCreateThumbnailFromImageIfAbsent, kCGImageSourceCreateThumbnailWithTransform,
        kCGImageSourceThumbnailMaxPixelSize,
    )

    def _source(path):
        return CGImageSourceCreateWithURL(NSURL.fileURLWithPath_(str(path)), None)

    def _exif_date(path):
        src = _source(path)
        if src is None:
            return None
        props = CGImageSourceCopyPropertiesAtIndex(src, 0, None) or {}
        return (props.get(kCGImagePropertyExifDictionary) or {}).get(kCGImagePropertyExifDateTimeOriginal)

    def _jpeg(path, max_px, quality):
        src = _source(path)
        if src is None:
            return None
        img = CGImageSourceCreateThumbnailAtIndex(src, 0, {
            kCGImageSourceCreateThumbnailFromImageIfAbsent: True,
            kCGImageSourceCreateThumbnailWithTransform: True,
            kCGImageSourceThumbnailMaxPixelSize: max_px,
        })
        if img is None:
            return None
        data = NSMutableData.data()
        dest = CGImageDestinationCreateWithData(data, "public.jpeg", 1, None)
        CGImageDestinationAddImage(dest, img, {kCGImageDestinationLossyCompressionQuality: quality})
        CGImageDestinationFinalize(dest)
        return bytes(data)

# ------------------------------------------------------- Windows / portable ---

else:
    import exifread
    from PIL import Image, ImageOps

    Image.MAX_IMAGE_PIXELS = 250_000_000   # high-res cameras exceed Pillow's default guard

    try:
        from pillow_heif import register_heif_opener
        register_heif_opener()
    except ImportError:          # HEIC previews are optional
        pass

    # EXIF orientation -> PIL transpose steps
    T = Image.Transpose
    _ORIENT = {2: [T.FLIP_LEFT_RIGHT], 3: [T.ROTATE_180], 4: [T.FLIP_TOP_BOTTOM],
               5: [T.TRANSPOSE], 6: [T.ROTATE_270], 7: [T.TRANSVERSE], 8: [T.ROTATE_90]}

    def _tags(path, stop=None):
        with open(path, "rb") as f:
            return exifread.process_file(f, details=False, stop_tag=stop or "UNDEF")

    def _exif_date(path):
        try:
            tags = _tags(path, "EXIF DateTimeOriginal")
        except Exception:
            return None
        tag = tags.get("EXIF DateTimeOriginal") or tags.get("Image DateTime")
        return str(tag) if tag else None

    def _embedded_preview(path):
        """Largest JPEG embedded in a raw file (every camera stores one)."""
        data = Path(path).read_bytes()
        best, best_area, pos = None, 0, 0
        while (pos := data.find(b"\xff\xd8\xff", pos)) != -1:
            try:
                img = Image.open(io.BytesIO(data[pos:]))
                if img.format == "JPEG" and img.width * img.height > best_area:
                    best, best_area = img, img.width * img.height
            except Exception:
                pass
            pos += 3
        return best

    def _jpeg(path, max_px, quality):
        if is_raw(path):
            img = _embedded_preview(path)
            if img is None:
                return None
            img.draft("RGB", (max_px, max_px))
            img = img.convert("RGB")
            try:
                orient = int(str(_tags(path, "Image Orientation").get("Image Orientation", 1).values[0]))
            except Exception:
                orient = 1
            for op in _ORIENT.get(orient, []):
                img = img.transpose(op)
        else:
            img = Image.open(path)
            img.draft("RGB", (max_px, max_px))
            img = ImageOps.exif_transpose(img).convert("RGB")
        img.thumbnail((max_px, max_px), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=int(quality * 100))
        return buf.getvalue()


# ------------------------------------------------------------------ public ---

def capture_time(path):
    """EXIF DateTimeOriginal, falling back to the file's modified time."""
    if in_cloud(path):
        return _mtime(path)
    stamp = _exif_date(path)
    if stamp:
        try:
            return datetime.strptime(str(stamp).strip()[:19], "%Y:%m:%d %H:%M:%S")
        except ValueError:
            pass
    return _mtime(path)


def scan(source):
    """All photos under source as [(path, capture datetime)], oldest first. Skips hidden/system dirs."""
    found = []
    for root, dirs, files in os.walk(Path(source).expanduser()):
        dirs[:] = [d for d in dirs if not d.startswith((".", "$"))]
        for name in files:
            if not name.startswith(".") and Path(name).suffix.lower() in PHOTO_EXTS:
                p = Path(root) / name
                found.append((p, capture_time(p)))
    found.sort(key=lambda x: x[1])
    return found


def shoot_days(photos):
    """[{date: 'YYYY-MM-DD', count}] newest first."""
    counts = Counter(t.strftime("%Y-%m-%d") for _, t in photos)
    return [{"date": d, "count": n} for d, n in sorted(counts.items(), reverse=True)]


def jpeg_bytes(path, max_px, quality=0.85):
    """Upright JPEG no larger than max_px on the long edge, or None if unreadable."""
    if in_cloud(path):
        return None
    try:
        return _jpeg(path, max_px, quality)
    except Exception:
        return None


def data_uri(jpeg):
    return "data:image/jpeg;base64," + base64.b64encode(jpeg).decode() if jpeg else None


def _volume_label(root):
    import ctypes
    buf = ctypes.create_unicode_buffer(261)
    ok = ctypes.windll.kernel32.GetVolumeInformationW(root, buf, 261, None, None, None, None, 0)
    return buf.value if ok and buf.value else None


def camera_cards():
    """Mounted volumes that look like camera cards (have a DCIM folder)."""
    if sys.platform == "win32":
        cards = []
        for letter in string.ascii_uppercase[3:]:          # skip A:-C:
            root = f"{letter}:\\"
            if os.path.isdir(root + "DCIM"):
                label = _volume_label(root) or "Memory card"
                cards.append({"name": f"{label} ({letter}:)", "path": root})
        return cards
    vols = Path("/Volumes")
    if not vols.is_dir():
        return []
    return [{"name": v.name, "path": str(v)} for v in sorted(vols.iterdir()) if (v / "DCIM").is_dir()]
