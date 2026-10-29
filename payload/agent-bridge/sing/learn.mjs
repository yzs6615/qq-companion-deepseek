#!/usr/bin/env node
// 整合包：先按整合包的目录指好 COMPANION_HOME 这些（见 companion-env.mjs），再跑插件版的 packages/speech/sing/learn.mjs
import { fileURLToPath } from 'node:url';
import '../companion-env.mjs';

const target = new URL('../packages/speech/sing/learn.mjs', import.meta.url);
process.argv[1] = fileURLToPath(target); // 有的脚本看“是不是直接运行的我”才跑命令行那段
await import(target.href);
