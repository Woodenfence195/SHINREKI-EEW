// Timeline: activity histogram, event markers, playhead scrubbing and the
// prefecture x time intensity strip.

import { rampColor, colorFor } from './palette.js';
import { fmtTime, jstParts, intensityLabel } from './fmt.js';

export class Timeline {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts;
    this.range = 86400;
    this.end = Date.now() / 1000;
    this.buckets = [];
    this.events = [];
    this.eews = [];
    this.playhead = null;
    this.hover = null;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this._bind();
    this._resize();
    new ResizeObserver(() => this._resize()).observe(canvas);
  }

  setRange(sec) { this.range = sec; }
  setEnd(ts) { this.end = ts; }
  setData({ buckets, events, eews }) {
    if (buckets) this.buckets = buckets;
    if (events) this.events = events;
    if (eews) this.eews = eews;
  }
  setPlayhead(ts) { this.playhead = ts; }

  get start() { return this.end - this.range; }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.w = Math.max(200, rect.width);
    this.h = Math.max(60, rect.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  xOf(ts) { return ((ts - this.start) / this.range) * this.w; }
  tOf(x) { return this.start + (x / this.w) * this.range; }

  _bind() {
    let down = false;
    const seek = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const ts = this.tOf(Math.max(0, Math.min(this.w, e.clientX - rect.left)));
      this.hover = ts;
      this.opts.onSeek?.(ts);
    };
    this.canvas.addEventListener('pointerdown', (e) => { down = true; this.canvas.setPointerCapture(e.pointerId); seek(e); });
    this.canvas.addEventListener('pointermove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.hover = this.tOf(e.clientX - rect.left);
      if (down) seek(e);
      this.opts.onHover?.(this.hover, e.clientX - rect.left);
    });
    this.canvas.addEventListener('pointerup', () => { down = false; });
    this.canvas.addEventListener('pointerleave', () => { this.hover = null; this.opts.onHover?.(null); });
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.opts.onZoom?.(e.deltaY > 0 ? 1.35 : 0.74);
    }, { passive: false });
  }

  draw() {
    const ctx = this.ctx;
    const w = this.w, h = this.h;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // background
    ctx.fillStyle = 'rgba(6,11,19,0.55)';
    ctx.fillRect(0, 0, w, h);

    // grid + labels
    const steps = this.range <= 3600 ? 6 : this.range <= 21600 ? 6 : 6;
    const span = this.range;
    const labelFmt = span <= 21600 ? (t) => fmtTime(t, false) : (t) => jstParts(t).day + ' ' + jstParts(t).hm;
    ctx.font = '9px "Cascadia Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= steps; i++) {
      const x = (i / steps) * w;
      const t = this.start + (i / steps) * span;
      ctx.strokeStyle = 'rgba(120,170,220,0.07)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h - 16); ctx.stroke();
      ctx.fillStyle = 'rgba(120,145,175,0.55)';
      ctx.textAlign = i === 0 ? 'left' : i === steps ? 'right' : 'center';
      ctx.fillText(labelFmt(t), x, h - 13);
    }

    // histogram
    const bottom = h - 18;
    const maxN = Math.max(1, ...this.buckets.map((b) => b.n));
    const bw = Math.max(1, w / Math.max(1, this.range / 300));
    for (const b of this.buckets) {
      const x = this.xOf(b.t);
      if (x < -bw || x > w + bw) continue;
      const hgt = Math.max(2, Math.pow(b.n / maxN, 0.55) * (bottom - 8));
      const v = (b.maxi || 0) / 10;
      const c = rampColor(v);
      ctx.fillStyle = v < 0.4 ? 'rgba(90,130,170,0.28)' : `rgba(${c.rgb[0]},${c.rgb[1]},${c.rgb[2]},${0.55 + 0.35 * Math.min(1, v / 4)})`;
      ctx.fillRect(x, bottom - hgt, Math.max(1, bw * 0.8), hgt);
    }

    // events: lollipop markers on the baseline
    for (const ev of this.events) {
      const x = this.xOf(ev.origin);
      if (x < 0 || x > w) continue;
      const v = ev.maxi || 0;
      const c = rampColor(v);
      const selected = this.selectedKey && ev.key === this.selectedKey;
      const hh = selected ? 26 : 12;
      ctx.strokeStyle = `rgba(${c.rgb[0]},${c.rgb[1]},${c.rgb[2]},${selected ? 0.9 : 0.55})`;
      ctx.lineWidth = selected ? 1.6 : 1;
      ctx.beginPath(); ctx.moveTo(x, bottom); ctx.lineTo(x, bottom - hh); ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, bottom - hh, selected ? 3 : 2.2, 0, Math.PI * 2);
      ctx.fillStyle = colorFor(v);
      ctx.fill();
    }

    // EEW ticks (top)
    for (const e of this.eews) {
      const x = this.xOf(e.report);
      if (x < 0 || x > w) continue;
      ctx.fillStyle = 'rgba(255,77,109,0.85)';
      ctx.fillRect(x, 0, 1.2, 5);
    }

    // playhead
    const ph = this.playhead ?? this.end;
    const px = this.xOf(ph);
    if (px >= -1 && px <= w + 1) {
      ctx.strokeStyle = 'rgba(92,225,210,0.9)';
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h - 16); ctx.stroke();
      ctx.fillStyle = 'rgba(92,225,210,0.9)';
      ctx.beginPath();
      ctx.moveTo(px - 4, 0); ctx.lineTo(px + 4, 0); ctx.lineTo(px, 6); ctx.closePath(); ctx.fill();
    }

    // hover
    if (this.hover) {
      const hx = this.xOf(this.hover);
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(hx, 0); ctx.lineTo(hx, h - 16); ctx.stroke();
    }
  }
}

export class HeatStrip {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.rows = [];
    this.times = [];
    this.values = [];
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dirty = true;
    this._resize();
    new ResizeObserver(() => { this._resize(); this.dirty = true; }).observe(canvas);
  }

  setPrefs(prefs) {
    // rows ordered north -> south by centroid latitude
    this.rows = [...prefs].sort((a, b) => b.c[1] - a.c[1]);
    this.dirty = true;
  }

  setData(samples) {
    this.samples = samples || [];
    this.dirty = true;
  }

  setWindow(from, to) {
    this.t0 = from;
    this.t1 = to;
    this.dirty = true;
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.w = Math.max(200, rect.width);
    this.h = Math.max(30, rect.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  draw() {
    if (!this.dirty) return;
    this.dirty = false;
    const ctx = this.ctx;
    const { w, h } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(6,11,19,0.35)';
    ctx.fillRect(0, 0, w, h);
    if (!this.samples || !this.samples.length || !this.rows.length) {
      ctx.fillStyle = 'rgba(120,145,175,0.35)';
      ctx.font = '9px "Cascadia Mono", monospace';
      ctx.fillText('无历史数据', 6, h / 2 + 3);
      return;
    }
    const n = this.samples.length;
    const rowH = h / this.rows.length;
    const t0 = this.t0 ?? this.samples[0].t;
    const t1 = this.t1 ?? this.samples[n - 1].t;
    const span = Math.max(1, t1 - t0);
    for (let i = 0; i < n; i++) {
      const s = this.samples[i];
      const x = ((s.t - t0) / span) * w;
      const bw = Math.max(1.5, w / Math.max(60, (span / 10)));
      for (let r = 0; r < this.rows.length; r++) {
        const pref = this.rows[r];
        const val = (s.v[pref.id] || 0) / 10;
        if (val < 1.0) continue;
        const c = rampColor(val);
        ctx.fillStyle = `rgba(${c.rgb[0]},${c.rgb[1]},${c.rgb[2]},${Math.min(0.95, 0.25 + val / 6)})`;
        ctx.fillRect(x, r * rowH, bw, Math.max(1, rowH - 0.3));
      }
    }
  }
}
