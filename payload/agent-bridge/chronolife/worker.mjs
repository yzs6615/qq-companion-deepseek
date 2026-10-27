#!/usr/bin/env node
/** 单次本机维护：推进虚拟时间，不创建模型请求、不接QQ、不监听端口。 */
import path from 'node:path';
import { cfg, env, ROOT } from '../config.mjs';
import { openLife } from './adapter.mjs';
const data = env.BRIDGE_DATA ? path.resolve(env.BRIDGE_DATA) : path.join(ROOT, 'data');
if (!cfg.chronolife) { console.log('ChronoLife未启用，不推进'); process.exit(0); }
const engine = openLife(data, cfg);
try {
  if (!process.argv.includes('--status')) engine.simulate_until(Date.now());
  const s = engine.get_state();
  console.log(JSON.stringify({ mode: s.mode, enabled: s.settings.enabled, proactive: s.settings.proactive, timezone: s.settings.timezone, plant: s.world.plant.stage, lastTick: s.at }));
} finally { engine.close(); }
