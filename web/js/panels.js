// DOM rendering for the feed, focus panel, EEW banner, settings and chronicle.

import {
  fmtTime, fmtDate, relTime, fmtMag, fmtDepth, intensityLabel, fmtBytes, jstParts,
} from './fmt.js';
import { rampColor, colorFor, JMA } from './palette.js';

const BADGE = {
  0: ['#5f7288', '#e7eef7'], 1: ['#dfe6ff', '#121a2c'], 2: ['#4ec3ff', '#06121f'],
  3: ['#3d7dff', '#f2f7ff'], 4: ['#ffd76a', '#241a02'], 5: ['#ffc23d', '#241600'],
  5.5: ['#ff8f2e', '#2a1200'], 6: ['#ff4d4d', '#fff3f3'], 6.5: ['#c2185b', '#ffe9f1'],
  7: ['#a25bff', '#f7efff'],
};

export function badgeColor(v) {
  const key = v < 0.5 ? 0 : v < 1.5 ? 1 : v < 2.5 ? 2 : v < 3.5 ? 3 : v < 4.5 ? 4
    : v < 5.25 ? 5 : v < 5.75 ? 5.5 : v < 6.25 ? 6 : v < 6.75 ? 6.5 : 7;
  return BADGE[key];
}

export function intensityChip(v, extra = '') {
  const [bg, fg] = badgeColor(v);
  return `<span class="pt-chip" style="background:${bg};color:${fg}">${intensityLabel(v)}${extra}</span>`;
}

function srcBadges(ev) {
  const src = ev.sources || [];
  const names = [];
  if (src.includes('jma-xml')) names.push('JMA');
  if (src.includes('p2pquake')) names.push('P2P');
  return names.map((n) => `<span class="src-badge">${n}</span>`).join('');
}

export function renderFeed(container, data, filter, selectedKey, onSelect) {
  const items = [];
  for (const q of data.quakes || []) items.push({ type: 'quake', t: q.origin, ev: q });
  for (const e of data.eews || []) items.push({ type: 'eew', t: e.report, ev: e });
  for (const lp of data.longperiods || []) items.push({ type: 'longperiod', t: lp.time, ev: lp });
  if (data.tsunami && !data.tsunami.cancelled) items.push({ type: 'tsunami', t: data.tsunami.time, ev: data.tsunami });
  items.sort((a, b) => b.t - a.t);

  const visible = items.filter((it) => {
    if (filter === 'all') return true;
    if (filter === 'eew') return it.type === 'eew';
    return it.type === filter;
  }).slice(0, 60);

  const frag = document.createDocumentFragment();
  for (const it of visible) {
    const node = document.createElement('div');
    node.className = `card type-${it.type}` + (it.ev.key === selectedKey ? ' selected' : '');
    if (it.type === 'quake') {
      const q = it.ev;
      const [bg] = badgeColor(q.maxi || 0);
      node.innerHTML = `
        <div class="card-head"><span class="card-kind">地震情報</span>
          <span class="card-time">${fmtTime(q.origin)}</span></div>
        <div class="card-main">
          <div class="int-badge" style="--int-color:${bg}">${intensityLabel(q.maxi)}</div>
          <div class="card-place">${q.place || '震源調査中'}</div>
          <div class="card-mag">${fmtMag(q.mag)}</div>
        </div>
        <div class="card-foot">
          <span>深さ ${fmtDepth(q.depth)}</span>
          ${srcBadges(q)}
          ${q.tsunami === 'None' ? '<span class="tsu ok">津波の心配なし</span>' : q.tsunami && q.tsunami !== 'Unknown' ? '<span class="tsu">津波注意</span>' : ''}
          <span style="margin-left:auto">${relTime(q.origin)}</span>
        </div>`;
    } else if (it.type === 'eew') {
      const e = it.ev;
      const [bg] = badgeColor(e.maxi || 0);
      node.innerHTML = `
        <div class="card-head">${e._num ? `<span class="card-num" style="color:${e._color || '#ff8fa0'}">${numLabel(e._num)}</span>` : ''}<span class="card-kind" style="color:#ff8fa0">緊急地震速報</span>
          <span class="card-time">${fmtTime(e.report)}</span></div>
        <div class="card-main">
          <div class="int-badge" style="--int-color:${bg}">${intensityLabel(e.maxi)}</div>
          <div class="card-place">${e.place || '解析中'}</div>
          <div class="card-mag">${fmtMag(e.mag)}</div>
        </div>
        <div class="card-foot"><span>第 ${e.serial} 報</span><span style="margin-left:auto">${relTime(e.report)}</span></div>`;
    } else if (it.type === 'longperiod') {
      const lp = it.ev;
      const cls = Math.min(4, Math.max(1, Math.round(lp.maxi || 1)));
      const colors = { 1: '#FFE9A8', 2: '#FFB300', 3: '#FF5252', 4: '#A03CBA' };
      const place = (lp.areas && lp.areas[0] && (lp.areas[0].pref || lp.areas[0].name)) || '長周期地震動';
      node.innerHTML = `
        <div class="card-head"><span class="card-kind" style="color:#c9a6ff">長周期地震動</span>
          <span class="card-time">${fmtTime(lp.time)}</span></div>
        <div class="card-main">
          <div class="int-badge" style="--int-color:${colors[cls]}">${cls}</div>
          <div class="card-place">${place}${lp.areas && lp.areas.length > 1 ? ' など' : ''}</div>
          <div class="card-mag">階級${cls}</div>
        </div>
        <div class="card-foot"><span>${(lp.areas || []).length} 区域</span><span class="src-badge">JMA</span>
          <span style="margin-left:auto">${relTime(lp.time)}</span></div>`;
    } else if (it.type === 'tsunami') {
      const grades = [...new Set((it.ev.areas || []).map((a) => a.grade))];
      const top = grades.includes('MajorWarning') ? '大津波警報' : grades.includes('Warning') ? '津波警報' : '津波注意報';
      node.innerHTML = `
        <div class="card-head"><span class="card-kind" style="color:#f6b24a">津波情報</span>
          <span class="card-time">${fmtTime(it.ev.time)}</span></div>
        <div class="card-main"><div class="card-place">${top}</div>
          <div class="card-mag">${(it.ev.areas || []).length} 区</div></div>
        <div class="card-foot"><span>沿岸带见地图</span><span style="margin-left:auto">${relTime(it.ev.time)}</span></div>`;
    }
    node.addEventListener('click', () => onSelect?.(it.ev, it.type));
    frag.appendChild(node);
  }
  container.replaceChildren(frag);
}

function intensityBars(prefMax) {
  if (!prefMax) return '';
  const entries = Object.entries(prefMax)
    .filter(([, v]) => v !== null && v !== undefined)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  if (!entries.length) return '';
  const max = Math.max(4, ...entries.map((e) => e[1]));
  return entries.map(([name, v]) => {
    const pct = Math.min(100, (v / max) * 100);
    const [bg] = badgeColor(v);
    return `<div class="bar-row"><span class="bar-name">${name.replace(/[県府都]$/, '')}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${pct}%;background:${bg}"></span></span>
      <span class="bar-val">${intensityLabel(v)}</span></div>`;
  }).join('');
}

export function renderFocus(container, ev, ctx = {}) {
  if (!ev) {
    container.innerHTML = `<div class="empty-state">
      <svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="22"/><circle cx="32" cy="32" r="12"/><path d="M32 4v10M32 50v10M4 32h10M50 32h10"/></svg>
      <p>选择一个地震事件</p><span>从左侧速报流或时间轴中选取，查看震源、震度分布与观测点详情。</span></div>`;
    return;
  }
  const [bg] = badgeColor(ev.maxi || 0);
  const points = ev.top_points || ev.points || [];
  const sources = Array.isArray(ev.sources) ? ev.sources : Object.keys(ev.sources || {});
  const near = ctx.user && ev.lat
    ? haversine(ctx.user.lat, ctx.user.lon, ev.lat, ev.lon)
    : null;
  const depth = ev.depth || 10;
  const sEta = near !== null ? Math.hypot(near, depth) / 4.0 : null;
  const arrived = sEta !== null && ev.origin ? (Date.now() / 1000 - ev.origin) > sEta : false;
  const srcCount = (ev.sources || []).length;

  container.innerHTML = `
    <div class="ev-head">
      <div class="ev-int" style="--int-color:${bg}">${intensityLabel(ev.maxi)}<small>MAX</small></div>
      <div class="ev-title">
        <h3>${ev.place || '震源調査中'}</h3>
        <div class="ev-meta">${fmtDate(ev.origin)} ${fmtTime(ev.origin)} JST · ${relTime(ev.origin)}</div>
      </div>
    </div>
    <div class="ev-grid">
      <div class="ev-cell"><span>MAGNITUDE</span><b>${ev.mag ? 'M ' + Number(ev.mag).toFixed(1) : '—'}</b></div>
      <div class="ev-cell"><span>DEPTH</span><b>${fmtDepth(ev.depth)}</b></div>
      <div class="ev-cell"><span>LAT / LON</span><b>${ev.lat ? Number(ev.lat).toFixed(2) : '—'}<small>N</small> ${ev.lon ? Number(ev.lon).toFixed(2) : '—'}<small>E</small></b></div>
      <div class="ev-cell"><span>观测点</span><b>${ev.point_count ?? points.length ?? 0}<small>pts</small></b></div>
    </div>
    ${near !== null ? `<div class="ev-note">距震央 <b class="mono">${Math.round(near)} km</b> ·
      S 波${arrived ? '已到达' : `约 ${Math.max(0, Math.round(sEta - (Date.now() / 1000 - ev.origin)))} 秒后到达`} ·
      本地预估 <b class="mono">${ctx.localIntensity ?? '—'}</b></div>` : ''}
    ${ev.comment ? `<div class="ev-note">${ev.comment}</div>` : ''}
    ${ctx.lp ? `<p class="section-label">長周期地震動 <em>LONG PERIOD</em></p>
      <div class="ev-note">気象庁 · 最大 <b class="mono">階級 ${Math.round(ctx.lp.maxi)}</b> · ${(ctx.lp.areas || []).length} 区域
        ${ctx.lp.maxi >= 3 ? ' · 高层建筑注意持续摇摆' : ''}</div>` : ''}
    ${!ctx.lp && ctx.estLp ? `<div class="ev-note">長周期地震動 <b class="mono">推算 階級 ${ctx.estLp}</b>（本地，非官方观测值）</div>` : ''}
    ${ev.pref_max && Object.keys(ev.pref_max).length ? `<p class="section-label">震度分布 <em>INTENSITY</em></p><div class="bars">${intensityBars(ev.pref_max)}</div>` : ''}
    ${points.length ? `<p class="section-label">观测点 <em>OBSERVATIONS</em></p>
      <div class="pts">${points.slice(0, 18).map((p) => `<div class="pt-row">${intensityChip(p.scale)}
        <span class="pt-name">${p.addr || p.city || ''}</span>
        <span style="color:var(--dim);font-size:9.5px">${p.pref || ''}</span></div>`).join('')}</div>` : ''}
    <p class="section-label">数据来源 <em>PROVENANCE</em></p>
    <div class="src-list">
      ${sources.map((s) => `<div class="src-row"><span class="ok"></span><b>${s === 'jma-xml' ? '気象庁 XML (VXSE53)' : 'P2PQuake 速報'}</b><span>${s === 'jma-xml' ? '震源・震度詳細' : '即時リレー'}</span></div>`).join('')}
      <div class="src-row"><span class="ok" style="background:var(--cyan)"></span><b>強震モニタ</b><span>实时震度场</span></div>
    </div>
    <div class="btn-row">
      <button class="btn primary" data-act="replay">⏱ 回放此刻</button>
      <button class="btn" data-act="zoom">⌖ 地图聚焦</button>
      <button class="btn" data-act="lp">長周期层</button>
    </div>`;

  container.querySelector('[data-act="replay"]')?.addEventListener('click', () => ctx.onReplay?.(ev));
  container.querySelector('[data-act="zoom"]')?.addEventListener('click', () => ctx.onZoom?.());
  container.querySelector('[data-act="lp"]')?.addEventListener('click', () => ctx.onLongPeriod?.(ev));
}

export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const p1 = (lat1 * Math.PI) / 180, p2 = (lat2 * Math.PI) / 180;
  const dp = p2 - p1, dl = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export const EVENT_COLORS = ['#ff5a6e', '#ffb300', '#58d4ff', '#b388ff'];
const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];

export function numLabel(n) {
  const v = Number(n) || 0;
  if (v >= 1 && v <= 10) return CIRCLED[v - 1];
  return v > 0 ? `#${v}` : '';
}

export function eventColor(n) {
  return EVENT_COLORS[(Math.max(1, Number(n) || 1) - 1) % EVENT_COLORS.length];
}

export function hexToRgb(hex) {
  const h = String(hex || '#ff5a6e').replace('#', '');
  return `${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)}`;
}

export function strokeEvent(eew) {
  if (!eew) return;
  const n = Number(eew._num) || 0;
  eew._num = n;
  eew._color = eventColor(n);
  eew._rgb = hexToRgb(eew._color);
}

export function renderEewBanner(banner, eew, others = [], ctx = {}) {
  if (!eew) { banner.classList.remove('show'); return; }
  banner.classList.add('show');
  banner.dataset.key = eew.key;
  const [bg] = badgeColor(eew.maxi || 0);
  const title = (eew.maxi || 0) >= 5.5 ? '強い揺れに警戒' : (eew.maxi || 0) >= 4 ? '揺れに注意' : '地震発生';
  banner.querySelector('#eew-serial').textContent = `第 ${eew.serial} 報`;
  banner.querySelector('#eew-test').hidden = !eew.test;
  banner.querySelector('#eew-endtest').hidden = !eew.test;
  const noEl = banner.querySelector('#eew-no');
  if (noEl) {
    noEl.hidden = !(others && others.length);
    noEl.textContent = numLabel(eew._num);
    noEl.style.color = eew._color || '#ff8e9c';
  }
  banner.querySelector('#eew-title').textContent = title;
  banner.querySelector('#eew-sub').textContent =
    `${eew.place || '震源解析中'} · ${fmtMag(eew.mag)} · 深さ ${fmtDepth(eew.depth)} · ${fmtTime(eew.report)} JST`;
  const maxiEl = banner.querySelector('#eew-maxi');
  maxiEl.textContent = intensityLabel(eew.maxi);
  maxiEl.style.color = bg;
  const areas = (eew.areas || []).slice(0, 8);
  banner.querySelector('#eew-areas').innerHTML = areas.map((a) =>
    `<span class="eew-area">${a.name}<b>${intensityLabel(a.to ?? a.from)}</b></span>`).join('');

  const queue = banner.querySelector('#eew-queue');
  if (queue) {
    if (others && others.length) {
      queue.hidden = false;
      queue.innerHTML = `<span class="q-label">同時発生</span>` + others.slice(0, 3).map((o) => {
        const color = o._color || eventColor(o._num);
        const num = numLabel(o._num) || '•';
        return `<button class="eew-q" data-key="${o.key}" style="--qc:${color}" title="切换到该速报并暂停轮换">
          <span class="q-no">${num}</span>
          <span>${o.place || '解析中'}</span>
          <span class="q-maxi">${intensityLabel(o.maxi)}</span>
          <span class="q-count" data-key="${o.key}">--</span>
        </button>`;
      }).join('') + '<button class="eew-rot" id="eew-rot"></button>';
    } else {
      queue.hidden = true;
      queue.innerHTML = '';
    }
  }
  return { title };
}

/** Seconds until the S-wave reaches `user` (negative once it has passed). */
export function secondsToArrival(eew, user) {
  if (!eew || !eew.lat || !user) return null;
  if (eew._model) {
    const d = haversine(user.lat, user.lon, eew.lat, eew.lon);
    return eew._model.origin + eew._model.sTravel(d) - Date.now() / 1000;
  }
  const dist = haversine(user.lat, user.lon, eew.lat, eew.lon);
  const depth = Math.max(0, eew.depth || 0);
  const r = Math.hypot(dist, depth);
  const travel = r <= 150 ? r / 4.0 : 37.5 + (r - 150) / 6.8;
  return (eew.origin || eew.report - 2) + travel - Date.now() / 1000;
}

export function updateCountdown(el, eew, user, basisEl, map) {
  if (!el) return;
  if (!eew || !eew.lat || !user) {
    el.innerHTML = '--.-<small>s</small>';
    if (basisEl) basisEl.textContent = '--';
    return;
  }
  const remain = secondsToArrival(eew, user);
  if (remain === null) { el.innerHTML = '--.-<small>s</small>'; return; }
  if (remain > 0) {
    el.innerHTML = `${remain.toFixed(1)}<small>s</small>`;
    el.style.color = remain < 10 ? '#ff5b73' : '#fff';
  } else {
    el.innerHTML = `已到达<small>${Math.abs(remain).toFixed(0)}s</small>`;
    el.style.color = 'rgba(255,255,255,.45)';
  }
  if (basisEl) {
    const model = eew._model;
    basisEl.textContent = model ? (model.linear ? '区域予測' : '推算') : '推算';
  }
}

/**
 * One shared travel-time model for both the wavefront circles and the
 * countdown, so they can never disagree.
 *
 *  - if the EEW carries (JMA) area arrival times, fit t = a + b*d by least
 *    squares, then anchor the line on the user's own area arrival when known;
 *  - otherwise fall back to the layered model (4.0 km/s near field,
 *    6.8 km/s beyond 150 km) which is also what the offline drills use.
 */
export function buildTravelModel(eew, map, user) {
  if (!eew || !eew.lat || !eew.lon) return null;
  const origin = eew.origin || eew.report - 2;
  const depth = Math.max(0, Number(eew.depth) || 0);
  const pts = [];
  for (const area of eew.areas || []) {
    if (!area.arrival) continue;
    const pref = map && map._matchPref ? map._matchPref(area.name || area.pref) : null;
    if (!pref) continue;
    const d = haversine(eew.lat, eew.lon, pref.c[1], pref.c[0]);
    const t = area.arrival - origin;
    // regress on hypocentral distance so the depth is built into the model
    if (d > 5 && t > 0.5 && t < 600) pts.push([Math.hypot(d, depth), t]);
  }
  let a = 0;
  let b = 0;
  let source = 'model';
  if (pts.length >= 3) {
    const n = pts.length;
    let sd = 0, st = 0, sdd = 0, sdt = 0;
    for (const [d, t] of pts) { sd += d; st += t; sdd += d * d; sdt += d * t; }
    const den = n * sdd - sd * sd;
    if (Math.abs(den) > 1e-6) {
      b = (n * sdt - sd * st) / den;
      a = (st - b * sd) / n;
      if (b > 0.04 && isFinite(b) && isFinite(a)) source = 'area';
    }
  }
  if (source === 'area') {
    b = Math.min(0.33, Math.max(0.075, b));
    if (user) {
      const prefName = map && map._prefAt ? map._prefAt(user.lon, user.lat) : null;
      if (prefName) {
        const key = prefName.replace(/[都府県]$/, '');
        for (const area of eew.areas || []) {
          if (!area.arrival) continue;
          const ak = String(area.pref || '').replace(/[都府県]$/, '');
          if (!ak) continue;
          if (ak === key || key.startsWith(ak) || ak.startsWith(key)) {
            const d = haversine(user.lat, user.lon, eew.lat, eew.lon);
            a = (area.arrival - origin) - b * Math.hypot(d, depth);
            source = 'anchored';
            break;
          }
        }
      }
    }
  }
  const linear = source !== 'model';
  return {
    eewKey: eew.key,
    origin,
    depth,
    a,
    b,
    source,
    linear,
    sTravel(d) {
      if (linear) return Math.max(1, a + b * Math.hypot(d, depth));
      const r = Math.hypot(d, depth);
      return r <= 150 ? r / 4.0 : 37.5 + (r - 150) / 6.8;
    },
    radiusAt(elapsed) {
      if (linear) {
        const rh = (elapsed - a) / b;
        return Math.sqrt(Math.max(0, rh * rh - depth * depth));
      }
      const t = Math.max(0, elapsed);
      if (t <= 37.5) return Math.sqrt(Math.max(0, (4.0 * t) ** 2 - depth ** 2));
      const r = 150 + (t - 37.5) * 6.8;
      return Math.sqrt(Math.max(0, r * r - depth * depth));
    },
    pTravel(d) { return 0.62 * this.sTravel(d); },
    pRadiusAt(elapsed) { return this.radiusAt(elapsed / 0.62); },
  };
}

// ------------------------------------------------------------------ settings
export function renderSettings(container, settings, actions) {
  const prefs = actions.prefs || [];
  const prefOptions = prefs.map((p) => `<option value="${p}" ${settings.drillPref === p ? 'selected' : ''}>${p}</option>`).join('');
  container.innerHTML = `
    <div class="setting-group">
      <h4>现在地 LOCATION</h4>
      <div class="setting-row">
        <div class="setting-label">名称<small>用于 S 波倒计时与本地预估震度</small></div>
        <input type="text" id="set-loc-name" value="${settings.location?.name || ''}" style="width:120px">
      </div>
      <div class="setting-row">
        <div class="setting-label">纬度 / 经度<small>十进制，例如 35.681 / 139.767；倒计时会优先采用气象厅「区域到达时刻」</small></div>
        <input type="number" step="0.001" id="set-loc-lat" value="${settings.location?.lat ?? 35.681}" style="width:100px">
        <input type="number" step="0.001" id="set-loc-lon" value="${settings.location?.lon ?? 139.767}" style="width:100px">
      </div>
    </div>
    <div class="setting-group">
      <h4>显示 DISPLAY</h4>
      <div class="setting-row">
        <div class="setting-label">震度配色<small>SHINREKI 为自建连续暖色梯度，JMA 为官方分级色</small></div>
        <select id="set-palette">
          <option value="shinreki" ${settings.palette !== 'jma' ? 'selected' : ''}>SHINREKI</option>
          <option value="jma" ${settings.palette === 'jma' ? 'selected' : ''}>JMA 官方</option>
        </select>
      </div>
      <div class="setting-row">
        <div class="setting-label">声音提醒<small>警报音固定持续 5 秒后自动停止</small></div>
        <div class="switch ${settings.sound ? 'on' : ''}" data-toggle="sound"></div>
      </div>
      <div class="setting-row">
        <div class="setting-label">同时速报轮换<small>有多条速报时，主横幅与地图强调每 N 秒切换一次；点速报条目会暂停</small></div>
        <select id="set-rotate">
          ${[5, 10, 15, 0].map((v) => `<option value="${v}" ${String(settings.rotate_seconds ?? 5) === String(v) ? 'selected' : ''}>${v ? v + ' 秒' : '关闭'}</option>`).join('')}
        </select>
      </div>
      <div class="setting-row">
        <div class="setting-label">语音播报<small>使用系统 TTS，日语语音优先</small></div>
        <div class="switch ${settings.speech ? 'on' : ''}" data-toggle="speech"></div>
      </div>
    </div>
    <div class="setting-group">
      <h4>档案 ARCHIVE</h4>
      <div class="setting-row">
        <div class="setting-label">保留天数<small>1 Hz 保存最近 24 小时，之后自动降采样</small></div>
        <input type="number" min="1" max="3650" id="set-days" value="${settings.retention_days ?? 30}" style="width:80px">
      </div>
      <div class="setting-row">
        <div class="setting-label">全分辨率时长（小时）<small>此后按 10 秒 / 60 秒分层压缩</small></div>
        <input type="number" min="1" max="240" id="set-live" value="${settings.live_hours ?? 24}" style="width:80px">
      </div>
      <div class="setting-row">
        <div class="setting-label">立即整理档案<small>把旧数据重写为稀疏帧，释放空间</small></div>
        <button class="btn" id="set-compact">整理</button>
      </div>
      <div class="setting-row">
        <div class="setting-label" style="color:#ff8f9c">清除历史<small>不可恢复：清空震度帧 / 事件 / 速报</small></div>
        <button class="btn danger" data-clear="frames">震度帧</button>
        <button class="btn danger" data-clear="events">事件</button>
        <button class="btn danger" data-clear="all">全部</button>
      </div>
    </div>
    <div class="setting-group">
      <h4>应急演练 DRILL</h4>
      <div class="setting-row">
        <div class="setting-label">震源位置<small>选择都道府县，震源取该县中心</small></div>
        <select id="drill-pref" style="width:130px">${prefOptions}</select>
      </div>
      <div class="setting-row">
        <div class="setting-label">震级 / 深度<small>M 与 深さ（km）</small></div>
        <input type="number" step="0.1" min="3" max="9.5" id="drill-mag" value="${settings.drillMag ?? 7.0}" style="width:80px">
        <input type="number" step="5" min="0" max="700" id="drill-depth" value="${settings.drillDepth ?? 40}" style="width:80px">
      </div>
      <div class="setting-row">
        <div class="setting-label">最大震度<small>横幅显示的目标最大震度</small></div>
        <select id="drill-maxi">
          ${[['3','3'],['4','4'],['5','5弱'],['5.5','5強'],['6','6弱'],['6.5','6強'],['7','7']]
            .map(([v, t]) => `<option value="${v}" ${String(settings.drillMaxi ?? '6') === v ? 'selected' : ''}>${t}</option>`).join('')}
        </select>
      </div>
      <div class="setting-row">
        <div class="setting-label">测试速报<small>不写入历史、不参与合并；横幅与地图为演练效果</small></div>
        <button class="btn primary" id="set-drill">触发</button>
        <button class="btn" id="set-drill-double">双震</button>
        <button class="btn danger" id="set-drill-end">结束测试</button>
      </div>
    </div>
    <div class="setting-group">
      <h4>数据源 SOURCES</h4>
      <div class="setting-row"><div class="setting-label">NIED 強震モニタ<small>1 Hz 全国震度场（实时）</small></div><div class="switch ${settings.sources?.kmoni ? 'on' : ''}" data-toggle="src-kmoni"></div></div>
      <div class="setting-row"><div class="setting-label">P2PQuake<small>紧急地震速报 / 地震情报 / 津波</small></div><div class="switch ${settings.sources?.p2pquake ? 'on' : ''}" data-toggle="src-p2p"></div></div>
      <div class="setting-row"><div class="setting-label">気象庁 XML<small>震源・震度詳細、長周期地震動</small></div><div class="switch ${settings.sources?.jma ? 'on' : ''}" data-toggle="src-jma"></div></div>
    </div>
    <div class="btn-row sticky" style="justify-content:flex-end">
      <button class="btn primary" id="set-save">保存设置</button>
    </div>`;

  container.querySelectorAll('.switch').forEach((sw) => {
    sw.addEventListener('click', () => { sw.classList.toggle('on'); });
  });
  const on = (name) => container.querySelector(`[data-toggle="${name}"]`)?.classList.contains('on');
  container.querySelector('#set-save')?.addEventListener('click', () => {
    const patch = {
      location: {
        name: container.querySelector('#set-loc-name').value || '现在地',
        lat: parseFloat(container.querySelector('#set-loc-lat').value) || 35.681,
        lon: parseFloat(container.querySelector('#set-loc-lon').value) || 139.767,
      },
      palette: container.querySelector('#set-palette').value,
      rotate_seconds: parseInt(container.querySelector('#set-rotate')?.value ?? '5', 10),
      sound: on('sound'),
      speech: on('speech'),
      retention_days: parseInt(container.querySelector('#set-days').value, 10) || 30,
      live_hours: parseInt(container.querySelector('#set-live').value, 10) || 24,
      sources: { kmoni: on('src-kmoni'), p2pquake: on('src-p2p'), jma: on('src-jma') },
    };
    actions.onSave?.(patch);
  });
  container.querySelector('#set-compact')?.addEventListener('click', () => actions.onCompact?.());
  container.querySelector('#set-drill')?.addEventListener('click', () => {
    actions.onDrill?.({
      pref: container.querySelector('#drill-pref')?.value,
      mag: parseFloat(container.querySelector('#drill-mag')?.value) || 7.0,
      depth: parseFloat(container.querySelector('#drill-depth')?.value) || 40,
      maxi: parseFloat(container.querySelector('#drill-maxi')?.value) ?? 6,
    });
  });
  container.querySelector('#set-drill-end')?.addEventListener('click', () => actions.onEndDrill?.());
  container.querySelector('#set-drill-double')?.addEventListener('click', () => actions.onDoubleDrill?.());
  container.querySelectorAll('[data-clear]').forEach((btn) => {
    btn.addEventListener('click', () => actions.onClear?.(btn.dataset.clear));
  });
}

// ------------------------------------------------------------------ chronicle
export function renderChronicle(container, stats, archive, events, actions) {
  const days = Object.keys(stats.by_day || {}).sort();
  const maxDay = Math.max(1, ...Object.values(stats.by_day || {}).map((d) => d.n));
  const maxHour = Math.max(1, ...(stats.hourly || [1]));
  const magTotal = Object.values(stats.mag_buckets || {}).reduce((a, b) => a + b, 0) || 1;

  container.innerHTML = `
    <div class="stat-grid">
      <div class="stat-card"><span>事件总数 · ${stats.days}天</span><b>${stats.count}<small>件</small></b></div>
      <div class="stat-card accent"><span>最大震度</span><b>${intensityLabel(stats.maxi)}</b></div>
      <div class="stat-card"><span>档案帧数</span><b>${(archive.frames || 0).toLocaleString()}<small>frames</small></b></div>
      <div class="stat-card"><span>档案体积</span><b>${fmtBytes(archive.bytes)}</b></div>
    </div>
    <div class="chart-row">
      <div class="chart-box"><h5>每日地震数 DAILY ACTIVITY</h5><canvas id="chart-daily"></canvas></div>
      <div class="chart-box"><h5>震级分布 MAGNITUDE</h5><canvas id="chart-mag"></canvas></div>
    </div>
    <div class="chart-box" style="margin-bottom:16px"><h5>时刻分布 HOURLY (JST)</h5><canvas id="chart-hourly" style="height:110px"></canvas></div>
    <div class="search-row">
      <input id="arch-search" placeholder="搜索地名…（例：宮城、熊本）">
      <button class="btn" id="arch-go">搜索</button>
    </div>
    <div class="chronicle-list" id="chron-list">
      ${chronicleRows(events, actions)}
    </div>`;

  drawDaily(container.querySelector('#chart-daily'), stats, days, maxDay);
  drawMag(container.querySelector('#chart-mag'), stats, magTotal);
  drawHourly(container.querySelector('#chart-hourly'), stats.hourly || [], maxHour);

  container.querySelector('#arch-go')?.addEventListener('click', () => {
    actions.onSearch?.(container.querySelector('#arch-search').value || '');
  });
  container.querySelector('#arch-search')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') actions.onSearch?.(e.target.value || '');
  });
  bindChronicleRows(container, actions);
}

function chronicleRows(events, actions) {
  if (!events || !events.length) return `<div style="padding:14px;color:var(--dim);font-size:11px">暂无事件</div>`;
  return events.map((ev) => {
    const [bg, fg] = badgeColor(ev.maxi || 0);
    return `<div class="chronicle-row" data-key="${ev.key}">
      <span class="t">${fmtDate(ev.origin).slice(5)} ${fmtTime(ev.origin)}</span>
      <span class="p">${ev.place || '—'}</span>
      <span class="m">${fmtMag(ev.mag)}</span>
      <span class="i" style="background:${bg};color:${fg}">${intensityLabel(ev.maxi)}</span>
      <span class="m">${fmtDepth(ev.depth)}</span>
    </div>`;
  }).join('');
}

function bindChronicleRows(container, actions) {
  container.querySelectorAll('.chronicle-row').forEach((row) => {
    row.addEventListener('click', () => actions.onOpen?.(row.dataset.key));
  });
}

function setupCanvas(canvas) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(100, rect.width), h = Math.max(60, rect.height || 150);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function drawDaily(canvas, stats, days, maxDay) {
  if (!canvas) return;
  const { ctx, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const pad = 18;
  const n = Math.max(1, days.length);
  const slot = (w - pad - 6) / n;
  const bw = Math.max(3, Math.min(26, slot * 0.55));
  // horizontal guides
  ctx.strokeStyle = 'rgba(120,170,220,.07)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = 8 + (i / 3) * (h - pad - 20);
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w - 4, y); ctx.stroke();
  }
  days.forEach((day, i) => {
    const d = stats.by_day[day];
    const bh = Math.max(2, (d.n / maxDay) * (h - pad - 20));
    const x = pad + i * slot + (slot - bw) / 2;
    const c = rampColor((d.maxi || 0) / 10);
    ctx.fillStyle = d.maxi >= 45 ? `rgba(${c.rgb[0]},${c.rgb[1]},${c.rgb[2]},.9)` : 'rgba(92,225,210,.32)';
    ctx.fillRect(x, h - pad - bh, bw, bh);
    if (i % Math.ceil(n / 8) === 0) {
      ctx.fillStyle = 'rgba(120,145,175,.55)';
      ctx.font = '8px "Cascadia Mono", monospace';
      ctx.fillText(day.slice(5), x, h - 5);
    }
  });
}

function drawMag(canvas, stats, total) {
  if (!canvas) return;
  const { ctx, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const entries = Object.entries(stats.mag_buckets || {});
  const max = Math.max(1, ...entries.map(([, v]) => v));
  const barH = (h - 14) / entries.length;
  entries.forEach(([label, v], i) => {
    const y = 4 + i * barH;
    const bw = (v / max) * (w - 60);
    ctx.fillStyle = 'rgba(255,255,255,.05)';
    ctx.fillRect(48, y, w - 54, barH - 3);
    ctx.fillStyle = 'rgba(92,225,210,.55)';
    ctx.fillRect(48, y, bw, barH - 3);
    ctx.fillStyle = 'rgba(160,180,205,.7)';
    ctx.font = '9px "Cascadia Mono", monospace';
    ctx.fillText(label, 6, y + barH - 5);
    ctx.fillStyle = 'rgba(200,215,230,.75)';
    ctx.fillText(String(v), 52 + bw + 4, y + barH - 5);
  });
}

function drawHourly(canvas, hourly, max) {
  if (!canvas) return;
  const { ctx, w, h } = setupCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const bw = (w - 10) / 24;
  hourly.forEach((v, i) => {
    const bh = (v / max) * (h - 22);
    ctx.fillStyle = `rgba(92,225,210,${0.25 + 0.5 * (v / max)})`;
    ctx.fillRect(6 + i * bw, h - 16 - bh, Math.max(2, bw * 0.6), bh);
    if (i % 3 === 0) {
      ctx.fillStyle = 'rgba(120,145,175,.5)';
      ctx.font = '8px "Cascadia Mono", monospace';
      ctx.fillText(String(i).padStart(2, '0'), 6 + i * bw, h - 4);
    }
  });
}

export function toast(host, message, ms = 3200) {
  const node = document.createElement('div');
  node.className = 'toast';
  node.textContent = message;
  host.appendChild(node);
  setTimeout(() => node.remove(), ms);
}
