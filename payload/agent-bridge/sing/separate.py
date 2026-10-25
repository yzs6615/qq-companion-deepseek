# 用 Demucs htdemucs_ft 的人声专精模型（04573f0d）把唱歌素材里的伴奏去掉，只留人声。
# python separate.py in.wav out_vocals.wav out_accomp.wav
import sys, wave
from pathlib import Path
import numpy as np
import torch
from demucs.states import load_model
from demucs.apply import apply_model

src, out_v, out_a = sys.argv[1], sys.argv[2], sys.argv[3]
ckpt = Path.home() / '.cache' / 'torch' / 'hub' / 'checkpoints' / '04573f0d-f3cf25b2.th'
model = load_model(str(ckpt))
model.eval()

w = wave.open(src)
sr, ch, n = w.getframerate(), w.getnchannels(), w.getnframes()
a = np.frombuffer(w.readframes(n), np.int16).astype(np.float32).reshape(-1, ch).T / 32768
assert sr == model.samplerate, (sr, model.samplerate)
if ch == 1:
    a = np.repeat(a, 2, axis=0)
mix = torch.from_numpy(a)
ref = mix.mean(0)
mix = (mix - ref.mean()) / ref.std()
with torch.no_grad():
    out = apply_model(model, mix[None], device='cpu', shifts=2, split=True, overlap=0.25, progress=False)[0]
out = out * ref.std() + ref.mean()
vocals = out[model.sources.index('vocals')].mean(0).numpy()
accomp = (out.sum(0) - out[model.sources.index('vocals')]).mean(0).numpy()


def save(p, x):
    x = np.clip(x, -1, 1)
    with wave.open(p, 'wb') as o:
        o.setnchannels(1)
        o.setsampwidth(2)
        o.setframerate(sr)
        o.writeframes((x * 32767).astype(np.int16).tobytes())


save(out_v, vocals)
save(out_a, accomp)
print('ok', model.sources, len(vocals) / sr)
