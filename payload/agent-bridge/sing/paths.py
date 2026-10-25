"""唱歌脚本用到的 Seed-VC 位置，都从环境变量或 agent-bridge/.env 读，别处装的改 .env 就行。

SEEDVC_HOME        整理好的一套（VoiceWave 那种目录：models\\ dist\\ .venv\\），填了它下面几项都有默认值
SEEDVC_RUNTIME     Seed-VC 代码目录（有 inference.py / train.py 的那个）
SEEDVC_TORCH_PATH  可选：额外加进 sys.path 的目录（比如打包好的 CUDA torch）
SEEDVC_MODELS      本地模型目录（rmvpe / campplus / 训练依赖），没有就让 Seed-VC 自己从 HF 下
SEEDVC_PY          跑 Seed-VC 的 python
SEEDVC_BASE_CKPT   唱歌底模（f0 44k）；微调后的放 data/sing-model/ft_model.pth
"""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def env(name: str, default: str = '') -> str:
    v = os.environ.get(name)
    if v:
        return v
    try:
        for line in (ROOT / '.env').read_text(encoding='utf-8').splitlines():
            line = line.strip()
            if line.startswith(name + '='):
                return line.split('=', 1)[1].strip().strip('"\'') or default
    except OSError:
        pass
    return default


HOME = env('SEEDVC_HOME')
RUNTIME = env('SEEDVC_RUNTIME', os.path.join(HOME, 'models', 'seedvc-v1-offline', 'runtime') if HOME else '')
TORCH_PATH = env('SEEDVC_TORCH_PATH', os.path.join(HOME, 'dist', 'VoiceWave-CUDA', '_internal') if HOME else '')
MODELS = env('SEEDVC_MODELS', os.path.join(HOME, 'models') if HOME else '')
PYTHON = env('SEEDVC_PY', os.path.join(HOME, '.venv', 'Scripts', 'python.exe') if HOME else 'python')
BASE_CKPT = env('SEEDVC_BASE_CKPT', os.path.join(MODELS, 'seedvc-sing-44k', 'DiT_seed_v2_uvit_whisper_base_f0_44k_bigvgan_pruned_ft_ema_v2.pth') if MODELS else '')
MODEL_DIR = ROOT / 'data' / 'sing-model'


def require_runtime() -> None:
    if not RUNTIME or not os.path.exists(os.path.join(RUNTIME, 'inference.py')):
        raise SystemExit('没找到 Seed-VC：先装好 Seed-VC，再在 agent-bridge\\.env 里填 SEEDVC_RUNTIME（或 SEEDVC_HOME）')
