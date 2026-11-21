// Preset Picker in the browser: reading Lightroom .xmp presets, writing sidecars, and the
// approximate preview render. A JavaScript port of presetpicker/presets.py and render.py.
"use strict";

const NS_CRS = "http://ns.adobe.com/camera-raw-settings/1.0/";
const NS_RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";

// Preset bookkeeping that must not end up in a photo's develop settings (as in presets.py).
const SKIP = new Set([
  "Name", "ShortName", "SortName", "Group", "Description", "UUID", "Cluster", "PresetType",
  "SupportsAmount", "SupportsAmount2", "SupportsColor", "SupportsMonochrome",
  "SupportsHighDynamicRange", "SupportsNormalDynamicRange", "SupportsSceneReferred",
  "SupportsOutputReferred", "RequiresRGBTables", "CameraModelRestriction", "Copyright",
  "ContactInfo", "ShowInPresets", "ShowInQuickActions", "CompatibleVersion",
  "IncrementalTemperature", "IncrementalTint", "WhiteBalance",
]);

/* ---------------------------------------------------------------- presets */

function parsePreset(text, fileName) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const desc = doc.getElementsByTagNameNS(NS_RDF, "Description")[0];
  if (!desc) return null;
  const localized = field => {
    const attr = desc.getAttributeNS(NS_CRS, field);
    if (attr) return attr;
    const el = desc.getElementsByTagNameNS(NS_CRS, field)[0];
    const li = el && el.getElementsByTagNameNS(NS_RDF, "li")[0];
    return li && li.textContent.trim() || "";
  };
  const settings = {};
  for (const a of desc.attributes) if (a.namespaceURI === NS_CRS) settings[a.localName] = a.value;
  for (const child of desc.children) {
    if (child.namespaceURI === NS_CRS && child.localName.startsWith("ToneCurvePV2012")) {
      settings[child.localName] = [...child.getElementsByTagNameNS(NS_RDF, "li")]
        .map(li => li.textContent.split(",").map(Number)).filter(p => p.length === 2 && p.every(Number.isFinite));
    }
  }
  return {
    id: fileName,
    name: localized("Name") || fileName.replace(/\.xmp$/i, ""),
    group: localized("Group"),
    text, desc, settings,
    summary: summarize(settings),
  };
}

const SUMMARY = [["Exposure2012", "EXP", 2], ["Contrast2012", "CON", 0], ["Highlights2012", "HL", 0],
  ["Shadows2012", "SH", 0], ["Whites2012", "WH", 0], ["Blacks2012", "BL", 0], ["Texture", "TEX", 0],
  ["Clarity2012", "CLR", 0], ["Dehaze", "DHZ", 0], ["Vibrance", "VIB", 0], ["Saturation", "SAT", 0],
  ["GrainAmount", "GRAIN", 0], ["PostCropVignetteAmount", "VIG", 0]];

function summarize(s, limit = 7) {
  const parts = [];
  if (s.Temperature) parts.push(`TEMP ${s.Temperature}K`);
  for (const [key, label, digits] of SUMMARY) {
    const v = parseFloat(s[key] || 0);
    if (!v) continue;
    const sign = key === "GrainAmount" ? "" : v > 0 ? "+" : "−";
    parts.push(`${label} ${sign}${Math.abs(v).toFixed(digits)}`);
  }
  return parts.slice(0, limit).join(" · ");
}

// XMP sidecar text carrying a preset onto a raw photo (as build_sidecar in presets.py).
function buildSidecar(preset) {
  const d = preset.desc;
  const esc = v => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const embedded = d.getAttributeNS(NS_CRS, "CameraProfile") === "Embedded";
  const attrs = [];
  for (const a of d.attributes) {
    if (a.namespaceURI !== NS_CRS || SKIP.has(a.localName)) continue;
    if (a.localName === "HasSettings" || a.localName === "AlreadyApplied") continue;   // set below
    if (embedded && (a.localName === "CameraProfile" || a.localName === "CameraProfileDigest")) continue;
    attrs.push(`    crs:${a.localName}="${esc(a.value)}"`);
  }
  attrs.push('    crs:HasSettings="True"', '    crs:AlreadyApplied="True"');
  const children = [...d.children]
    .filter(c => c.namespaceURI === NS_CRS && !SKIP.has(c.localName))
    .map(c => "    " + new XMLSerializer().serializeToString(c)).join("\n");
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="${NS_RDF}">
  <rdf:Description rdf:about="" xmlns:crs="${NS_CRS}"
${attrs.join("\n")}>
${children}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
`;
}

/* ----------------------------------------------------------------- render */
// Works on Float32Array RGB in 0..1. Same steps and constants as render.py.

const HSL_BANDS = { Red: 0, Orange: 30, Yellow: 60, Green: 120, Aqua: 180, Blue: 225, Purple: 270, Magenta: 315 };
const num = (s, k, d = 0) => { const v = parseFloat(s[k]); return Number.isFinite(v) ? v : d; };
const clamp = v => v < 0 ? 0 : v > 1 ? 1 : v;
const luma = (r, g, b) => r * 0.2126 + g * 0.7152 + b * 0.0722;

function rgbToHsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-6) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    if (h < 0) h += 6;
  }
  return [h * 60, mx > 1e-6 ? d / mx : 0, mx];
}
function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360 / 60;
  const i = Math.floor(h) % 6, f = h - Math.floor(h);
  const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i];
}

// Gaussian blur approximated by three box blurs per channel.
function blur(src, w, h, sigma) {
  const out = new Float32Array(src.length);
  if (sigma < 0.3) { out.set(src); return out; }
  const boxes = (() => {
    const n = 3, wIdeal = Math.sqrt(12 * sigma * sigma / n + 1);
    let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
    const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
    return [0, 1, 2].map(i => ((i < m ? wl : wl + 2) - 1) / 2);
  })();
  const a = new Float32Array(w * h), b = new Float32Array(w * h);
  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < w * h; i++) a[i] = src[i * 3 + c];
    for (const r of boxes) { boxH(a, b, w, h, r); boxV(b, a, w, h, r); }
    for (let i = 0; i < w * h; i++) out[i * 3 + c] = a[i];
  }
  return out;
}
function boxH(s, t, w, h, r) {
  const k = 1 / (r + r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = s[row] * (r + 1);
    for (let x = 0; x < r; x++) acc += s[row + Math.min(x, w - 1)];
    for (let x = 0; x < w; x++) {
      acc += s[row + Math.min(x + r, w - 1)] - s[row + Math.max(x - r - 1, 0)];
      t[row + x] = acc * k;
    }
  }
}
function boxV(s, t, w, h, r) {
  const k = 1 / (r + r + 1);
  for (let x = 0; x < w; x++) {
    let acc = s[x] * (r + 1);
    for (let y = 0; y < r; y++) acc += s[Math.min(y, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      acc += s[Math.min(y + r, h - 1) * w + x] - s[Math.max(y - r - 1, 0) * w + x];
      t[y * w + x] = acc * k;
    }
  }
}

function curveFn(points) {
  const pts = [...points].sort((p, q) => p[0] - q[0]).map(([x, y]) => [x / 255, y / 255]);
  return v => {
    if (v <= pts[0][0]) return pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      if (v <= pts[i][0]) {
        const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
        return x1 === x0 ? y1 : y0 + (y1 - y0) * (v - x0) / (x1 - x0);
      }
    }
    return pts[pts.length - 1][1];
  };
}

// Seeded normal noise, so the grain doesn't flicker between renders.
function noiseField(n, seed = 7) {
  let st = seed >>> 0;
  const rnd = () => { st = (st * 1664525 + 1013904223) >>> 0; return (st + 0.5) / 4294967296; };
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 2) {
    const u = rnd(), v = rnd(), m = Math.sqrt(-2 * Math.log(u));
    out[i] = m * Math.cos(2 * Math.PI * v);
    if (i + 1 < n) out[i + 1] = m * Math.sin(2 * Math.PI * v);
  }
  return out;
}

// imageData: ImageData (RGBA, modified in place). s: preset settings.
function applyPreset(imageData, s) {
  const { width: w, height: h, data } = imageData;
  const n = w * h;
  const scale = Math.max(w, h) / 1600;
  let img = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { img[i * 3] = data[i * 4] / 255; img[i * 3 + 1] = data[i * 4 + 1] / 255; img[i * 3 + 2] = data[i * 4 + 2] / 255; }

  const ev = num(s, "Exposure2012");
  if (ev) { const m = 2 ** ev; for (let i = 0; i < img.length; i++) img[i] = clamp(img[i] ** 2.2 * m) ** (1 / 2.2); }

  const c = num(s, "Contrast2012") / 100;
  if (c) for (let i = 0; i < img.length; i++) { const v = img[i]; img[i] = v + c * 1.3 * v * (1 - v) * (2 * v - 1); }

  const tones = [["Highlights2012", L => Math.max(0, Math.min(1, (L - .5) * 2)) ** 1.5, .25],
                 ["Shadows2012", L => Math.max(0, Math.min(1, (.5 - L) * 2)) ** 1.5, .25],
                 ["Whites2012", L => Math.max(0, Math.min(1, (L - .75) * 4)), .2],
                 ["Blacks2012", L => Math.max(0, Math.min(1, (.25 - L) * 4)), .2]]
    .map(([k, f, m]) => [num(s, k) / 100 * m, f]).filter(([a]) => a);
  if (tones.length) {
    for (let i = 0; i < n; i++) {
      const L = luma(img[i * 3], img[i * 3 + 1], img[i * 3 + 2]);
      let add = 0;
      for (const [a, f] of tones) add += a * f(L);
      img[i * 3] += add; img[i * 3 + 1] += add; img[i * 3 + 2] += add;
    }
  }

  if ((s.ToneCurvePV2012 || []).length > 2) {
    const f = curveFn(s.ToneCurvePV2012);
    for (let i = 0; i < img.length; i++) img[i] = f(clamp(img[i]));
  }
  ["Red", "Green", "Blue"].forEach((ch, k) => {
    const pts = s["ToneCurvePV2012" + ch] || [];
    if (pts.length > 2) { const f = curveFn(pts); for (let i = 0; i < n; i++) img[i * 3 + k] = f(clamp(img[i * 3 + k])); }
  });

  for (let i = 0; i < img.length; i++) img[i] = clamp(img[i]);
  const tex = num(s, "Texture") / 100;
  if (tex) { const b = blur(img, w, h, 2 * scale); for (let i = 0; i < img.length; i++) img[i] += tex * 0.8 * (img[i] - b[i]); }
  const clar = num(s, "Clarity2012") / 100;
  if (clar) {
    const b = blur(img, w, h, 25 * scale);
    for (let i = 0; i < n; i++) {
      const L = luma(img[i * 3], img[i * 3 + 1], img[i * 3 + 2]), m = 4 * L * (1 - L);
      for (let k = 0; k < 3; k++) img[i * 3 + k] += clar * 0.6 * (img[i * 3 + k] - b[i * 3 + k]) * m;
    }
  }
  const dehaze = num(s, "Dehaze") / 100;
  if (dehaze) for (let i = 0; i < img.length; i++) img[i] = (img[i] - .5) * (1 + dehaze * .4) + .5 - dehaze * .04;

  const bands = Object.entries(HSL_BANDS)
    .map(([band, centre]) => [centre, ...["Hue", "Saturation", "Luminance"].map(k => num(s, `${k}Adjustment${band}`) / 100)])
    .filter(([, dh, ds, dl]) => dh || ds || dl);
  const vib = num(s, "Vibrance") / 100, satu = num(s, "Saturation") / 100;
  for (let i = 0; i < n; i++) {
    const [hue, sat, val] = rgbToHsv(clamp(img[i * 3]), clamp(img[i * 3 + 1]), clamp(img[i * 3 + 2]));
    let hOut = hue, sMul = 1, lMul = 1;
    for (const [centre, dh, ds, dl] of bands) {
      const dist = Math.abs(((hue - centre + 180) % 360 + 360) % 360 - 180);
      const wgt = Math.max(0, Math.min(1, 1 - dist / 40));
      hOut += wgt * dh * 30; sMul *= 1 + wgt * ds; lMul *= 1 + wgt * dl * .35 * Math.min(1, sat * 2);
    }
    sMul *= (1 + satu) * (1 + vib * (1 - sat));
    const [r, g, b] = hsvToRgb(hOut, clamp(sat * sMul), val * lMul);
    img[i * 3] = r; img[i * 3 + 1] = g; img[i * 3 + 2] = b;
  }

  const blend = .5 + num(s, "ColorGradeBlending", 50) / 200;
  const tints = ["Shadow", "Midtone", "Highlight", "Global"].map(z => [z, num(s, `ColorGrade${z}Hue`), num(s, `ColorGrade${z}Sat`)])
    .concat([["Shadow", num(s, "SplitToningShadowHue"), num(s, "SplitToningShadowSaturation")],
             ["Highlight", num(s, "SplitToningHighlightHue"), num(s, "SplitToningHighlightSaturation")]])
    .filter(([, , amt]) => amt)
    .map(([z, hue, amt]) => { const t = hsvToRgb(hue, 1, 1), m = (t[0] + t[1] + t[2]) / 3; return [z, amt / 100 * .18, t.map(v => v - m)]; });
  if (tints.length) {
    for (let i = 0; i < n; i++) {
      const L = luma(clamp(img[i * 3]), clamp(img[i * 3 + 1]), clamp(img[i * 3 + 2]));
      const zone = { Shadow: Math.max(0, Math.min(1, 1 - L / blend)) ** 1.5, Midtone: 4 * L * (1 - L),
                     Highlight: Math.max(0, Math.min(1, (L - (1 - blend)) / blend)) ** 1.5, Global: 1 };
      for (const [z, a, t] of tints) for (let k = 0; k < 3; k++) img[i * 3 + k] += zone[z] * a * t[k];
    }
  }

  const vig = num(s, "PostCropVignetteAmount") / 100;
  if (vig) {
    const mid = num(s, "PostCropVignetteMidpoint", 50) / 100;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const r = Math.hypot((x - w / 2) / (w / 2), (y - h / 2) / (h / 2)) / Math.SQRT2;
      const fall = Math.max(0, Math.min(1, (r - mid * .6) / (1 - mid * .6))) ** 2, i = (y * w + x) * 3;
      for (let k = 0; k < 3; k++) img[i + k] = vig < 0 ? img[i + k] * (1 + vig * .8 * fall) : img[i + k] + vig * fall * (1 - img[i + k]);
    }
  }

  const grain = num(s, "GrainAmount") / 100;
  if (grain) {
    const noise = noiseField(n), g3 = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const v = Math.max(0, Math.min(255, noise[i] * 40 + 128)) / 255; g3[i * 3] = g3[i * 3 + 1] = g3[i * 3 + 2] = v; }
    const size = .5 + num(s, "GrainSize", 25) / 50 * scale, gb = blur(g3, w, h, size);
    for (let i = 0; i < n; i++) { const g = gb[i * 3] * 255 / 128 - 1; for (let k = 0; k < 3; k++) img[i * 3 + k] += g * grain * .12; }
  }

  for (let i = 0; i < n; i++) {
    data[i * 4] = clamp(img[i * 3]) * 255 + .5; data[i * 4 + 1] = clamp(img[i * 3 + 1]) * 255 + .5; data[i * 4 + 2] = clamp(img[i * 3 + 2]) * 255 + .5;
  }
  return imageData;
}

window.PresetEngine = { parsePreset, buildSidecar, applyPreset, summarize };
