#!/usr/bin/env python3
"""看手机（B 站/直播/视频）：adb 截图 + 麦克风录外放 + Whisper 转文字。

用法：
  python live/phone_live.py shot [--out a.png]
  python live/phone_live.py rec 30 [--out a.wav]
  python live/phone_live.py asr a.wav [--model small]
  python live/phone_live.py watch [--seconds 60] [--shots 6] [--model small]

watch 会定时截手机屏幕，同时用电脑麦克风录手机外放，最后转成文字，
全部放进 data/live/phone-<时间戳>/，并打印一行 JSON。
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

ADB = TOOLS / "platform-tools" / "adb.exe"
LIVE_DIR = ROOT / "data" / "live"


def now_tag() -> str:
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def adb_args(serial: str | None) -> list[str]:
    return [str(ADB)] + (["-s", serial] if serial else [])


def pick_serial() -> str | None:
    try:
        out = subprocess.check_output([str(ADB), "devices"], text=True, timeout=10)
    except Exception:
        return None
    for line in out.splitlines()[1:]:
        parts = line.split()
        if len(parts) >= 2 and parts[1] == "device":
            return parts[0]
    return None


def phone_shot(path: Path, serial: str | None = None) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as fh:
        subprocess.run(
            adb_args(serial) + ["exec-out", "screencap", "-p"],
            stdout=fh,
            stderr=subprocess.PIPE,
            timeout=30,
            check=True,
        )
    if path.stat().st_size < 100:
        raise RuntimeError("adb screencap returned an empty image")
    print(f"[phone] shot -> {path}", flush=True)
    return path


def save_wav(path: Path, data, samplerate: int = 16000) -> None:
    import numpy as np

    # 手机外放经过麦克风通常很小：先归一化，Whisper 才听得清。
    peak = float(np.max(np.abs(data))) if data.size else 0.0
    if peak > 1e-5:
        data = data * min(50.0, 0.9 / peak)
    pcm = (np.clip(data, -1.0, 1.0) * 32767).astype(np.int16)
    if pcm.ndim > 1:
        pcm = pcm.mean(axis=1).astype(np.int16)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(samplerate)
        w.writeframes(pcm.tobytes())


def record(path: Path, seconds: float) -> Path:
    import soundcard as sc

    mic = sc.default_microphone()
    print(f"[phone] recording {seconds}s from mic: {mic.name}", flush=True)
    with mic.recorder(samplerate=16000) as rec:
        data = rec.record(numframes=int(16000 * seconds))
    save_wav(path, data)
    print(f"[phone] audio -> {path}", flush=True)
    return path


def transcribe(wav_path: Path, model_size: str = "base") -> dict:
    from faster_whisper import WhisperModel

    print(f"[phone] loading whisper {model_size} (cpu/int8)...", flush=True)
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
            print(f"[phone] {seg.start:6.1f}-{seg.end:6.1f} {text}", flush=True)
    text = "".join(parts).strip()
    print(f"[phone] transcript ({len(text)} chars)", flush=True)
    return {"text": text, "language": info.language, "duration": info.duration}


def watch(args: argparse.Namespace) -> dict:
    serial = args.serial or pick_serial()
    if not serial:
        raise RuntimeError("没有已授权的 adb 设备（手机开 USB 调试并点允许）")
    out_dir = LIVE_DIR / f"phone-{now_tag()}"
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"[phone] device {serial}", flush=True)

    audio_path = out_dir / "audio.wav"
    shots: list[str] = []
    errors: list[str] = []

    def recorder():
        try:
            record(audio_path, args.seconds)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"record: {exc}")

    rec = threading.Thread(target=recorder, daemon=True)
    rec.start()

    interval = max(1.0, args.seconds / max(1, args.shots))
    for i in range(1, args.shots + 1):
        try:
            p = out_dir / f"shot-{i}.png"
            phone_shot(p, serial)
            shots.append(str(p))
        except Exception as exc:  # noqa: BLE001
            errors.append(f"shot {i}: {exc}")
        if i < args.shots:
            time.sleep(interval)

    rec.join(timeout=args.seconds + 20)

    result = {
        "dir": str(out_dir),
        "device": serial,
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


def main() -> None:
    ap = argparse.ArgumentParser(description="watch phone screen: adb shots + mic + whisper")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_shot = sub.add_parser("shot")
    p_shot.add_argument("--out", default=str(LIVE_DIR / f"phone-shot-{now_tag()}.png"))
    p_shot.add_argument("--serial", default=None)

    p_rec = sub.add_parser("rec")
    p_rec.add_argument("seconds", type=float)
    p_rec.add_argument("--out", default=str(LIVE_DIR / f"phone-rec-{now_tag()}.wav"))

    p_asr = sub.add_parser("asr")
    p_asr.add_argument("wav")
    p_asr.add_argument("--model", default="base")

    p_watch = sub.add_parser("watch")
    p_watch.add_argument("--seconds", type=float, default=60)
    p_watch.add_argument("--shots", type=int, default=6)
    p_watch.add_argument("--model", default="base")
    p_watch.add_argument("--serial", default=None)

    args = ap.parse_args()
    if args.cmd in ("shot", "watch"):
        # 告诉 bridge 的黑屏看门狗：这会儿真在用手机
        try:
            data_dir = Path(os.environ["BRIDGE_DATA"]) if os.environ.get("BRIDGE_DATA") else ROOT / "data"
            data_dir.mkdir(parents=True, exist_ok=True)
            (data_dir / "phone-used").write_text(str(int(time.time() * 1000)))
        except OSError:
            pass
    if args.cmd == "shot":
        serial = args.serial or pick_serial()
        print(json.dumps({"file": str(phone_shot(Path(args.out), serial))}, ensure_ascii=False))
    elif args.cmd == "rec":
        p = record(Path(args.out), args.seconds)
        print(json.dumps({"file": str(p)}, ensure_ascii=False))
    elif args.cmd == "asr":
        print(json.dumps(transcribe(Path(args.wav), args.model), ensure_ascii=False))
    elif args.cmd == "watch":
        print(json.dumps(watch(args), ensure_ascii=False))


if __name__ == "__main__":
    main()
