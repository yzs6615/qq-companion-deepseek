/**
 * 本体的小工具（功能页、日记网页、会话查看、表情包索引、下表情包 / whisper 模型、NapCat 配置）单独跑时，
 * 找用户自己的东西（.env、人设、data）放在哪，跟内核一个算法：
 *   - 设了 COMPANION_HOME 就是它（内核由 DSH 带起来时就有）；
 *   - 没设：内核目录里有 .env（在仓库里直接跑、测试）就是内核目录；
 *     没有的话，本体装进 DSH 时默认放在 <DSH_HOME，没有就是 ~/.dsh>/companion（跟 index.js 一样），那里有 .env 就用它，
 *     顺手设进 process.env.COMPANION_HOME（config.mjs 按它读 .env）。
 *   - 数据目录：BRIDGE_DATA 优先，其次 <COMPANION_HOME>/data。
 * import 这个文件就会把 COMPANION_HOME 定下来，所以要排在 import config.mjs 前面（config.mjs 一 import 就读 .env）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 内核目录（packages/core/kernel，装进 DSH 是 node_modules/dsh-companion-core/kernel）。 */
export const KERNEL = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** COMPANION_HOME：算法见上。 */
export function companionHome(env = process.env) {
  if (!env.COMPANION_HOME) {
    const home = path.join(env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'companion');
    if (!fs.existsSync(path.join(KERNEL, '.env')) && fs.existsSync(path.join(home, '.env'))) env.COMPANION_HOME = home;
  }
  return env.COMPANION_HOME ? path.resolve(env.COMPANION_HOME) : KERNEL;
}

/** 数据目录：BRIDGE_DATA 优先，其次 <COMPANION_HOME>/data。.env 里写的 BRIDGE_DATA 要等 config.mjs 读进来以后才算数。 */
export function dataDir(env = process.env) {
  return env.BRIDGE_DATA ? path.resolve(env.BRIDGE_DATA) : path.join(companionHome(env), 'data');
}

companionHome();
