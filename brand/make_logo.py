"""Generate the $LAST token logo (paper palette, riso offset) as PNG."""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

OUT_DIR = sys.argv[1]
FONT = sys.argv[2]
S = 1024
BLUE, PAPER, INK, SKY = (0, 95, 176), (233, 225, 205), (50, 46, 37), (131, 220, 255)

img = Image.new("RGB", (S, S), BLUE)
d = ImageDraw.Draw(img)

# Riso dot screen, subtle, on the blue field.
for y in range(0, S, 18):
    for x in range((y // 18) % 2 * 9, S, 18):
        d.ellipse((x - 2, y - 2, x + 2, y + 2), fill=(10, 104, 186))

# Crown from the site's icon path (64x64 grid), scaled and centred in the upper half.
crown = [(12, 46), (9, 20), (22, 30), (32, 14), (42, 30), (55, 20), (52, 46)]
base = (12, 49, 52, 54)
k, ox, oy = 9.5, S / 2 - 32 * 9.5, 150


def pts(off):
    return [(ox + x * k + off, oy + y * k + off) for x, y in crown]


def rect(off):
    x0, y0, x1, y1 = base
    return (ox + x0 * k + off, oy + y0 * k + off, ox + x1 * k + off, oy + y1 * k + off)


for off, col in ((16, INK), (0, PAPER)):
    d.polygon(pts(off), fill=col)
    d.rectangle(rect(off), fill=col)
# Jewels on the three crown tips.
for x, y in ((9, 20), (32, 14), (55, 20)):
    cx, cy, r = ox + x * k, oy + y * k, 26
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=SKY, outline=INK, width=8)

# "$LAST" wordmark with a misregistered ink layer.
font = ImageFont.truetype(FONT, 250)
text = "$LAST"
w = d.textlength(text, font=font)
tx, ty = (S - w) / 2, 600
d.text((tx + 12, ty + 12), text, font=font, fill=INK)
d.text((tx, ty), text, font=font, fill=PAPER)

os.makedirs(OUT_DIR, exist_ok=True)
img.save(os.path.join(OUT_DIR, "last-logo-1024.png"), optimize=True)
img.resize((512, 512), Image.LANCZOS).save(os.path.join(OUT_DIR, "last-logo-512.png"), optimize=True)
print("ok")
