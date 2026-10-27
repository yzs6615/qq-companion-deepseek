"""现场照：她房间的背景 + 她现在的动作，按时段补一点光线，拼成一张“刚拍的照片”。
python scene/photo.py in.json   in.json：{"bg": 背景图, "pose": 透明底动作图, "out": 输出 jpg, "light": morning|day|evening|night|rain-day|rain-night|snow,
  "gifts": [对方送的东西，透明底 png，最新的在前，最多 3 件]}
最后一行打印 {"ok": true, "out": ...}。人站在画面中间偏下（背景图里那块圆地毯上），躺着的姿势放小一点。
礼物摆在前景的地上：左下角、右下角、地毯右边（离得远一点，小一点），先摆礼物再摆人，挡住了也是人在前面。
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


# 礼物摆哪：(底边中点 x, 底边 y, 最高多高, 最宽多宽)，都按画面大小的比例
GIFT_SLOTS = [(0.15, 0.975, 0.22, 0.27), (0.84, 0.985, 0.2, 0.25), (0.71, 0.905, 0.13, 0.15)]


def lit(im, light):
    """按时段给透明底的图补一点光：傍晚偏橙、夜里压暗。"""
    if not light:
        return im
    col, k, bright = light
    alpha = im.getchannel('A')
    rgb = im.convert('RGB')
    rgb = Image.blend(rgb, ImageChops.multiply(rgb, Image.new('RGB', rgb.size, col)), k * 2 if k * 2 <= 1 else 1)
    rgb = ImageEnhance.Brightness(rgb).enhance(bright)
    out = rgb.convert('RGBA')
    out.putalpha(alpha)
    return out


def cropped(path):
    im = Image.open(path).convert('RGBA')
    box = im.getchannel('A').point(lambda v: 255 if v > 24 else 0).getbbox()
    return im.crop(box) if box else im


def put(bg, im, cx, bottom, shadow_k):
    """把东西摆在 (cx, bottom)，脚下垫一块影子。"""
    w, h = im.size
    x = int(cx - w / 2)
    sh = Image.new('RGBA', bg.size, (0, 0, 0, 0))
    sw, shh = w * 0.62, max(8, h * shadow_k)
    ImageDraw.Draw(sh).ellipse([cx - sw / 2, bottom - shh / 2, cx + sw / 2, bottom + shh / 2], fill=(20, 16, 30, 95))
    bg.alpha_composite(sh.filter(ImageFilter.GaussianBlur(10)))
    bg.alpha_composite(im, (x, int(bottom - h + h * 0.02)))


def main():
    a = json.load(open(sys.argv[1], encoding='utf-8'))
    bg = Image.open(a['bg']).convert('RGB').resize((S, S), Image.LANCZOS).convert('RGBA')
    light = LIGHT.get(a.get('light'))
    for path, (gx, gy, gh, gw) in zip((a.get('gifts') or [])[:3], GIFT_SLOTS):
        try:
            g = cropped(path)
        except Exception:
            continue
        k = min(S * gh / max(1, g.height), S * gw / max(1, g.width))
        g = lit(g.resize((max(1, int(g.width * k)), max(1, int(g.height * k))), Image.LANCZOS), light)
        put(bg, g, S * gx, S * gy, 0.08)
    fig = cropped(a['pose'])
    lying = fig.width > fig.height * 1.15
    h = int(S * (0.34 if lying else 0.56))
    w = max(1, int(fig.width * h / max(1, fig.height)))
    if w > S * 0.66:
        w = int(S * 0.66)
        h = max(1, int(fig.height * w / max(1, fig.width)))
    fig = lit(fig.resize((w, h), Image.LANCZOS), light)
    put(bg, fig, S * 0.47, int(S * 0.88), 0.10 if lying else 0.06)
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
