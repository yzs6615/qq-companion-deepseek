"""礼物抠图：百炼画的“白底上一个东西” → 透明底 PNG（摆进她房间用）。
python scene/gift.py raw.png out.png
从四边往里灌：跟边上的白差不多的颜色都当背景，抠掉；边缘收一像素再羽化一点，免得留白边。裁到东西的大小，最长边不超过 640。
最后一行打印 {"ok": true} 或 {"ok": false, "why": ...}（抠出来太小 / 几乎没抠掉，都算失败）。
"""
import json
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter

MARK = (255, 0, 255)


def main():
    src, out = sys.argv[1], sys.argv[2]
    im = Image.open(src).convert('RGB')
    w, h = im.size
    flood = im.copy()
    seeds = [(x, y) for x in (0, w // 4, w // 2, 3 * w // 4, w - 1) for y in (0, h - 1)] + [(x, y) for x in (0, w - 1) for y in (h // 4, h // 2, 3 * h // 4)]
    for p in seeds:
        r, g, b = flood.getpixel(p)
        if min(r, g, b) >= 200 and (r, g, b) != MARK:   # 只从发白的边往里灌
            ImageDraw.floodfill(flood, p, MARK, thresh=42)
    bgmask = ImageChops.difference(flood, Image.new('RGB', im.size, MARK)).convert('L').point(lambda v: 255 if v < 8 else 0)
    alpha = ImageChops.invert(bgmask).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.9))
    box = alpha.point(lambda v: 255 if v > 40 else 0).getbbox()
    if not box:
        return print(json.dumps({'ok': False, 'why': '全抠没了'}))
    area = (box[2] - box[0]) * (box[3] - box[1]) / (w * h)
    kept = alpha.point(lambda v: 255 if v > 128 else 0).histogram()[255] / (w * h)
    if area < 0.03 or kept > 0.9:
        return print(json.dumps({'ok': False, 'why': f'抠得不对（框 {area:.2f}，留下 {kept:.2f}）'}))
    rgba = im.convert('RGBA')
    rgba.putalpha(alpha)
    rgba = rgba.crop(box)
    k = 640 / max(rgba.size)
    if k < 1:
        rgba = rgba.resize((max(1, int(rgba.width * k)), max(1, int(rgba.height * k))), Image.LANCZOS)
    rgba.save(out)
    print(json.dumps({'ok': True, 'out': out, 'size': rgba.size}))


if __name__ == '__main__':
    main()
