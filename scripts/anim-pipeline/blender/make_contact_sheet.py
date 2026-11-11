#!/usr/bin/env python3
"""Compose a labeled contact sheet from the Blender four-view renders.

Runs with a normal Python 3 + Pillow (not Blender's bundled Python):

    python3 scripts/anim-pipeline/blender/make_contact_sheet.py \
        --dir tests/tmp/blender-probe --out tests/tmp/blender-probe/contact-sheet.png

Layout: rest-pose four views on the top row (front / side / three-quarter / back)
and the pose before/after pairs on the second row. This is the "参考图三视图对照 +
接触表" acceptance artifact: an agent (or human) can read one image to judge whether
a pose edit in Blender is sane before exporting VPD.
"""

import argparse
import os
from PIL import Image, ImageDraw, ImageFont

PANELS = [
    ("front.png", "front (rest)"),
    ("side.png", "side (rest)"),
    ("three-quarter.png", "3/4 (rest)"),
    ("back.png", "back (rest)"),
    ("posed-front.png", "front (posed)"),
    ("posed-three-quarter.png", "3/4 (posed)"),
]


def load_font(size):
    candidates = [
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", required=True, help="directory with the PNG renders")
    parser.add_argument("--out", required=True, help="output contact sheet path")
    parser.add_argument("--cols", type=int, default=4)
    parser.add_argument("--thumb-width", type=int, default=384)
    parser.add_argument("--labels", default="", help="optional comma-separated reference image paths")
    args = parser.parse_args()

    font = load_font(22)
    label_h = 34
    panels = []
    for filename, label in PANELS:
        path = os.path.join(args.dir, filename)
        if not os.path.exists(path):
            continue
        img = Image.open(path).convert("RGB")
        ratio = args.thumb_width / img.width
        img = img.resize((args.thumb_width, int(img.height * ratio)), Image.LANCZOS)
        panels.append((img, label))
    if not panels:
        raise SystemExit("no render PNGs found in %s" % args.dir)

    cols = max(1, min(args.cols, len(panels)))
    rows = (len(panels) + cols - 1) // cols
    cell_w = args.thumb_width
    cell_h = max(p[0].height for p in panels) + label_h
    sheet = Image.new("RGB", (cols * cell_w, rows * cell_h), (24, 25, 28))
    draw = ImageDraw.Draw(sheet)

    for index, (img, label) in enumerate(panels):
        row, col = divmod(index, cols)
        x = col * cell_w
        y = row * cell_h
        sheet.paste(img, (x + (cell_w - img.width) // 2, y + label_h))
        draw.text((x + 10, y + 6), "%d. %s" % (index + 1, label), fill=(230, 230, 235), font=font)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    sheet.save(args.out)
    print("contact sheet (%dx%d, %d panels) -> %s" % (sheet.width, sheet.height, len(panels), args.out))


if __name__ == "__main__":
    main()
