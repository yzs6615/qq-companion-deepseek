/**
 * 天气：Open-Meteo（免费，不要 key）。城市名 → 经纬度 → 今天/明天的天气，缓存 2 小时。
 * 只给聊天当背景：下雨、降温、很热很冷这种“值得顺口提一句”的会标出来。
 */
const GEO = process.env.WEATHER_GEO_API || 'https://geocoding-api.open-meteo.com/v1/search';
const API = process.env.WEATHER_API || 'https://api.open-meteo.com/v1/forecast';

const WMO = {
  0: '晴', 1: '晴', 2: '多云', 3: '阴', 45: '雾', 48: '雾',
  51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨', 56: '冻雨', 57: '冻雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪', 80: '阵雨', 81: '阵雨', 82: '暴雨',
  85: '阵雪', 86: '阵雪', 95: '雷阵雨', 96: '雷阵雨', 99: '雷阵雨',
};
const WET = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99]);
const cache = new Map(); // city -> { at, data }

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** 城市名 → { name, lat, lon }；找不到返回 null。 */
export async function geocode(city) {
  const j = await getJson(`${GEO}?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`);
  const g = j?.results?.[0];
  return g ? { name: g.name || city, lat: g.latitude, lon: g.longitude } : null;
}

/** 取天气（2 小时内用缓存）。返回 { city, now, today, tomorrow }；失败抛错。 */
export async function getWeather(city, maxAgeMs = 2 * 3600_000) {
  const key = String(city || '').trim();
  if (!key) return null;
  const c = cache.get(key);
  if (c && Date.now() - c.at < maxAgeMs) return c.data;
  const g = await geocode(key);
  if (!g) throw new Error(`找不到城市：${key}`);
  const q = new URLSearchParams({
    latitude: String(g.lat), longitude: String(g.lon), timezone: 'auto', forecast_days: '2',
    current: 'temperature_2m,weather_code',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
  });
  const j = await getJson(`${API}?${q}`);
  const d = j.daily || {};
  const day = (i) => ({ code: d.weather_code?.[i], desc: WMO[d.weather_code?.[i]] || '', tmax: Math.round(d.temperature_2m_max?.[i]), tmin: Math.round(d.temperature_2m_min?.[i]), pop: d.precipitation_probability_max?.[i] ?? null });
  const data = {
    city: key,
    now: { temp: Math.round(j.current?.temperature_2m), desc: WMO[j.current?.weather_code] || '' },
    today: day(0),
    tomorrow: day(1),
  };
  cache.set(key, { at: Date.now(), data });
  return data;
}

/** 缓存里有就直接给（不发请求）；聊天提示词是同步拼的，用这个。 */
export function cachedWeather(city) {
  return cache.get(String(city || '').trim())?.data || null;
}

/** 值得顺口提一句的：下雨下雪、降温/升温明显、很热、很冷。 */
export function notable(w) {
  if (!w) return [];
  const out = [];
  const wet = (x) => WET.has(x.code) || (x.pop ?? 0) >= 60;
  if (wet(w.today)) out.push(`今天有${w.today.desc || '雨'}`);
  else if (wet(w.tomorrow)) out.push(`明天有${w.tomorrow.desc || '雨'}`);
  if (Number.isFinite(w.tomorrow.tmax) && w.tomorrow.tmax <= w.today.tmax - 6) out.push('明天降温');
  if (Number.isFinite(w.tomorrow.tmax) && w.tomorrow.tmax >= w.today.tmax + 6) out.push('明天升温');
  if (w.today.tmax >= 35) out.push('今天很热');
  if (w.today.tmin <= 0) out.push('今天很冷');
  return out;
}

/** 一句话：“杭州今天小雨 12~18℃（降水 80%），现在 15℃；明天多云 10~16℃” */
export function describe(w) {
  if (!w) return '';
  const t = w.today;
  const m = w.tomorrow;
  const pop = t.pop !== null && t.pop !== undefined ? `（降水 ${t.pop}%）` : '';
  return `${w.city}今天${t.desc} ${t.tmin}~${t.tmax}℃${pop}，现在 ${w.now.temp}℃；明天${m.desc} ${m.tmin}~${m.tmax}℃`;
}
