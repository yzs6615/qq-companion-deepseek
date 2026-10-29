"""旅行明信片：正面（百炼画的当地风景，没有就自己画一张）+ 背面（手写几句话、邮编格、邮票、邮戳），上下拼成一张。
python postcard/card.py in.json   in.json：{"front": 风景图或空, "out": 输出 jpg, "to": "开头的称呼：", "body": "背面写的话",
  "sign": "—— 小伴", "date": "2026.10.27", "city": "厦门", "spot": "鼓浪屿", "fonts": [手写体候选...], "sans": [邮戳用的黑体候选...]}
最后一行打印 {"ok": true}。邮票是从正面中间裁的一小块，邮戳盖在邮票左下角、压住一半。
"""
import json
import math
import os
import random
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont, ImageOps

W, H = 1440, 960          # 一面的大小（3:2）
PAD, GAP = 48, 44         # 外边、正反面之间
INK = (44, 60, 108)
RED = (178, 48, 44)
LINE = (178, 168, 148)
NO_START = set('，。！？、；：）」』”’…—,.!?;:)')


def font(paths, size):
    for p in paths or []:
        if p and os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def paper(w, h, seed):
    im = Image.new('RGB', (w, h), (250, 246, 236))
    d = ImageDraw.Draw(im)
    rnd = random.Random(seed)
    for _ in range(w * h // 300):   # 一点纸纹
        x, y = rnd.randrange(w), rnd.randrange(h)
        c = rnd.randrange(230, 247)
        d.point((x, y), fill=(c, c - 4, c - 12))
    return im


def fallback_front(city, spot, fonts):
    """正面没画成：天空渐变 + 三层远山 + 大字地名。"""
    im = Image.new('RGB', (W, H))
    d = ImageDraw.Draw(im)
    top, bottom = (120, 178, 224), (252, 226, 192)
    for y in range(H):
        t = y / H
        d.line([(0, y), (W, y)], fill=tuple(int(top[i] * (1 - t) + bottom[i] * t) for i in range(3)))
    rnd = random.Random(city + spot)
    for col, base in [((128, 156, 176), 0.6), ((92, 124, 146), 0.71), ((62, 94, 114), 0.83)]:
        pts, x = [(0, H)], 0
        while x <= W:
            pts.append((x, int(H * base - rnd.random() * H * 0.13)))
            x += rnd.randint(70, 190)
        pts += [(W, int(H * base)), (W, H)]
        d.polygon(pts, fill=col)
    big, small = font(fonts, 150), font(fonts, 64)
    for f, s, y in [(big, city, int(H * 0.3)), (small, spot, int(H * 0.3) + 130)]:
        if not s:
            continue
        shadow = Image.new('RGBA', im.size, (0, 0, 0, 0))
        ImageDraw.Draw(shadow).text((W // 2 + 4, y + 5), s, font=f, fill=(30, 40, 60, 120), anchor='mm')
        im.paste(shadow.filter(ImageFilter.GaussianBlur(5)), (0, 0), shadow.filter(ImageFilter.GaussianBlur(5)))
        ImageDraw.Draw(im).text((W // 2, y), s, font=f, fill=(255, 252, 244), anchor='mm')
    return im


def stamp_from(front):
    """邮票：正面中间裁一块，白边 + 一圈齿孔。"""
    sw, sh = 214, 256
    st = Image.new('RGBA', (sw, sh), (255, 255, 255, 255))
    st.paste(ImageOps.fit(front, (sw - 30, sh - 30), Image.LANCZOS, centering=(0.5, 0.45)), (15, 15))
    mask = Image.new('L', (sw, sh), 255)
    md = ImageDraw.Draw(mask)
    r = 6
    for x in range(0, sw + 1, 2 * r + 5):
        md.ellipse([x - r, -r, x + r, r], fill=0)
        md.ellipse([x - r, sh - r, x + r, sh + r], fill=0)
    for y in range(0, sh + 1, 2 * r + 5):
        md.ellipse([-r, y - r, r, y + r], fill=0)
        md.ellipse([sw - r, y - r, sw + r, y + r], fill=0)
    st.putalpha(mask)
    return st


def postmark(city, date, sans):
    """邮戳：双圈、城市、日期，右边几道波浪线；随机擦掉一点，像没盖实。"""
    size = 270
    im = Image.new('RGBA', (size + 250, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    cx = cy = size // 2
    r = 112
    col = RED + (215,)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=col, width=6)
    d.ellipse([cx - r + 15, cy - r + 15, cx + r - 15, cy + r - 15], outline=col, width=3)
    cf = font(sans, 52 if len(city) <= 3 else 40)
    d.text((cx, cy - 26), city, font=cf, fill=col, anchor='mm')
    d.line([(cx - 74, cy + 10), (cx + 74, cy + 10)], fill=col, width=3)
    d.text((cx, cy + 44), date, font=font(sans, 28), fill=col, anchor='mm')
    for k in range(4):
        y0 = cy - 54 + k * 36
        d.line([(cx + r + 16 + x, y0 + 9 * math.sin(x / 20)) for x in range(0, 230, 4)], fill=col, width=4)
    rnd = random.Random(city + date)
    noise = Image.new('L', im.size, 255)
    nd = ImageDraw.Draw(noise)
    for _ in range(1100):
        x, y = rnd.randrange(im.width), rnd.randrange(im.height)
        nd.ellipse([x - 3, y - 3, x + 3, y + 3], fill=rnd.randrange(0, 170))
    im.putalpha(ImageChops.multiply(im.getchannel('A'), noise.filter(ImageFilter.GaussianBlur(1.2))))
    return im.rotate(-12, expand=True, resample=Image.BICUBIC)


def wrap(text, f, width):
    lines = []
    for para in str(text).split('\n'):
        para = para.strip()
        cur = ''
        for ch in para:
            if f.getlength(cur + ch) <= width or not cur or ch in NO_START:   # 标点别落到下一行开头
                cur += ch
            else:
                lines.append(cur)
                cur = ch
        if cur:
            lines.append(cur)
    return lines


def back(a, front):
    fonts, sans = a.get('fonts') or [], a.get('sans') or []
    im = paper(W, H, a.get('city', '') + a.get('date', '')).convert('RGBA')
    d = ImageDraw.Draw(im)
    for i in range(6):   # 左上角六个邮编格
        d.rectangle([72 + i * 60, 62, 72 + i * 60 + 46, 62 + 54], outline=RED, width=3)
    d.text((W // 2 - 40, 92), 'POSTCARD   明 信 片', font=font(sans, 30), fill=(160, 148, 126), anchor='mm')
    mid = int(W * 0.56)
    d.line([(mid, 170), (mid, H - 80)], fill=LINE, width=3)
    # 右边：邮票、邮戳、地址
    st = stamp_from(front)
    sx, sy = W - 76 - st.width, 52
    sh = Image.new('RGBA', im.size, (0, 0, 0, 0))
    sh.paste((40, 30, 20, 70), (sx + 5, sy + 7), st)
    im.alpha_composite(sh.filter(ImageFilter.GaussianBlur(5)))
    im.alpha_composite(st, (sx, sy))
    pm = postmark(a.get('city', ''), a.get('date', ''), sans)
    im.alpha_composite(pm, (max(mid + 20, sx - 250), sy + 96))
    hf = font(fonts, 48)
    to_name = str(a.get('to', '')).strip().rstrip('：:').strip() or '你'
    for k, s in enumerate([f'{to_name}  收', f'寄自 {a.get("city", "")} · {a.get("spot", "")}', '']):
        y = 520 + k * 118
        d.line([(mid + 50, y), (W - 76, y)], fill=LINE, width=2)
        if s:
            d.text((mid + 64, y - 66), s, font=hf if k == 0 else font(fonts, 40), fill=INK + (235,))
    # 左边：正文，字从大往小试，排得下为止
    left, right, top, bottom = 84, mid - 56, 196, H - 200
    for size in range(50, 27, -2):
        f = font(fonts, size)
        lh = int(size * 1.6)
        lines = wrap(a.get('body', ''), f, right - left)
        if lh * (len(lines) + 1) <= bottom - top:
            break
    y = top
    for s in [a.get('to', '')] + lines:
        if s:
            d.text((left, y), s, font=f, fill=INK + (235,))
        y += lh
    sf = font(fonts, size + 2)
    sign_y = max(y + lh // 3, H - 190)
    for s, dy, ff in [(a.get('sign', ''), 0, sf), (a.get('date', ''), int(lh * 0.95), font(fonts, max(24, size - 8)))]:
        if s:
            d.text((right - ff.getlength(s), min(sign_y + dy, H - 70)), s, font=ff, fill=INK + (235,))
    return im.convert('RGB')


def main():
    a = json.load(open(sys.argv[1], encoding='utf-8'))
    f = a.get('front')
    front = Image.open(f).convert('RGB') if f and os.path.exists(f) else fallback_front(a.get('city', ''), a.get('spot', ''), a.get('fonts'))
    front = ImageOps.fit(front, (W, H), Image.LANCZOS)
    b = back(a, front)
    canvas = Image.new('RGBA', (W + 2 * PAD, 2 * H + 2 * PAD + GAP), (228, 222, 210, 255))
    for i, face in enumerate([front, b]):
        x, y = PAD, PAD + i * (H + GAP)
        sh = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
        ImageDraw.Draw(sh).rectangle([x + 6, y + 9, x + W + 6, y + H + 9], fill=(60, 48, 36, 80))
        canvas.alpha_composite(sh.filter(ImageFilter.GaussianBlur(9)))
        canvas.paste(face, (x, y))
    canvas.convert('RGB').save(a['out'], 'JPEG', quality=88)
    print(json.dumps({'ok': True, 'out': a['out']}))


if __name__ == '__main__':
    main()
