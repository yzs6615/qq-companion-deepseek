#!/usr/bin/env node
/**
 * Write a NapCat OneBot 11 config with a forward WebSocket server that the
 * bridge can connect to, and sync the token into ../.env.
 *
 *   node napcat/setup-onebot.mjs            # writes onebot11.json (template for every account)
 *   node napcat/setup-onebot.mjs 123456789  # also writes onebot11_123456789.json
 *
 * Env: ONEBOT_PORT (default 3001), ONEBOT_TOKEN (default random)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONFIG_DIR =
  process.env.NAPCAT_CONFIG_DIR || path.join(ROOT, '..', 'tools', 'napcat', 'app', 'napcat', 'config');
const PORT = Number(process.env.ONEBOT_PORT || 3001);
const TOKEN = process.env.ONEBOT_TOKEN || crypto.randomBytes(12).toString('hex');
const uin = process.argv[2] || '';

if (!fs.existsSync(CONFIG_DIR)) {
  console.error(`找不到 NapCat 配置目录: ${CONFIG_DIR}\n请先解压 NapCat.Shell.Windows.Node.zip 到 tools/napcat/app。`);
  process.exit(1);
}

const config = {
  network: {
    httpServers: [],
    httpSseServers: [],
    httpClients: [],
    websocketServers: [
      {
        name: 'dsh-bridge',
        enable: true,
        host: '127.0.0.1',
        port: PORT,
        messagePostFormat: 'array',
        reportSelfMessage: false,
        token: TOKEN,
        enableForcePushEvent: true,
        debug: false,
        heartInterval: 30000,
      },
    ],
    websocketClients: [],
    plugins: [],
  },
  musicSignUrl: '',
  enableLocalFile2Url: false,
  parseMultMsg: false,
  imageDownloadProxy: '',
  timeout: { baseTimeout: 10000, uploadSpeedKBps: 256, downloadSpeedKBps: 256, maxTimeout: 1800000 },
};

const targets = [path.join(CONFIG_DIR, 'onebot11.json')];
if (uin) targets.push(path.join(CONFIG_DIR, `onebot11_${uin}.json`));
for (const file of targets) {
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  console.log(`写入 ${file}`);
}

// Sync token into the bridge's .env (leave everything else untouched).
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  const next = fs
    .readFileSync(envFile, 'utf8')
    .split(/\r?\n/)
    .map((line) => (line.startsWith('ONEBOT_TOKEN=') ? `ONEBOT_TOKEN=${TOKEN}` : line))
    .join('\n');
  fs.writeFileSync(envFile, next);
  console.log('已更新 .env 的 ONEBOT_TOKEN');
}

console.log(`\nOneBot WS: ws://127.0.0.1:${PORT}  token: ${TOKEN}`);
console.log('接着：启动 NapCat 并用手机 QQ 扫码登录 → 运行 `node bridge.mjs`。');
