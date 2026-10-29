"""一封信：信纸（百炼画的，没有就自己画一张素纸）+ 手写体排字 + 右下角盖个小章。
python letter/card.py in.json   in.json：{"bg": 信纸图或空, "out": 输出 jpg, "to": "开头的称呼：", "body": "正文（换行分段）",
  "sign": "—— 小伴", "date": "10月27日 周日", "stamp": 透明底小图或空, "fonts": [手写体候选...]}
最后一行打印 {"ok": true}。字从大往小试，排得下为止；每行下面画一条淡淡的横线，跟字对齐。
"""
import json
import os
import random
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1024, 1440
INK = (44, 60, 108)
NO_START = set('，。！？、；：）」』”’…—,.!?;:)')


def font(paths, size):
    for p in paths:
        if p and os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def plain_paper():
    """没有百炼画的信纸时：米白纸 + 一圈淡蓝水彩边。"""
    im = Image.new('RGB', (W, H), (250, 247, 238))
    edge = Image.new('L', (W, H), 0)
    ImageDraw.Draw(edge).rectangle([0, 0, W, H], fill=255)
    ImageDraw.Draw(edge).rectangle([70, 70, W - 70, H - 70], fill=0)
    edge = edge.filter(ImageFilter.GaussianBlur(40))
    im.paste(Image.new('RGB', (W, H), (176, 214, 240)), (0, 0), edge)
    rnd = random.Random(3)
    d = ImageDraw.Draw(im)
    for _ in range(2500):   # 一点纸纹
        x, y = rnd.randrange(W), rnd.randrange(H)
        c = rnd.randrange(232, 248)
        d.point((x, y), fill=(c, c - 3, c - 10))
    return im


def wrap(text, f, width):
    lines = []
    for para in str(text).split('\n'):
        para = para.strip()
        if not para:
            continue
        para = '　　' + para   # 段首空两格（全角空格，算在宽度里）
        cur = ''
        for ch in para:
            if f.getlength(cur + ch) <= width or not cur or ch in NO_START:   # 标点别落到下一行开头
                cur += ch
            else:
                lines.append(cur)
                cur = ch
        lines.append(cur)
        lines.append('')   # 段落之间空半行
    while lines and lines[-1] == '':
        lines.pop()
    return lines


def main():
    a = json.load(open(sys.argv[1], encoding='utf-8'))
    bg = a.get('bg')
    paper = Image.open(bg).convert('RGB').resize((W, H), Image.LANCZOS) if bg and os.path.exists(bg) else plain_paper()
    im = paper.convert('RGBA')
    fonts = a.get('fonts') or []
    left, right, top, bottom = 150, W - 150, 250, H - 330
    for size in range(46, 27, -2):
        f = font(fonts, size)
        lh = int(size * 1.62)
        lines = wrap(a.get('body', ''), f, right - left)
        need = lh * (len(lines) + 1.4)   # +称呼那一行
        if need <= bottom - top:
            break
    layer = Image.new('RGBA', im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    y = top
    for i, s in enumerate([a.get('to', '')] + lines):
        if s:
            d.line([(left - 10, y + int(size * 1.18)), (right + 10, y + int(size * 1.18))], fill=(110, 145, 200, 70), width=2)
            d.text((left, y), s, font=f, fill=INK + (235,))
        y += lh if s or i == 0 else lh // 2
    sf = font(fonts, size + 2)
    sign_y = max(y + lh // 2, top + int(lh * 2))
    for s, dy in [(a.get('sign', ''), 0), (a.get('date', ''), int(lh * 0.95))]:
        if s:
            d.text((right - sf.getlength(s), sign_y + dy), s, font=sf if dy == 0 else font(fonts, max(24, size - 8)), fill=INK + (235,))
    im.alpha_composite(layer)
    stamp = a.get('stamp')
    if stamp and os.path.exists(stamp):
        st = Image.open(stamp).convert('RGBA')
        box = st.getchannel('A').point(lambda v: 255 if v > 24 else 0).getbbox()
        if box:
            st = st.crop(box)
        sh = 210
        st = st.resize((max(1, int(st.width * sh / st.height)), sh), Image.LANCZOS).rotate(-8, expand=True, resample=Image.BICUBIC)
        x0, y0 = left - 10, min(H - 120 - st.height, sign_y + int(lh * 0.2))
        shadow = Image.new('RGBA', im.size, (0, 0, 0, 0))
        shadow.paste((30, 30, 60, 60), (x0 + 6, y0 + 8), st)
        im.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(6)))
        im.alpha_composite(st, (x0, y0))
    im.convert('RGB').save(a['out'], 'JPEG', quality=90)
    print(json.dumps({'ok': True, 'out': a['out']}))


if __name__ == '__main__':
    main()
