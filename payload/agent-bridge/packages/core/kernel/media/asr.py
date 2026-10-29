#!/usr/bin/env python3
"""听一段音频 / 视频里说了啥（faster-whisper，CPU）。

用法：python media/asr.py <音频或视频文件> [--model base]
最后一行打印 JSON：{"text": ..., "language": ..., "duration": ...}；出错打印 {"error": ...}。

只用本地模型：WHISPER_MODEL_DIR 下的 <大小>/model.bin（比如 base/model.bin），找不到就报错，绝不自己去网上下。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def transcribe(path: Path, model_size: str = "base") -> dict:
    base = os.environ.get("WHISPER_MODEL_DIR", "")
    local = Path(base) / model_size if base else None
    if not local or not (local / "model.bin").exists():
        raise RuntimeError(f"没有本地 whisper 模型（.env 里设 WHISPER_MODEL_DIR，下面要有 {model_size}/model.bin）")
    from faster_whisper import WhisperModel

    model = WhisperModel(str(local), device="cpu", compute_type="int8", local_files_only=True)
    segments, info = model.transcribe(str(path), language="zh", vad_filter=True, beam_size=5)
    text = "".join(s.text.strip() for s in segments if s.text.strip()).strip()
    return {"text": text, "language": info.language, "duration": info.duration}


def main() -> None:
    ap = argparse.ArgumentParser(description="whisper 转文字（只用本地模型）")
    ap.add_argument("file")
    ap.add_argument("--model", default="base")
    args = ap.parse_args()
    try:
        out = transcribe(Path(args.file), args.model)
    except Exception as e:  # noqa: BLE001 — 调用方只看最后一行 JSON
        out = {"error": str(e)}
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
