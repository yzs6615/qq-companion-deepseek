#!/usr/bin/env node
/**
 * Tiny ADB phone-control CLI (no dependencies).
 *
 *   node phone/phone.mjs devices
 *   node phone/phone.mjs shot [out.png]
 *   node phone/phone.mjs dump [--raw]
 *   node phone/phone.mjs find 微信 [--tap]
 *   node phone/phone.mjs tap 540 1600
 *   node phone/phone.mjs swipe 540 1800 540 600 300
 *   node phone/phone.mjs scroll down 3
 *   node phone/phone.mjs text "你好"
 *   node phone/phone.mjs key HOME
 *   node phone/phone.mjs open com.tencent.mm
 *   node phone/phone.mjs unlock
 *   node phone/phone.mjs info
 *
 * Env: ADB=<path to adb>, ANDROID_SERIAL=<serial>, PHONE_SHOT_DIR=<dir>
 *
 * 发给手机的每条命令先过 guard.mjs：打电话、发短信、卸载/装应用、清数据、改系统设置、删文件、
 * 参数里夹 ; | & 这类字符的，一律拦下并说明原因（退出码 3）。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAdb, checkKey, checkTapText, isNum, isPackageName } from './guard.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// adb：.env 的 ADB 优先，其次插件旁边的 tools/platform-tools，再不然用 PATH 里的 adb
const LOCAL_ADB = path.join(ROOT, 'tools', 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
const ADB = process.env.ADB || (fs.existsSync(LOCAL_ADB) ? LOCAL_ADB : 'adb');
const DATA_DIR = process.env.BRIDGE_DATA ? path.resolve(process.env.BRIDGE_DATA) : path.join(ROOT, 'data');
const SHOT_DIR = process.env.PHONE_SHOT_DIR || path.join(DATA_DIR, 'shots');
const DRY = process.argv.includes('--dry-run');

const KEYCODES = {
  HOME: 3,
  BACK: 4,
  CALL: 5,
  ENDCALL: 6,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  POWER: 26,
  CAMERA: 27,
  MENU: 82,
  NOTIFICATION: 83,
  SEARCH: 84,
  ENTER: 66,
  DEL: 67,
  TAB: 61,
  SPACE: 62,
  ESCAPE: 111,
  WAKEUP: 224,
  SLEEP: 223,
  APP_SWITCH: 187,
};

function fail(msg) {
  console.error(`phone: ${msg}`);
  process.exit(1);
}
// 被“别做”清单拦下：原因打到 stdout（模型看得到），退出码 3，跟普通出错分开
function refuse(why) {
  console.log(`phone: 不执行——${why}。`);
  process.exit(3);
}
function adbArgs(args, { binary = false } = {}) {
  const why = checkAdb(args);
  if (why) refuse(why);
  const full = [...(process.env.ANDROID_SERIAL ? ['-s', process.env.ANDROID_SERIAL] : []), ...args];
  if (DRY) {
    console.log(`${ADB} ${full.join(' ')}`);
    process.exit(0);
  }
  if (ADB !== 'adb' && !fs.existsSync(ADB)) fail(`找不到 adb: ${ADB}（在 .env 里设 ADB=adb 的完整路径）`);
  try {
    return execFileSync(ADB, full, {
      encoding: binary ? 'buffer' : 'utf8',
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (err) {
    const msg = (err.stderr || Buffer.from('')).toString().trim() || err.message;
    fail(`${msg}\n提示：adb 需要启动后台 daemon，当前 DSH 的 workspace-write 沙箱会拒绝；请让用户把权限切到 danger-full-access 后再试。`);
  }
}
const shell = (cmd, opts) => adbArgs(['shell', ...cmd.split(' ')], opts);
const sh = (args, opts) => adbArgs(['shell', ...args], opts);
const out = (s) => String(s).replace(/\r/g, '').trim();

function devices() {
  const text = out(adbArgs(['devices', '-l']));
  console.log(text);
  if (!/\bdevice\b/.test(text.replace(/List of devices attached/, ''))) {
    console.error('\n没有已授权的设备：请用 USB 连接手机、打开“开发者选项 → USB 调试”，手机上点允许。');
    process.exitCode = 2;
  }
}
function screenSize() {
  const m = out(shell('wm size')).match(/Override size: (\d+)x(\d+)|Physical size: (\d+)x(\d+)/);
  if (!m) return { w: 1080, h: 2400 };
  return { w: Number(m[1] || m[3]), h: Number(m[2] || m[4]) };
}
function saveShot(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const buf = adbArgs(['exec-out', 'screencap', '-p'], { binary: true });
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) fail('截图数据不是 PNG（换用 adb exec-out screencap -p 试试）');
  fs.writeFileSync(file, buf);
  console.log(file);
}
function shot(file) {
  const f = path.resolve(file || path.join(SHOT_DIR, `shot-${Date.now()}.png`));
  saveShot(f);
}
function dumpXml() {
  sh(['uiautomator', 'dump', '/sdcard/dsh_window.xml']);
  return out(adbArgs(['exec-out', 'cat', '/sdcard/dsh_window.xml']));
}
function parseNodes(xml) {
  const nodes = [];
  for (const m of xml.matchAll(/<node\b([^>]*)\/?>/g)) {
    const attrs = {};
    for (const a of m[1].matchAll(/([a-zA-Z0-9_:-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    const b = attrs.bounds?.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    nodes.push({
      text: (attrs.text || '').trim(),
      desc: (attrs['content-desc'] || '').trim(),
      cls: attrs.class || '',
      clickable: attrs.clickable === 'true',
      bounds: b ? { x1: +b[1], y1: +b[2], x2: +b[3], y2: +b[4] } : null,
    });
  }
  return nodes;
}
function dump(raw) {
  const xml = dumpXml();
  if (raw) {
    console.log(xml);
    return;
  }
  const nodes = parseNodes(xml).filter((n) => n.bounds && (n.text || n.desc));
  nodes.forEach((n, i) => {
    const b = n.bounds;
    const cx = Math.round((b.x1 + b.x2) / 2);
    const cy = Math.round((b.y1 + b.y2) / 2);
    console.log(`${String(i).padStart(2)}  [${cx},${cy}]  ${n.text || n.desc}${n.clickable ? '  (clickable)' : ''}`);
  });
  if (!nodes.length) console.log('（没有可见文本节点）');
}
function find(query, doTap) {
  const xml = process.env.PHONE_XML ? fs.readFileSync(process.env.PHONE_XML, 'utf8') : dumpXml();
  const q = query.toLowerCase();
  const hits = parseNodes(xml).filter(
    (n) => n.bounds && (n.text.toLowerCase().includes(q) || n.desc.toLowerCase().includes(q)),
  );
  if (!hits.length) fail(`没找到“${query}”`);
  hits.forEach((n) => {
    const b = n.bounds;
    const cx = Math.round((b.x1 + b.x2) / 2);
    const cy = Math.round((b.y1 + b.y2) / 2);
    console.log(`${n.text || n.desc}  ->  ${cx} ${cy}  (${b.x1},${b.y1})-(${b.x2},${b.y2})`);
  });
  if (doTap) {
    const why = checkTapText(hits[0].text || hits[0].desc) || checkTapText(query);
    if (why) refuse(why);
    const b = hits[0].bounds;
    sh(['input', 'tap', String(Math.round((b.x1 + b.x2) / 2)), String(Math.round((b.y1 + b.y2) / 2))]);
    console.log(`已点击：${hits[0].text || hits[0].desc}`);
  }
}
function tap(x, y) {
  if (!Number.isFinite(+x) || !Number.isFinite(+y)) fail('用法: tap <x> <y>');
  sh(['input', 'tap', String(x), String(y)]);
  console.log(`tap ${x} ${y}`);
}
function swipe(x1, y1, x2, y2, ms = 300) {
  if (![x1, y1, x2, y2, ms].every(isNum)) fail('用法: swipe x1 y1 x2 y2 [ms]（都得是数字）');
  sh(['input', 'swipe', String(x1), String(y1), String(x2), String(y2), String(ms)]);
  console.log(`swipe ${x1},${y1} -> ${x2},${y2} (${ms}ms)`);
}
function scroll(dir = 'down', times = 1) {
  const { w, h } = screenSize();
  const cx = Math.round(w / 2);
  const n = Math.max(1, Math.min(10, Number(times) || 1));
  for (let i = 0; i < n; i++) {
    if (dir === 'up') swipe(cx, Math.round(h * 0.3), cx, Math.round(h * 0.8), 250);
    else swipe(cx, Math.round(h * 0.8), cx, Math.round(h * 0.3), 250);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
}
function inputText(text) {
  if (!text) fail('用法: text <内容>');
  if (/[\r\n]/.test(text)) fail('text 里不能有换行，一次输一行');
  if (/[^\x00-\x7F]/.test(text)) {
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    sh(['am', 'broadcast', '-a', 'ADB_INPUT_B64', '--es', 'msg', b64]);
    console.log('已通过 ADBKeyboard 发送中文（若没输入，请先运行 ime 切到 ADBKeyboard）');
    return;
  }
  const escaped = text.replace(/ /g, '%s').replace(/([&|;<>()$`\\"'~*?[\]{}])/g, '\\$1');
  sh(['input', 'text', escaped]);
  console.log(`text ${text}`);
}
function key(name) {
  const code = KEYCODES[String(name).toUpperCase()] ?? (/^\d+$/.test(String(name)) ? Number(name) : null);
  if (!code) fail(`未知按键: ${name}（可用：${Object.keys(KEYCODES).join(', ')} 或 keycode 数字）`);
  const why = checkKey(code);
  if (why) refuse(why);
  sh(['input', 'keyevent', String(code)]);
  console.log(`key ${name} (${code})`);
}
function openApp(pkg) {
  if (!pkg) fail('用法: open <包名>');
  if (!isPackageName(pkg)) fail(`包名不对：${pkg}（要像 com.tencent.mm 这样）`);
  let comp = '';
  try {
    comp = out(shell(`cmd package resolve-activity --brief ${pkg}`)).split('\n').pop()?.trim() || '';
  } catch {}
  if (comp && comp.includes('/')) {
    sh(['am', 'start', '-n', comp]);
    console.log(`start ${comp}`);
  } else {
    sh(['monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1']);
    console.log(`monkey start ${pkg}`);
  }
}
function apps() {
  const text = out(shell('pm list packages -3'));
  console.log(text.split('\n').map((l) => l.replace('package:', '')).join('\n'));
}
function info() {
  const { w, h } = screenSize();
  console.log(`型号: ${out(shell('getprop ro.product.model'))}`);
  console.log(`系统: Android ${out(shell('getprop ro.build.version.release'))} (SDK ${out(shell('getprop ro.build.version.sdk'))})`);
  console.log(`分辨率: ${w}x${h}`);
  console.log(`电量: ${out(shell('dumpsys battery')).match(/level: (\d+)/)?.[1] ?? '?'}%`);
}
function screenState() {
  const text = out(shell('dumpsys power'));
  console.log(/mWakefulness=(\w+)/.exec(text)?.[1] || 'unknown');
}
function phoneStatus() {
  const power = out(shell('dumpsys power'));
  const wakefulness = /mWakefulness=(\w+)/.exec(power)?.[1] || 'unknown';
  const win = out(shell('dumpsys window'));
  const locked = /mDreamingLockscreen=true|mShowingLockscreen=true|isStatusBarKeyguard=true/.test(win);
  console.log(JSON.stringify({ screen: wakefulness === 'Awake' ? 'on' : 'off', locked, wakefulness }));
}
function wake(on) {
  if (on) {
    sh(['input', 'keyevent', '224']);
    sh(['input', 'keyevent', '82']);
  } else {
    sh(['input', 'keyevent', '223']);
  }
}
function unlock() {
  sh(['input', 'keyevent', '224']);
  sh(['wm', 'dismiss-keyguard']);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
  const { w, h } = screenSize();
  swipe(Math.round(w / 2), Math.round(h * 0.8), Math.round(w / 2), Math.round(h * 0.3), 250);
  const pin = process.env.PHONE_PIN || '';
  if (pin) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
    // 锁屏 PIN 框对 input text 不一定买账，用数字键更稳：0=7 … 9=16。
    for (const ch of pin) {
      if (ch >= '0' && ch <= '9') {
        sh(['input', 'keyevent', String(7 + Number(ch))]);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
      }
    }
    sh(['input', 'keyevent', '66']);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
  }
  const win = out(shell('dumpsys window'));
  const stillLocked = /mDreamingLockscreen=true|mShowingLockscreen=true|isStatusBarKeyguard=true/.test(win);
  console.log(
    pin
      ? `已亮屏、上滑并输入 PHONE_PIN${stillLocked ? '；但还显示锁屏，检查 PIN/锁屏方式' : '；已解锁'}`
      : '已亮屏并上滑；有 PIN 的话在 .env 设 PHONE_PIN，或手动 text <密码> + key ENTER',
  );
}
function imeList() {
  console.log(out(shell('ime list -s')));
}
function setIme(which = 'adb') {
  if (which === 'adb') sh(['ime', 'set', 'com.android.adbkeyboard/.AdbIME']);
  else if (/^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/.test(which)) sh(['ime', 'set', which]);
  else fail(`输入法 id 不对：${which}（先 ime 看列表）`);
  console.log('done');
}
function installIme() {
  const apk = process.env.ADB_KEYBOARD_APK || path.join(ROOT, 'tools', 'ADBKeyboard.apk');
  if (!fs.existsSync(apk)) fail(`找不到 ${apk}`);
  adbArgs(['install', '-r', apk]);
  sh(['ime', 'set', 'com.android.adbkeyboard/.AdbIME']);
  console.log('ADBKeyboard 已安装并切为当前输入法；现在 text 命令支持中文。');
}

const [cmd, ...rest] = process.argv.slice(2).filter((a) => a !== '--dry-run');
const flag = (name) => rest.includes(name);
const positional = rest.filter((a) => !a.startsWith('--'));

// 记一笔“刚刚有人在用手机”，bridge 的黑屏看门狗只在这之后才管锁屏（status/unlock 是看门狗自己调的，不算）
if (cmd && !DRY && !['status', 'unlock', 'devices', 'help', 'wait'].includes(cmd)) {
  try {
    const dataDir = DATA_DIR;
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'phone-used'), String(Date.now()));
  } catch {
    /* 写不了就算了 */
  }
}

switch (cmd) {
  case 'devices':
    devices();
    break;
  case 'shot':
  case 'screenshot':
    shot(positional[0]);
    break;
  case 'dump':
    dump(flag('--raw'));
    break;
  case 'find':
    if (!positional[0]) fail('用法: find <文字> [--tap]');
    find(positional[0], flag('--tap'));
    break;
  case 'tap':
    tap(positional[0], positional[1]);
    break;
  case 'swipe':
    swipe(positional[0], positional[1], positional[2], positional[3], positional[4] || 300);
    break;
  case 'scroll':
    scroll(positional[0] || 'down', positional[1] || 1);
    break;
  case 'text':
    inputText(positional.join(' '));
    break;
  case 'key':
    key(positional[0]);
    break;
  case 'open':
    openApp(positional[0]);
    break;
  case 'apps':
    apps();
    break;
  case 'info':
    info();
    break;
  case 'screen':
    if (positional[0] === 'on' || positional[0] === 'off') wake(positional[0] === 'on');
    else screenState();
    break;
  case 'status':
    phoneStatus();
    break;
  case 'unlock':
    unlock();
    break;
  case 'ime':
    if (positional[0]) setIme(positional[0]);
    else imeList();
    break;
  case 'install-ime':
    installIme();
    break;
  case 'wait':
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(positional[0] || 1000));
    break;
  default:
    console.log(
      [
        '用法: node phone/phone.mjs <command> [args]',
        '',
        '  devices            列出已连接手机',
        '  shot [file]        截图保存到 data/shots/，可用视觉模型看图',
        '  dump [--raw]       导出当前界面的文字节点与坐标',
        '  find <文字> [--tap] 按文字找节点（可点击）',
        '  tap x y            点击',
        '  swipe x1 y1 x2 y2 [ms]',
        '  scroll up|down [n] 滚动',
        '  text <内容>        输入文字（中文需 ADBKeyboard）',
        '  key <NAME|code>    按键（HOME/BACK/ENTER/...）',
        '  open <包名>        打开 App',
        '  apps               第三方 App 包名',
        '  info               型号/系统/分辨率/电量',
        '  screen [on|off]    亮屏/息屏',
        '  status             屏幕亮灭 + 是否锁屏（JSON）',
        '  unlock             亮屏 + 上滑；有 PIN 时读 .env 的 PHONE_PIN',
        '  ime [adb|<id>]     查看/切换输入法',
        '  install-ime        安装 ADBKeyboard 并设为输入法（中文输入）',
        '  wait [ms]',
        '',
        '全局: --dry-run 只打印 adb 命令，ANDROID_SERIAL 选择设备。',
      ].join('\n'),
    );
}
