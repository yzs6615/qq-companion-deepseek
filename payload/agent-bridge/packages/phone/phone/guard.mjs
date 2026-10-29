/**
 * 手机的“别做”清单：phone.mjs 发给手机的每条 adb shell 命令先过这里。
 * 拦的是：打电话、发短信/替人发消息、卸载/装应用、清数据、改系统设置、删文件、重启，
 * 还有参数里夹 shell 特殊字符（; | & ` $ 换行）想顺带跑别的命令的。
 * 纯函数，不连手机，方便测试（test/phone-guard.mjs）。
 */

// 打电话 / 发消息 / 删东西的 intent
const BAD_ACTIONS =
  /android\.intent\.action\.(call|call_privileged|call_emergency|dial|send|sendto|send_multiple|respond_via_message|delete|uninstall_package|install_package|factory_reset|master_clear|reboot)\b/i;
// 打电话 / 发短信 / 发邮件的链接
const BAD_URIS = /(^|[\s"'=])(tel|sms|smsto|mms|mmsto|mailto|wtai|voicemail):/i;

const RULES = [
  [/\bam\s+(start|start-activity|startservice|start-service|start-foreground-service|broadcast)\b[\s\S]*/i, (s) => (BAD_ACTIONS.test(s) || BAD_URIS.test(s) ? '不打电话、不替主人发消息（拨号 / 发短信 / 分享发送这类 intent 一律不发）' : null)],
  [/\b(pm|cmd\s+package)\s+(uninstall|install|install-create|install-write|install-commit|install-existing|clear|disable|disable-user|disable-until-used|hide|suspend|grant|revoke|reset-permissions|set-install-location)\b/i, () => '不装卸应用、不清应用数据、不改应用权限'],
  [/\bservice\s+call\s+(phone|isms|imms|iphonesubinfo|telecom)\b/i, () => '不打电话、不发短信'],
  [/\btelecom\s+/i, () => '不打电话'],
  [/\bcontent\s+(insert|update|delete|call)\b/i, () => '不改手机里的数据（短信、联系人、设置都在这里面）'],
  [/\bsettings\s+(put|delete|reset)\b/i, () => '不改系统设置'],
  [/\b(svc|setprop|dpm|reboot|wipe|recovery)\b/i, () => '不改系统设置、不重启手机'],
  [/\bcmd\s+(wifi|bluetooth_manager|connectivity|phone|statusbar\s+expand-settings)\b/i, () => '不改系统设置'],
  [/\bwm\s+(size|density)\s+\S/i, () => '不改屏幕分辨率这类系统设置'],
  [/\b(rm|rmdir|mv|dd|mkfs|chmod|chown)\s/i, () => '不删、不改手机上的文件'],
];

// 键码：5 = 拨号键（CALL）
const BAD_KEYS = new Map([
  [5, '不打电话（CALL 键会直接拨号）'],
]);

/**
 * 检查一条要发给手机的 adb 命令（不带 -s 序列号），没问题返回 null，要拦就返回中文原因。
 * args 例：['shell', 'input', 'tap', '540', '1600']、['exec-out', 'screencap', '-p']、['uninstall', 'com.x']
 */
export function checkAdb(args) {
  const [head, ...rest] = args.map(String);
  if (/^(uninstall|install|install-multiple|install-multi-package|reboot|sideload|root|remount|disable-verity|push|forward|reverse)$/i.test(head || '')) {
    if (head === 'install' && rest.some((a) => /ADBKeyboard\.apk$/i.test(a))) return null; // install-ime 装中文输入法，主人装机时用
    return `adb ${head} 不让用：不装卸应用、不往手机里塞东西、不重启`;
  }
  if (head !== 'shell' && head !== 'exec-out') return null;
  return checkShell(rest);
}

/** 检查 adb shell 后面那一串（手机上会拼成一行交给 sh 跑）。 */
export function checkShell(args) {
  const toks = args.map(String);
  // input text 的内容 phone.mjs 已经转义过了，只要求特殊字符前面都带反斜杠、没有换行
  const textAt = toks[0] === 'input' && toks[1] === 'text' ? 2 : -1;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (/[\r\n]/.test(t)) return '参数里有换行，可能夹带了别的命令，不执行';
    if (i >= textAt && textAt >= 0) {
      if (/(^|[^\\])[;&|`$<>()]/.test(t)) return '要输入的文字里有没转义的特殊字符，不执行';
      continue;
    }
    if (/[;&|`$<>]|\$\(/.test(t)) return `参数“${t.slice(0, 40)}”里有 ; | & \` $ 这类字符，可能夹带了别的命令，不执行`;
  }
  // 要输入的文字不参与下面的检查（打出“pm uninstall”几个字不算卸载）
  const line = (textAt >= 0 ? toks.slice(0, textAt) : toks).join(' ');
  for (const [re, why] of RULES) {
    const m = line.match(re);
    if (!m) continue;
    const reason = why(m[0]);
    if (reason) return reason;
  }
  const key = line.match(/\binput\s+keyevent\s+(?:--longpress\s+)?(\S+)/i);
  if (key) {
    const k = key[1].toUpperCase().replace(/^KEYCODE_/, '');
    const code = /^\d+$/.test(k) ? Number(k) : k === 'CALL' ? 5 : null;
    if (BAD_KEYS.has(code)) return BAD_KEYS.get(code);
  }
  return null;
}

/** key 命令：按键码查。 */
export function checkKey(code) {
  return BAD_KEYS.get(Number(code)) || null;
}

// find --tap 不点这些字样的按钮（付钱、打电话、删东西、卸载）。发消息不在这里拦：主人点头了可以发
const BAD_TAP = /^(转账|付款|支付|立即支付|确认支付|确认付款|确定支付|免密支付|红包|发红包|塞钱进红包|拨打|呼叫|拨号|打电话|视频通话|语音通话|删除|确认删除|彻底删除|清空|卸载|确认卸载|清除数据|清除缓存|恢复出厂设置)/i;

/** find --tap 前检查要点的那个按钮的字，要拦返回中文原因。 */
export function checkTapText(text) {
  const t = String(text || '').trim();
  if (BAD_TAP.test(t)) return `不点“${t.slice(0, 20)}”：付钱、打电话、删东西、卸载这类按钮要主人自己点`;
  return null;
}

/** 包名只能是 com.xxx.yyy 这种，防止夹带命令。 */
export const isPackageName = (s) => /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(String(s || ''));
/** 坐标、时长这类参数只能是数字。 */
export const isNum = (s) => /^-?\d+(\.\d+)?$/.test(String(s ?? ''));
