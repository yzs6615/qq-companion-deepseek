/** ChronoLife 的设置：插件（module.mjs）和定时任务用的 worker.mjs 共用这一份，默认值只写在这里。不碰 node:sqlite，静态 import 也没事。 */
export function chronoSettings(env) {
  return {
    // ChronoLife旁存时间线；不开启时沿用旧行为。
    chronolife: env.CHRONOLIFE === 'true',
    chronolifeTimezone: env.CHRONOLIFE_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai', // 不填就用电脑的时区
    chronolifeTickMinutes: Number(env.CHRONOLIFE_TICK_MINUTES || 30),
    chronolifeProactive: env.CHRONOLIFE_PROACTIVE === 'true',
    chronolifeCheckMs: Number(env.CHRONOLIFE_CHECK_MS || 0), // 测试用：bridge 多久看一次（不填就按 CHRONOLIFE_TICK_MINUTES）
  };
}
