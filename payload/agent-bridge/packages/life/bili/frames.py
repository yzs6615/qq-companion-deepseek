"""挑画面、拼图版（思路参考 video-watch-plus：先量“哪里变了”，再挑帧拼成图版；只用 PyAV + Pillow + numpy）。

python bili/frames.py plan.json

plan.json：
  {"segments": [{"file", "start", "end", "kind": "peak"|"even"|"whole", "target"?, "note"?}, ...],
   "max": 帧数上限, "duration": 视频秒数, "out": 输出前缀（会写 <out>-1.jpg、<out>-2.jpg …）}

每段（B站 DASH 一个分片约 5 秒，或者没索引时整段）：
  - peak（弹幕高峰）：取离目标时间最近的那帧；
  - even（均匀铺开）：段里前后两帧差别最大的地方算“换镜头”，取换完的那帧；没换镜头就取中间那帧。
  whole（没有分片索引时下的整段）先切成小窗口再按 even 处理。
然后按 弹幕高峰 > 换镜头（越明显越先）> 均匀 的顺序挑，跟已挑的长得太像、或时间挨太近的不要，最多 max 帧，
按时间排好，每 9 格拼一张，左上角写时间和为什么挑它。
最后一行输出 JSON：{"sheets": [...], "frames": [{"t", "kind", "note"}]}
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import av
import numpy as np
from PIL import Image, ImageDraw, ImageFont

CUT = 0.10  # 缩略图平均灰度差超过这个算换镜头
SAME = 0.04  # 跟已挑的帧比，大部分格子的变化（中位数）不到这个，算同一个镜头（画面里有东西在动也算同一个）
THUMB = (32, 18)


def thumb(img: Image.Image) -> np.ndarray:
    return np.asarray(img.convert("L").resize(THUMB), dtype=np.float32) / 255.0


def same_shot(a: np.ndarray, b: np.ndarray) -> bool:
    # 2x2 合并成 16x9 的格子，看“大部分格子”变没变：一小块在动不算换镜头
    pa = a.reshape(9, 2, 16, 2).mean(axis=(1, 3))
    pb = b.reshape(9, 2, 16, 2).mean(axis=(1, 3))
    return float(np.median(np.abs(pa - pb))) < SAME


def decode(path: str, t0: float, t1: float, step: int = 2):
    """解出 [t0, t1) 里的帧（每 step 帧取一帧），返回 [(t, PIL.Image)]。分片单独解码时时间戳本来就是绝对的。"""
    out = []
    try:
        with av.open(path) as c:
            s = c.streams.video[0]
            s.thread_type = "AUTO"
            for i, f in enumerate(c.decode(s)):
                if f.time is None:
                    continue
                if f.time >= t1:
                    break
                if f.time >= t0 and i % step == 0:
                    out.append((float(f.time), f.to_image()))
    except (av.error.FFmpegError, EOFError):
        pass  # 只下了一部分的文件，解到尾巴会报错：用已经拿到的
    return out


def best_in(frames, kind: str, target: float | None, note: str | None):
    if not frames:
        return None
    if kind == "peak" and target is not None:
        t, img = min(frames, key=lambda x: abs(x[0] - target))
        return {"t": t, "img": img, "th": thumb(img), "kind": "peak", "score": 1.0, "note": note}
    ths = [thumb(img) for _, img in frames]
    diffs = [float(np.abs(ths[i] - ths[i - 1]).mean()) for i in range(1, len(ths))]
    if diffs and max(diffs) > CUT:
        k = int(np.argmax(diffs)) + 1
        # 换完镜头再往后一点，避开转场的糊帧
        k = min(len(frames) - 1, k + 1)
        return {"t": frames[k][0], "img": frames[k][1], "th": ths[k], "kind": "cut", "score": max(diffs), "note": None}
    k = len(frames) // 2
    return {"t": frames[k][0], "img": frames[k][1], "th": ths[k], "kind": "even", "score": 0.0, "note": None}


def probe(path: str) -> float:
    """视频有多长（秒）；量不出来给 0。"""
    try:
        with av.open(path) as c:
            if c.duration:
                return float(c.duration) / av.time_base
            s = c.streams.video[0]
            return float(s.duration * s.time_base) if s.duration and s.time_base else 0.0
    except (av.error.FFmpegError, IndexError):
        return 0.0


def candidates(plan) -> list[dict]:
    out = []
    for seg in plan["segments"]:
        # end 写 0 = 不知道多长（QQ 发来的视频），自己量
        start, end = float(seg["start"]), float(seg["end"]) or probe(seg["file"]) or 60.0
        if seg["kind"] == "whole":
            # 没有分片索引时下的整段：切成小窗口，每个窗口当一个 even 段
            n = max(1, int(plan["max"]) * 2)
            frames = decode(seg["file"], start, end, step=3)
            w = (end - start) / n
            for k in range(n):
                part = [x for x in frames if start + k * w <= x[0] < start + (k + 1) * w]
                c = best_in(part, "even", None, None)
                if c:
                    out.append(c)
        else:
            c = best_in(decode(seg["file"], start, end), seg["kind"], seg.get("target"), seg.get("note"))
            if c:
                out.append(c)
    return out


def choose(cands: list[dict], n: int, duration: float) -> list[dict]:
    rank = {"peak": 0, "cut": 1, "even": 2}
    order = sorted(cands, key=lambda c: (rank[c["kind"]], -c["score"], c["t"]))
    min_gap = max(2.0, duration / (n * 4))
    picked: list[dict] = []
    for c in order:
        if len(picked) >= n:
            break
        if any(abs(c["t"] - p["t"]) < min_gap for p in picked):
            continue
        if c["kind"] != "peak" and any(same_shot(c["th"], p["th"]) for p in picked):
            continue
        picked.append(c)
    return sorted(picked, key=lambda c: c["t"])


def font(size: int):
    for f in (r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\simhei.ttf", "/System/Library/Fonts/PingFang.ttc"):
        try:
            return ImageFont.truetype(f, size)
        except OSError:
            continue
    return ImageFont.load_default()


def sheets(picked: list[dict], out: str) -> list[str]:
    paths = []
    f = font(16)
    label = {"peak": "弹幕高峰", "cut": "换镜头", "even": ""}
    for si in range(math.ceil(len(picked) / 9)):
        group = picked[si * 9 : si * 9 + 9]
        cols = 3 if len(group) > 4 else 2 if len(group) > 1 else 1
        rows = math.ceil(len(group) / cols)
        w = 427
        first = group[0]["img"]
        h = int(w * first.height / first.width)
        img = Image.new("RGB", (cols * w, rows * h), "black")
        draw = ImageDraw.Draw(img)
        for i, c in enumerate(group):
            x, y = (i % cols) * w, (i // cols) * h
            img.paste(c["img"].convert("RGB").resize((w, h)), (x, y))
            text = f"{int(c['t'] // 60)}:{int(c['t'] % 60):02d} {label[c['kind']]}".strip()
            box = draw.textbbox((x + 6, y + 3), text, font=f)
            draw.rectangle([x, y, box[2] + 6, box[3] + 4], fill="black")
            draw.text((x + 6, y + 3), text, fill="yellow", font=f)
        p = f"{out}-{si + 1}.jpg"
        Path(p).parent.mkdir(parents=True, exist_ok=True)
        img.save(p, quality=85)
        paths.append(p)
    return paths


def main() -> None:
    plan = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    n = max(1, min(27, int(plan["max"])))
    duration = float(plan.get("duration") or 0) or max((probe(x["file"]) for x in plan["segments"]), default=60.0) or 60.0
    picked = choose(candidates(plan), n, duration)
    if not picked:
        raise SystemExit("没抽到画面")
    # 清掉这个视频以前的图
    for old in Path(plan["out"]).parent.glob(Path(plan["out"]).name + "-*.jpg"):
        old.unlink(missing_ok=True)
    paths = sheets(picked, plan["out"])
    print(json.dumps({"sheets": paths, "duration": round(duration, 1), "frames": [{"t": round(c["t"], 1), "kind": c["kind"], "note": c["note"]} for c in picked]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
