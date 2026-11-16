"""Draw the app icon: assets/AppIcon.png, AppIcon.ico (Windows) and, on macOS, AppIcon.icns."""
import colorsys
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SIZE = 1024


def draw(size=SIZE):
    # Colour wheel ring on a dark rounded square: "pick a look".
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    cx = cy = size / 2
    ang = (np.degrees(np.arctan2(yy - cy, xx - cx)) + 200) % 360 / 360
    rgb = np.array([colorsys.hsv_to_rgb(h, 0.72, 1.0) for h in np.linspace(0, 1, 361)])
    wheel = (rgb[(ang * 360).astype(int)] * 255).astype(np.uint8)
    ring = Image.fromarray(wheel, "RGB")

    icon = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    m = int(size * 0.1)
    bg = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(bg).rounded_rectangle([m, m, size - m, size - m], radius=int(size * 0.18), fill=(28, 28, 32, 255))
    icon.alpha_composite(bg)

    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    r_out, r_in = size * 0.31, size * 0.17
    d.ellipse([cx - r_out, cy - r_out, cx + r_out, cy + r_out], fill=255)
    d.ellipse([cx - r_in, cy - r_in, cx + r_in, cy + r_in], fill=0)
    icon.paste(ring, (0, 0), mask)
    return icon


def main():
    out = ROOT / "assets"
    out.mkdir(exist_ok=True)
    base = draw()
    base.save(out / "AppIcon.png")
    base.save(out / "AppIcon.ico", sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])
    if sys.platform != "darwin":   # iconutil only exists on macOS
        return
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "AppIcon.iconset"
        iconset.mkdir()
        for px in (16, 32, 128, 256, 512):
            base.resize((px, px), Image.LANCZOS).save(iconset / f"icon_{px}x{px}.png")
            base.resize((px * 2, px * 2), Image.LANCZOS).save(iconset / f"icon_{px}x{px}@2x.png")
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(out / "AppIcon.icns")], check=True)
    print("wrote", out / "AppIcon.icns")


if __name__ == "__main__":
    main()
