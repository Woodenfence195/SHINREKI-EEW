// Synthesised alert sounds (no sampled audio) and optional TTS.

export class Sound {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.master = null;
    this.alarmTimer = null;
    this.alarmStop = null;
    this.voice = null;
    this._pickVoice();
  }

  _ensure() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.55;
    this.master.connect(this.ctx.destination);
    return this.ctx;
  }

  resume() {
    const ctx = this._ensure();
    if (ctx && ctx.state === 'suspended') ctx.resume();
  }

  setEnabled(on) { this.enabled = !!on; if (!on) this.stopAlarm(); }

  _tone(freq, start, dur, { type = 'sine', gain = 0.2, sweep = 0, attack = 0.008 } = {}) {
    const ctx = this._ensure();
    if (!ctx) return;
    const t0 = ctx.currentTime + start;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (sweep) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + sweep), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  _noise(start, dur, gain = 0.08) {
    const ctx = this._ensure();
    if (!ctx) return;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = gain;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 900;
    src.connect(f).connect(g).connect(this.master);
    src.start(ctx.currentTime + start);
  }

  // one urgent EEW siren phrase
  eewPhrase(level = 5) {
    if (!this.enabled) return;
    const base = level >= 6 ? 880 : 740;
    for (let i = 0; i < 3; i++) {
      this._tone(base, i * 0.19, 0.14, { type: 'square', gain: 0.13 });
      this._tone(base * 1.5, i * 0.19 + 0.085, 0.12, { type: 'sine', gain: 0.1 });
    }
    this._tone(base * 0.5, 0.02, 0.5, { type: 'sine', gain: 0.16, sweep: -120 });
    this._noise(0.02, 0.35, 0.03);
  }

  alarm(level = 5) {
    if (!this.enabled) return;
    this.stopAlarm();
    this.eewPhrase(level);
    this.alarmTimer = setInterval(() => this.eewPhrase(level), 1500);
    // JMA-style attention, but only for five seconds
    this.alarmStop = setTimeout(() => this.stopAlarm(), 5000);
  }

  stopAlarm() {
    if (this.alarmTimer) { clearInterval(this.alarmTimer); this.alarmTimer = null; }
    if (this.alarmStop) { clearTimeout(this.alarmStop); this.alarmStop = null; }
  }

  quake(maxi = 3) {
    if (!this.enabled) return;
    this.resume();
    const base = 520 + Math.min(6, maxi) * 40;
    this._tone(base, 0, 0.5, { type: 'sine', gain: 0.14, sweep: -80 });
    this._tone(base * 1.5, 0.14, 0.45, { type: 'sine', gain: 0.1 });
    this._tone(base * 2, 0.3, 0.6, { type: 'triangle', gain: 0.06 });
  }

  tick(high = false) {
    if (!this.enabled) return;
    this._tone(high ? 1320 : 880, 0, 0.05, { type: 'sine', gain: 0.04 });
  }

  _pickVoice() {
    try {
      const voices = speechSynthesis.getVoices();
      this.voice = voices.find((v) => /ja[-_]JP/i.test(v.lang)) || voices.find((v) => /zh[-_]CN/i.test(v.lang)) || null;
      if (!this.voice) {
        speechSynthesis.addEventListener('voiceschanged', () => this._pickVoice(), { once: true });
      }
    } catch (e) { /* no speech support */ }
  }

  speak(text) {
    if (!this.enabled || !('speechSynthesis' in window)) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      if (this.voice) u.voice = this.voice;
      u.lang = this.voice ? this.voice.lang : 'ja-JP';
      u.rate = 1.02;
      u.pitch = 0.95;
      u.volume = 0.9;
      speechSynthesis.speak(u);
    } catch (e) { /* ignore */ }
  }
}
