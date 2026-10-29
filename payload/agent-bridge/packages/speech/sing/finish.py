# 转换后处理：把原唱 4.5kHz 以上的气声按转换版的音量包络叠回去，再（可选）配上伴奏。
# python finish.py <转换版.wav> <原唱人声.wav> <伴奏.wav> <半音偏移> <输出前缀>
# 输出：<前缀>_清唱.wav、<前缀>_带伴奏.wav；打印前后的高频占比 / 平坦度
import sys
import numpy as np
import soundfile as sf
import librosa
from scipy.signal import butter, sosfiltfilt

conv_p, src_p, acc_p, shift, prefix = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5]


def mono(p):
    y, sr = sf.read(p)
    return (y.mean(1) if y.ndim > 1 else y), sr


def hf_share(y, sr):
    S = np.abs(librosa.stft(y.astype(np.float32), n_fft=2048)) ** 2
    fr = librosa.fft_frequencies(sr=sr, n_fft=2048)
    return S[(fr > 4000) & (fr < 8000)].sum() / S.sum() * 100


out, sr = mono(conv_p)
src, sr2 = mono(src_p)
assert sr == sr2 == 44100, (sr, sr2)
n = min(len(out), len(src))
out, src = out[:n], src[:n]
if shift:
    # 气声没有音高，但齿音的位置会跟着唱的变；降调版的气声也跟着挪一下
    src = librosa.effects.pitch_shift(src.astype(np.float32), sr=sr, n_steps=shift)
air = sosfiltfilt(butter(6, 4500, btype='highpass', fs=sr, output='sos'), src)
win = int(sr * 0.05)
env = lambda y: np.sqrt(np.convolve(y ** 2, np.ones(win) / win, 'same'))
air = air * np.clip(env(out) / (env(src) + 1e-4), 0, 2)
best = None
for g in [0.3, 0.5, 0.7, 0.9, 1.2]:
    s = hf_share(out + g * air, sr)
    if best is None or abs(s - 0.9) < abs(best[1] - 0.9):
        best = (g, s)
g = best[0]
sing = out + g * air
sing = sing / max(1e-6, np.abs(sing).max()) * 0.9
sf.write(f'{prefix}_清唱.wav', sing.astype(np.float32), sr, subtype='PCM_16')

acc, sr3 = mono(acc_p)
assert sr3 == sr
acc = acc[:n]
if shift:
    acc = librosa.effects.pitch_shift(acc.astype(np.float32), sr=sr, n_steps=shift)
# 人声比伴奏响一点（跟原曲差不多的比例）
mix = sing * 1.0 + acc * (np.sqrt((sing ** 2).mean()) / (np.sqrt((acc ** 2).mean()) + 1e-9)) * 0.6
mix = mix / max(1e-6, np.abs(mix).max()) * 0.92
sf.write(f'{prefix}_带伴奏.wav', mix.astype(np.float32), sr, subtype='PCM_16')
flat = lambda y: float(librosa.feature.spectral_flatness(y=y.astype(np.float32)).mean())
print(f'{prefix}: 气声增益 {g}，高频占比 {hf_share(out, sr):.1f}% -> {best[1]:.1f}%，平坦度 {flat(out):.4f} -> {flat(sing):.4f}')
