/** QQ桥接适配：新数据旁存，旧记忆按范围读取，主动发送只走持久队列。 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ChronoLife } from './engine.mjs';

export function openLife(dataDir, cfg) {
  return new ChronoLife({ dbPath: path.join(dataDir, 'chronolife', 'life.sqlite'), settings: {
    timezone: cfg.chronolifeTimezone, tickMinutes: cfg.chronolifeTickMinutes,
    proactive: cfg.chronolifeProactive, enabled: true,
  } });
}

/** 命令只影响本会话记忆；全局设置只接受主人私聊。 */
export class LifeAdapter {
  constructor({ engine, dataDir, owner, clearSession }) {
    this.engine = engine; this.dataDir = dataDir; this.owner = String(owner); this.clearSession = clearSession;
    this.redactionFile = path.join(dataDir, 'chronolife', 'redactions.json');
    this.redactions = fs.existsSync(this.redactionFile) ? JSON.parse(fs.readFileSync(this.redactionFile, 'utf8')) : {};
  }
  filter(scope, value) {
    const terms = [...(this.redactions.global || []), ...(scope === 'global' ? [] : this.redactions[scope] || [])];
    return String(value || '').split('\n').filter(line => !terms.some(t => line.includes(t))).join('\n');
  }
  importFacts(scope, facts) {
    for (const f of facts.slice(-40)) {
      if (!f || typeof f.t !== 'string' || !f.t.trim() || f.t.length > 2000) continue;
      if (this.filter(scope, f.t) !== f.t) continue;
      this.engine.record_memory({ id: `fact:${scope}:${createHash('sha256').update(f.t).digest('hex').slice(0, 16)}`, scope, text: f.t, source: 'inferred', layer: 'L5', confidence: .6, importance: .7, at: Number.isSafeInteger(f.at) && f.at > 0 ? f.at : Date.now() });
    }
  }
  redact(scope, old, targetId) {
    if (!old) return;
    const terms = old.split(/\r?\n/).map(t => t.trim()).filter(Boolean);
    this.redactions[scope] = [...new Set([...(this.redactions[scope] || []), ...terms])];
    fs.writeFileSync(this.redactionFile + '.tmp', JSON.stringify(this.redactions, null, 2) + '\n');
    fs.renameSync(this.redactionFile + '.tmp', this.redactionFile);
    for (const term of terms) {
      const related = this.engine.get_relevant_memories({ scope, query: term, limit: 100 }).filter(m => m.scope === scope && m.id !== targetId);
      for (const m of related) this.engine.delete_memory(scope, m.id);
    }
    this.clearSession(scope);
  }
  async command({ text, scope, userId, isGroup, send }) {
    const match = text.match(/^\/生活(?:\s+([\s\S]*))?$/);
    if (!match) return false;
    const arg = (match[1] || '状态').trim();
    if (arg === '帮助') {
      await send('/生活 状态｜事件｜记忆\n/生活 记住 内容\n/生活 更正 编号 新内容\n/生活 删除 编号\n主人私聊：暂停｜恢复｜停用｜启用｜主动 开/关｜兴趣 plant/notes/sketch/rest 权重');
      return true;
    }
    const own = !isGroup && String(userId) === this.owner;
    const global = /^(暂停|恢复|停用|启用|主动\s|兴趣\s)/.test(arg);
    if (global && !own) { await send('生活设置请由主人私聊修改'); return true; }
    if (arg === '状态') {
      this.engine.simulate_until(Date.now());
      const s = this.engine.get_state();
      await send(`ChronoLife：${s.mode}\n时区：${s.settings.timezone}\n虚拟植物：${s.world.plant.stage}\n主动分享：${s.settings.proactive ? '开' : '关'} · 全局滚动7天最多${s.settings.weeklyMax}条\n未回复时停发；${s.settings.quietStart}:00—${s.settings.quietEnd}:00免打扰\n/生活 帮助 查看控制项`);
    } else if (arg === '事件' || arg === '记忆') {
      const memories = this.engine.get_relevant_memories({ scope: arg === '事件' ? 'global' : scope, limit: 12 });
      await send(memories.map(m => `${m.id} [${m.source}/${m.layer}]\n${m.text}`).join('\n\n') || '还没有记录');
    } else if (arg === '暂停' || arg === '恢复') {
      this.engine.set_rest_mode(arg === '暂停'); await send(arg === '暂停' ? '自主生活和主动分享已暂停，聊天照常' : '自主生活已恢复，主动开关保持原设置');
    } else if (arg === '停用' || arg === '启用') {
      this.engine.set_enabled(arg === '启用'); this.clearSession(scope); await send(arg === '启用' ? 'ChronoLife已启用' : 'ChronoLife已停用，普通聊天保留');
    } else if (/^主动\s+(开|关)$/.test(arg)) {
      const enabled = arg.endsWith('开'); this.engine.set_proactive(enabled); await send(enabled ? '已允许向现有PROACTIVE_QQ白名单偶尔分享；每周最多3条，未回复不再发' : '主动分享已关闭');
    } else if (/^兴趣\s+(plant|notes|sketch|rest)\s+\d+(\.\d+)?$/.test(arg)) {
      const [, name, weight] = arg.split(/\s+/); this.engine.set_interest(name, Number(weight)); await send('兴趣权重已保存');
    } else if (/^记住\s+\S/.test(arg)) {
      const content = arg.replace(/^记住\s+/, '').slice(0, 2000);
      const id = `note:${randomUUID()}`;
      this.engine.record_memory({ id, scope, text: content, source: 'observed', layer: 'L3', importance: .9 });
      await send(`已记录：${id}`);
    } else if (/^(删除|更正)\s+/.test(arg)) {
      const [, action, id, replacement] = arg.match(/^(删除|更正)\s+(\S+)(?:\s+([\s\S]+))?$/) || [];
      const recordScope = action === '删除' && own && this.engine.get_memory('global', id) ? 'global' : scope;
      const old = this.engine.get_memory(recordScope, id);
      if (!old || (action === '更正' && !replacement)) { await send('编号不存在于当前会话，或没有提供更正内容'); return true; }
      if (!old.deletable) { await send('此记录不能更改'); return true; }
      // 先持久化屏蔽规则再更改记录；中断时宁可少记，不恢复旧内容。
      this.redact(recordScope, old.text, id);
      const ok = action === '删除' ? this.engine.delete_memory(recordScope, id) : this.engine.correct_memory(recordScope, id, replacement.slice(0, 2000));
      await send(ok ? '已更新，并清除当前会话续接，避免旧历史继续带入；历史文件保留原档' : '此记录不能更改');
    } else await send('没有这个生活指令，发 /生活 帮助 查看');
    return true;
  }
}
