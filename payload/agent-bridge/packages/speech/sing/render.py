"""把一首歌的几段换成机器人自己的嗓子唱，放进歌库（data/songs/<歌名>/）。

python sing/render.py --audio 歌.flac --title 第一天 --artist 孙燕姿 --seg 25-46.6 --seg 46.5-85 [--lyrics 歌词.json] [--shift 0]

每段：截出来 → Demucs 分出人声和伴奏 → 用微调过的唱歌模型 + 参考声音换成机器人的嗓子（显卡）
      → 补一点原唱的气声、配回伴奏 → 24kHz 单声道、音量拉齐、首尾淡入淡出 → data/songs/<歌名>/NN.wav
歌名下的 song.json 记每段的起止时间和歌词（--lyrics 是 {"lines":[{"start","end","text"}]} 这种格式）。
同一段（起止时间一样）再跑会覆盖。一段 30 秒大约 3 分钟。
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
# 数据目录（BRIDGE_DATA，没设就是 COMPANION_HOME/data）、微调的唱歌模型目录、跑 Seed-VC 的 python（.env 里的 SEEDVC_PY / SEEDVC_HOME）
from paths import DATA, MODEL_DIR, PYTHON as VW_PY  # noqa: E402
SONGS = Path(os.environ['SONG_DIR']) if os.environ.get('SONG_DIR') else DATA / 'songs'


def run(cmd: list[str], env_extra: dict | None = None) -> None:
    env = {**os.environ, 'PYTHONIOENCODING': 'utf-8', **(env_extra or {})}
    r = subprocess.run(cmd, env=env, capture_output=True, text=True, encoding='utf-8', errors='replace')
    if r.returncode != 0:
        tail = '\n'.join((r.stdout + r.stderr).strip().splitlines()[-8:])
        raise SystemExit(f'失败：{" ".join(cmd[:2])}\n{tail}')


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--audio', required=True)
    ap.add_argument('--title', required=True)
    ap.add_argument('--artist', default='')
    ap.add_argument('--seg', action='append', required=True, help='起-止（秒），可以写多个')
    ap.add_argument('--lyrics')
    ap.add_argument('--shift', type=int, default=0)
    ap.add_argument('--steps', type=int, default=80)
    a = ap.parse_args()

    lines = json.loads(Path(a.lyrics).read_text(encoding='utf-8'))['lines'] if a.lyrics else []
    out_dir = SONGS / a.title
    out_dir.mkdir(parents=True, exist_ok=True)
    meta_p = out_dir / 'song.json'
    meta = json.loads(meta_p.read_text(encoding='utf-8')) if meta_p.exists() else {'title': a.title, 'artist': a.artist, 'clips': []}
    if a.artist:
        meta['artist'] = a.artist
    info = sf.info(a.audio)

    for seg in a.seg:
        start, end = (float(x) for x in seg.split('-'))
        work = MODEL_DIR / 'work' / f'{a.title}-{start:g}'
        shutil.rmtree(work, ignore_errors=True)
        work.mkdir(parents=True)
        print(f'[{a.title} {start:g}-{end:g}] 截取…', flush=True)
        y, sr = sf.read(a.audio, start=int(start * info.samplerate), stop=int(end * info.samplerate), always_2d=True)
        y = y.T
        if sr != 44100:
            y = librosa.resample(y, orig_sr=sr, target_sr=44100)
        if y.shape[0] == 1:
            y = np.repeat(y, 2, axis=0)
        sf.write(work / 'clip.wav', y.T, 44100, subtype='PCM_16')

        print('  分离人声…', flush=True)
        run([sys.executable, str(HERE / 'separate.py'), str(work / 'clip.wav'), str(work / 'vocals.wav'), str(work / 'accomp.wav')])
        print('  换嗓子（显卡）…', flush=True)
        run([VW_PY, str(HERE / 'convert.py'), str(work / 'vocals.wav'), str(MODEL_DIR / 'ref_sing.wav'), str(work / 'conv'), str(a.shift), str(a.steps), 'false'],
            {'PYTHONUTF8': '1'})
        conv = glob.glob(str(work / 'conv' / 'vc_*.wav'))[0]
        print('  补气声、配伴奏…', flush=True)
        run([sys.executable, str(HERE / 'finish.py'), conv, str(work / 'vocals.wav'), str(work / 'accomp.wav'), str(a.shift), str(work / 'final')])

        mix, _ = librosa.load(str(work / 'final_带伴奏.wav'), sr=24000, mono=True)
        mix = mix / (np.sqrt((mix ** 2).mean()) + 1e-9) * 10 ** (-18 / 20)  # 音量拉到 -18 dBFS
        mix = np.clip(mix, -0.98, 0.98)
        fade = int(24000 * 0.3)
        mix[:fade] *= np.linspace(0, 1, fade)
        mix[-fade:] *= np.linspace(1, 0, fade)

        clips = [c for c in meta['clips'] if not (abs(c['start'] - start) < 0.01 and abs(c['end'] - end) < 0.01)]
        same = next((c for c in meta['clips'] if abs(c['start'] - start) < 0.01 and abs(c['end'] - end) < 0.01), None)
        name = same['file'] if same else f'{len(meta["clips"]) + 1:02d}.wav'
        sf.write(out_dir / name, mix.astype(np.float32), 24000, subtype='PCM_16')
        words = '，'.join(l['text'] for l in lines if l['end'] > start + 0.3 and l['start'] < end - 0.3)
        clips.append({'file': name, 'start': start, 'end': end, 'sec': round(len(mix) / 24000, 1), 'lyrics': words})
        meta['clips'] = sorted(clips, key=lambda c: c['start'])
        meta_p.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding='utf-8')
        shutil.rmtree(work, ignore_errors=True)
        print(f'  好了：{out_dir / name}（{len(mix) / 24000:.1f}s）{words[:30]}', flush=True)


if __name__ == '__main__':
    main()
