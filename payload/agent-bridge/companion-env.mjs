/**
 * 整合包里插件版内核用的路径。入口 bridge.mjs 和 scripts\、napcat\ 下转手的小工具都先 import 这个，再去跑 packages\core\kernel 里的东西。
 * 整合包的目录是安装器定的：
 *   <安装目录>\agent-bridge\           .env、persona.md、data\，npm 装的 node_modules（DSH 在里面）
 *   <安装目录>\agent-bridge\packages\  插件版的本体和全部插件（打包时从 dsh-companion-plugins 仓库的 packages\ 复制）
 *   <安装目录>\tools\                  自带的 Node.js、NapCat、adb、Whisper 模型
 *   <安装目录>\.dsh-home\              DSH 的配置（用哪个模型）
 * 插件版自己是按“装进 DSH”的样子找这些的，这里替它指好（跟老版本 bridge.mjs 里 use-plugins.txt 那段一个意思）。
 * .env 里写了的以 .env 为准：先把 .env 读进环境变量（跟本体 config.mjs 一个规矩，已经在环境变量里的不覆盖），再补上没写的。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.dirname(APP);
const env = process.env;

env.COMPANION_HOME ||= APP;
try {
  for (const raw of fs.readFileSync(path.join(env.COMPANION_HOME, '.env'), 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    const eq = line.indexOf('=');
    if (!line || line.startsWith('#') || eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in env)) env[key] = value;
  }
} catch {
  /* 还没有 .env（没装完）：全用下面的默认 */
}
// DSH：安装器用 npm 装在 agent-bridge\node_modules（离线包解到同一个地方）；插件版自己只会去内核旁边找
env.DSH_CLI ||= path.join(APP, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
// 安装器写进 .env 的是 DSH_HOME=<安装目录>\.dsh-home、AGENT_CWD=<安装目录>；没写也照这个来（插件版没设 DSH_HOME 时用 ~\.dsh，那是另一套配置）
env.DSH_HOME ||= path.join(DIR, '.dsh-home');
env.AGENT_CWD ||= DIR;
// Whisper 模型：scripts\fetch-whisper.mjs 下到这里，内核听 QQ 语音、看视频也到这里找
env.WHISPER_MODEL_DIR ||= path.join(DIR, 'tools', 'whisper-models');
// adb：安装器下到 tools\platform-tools（没有就用 PATH 里的）
const adb = path.join(DIR, 'tools', 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
if (fs.existsSync(adb)) env.ADB ||= adb;
// NapCat 的配置目录（napcat\setup-onebot.mjs 往这写）：安装器解到 tools\napcat\app；启动器也认 .env 里的 NAPCAT_DIR
env.NAPCAT_CONFIG_DIR ||= path.join(env.NAPCAT_DIR ? path.resolve(APP, env.NAPCAT_DIR) : path.join(DIR, 'tools', 'napcat', 'app', 'napcat'), 'config');
