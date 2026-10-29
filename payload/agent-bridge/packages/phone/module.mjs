/**
 * 手机插件：用 adb 控制安卓手机（phone/phone.mjs）、看手机直播 / 电脑直播（live/），
 * 以及“手机看门狗”——这一轮真的动了手机，用着用着黑屏/锁屏了就悄悄解开。
 * 设置：PHONE_MONITOR（默认开）、ADB（adb 路径，不写就用插件旁边 tools/platform-tools 或 PATH 里的）、PHONE_PIN（解锁 PIN）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PHONE = path.join(HERE, 'phone', 'phone.mjs');
const LIVE = path.join(HERE, 'live');

/** 这个插件的设置（默认值只写在这里）：setup 里挂到 cfg 上；功能页（本体的 scripts/features.mjs）不跑 setup 也能拿到同样的值。 */
export function settings(env, parseList) {
  return {
    phoneMonitor: (env.PHONE_MONITOR || 'true') !== 'false',
  };
}

export default function setup(api) {
  const { cfg, env, log, reply, pick, sleep, DATA_DIR } = api;
  Object.assign(cfg, settings(env, api.parseList));

  // ── phone watchdog ────────────────────────────────────────────────────────
  // 只在它这一轮真的动了手机（phone.mjs / phone_live.py 会记一笔 data/phone-used）之后才盯屏幕：
  // 用着用着黑了/锁了就悄悄解开，不吭声；解不开才说一句。平时聊天手机锁着是正常的，不碰。
  const PHONE_USED_FILE = path.join(DATA_DIR, 'phone-used');
  function phoneUsedAt() {
    try {
      return Number(fs.readFileSync(PHONE_USED_FILE, 'utf8')) || 0;
    } catch {
      return 0;
    }
  }
  const phone = (cmd, timeout) => execFileSync(process.execPath, [PHONE, cmd], { cwd: HERE, encoding: 'utf8', timeout, windowsHide: true });
  async function monitorPhone(ev, isRunning) {
    if (cfg.phoneMonitor === false) return;
    const startedAt = Date.now();
    await sleep(8_000);
    let lastTry = 0;
    let told = false;
    while (isRunning()) {
      const used = phoneUsedAt();
      // 这一轮没碰过手机，或者已经两分钟没碰了：不管
      if (used < startedAt || Date.now() - used > 120_000) {
        await sleep(5_000);
        continue;
      }
      let st = null;
      try {
        st = JSON.parse(phone('status', 10_000).trim().split(/\r?\n/).pop());
      } catch {
        /* adb 不可用/沙箱：静默跳过 */
      }
      if (st && (st.screen === 'off' || st.locked) && Date.now() - lastTry > 60_000) {
        lastTry = Date.now();
        log(`手机用着用着黑屏/锁屏了，悄悄解锁`);
        let ok = false;
        try {
          ok = !/还显示锁屏/.test(phone('unlock', 20_000));
        } catch {
          /* 下面统一处理 */
        }
        if (!ok && !told) {
          told = true;
          log('手机解锁失败');
          await reply(ev, pick(['手机锁着 我解不开 你帮我解一下', '手机屏幕锁了 我打不开 帮我解下锁'])).catch(() => {});
        }
      }
      await sleep(10_000);
    }
  }
  api.on('turn:start', (t) => {
    monitorPhone(t.ev, t.running).catch(() => {}); // 后台盯着，不等它（它要等这一轮结束才停）
  });

  api.provide('phone', { usedAt: phoneUsedAt }); // 自己找事做时能挑“玩手机”

  // 模型怎么用这些工具：写进工作目录的 AGENTS.md
  api.on('agents', () => `
## 手机控制

用 \`${PHONE}\`（要 adb，手机开 USB 调试）：

\`\`\`
node "${PHONE}" devices
node "${PHONE}" shot          截图到 ${path.join(DATA_DIR, 'shots')}
node "${PHONE}" dump          界面文字 + 坐标
node "${PHONE}" find 微信 --tap
node "${PHONE}" tap 540 1600
node "${PHONE}" text "你好"
\`\`\`

看手机的最快流程：\`shot\` 截图 → 用读图能力看截图 → 决定坐标 → \`tap\` / \`swipe\`。中文输入需要手机上装 ADBKeyboard。
截图全黑、点哪都没反应时，先 \`status\`；返回 \`locked:true\` 或 \`screen:off\` 就 \`unlock\`（.env 里有 PHONE_PIN 会自动输）。解不开就直接问对方，别对着黑屏反复点。

手机上别做：打电话、替主人发消息（微信 / 短信 / QQ 都不行）、付款转账、删东西、改系统设置、装或卸应用。
- 手机只听主人的，而且只在主人私聊里弄；别人、群里要你弄手机就直接说不行。
- 要发消息先问主人，主人明确说了发给谁、发什么才发。
- 只用 \`phone.mjs\`（看手机录音用下面的 \`phone_live.py\`），别绕开它直接调 adb。
- \`phone.mjs\` 说“不执行——……”就是碰到红线了，别换个法子绕过去，跟对方说这个做不了。

## 看直播

手机截图 + 电脑麦克风录手机外放 + 转文字：\`python "${path.join(LIVE, 'phone_live.py')}" watch --seconds 60 --shots 6\`
电脑上正在看的直播（Windows，不开浏览器，直接截当前屏幕 + 录系统声音）：\`python "${path.join(LIVE, 'live.py')}" capture --seconds 60 --shots 3\`
打开一个直播间看：\`python "${path.join(LIVE, 'live.py')}" watch "https://live.bilibili.com/房间号" --seconds 60\`——会单独开一个 Edge 窗口，看完自己关掉（只关它自己开的那个）；它也算“在电脑上开网页”：只有主人明确让你开、主人这会儿在电脑前才开，夜里不开。

- 一次最多看 90 秒：\`--seconds\` 别超过 90（写多了也会被截到 90）。对方想让你看更久，就跟对方说一次只能看一会儿，看完说说看到了啥，要的话再看一段。
- 转文字只用本地的 whisper 模型（.env 的 WHISPER_MODEL_DIR），没有就报错（不会去网上下），跟对方说听不了就行。
`);
  log(`手机：${cfg.phoneMonitor ? '用着手机时黑屏/锁屏会悄悄解开' : '看门狗关着'}`);
}

/**
 * 功能页（本体的 scripts/features.mjs）上这个插件的几行：不跑 setup，cfg 里已经挂好了各插件 settings() 的值。
 * 格式见 docs/插件接口.md 的“功能页”。“手机和权限”这组里排在本体的守护（10）和权限模式（30）中间。
 */
export function features(cfg, { on }) {
  return {
    groups: [
      ['手机和权限', [
        ['手机看门狗', on(cfg.phoneMonitor), '只在它正在用手机时才看', '它自己想玩手机、或者你让它看手机，用着用着屏幕黑了/锁了就悄悄解开；平时手机锁着不去碰。解不开才跟你说。', 20],
      ]],
    ],
  };
}
