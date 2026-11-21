"""Read Lightroom .xmp presets and turn them into per-photo XMP sidecars."""
import copy
import xml.etree.ElementTree as ET
from pathlib import Path

NS = {
    "x": "adobe:ns:meta/",
    "rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "crs": "http://ns.adobe.com/camera-raw-settings/1.0/",
}
for _prefix, _uri in NS.items():
    ET.register_namespace(_prefix, _uri)
CRS = "{%s}" % NS["crs"]
RDF = "{%s}" % NS["rdf"]

DEFAULT_DIRS = [
    "~/Library/Application Support/Adobe/Lightroom/Develop Presets/User Presets",
    "~/Library/Application Support/Adobe/CameraRaw/Settings",
    "~/AppData/Roaming/Adobe/Lightroom/Develop Presets/User Presets",
    "~/AppData/Roaming/Adobe/CameraRaw/Settings",
]

# Preset bookkeeping that must not end up in a photo's develop settings.
SKIP = {
    "Name", "ShortName", "SortName", "Group", "Description", "UUID", "Cluster", "PresetType",
    "SupportsAmount", "SupportsAmount2", "SupportsColor", "SupportsMonochrome",
    "SupportsHighDynamicRange", "SupportsNormalDynamicRange",
    "SupportsSceneReferred", "SupportsOutputReferred", "RequiresRGBTables",
    "CameraModelRestriction", "Copyright", "ContactInfo", "ShowInPresets",
    "ShowInQuickActions", "CompatibleVersion", "IncrementalTemperature",
    "IncrementalTint", "WhiteBalance",
}


def _description(path):
    return next(ET.parse(path).getroot().iter(RDF + "Description"))


def _localized(desc, field):
    """A field stored as an attribute or as an rdf:Alt list (how Lightroom exports names)."""
    if desc.get(CRS + field):
        return desc.get(CRS + field)
    el = desc.find(CRS + field)
    if el is not None:
        li = el.find(f".//{RDF}li")
        if li is not None and (li.text or "").strip():
            return li.text.strip()
    return None


def find_preset_dir():
    for d in DEFAULT_DIRS:
        p = Path(d).expanduser()
        if p.is_dir() and any(p.rglob("*.xmp")):
            return str(p)
    return None


def load_presets(folder):
    """Return [{id, name, group}] for every .xmp preset under folder. id is the file path."""
    if not folder or not Path(folder).is_dir():
        return []
    presets = []
    for p in sorted(Path(folder).rglob("*.xmp")):
        try:
            desc = _description(p)
        except (ET.ParseError, StopIteration, OSError):
            continue
        presets.append({
            "id": str(p),
            "name": _localized(desc, "Name") or p.stem,
            "group": _localized(desc, "Group") or (p.parent.name if p.parent != Path(folder) else ""),
        })
    presets.sort(key=lambda x: (x["group"].lower(), x["name"].lower()))
    return presets


def read_settings(path):
    """Develop settings as {name: value-string}, plus tone curves as {name: [(x, y), ...]}."""
    desc = _description(path)
    values = {k[len(CRS):]: v for k, v in desc.attrib.items() if k.startswith(CRS)}
    for child in desc:
        if child.tag.startswith(CRS + "ToneCurvePV2012"):
            pts = []
            for li in child.iter(RDF + "li"):
                try:
                    x, y = (int(n) for n in li.text.split(","))
                    pts.append((x, y))
                except (ValueError, AttributeError):
                    pass
            values[child.tag[len(CRS):]] = pts
    return values


def build_sidecar(preset_path):
    """XMP sidecar (bytes) that carries the preset's develop settings onto a raw photo."""
    desc = _description(preset_path)

    root = ET.Element("{%s}xmpmeta" % NS["x"])
    rdf = ET.SubElement(root, RDF + "RDF")
    out = ET.SubElement(rdf, RDF + "Description", {RDF + "about": ""})

    for key, val in desc.attrib.items():
        name = key[len(CRS):]
        if not key.startswith(CRS) or name in SKIP:
            continue
        # "Embedded" only exists for JPEG/HEIC; on a raw file Lightroom would have no profile.
        if name in ("CameraProfile", "CameraProfileDigest") and desc.get(CRS + "CameraProfile") == "Embedded":
            continue
        out.set(key, val)
    out.set(CRS + "HasSettings", "True")
    out.set(CRS + "AlreadyApplied", "True")
    for child in desc:  # tone curves, point colors, masks, ...
        if child.tag.startswith(CRS) and child.tag[len(CRS):] not in SKIP:
            out.append(copy.deepcopy(child))

    ET.indent(root)
    return (b'<?xpacket begin="\xef\xbb\xbf" id="W5M0MpCehiHzreSzNTczkc9d"?>\n'
            + ET.tostring(root, encoding="utf-8") + b'\n<?xpacket end="w"?>\n')


# Short darkroom-style label for the UI, e.g. "EXP −0.18 · CON +45 · TEX +19".
_SUMMARY = [("Exposure2012", "EXP", 2), ("Contrast2012", "CON", 0), ("Highlights2012", "HL", 0),
            ("Shadows2012", "SH", 0), ("Whites2012", "WH", 0), ("Blacks2012", "BL", 0),
            ("Texture", "TEX", 0), ("Clarity2012", "CLR", 0), ("Dehaze", "DHZ", 0),
            ("Vibrance", "VIB", 0), ("Saturation", "SAT", 0), ("GrainAmount", "GRAIN", 0),
            ("PostCropVignetteAmount", "VIG", 0)]


def summary(settings, limit=7):
    parts = []
    if settings.get("Temperature"):
        parts.append(f"TEMP {settings['Temperature']}K")
    for key, label, digits in _SUMMARY:
        try:
            v = float(settings.get(key, 0))
        except (TypeError, ValueError):
            continue
        if v:
            text = f"{abs(v):.{digits}f}"
            sign = "" if key == "GrainAmount" else ("+" if v > 0 else "−")
            parts.append(f"{label} {sign}{text}")
    return " · ".join(parts[:limit])
