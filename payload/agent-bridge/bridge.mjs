#!/usr/bin/env node
/**
 * 整合包的入口：跑插件版的内核（packages\core\kernel\main.mjs），带上 packages\ 下的全部插件。
 * 守护（bridge-guard.ps1）、启动器、状态窗口都按“bridge.mjs”这个名字认进程，别改名。
 * 内核和插件的代码是打包时从 dsh-companion-plugins 仓库复制进来的，要改去那边改；这里只把整合包的目录指给它（见 companion-env.mjs）。
 * 想只带几个插件：.env 里写 COMPANION_ONLY=speech,memory（跟插件仓库根目录的 bridge.mjs 一样）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import './companion-env.mjs';

const PKGS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'packages');
if (!process.env.COMPANION_MODULES) {
  const only = (process.env.COMPANION_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
  const mods = fs.readdirSync(PKGS)
    .filter((id) => id !== 'core' && fs.existsSync(path.join(PKGS, id, 'module.mjs')) && (!only.length || only.includes(id)))
    .map((id) => ({ id, file: path.join(PKGS, id, 'module.mjs') }));
  process.env.COMPANION_MODULES = JSON.stringify(mods);
}
await import(pathToFileURL(path.join(PKGS, 'core', 'kernel', 'main.mjs')).href);
