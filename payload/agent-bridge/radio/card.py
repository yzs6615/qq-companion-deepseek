"""深夜电台的节目卡。

python radio/card.py 卡片信息.json 输出.png
信息：{brand, number, title, line, song, when, dur, extra}（radio.mjs 的 cardInfo）。
最后一行打印 {"ok": true, "path": ...}；画不出来（没 Pillow、没中文字体）打印 {"ok": false, "error": ...}。
"""
import json
import os
import random
import sys

FONTS_BOLD = [r'C:\Windows\Fonts\msyhbd.ttc', r'C:\Windows\Fonts\simhei.ttf', r'C:\Windows\Fonts\Dengb.ttf',
              '/System/Library/Fonts/PingFang.ttc', '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc']
FONTS = [r'C:\Windows\Fonts\msyh.ttc', r'C:\Windows\Fonts\Deng.ttf', r'C:\Windows\Fonts\simhei.ttf',
         '/System/Library/Fonts/PingFang.ttc', '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc']


def font(size, bold=False):
    from PIL import ImageFont
    for f in (FONTS_BOLD if bold else []) + FONTS:
        if os.path.exists(f):
            try:
                return ImageFont.truetype(f, size)
            except Exception:
                pass
    raise RuntimeError('找不到中文字体')


def wrap(draw, text, fnt, width, max_lines):
    lines, cur = [], ''
    for ch in str(text):
        if ch == '\n':
            lines.append(cur)
            cur = ''
            continue
        if cur and draw.textlength(cur + ch, font=fnt) > width:
            lines.append(cur)
            cur = ch.lstrip()
        else:
            cur += ch
    if cur:
        lines.append(cur)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        lines[-1] = lines[-1][:-1] + '…'
    return lines


def render(d, out):
    from PIL import Image, ImageDraw, ImageFilter
    W, H = 720, 960
    top, bottom = (16, 21, 40), (40, 52, 88)
    img = Image.new('RGB', (W, H))
    g = ImageDraw.Draw(img)
    for y in range(H):
        t = y / (H - 1)
        g.line([(0, y), (W, y)], fill=tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    rnd = random.Random(int(d.get('number') or 1) * 7919)
    for _ in range(80):  # 星星：每期位置不一样
        x, y = rnd.randrange(W), rnd.randrange(int(H * 0.6))
        if (x < 420 and 55 < y < 175) or (x < W - 40 and 285 < y < 480):
            continue  # 别压在字上
        r = rnd.choice([1, 1, 1, 2])
        a = rnd.randrange(80, 220)
        g.ellipse([x - r, y - r, x + r, y + r], fill=(a, a, min(255, a + 25)))
    # 月牙 + 一圈光
    moon = Image.new('L', (W, H), 0)
    m = ImageDraw.Draw(moon)
    cx, cy, R = W - 140, 150, 58
    m.ellipse([cx - R, cy - R, cx + R, cy + R], fill=255)
    m.ellipse([cx - R + 30, cy - R - 16, cx + R + 30, cy + R - 16], fill=0)
    halo = moon.filter(ImageFilter.GaussianBlur(22)).point(lambda v: v // 3)
    img.paste((245, 213, 138), (0, 0), halo)
    img.paste((250, 228, 165), (0, 0), moon)

    g = ImageDraw.Draw(img)
    warm, white, muted = (245, 210, 130), (244, 244, 250), (160, 170, 200)
    X, width = 56, W - 112
    g.text((X, 72), d.get('brand') or '深夜电台', font=font(30, True), fill=warm)
    g.text((X, 118), f"第 {d.get('number', 1)} 期", font=font(26), fill=muted)

    y = 300
    ft = font(60, True)
    for line in wrap(g, d.get('title') or '', ft, width, 3):
        g.text((X, y), line, font=ft, fill=white)
        y += 80
    if d.get('line'):
        y += 14
        fl = font(30)
        for line in wrap(g, f"「{d['line']}」", fl, width, 2):
            g.text((X, y), line, font=fl, fill=(200, 208, 230))
            y += 46

    y = max(y + 50, H - 330)
    g.line([(X, y), (W - X, y)], fill=(80, 92, 130), width=2)
    y += 34
    if d.get('song'):
        # 雅黑里没有 ♪，自己画一个小音符
        g.ellipse([X, y + 17, X + 13, y + 27], fill=warm)
        g.line([(X + 12, y + 22), (X + 12, y + 2)], fill=warm, width=3)
        g.line([(X + 12, y + 3), (X + 21, y + 9)], fill=warm, width=3)
        g.text((X + 32, y), '这期的歌', font=font(24, True), fill=warm)
        y += 44
        fs = font(34, True)
        for line in wrap(g, d['song'], fs, width, 2):
            g.text((X, y), line, font=fs, fill=white)
            y += 50
    foot = ' · '.join(x for x in [d.get('when'), d.get('dur'), d.get('extra')] if x)
    g.text((X, H - 92), foot, font=font(24), fill=muted)
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    img.save(out, optimize=True)


def main():
    try:
        with open(sys.argv[1], encoding='utf-8') as f:
            d = json.load(f)
        render(d, sys.argv[2])
        print(json.dumps({'ok': True, 'path': sys.argv[2]}, ensure_ascii=False))
    except Exception as e:  # noqa: BLE001 画不出来就让调用方发文字卡
        print(json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
