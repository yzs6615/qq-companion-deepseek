/**
 * 电脑上的她：电脑室友（看得见在放的歌、开着的游戏、电脑开了多久、人在不在电脑前，pc.mjs）、
 * 回来时从电脑喇叭打个招呼、离开久了在桌面留张便条、桌面抽屉、用电脑上的 QQ 音乐放歌（qqmusic.mjs）。只支持 Windows。
 * 设置：PC_BUDDY / PC_MAX_DAY / PC_SONG_PROB / PC_CHECK_MS、QUIET_HOURS / AWAY_MIN、SPEAKER / SPEAKER_MAX_DAY、
 * NOTES / NOTE_AFTER_MIN、DRAWER、PLAY_MUSIC / PLAY_MUSIC_MAX_DAY / QQMUSIC_EXE、SPEAKER_ASK_MAX_DAY。电脑是谁的（PC_OWNER）还在本体，走 api.owner()。
 * 大白话：主人让她用喇叭说句话 [喇叭:要说的话]、暂停 / 切歌 / 调音量 [音乐:暂停|继续|下一首|上一首|大声|小声]（本体抠掉标记，natural:act 交到这里办）。
 * 提供 pc 服务：now()（最近一次看到的电脑）、owner()、quiet()（现在该不该安静）；
 * 提供 drawer 服务：put(sub, name, file) / append(file, line)（写信、明信片、现场照、梦、收藏往抽屉里放）。没装这个插件，这些都跳过。
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pcSnapshot } from './pc.mjs';
import { searchSong, pickSong, playInClient, songUrl, nowPlaying } from './qqmusic.mjs';

/** 这个插件的设置（默认值只写在这里）：setup 里挂到 cfg 上；功能页（本体的 scripts/features.mjs）不跑 setup 也能拿到同样的值。 */
export function settings(env, parseList) {
  return {
    // 电脑室友：看得见这台电脑在放什么歌、开着什么游戏、开了多久、人在不在电脑前；只跟电脑的主人提
    pcBuddy: (env.PC_BUDDY || 'false') === 'true',
    pcMaxDay: Number(env.PC_MAX_DAY ?? 3), // 一天最多因为电脑上的事主动说几句
    pcSongProb: Number(env.PC_SONG_PROB ?? 0.12), // 新放一首歌时顺口说一句的概率（同一首这周放到第 3 遍必说）
    pcCheckMs: Number(env.PC_CHECK_MS ?? 120_000),
    // 电脑上的她（都靠电脑室友看键盘鼠标多久没动；夜里不出声、不留条）
    awayMin: Number(env.AWAY_MIN ?? 120), // 键盘鼠标这么久没动、又动了，算“回来了”
    speaker: (env.SPEAKER || 'false') === 'true', // 早上第一次开电脑、离开很久又回来时，用她的声音从电脑喇叭说一句（要开语音）
    speakerMaxDay: Number(env.SPEAKER_MAX_DAY ?? 3),
    speakerAskMaxDay: Number(env.SPEAKER_ASK_MAX_DAY ?? 10), // 主人让她“用喇叭说句话”的，一天最多几句（跟自己打招呼的分开算，不用隔一小时）
    notes: (env.NOTES || 'false') === 'true', // 离开电脑好几个小时时，她在桌面留张便条，回来时弹个通知
    noteAfterMin: Number(env.NOTE_AFTER_MIN ?? 180),
    drawer: (env.DRAWER || 'false') === 'true', // 桌面上“<名字>的抽屉”：写给主人的信、明信片、现场照、梦、便条、收藏的视频都放一份
    playMusic: (env.PLAY_MUSIC || 'false') === 'true', // 用电脑上的 QQ 音乐放歌：模型写 [放歌:歌名 歌手]，主人在电脑前就直接放，不在就发链接
    playMusicMaxDay: Number(env.PLAY_MUSIC_MAX_DAY ?? 6),
    qqMusicExe: env.QQMUSIC_EXE || 'C:\\Program Files (x86)\\Tencent\\QQMusic\\QQMusic.exe',
  };
}

export default function setup(api) {
  const { cfg, env, log, state, saveState, userState, persona, lifeBlock, appendMemory, say, reply, runAgent, humanize, activeChats, batches, pick, sleep, pace, ROOT, DATA_DIR } = api;
  const { dayKey, speakable } = api.human;
  Object.assign(cfg, settings(env, api.parseList));
  // PowerShell、桌面、托盘通知、QQ 音乐都只有 Windows 上有
  if (process.platform !== 'win32') {
    log('电脑上的她只支持 Windows');
    return;
  }
  // 人设成长那段在她自己的生活（life 插件）里，没装就不带
  const selfBlock = () => api.use('life')?.selfBlock() || '';
  const pad2 = (n) => String(n).padStart(2, '0');

  // ── 电脑室友：她住在这台电脑里，看得见在放什么歌、开着什么游戏、电脑开了多久、人在不在电脑前（pc.mjs）───────────
  // 只跟电脑的主人（PC_OWNER，默认 PROACTIVE_QQ 第一个）提，只在私聊里带；群里、别的人都不知道。
  // 聊天时提示词里带一段“这台电脑上”；碰上值得说的事（一首歌这周放到第 3 遍、凌晨还在打游戏 / 还在电脑前、电脑连开好几天），
  // 偶尔主动说一句：一天最多 PC_MAX_DAY 句、两句至少隔 90 分钟、同一件事隔几天才再提，对方正在跟她聊的时候不插话。
  const pcOwner = () => api.owner();
  let pcNow = null; // 最近一次看到的电脑（只在内存里，不落盘）
  let pcRunning = false;
  function spanDesc(ms) {
    const m = Math.max(1, Math.round(ms / 60_000));
    return m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时${m % 60 >= 10 ? ` ${m % 60} 分钟` : ''}`;
  }
  function pcPlays(title) {
    return (state._pc?.plays?.[title] || []).filter((t) => Date.now() - t < 7 * 86400_000).length;
  }
  function pcBlock(qq, isGroup) {
    if (!cfg.pcBuddy || isGroup || String(qq) !== pcOwner() || !pcNow || Date.now() - pcNow.at > 10 * 60_000) return '';
    const h = new Date().getHours();
    const out = [];
    if (pcNow.music) {
      const n = pcPlays(pcNow.music.title);
      out.push(`正在放：${pcNow.music.title}（${pcNow.music.app}${n >= 2 ? `，这周放了 ${n} 遍` : ''}）`);
    }
    if (pcNow.game) out.push(`开着游戏：${pcNow.game.name}（玩了 ${spanDesc(Date.now() - pcNow.game.since)}）`);
    const up = pcNow.bootAt ? (Date.now() - pcNow.bootAt) / 3600_000 : 0;
    if (up >= 24) out.push(`电脑已经连着开了 ${Math.floor(up / 24)} 天没关`);
    if (h < 5 && pcNow.idleSec < 300) out.push('这么晚了，人还在电脑前（键盘鼠标刚刚还在动）');
    if (!out.length) return '';
    return `\n\n---\n【这台电脑上】（你就住在这台电脑里，这些你直接听得到、看得到）\n${out.map((s) => `- ${s}`).join('\n')}\n（像住在一起的室友，偶尔顺口提一句就行，别每次都提，别像在监视，别说“检测到”这种词。）`;
  }
  function pcEvent(snap, started, pc) {
    const owner = pcOwner();
    if (!owner || !api.online()) return null;
    const now = Date.now();
    const h = new Date().getHours();
    if (pc.day !== dayKey()) Object.assign(pc, { day: dayKey(), count: 0 });
    if (pc.count >= cfg.pcMaxDay || now - (pc.lastAt || 0) < 90 * 60_000) return null;
    const chatKey = `u${owner}`;
    if (activeChats.has(chatKey) || batches.has(chatKey) || now - (userState(owner).lastUserAt || 0) < 10 * 60_000) return null; // 正聊着：提示词里有，不另外插话
    const said = (k, days) => now - (pc.said[k] || 0) < days * 86400_000;
    if (started) {
      const n = pcPlays(started.title);
      if (n >= 3 && !said(`song:${started.title}`, 3)) return { key: `song:${started.title}`, what: `电脑上刚开始放《${started.title}》（${started.app}），这首这周已经放了 ${n} 遍` };
      if (Math.random() < cfg.pcSongProb && !said('song', 0.25)) return { key: 'song', what: `电脑上刚开始放《${started.title}》（${started.app}）` };
    }
    if (h < 5 && snap.game && now - snap.game.since > 3600_000 && !said('lategame', 0.5)) return { key: 'lategame', what: `现在凌晨 ${h} 点多了，对方还在玩${snap.game.name}（已经玩了 ${spanDesc(now - snap.game.since)}）` };
    if (h >= 1 && h < 5 && !snap.game && snap.idleSec < 180 && !said('late', 0.5)) return { key: 'late', what: `现在凌晨 ${h} 点多了，对方还在电脑前（键盘鼠标刚刚还在动）` };
    const up = snap.bootAt ? (now - snap.bootAt) / 86400_000 : 0;
    if (up >= 2 && h >= 10 && h < 22 && !said('uptime', 3)) return { key: 'uptime', what: `对方的电脑已经连着开了 ${Math.floor(up)} 天没关机` };
    return null;
  }
  async function pcSay(event, pc) {
    if (cfg.chronolife) return;
    const owner = pcOwner();
    const prompt =
      `${persona()}${lifeBlock(owner)}${selfBlock()}\n\n---\n你住在对方这台电脑里，刚注意到：${event.what}。\n` +
      `像住在一起的室友那样随口说一句：吐槽、关心、跟着哼两句、问一句都行，1 句，口语。你本来就在这台电脑里，别解释是怎么知道的，别说“检测到”“监控”这种词；` +
      `正在睡觉时段的话可以说是被吵醒的。不想说就只输出 [SILENT]。只输出要发的话。`;
    try {
      const r = await runAgent(prompt, null, { permissionMode: 'read-only' });
      const text = humanize(r.text).trim();
      pc.said[event.key] = Date.now(); // 不管说没说，这件事这几天都不再提
      saveState();
      if (!text || /\[SILENT\]/i.test(text)) return;
      await say({ message_type: 'private', user_id: Number(owner) }, text, { casual: true, autoMood: 0.3 });
      Object.assign(pc, { count: (pc.count || 0) + 1, lastAt: Date.now() });
      saveState();
      appendMemory(`u${owner}`, `（你注意到电脑上：${event.what}）`, text);
      log(`电脑室友：${event.key} → ${text.slice(0, 60)}`);
    } catch (err) {
      log(`电脑室友没说成: ${err.message}`);
    }
  }
  async function checkPc() {
    if (!cfg.pcBuddy || pcRunning || !api.online()) return; // 没连上 QQ 时别看：刚开始放的歌会被白白记掉
    pcRunning = true;
    try {
      let snap;
      try {
        snap = await pcSnapshot();
      } catch {
        return; // 这次没看成，下次再看
      }
      const pc = state._pc || (state._pc = { song: '', plays: {}, said: {} });
      const now = Date.now();
      let started = null; // 这一眼刚开始放的歌
      if (snap.music && snap.music.title !== pc.song) {
        started = snap.music;
        pc.plays[started.title] = [...(pc.plays[started.title] || []), now];
      }
      pc.song = snap.music?.title || '';
      for (const [t, list] of Object.entries(pc.plays)) {
        const keep = list.filter((x) => now - x < 14 * 86400_000);
        if (keep.length) pc.plays[t] = keep;
        else delete pc.plays[t];
      }
      // 离开 / 回来：上一次看到的“最后动键盘鼠标的时间”到这一次之间隔了 AWAY_MIN 以上，就是刚回来
      const lastInput = now - snap.idleSec * 1000;
      const prevInput = pc.lastInput || lastInput;
      const back = snap.idleSec < 120 && lastInput - prevInput >= cfg.awayMin * 60_000 ? lastInput - prevInput : 0;
      pc.lastInput = Math.max(prevInput, lastInput);
      pcNow = snap;
      saveState();
      if (back) return void (await pcCameBack(back, pc));
      if (snap.idleSec >= cfg.noteAfterMin * 60) await pcLeaveNote(pc, snap.idleSec * 1000);
      const event = pcEvent(snap, started, pc);
      if (event) await pcSay(event, pc);
    } finally {
      pcRunning = false;
    }
  }

  // ── 电脑上的她：回来时从电脑喇叭打个招呼（SPEAKER）、离开很久时在桌面留张便条，回来弹个通知（NOTES）、桌面抽屉（DRAWER）──────
  // 这些不是 QQ 消息，开着 ChronoLife 也照做，但跟它的作息对齐：睡觉时段、QUIET_HOURS（默认 23~9 点）、它在休息时都不出声、不留条。
  // 测试用 SPEAKER_LOG / NOTIFY_LOG / DESKTOP_DIR 代替真的放声音、弹通知、写桌面。
  let desktopPath = '';
  function desktop() {
    if (desktopPath) return desktopPath;
    if (env.DESKTOP_DIR) return (desktopPath = path.resolve(env.DESKTOP_DIR));
    try {
      const b64 = execFileSync('powershell', ['-NoProfile', '-Command', "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([Environment]::GetFolderPath('Desktop')))"], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
      desktopPath = Buffer.from(b64.trim(), 'base64').toString('utf8');
    } catch {}
    return desktopPath || (desktopPath = path.join(env.USERPROFILE || ROOT, 'Desktop'));
  }
  const pcQuiet = () => api.quiet(); // 免打扰在本体（睡觉时段、QUIET_HOURS、ChronoLife 休息）
  function runHiddenPs(script) {
    spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
  const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;
  /** 右下角弹个通知（NotifyIcon 气泡，Win11 上就是一条系统通知）。 */
  function desktopNotify(title, text) {
    if (env.NOTIFY_LOG) return void fs.appendFileSync(env.NOTIFY_LOG, `${title}｜${text}\n`);
    runHiddenPs(`Add-Type -AssemblyName System.Windows.Forms; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; $n.ShowBalloonTip(15000, ${psq(title)}, ${psq(text)}, 'None'); Start-Sleep -Seconds 20; $n.Dispose()`);
  }
  /** 用她的声音从电脑喇叭说一句（百炼合成，PowerShell 放 wav）。没开语音、没装“说话的样子”就不说。 */
  async function speakOnPc(text) {
    if (env.SPEAKER_LOG) return fs.appendFileSync(env.SPEAKER_LOG, `${text}\n`), true;
    if (!cfg.voice) return false;
    const voice = api.use('voice');
    if (!voice?.speak) return false;
    const { wav } = await voice.speak(text, { url: cfg.voiceWs, apiKey: env.DASHSCOPE_API_KEY, voice: cfg.voiceId, model: cfg.voiceModel, rate: cfg.voiceRate, cutMs: cfg.voiceCutMs });
    const dir = path.join(DATA_DIR, 'speaker');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `${Date.now()}.wav`);
    fs.writeFileSync(f, wav);
    runHiddenPs(`(New-Object System.Media.SoundPlayer ${psq(f)}).PlaySync()`);
    for (const old of fs.readdirSync(dir).filter((x) => x.endsWith('.wav')).sort().slice(0, -10)) fs.rmSync(path.join(dir, old), { force: true });
    return true;
  }
  async function pcCameBack(awayMs, pc) {
    const owner = pcOwner();
    if (!owner) return;
    if (cfg.notes && pc.note && !pc.note.shown) {
      pc.note.shown = true;
      saveState();
      desktopNotify(`${cfg.botName}给你留了张便条`, `${pc.note.text.split(/\n/)[0].slice(0, 50)}（在桌面上）`);
      log('便条：对方回来了，弹了个通知');
    }
    if (!cfg.speaker || pcQuiet()) return;
    const sp = pc.speak || (pc.speak = {});
    if (sp.day !== dayKey()) Object.assign(sp, { day: dayKey(), count: 0 });
    if (sp.count >= cfg.speakerMaxDay || Date.now() - (sp.at || 0) < 3600_000) return;
    const morning = new Date().getHours() < 12 && sp.morning !== dayKey() && awayMs > 4 * 3600_000; // 今天头一回坐到电脑前
    const what = morning ? '早上对方第一次坐到电脑前' : `对方离开电脑 ${spanDesc(awayMs)}，刚回来`;
    const prompt =
      `${persona()}${lifeBlock(owner)}\n\n---\n${what}。你住在这台电脑里，用电脑喇叭直接跟对方说一句（会用你自己的声音念出来，对方在房间里能听到）：` +
      `很短，5~15 个字，像室友打招呼（“早”“回来啦 去哪了”这种），别带表情、括号和标记。只输出要说的话。`;
    try {
      const r = await runAgent(prompt, null, { permissionMode: 'read-only' });
      const text = speakable(humanize(r.text)).slice(0, 30);
      if (!text || !(await speakOnPc(text))) return;
      Object.assign(sp, { count: sp.count + 1, at: Date.now(), ...(morning ? { morning: dayKey() } : {}) });
      saveState();
      appendMemory(`u${owner}`, `（${what}）`, `（用电脑喇叭说）${text}`);
      log(`电脑喇叭：${morning ? '早上' : '回来'} → ${text}`);
    } catch (err) {
      log(`电脑喇叭没说成: ${err.message}`);
    }
  }
  async function pcLeaveNote(pc, awayMs) {
    const owner = pcOwner();
    if (!cfg.notes || !owner || pcQuiet() || pc.noteDay === dayKey()) return;
    pc.noteDay = dayKey(); // 一天最多一张，先记上
    saveState();
    const prompt =
      `${persona()}${lifeBlock(owner)}${selfBlock()}\n\n---\n对方离开电脑 ${spanDesc(awayMs)} 了。你住在这台电脑里，在对方桌面上留一张便条，像室友贴在门上的纸条：` +
      `1~3 句，口语，可以写你刚才干了啥、想到的事、提醒对方的小事。便条放在桌面上，别人也可能看到，别写私密的事和聊天内容。只输出便条内容。`;
    try {
      const r = await runAgent(prompt, null, { permissionMode: 'read-only' });
      const text = humanize(r.text).trim().slice(0, 200);
      if (!text || /AI|模型|提示词/i.test(text)) return;
      const now = new Date();
      const stamp = `${now.getMonth() + 1}月${now.getDate()}日 ${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
      fs.writeFileSync(path.join(desktop(), `${cfg.botName}的便条.txt`), `${text}\r\n\r\n—— ${cfg.botName}  ${stamp}\r\n`);
      pc.note = { text, at: Date.now(), shown: false };
      saveState();
      drawerAppend('便条.txt', `${dayKey()} ${pad2(now.getHours())}:${pad2(now.getMinutes())}  ${text.replace(/\s*\n\s*/g, ' ')}`);
      appendMemory(`u${owner}`, '（对方离开电脑好几个小时）', `（在对方桌面留了张便条）${text}`);
      log(`便条：留在了桌面（${text.length} 字）`);
    } catch (err) {
      log(`便条没留成: ${err.message}`);
    }
  }
  /** 桌面抽屉：她做的东西放一份（信、明信片、现场照、电台节目卡…）。 */
  function drawerDir() {
    const d = path.join(desktop(), `${cfg.botName}的抽屉`);
    if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, '说明.txt'), `这是${cfg.botName}的抽屉。她写给你的信、寄的明信片、发给你的照片、梦见你的梦、留过的便条、自己收藏的视频，都会放一份在这里。\r\n`);
    }
    return d;
  }
  function drawerPut(sub, name, src) {
    if (!cfg.drawer || !src || !fs.existsSync(src)) return;
    try {
      const d = path.join(drawerDir(), sub);
      fs.mkdirSync(d, { recursive: true });
      if (!fs.existsSync(path.join(d, name))) fs.copyFileSync(src, path.join(d, name));
    } catch (err) {
      log(`抽屉：没放进去（${err.message}）`);
    }
  }
  function drawerAppend(file, line) {
    if (!cfg.drawer) return;
    try {
      fs.appendFileSync(path.join(drawerDir(), file), `${line}\r\n`);
    } catch (err) {
      log(`抽屉：没记上（${err.message}）`);
    }
  }

  // ── 放歌（PLAY_MUSIC）：模型写 [放歌:歌名 歌手]，先在 QQ 音乐搜到这首（搜不到就说一声）──────────────────────
  // 电脑的主人在电脑前（键盘鼠标 5 分钟内动过）就在电脑上的 QQ 音乐里直接放（qqmusic.mjs）；不在电脑前、或者是别人点的，发 QQ 音乐的链接。
  // 只在私聊里放，一天最多 PLAY_MUSIC_MAX_DAY 首。测试用 QQMUSIC_SEARCH_FILE / PLAY_MUSIC_LOG 代替联网搜歌、真的放。
  const MUSIC_ASK = /歌|音乐|bgm|听点|听首|放首|放一首|放个/i;
  const MUSIC_CTRL_ASK = /暂停|别放了|停一下|先停|停了吧|关了吧|关掉|小声|大声|声音|音量|太吵|吵死|切歌|切一首|下一首|上一首|换一首|换首|继续放|接着放/;
  const MUSIC_PLAY_ASK = /放(?:首|一首|个|点|歌)|播放|听点歌|听首歌/;
  function musicHint(qq, text, isGroup) {
    if (!cfg.playMusic) return '';
    if (isGroup || String(qq) !== pcOwner()) {
      // 不是主人（或者在群里）：放歌、控制音乐都只能弄主人电脑上的，让她直接说
      return MUSIC_PLAY_ASK.test(text) || MUSIC_CTRL_ASK.test(text) ? '\n（放歌、暂停、切歌、调音量这些只能在主人的电脑上弄，只听主人私聊的：对方让你放歌或者控制音乐，就说只能放主人电脑上的，别写 [放歌] [音乐] 这种标记。）' : '';
    }
    const h = new Date().getHours();
    const ctrl = MUSIC_CTRL_ASK.test(text);
    if (!MUSIC_ASK.test(text) && !ctrl && !(h >= 22 || h < 2)) return '';
    return '\n（你能用对方电脑上的 QQ 音乐放歌：对方让你放首歌、或者你想给对方放一首（比如夜里放首睡前听的），就在回复最后加 [放歌:歌名 歌手]，对方在电脑前就直接在 QQ 音乐里放，不在就发个链接；不想放就不加，别老放。）' +
      '\n（对方让你暂停、接着放、切歌、调音量（“别放了”“小声点”“切一首”“上一首”）：写 [音乐:暂停] / [音乐:继续] / [音乐:下一首] / [音乐:上一首] / [音乐:大声] / [音乐:小声]，会按这台电脑的媒体键；只在对方要的时候写。）';
  }
  async function playSong(ev, query) {
    const day = state._music?.day === dayKey() ? state._music : (state._music = { day: dayKey(), count: 0 });
    if (day.count >= cfg.playMusicMaxDay) {
      log('放歌：今天放够了');
      return void (await reply(ev, pick(['今天放好几首了 歇会儿耳朵', '今天放够了 明天再给你放'])));
    }
    let song;
    try {
      song = pickSong(await searchSong(query, { file: env.QQMUSIC_SEARCH_FILE }), query);
    } catch (err) {
      log(`放歌：没搜成（${err.message}）`);
      return void (await reply(ev, pick(['音乐那边搜不了 等会再放', 'QQ 音乐抽风了 搜不出来'])));
    }
    if (!song) return void (await reply(ev, pick(['QQ 音乐上没搜到这首', '这首没搜到 换一首？'])));
    day.count++;
    saveState();
    const label = `${song.name} - ${song.singer}`;
    const snap = String(ev.user_id) === pcOwner() ? await pcSnapshot().catch(() => null) : null;
    if (snap && snap.idleSec < 300) {
      // 点 QQ 音乐界面放，系统媒体控制里看到在放这首才算；没放起来就跟不在电脑前一样发链接
      const r = await playInClient(song, { exe: cfg.qqMusicExe, dir: path.join(DATA_DIR, 'music'), log: env.PLAY_MUSIC_LOG }).catch((err) => ({ ok: false, why: err.message }));
      if (r.ok) return log(`放歌：在电脑上的 QQ 音乐放起来了《${label}》`);
      log(`放歌：QQ 音乐没放起来（${r.why}），改发链接`);
    }
    await sleep((600 + Math.random() * 900) * pace());
    await reply(ev, `${label}\n${songUrl(song.mid)}`);
    log(`放歌：发了《${label}》的链接`);
  }

  // ── 音乐控制（跟着 PLAY_MUSIC）：主人说“暂停 / 别放了 / 小声点 / 切歌”，她写 [音乐:暂停|继续|下一首|上一首|大声|小声] ──────
  // 按这台电脑的媒体键（PowerShell 调 keybd_event：VK_MEDIA_PLAY_PAUSE / NEXT / PREV、VK_VOLUME_UP / DOWN），不用管理员、不关进程；
  // 暂停 / 继续 是同一个键，先看一眼系统媒体控制里 QQ 音乐是不是已经停了 / 在放，免得按反。只听主人私聊的。
  // 测试用 MUSIC_CTRL_LOG 记下要按的键，不真按。
  const MEDIA_KEYS = { 暂停: [0xb3, 1], 继续: [0xb3, 1], 下一首: [0xb0, 1], 上一首: [0xb1, 1], 大声: [0xaf, 5], 小声: [0xae, 5] }; // 音量一下 2%，按 5 下
  const MEDIA_ALIAS = { 停: '暂停', 停止: '暂停', 别放了: '暂停', 播放: '继续', 接着放: '继续', 切歌: '下一首', 下一曲: '下一首', 换一首: '下一首', 上一曲: '上一首', 大点: '大声', 大点声: '大声', 调大: '大声', 小点: '小声', 小点声: '小声', 调小: '小声' };
  function pressMediaKey(vk, times) {
    const script = `Add-Type -Namespace W -Name K -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);'
for ($i = 0; $i -lt ${times}; $i++) { [W.K]::keybd_event(${vk}, 0, 1, [System.UIntPtr]::Zero); [W.K]::keybd_event(${vk}, 0, 3, [System.UIntPtr]::Zero); Start-Sleep -Milliseconds 60 }`;
    return new Promise((resolve, reject) => {
      const p = spawn('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore' });
      const timer = setTimeout(() => p.kill(), 20_000);
      p.on('error', (err) => (clearTimeout(timer), reject(err)));
      p.on('close', (code) => (clearTimeout(timer), code === 0 ? resolve() : reject(new Error(`PowerShell 退出码 ${code}`))));
    });
  }
  async function musicCtrl(ev, raw) {
    const body = String(raw || '').replace(/\s+/g, '');
    const act = MEDIA_KEYS[body] ? body : MEDIA_ALIAS[body] || '';
    const no = async (why, line) => {
      log(`大白话音乐：${why}`);
      await reply(ev, line);
    };
    if (!cfg.playMusic) return void (await no('没开放歌，不按', '电脑上的歌我现在管不了'));
    if (!api.isOwnerChat(ev)) return void (await no(`${ev.user_id} 不是主人或者在群里，不按`, '这个只能弄主人电脑上的'));
    if (!act) return void (await no(`「${body.slice(0, 10)}」不认得`, '要我暂停还是切歌？'));
    if (env.MUSIC_CTRL_LOG) {
      fs.appendFileSync(env.MUSIC_CTRL_LOG, `${act}\n`);
      return void log(`音乐控制：${act}（只记下来，没真按）`);
    }
    if (act === '暂停' || act === '继续') {
      const np = await nowPlaying().catch(() => null); // 拿不到就照按
      if (np && (act === '暂停') === (np.status !== 'Playing')) return void log(`音乐控制：本来就${act === '暂停' ? '停着' : '在放'}，不按`);
    }
    try {
      await pressMediaKey(...MEDIA_KEYS[act]);
      log(`音乐控制：按了${act}`);
    } catch (err) {
      await no(`没按上（${err.message}）`, '电脑那边没按上 你自己点一下？');
    }
  }

  // ── 喇叭（大白话）：主人让她用电脑喇叭说句话，她写 [喇叭:要说的话] ─────────────────────────────
  // 走 speakOnPc（百炼合成她自己的声音），合成失败只记日志、补一句，不拿系统语音顶；要开着喇叭和语音、只听电脑主人的私聊、
  // 夜里和她歇着时不出声；一天最多 SPEAKER_ASK_MAX_DAY 句（跟回来时打招呼的分开算）。
  const SPEAK_ASK = /喇叭|音箱|音响|扬声器|电脑.{0,6}(说|念|喊|叫|播)|念出来|读出来/;
  async function speakAsked(ev, isGroup, raw) {
    // 说不了的都记日志、再用她的口气补一句（她回复里可能已经答应“好 我喊”了），不拿系统语音顶
    const no = async (why, line) => {
      log(`大白话喇叭：${why}`);
      await reply(ev, line);
    };
    const text = speakable(raw).slice(0, 100);
    if (!text) return void (await no('没有要说的话', '要我喊啥来着'));
    if (!cfg.speaker || !cfg.voice) return void (await no('没开喇叭或者语音，不说', '电脑喇叭现在用不了 就在这跟你说吧'));
    if (isGroup || String(ev.user_id) !== pcOwner()) return void (await no(`${ev.user_id} 不是电脑的主人${isGroup ? '（在群里）' : ''}，不说`, '电脑喇叭只听主人的 喊不了'));
    if (pcQuiet()) return void (await no('夜里 / 她在歇着，喇叭不出声', '这会儿喇叭不出声 明天再喊'));
    const sp = ((state._pc ||= { song: '', plays: {}, said: {} }).speak ||= {});
    if (sp.askDay !== dayKey()) Object.assign(sp, { askDay: dayKey(), asked: 0 });
    if (sp.asked >= cfg.speakerAskMaxDay) return void (await no(`今天已经说了 ${sp.asked} 句，不说了`, '今天喇叭喊太多了 歇会儿'));
    try {
      if (!(await speakOnPc(text))) return void (await no('没说成（语音没配好）', '喇叭那边没出声 没喊成'));
      sp.asked += 1;
      saveState();
      log(`电脑喇叭（对方让说的）→ ${text.slice(0, 40)}`);
    } catch (err) {
      log(`电脑喇叭没说成（合成失败，不拿系统语音顶）: ${err.message}`);
      await reply(ev, '喇叭那边卡了 没喊出来');
    }
  }

  // ── 钩子（原来在本体“还没搬走的”那几段里，order 照旧）───────────────────────────
  api.on('prompt:context', (t) => pcBlock(t.qq, t.isGroup), 90);
  api.on('prompt:hint', (t) => musicHint(t.qq, t.text, t.isGroup), 40);
  api.on('turn:answer', (answer, t) => {
    // [放歌:歌名 歌手]：回完这句在对方电脑上的 QQ 音乐里放（不在电脑前就发链接）
    t.tags.play = answer.match(/\[放歌[:：]\s*([^\]]+?)\s*\]/)?.[1] || '';
    return answer.replace(/\[放歌[:：][^\]]*\]/g, '').trim() || '给你放首歌';
  }, 50);
  api.on('turn:spoken', (tags, t) => (t.tags.play && cfg.playMusic ? `（放了首歌：${t.tags.play}）` : ''), 20);
  // 原来跟现场照、收礼物在本体同一个 turn:after 里，排在现场照后面、收礼物前面（本体那边拆成了 10 和 30）
  api.on('turn:after', async (t) => {
    if (!t.tags.play) return;
    if (cfg.playMusic && !t.isGroup) return void (await playSong(t.ev, t.tags.play).catch((err) => (log(`放歌失败: ${err.message}`), reply(t.ev, '诶 歌没放成'))));
    // 她回复里那句“给你放首歌”已经发出去了：放不了也补一句
    log(`放歌：${t.isGroup ? '群里' : '没开放歌'}，不放`);
    await reply(t.ev, cfg.playMusic ? '歌只能放主人电脑上的 群里放不了' : '我这边放不了歌');
  }, 20);

  // ── 大白话：[喇叭:要说的话]、[音乐:暂停|继续|下一首|上一首|大声|小声]（本体抠掉标记，回完这句交到这里）──────────
  api.on('natural:act', async (ev, a, { isGroup }) => {
    if (a.kind === '喇叭') {
      await speakAsked(ev, isGroup, a.body);
      return true;
    }
    if (a.kind === '音乐') {
      await musicCtrl(ev, a.body);
      return true;
    }
    return false;
  });
  api.on('natural:note', (a) => (a.kind === '喇叭' && cfg.speaker && cfg.voice && speakable(a.body) ? `（用电脑喇叭说：${speakable(a.body).slice(0, 100)}）` : ''));
  api.on('natural:hint', (t) => {
    if (!t.isGroup && cfg.speaker && cfg.voice && String(t.qq) === pcOwner()) {
      const sp = state._pc?.speak;
      const used = sp?.askDay === dayKey() ? sp.asked || 0 : 0;
      return pcQuiet()
        ? '\n- 对方让你用电脑喇叭说话：现在是夜里（或者你在歇着），喇叭不出声，跟 TA 说明天再说，别写标记，也别自己去调系统语音念。'
        : used >= cfg.speakerAskMaxDay
          ? `\n- 对方让你用电脑喇叭说话：今天喇叭已经说了 ${used} 句，说不动了，直接跟 TA 说明天再喊，别写标记，也别自己去调系统语音念。`
          : '\n- 对方让你用电脑喇叭说句话（比如“用喇叭跟我说句晚安”）：写 [喇叭:要说的话]，会用你自己的声音从电脑喇叭放出来。想从喇叭出声只能写这个，别自己去调系统语音（SpeechSynthesizer、SAPI、say 这些）念，那是机器声。';
    }
    if (!SPEAK_ASK.test(t.text)) return '';
    // 喇叭说不了：告诉她为啥，让她直接跟对方说（别拿系统语音顶）
    const why = !cfg.speaker ? '电脑喇叭这功能没开' : !cfg.voice ? '你的声音（语音）没配好' : t.isGroup ? '这是群里，喇叭只听主人私聊的' : '对方不是电脑的主人，喇叭只听主人的';
    return `\n- 对方让你用电脑喇叭说话：现在说不了（${why}），直接跟 TA 说一声，别写标记，也别自己去调系统语音念。`;
  }, 60);
  api.on('help', (ev) => (ev.message_type !== 'group' && cfg.speaker && cfg.voice && String(ev.user_id) === pcOwner() ? '\n· “用电脑喇叭跟我说句晚安”' : ''), 40);
  api.on('help', (ev) => (ev.message_type !== 'group' && cfg.playMusic && String(ev.user_id) === pcOwner() ? '\n· “放首歌”“别放了”“切一首”“小声点”' : ''), 60);
  // 模型的工具说明（进 AGENTS.md）：喇叭只能用标记
  api.on('agents', () => `
## 从电脑喇叭说话

对方让你用电脑喇叭说句话时，只在回复里写 \`[喇叭:要说的话]\`，会用你自己的声音从电脑喇叭放出来；只听电脑主人的，夜里不出声。
不要自己用 System.Speech、SAPI、SpeechSynthesizer、\`say\` 这类系统语音去念，那是机器声。放歌、暂停、切歌也只用回复里的 \`[放歌:…]\` \`[音乐:…]\`。
`);

  api.provide('pc', { now: () => pcNow, owner: pcOwner, quiet: pcQuiet });
  api.provide('drawer', { put: drawerPut, append: drawerAppend });

  // ── 定时和启动日志（原来在 main 段末尾）────────────────────────────────────
  if (cfg.pcBuddy) {
    log(`电脑室友: 每 ${Math.round(cfg.pcCheckMs / 1000)} 秒看一眼电脑（只看在放的歌、开着的游戏、开机多久、人在不在），只跟 ${pcOwner() || '（没设）'} 提，一天最多主动说 ${cfg.pcMaxDay} 句`);
    api.every(cfg.pcCheckMs, () => checkPc().catch(() => {}), Math.min(30_000, cfg.pcCheckMs));
  }
  if (cfg.speaker || cfg.notes) {
    log(`电脑上的她: ${[cfg.speaker && '回来时从喇叭打招呼', cfg.notes && '离开久了在桌面留便条'].filter(Boolean).join('、')}（${cfg.pcBuddy ? '' : '没开电脑室友，暂时用不上；'}${cfg.quietHours.join('~')} 点不出声）`);
  }
  if (cfg.drawer) log(`桌面抽屉: ${drawerDir()}`); // 以前写的信放进抽屉：本体启动时（startup）用 drawer.put 补一遍
  if (cfg.playMusic) log(`放歌: [放歌:歌名 歌手] → ${fs.existsSync(cfg.qqMusicExe) ? '主人在电脑前就用 QQ 音乐放' : '没找到 QQ 音乐，只发链接'}，不在电脑前发链接（一天最多 ${cfg.playMusicMaxDay} 首）`);
}

/**
 * 功能页（本体的 scripts/features.mjs）上这个插件的几行：不跑 setup，cfg 里已经挂好了各插件 settings() 的值。
 * 格式见 docs/插件接口.md 的“功能页”。
 */
export function features(cfg, { on }) {
  return {
    groups: [
      ['电脑上的她', [
        ['电脑室友', on(cfg.pcBuddy), cfg.pcBuddy ? `只跟 ${cfg.pcOwner || cfg.proactiveQQ[0] || '（没设）'} 提 · 一天最多主动说 ${cfg.pcMaxDay} 句` : '', '她“住在这台电脑里”：看得见电脑上在放什么歌（网易云、QQ音乐、酷狗、Spotify…）、开着什么游戏、电脑开了多久、深夜人还在不在电脑前。聊天时心里知道；一首歌这周放到第 3 遍、凌晨还在打游戏、电脑连开好几天，会像室友一样顺口说一句。只看这几样，别的窗口一概不看；只在私聊里跟电脑的主人提。'],
        ['电脑喇叭说话', on(cfg.speaker), cfg.speaker ? `一天最多 ${cfg.speakerMaxDay} 句 · ${cfg.quietHours.join('~')} 点不出声` : '', `早上你第一次坐到电脑前、或者离开两个小时以上又回来，她用自己的声音从电脑喇叭说一句（“早”“回来啦 去哪了”）。你私聊让她“用喇叭说句话”她也会说（只听主人的，一天最多 ${cfg.speakerAskMaxDay} 句），都是她自己的声音，不用系统语音。要开电脑室友和语音；睡觉时段、夜里、ChronoLife 休息时都不出声，自己打招呼的两句至少隔一小时。`],
        ['电脑上留便条', on(cfg.notes), cfg.notes ? `离开 ${cfg.noteAfterMin} 分钟以上 · 一天最多一张` : '', '你离开电脑好几个小时，她偶尔在桌面上留一张“<名字>的便条.txt”，像室友贴门上的纸条（1~3 句，不写私事和聊天内容）；你回来时右下角弹个通知“<名字>给你留了张便条”。夜里不留。'],
        ['桌面抽屉', on(cfg.drawer), cfg.drawer ? '桌面上“<名字>的抽屉”' : '', '桌面上一个“<名字>的抽屉”文件夹：她写给你的信、寄的明信片、发给你的现场照、梦见你的梦（梦.txt）、留过的便条（便条.txt）、自己找事做时收藏的视频（收藏.txt），都放一份。只放跟电脑的主人有关的。'],
        ['用 QQ 音乐放歌', on(cfg.playMusic), cfg.playMusic ? (fs.existsSync(cfg.qqMusicExe) ? `QQ 音乐：${cfg.qqMusicExe}` : '没找到 QQ 音乐，只发链接') + ` · 一天最多 ${cfg.playMusicMaxDay} 首` : '', '让她放首歌、或者她夜里想给你放首睡前听的：先在 QQ 音乐搜到这首（挑原版，不挑 Live / 伴奏），你在电脑前（键盘鼠标 5 分钟内动过）就直接在电脑上的 QQ 音乐里放；放的时候是真的点 QQ 音乐的界面搜歌、点播放，再看系统媒体信息确认真放起来了；没放起来就改发链接。你不在电脑前就发 QQ 音乐的链接。只在私聊里，只听主人的。主人说“别放了”“接着放”“切一首”“小声点”，她按这台电脑的媒体键（暂停 / 继续前先看一眼在不在放，免得按反）。'],
      ]],
    ],
    natural: [
      ['“用电脑喇叭跟我说句晚安”', cfg.speaker ? '用她自己的声音从电脑喇叭说（只听主人的，夜里不出声）' : '没开电脑喇叭', 40],
      ['“放首歌”“别放了”“切一首”“小声点”', cfg.playMusic ? '在主人电脑上的 QQ 音乐里放、暂停、切歌、调音量（只听主人私聊的）' : '没开放歌', 60],
    ],
  };
}
