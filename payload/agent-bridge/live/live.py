#!/usr/bin/env python3
"""看直播：截图 + 录系统声音 + Whisper 转文字。

用法：
  python live/live.py shot [--out a.png]
  python live/live.py rec 30 [--out a.wav]
  python live/live.py asr a.wav [--model small]
  python live/live.py watch <url> [--seconds 60] [--shots 3] [--model small]

watch 会打开 Edge 到直播间，等加载后同时录音和定时截图，最后把
音频转成文字，全部放进 data/live/<时间戳>/，并打印一行 JSON。
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import time
import wave
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
TOOLS = ROOT.parent / "tools"
PYLIBS = TOOLS / "pylibs"
if PYLIBS.exists():
    sys.path.insert(0, str(PYLIBS))

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
LIVE_DIR = ROOT / "data" / "live"


def now_tag() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def save_wav(path: Path, data, samplerate: int = 16000) -> None:
    import numpy as np

    pcm = (np.clip(data, -1.0, 1.0) * 32767).astype(np.int16)
    if pcm.ndim > 1:
        pcm = pcm.mean(axis=1).astype(np.int16)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(samplerate)
        w.writeframes(pcm.tobytes())


def record(path: Path, seconds: float, device: str | None = None) -> Path:
    import soundcard as sc

    if device:
        mic = sc.get_microphone(id=device, include_loopback=True)
    else:
        speaker = sc.default_speaker()
        mic = sc.get_microphone(id=str(speaker.name), include_loopback=True)
    print(f"[live] recording {seconds}s from loopback: {mic.name}", flush=True)
    with mic.recorder(samplerate=16000) as rec:
        data = rec.record(numframes=int(16000 * seconds))
    save_wav(path, data)
    print(f"[live] audio -> {path}", flush=True)
    return path


def shot(path: Path) -> Path:
    from PIL import ImageGrab

    img = ImageGrab.grab()
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path)
    print(f"[live] shot -> {path} ({img.width}x{img.height})", flush=True)
    return path


def transcribe(wav_path: Path, model_size: str = "small") -> dict:
    from faster_whisper import WhisperModel

    print(f"[live] loading whisper {model_size} (cpu/int8)...", flush=True)
    local = TOOLS / "whisper-models" / model_size
    model_ref = str(local) if (local / "model.bin").exists() else model_size
    model = WhisperModel(model_ref, device="cpu", compute_type="int8")
    segments, info = model.transcribe(
        str(wav_path), language="zh", vad_filter=True, beam_size=5
    )
    parts = []
    for seg in segments:
        text = seg.text.strip()
        if text:
            parts.append(text)
            print(f"[live] {seg.start:6.1f}-{seg.end:6.1f} {text}", flush=True)
    text = "".join(parts).strip()
    print(f"[live] transcript ({len(text)} chars)", flush=True)
    return {"text": text, "language": info.language, "duration": info.duration}


def open_live(url: str) -> None:
    if os.path.exists(EDGE):
        subprocess.Popen(
            [EDGE, "--new-window", "--start-maximized", url],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    else:
        os.startfile(url)  # noqa: S606


def capture(args: argparse.Namespace, out_dir: Path | None = None) -> dict:
    out_dir = out_dir or (LIVE_DIR / now_tag())
    out_dir.mkdir(parents=True, exist_ok=True)
    audio_path = out_dir / "audio.wav"
    shots = []
    errors = []

    def recorder():
        try:
            record(audio_path, args.seconds)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"record: {exc}")

    rec_thread = threading.Thread(target=recorder, daemon=True)
    rec_thread.start()

    interval = max(1.0, args.seconds / max(1, args.shots))
    for i in range(1, args.shots + 1):
        try:
            p = out_dir / f"shot-{i}.png"
            shot(p)
            shots.append(str(p))
        except Exception as exc:  # noqa: BLE001
            errors.append(f"shot {i}: {exc}")
        if i < args.shots:
            time.sleep(interval)

    rec_thread.join(timeout=args.seconds + 20)

    result = {
        "dir": str(out_dir),
        "shots": shots,
        "audio": str(audio_path) if audio_path.exists() else "",
        "text": "",
        "model": args.model,
        "errors": errors,
    }
    if audio_path.exists() and audio_path.stat().st_size > 44:
        try:
            asr = transcribe(audio_path, args.model)
            result["text"] = asr["text"]
            (out_dir / "transcript.txt").write_text(asr["text"], encoding="utf-8")
        except Exception as exc:  # noqa: BLE001
            result["errors"].append(f"asr: {exc}")
    (out_dir / "meta.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return result


def watch(args: argparse.Namespace) -> dict:
    print(f"[live] opening {args.url}", flush=True)
    open_live(args.url)
    time.sleep(max(0, args.load_wait))
    return capture(args)


def main() -> None:
    ap = argparse.ArgumentParser(description="watch live stream: shot + loopback audio + whisper")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_shot = sub.add_parser("shot")
    p_shot.add_argument("--out", default=str(LIVE_DIR / f"shot-{now_tag()}.png"))

    p_rec = sub.add_parser("rec")
    p_rec.add_argument("seconds", type=float)
    p_rec.add_argument("--out", default=str(LIVE_DIR / f"rec-{now_tag()}.wav"))
    p_rec.add_argument("--device", default=None)

    p_asr = sub.add_parser("asr")
    p_asr.add_argument("wav")
    p_asr.add_argument("--model", default="base")

    p_cap = sub.add_parser("capture")
    p_cap.add_argument("--seconds", type=float, default=60)
    p_cap.add_argument("--shots", type=int, default=3)
    p_cap.add_argument("--model", default="base")

    p_watch = sub.add_parser("watch")
    p_watch.add_argument("url")
    p_watch.add_argument("--seconds", type=float, default=60)
    p_watch.add_argument("--shots", type=int, default=3)
    p_watch.add_argument("--load-wait", type=float, default=8)
    p_watch.add_argument("--model", default="base")

    args = ap.parse_args()
    if args.cmd == "shot":
        print(json.dumps({"file": str(shot(Path(args.out)))}, ensure_ascii=False))
    elif args.cmd == "rec":
        p = record(Path(args.out), args.seconds, args.device)
        print(json.dumps({"file": str(p)}, ensure_ascii=False))
    elif args.cmd == "asr":
        print(json.dumps(transcribe(Path(args.wav), args.model), ensure_ascii=False))
    elif args.cmd == "capture":
        print(json.dumps(capture(args), ensure_ascii=False))
    elif args.cmd == "watch":
        print(json.dumps(watch(args), ensure_ascii=False))


if __name__ == "__main__":
    main()
