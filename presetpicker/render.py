"""Approximate a Lightroom preset on a preview image, for the before/after view only.

This is not Adobe's engine: it covers the common Basic, Tone Curve, HSL, Color Grading,
Effects and Detail sliders closely enough to judge a look. Exported files keep the
exact preset settings, so Lightroom always renders the real result.
"""
import io

import numpy as np
from PIL import Image, ImageFilter

# Lightroom HSL bands: centre hue in degrees.
HSL_BANDS = {"Red": 0, "Orange": 30, "Yellow": 60, "Green": 120,
             "Aqua": 180, "Blue": 225, "Purple": 270, "Magenta": 315}


def _f(s, key, default=0.0):
    try:
        return float(s.get(key, default))
    except (TypeError, ValueError):
        return default


def _luma(img):
    return img[..., 0] * 0.2126 + img[..., 1] * 0.7152 + img[..., 2] * 0.0722


def _rgb_to_hsv(rgb):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx, mn = rgb.max(-1), rgb.min(-1)
    d = mx - mn
    h = np.zeros_like(mx)
    m = d > 1e-6
    rm, gm, bm = m & (mx == r), m & (mx == g) & (mx != r), m & (mx == b) & (mx != r) & (mx != g)
    h[rm] = ((g - b)[rm] / d[rm]) % 6
    h[gm] = (b - r)[gm] / d[gm] + 2
    h[bm] = (r - g)[bm] / d[bm] + 4
    s = np.where(mx > 1e-6, d / np.maximum(mx, 1e-6), 0)
    return np.stack([h * 60, s, mx], -1)


def _hsv_to_rgb(hsv):
    h, s, v = hsv[..., 0] % 360 / 60, hsv[..., 1], hsv[..., 2]
    i = np.floor(h).astype(int) % 6
    f = h - np.floor(h)
    p, q, t = v * (1 - s), v * (1 - s * f), v * (1 - s * (1 - f))
    choices = [(v, t, p), (q, v, p), (p, v, t), (p, q, v), (t, p, v), (v, p, q)]
    out = np.zeros(hsv.shape)
    for k, (r, g, b) in enumerate(choices):
        sel = i == k
        out[..., 0][sel], out[..., 1][sel], out[..., 2][sel] = r[sel], g[sel], b[sel]
    return out


def _hue_rgb(hue):
    return _hsv_to_rgb(np.array([[hue, 1.0, 1.0]]))[0]


def _blur(img, radius):
    pil = Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8))
    return np.asarray(pil.filter(ImageFilter.GaussianBlur(radius)), dtype=np.float32) / 255


def _curve(points):
    pts = sorted(points)
    xs, ys = np.array([p[0] for p in pts]) / 255, np.array([p[1] for p in pts]) / 255
    return lambda x: np.interp(x, xs, ys)


def apply_preset(image, s):
    """image: PIL RGB. s: settings from presets.read_settings. Returns a new PIL image."""
    img = np.asarray(image.convert("RGB"), dtype=np.float32) / 255
    h, w = img.shape[:2]
    scale = max(h, w) / 1600

    # Exposure, in linear light.
    ev = _f(s, "Exposure2012")
    if ev:
        img = np.clip((img ** 2.2) * 2 ** ev, 0, 1) ** (1 / 2.2)

    # Contrast: an S-curve around mid grey.
    c = _f(s, "Contrast2012") / 100
    if c:
        img = img + c * 1.3 * img * (1 - img) * (2 * img - 1)

    # Highlights / Shadows / Whites / Blacks via luminance masks.
    L = _luma(img)[..., None]
    for key, mask, k in (("Highlights2012", np.clip((L - 0.5) * 2, 0, 1) ** 1.5, 0.25),
                         ("Shadows2012", np.clip((0.5 - L) * 2, 0, 1) ** 1.5, 0.25),
                         ("Whites2012", np.clip((L - 0.75) * 4, 0, 1), 0.2),
                         ("Blacks2012", np.clip((0.25 - L) * 4, 0, 1), 0.2)):
        amt = _f(s, key) / 100
        if amt:
            img = img + amt * k * mask

    # Tone curves: master, then per channel.
    if len(s.get("ToneCurvePV2012", [])) > 2:
        img = _curve(s["ToneCurvePV2012"])(np.clip(img, 0, 1))
    for i, ch in enumerate(("Red", "Green", "Blue")):
        pts = s.get(f"ToneCurvePV2012{ch}", [])
        if len(pts) > 2:
            img[..., i] = _curve(pts)(np.clip(img[..., i], 0, 1))

    # Texture (fine detail) and Clarity (midtone local contrast).
    img = np.clip(img, 0, 1)
    tex = _f(s, "Texture") / 100
    if tex:
        img = img + tex * 0.8 * (img - _blur(img, 2 * scale))
    clar = _f(s, "Clarity2012") / 100
    if clar:
        L = _luma(img)[..., None]
        img = img + clar * 0.6 * (img - _blur(img, 25 * scale)) * (4 * L * (1 - L))
    dehaze = _f(s, "Dehaze") / 100
    if dehaze:
        img = (img - 0.5) * (1 + dehaze * 0.4) + 0.5 - dehaze * 0.04

    # HSL per colour band, plus Vibrance / Saturation.
    hsv = _rgb_to_hsv(np.clip(img, 0, 1))
    hue, sat = hsv[..., 0], hsv[..., 1]
    hue_out, sat_mul, lum_mul = hue.copy(), np.ones_like(sat), np.ones_like(sat)
    for band, centre in HSL_BANDS.items():
        dh, ds, dl = (_f(s, f"{k}Adjustment{band}") / 100 for k in ("Hue", "Saturation", "Luminance"))
        if not (dh or ds or dl):
            continue
        dist = np.abs((hue - centre + 180) % 360 - 180)
        wgt = np.clip(1 - dist / 40, 0, 1)
        hue_out += wgt * dh * 30
        sat_mul *= 1 + wgt * ds
        lum_mul *= 1 + wgt * dl * 0.35 * np.clip(sat * 2, 0, 1)
    vib, satu = _f(s, "Vibrance") / 100, _f(s, "Saturation") / 100
    sat_mul *= (1 + satu) * (1 + vib * (1 - sat))
    hsv[..., 0], hsv[..., 1] = hue_out, np.clip(sat * sat_mul, 0, 1)
    hsv[..., 2] = hsv[..., 2] * lum_mul
    img = _hsv_to_rgb(hsv)

    # Colour grading / split toning: tint shadows, midtones, highlights.
    L = _luma(np.clip(img, 0, 1))[..., None]
    blend = 0.5 + _f(s, "ColorGradeBlending", 50) / 200
    zones = {"Shadow": np.clip(1 - L / blend, 0, 1) ** 1.5,
             "Midtone": 4 * L * (1 - L),
             "Highlight": np.clip((L - (1 - blend)) / blend, 0, 1) ** 1.5,
             "Global": np.ones_like(L)}
    tints = [(z, _f(s, f"ColorGrade{z}Hue"), _f(s, f"ColorGrade{z}Sat")) for z in zones]
    tints += [("Shadow", _f(s, "SplitToningShadowHue"), _f(s, "SplitToningShadowSaturation")),
              ("Highlight", _f(s, "SplitToningHighlightHue"), _f(s, "SplitToningHighlightSaturation"))]
    for zone, hue_deg, amt in tints:
        if amt:
            tint = _hue_rgb(hue_deg)
            img = img + zones[zone] * (amt / 100) * 0.18 * (tint - tint.mean())

    # Post-crop vignette.
    vig = _f(s, "PostCropVignetteAmount") / 100
    if vig:
        yy, xx = np.mgrid[0:h, 0:w]
        r = np.sqrt(((xx - w / 2) / (w / 2)) ** 2 + ((yy - h / 2) / (h / 2)) ** 2) / np.sqrt(2)
        mid = _f(s, "PostCropVignetteMidpoint", 50) / 100
        fall = np.clip((r - mid * 0.6) / (1 - mid * 0.6), 0, 1) ** 2
        img = img * (1 + vig * 0.8 * fall)[..., None] if vig < 0 else img + vig * fall[..., None] * (1 - img)

    # Grain (fixed seed so the preview doesn't flicker).
    grain = _f(s, "GrainAmount") / 100
    if grain:
        rng = np.random.default_rng(7)
        noise = rng.normal(0, 1, (h, w)).astype(np.float32)
        size = 0.5 + _f(s, "GrainSize", 25) / 50 * scale
        noise = np.asarray(Image.fromarray(((noise * 40) + 128).clip(0, 255).astype(np.uint8))
                           .filter(ImageFilter.GaussianBlur(size)), dtype=np.float32) / 128 - 1
        img = img + noise[..., None] * grain * 0.12

    return Image.fromarray((np.clip(img, 0, 1) * 255 + 0.5).astype(np.uint8))


def to_jpeg(image, quality=88):
    buf = io.BytesIO()
    image.save(buf, "JPEG", quality=quality)
    return buf.getvalue()
