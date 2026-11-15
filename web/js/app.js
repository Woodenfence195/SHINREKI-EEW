// 震歴 SHINREKI — application controller.

import { SeismicMap } from './map.js';
import { Timeline, HeatStrip } from './timeline.js';
import { buildRasterLUT, rampColor } from './palette.js';
import { fmtTime, fmtDate, jstParts, intensityLabel, fmtBytes, relTime } from './fmt.js';
import {
  renderFeed, renderFocus, renderEewBanner, updateCountdown, renderSettings,
  renderChronicle, toast, haversine, badgeColor, buildTravelModel, secondsToArrival,
  numLabel, eventColor, strokeEvent,
} from './panels.js';
import { Sound } from './sound.js';

const $ = (sel) => document.querySelector(sel);
const PIX = 352 * 400;

const S = {
  state: null,
  settings: null,
  palette: 'shinreki',
  lut: null,
  mode: 'live',
  replayTs: null,
  playing: false,
  speed: 10,
  range: 86400,
  timelineEnd: Date.now() / 1000,
  frames: [],
  frameRange: [0, 0],
  selected: null,
  filter: 'all',
  feed: { quakes: [], eews: [], tsunami: null },
  liveFrameTs: 0,
  rasterBusy: false,
  pendingTs: 0,
  lastEewKey: null,
  lastQuakeKey: null,
  drill: null,
  dismissedEews: new Set(),
  announced: new Set(),
  pinnedKey: null,
  primaryKey: null,
  rotation: { enabled: true, interval: 5000, last: 0, key: null, setting: null },
  numbers: new Map(),
  numberSeq: 0,
  booted: false,
  bannerEew: null,
  audioReady: false,
  heatData: [],
};

const sound = new Sound();
let map, timeline, heat, sse;

// ------------------------------------------------------------------ utils
async function getJSON(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json();
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json();
}

function decodeFrames(buffer) {
  const dv = new DataView(buffer);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'SHFR') return [];
  const count = dv.getUint32(6, true);
  let off = 10;
  const frames = [];
  for (let f = 0; f < count; f++) {
    const ts = dv.getUint32(off, true);
    const n = dv.getUint32(off + 4, true);
    off += 8;
    const arr = new Uint8Array(PIX).fill(255);
    for (let i = 0; i < n; i++) {
      arr[dv.getUint32(off + i * 4, true)] = dv.getUint8(off + n * 4 + i);
    }
    off += n * 5;
    frames.push({ ts, arr });
  }
  return frames;
}

// ------------------------------------------------------------------ boot
async function init() {
  map = new SeismicMap($('#map'), {
    onSelect: (ev) => selectEvent(ev.key),
    onCursor: (c) => updateCursor(c),
    onHover: (ev, pref) => {
      const tip = $('#map-cursor');
      if (ev) tip.textContent = `${ev.place || ''} · ${intensityLabel(ev.maxi)}`;
    },
  });
  map.observeResize();

  timeline = new Timeline($('#timeline'), {
    onSeek: (ts) => seekTo(ts),
    onHover: (ts, x) => showTimelineTip(ts, x),
    onZoom: (f) => changeRange(S.range * f),
  });
  heat = new HeatStrip($('#heatmap'));

  const [state, geo] = await Promise.all([getJSON('/api/state'), getJSON('/data/japan.json')]);
  map.setGeography(geo);
  map.loadPrefmap();
  heat.setPrefs(geo.prefs);
  S.state = state;
  S.settings = state.settings;
  S.palette = state.settings?.palette || 'shinreki';
  S.lut = buildRasterLUT(S.palette);
  map.setLUT(S.lut);
  map.setUser(state.settings?.location);
  map.setEvents(state.quakes || []);
  S.feed = {
    quakes: state.quakes || [], eews: state.eews || [], tsunami: state.tsunami,
    longperiods: state.longperiods || [],
  };

  applyState(state);
  refreshFeed();
  renderFocus($('#focus-body'), null, {});

  await loadLatestFrame();
  connectSSE();
  await refreshTimeline();
  await refreshHeat();
  bindUI();
  requestAnimationFrame(loop);

  // expose a tiny debug/automation surface (used by the screenshot tooling)
  window.SHINREKI = {
    S, selectEvent, enterReplay, goLive, changeRange, map, timeline, heat,
    updateTsunamiLegend, applyLongPeriodLayer, buildEstimatedLp,
  };

  if (state.quakes && state.quakes.length) {
    selectEvent(state.quakes[0].key);
  }

  setInterval(tickClock, 250);
  setInterval(() => { if (S.mode === 'live') refreshTimeline(); }, 30000);
  setInterval(() => { if (S.mode === 'live') refreshHeat(); }, 60000);
}

// ------------------------------------------------------------------ live frame
async function loadLatestFrame() {
  if (S.state?.frame?.ts) {
    await fetchRaster(S.state.frame.ts);
  }
}

async function fetchRaster(ts) {
  if (S.rasterBusy) { S.pendingTs = ts; return; }
  S.rasterBusy = true;
  try {
    const url = ts ? `/api/raster?ts=${ts}` : '/api/raster';
    const res = await fetch(url, { cache: 'no-store' });
    if (res.ok) {
      const buf = await res.arrayBuffer();
      const arr = new Uint8Array(buf);
      if (arr.length === PIX) {
        map.setFrame(arr);
        S.liveFrameTs = Number(res.headers.get('X-Frame-Ts') || ts || 0);
        updateMapStamp(S.liveFrameTs);
      }
    }
  } catch (e) { /* keep last frame */ }
  S.rasterBusy = false;
  if (S.pendingTs && S.pendingTs !== ts) {
    const next = S.pendingTs;
    S.pendingTs = 0;
    fetchRaster(next);
  }
}

function updateMapStamp(ts) {
  if (!ts) return;
  const p = jstParts(ts);
  $('#map-ts').textContent = p.clock;
  const lag = Math.max(0, Math.round(Date.now() / 1000 - ts));
  $('#map-sub').textContent = S.mode === 'live' ? `delay ${lag}s · ${p.date}` : `REPLAY · ${p.date} ${p.clock}`;
}

// ------------------------------------------------------------------ SSE
function connectSSE() {
  if (sse) sse.close();
  sse = new EventSource('/api/stream');
  sse.addEventListener('hello', (e) => {
    const payload = JSON.parse(e.data);
    if (payload.state) applyState(payload.state);
  });
  sse.addEventListener('state', (e) => applyState(JSON.parse(e.data)));
  sse.addEventListener('frame', (e) => {
    const f = JSON.parse(e.data);
    if (S.mode === 'live') fetchRaster(f.ts);
  });
  sse.addEventListener('quake', (e) => onQuakeEvent(JSON.parse(e.data)));
  sse.addEventListener('eew', (e) => onEewEvent(JSON.parse(e.data)));
  sse.addEventListener('tsunami', (e) => onTsunamiEvent(JSON.parse(e.data)));
  sse.onerror = () => { /* EventSource retries automatically */ };
}


function refreshFeed() {
  const list = $('#feed-list');
  if (!list) return;
  const top = list.scrollTop;
  renderFeed(list, S.feed, S.filter, S.selected?.key, (ev, type) => selectEvent(ev.key, type));
  list.scrollTop = top;
}

// ------------------------------------------------------------------ state
function applyState(st) {
  S.state = st;
  S.settings = st.settings || S.settings;
  if (st.settings && st.settings.palette !== S.palette) {
    S.palette = st.settings.palette;
    S.lut = buildRasterLUT(S.palette);
    map.setLUT(S.lut);
  }
  if (st.settings?.location) map.setUser(st.settings.location);
  map.setEvents(st.quakes || []);

  // status pills
  const demoMode = st.mode === 'demo';
  ['#status-kmoni', '#status-p2p', '#status-jma'].forEach((sel) => { $(sel).hidden = demoMode; });
  $('#status-demo').hidden = !demoMode;
  const k = st.status?.kmoni || {};
  setPill('#status-kmoni', k.ok ? 'ok' : (k.ts ? 'warn' : 'bad'),
    k.ts ? `${Math.max(0, Math.round(k.age || 0))}s` : 'off');
  const p = st.status?.p2p || {};
  setPill('#status-p2p', p.connected ? 'ok' : (p.age && p.age < 300 ? 'warn' : 'bad'),
    p.connected ? 'live' : (p.age ? `${Math.round(p.age)}s` : 'off'));
  const j = st.status?.jma || {};
  setPill('#status-jma', j.ok ? 'ok' : 'bad', j.ok ? 'ok' : 'off');

  const arch = st.archive || {};
  $('#archive-text').textContent = `档案 ${formatCount(arch.frames)} · ${arch.retention_days}天`;
  $('#archive-chip').title = `帧 ${arch.frames} · 事件 ${arch.events} · 体积 ${fmtBytes(arch.bytes)}`;

  S.feed = {
    quakes: st.quakes || [], eews: st.eews || [], tsunami: st.tsunami,
    longperiods: st.longperiods || [],
  };
  (st.eews || []).forEach((e) => {
    e._model = buildTravelModel(e, map, S.settings?.location);
  });
  const rotSeconds = Number(st.settings?.rotate_seconds ?? 5);
  if (S.rotation.setting !== rotSeconds) {
    S.rotation.setting = rotSeconds;
    S.rotation.interval = Math.max(0, rotSeconds) * 1000;
    S.rotation.enabled = rotSeconds > 0;
    S.rotation.last = 0;
    S.rotation.key = null;
  }
  if (!S.booted) {
    (st.eews || []).forEach((e) => S.announced.add(e.key));
    S.rotation.last = Date.now();
    S.booted = true;
  }
  orderAndShowEews(st.eews || []);
  map.setTsunami(st.tsunami);
  if (st.longperiod && !st.longperiod.estimated) map.setLongperiod(st.longperiod);
  updateTsunamiLegend(st.tsunami);
  refreshFeed();
  updateMapMode();
}

function setPill(sel, cls, value) {
  const node = $(sel);
  if (!node) return;
  node.classList.remove('ok', 'warn', 'bad');
  node.classList.add(cls);
  const v = node.querySelector('.pill-value');
  if (v) v.textContent = value;
}

function formatCount(n) {
  if (!n) return '空';
  if (n > 100000) return `${(n / 10000).toFixed(1)}万`;
  if (n > 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// ------------------------------------------------------------------ events
function onQuakeEvent(ev) {
  if (!ev || !ev.key) return;
  const exists = S.feed.quakes.find((q) => q.key === ev.key);
  if (exists) Object.assign(exists, ev);
  else S.feed.quakes.unshift(ev);
  S.feed.quakes = S.feed.quakes.slice(0, 40);
  refreshFeed();
  map.setEvents(S.feed.quakes);
  if (S.lastQuakeKey !== ev.key) {
    S.lastQuakeKey = ev.key;
    const maxi = ev.maxi || 0;
    if (maxi >= 1) sound.quake(maxi);
    toast($('#toasts'), `地震情報 · ${ev.place || ''} · 最大震度${intensityLabel(maxi)}`);
  }
  refreshTimeline();
}

function onEewEvent(eew) {
  if (!eew || !S.state) return;
  if (eew.cancelled) {
    S.state.eews = (S.state.eews || []).filter((e) => e.grp !== eew.grp && e.key !== eew.key);
    orderAndShowEews(S.state.eews);
    refreshTimeline();
    return;
  }
  eew._model = buildTravelModel(eew, map, S.settings?.location);
  const others = (S.state.eews || []).filter((e) => e.key !== eew.key && e.grp !== eew.grp);
  S.state.eews = [eew, ...others].slice(0, 8);
  S.dismissedEews.delete(eew.key);
  if (!S.pinnedKey) {
    S.rotation.key = null;
    S.rotation.last = Date.now();
  }
  orderAndShowEews(S.state.eews);
  refreshTimeline();
}

function onTsunamiEvent(tsu) {
  toast($('#toasts'), tsu.cancelled ? '津波情報已解除' : '津波警報・注意報发布', 5000);
  S.feed.tsunami = tsu;
  refreshFeed();
}

// ------------------------------------------------------------------ EEW banner
// Several EEWs can be live at the same time (double earthquakes, or one event
// per source).  The banner shows one "primary" and lists the rest underneath.
function activeEews(list) {
  return (list || []).filter((e) => e && !e.cancelled && !S.dismissedEews.has(e.key));
}

function hashCode(text) {
  let h = 2166136261;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Stable per-event numbers for the currently active EEWs.
 *  - first to occur = 1, then 2, 3 …
 *  - identical origin time: larger magnitude first
 *  - still identical: pseudo-random but stable (hash of the group id)
 * Numbers never change while the event is alive, even when the banner rotates.
 */
function assignEventNumbers(active) {
  if (!active.length) {
    if (S.numbers.size) { S.numbers.clear(); S.numberSeq = 0; }
    return;
  }
  const missing = active.filter((e) => !S.numbers.has(e.grp));
  if (missing.length) {
    missing.sort((a, b) => {
      const ta = a.origin || a.report || 0;
      const tb = b.origin || b.report || 0;
      if (ta !== tb) return ta - tb;
      const dm = (b.mag || 0) - (a.mag || 0);
      if (Math.abs(dm) > 1e-9) return dm;
      return hashCode(a.grp) - hashCode(b.grp);
    });
    for (const e of missing) {
      S.numbers.set(e.grp, S.numberSeq + 1);
      S.numberSeq += 1;
    }
  }
  for (const e of active) {
    e._num = S.numbers.get(e.grp) || 0;
    strokeEvent(e);
  }
}

function secondsUntil(eew) {
  const user = S.settings?.location;
  if (!user || !eew?.lat) return 999;
  const s = secondsToArrival(eew, user);
  return s === null ? 999 : Math.max(0, s);
}

function pickPrimary(list) {
  const active = activeEews(list);
  if (!active.length) return null;
  if (S.pinnedKey) {
    const pinned = active.find((e) => e.key === S.pinnedKey);
    if (pinned) return pinned;
    S.pinnedKey = null;
  }
  if (S.rotation.key) {
    const rotated = active.find((e) => e.key === S.rotation.key);
    if (rotated) return rotated;
    S.rotation.key = null;
  }
  return active.slice().sort((a, b) => {
    const dm = (b.maxi || 0) - (a.maxi || 0);
    if (Math.abs(dm) > 0.01) return dm;
    return secondsUntil(a) - secondsUntil(b);
  })[0];
}

function maybeRotate() {
  const active = activeEews(S.state?.eews);
  if (!S.rotation.enabled || S.rotation.interval <= 0) return;
  if (active.length < 2 || S.pinnedKey) return;
  const now = Date.now();
  if (now - S.rotation.last < S.rotation.interval) return;
  const sorted = active.slice().sort((a, b) => {
    const dm = (b.maxi || 0) - (a.maxi || 0);
    if (Math.abs(dm) > 0.01) return dm;
    return secondsUntil(a) - secondsUntil(b);
  });
  const cur = S.bannerEew?.key || S.rotation.key;
  let idx = sorted.findIndex((e) => e.key === cur);
  if (idx < 0) idx = -1;
  const next = sorted[(idx + 1) % sorted.length];
  S.rotation.key = next.key;
  S.rotation.last = now;
  orderAndShowEews(S.state.eews);
}

function updateRotationChip() {
  const btn = document.querySelector('#eew-rot');
  if (!btn) return;
  const secs = Math.round(S.rotation.interval / 1000);
  btn.textContent = S.rotation.enabled ? `⇄ 轮换 ${secs}s` : '轮换已暂停 · 恢复';
  btn.classList.toggle('on', S.rotation.enabled);
  btn.classList.toggle('paused', !S.rotation.enabled);
}

function orderAndShowEews(list) {
  const active = activeEews(list);
  assignEventNumbers(active);
  active.forEach((e) => {
    if (!e._model) e._model = buildTravelModel(e, map, S.settings?.location);
  });
  const primary = pickPrimary(active);
  const ordered = primary ? [primary, ...active.filter((e) => e.key !== primary.key)] : [];
  map.setEews(ordered);
  renderBannerFor(ordered);
}

function renderBannerFor(ordered) {
  const banner = $('#eew-banner');
  const primary = ordered[0] || null;
  if (!primary) {
    banner.classList.remove('show');
    sound.stopAlarm();
    S.bannerEew = null;
    S.primaryKey = null;
    return;
  }
  S.bannerEew = primary;
  S.primaryKey = primary.key;
  renderEewBanner(banner, primary, ordered.slice(1), {});
  updateRotationChip();
  updateCountdown($('#eew-countdown'), primary, S.settings?.location, $('#eew-basis'), map);
  const local = localEstimate(primary);
  $('#eew-local').textContent = local !== null ? intensityLabel(local) : '—';

  // announce every EEW that we have not announced yet (one burst per batch)
  const fresh = ordered.filter((e) => !S.announced.has(e.key));
  fresh.forEach((e) => S.announced.add(e.key));
  if (fresh.length && S.booted) {
    const loud = fresh.slice().sort((a, b) => (b.maxi || 0) - (a.maxi || 0))[0];
    if (S.settings?.sound) sound.alarm(loud.maxi || 5);
    if (S.settings?.speech) {
      const places = fresh.map((e) => e.place || '').filter(Boolean).join('、');
      sound.speak(`緊急地震速報。${places}で地震。最大震度${intensityLabel(loud.maxi)}。強い揺れに警戒してください。`);
    }
    if (fresh.length > 1) {
      toast($('#toasts'), `同时收到 ${fresh.length} 条紧急地震速报`, 5000);
    }
  }
}

function localEstimate(eew) {
  const user = S.settings?.location;
  if (!user || !eew?.lat) return null;
  const d = haversine(user.lat, user.lon, eew.lat, eew.lon);
  const depth = eew.depth || 10;
  const m = eew.mag || 6;
  const r = Math.max(2, Math.hypot(d, depth));
  return Math.max(0, Math.min(7, 1.0 + 1.5 * m - 3.0 * Math.log10(r)));
}

function updateMapMode() {
  const el = $('#map-mode');
  if (!el) return;
  el.classList.toggle('replay', S.mode === 'replay');
  el.innerHTML = `<i></i>${S.mode === 'live' ? 'LIVE' : 'REPLAY'}`;
  $('#tl-live')?.classList.toggle('on', S.mode === 'live');
}

function updateTsunamiLegend(tsu) {
  const box = $('#tsunami-legend');
  if (!box) return;
  const areas = (tsu && tsu.areas) || [];
  const active = !!tsu && !tsu.cancelled && areas.length > 0 && map.showTsunami;
  box.hidden = !active;
  if (!active) return;
  const grades = [...new Set(areas.map((a) => a.grade))];
  const title = grades.includes('MajorWarning') ? '大津波警報発表'
    : grades.includes('Warning') ? '津波警報発表' : '津波注意報発表';
  const el = $('#ts-title');
  if (el) el.textContent = `${title} · ${areas.length} 区`;
}

function showLongperiodLegend(on) {
  ['#lp-bar', '#lp-labels', '#lp-caption'].forEach((sel) => {
    const el = $(sel);
    if (el) el.hidden = !on;
  });
}

function estimateLpAt(mag, distKm, depthKm) {
  if (!mag) return 0;
  const r = Math.max(5, Math.hypot(distKm, depthKm || 0));
  const v = 2.0 * Number(mag) - 2.9 * Math.log10(r) - 6.4;
  return Math.max(0, Math.min(4, v));
}

function buildEstimatedLp(ev) {
  if (!ev || !ev.lat) return null;
  const areas = [];
  for (const p of map.prefs) {
    const d = haversine(ev.lat, ev.lon, p.c[1], p.c[0]);
    const v = estimateLpAt(ev.mag, d, ev.depth);
    if (v >= 1) areas.push({ name: p.ja, cls: Math.round(v) });
  }
  if (!areas.length) return null;
  return {
    areas, estimated: true, lat: ev.lat, lon: ev.lon,
    maxi: Math.max(...areas.map((a) => a.cls)),
  };
}

function applyLongPeriodLayer() {
  const lp = S.state?.longperiod;
  if (lp && !lp.estimated && lp.time && Date.now() / 1000 - lp.time < 86400) {
    map.setLongperiod(lp);
    return;
  }
  map.setLongperiod(buildEstimatedLp(S.selected));
}

// ------------------------------------------------------------------ selection
async function selectEvent(key, type) {
  if (!key) return;
  try {
    if (type === 'eew') {
      // test EEWs are not stored, so resolve them from the live state
      const eew = (S.state?.eews || []).find((e) => e.key === key);
      if (eew) {
        S.pinnedKey = key;
        orderAndShowEews(S.state.eews || []);
        toast($('#toasts'), `切換至 ${eew.place || '速報'} · 最大震度${intensityLabel(eew.maxi)}`);
      }
      return;
    }
    const ev = await getJSON(`/api/event/${encodeURIComponent(key)}`);
    S.selected = ev;
    if (timeline) timeline.selectedKey = key;
    map.setSelection(ev);
    const user = S.settings?.location;
    const local = user && ev.lat ? localEstimate({ lat: ev.lat, lon: ev.lon, depth: ev.depth, mag: ev.mag }) : null;
    const latestLp = S.state?.longperiod;
    const lp = latestLp && ev.origin && Math.abs((latestLp.time || 0) - ev.origin) < 600 ? latestLp : null;
    let estLp = null;
    if (!lp && user && ev.lat) {
      estLp = Math.round(estimateLpAt(ev.mag, haversine(user.lat, user.lon, ev.lat, ev.lon), ev.depth));
      if (estLp < 1) estLp = null;
    }
    renderFocus($('#focus-body'), ev, {
      user,
      lp,
      estLp,
      localIntensity: local !== null && local !== undefined ? intensityLabel(local) : null,
      onReplay: () => { enterReplay(ev.origin); zoomToEvent(ev); },
      onZoom: () => zoomToEvent(ev),
      onLongPeriod: () => {
        map.showLongPeriod = true;
        document.querySelector('[data-layer="longperiod"]')?.classList.add('on');
        showLongperiodLegend(true);
        map.setLongperiod(lp || buildEstimatedLp(ev));
        toast($('#toasts'), lp ? '显示气象厅长周期情报层' : '显示推算长周期层（虚线）');
      },
    });
    if (map.showLongPeriod) applyLongPeriodLayer();
    refreshFeed();
  } catch (e) {
    console.error('selectEvent failed', e);
    toast($('#toasts'), '无法加载事件详情');
  }
}

function zoomToEvent(ev) {
  if (!ev.lat) return;
  map.zoom = Math.max(map.fitZoom * 2.4, map.zoom);
  const [sx, sy] = map.toScreen(ev.lon, ev.lat);
  map.cx += map.canvas.clientWidth / 2 - sx;
  map.cy += map.canvas.clientHeight / 2 - sy;
  map._clamp();
}

// ------------------------------------------------------------------ replay
async function enterReplay(ts) {
  if (!ts) return;
  S.mode = 'replay';
  S.replayTs = ts;
  S.playing = false;
  updatePlayButton();
  updateMapMode();
  timeline.setPlayhead(ts);
  S.timelineEnd = Math.max(ts, Date.now() / 1000);
  await loadReplayWindow(ts);
  await refreshTimeline();
  updateMapStamp(ts);
}

async function loadReplayWindow(center) {
  const span = 120;
  const from = center - span / 2;
  const to = center + span / 2;
  try {
    const res = await fetch(`/api/frames?from=${from}&to=${to}&step=0.5`, { cache: 'no-store' });
    const buf = await res.arrayBuffer();
    const frames = decodeFrames(buf);
    S.frames = frames;
    S.frameRange = frames.length ? [frames[0].ts, frames[frames.length - 1].ts] : [0, 0];
    drawReplayFrame(center);
  } catch (e) {
    toast($('#toasts'), '历史帧加载失败');
  }
}

function drawReplayFrame(ts) {
  if (!S.frames.length) return;
  let lo = 0, hi = S.frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (S.frames[mid].ts <= ts) lo = mid; else hi = mid - 1;
  }
  const f = S.frames[lo];
  if (f) { map.setFrame(f.arr); updateMapStamp(f.ts); }
}

let seekTimer = null;
function seekTo(ts) {
  S.mode = 'replay';
  S.replayTs = ts;
  timeline.setPlayhead(ts);
  updateMapStamp(ts);
  updateMapMode();
  clearTimeout(seekTimer);
  seekTimer = setTimeout(() => enterReplay(ts), 140);
}

function togglePlay() {
  if (S.mode === 'live') {
    enterReplay(Date.now() / 1000 - 120).then(() => { S.playing = true; updatePlayButton(); });
    return;
  }
  S.playing = !S.playing;
  updatePlayButton();
}

function updatePlayButton() {
  const btn = $('#tl-play');
  if (btn) btn.classList.toggle('playing', S.playing);
}

function goLive() {
  S.mode = 'live';
  S.playing = false;
  S.replayTs = null;
  S.frames = [];
  updatePlayButton();
  updateMapMode();
  timeline.setPlayhead(null);
  S.timelineEnd = Date.now() / 1000;
  loadLatestFrame();
  refreshTimeline();
  refreshHeat();
}

// ------------------------------------------------------------------ timeline data
async function refreshTimeline() {
  const end = S.mode === 'live' ? Date.now() / 1000 : Math.max(S.replayTs + 60, S.timelineEnd);
  const from = end - S.range;
  S.timelineEnd = end;
  timeline.setRange(S.range);
  timeline.setEnd(end);
  timeline.setPlayhead(S.mode === 'live' ? null : S.replayTs);
  try {
    const data = await getJSON(`/api/timeline?from=${Math.floor(from)}&to=${Math.floor(end)}`);
    timeline.setData(data);
  } catch (e) { /* ignore */ }
}

async function refreshHeat() {
  const end = S.mode === 'live' ? Date.now() / 1000 : S.timelineEnd;
  const from = end - S.range;
  heat.setWindow(from, end);
  try {
    const rows = await getJSON(`/api/heat?from=${Math.floor(from)}&to=${Math.floor(end)}`);
    heat.setData(rows);
  } catch (e) { /* ignore */ }
}

function changeRange(next) {
  S.range = Math.max(900, Math.min(86400 * 60, next));
  document.querySelectorAll('#tl-ranges button').forEach((b) => {
    b.classList.toggle('on', Math.abs(Number(b.dataset.range) - S.range) / S.range < 0.05);
  });
  refreshTimeline();
  refreshHeat();
}

function showTimelineTip(ts, x) {
  const tip = $('#tl-tip');
  if (ts === null || ts === undefined) { tip.classList.remove('show'); return; }
  tip.classList.add('show');
  tip.style.left = `${x}px`;
  const p = jstParts(ts);
  tip.textContent = `${p.date} ${p.clock}`;
}

// ------------------------------------------------------------------ loop
let lastTick = performance.now();
function loop(now) {
  const dt = Math.min(0.25, (now - lastTick) / 1000);
  lastTick = now;

  if (S.mode === 'replay' && S.playing) {
    S.replayTs += dt * S.speed;
    if (S.replayTs > S.frameRange[1] - 2) {
      loadReplayWindow(S.replayTs + 60);
    }
    if (S.replayTs > Date.now() / 1000) { goLive(); }
    else {
      drawReplayFrame(S.replayTs);
      timeline.setPlayhead(S.replayTs);
    }
  }
  const user = S.settings?.location;
  maybeRotate();
  const primary = S.bannerEew;
  if (primary) updateCountdown($('#eew-countdown'), primary, user, $('#eew-basis'), map);
  const queue = $('#eew-queue');
  if (queue && !queue.hidden) {
    queue.querySelectorAll('.q-count').forEach((el) => {
      const e = (S.state?.eews || []).find((x) => x.key === el.dataset.key);
      const sec = e ? secondsToArrival(e, user) : null;
      if (sec === null) { el.textContent = '--'; return; }
      el.textContent = sec > 0 ? `${sec.toFixed(0)}s` : '到达';
      el.classList.toggle('past', sec <= 0);
    });
  }

  map.draw(now);
  timeline.draw();
  if (heat) heat.draw();
  requestAnimationFrame(loop);
}

function tickClock() {
  const now = Date.now() / 1000;
  const p = jstParts(now);
  $('#jst-time').textContent = p.clock;
  $('#jst-date').textContent = `${p.date} ${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][p.wd]}`;
  $('#tl-clock').textContent = S.mode === 'live' ? p.hm : fmtTime(S.replayTs || now);
}

// ------------------------------------------------------------------ UI bindings
function bindUI() {
  document.querySelectorAll('#feed-filters .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('#feed-filters .chip').forEach((c) => c.classList.remove('on'));
      chip.classList.add('on');
      S.filter = chip.dataset.filter;
      refreshFeed();
    });
  });

  document.querySelectorAll('#tl-ranges button').forEach((btn) => {
    btn.addEventListener('click', () => changeRange(Number(btn.dataset.range)));
  });

  $('#tl-play').addEventListener('click', togglePlay);
  $('#tl-live').addEventListener('click', goLive);
  $('#tl-prev').addEventListener('click', () => jumpEvent(-1));
  $('#tl-next').addEventListener('click', () => jumpEvent(1));
  $('#tl-speed').addEventListener('change', (e) => { S.speed = Number(e.target.value); });

  $('#zoom-in').addEventListener('click', () => map.zoomAt(map.canvas.clientWidth / 2, map.canvas.clientHeight / 2, 1.4));
  $('#zoom-out').addEventListener('click', () => map.zoomAt(map.canvas.clientWidth / 2, map.canvas.clientHeight / 2, 1 / 1.4));
  document.querySelectorAll('.map-tools .tool').forEach((btn) => {
    btn.addEventListener('click', () => {
      const layer = btn.dataset.layer;
      if (!layer) return;
      btn.classList.toggle('on');
      const on = btn.classList.contains('on');
      if (layer === 'intensity') map.showIntensity = on;
      if (layer === 'cities') map.showCities = on;
      if (layer === 'history') map.showHistory = on;
      if (layer === 'tsunami') {
        map.showTsunami = on;
        updateTsunamiLegend(on ? S.state?.tsunami : null);
      }
      if (layer === 'longperiod') {
        map.showLongPeriod = on;
        showLongperiodLegend(on);
        if (on) applyLongPeriodLayer();
      }
    });
  });

  $('#eew-close').addEventListener('click', () => {
    const eew = S.bannerEew;
    if (eew) {
      S.dismissedEews.add(eew.key);
      if (S.dismissedEews.size > 60) S.dismissedEews.delete(S.dismissedEews.values().next().value);
      if (S.pinnedKey === eew.key) S.pinnedKey = null;
    }
    sound.stopAlarm();
    // fall back to the next active EEW instead of hiding everything
    if (S.state) orderAndShowEews(S.state.eews || []);
  });
  $('#eew-queue').addEventListener('click', (ev) => {
    const rot = ev.target.closest('#eew-rot');
    if (rot) {
      S.rotation.enabled = !S.rotation.enabled;
      if (S.rotation.enabled) {
        S.pinnedKey = null;
        S.rotation.last = Date.now();
      }
      updateRotationChip();
      if (S.state) orderAndShowEews(S.state.eews || []);
      toast($('#toasts'), S.rotation.enabled ? `恢复轮换（${Math.round(S.rotation.interval / 1000)} 秒）` : '已暂停轮换');
      return;
    }
    const btn = ev.target.closest('.eew-q');
    if (!btn) return;
    S.pinnedKey = btn.dataset.key;
    S.rotation.enabled = false;
    S.rotation.key = btn.dataset.key;
    if (S.state) orderAndShowEews(S.state.eews || []);
    updateRotationChip();
  });
  $('#eew-endtest').addEventListener('click', async () => {
    try {
      await postJSON('/api/demo/eew/end', {});
      toast($('#toasts'), '测试已结束');
    } catch (e) { toast($('#toasts'), '结束测试失败'); }
  });

  $('#btn-settings').addEventListener('click', () => openSettings());
  $('#btn-chronicle').addEventListener('click', () => openChronicle());
  $('#archive-chip').addEventListener('click', () => openChronicle());

  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => btn.closest('.modal').hidden = true);
  });
  document.querySelectorAll('.modal').forEach((m) => {
    m.addEventListener('click', (e) => { if (e.target === m) m.hidden = true; });
  });

  document.addEventListener('pointerdown', () => {
    if (!S.audioReady) { S.audioReady = true; sound.resume(); }
  }, { once: true });

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    if (e.key === 'l' || e.key === 'L') goLive();
    if (e.key === 'ArrowLeft') jumpEvent(-1);
    if (e.key === 'ArrowRight') jumpEvent(1);
    if (e.key === 'Escape') document.querySelectorAll('.modal').forEach((m) => m.hidden = true);
  });

  window.addEventListener('resize', () => { map._resize(); });
}

function jumpEvent(dir) {
  const list = (timeline.events || []).slice().sort((a, b) => a.origin - b.origin);
  if (!list.length) return;
  const cur = S.replayTs || Date.now() / 1000;
  const target = dir > 0 ? list.find((e) => e.origin > cur + 5) : [...list].reverse().find((e) => e.origin < cur - 5);
  if (target) {
    selectEvent(target.key);
    enterReplay(target.origin);
    zoomToEvent(target);
  }
}

function updateCursor(c) {
  const el = $('#map-cursor');
  el.classList.add('show');
  el.style.left = `${c.x}px`;
  el.style.top = `${c.y}px`;
  if (!el.dataset.hover) el.textContent = `${c.lat.toFixed(2)}N ${c.lon.toFixed(2)}E`;
}

// ------------------------------------------------------------------ modals
async function openSettings() {
  const st = S.state || {};
  const settings = {
    ...(st.settings || {}),
    sources: st.settings?.sources || { kmoni: true, p2pquake: true, jma: true },
    drillPref: S.drill?.pref || '宮城県',
    drillMag: S.drill?.mag ?? 7.0,
    drillDepth: S.drill?.depth ?? 40,
    drillMaxi: S.drill?.maxi ?? 6,
  };
  renderSettings($('#settings-body'), settings, {
    prefs: (map.prefs || []).map((p) => p.ja),
    onSave: async (patch) => {
      try {
        const res = await postJSON('/api/settings', patch);
        S.settings = res.settings;
        if (patch.location) {
          map.setUser(patch.location);
          (S.state?.eews || []).forEach((e) => {
            e._model = buildTravelModel(e, map, patch.location);
          });
        }
        S.palette = res.settings.palette;
        S.lut = buildRasterLUT(S.palette);
        map.setLUT(S.lut);
        sound.setEnabled(!!res.settings.sound);
        const rs = Number(res.settings.rotate_seconds ?? 5);
        S.rotation.setting = rs;
        S.rotation.interval = Math.max(0, rs) * 1000;
        S.rotation.enabled = rs > 0;
        S.rotation.key = null;
        S.rotation.last = Date.now();
        $('#modal-settings').hidden = true;
        toast($('#toasts'), '设置已保存');
        if (S.state) applyState(S.state);
      } catch (e) { toast($('#toasts'), '保存失败'); }
    },
    onCompact: async () => {
      try {
        const res = await postJSON('/api/compact', {});
        toast($('#toasts'), `整理完成，重写 ${res.removed} 帧`);
      } catch (e) { toast($('#toasts'), '整理失败'); }
    },
    onDrill: async (opts) => {
      S.drill = opts;
      try {
        await postJSON('/api/demo/eew', opts || {});
        $('#modal-settings').hidden = true;
        toast($('#toasts'), `测试速报 · ${opts?.pref || ''} · M${opts?.mag ?? ''} · 不写入历史`);
      } catch (e) { toast($('#toasts'), '测试失败'); }
    },
    onEndDrill: async () => {
      try {
        const res = await postJSON('/api/demo/eew/end', {});
        sound.stopAlarm();
        $('#eew-banner').classList.remove('show');
        toast($('#toasts'), res.ended?.length ? '已结束测试速报' : '当前没有测试速报');
      } catch (e) { toast($('#toasts'), '结束测试失败'); }
    },
    onDoubleDrill: async () => {
      try {
        const res = await postJSON('/api/demo/eew/double', {});
        $('#modal-settings').hidden = true;
        toast($('#toasts'), `双震演练 · ${res.eews?.length || 0} 条速报同时进行`);
      } catch (e) { toast($('#toasts'), '双震演练失败'); }
    },
    onClear: async (target) => {
      const label = target === 'frames' ? '全部震度帧' : target === 'events' ? '全部事件与速报' : '全部历史（帧 + 事件）';
      if (!window.confirm(`确定清除${label}？此操作不可恢复。`)) return;
      try {
        await postJSON('/api/clear', { target });
        toast($('#toasts'), '历史已清除');
        S.selected = null;
        refreshFeed();
        await refreshTimeline();
        await refreshHeat();
      } catch (e) { toast($('#toasts'), '清除失败'); }
    },
  });
  $('#modal-settings').hidden = false;
  $('#settings-body').classList.add('two-col');
}

async function openChronicle(search = '') {
  const body = $('#chronicle-body');
  body.innerHTML = '<div style="padding:30px;color:var(--dim)">读取档案…</div>';
  $('#modal-chronicle').hidden = false;
  try {
    const stats = await getJSON('/api/stats?days=30');
    const events = search
      ? await getJSON(`/api/search?q=${encodeURIComponent(search)}`)
      : (await getJSON(`/api/events?from=${Math.floor(Date.now() / 1000 - 30 * 86400)}&to=${Math.floor(Date.now() / 1000)}&limit=60`));
    renderChronicle(body, stats, stats.archive || {}, events, {
      onOpen: async (key) => {
        $('#modal-chronicle').hidden = true;
        await selectEvent(key);
        const ev = S.selected;
        if (ev) { enterReplay(ev.origin); zoomToEvent(ev); }
      },
      onSearch: (q) => openChronicle(q),
    });
  } catch (e) {
    body.innerHTML = '<div style="padding:30px;color:var(--dim)">档案读取失败</div>';
  }
}

// ------------------------------------------------------------------ go
init().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend',
    `<div style="position:fixed;inset:0;display:grid;place-items:center;background:#05080e;color:#9fb2cc;font:14px system-ui">
      <div>初始化失败：${String(err.message || err)}<br><br>请确认后端已启动（python -m app）。</div></div>`);
});

