#!/usr/bin/env python3
"""把 GIF 拆成多帧，拼成一张带帧号的 contact sheet，方便模型“看”动图。

用法：python images/gif_sheet.py in.gif out.png [maxFrames]
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageSequence


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: gif_sheet.py in.gif out.png [maxFrames]", file=sys.stderr)
        return 1
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    limit = int(sys.argv[3]) if len(sys.argv) > 3 else 9

    im = Image.open(src)
    frames = []
    for frame in ImageSequence.Iterator(im):
        frames.append(frame.convert("RGB"))
        if len(frames) >= 64:
            break
    if not frames:
        print("no frames", file=sys.stderr)
        return 2
    if len(frames) > limit:
        step = max(1, len(frames) // limit)
        frames = frames[::step][:limit]

    w, h = frames[0].size
    scale = min(1.0, 320.0 / max(w, h))
    tw, th = max(1, int(w * scale)), max(1, int(h * scale))
    cols = 3 if len(frames) > 4 else 2
    rows = (len(frames) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * tw, rows * th), "white")
    draw = ImageDraw.Draw(sheet)
    for i, frame in enumerate(frames):
        sheet.paste(frame.resize((tw, th)), ((i % cols) * tw, (i // cols) * th))
        draw.rectangle([(i % cols) * tw, (i // cols) * th, (i % cols) * tw + 18, (i // cols) * th + 14], fill="black")
        draw.text(((i % cols) * tw + 3, (i // cols) * th + 1), str(i + 1), fill="white")
    dst.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(dst)
    print(dst)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
