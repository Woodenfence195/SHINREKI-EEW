// Intensity colour scales.  "shinreki" is the app's own continuous ramp;
// "jma" reproduces the official categorical JMA palette.

export const JMA = {
  0: '#F2F2FF', 1: '#F2F2FF', 2: '#00AAFF', 3: '#0041FF', 4: '#FAE696',
  5: '#FFE600', 5.5: '#FF9900', 6: '#FF2800', 6.5: '#A50021', 7: '#B40068',
};

const RAMP = [
  [0.0, [16, 30, 56], 0],
  [0.3, [24, 48, 92], 26],
  [0.6, [32, 78, 160], 60],
  [1.0, [46, 107, 255], 118],
  [1.5, [38, 158, 236], 168],
  [2.0, [34, 199, 201], 200],
  [2.6, [88, 216, 150], 220],
  [3.2, [142, 226, 79], 232],
  [4.0, [255, 212, 71], 244],
  [4.6, [255, 168, 56], 250],
  [5.0, [255, 138, 43], 255],
  [5.5, [255, 90, 60], 255],
  [6.0, [232, 38, 60], 255],
  [6.5, [192, 18, 79], 255],
  [7.0, [150, 42, 210], 255],
];

export function rampColor(v) {
  const x = Math.max(0, Math.min(7, Number(v) || 0));
  for (let i = 1; i < RAMP.length; i++) {
    if (x <= RAMP[i][0]) {
      const [a, ca, aa] = RAMP[i - 1];
      const [b, cb, ab] = RAMP[i];
      const t = b === a ? 0 : (x - a) / (b - a);
      const c = ca.map((n, j) => Math.round(n + (cb[j] - n) * t));
      return { rgb: c, a: Math.round(aa + (ab - aa) * t) };
    }
  }
  return { rgb: RAMP[RAMP.length - 1][1], a: 255 };
}

export function colorFor(v, palette = 'shinreki') {
  if (v === null || v === undefined) return '#26364a';
  const x = Number(v);
  if (palette === 'jma') {
    const key = x < 0.5 ? 0 : x < 1.5 ? 1 : x < 2.5 ? 2 : x < 3.5 ? 3 : x < 4.5 ? 4
      : x < 5.25 ? 5 : x < 5.75 ? 5.5 : x < 6.25 ? 6 : x < 6.75 ? 6.5 : 7;
    return JMA[key];
  }
  const { rgb } = rampColor(x);
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

// Little-endian RGBA packed into 32-bit words for fast ImageData writes.
export function buildRasterLUT(palette = 'shinreki') {
  const lut = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = 0, g = 0, b = 0, a = 0;
    if (i !== 255 && i <= 70) {
      const v = i / 10;
      if (palette === 'jma') {
        const hex = colorFor(v, 'jma').replace('#', '');
        r = parseInt(hex.slice(0, 2), 16);
        g = parseInt(hex.slice(2, 4), 16);
        b = parseInt(hex.slice(4, 6), 16);
        a = v < 0.5 ? 0 : 235;
      } else {
        const c = rampColor(v);
        [r, g, b] = c.rgb;
        a = c.a;
        // fade out the very bottom so the field melts into the map
        if (v < 0.25) a = 0;
      }
    }
    lut[i] = (a << 24) | (b << 16) | (g << 8) | r;
  }
  return lut;
}

export function bgFor(v) {
  // solid chip colour for badges / bars
  return colorFor(v, 'jma');
}
