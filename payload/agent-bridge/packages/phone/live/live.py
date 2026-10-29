#!/usr/bin/env python3
"""看直播：截图 + 录系统声音 + Whisper 转文字。

用法：
  python live/live.py shot [--out a.png]
  python live/live.py rec 30 [--out a.wav]
  python live/live.py asr a.wav [--model small]
  python live/live.py watch <url> [--seconds 60] [--shots 3] [--model small]

watch 会单独开一个 Edge 窗口（临时配置，不碰主人自己开着的 Edge）到直播间，
等加载后同时录音和定时截图，看完把这个窗口关掉，最后把音频转成文字，
全部放进 data/live/<时间戳>/，并打印一行 JSON。
一次最多看 90 秒，--seconds 写多了会截到 90。
语音识别只用本地模型：WHISPER_MODEL_DIR（没设先找 <COMPANION_HOME>/tools/whisper-models，再找插件目录下的 tools/whisper-models）里的 <大小>/model.bin，没有就报错，不去网上下。
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import wave
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
TOOLS = ROOT / "tools"
PYLIBS = TOOLS / "pylibs"
if PYLIBS.exists():
    sys.path.insert(0, str(PYLIBS))

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

DATA_DIR = Path(os.environ["BRIDGE_DATA"]) if os.environ.get("BRIDGE_DATA") else ROOT / "data"
LIVE_DIR = DATA_DIR / "live"
MAX_SECONDS = 90  # 一次最多看/录这么久，再长这一轮聊天就等太久了


def find_edge() -> str | None:
    """找 Edge：先 Program Files，再 x86，再用户目录，最后查注册表和 PATH。找不到返回 None。"""
    cands = []
    for var in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"):
        base = os.environ.get(var)
        if base:
            cands.append(Path(base) / "Microsoft" / "Edge" / "Application" / "msedge.exe")
    for p in cands:
        if p.exists():
            return str(p)
    try:
        import winreg

        for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
            try:
                with winreg.OpenKey(hive, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe") as k:
                    val, _ = winreg.QueryValueEx(k, "")
                    if val and os.path.exists(val):
                        return val
            except OSError:
                pass
    except ImportError:
        pass
    return shutil.which("msedge")


def clamp_seconds(seconds: float) -> float:
    if seconds > MAX_SECONDS:
        print(f"[live] 一次最多 {MAX_SECONDS} 秒，--seconds {seconds:g} 截到 {MAX_SECONDS}", flush=True)
        return float(MAX_SECONDS)
    return seconds


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


def whisper_model_dir(model_size: str) -> Path:
    """只用本地模型，找不到就报错，绝不自己去网上下。
    模型目录：设了 WHISPER_MODEL_DIR 就用它（下面放 <大小>/model.bin，或者直接就是放 model.bin 的目录）；
    没设先找 <COMPANION_HOME>/tools/whisper-models（本体的 fetch-whisper.mjs 没设时下到这），再找插件目录下的 tools/whisper-models。"""
    if os.environ.get("WHISPER_MODEL_DIR"):
        base = Path(os.environ["WHISPER_MODEL_DIR"])
        if (base / "model.bin").exists():
            return base
        bases = [base]
    else:
        bases = ([Path(os.environ["COMPANION_HOME"]) / "tools" / "whisper-models"] if os.environ.get("COMPANION_HOME") else []) + [TOOLS / "whisper-models"]
    local = next((b / model_size for b in bases if (b / model_size / "model.bin").exists()), bases[0] / model_size)
    if not (local / "model.bin").exists():
        raise RuntimeError(
            f"没有本地语音识别模型：{local / 'model.bin'}。"
            f"请主人用本体的 kernel/scripts/fetch-whisper.mjs {model_size} 下一个，"
            "或者设 WHISPER_MODEL_DIR 指到放模型的目录"
        )
    return local


def transcribe(wav_path: Path, model_size: str = "small") -> dict:
    local = whisper_model_dir(model_size)
    from faster_whisper import WhisperModel

    print(f"[live] loading whisper {model_size} (cpu/int8)...", flush=True)
    model = WhisperModel(str(local), device="cpu", compute_type="int8", local_files_only=True)
    segments, info = model.transcribe(
        str(wav_path), language="zh", vad_filter=True, beam_size=5,
        initial_prompt="以下是普通话的句子，用简体中文。",  # 不给这句，base 模型常常听出繁体字
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


def open_live(url: str) -> dict:
    """单独开一个 Edge：用临时的 --user-data-dir，这样它是自己的一个进程，
    不会并进主人已经开着的 Edge 里，看完能只关这一个。返回 {proc, profile, note}。"""
    edge = find_edge()
    if not edge:
        # 没有 Edge 只能交给默认浏览器，这种开的窗口没法自动关
        os.startfile(url)  # noqa: S606
        return {"proc": None, "profile": None, "note": "没找到 Edge，用默认浏览器开的，看完关不掉，跟主人说一声"}
    profile = tempfile.mkdtemp(prefix="live-edge-")
    proc = subprocess.Popen(
        [
            edge,
            f"--user-data-dir={profile}",
            "--no-first-run",
            "--no-default-browser-check",
            "--autoplay-policy=no-user-gesture-required",
            "--new-window",
            "--start-maximized",
            url,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return {"proc": proc, "profile": profile, "note": ""}


def close_live(opened: dict) -> None:
    """只关自己开的那个 Edge（连同它的子进程），再删掉临时配置。"""
    proc = opened.get("proc")
    if proc is not None and proc.poll() is None:
        try:
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=15,
            )
        except Exception:  # noqa: BLE001
            try:
                proc.kill()
            except Exception:  # noqa: BLE001
                pass
        print("[live] 关掉了自己开的 Edge 窗口", flush=True)
    profile = opened.get("profile")
    if profile:
        # 进程刚退，文件可能还占着一会儿
        for _ in range(5):
            shutil.rmtree(profile, ignore_errors=True)
            if not os.path.exists(profile):
                break
            time.sleep(1)


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
    opened = open_live(args.url)
    try:
        time.sleep(max(0, args.load_wait))
        result = capture(args)
    finally:
        close_live(opened)
    if opened["note"]:
        result["errors"].append(opened["note"])
    return result


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
    if hasattr(args, "seconds"):
        args.seconds = clamp_seconds(args.seconds)
    if args.cmd == "shot":
        print(json.dumps({"file": str(shot(Path(args.out)))}, ensure_ascii=False))
    elif args.cmd == "rec":
        p = record(Path(args.out), args.seconds, args.device)
        print(json.dumps({"file": str(p)}, ensure_ascii=False))
    elif args.cmd == "asr":
        try:
            print(json.dumps(transcribe(Path(args.wav), args.model), ensure_ascii=False))
        except Exception as exc:  # noqa: BLE001
            # 最后一行还是 JSON，调用方能拿到原因
            print(json.dumps({"text": "", "error": str(exc)}, ensure_ascii=False))
            sys.exit(1)
    elif args.cmd == "capture":
        print(json.dumps(capture(args), ensure_ascii=False))
    elif args.cmd == "watch":
        print(json.dumps(watch(args), ensure_ascii=False))


if __name__ == "__main__":
    main()
