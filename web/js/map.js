// The map canvas: prefecture geometry, real-time intensity raster, hypocentres,
// P/S wavefronts, user position and interactive pan/zoom.

import { rampColor } from './palette.js';

const KM_PER_DEG = 111.0;

export class SeismicMap {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.opts = opts;
    this.grid = null;
    this.prefs = [];
    this.paths = null;
    this.raster = null;
    this.rasterImage = null;
    this.off = document.createElement('canvas');
    this.off.width = 352; this.off.height = 400;
    this.offCtx = this.off.getContext('2d');
    this.blur = document.createElement('canvas');
    this.blur.width = 264; this.blur.height = 300;
    this.blurCtx = this.blur.getContext('2d');
    this.zoom = 1.4;
    this.cx = 0; this.cy = 0;
    this.fitZoom = 1.4;
    this.user = null;
    this.events = [];
    this.eews = [];
    this.selection = null;
    this.hoverEvent = null;
    this.hoverPref = null;
    this.palette = 'shinreki';
    this.lut = null;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.showIntensity = true;
    this.showCities = true;
    this.showHistory = true;
    this.showTsunami = true;
    this.showLongPeriod = false;
    this.tsunami = null;
    this.longperiod = null;
    this.prefmap = null;
    this.coast = null;
    this.animTime = 0;
    this._bind();
    this._resize();
  }

  // ---------------------------------------------------------------- setup
  setGeography(doc) {
    this.grid = doc.grid;
    this.prefs = doc.prefs;
    this.paths = this.prefs.map((p) => {
      const path = new Path2D();
      for (const ring of p.rings) {
        for (let i = 0; i < ring.length; i += 2) {
          const x = (ring[i] - this.grid.lon_c) * this.grid.kx + this.grid.width / 2;
          const y = (this.grid.lat_c - ring[i + 1]) * this.grid.ky + this.grid.height / 2;
          if (i === 0) path.moveTo(x, y); else path.lineTo(x, y);
        }
        path.closePath();
      }
      return path;
    });
    this.pathsByName = {};
    this.prefsByNameJa = {};
    this.prefs.forEach((p, i) => {
      this.pathsByName[p.ja] = this.paths[i];
      this.prefsByNameJa[p.ja] = p;
    });
    this.resetView();
  }

  setLUT(lut) { this.lut = lut; if (this.raster) this._buildRasterImage(); }

  resetView() {
    const cw = this.canvas.clientWidth || 800;
    const ch = this.canvas.clientHeight || 600;
    this.fitZoom = Math.min(cw / this.grid.width, ch / this.grid.height) * 1.16;
    this.zoom = this.fitZoom;
    this.cx = cw / 2;
    this.cy = ch / 2;
  }

  setUser(loc) {
    this.user = loc;
  }

  setSelection(ev) {
    this.selection = ev || null;
  }

  setEvents(list) { this.events = list || []; }

  setEews(list) { this.eews = list || []; }

  setFrame(array) {
    this.raster = array;
    this._buildRasterImage();
  }

  setTsunami(tsu) { this.tsunami = tsu || null; }

  setLongperiod(lp) { this.longperiod = lp || null; }

  async loadPrefmap(url = '/data/prefmap.bin') {
    try {
      const res = await fetch(url, { cache: 'force-cache' });
      if (!res.ok) return;
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length !== this.grid.width * this.grid.height) return;
      this.prefmap = buf;
      this._buildCoastlines();
    } catch (e) { /* coastline layer unavailable */ }
  }

  _isLand(lon, lat) {
    if (!this.prefmap) return false;
    const [bx, by] = this.toBase(lon, lat);
    const x = Math.floor(bx), y = Math.floor(by);
    if (x < 0 || y < 0 || x >= this.grid.width || y >= this.grid.height) return false;
    return this.prefmap[y * this.grid.width + x] > 0;
  }

  _buildCoastlines() {
    this.coast = {};
    for (const p of this.prefs) {
      const segs = [];
      for (const ring of p.rings) {
        for (let i = 0; i + 3 < ring.length; i += 2) {
          const lon1 = ring[i], lat1 = ring[i + 1], lon2 = ring[i + 2], lat2 = ring[i + 3];
          const dLon = lon2 - lon1, dLat = lat2 - lat1;
          const len = Math.hypot(dLon, dLat);
          if (len < 0.012) continue;
          const nx = -dLat / len, ny = dLon / len;
          const mx = (lon1 + lon2) / 2, my = (lat1 + lat2) / 2;
          const off = 0.055;
          const a = this._isLand(mx + nx * off, my + ny * off);
          const b = this._isLand(mx - nx * off, my - ny * off);
          if (a === b) continue;
          const [x1, y1] = this.toBase(lon1, lat1);
          const [x2, y2] = this.toBase(lon2, lat2);
          segs.push([x1, y1, x2, y2]);
        }
      }
      this.coast[p.id] = segs;
    }
  }

  _matchPref(name) {
    if (!name) return null;
    const special = [
      ['相模湾', '神奈川県'], ['東京湾', '東京都'], ['伊豆諸島', '東京都'], ['小笠原', '東京都'],
      ['瀬戸内海', '香川県'], ['大阪湾', '大阪府'], ['有明海', '熊本県'], ['八代海', '熊本県'],
    ];
    for (const [key, pref] of special) {
      if (name.includes(key) && this.prefsByNameJa[pref]) return this.prefsByNameJa[pref];
    }
    let best = null, bestLen = 0;
    for (const p of this.prefs) {
      const base = p.ja.replace(/[都府県]$/, '');
      if (name.startsWith(base) && base.length > bestLen) { best = p; bestLen = base.length; }
    }
    return best;
  }

  _buildRasterImage() {
    if (!this.raster || !this.lut) return;
    const w = this.grid.width, h = this.grid.height;
    const img = this.offCtx.createImageData(w, h);
    const buf = new Uint32Array(img.data.buffer);
    const lut = this.lut;
    const src = this.raster;
    for (let i = 0; i < src.length; i++) buf[i] = lut[src[i]];
    this.offCtx.putImageData(img, 0, 0);
    this.rasterImage = true;
  }

  // ---------------------------------------------------------------- view
  toBase(lon, lat) {
    return [
      (lon - this.grid.lon_c) * this.grid.kx + this.grid.width / 2,
      (this.grid.lat_c - lat) * this.grid.ky + this.grid.height / 2,
    ];
  }

  toScreen(lon, lat) {
    const [bx, by] = this.toBase(lon, lat);
    return [
      (bx - this.grid.width / 2) * this.zoom + this.cx,
      (by - this.grid.height / 2) * this.zoom + this.cy,
    ];
  }

  toLonLat(sx, sy) {
    const bx = (sx - this.cx) / this.zoom + this.grid.width / 2;
    const by = (sy - this.cy) / this.zoom + this.grid.height / 2;
    return [
      (bx - this.grid.width / 2) / this.grid.kx + this.grid.lon_c,
      this.grid.lat_c - (by - this.grid.height / 2) / this.grid.ky,
    ];
  }

  // km -> base-pixel units (the coordinate space of the vector map).
  // The canvas transform already applies the zoom, so this must NOT scale with it.
  kmToPx(km) { return (km / KM_PER_DEG) * this.grid.ky; }

  zoomAt(sx, sy, factor) {
    const before = this.toLonLat(sx, sy);
    this.zoom = Math.max(this.fitZoom * 0.82, Math.min(this.fitZoom * 14, this.zoom * factor));
    const after = this.toLonLat(sx, sy);
    const [bx1, by1] = this.toBase(before[0], before[1]);
    const [bx2, by2] = this.toBase(after[0], after[1]);
    this.cx += (bx2 - bx1) * this.zoom;
    this.cy += (by2 - by1) * this.zoom;
    this._clamp();
  }

  _clamp() {
    if (!this.grid) return;
    const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    const margin = 120;
    const maxX = this.grid.width * this.zoom * 0.55 + margin;
    const maxY = this.grid.height * this.zoom * 0.55 + margin;
    this.cx = Math.max(cw - maxX, Math.min(maxX, this.cx));
    this.cy = Math.max(ch - maxY, Math.min(maxY, this.cy));
  }

  // ---------------------------------------------------------------- draw
  draw(time = performance.now()) {
    this.animTime = time;
    const ctx = this.ctx;
    const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    // deep-sea background
    const g = ctx.createRadialGradient(cw * 0.5, ch * 0.42, 40, cw * 0.5, ch * 0.5, Math.max(cw, ch) * 0.75);
    g.addColorStop(0, '#0a1622');
    g.addColorStop(0.55, '#070e19');
    g.addColorStop(1, '#04070d');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cw, ch);

    if (!this.grid || !this.paths) return;

    ctx.save();
    ctx.setTransform(
      this.dpr * this.zoom, 0, 0, this.dpr * this.zoom,
      this.dpr * (this.cx - this.grid.width / 2 * this.zoom),
      this.dpr * (this.cy - this.grid.height / 2 * this.zoom),
    );

    this._drawGraticule(ctx);
    this._drawLand(ctx);
    if (this.showIntensity && this.rasterImage) this._drawRaster(ctx);
    if (this.showHistory) this._drawHistory(ctx);
    this._drawTsunami(ctx);
    this._drawLongperiod(ctx);
    this._drawEewShade(ctx);
    this._drawWaves(ctx);
    this._drawHypocenters(ctx);
    this._drawUser(ctx);
    if (this.showCities) this._drawLabels(ctx);
    ctx.restore();

    this._drawVignette(ctx, cw, ch);
  }

  _drawGraticule(ctx) {
    const step = this.zoom > 3 ? 1 : 2;
    ctx.lineWidth = 0.6 / this.zoom;
    ctx.strokeStyle = 'rgba(110,160,200,0.055)';
    ctx.beginPath();
    for (let lon = 126; lon <= 148; lon += step) {
      const [x] = this.toBase(lon, 0);
      ctx.moveTo(x, 0); ctx.lineTo(x, this.grid.height);
    }
    for (let lat = 28; lat <= 48; lat += step) {
      const [, y] = this.toBase(0, lat);
      ctx.moveTo(0, y); ctx.lineTo(this.grid.width, y);
    }
    ctx.stroke();
  }

  _drawLand(ctx) {
    const glow = this.zoom < 2.2;
    for (let i = 0; i < this.prefs.length; i++) {
      const p = this.prefs[i];
      const path = this.paths[i];
      if (this.hoverPref === p.ja) {
        ctx.fillStyle = 'rgba(38,70,96,0.9)';
      } else {
        ctx.fillStyle = 'rgba(17,29,43,0.94)';
      }
      ctx.fill(path);
      ctx.lineWidth = 0.7 / this.zoom;
      ctx.strokeStyle = 'rgba(86,140,178,0.42)';
      ctx.stroke(path);
      if (glow) {
        ctx.lineWidth = 2.4 / this.zoom;
        ctx.strokeStyle = 'rgba(60,110,150,0.10)';
        ctx.stroke(path);
      }
    }
  }

  _drawRaster(ctx) {
    const w = this.grid.width, h = this.grid.height;
    if (this.zoom > 4.2) {
      // close-up: crisp station pixels
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.off, 0, 0, w, h);
      return;
    }
    // soft thermal field: downsample then upsample for a blurred look
    const b = this.blurCtx;
    b.clearRect(0, 0, this.blur.width, this.blur.height);
    b.imageSmoothingEnabled = true;
    b.drawImage(this.off, 0, 0, this.blur.width, this.blur.height);
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 1;
    ctx.drawImage(this.blur, 0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.28;
    ctx.drawImage(this.blur, -1.2, -1.2, w + 2.4, h + 2.4);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  _drawHistory(ctx) {
    if (!this.showHistory) return;
    const now = this.animTime / 1000;
    for (const ev of this.events) {
      if (!ev.lat || !ev.lon) continue;
      if (this.selection && ev.key === this.selection.key) continue;
      const [bx, by] = this.toBase(ev.lon, ev.lat);
      const age = Math.max(0, (ev.age ?? 3600));
      const alpha = 0.22 + 0.35 * Math.exp(-age / 7200);
      const size = 3.2 / this.zoom;
      ctx.beginPath();
      ctx.arc(bx, by, size, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(150,190,220,${alpha.toFixed(2)})`;
      ctx.lineWidth = 0.8 / this.zoom;
      ctx.stroke();
    }
  }

  _drawTsunami(ctx) {
    const tsu = this.tsunami;
    if (!this.showTsunami || !tsu || tsu.cancelled) return;
    const items = this._tsunamiItems(tsu);
    if (!items.length) return;
    for (const item of items) {
      const segs = this.coast && this.coast[item.pref.id];
      if (!segs || !segs.length) continue;
      const color = item.color;
      const width = (4.5 + Math.min(9, item.height) * 2.2) / this.zoom;
      const path = this.pathsByName[item.pref.ja];
      // inland wash, clipped to land
      ctx.save();
      if (path) ctx.clip(path);
      ctx.beginPath();
      for (const [x1, y1, x2, y2] of segs) { ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); }
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.3;
      ctx.lineWidth = width * 2.4;
      ctx.lineCap = 'round';
      ctx.stroke();
      ctx.restore();
      // shoreline stroke
      ctx.save();
      ctx.beginPath();
      for (const [x1, y1, x2, y2] of segs) { ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); }
      ctx.globalAlpha = 0.95;
      ctx.lineWidth = Math.max(1.6, 2.8 / this.zoom);
      ctx.strokeStyle = color;
      ctx.lineCap = 'round';
      ctx.stroke();
      // flowing dashes
      ctx.globalAlpha = 0.7;
      ctx.setLineDash([5 / this.zoom, 10 / this.zoom]);
      ctx.lineDashOffset = -((this.animTime / 34) % 120);
      ctx.lineWidth = Math.max(1.4, 1.8 / this.zoom);
      ctx.stroke();
      ctx.restore();
      // label
      if (this.zoom > 1.0) {
        const [bx, by] = this.toBase(item.pref.c[0], item.pref.c[1]);
        const text = `${item.pref.ja.replace(/[都府県]$/, '')} ${item.label}${item.height ? ' ' + item.height + 'm' : ''}`;
        ctx.font = `600 ${10 / this.zoom}px "Microsoft YaHei UI", system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const tw = ctx.measureText(text).width;
        ctx.fillStyle = 'rgba(24,4,10,0.72)';
        ctx.fillRect(bx - tw / 2 - 4 / this.zoom, by - 8 / this.zoom, tw + 8 / this.zoom, 16 / this.zoom);
        ctx.fillStyle = color;
        ctx.fillText(text, bx, by);
      }
    }
  }

  _tsunamiItems(tsu) {
    const out = [];
    for (const area of tsu.areas || []) {
      const pref = this._matchPref(area.name);
      if (!pref) continue;
      const grade = area.grade || 'Warning';
      let height = 0;
      const candidates = [area.max, area.maxHeight, area.firstHeight, area.first];
      for (const c of candidates) {
        if (c && typeof c.value === 'number') { height = Math.max(height, c.value); }
        else if (typeof c === 'number') { height = Math.max(height, c); }
      }
      if (!height) {
        height = grade === 'MajorWarning' ? 5 : grade === 'Warning' ? 3 : 0.5;
      }
      const color = grade === 'MajorWarning' ? '#C2185B' : grade === 'Warning' ? '#FF3B3B' : '#FFB300';
      const label = grade === 'MajorWarning' ? '大津波警報' : grade === 'Warning' ? '津波警報' : '津波注意報';
      const existing = out.find((o) => o.pref.id === pref.id);
      if (existing) {
        if (height > existing.height) Object.assign(existing, { height, color, label });
      } else {
        out.push({ pref, grade, height, color, label });
      }
    }
    return out;
  }

  _drawLongperiod(ctx) {
    const lp = this.longperiod;
    if (!this.showLongPeriod || !lp || !lp.areas || !lp.areas.length) return;
    const byPref = new Map();
    for (const area of lp.areas) {
      const pref = this._matchPref(area.name || area.pref);
      if (!pref) continue;
      const cls = Number(area.cls ?? area.class ?? 0);
      if (!cls) continue;
      if (!byPref.has(pref.id) || byPref.get(pref.id) < cls) byPref.set(pref.id, cls);
    }
    const colors = { 1: '#FFE9A8', 2: '#FFB300', 3: '#FF5252', 4: '#A03CBA' };
    for (const [pid, cls] of byPref) {
      const pref = this.prefs.find((p) => p.id === pid);
      if (!pref) continue;
      const path = this.pathsByName[pref.ja];
      if (!path) continue;
      const color = colors[Math.min(4, Math.max(1, Math.round(cls)))] || '#FFB300';
      ctx.save();
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.16;
      ctx.fill(path);
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 1.3 / this.zoom;
      ctx.setLineDash(lp.estimated ? [4 / this.zoom, 4 / this.zoom] : []);
      ctx.strokeStyle = color;
      ctx.stroke(path);
      ctx.restore();
      if (this.zoom > 1.3) {
        const [bx, by] = this.toBase(pref.c[0], pref.c[1]);
        const text = `階級${Math.round(cls)}`;
        ctx.font = `700 ${9.5 / this.zoom}px "Microsoft YaHei UI", system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(6,12,20,0.6)';
        const tw = ctx.measureText(text).width;
        ctx.fillRect(bx - tw / 2 - 3 / this.zoom, by - 7 / this.zoom + 12 / this.zoom, tw + 6 / this.zoom, 13 / this.zoom);
        ctx.fillStyle = color;
        ctx.fillText(text, bx, by + 18 / this.zoom);
      }
    }
  }

  _drawEewShade(ctx) {
    const list = (this.eews || []).slice(0, 3);
    if (!list.length) return;
    list.forEach((eew, idx) => {
      if (!eew || !eew.areas) return;
      const primary = idx === 0;
      const accent = eew._rgb || '255,90,110';
      const map = new Map();
      for (const area of eew.areas) {
        const pref = area.pref;
        if (!pref) continue;
        const val = area.to ?? area.from ?? 0;
        if (!map.has(pref) || map.get(pref) < val) map.set(pref, val);
      }
      const drawn = [];
      const ranked = [...map.entries()].sort((a, b) => b[1] - a[1]);
      let labelled = 0;
      for (const [name, val] of ranked) {
        const pref = this._resolvePref(name);
        if (!pref) continue;
        const path = this.pathsByName[pref.ja];
        if (!path) continue;
        if (primary) {
          const c = rampColor(val);
          ctx.fillStyle = `rgba(${c.rgb[0]},${c.rgb[1]},${c.rgb[2]},0.16)`;
          ctx.fill(path);
          ctx.lineWidth = 1.4 / this.zoom;
          ctx.strokeStyle = `rgba(${c.rgb[0]},${c.rgb[1]},${c.rgb[2]},${0.55 + 0.3 * Math.sin(this.animTime / 260)})`;
          ctx.stroke(path);
          if (this.zoom > 1.6 && val >= 4 && labelled < 5) {
            const [bx, by] = this.toBase(pref.c[0], pref.c[1]);
            if (drawn.some(([dx, dy]) => Math.hypot(dx - bx, dy - by) * this.zoom < 52)) continue;
            drawn.push([bx, by]);
            labelled += 1;
            const text = `${name} ${this._intensityLabel(val)}`;
            ctx.font = `600 ${9.5 / this.zoom}px "Microsoft YaHei UI", system-ui, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const tw = ctx.measureText(text).width;
            ctx.fillStyle = 'rgba(6,12,20,0.62)';
            ctx.fillRect(bx - tw / 2 - 3 / this.zoom, by - 7 / this.zoom, tw + 6 / this.zoom, 14 / this.zoom);
            ctx.fillStyle = `rgba(${c.rgb[0]},${c.rgb[1]},${c.rgb[2]},0.95)`;
            ctx.fillText(text, bx, by);
          }
        } else {
          // secondary events: dashed outline only, so the primary stays readable
          ctx.save();
          ctx.setLineDash([4 / this.zoom, 4 / this.zoom]);
          ctx.lineWidth = 1.1 / this.zoom;
          ctx.strokeStyle = `rgba(${accent},${0.5 + 0.2 * Math.sin(this.animTime / 300)})`;
          ctx.stroke(path);
          ctx.restore();
        }
      }
    });
  }

  _intensityLabel(v) {
    if (v < 0.5) return '0';
    if (v < 1.5) return '1';
    if (v < 2.5) return '2';
    if (v < 3.5) return '3';
    if (v < 4.5) return '4';
    if (v < 5.25) return '5弱';
    if (v < 5.75) return '5強';
    if (v < 6.25) return '6弱';
    if (v < 6.75) return '6強';
    return '7';
  }

  _prefName(name) {
    const table = { 東京: '東京都', 大阪: '大阪府', 京都: '京都府', 北海道: '北海道' };
    return table[name] || name;
  }

  _resolvePref(name) {
    if (!name) return null;
    const direct = this._prefName(name);
    if (this.prefsByNameJa[direct]) return this.prefsByNameJa[direct];
    const key = Object.keys(this.prefsByNameJa).find(
      (k) => k.startsWith(name) || name.startsWith(k.replace(/[都府県]$/, '')),
    );
    return key ? this.prefsByNameJa[key] : null;
  }

  _prefPath(name) {
    const pref = this._resolvePref(name);
    return pref ? this.pathsByName[pref.ja] : null;
  }

  _drawWaves(ctx) {
    const list = (this.eews || []).slice(0, 3);
    if (!list.length) return;
    const now = Date.now() / 1000;
    const label = (text, x, y, color) => {
      ctx.font = `700 ${9 / this.zoom}px "Cascadia Mono", monospace`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(6,12,20,0.7)';
      ctx.fillRect(x, y - 6 / this.zoom, 13 / this.zoom, 12 / this.zoom);
      ctx.fillStyle = color;
      ctx.fillText(text, x + 3 / this.zoom, y);
    };
    list.forEach((eew, idx) => {
      if (!eew || !eew.lat || !eew.lon) return;
      const rgb = eew._rgb || '255,90,110';
      const primary = idx === 0;
      const model = eew._model;
      const origin = model ? model.origin : (eew.origin || eew.report - 5);
      const elapsed = Math.max(0, now - origin);
      const [bx, by] = this.toBase(eew.lon, eew.lat);
      let pKm;
      let sKm;
      if (model) {
        // same travel-time model as the countdown, so circle and ETA agree
        pKm = model.pRadiusAt(elapsed);
        sKm = model.radiusAt(elapsed);
      } else {
        const depth = eew.depth || 10;
        pKm = Math.hypot(7.0 * elapsed, depth);
        sKm = Math.hypot(4.0 * elapsed, depth);
      }
      const pR = this.kmToPx(pKm);
      const sR = this.kmToPx(sKm);
      ctx.save();
      ctx.beginPath();
      ctx.arc(bx, by, Math.max(2, pR), 0, Math.PI * 2);
      ctx.strokeStyle = primary ? 'rgba(110,180,255,0.5)' : `rgba(${rgb},0.32)`;
      ctx.lineWidth = (primary ? 1.3 : 1.0) / this.zoom;
      ctx.setLineDash([5 / this.zoom, 5 / this.zoom]);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(bx, by, Math.max(2, sR), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${rgb},${primary ? 0.62 : 0.42})`;
      ctx.setLineDash([]);
      ctx.lineWidth = (primary ? 1.0 : 0.9) / this.zoom;
      ctx.stroke();
      if (primary) {
        if (pR > 6) label('P', bx + pR * 0.7, by - pR * 0.7, 'rgba(140,195,255,0.85)');
        if (sR > 6) label('S', bx + sR * 0.7, by - sR * 0.7, `rgba(${rgb},0.9)`);
      }
      if (sR > 10) {
        const n = Number(eew._num) || 0;
        const num = n >= 1 && n <= 10 ? '①②③④⑤⑥⑦⑧⑨⑩'[n - 1] : (n ? `#${n}` : '');
        ctx.font = `700 ${13 / this.zoom}px "Microsoft YaHei UI", system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(6,12,20,0.72)';
        ctx.beginPath();
        ctx.arc(bx + sR * 0.985, by - sR * 0.17, 9 / this.zoom, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `rgba(${rgb},0.95)`;
        ctx.fillText(num, bx + sR * 0.985, by - sR * 0.17);
      }
      ctx.restore();
    });
  }

  _drawHypocenters(ctx) {
    const list = [];
    if (this.selection && this.selection.lat) list.push({ ...this.selection, strong: true });
    else {
      const recent = this.events.slice(0, 3).filter((e) => e.lat);
      if (recent[0]) list.push({ ...recent[0], strong: true });
    }
    const now = this.animTime / 1000;
    for (const ev of list) {
      const [bx, by] = this.toBase(ev.lon, ev.lat);
      const c = rampColor(ev.maxi || 0);
      const strong = ev.strong;
      const pulse = (Math.sin(now * 2.2) + 1) / 2;
      if (strong) {
        for (let k = 0; k < 3; k++) {
          const r = (8 + k * 9 + pulse * 5) / this.zoom;
          ctx.beginPath();
          ctx.arc(bx, by, r, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(255,120,120,${(0.5 - k * 0.14).toFixed(2)})`;
          ctx.lineWidth = 1 / this.zoom;
          ctx.stroke();
        }
      }
      const s = 5 / this.zoom;
      ctx.beginPath();
      ctx.moveTo(bx - s, by); ctx.lineTo(bx + s, by);
      ctx.moveTo(bx, by - s); ctx.lineTo(bx, by + s);
      ctx.strokeStyle = 'rgba(255,120,120,0.9)';
      ctx.lineWidth = 1.2 / this.zoom;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(bx, by, 2.4 / this.zoom, 0, Math.PI * 2);
      ctx.fillStyle = `rgb(${c.rgb[0]},${c.rgb[1]},${c.rgb[2]})`;
      ctx.fill();

      if (strong) {
        const label = `${ev.place || ''}`;
        ctx.font = `${12 / this.zoom}px "Microsoft YaHei UI", system-ui, sans-serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(6,12,20,0.72)';
        ctx.fillRect(bx + 10 / this.zoom, by - 18 / this.zoom, tw + 12 / this.zoom, 20 / this.zoom);
        ctx.fillStyle = 'rgba(226,240,255,0.92)';
        ctx.fillText(label, bx + 16 / this.zoom, by - 8 / this.zoom);
      }
    }
  }

  _drawUser(ctx) {
    if (!this.user) return;
    const [bx, by] = this.toBase(this.user.lon, this.user.lat);
    const t = this.animTime / 1000;
    ctx.beginPath();
    ctx.arc(bx, by, (7 + Math.sin(t * 2) * 1.5) / this.zoom, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(92,225,210,0.55)';
    ctx.lineWidth = 1 / this.zoom;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(bx, by, 2.4 / this.zoom, 0, Math.PI * 2);
    ctx.fillStyle = '#5ce1d2';
    ctx.fill();
    ctx.font = `${9 / this.zoom}px "Cascadia Mono", monospace`;
    ctx.fillStyle = 'rgba(92,225,210,0.8)';
    ctx.textAlign = 'center';
    ctx.fillText(this.user.name || '现在地', bx, by + 14 / this.zoom);
  }

  _drawLabels(ctx) {
    const cities = [
      ['札幌', 43.06, 141.35], ['仙台', 38.27, 140.87], ['東京', 35.68, 139.77],
      ['名古屋', 35.18, 136.91], ['大阪', 34.69, 135.50], ['広島', 34.39, 132.46],
      ['福岡', 33.59, 130.40], ['新潟', 37.90, 139.02], ['金沢', 36.56, 136.66],
      ['那覇', 26.21, 127.68], ['青森', 40.82, 140.75], ['高知', 33.56, 133.53],
    ];
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const [name, lat, lon] of cities) {
      if (this.zoom < 1.9 && name !== '東京' && name !== '大阪' && name !== '札幌' && name !== '福岡') continue;
      const [bx, by] = this.toBase(lon, lat);
      ctx.beginPath();
      ctx.arc(bx, by, 1.4 / this.zoom, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(180,210,235,0.55)';
      ctx.fill();
      ctx.font = `${9.5 / this.zoom}px "Microsoft YaHei UI", system-ui, sans-serif`;
      ctx.fillStyle = 'rgba(178,205,230,0.7)';
      ctx.fillText(name, bx + 4 / this.zoom, by - 4 / this.zoom);
    }
    if (this.zoom > 2.6) {
      for (const p of this.prefs) {
        ctx.font = `${8.5 / this.zoom}px "Microsoft YaHei UI", system-ui, sans-serif`;
        ctx.fillStyle = 'rgba(140,175,205,0.42)';
        ctx.textAlign = 'center';
        const [bx, by] = this.toBase(p.c[0], p.c[1]);
        ctx.fillText(p.ja, bx, by);
      }
    }
  }

  _drawVignette(ctx, cw, ch) {
    const v = ctx.createRadialGradient(cw / 2, ch / 2, Math.min(cw, ch) * 0.35, cw / 2, ch / 2, Math.max(cw, ch) * 0.72);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, cw, ch);
  }

  // ---------------------------------------------------------------- interaction
  _bind() {
    const c = this.canvas;
    let dragging = false;
    let moved = 0;
    let last = null;
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      const f = Math.exp(-e.deltaY * 0.0016);
      this.zoomAt(e.clientX - rect.left, e.clientY - rect.top, f);
    }, { passive: false });

    c.addEventListener('pointerdown', (e) => {
      dragging = true;
      moved = 0;
      last = [e.clientX, e.clientY];
      c.setPointerCapture(e.pointerId);
      c.classList.add('dragging');
    });
    c.addEventListener('pointermove', (e) => {
      const rect = c.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      if (dragging && last) {
        const dx = mx - last[0], dy = my - last[1];
        moved += Math.abs(dx) + Math.abs(dy);
        this.cx += dx;
        this.cy += dy;
        last = [mx, my];
        this._clamp();
      }
      this._hover(mx, my);
    });
    c.addEventListener('pointerup', (e) => {
      const wasDrag = moved > 6;
      dragging = false;
      last = null;
      c.classList.remove('dragging');
      if (!wasDrag) {
        const rect = c.getBoundingClientRect();
        const hit = this._pick(e.clientX - rect.left, e.clientY - rect.top);
        if (hit) this.opts.onSelect?.(hit);
      }
    });
    c.addEventListener('pointerleave', () => { dragging = false; last = null; });
    c.addEventListener('dblclick', (e) => {
      const rect = c.getBoundingClientRect();
      this.zoomAt(e.clientX - rect.left, e.clientY - rect.top, 1.6);
    });
  }

  _pick(mx, my) {
    let best = null;
    let bestD = 16;
    for (const ev of this.events) {
      if (!ev.lat) continue;
      const [x, y] = this.toScreen(ev.lon, ev.lat);
      const d = Math.hypot(x - mx, y - my);
      if (d < bestD) { bestD = d; best = ev; }
    }
    return best;
  }

  _hover(mx, my) {
    const [lon, lat] = this.toLonLat(mx, my);
    this.opts.onCursor?.({ lon, lat, x: mx, y: my });
    const pref = this._prefAt(lon, lat);
    this.hoverPref = pref;
    const hit = this._pick(mx, my);
    this.hoverEvent = hit;
    this.opts.onHover?.(hit, pref);
  }

  _prefAt(lon, lat) {
    for (const p of this.prefs) {
      const b = p.bbox;
      if (lon < b[0] - 0.1 || lon > b[2] + 0.1 || lat < b[1] - 0.1 || lat > b[3] + 0.1) continue;
      for (const ring of p.rings) {
        let inside = false;
        for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
          const xi = ring[i], yi = ring[i + 1], xj = ring[j], yj = ring[j + 1];
          if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi || 1e-12) + xi) inside = !inside;
        }
        if (inside) return p.ja;
      }
    }
    return null;
  }

  _resize() {
    const c = this.canvas;
    const rect = c.getBoundingClientRect();
    const w = Math.max(320, Math.round(rect.width));
    const h = Math.max(280, Math.round(rect.height));
    c.width = Math.round(w * this.dpr);
    c.height = Math.round(h * this.dpr);
    if (this.grid && this.zoom === this.fitZoom) this.resetView();
    this._clamp?.();
  }

  observeResize() {
    const ro = new ResizeObserver(() => this._resize());
    ro.observe(this.canvas);
    this._resize();
  }
}

function rect0(el) { return el.getBoundingClientRect(); }
