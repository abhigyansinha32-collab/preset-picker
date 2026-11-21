// The browser stand-in for presetpicker/app.py: same methods, so the desktop UI (app.js) runs
// unchanged. Everything happens locally; photos and presets never leave the computer.
"use strict";
(() => {
  const E = window.PresetEngine;
  const RAW = new Set(["arw", "cr2", "cr3", "nef", "nrw", "raf", "orf", "rw2", "dng", "pef", "srw", "3fr", "iiq"]);
  const IMG = new Set(["jpg", "jpeg", "png", "heic", "heif", "tif", "tiff", "webp"]);
  const ext = name => (name.split(".").pop() || "").toLowerCase();
  const STORE = "presetpicker.web";

  const S = {
    files: [],        // File objects of the chosen source folder
    scan: null,       // [{file, time: Date}] sorted
    photos: [],       // photos in the grid
    presets: new Map(),
    outDir: null,     // FileSystemDirectoryHandle (Chrome/Edge) or null = download a zip
    small: new Map(), // i -> canvas (≈520px)
    big: new Map(),   // i -> canvas (≈1600px), only a few kept
    looks: new Map(),
    settings: { source: "", presets: "", output: "" },
  };

  /* ------------------------------------------------------ persistence */

  function saved() { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; } }
  function save(patch) { try { localStorage.setItem(STORE, JSON.stringify({ ...saved(), ...patch })); } catch { /* private mode */ } }

  function loadPresetTexts(texts) {
    S.presets.clear();
    for (const [name, text] of Object.entries(texts)) {
      const p = E.parsePreset(text, name);
      if (p) S.presets.set(name, p);
    }
  }
  const presetList = () => [...S.presets.values()]
    .sort((a, b) => (a.group + a.name).localeCompare(b.group + b.name))
    .map(p => ({ id: p.id, name: p.name, group: p.group, settings: p.summary }));

  /* ---------------------------------------------------- file pickers */

  function pickFiles({ folder = false, accept = "" } = {}) {
    return new Promise(resolve => {
      const input = Object.assign(document.createElement("input"), { type: "file", multiple: true, accept });
      if (folder) input.webkitdirectory = true;
      input.onchange = () => resolve([...input.files]);
      input.oncancel = () => resolve(null);
      input.click();
    });
  }

  /* ------------------------------------------------------ decoding */

  // Size of a JPEG from its SOF marker, without decoding it.
  function jpegSize(view, start) {
    let p = start + 2;
    while (p + 9 < view.byteLength) {
      if (view.getUint8(p) !== 0xff) return null;
      const m = view.getUint8(p + 1), len = view.getUint16(p + 2);
      if (m >= 0xc0 && m <= 0xc3) return { h: view.getUint16(p + 5), w: view.getUint16(p + 7) };
      if (m === 0xd9 || m === 0xda) return null;
      p += 2 + len;
    }
    return null;
  }

  // The largest JPEG preview a camera embeds in its raw file.
  async function embeddedPreview(file) {
    const buf = await file.arrayBuffer(), bytes = new Uint8Array(buf), view = new DataView(buf);
    let best = null;
    for (let i = 0; i < bytes.length - 3; i++) {
      if (bytes[i] === 0xff && bytes[i + 1] === 0xd8 && bytes[i + 2] === 0xff) {
        const size = jpegSize(view, i);
        if (size && (!best || size.w * size.h > best.w * best.h)) best = { ...size, at: i };
      }
    }
    return best ? new Blob([buf.slice(best.at)], { type: "image/jpeg" }) : null;
  }

  async function orientationOf(file) {
    try { return (await window.exifr.orientation(file)) || 1; } catch { return 1; }
  }

  // Draw the photo upright into a canvas no larger than max on the long edge.
  async function decode(file, max) {
    let bitmap, orient = 1;
    if (RAW.has(ext(file.name))) {
      const jpg = await embeddedPreview(file);
      if (!jpg) return null;
      bitmap = await createImageBitmap(jpg, { imageOrientation: "none" });
      orient = await orientationOf(file);
    } else {
      bitmap = await createImageBitmap(file);    // browsers apply EXIF rotation here
    }
    const swap = orient >= 5 && orient <= 8;
    const k = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const bw = Math.round(bitmap.width * k), bh = Math.round(bitmap.height * k);
    const c = document.createElement("canvas");
    [c.width, c.height] = swap ? [bh, bw] : [bw, bh];
    const g = c.getContext("2d");
    g.imageSmoothingQuality = "high";
    const t = { 2: [-1, 0, 0, 1, bw, 0], 3: [-1, 0, 0, -1, bw, bh], 4: [1, 0, 0, -1, 0, bh],
                5: [0, 1, 1, 0, 0, 0], 6: [0, 1, -1, 0, bh, 0], 7: [0, -1, -1, 0, bh, bw], 8: [0, -1, 1, 0, 0, bw] }[orient];
    if (t) g.setTransform(...t);
    g.drawImage(bitmap, 0, 0, bw, bh);
    bitmap.close?.();
    return c;
  }

  const toUri = (canvas, q = 0.85) => canvas.toDataURL("image/jpeg", q);

  function rendered(canvas, presetId) {
    const out = document.createElement("canvas");
    out.width = canvas.width; out.height = canvas.height;
    const g = out.getContext("2d");
    g.drawImage(canvas, 0, 0);
    const data = g.getImageData(0, 0, out.width, out.height);
    g.putImageData(E.applyPreset(data, S.presets.get(presetId).settings), 0, 0);
    return out;
  }

  /* ------------------------------------------------------------ zip */
  // Minimal "stored" zip (no compression; photos are already compressed).

  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes, crc = 0xffffffff) {
    for (let i = 0; i < bytes.length; i++) crc = CRC[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return crc;
  }
  async function makeZip(entries) {              // entries: [{name, blob}]
    const enc = new TextEncoder(), parts = [], central = [];
    let offset = 0;
    for (const { name, blob } of entries) {
      let crc = 0xffffffff;
      const reader = blob.stream().getReader();
      for (;;) { const { done, value } = await reader.read(); if (done) break; crc = crc32(value, crc); }
      crc = (crc ^ 0xffffffff) >>> 0;
      const nameBytes = enc.encode(name), size = blob.size;
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
      local.setUint32(14, crc, true); local.setUint32(18, size, true); local.setUint32(22, size, true);
      local.setUint16(26, nameBytes.length, true);
      parts.push(local, nameBytes, blob);
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true);
      cen.setUint32(16, crc, true); cen.setUint32(20, size, true); cen.setUint32(24, size, true);
      cen.setUint16(28, nameBytes.length, true); cen.setUint32(42, offset, true);
      central.push(cen, nameBytes);
      offset += 30 + nameBytes.length + size;
    }
    const cenSize = central.reduce((a, p) => a + (p.byteLength ?? p.length), 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, cenSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], { type: "application/zip" });
  }

  /* -------------------------------------------------------------- API */

  const pad = n => String(n).padStart(2, "0");
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const stamp = d => `${ymd(d)} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;

  const api = {
    async init() {
      const st = saved();
      loadPresetTexts(st.presets || {});
      S.settings.presets = S.presets.size ? `${S.presets.size} preset${S.presets.size === 1 ? "" : "s"} saved in this browser` : "";
      S.settings.output = window.showDirectoryPicker ? "Choose a folder…" : "Your Downloads folder, as a .zip";
      return { version: document.documentElement.dataset.version || "web", platform: "web",
               settings: S.settings, cards: [], presets: presetList() };
    },
    async cards() { return []; },
    async set_setting(key, value) { S.settings[key] = value; return S.settings; },

    async choose_folder(key) {
      if (key === "source") {
        const files = await pickFiles({ folder: true });
        if (!files) return null;
        S.files = files.filter(f => (RAW.has(ext(f.name)) || IMG.has(ext(f.name))) && !f.name.startsWith("."));
        const top = (files[0]?.webkitRelativePath || "").split("/")[0] || "Chosen folder";
        S.scan = null;
        S.settings.source = top;
        return S.settings;
      }
      if (key === "presets") {
        const files = await pickFiles({ accept: ".xmp" });
        if (!files) return null;
        const texts = {};
        for (const f of files.filter(f => ext(f.name) === "xmp")) texts[f.name] = await f.text();
        loadPresetTexts(texts);
        save({ presets: texts });
        S.settings.presets = `${S.presets.size} preset${S.presets.size === 1 ? "" : "s"} saved in this browser`;
        return S.settings;
      }
      if (key === "output" && window.showDirectoryPicker) {
        try { S.outDir = await window.showDirectoryPicker({ mode: "readwrite", id: "presetpicker-out" }); }
        catch { return null; }
        S.settings.output = S.outDir.name;
        return S.settings;
      }
      return null;
    },

    async load_presets() { return presetList(); },

    async scan_source(source, rescan = false) {
      if (!S.files.length) return { total: 0, days: [], error: "Choose a folder with your photos." };
      if (!S.scan || rescan) {
        S.scan = [];
        for (const file of S.files) {
          let time = null;
          try { time = (await window.exifr.parse(file, ["DateTimeOriginal"]))?.DateTimeOriginal || null; } catch { /* no EXIF */ }
          S.scan.push({ file, time: time instanceof Date && !isNaN(time) ? time : new Date(file.lastModified) });
        }
        S.scan.sort((a, b) => a.time - b.time);
      }
      const counts = {};
      for (const { time } of S.scan) counts[ymd(time)] = (counts[ymd(time)] || 0) + 1;
      const days = Object.entries(counts).sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([date, count]) => ({ date, count }));
      return { total: S.scan.length, days };
    },

    async load_photos(source, start, end) {
      if (!S.scan) await api.scan_source(source);
      S.photos = S.scan.filter(({ time }) => (!start || ymd(time) >= start) && (!end || ymd(time) <= end));
      S.small.clear(); S.big.clear(); S.looks.clear();
      return S.photos.map(({ file, time }, i) => ({
        i, name: file.name, path: file.webkitRelativePath || file.name, raw: RAW.has(ext(file.name)), cloud: false,
        ext: ext(file.name).toUpperCase(),
        time: `${pad(time.getDate())}.${pad(time.getMonth() + 1)}.${time.getFullYear()} ${pad(time.getHours())}:${pad(time.getMinutes())}`,
      }));
    },

    async thumb(i) {
      if (!S.small.has(i)) {
        try { S.small.set(i, await decode(S.photos[i].file, 520)); } catch { S.small.set(i, null); }
      }
      const c = S.small.get(i);
      return c ? toUri(c, 0.8) : null;
    },

    async look(i, presetId) {
      const key = i + "|" + presetId;
      if (!S.looks.has(key)) {
        if (!S.small.has(i)) await api.thumb(i);
        const c = S.small.get(i);
        S.looks.set(key, c && S.presets.has(presetId) ? toUri(rendered(c, presetId), 0.84) : null);
      }
      return S.looks.get(key);
    },

    async preview(i, presetId) {
      if (!S.big.has(i)) {
        const c = await decode(S.photos[i].file, 1600).catch(() => null);
        if (!c) return { error: "This browser can't open this photo for a large preview." };
        S.big.set(i, c);
        if (S.big.size > 4) S.big.delete(S.big.keys().next().value);
      }
      const base = S.big.get(i), before = toUri(base, 0.9);
      if (!presetId || !S.presets.has(presetId)) return { before, after: before, settings: "" };
      await new Promise(r => setTimeout(r));  // let the spinner paint before the heavy render
      return { before, after: toUri(rendered(base, presetId), 0.9), settings: S.presets.get(presetId).summary };
    },

    async export(choices) {
      const picked = Object.entries(choices).filter(([, id]) => id && S.presets.has(id)).map(([i, id]) => [S.photos[+i].file, S.presets.get(id)]);
      if (!picked.length) return { error: "No presets chosen" };
      const folder = `Preset Picker ${stamp(new Date())}`;
      const used = new Set(), entries = [];
      let raw = 0, other = 0;
      for (const [file, preset] of picked) {
        let name = file.name, n = 1;
        const dot = name.lastIndexOf("."), stem = name.slice(0, dot), suffix = name.slice(dot);
        while (used.has(name.toLowerCase())) name = `${stem}_${n++}${suffix}`;
        used.add(name.toLowerCase());
        entries.push({ name, blob: file });
        entries.push({ name: name.slice(0, name.lastIndexOf(".")) + ".xmp", blob: new Blob([E.buildSidecar(preset)], { type: "application/rdf+xml" }) });
        RAW.has(ext(file.name)) ? raw++ : other++;
      }
      if (S.outDir) {
        const dir = await S.outDir.getDirectoryHandle(folder, { create: true });
        for (const { name, blob } of entries) {
          const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
          await blob.stream().pipeTo(w);
        }
        return { folder: `${S.outDir.name}/${folder}`, raw, other };
      }
      const zip = await makeZip(entries.map(e => ({ ...e, name: `${folder}/${e.name}` })));
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(zip), download: `${folder}.zip` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      return { folder: `${folder}.zip in your Downloads`, raw, other, zip: true };
    },

    async reveal() {},
  };

  // app.js loads after this file and starts as soon as it finds window.pywebview.api.
  window.pywebview = { api };
})();
