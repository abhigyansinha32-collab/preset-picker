"""Draw the app icon: assets/AppIcon.png, AppIcon.ico (Windows) and, on macOS, AppIcon.icns."""
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SIZE = 1024


CHARCOAL, CREAM, AMBER, TEAL = (30, 27, 24), (243, 237, 226), (224, 164, 88), (91, 138, 140)


def draw(size=SIZE):
    """Grain & Glow mark: an amber sun glowing over a faded-teal horizon, inside a cream print
    border on charcoal, with a little film grain."""
    m = int(size * 0.1)                       # macOS icon grid margin
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32) / size

    # Photo area: charcoal sky, soft amber glow, teal hills, grain.
    img = np.ones((size, size, 3), np.float32) * np.array(CHARCOAL) / 255
    cx, cy, r = .5, .5, .17
    d = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2)
    glow = np.clip(1 - (d - r) / .22, 0, 1) ** 2.2 * (d > r)
    img = img + glow[..., None] * (np.array(AMBER) / 255 - img) * .55
    img = np.where((d <= r)[..., None], np.array(AMBER) / 255, img)
    hill = .62 + .035 * np.sin(xx * 7.5 + .6)
    img = np.where((yy > hill)[..., None], np.array(TEAL) / 255 * .78, img)
    rng = np.random.default_rng(3)
    img = img + rng.normal(0, .035, (size, size, 1))
    photo = Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8), "RGB")

    icon = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    card = Image.new("L", (size, size), 0)
    ImageDraw.Draw(card).rounded_rectangle([m, m, size - m, size - m], radius=int(size * .18), fill=255)
    icon.paste(Image.new("RGBA", (size, size), CREAM + (255,)), (0, 0), card)   # print border
    b = int(size * .055)
    window = Image.new("L", (size, size), 0)
    ImageDraw.Draw(window).rounded_rectangle([m + b, m + b, size - m - b, size - m - b],
                                             radius=int(size * .13), fill=255)
    icon.paste(photo, (0, 0), window)
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
