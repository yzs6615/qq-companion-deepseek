# 换嗓子：Seed-VC 唱歌模型（最好先用目标声音微调过）把一段清唱人声换成目标的嗓子。
# Seed-VC 在哪见 sing/paths.py（.env 里的 SEEDVC_*）；用 SEEDVC_PY 跑，加 PYTHONUTF8=1。
# python convert.py <清唱人声.wav> <参考.wav> <输出目录> <半音偏移> <步数> <fp16 true|false> [模型.pth]
import os, sys, runpy
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from paths import MODEL_DIR, RUNTIME, TORCH_PATH, require_runtime  # noqa: E402

require_runtime()
os.environ.setdefault('HF_HUB_OFFLINE', '1') if os.path.exists(os.path.join(MODEL_DIR, 'config.yml')) else None
if TORCH_PATH:
    sys.path.insert(0, TORCH_PATH)
sys.path.insert(0, RUNTIME)
sys.path.insert(0, os.path.join(HERE, 'shim'))
os.makedirs(os.path.join(MODEL_DIR, 'cache'), exist_ok=True)
os.chdir(os.path.join(MODEL_DIR, 'cache'))  # 运行时的缓存落在这里
source, target, outdir, shift, steps, fp16 = sys.argv[1:7]
ckpt = sys.argv[7] if len(sys.argv) > 7 else os.path.join(MODEL_DIR, 'ft_model.pth')
config = os.path.join(MODEL_DIR, 'config.yml')
if not os.path.exists(config):
    config = os.path.join(RUNTIME, 'configs', 'presets', 'config_dit_mel_seed_uvit_whisper_base_f0_44k.yml')
os.makedirs(outdir, exist_ok=True)
sys.argv = ['inference.py',
            '--source', source, '--target', target, '--output', outdir,
            '--diffusion-steps', steps, '--f0-condition', 'true', '--auto-f0-adjust', 'false',
            '--semi-tone-shift', shift, '--inference-cfg-rate', '0.7',
            '--checkpoint', ckpt,
            '--config', config,
            '--fp16', fp16]
runpy.run_path(os.path.join(RUNTIME, 'inference.py'), run_name='__main__')
