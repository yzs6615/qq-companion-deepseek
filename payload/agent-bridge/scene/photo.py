"""现场照：她房间的背景 + 她现在的动作，按时段补一点光线，拼成一张“刚拍的照片”。
python scene/photo.py in.json   in.json：{"bg": 背景图, "pose": 透明底动作图, "out": 输出 jpg, "light": morning|day|evening|night|rain-day|rain-night|snow}
最后一行打印 {"ok": true, "out": ...}。人站在画面中间偏下（背景图里那块圆地毯上），躺着的姿势放小一点。
"""
import json
import sys

from PIL import Image, ImageChops, ImageDraw, ImageEnhance, ImageFilter

S = 1024
# 光线：(颜色, 混多少, 亮度) —— 傍晚偏橙，夜里压暗偏台灯的暖光，下雨偏冷
LIGHT = {
    'evening': ((255, 190, 150), 0.30, 1.0),
    'night': ((255, 210, 150), 0.28, 0.72),
    'rain-night': ((255, 212, 165), 0.24, 0.72),
    'rain-day': ((200, 214, 240), 0.30, 0.94),
    'snow': ((228, 236, 255), 0.18, 1.0),
}


def main():
    a = json.load(open(sys.argv[1], encoding='utf-8'))
    bg = Image.open(a['bg']).convert('RGB').resize((S, S), Image.LANCZOS).convert('RGBA')
    fig = Image.open(a['pose']).convert('RGBA')
    box = fig.getchannel('A').point(lambda v: 255 if v > 24 else 0).getbbox()
    if box:
        fig = fig.crop(box)
    lying = fig.width > fig.height * 1.15
    h = int(S * (0.34 if lying else 0.56))
    w = max(1, int(fig.width * h / max(1, fig.height)))
    if w > S * 0.66:
        w = int(S * 0.66)
        h = max(1, int(fig.height * w / max(1, fig.width)))
    fig = fig.resize((w, h), Image.LANCZOS)
    light = LIGHT.get(a.get('light'))
    if light:
        col, k, bright = light
        alpha = fig.getchannel('A')
        rgb = fig.convert('RGB')
        rgb = Image.blend(rgb, ImageChops.multiply(rgb, Image.new('RGB', rgb.size, col)), k * 2 if k * 2 <= 1 else 1)
        rgb = ImageEnhance.Brightness(rgb).enhance(bright)
        fig = rgb.convert('RGBA')
        fig.putalpha(alpha)
    x = int(S * 0.47 - w / 2)
    foot = int(S * 0.88)
    sh = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    sw, shh = w * 0.62, max(10, h * (0.10 if lying else 0.06))
    ImageDraw.Draw(sh).ellipse([x + w / 2 - sw / 2, foot - shh / 2, x + w / 2 + sw / 2, foot + shh / 2], fill=(20, 16, 30, 95))
    bg.alpha_composite(sh.filter(ImageFilter.GaussianBlur(10)))
    bg.alpha_composite(fig, (x, foot - h + int(h * 0.02)))
    # 一点点暗角，像手机随手拍的
    vig = Image.new('L', (S, S), 0)
    ImageDraw.Draw(vig).ellipse([-S * 0.25, -S * 0.25, S * 1.25, S * 1.25], fill=255)
    vig = vig.filter(ImageFilter.GaussianBlur(120))
    dark = Image.new('RGBA', (S, S), (10, 8, 20, 70))
    dark.putalpha(ImageChops.invert(vig).point(lambda v: v * 70 // 255))
    bg.alpha_composite(dark)
    bg.convert('RGB').save(a['out'], 'JPEG', quality=88)
    print(json.dumps({'ok': True, 'out': a['out']}))


if __name__ == '__main__':
    main()
