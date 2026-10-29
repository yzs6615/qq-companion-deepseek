/**
 * 插件自带的命令行脚本（bili/bili.mjs、life/life.mjs、chronolife/worker.mjs）用的设置：读 COMPANION_HOME/.env（已经在环境变量里的优先）。
 * 内核调模型时起的命令行已经带着全部环境变量（BRIDGE_DATA 也在），这里只是让手动单独跑的时候也读得到 .env。
 * COMPANION_HOME 没设就当插件目录；数据目录 BRIDGE_DATA 优先，没有就是 <COMPANION_HOME>/data。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HOME = process.env.COMPANION_HOME ? path.resolve(process.env.COMPANION_HOME) : HERE;

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnv(path.join(HOME, '.env'));

export const env = process.env;
export const DATA_DIR = env.BRIDGE_DATA ? path.resolve(env.BRIDGE_DATA) : path.join(HOME, 'data');
