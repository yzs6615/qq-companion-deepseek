# Seed-VC 的 hf_utils 替身：本地有的模型直接用本地的（离线），本地没有就交给 Seed-VC 自己的 hf_utils 去下。
import importlib.util
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from paths import MODELS, RUNTIME  # noqa: E402

DEPS = os.path.join(MODELS, 'seedvc-train-deps') if MODELS else ''
LOCAL = {
    ('lj1995/VoiceConversionWebUI', 'rmvpe.pt'): os.path.join(MODELS, 'seedvc-sing-44k', 'rmvpe.pt'),
    ('funasr/campplus', 'campplus_cn_common.bin'): os.path.join(MODELS, 'seedvc-v1-offline', 'dependencies', 'campplus_cn_common.bin'),
    # 只有训练用得到
    ('myshell-ai/OpenVoiceV2', 'converter/checkpoint.pth'): os.path.join(DEPS, 'openvoice-converter', 'checkpoint.pth'),
    ('myshell-ai/OpenVoiceV2', 'converter/config.json'): os.path.join(DEPS, 'openvoice-converter', 'config.json'),
    ('Plachta/Seed-VC', 'se_db.pt'): os.path.join(DEPS, 'se_db.pt'),
} if MODELS else {}

_upstream = None


def _fallback():
    global _upstream
    if _upstream is None:
        spec = importlib.util.spec_from_file_location('seedvc_hf_utils', os.path.join(RUNTIME, 'hf_utils.py'))
        _upstream = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_upstream)
    return _upstream


def _local(repo_id, filename):
    p = LOCAL.get((repo_id, filename))
    return p if p and os.path.exists(p) else None


def load_custom_model_from_hf(repo_id, model_filename='pytorch_model.bin', config_filename=None):
    p = _local(repo_id, model_filename)
    c = _local(repo_id, config_filename) if config_filename else None
    if p and (config_filename is None or c):
        return p if config_filename is None else (p, c)
    return _fallback().load_custom_model_from_hf(repo_id, model_filename, config_filename)
