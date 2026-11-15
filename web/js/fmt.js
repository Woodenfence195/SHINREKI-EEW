// Shared formatting helpers (times are unix seconds, displayed in JST)
export const JST_OFFSET = 9 * 3600;

const pad2 = (n) => String(n).padStart(2, '0');

export function jstParts(ts) {
  const d = new Date((ts + JST_OFFSET) * 1000);
  return {
    y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(),
    hh: d.getUTCHours(), mm: d.getUTCMinutes(), ss: d.getUTCSeconds(),
    wd: d.getUTCDay(),
    date: `${d.getUTCFullYear()}.${pad2(d.getUTCMonth() + 1)}.${pad2(d.getUTCDate())}`,
    day: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`,
    clock: `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`,
    hm: `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`,
  };
}

export function fmtTime(ts, seconds = true) {
  if (!ts) return '--:--';
  const p = jstParts(ts);
  return seconds ? p.clock : p.hm;
}

export function fmtDate(ts) {
  if (!ts) return '----.--.--';
  return jstParts(ts).date;
}

export function fmtStamp(ts) {
  if (!ts) return '--';
  const p = jstParts(ts);
  return `${p.day} ${p.hm}:${pad2(p.ss)}`;
}

export function relTime(ts) {
  const diff = Date.now() / 1000 - ts;
  if (diff < 45) return '刚刚';
  if (diff < 3600) return `${Math.round(diff / 60)} 分钟前`;
  if (diff < 86400) return `${(diff / 3600).toFixed(diff < 7200 ? 1 : 0)} 小时前`;
  return `${Math.round(diff / 86400)} 天前`;
}

export function fmtMag(m) {
  if (m === null || m === undefined) return 'M —';
  return `M${Number(m).toFixed(1)}`;
}

export function fmtDepth(d) {
  if (d === null || d === undefined) return '—';
  return `${Math.round(Number(d))} km`;
}

export function intensityLabel(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  const x = Number(v);
  if (x < 0.5) return '0';
  if (x < 1.5) return '1';
  if (x < 2.5) return '2';
  if (x < 3.5) return '3';
  if (x < 4.5) return '4';
  if (x < 5.25) return '5弱';
  if (x < 5.75) return '5強';
  if (x < 6.25) return '6弱';
  if (x < 6.75) return '6強';
  return '7';
}

export function intensityClass(v) {
  const label = intensityLabel(v);
  return { '0': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5弱': 5, '5強': 5.5, '6弱': 6, '6強': 6.5, '7': 7 }[label] ?? 0;
}

export function fmtBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export function debounce(fn, wait = 200) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

export function el(tag, cls, html) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (html !== undefined) node.innerHTML = html;
  return node;
}
