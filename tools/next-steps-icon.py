"""Draw the next-steps icon: a deep blue rounded tile with three suggestion rows,
the first marked as added, and a forward chevron. 1024x1024 PNG, drawn at 4x and
downsampled for smooth edges.

Usage: uv run --no-project --with pillow python -I tools/next-steps-icon.py .claude-plugin/icon.png"""
import sys

from PIL import Image, ImageDraw

OUT = sys.argv[1]
S = 4  # supersampling factor
W = 1024 * S

BG = (37, 56, 168)  # deep blue
ROW = (255, 255, 255)
DIM = (255, 255, 255, 120)
ACCENT = (122, 230, 170)  # green check for the added row

img = Image.new('RGBA', (W, W), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([0, 0, W - 1, W - 1], radius=220 * S, fill=BG)

overlay = Image.new('RGBA', (W, W), (0, 0, 0, 0))
o = ImageDraw.Draw(overlay)

# Three rows: a dot (or check) then a bar, like the suggestion list.
rows = [(300, 520, True), (500, 440, False), (700, 360, False)]
for y, length, added in rows:
    cx, cy, r = 250 * S, y * S, 46 * S
    if added:
        o.ellipse([cx - r, cy - r, cx + r, cy + r], fill=ACCENT)
        o.line(
            [(cx - 22 * S, cy + 2 * S), (cx - 6 * S, cy + 18 * S), (cx + 24 * S, cy - 16 * S)],
            fill=BG, width=12 * S, joint='curve',
        )
    else:
        o.ellipse([cx - r, cy - r, cx + r, cy + r], outline=ROW, width=12 * S)
    x0 = 340 * S
    o.rounded_rectangle([x0, cy - 30 * S, x0 + length * S, cy + 30 * S], radius=30 * S,
                        fill=ROW if added else DIM)

# Forward chevron on the right, level with the middle row.
cy = 500 * S
o.line([(800 * S, cy - 90 * S), (880 * S, cy), (800 * S, cy + 90 * S)], fill=ROW, width=40 * S,
       joint='curve')
for x, y in [(800, cy / S - 90), (880, cy / S), (800, cy / S + 90)]:
    o.ellipse([(x - 20) * S, (y - 20) * S, (x + 20) * S, (y + 20) * S], fill=ROW)

img = Image.alpha_composite(img, overlay)
img = img.resize((1024, 1024), Image.LANCZOS)
img.save(OUT, optimize=True)
print(OUT, img.size)
