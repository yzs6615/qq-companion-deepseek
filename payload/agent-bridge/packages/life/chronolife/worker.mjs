#!/usr/bin/env node
/** 单次本机维护：推进虚拟时间，不创建模型请求、不接QQ、不监听端口。.env 和数据目录跟插件里的一样（见 ../env.mjs）。 */
import { env, DATA_DIR } from '../env.mjs';
import { chronoSettings } from './settings.mjs';
const cfg = chronoSettings(env);
if (!cfg.chronolife) { console.log('ChronoLife未启用，不推进'); process.exit(0); }
const { openLife } = await import('./adapter.mjs'); // node:sqlite 用到时再 import（老 Node 没有它）
const engine = openLife(DATA_DIR, cfg);
try {
  if (!process.argv.includes('--status')) engine.simulate_until(Date.now());
  const s = engine.get_state();
  console.log(JSON.stringify({ mode: s.mode, enabled: s.settings.enabled, proactive: s.settings.proactive, timezone: s.settings.timezone, plant: s.world.plant.stage, lastTick: s.at }));
} finally { engine.close(); }
