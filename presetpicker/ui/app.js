"use strict";
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

// Small line icons (stroke follows the text colour).
const ICONS = {
  card: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M7 3h8l4 4v14H7z"/><path d="M10 3v4M13 3v4M16 4.5V7"/></svg>',
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M3 6h6l2 2h10v11H3z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
};
const icon = name => Object.assign(document.createElement("span"), { className: "ico", innerHTML: ICONS[name] });

const state = {
  settings: {}, cards: [], presets: [], days: [],
  from: "", to: "", anchor: null,
  photos: [], choices: {}, filter: "all", last: -1,
  lb: { i: -1, mode: "split", pos: 50, token: 0 },
};
let api;

/* ------------------------------------------------------------------ util */

function show(view) {
  for (const v of ["setup", "grid", "done"]) $("#" + v).hidden = v !== view;
}
function fmtDay(iso, opts) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined,
    opts || { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}
const presetName = id => (state.presets.find(p => p.id === id) || {}).name || "";
function fillPresetSelect(sel, emptyLabel) {
  sel.replaceChildren(new Option(emptyLabel, ""));
  const groups = {};
  for (const p of state.presets) (groups[p.group] ||= []).push(p);
  for (const [g, list] of Object.entries(groups)) {
    const parent = g ? sel.appendChild(Object.assign(document.createElement("optgroup"), { label: g })) : sel;
    for (const p of list) parent.appendChild(new Option(p.name, p.id));
  }
}

/* ----------------------------------------------------------------- setup */

function renderSources() {
  const box = $("#sources");
  box.replaceChildren();
  const cur = state.settings.source;
  const tiles = state.cards.map(c => ({ ico: "card", name: c.name, detail: "Camera card", path: c.path }));
  if (cur && !tiles.some(t => t.path === cur))
    tiles.push({ ico: "folder", name: cur.split("/").filter(Boolean).pop() || cur, detail: cur, path: cur });
  for (const t of tiles) {
    const b = el("button", "source" + (t.path === cur ? " on" : ""));
    const txt = el("div");
    txt.append(el("b", null, t.name), el("small", null, t.detail));
    b.append(icon(t.ico), txt);
    b.title = t.path;
    b.onclick = () => pickSource(t.path);
    box.append(b);
  }
  const choose = el("button", "source");
  const txt = el("div");
  txt.append(el("b", null, "Choose folder…"), el("small", null, "Any folder on this computer"));
  choose.append(icon("plus"), txt);
  choose.onclick = async () => {
    const s = await api.choose_folder("source");
    if (s) { state.settings = s; pickSource(s.source); }
  };
  box.append(choose);
}

async function pickSource(path, rescan = false) {
  state.settings.source = path;
  renderSources();
  $("#days").replaceChildren(el("p", "empty", "Reading photos…"));
  const res = await api.scan_source(path, rescan);
  state.days = res.days;
  if (res.error || !res.days.length) {
    $("#days").replaceChildren(el("p", "empty", res.error || "No photos found here."));
    state.from = state.to = "";
  } else {
    state.from = state.to = res.days[0].date;   // newest shoot by default
  }
  renderDays();
}

function renderDays() {
  $("#from").value = state.from;
  $("#to").value = state.to;
  const box = $("#days");
  if (state.days.length) {
    box.replaceChildren();
    for (const d of state.days) {
      const inRange = (!state.from || d.date >= state.from) && (!state.to || d.date <= state.to);
      const b = el("button", "day" + (inRange ? " on" : ""));
      b.append(el("span", null, fmtDay(d.date)), el("small", null, String(d.count)));
      b.onclick = e => {
        if (e.shiftKey && state.anchor) {
          [state.from, state.to] = [state.anchor, d.date].sort();
        } else {
          state.from = state.to = state.anchor = d.date;
        }
        renderDays();
      };
      box.append(b);
    }
  }
  const n = state.days.filter(d => (!state.from || d.date >= state.from) && (!state.to || d.date <= state.to))
    .reduce((a, d) => a + d.count, 0);
  $("#rangeCount").textContent = state.days.length ? `${n} photo${n === 1 ? "" : "s"} selected` : "";
  const ready = n > 0 && state.presets.length > 0;
  $("#showPhotos").disabled = !ready;
  $("#showPhotos").textContent = n ? `Show ${n} photo${n === 1 ? "" : "s"}` : "Show photos";
}

function renderPresets() {
  $("#presetPath").textContent = state.settings.presets || "No folder chosen";
  const box = $("#presetList");
  box.replaceChildren();
  if (!state.presets.length) {
    box.append(el("p", "warn", "I can't find any .xmp presets here. Export your presets from Lightroom, then choose that folder."));
  } else {
    for (const p of state.presets) box.append(el("span", "chip", p.name));
  }
  $("#outputPath").textContent = state.settings.output;
  renderDays();
}

async function chooseFolder(key) {
  const s = await api.choose_folder(key);
  if (!s) return;
  state.settings = s;
  if (key === "presets") state.presets = await api.load_presets();
  renderPresets();
}

async function pollCards() {
  if ($("#setup").hidden) return;
  const cards = await api.cards();
  const before = state.cards.map(c => c.path).join();
  state.cards = cards;
  if (cards.map(c => c.path).join() !== before) {
    const added = cards.find(c => !before.split(",").includes(c.path));
    if (added) pickSource(added.path);   // a card was just inserted: jump to it
    else renderSources();
  }
}

/* ------------------------------------------------------------------ grid */

const thumbQueue = [];
let thumbsRunning = 0;
const observer = new IntersectionObserver(entries => {
  for (const e of entries) if (e.isIntersecting) {
    observer.unobserve(e.target);
    thumbQueue.push(e.target);
  }
  pumpThumbs();
}, { root: null, rootMargin: "600px" });

function pumpThumbs() {
  while (thumbsRunning < 6 && thumbQueue.length) {
    const img = thumbQueue.shift();
    thumbsRunning++;
    api.thumb(Number(img.dataset.i)).then(uri => {
      if (uri) { img.src = uri; img.onload = () => img.classList.add("ready"); }
    }).finally(() => { thumbsRunning--; pumpThumbs(); });
  }
}

/* Small preset renders ("looks"), shared by cards, the look menu and the filmstrip. */
const lookCache = {};
const getLook = (i, id) => (lookCache[i + "|" + id] ||= api.look(i, id));
const thumbOf = i => cardOf(i)?.querySelector("img.before")?.src || "";
const presetById = id => state.presets.find(p => p.id === id);

async function showPhotos() {
  $("#showPhotos").disabled = true;
  state.photos = await api.load_photos(state.settings.source, state.from, state.to);
  state.choices = {};
  state.last = -1;
  for (const k in lookCache) delete lookCache[k];
  const range = state.from === state.to ? fmtDay(state.from) : `${fmtDay(state.from)} – ${fmtDay(state.to)}`;
  $("#gridTitle").textContent = range;
  fillPresetSelect($("#setAll"), "—");
  fillPresetSelect($("#bulk"), "Choose a look…");

  const box = $("#photos");
  box.replaceChildren();
  thumbQueue.length = 0;
  for (const p of state.photos) box.append(buildCard(p));
  show("grid");
  box.scrollTop = 0;
  refresh();
}

function buildCard(p) {
  const card = el("div", "card" + (p.raw ? "" : " nonraw"));
  card.dataset.i = p.i;

  // Photo with a before/after slider (like the website): the preset render is clipped at --pos.
  const ph = el("div", "ph");
  ph.style.setProperty("--pos", "50%");
  const before = el("img", "before");
  before.dataset.i = p.i;
  before.alt = p.name;
  const after = el("img", "after");
  after.alt = "";
  const slide = Object.assign(el("input", "slide"), { type: "range", min: 0, max: 100, value: 50, title: "Drag to compare" });
  slide.oninput = () => ph.style.setProperty("--pos", slide.value + "%");
  for (const ev of ["click", "pointerdown", "dblclick"]) slide.addEventListener(ev, e => e.stopPropagation());
  const tick = el("button", "tick", "✓");
  tick.title = "Select (shift-click for a range)";
  tick.onclick = e => { e.stopPropagation(); toggleSelect(p.i, e.shiftKey); };
  const expand = el("button", "expand", "⤢");
  expand.title = "Large preview";
  expand.onclick = e => { e.stopPropagation(); openLightbox(p.i); };
  ph.append(before, after, el("span", "handle"), slide, tick, el("div", "badge"), el("span", "type", p.ext), expand);

  const meta = el("div", "meta");
  const row = el("div", "row");
  const name = el("b", null, p.name);
  name.title = p.path;
  row.append(name, el("span", null, p.time.slice(0, 16)));
  const pick = el("button", "pick");
  pick.append(el("span", "pick-name", "Choose a look"), el("span", "caret", "▾"));
  pick.onclick = e => { e.stopPropagation(); openLooks(p.i, pick); };
  meta.append(row, pick, el("p", "warn", "Lightroom won't add this to a " + p.ext + " by itself. Apply it there with one click."));
  card.append(ph, meta);
  card.onclick = e => toggleSelect(p.i, e.shiftKey);
  card.ondblclick = () => openLightbox(p.i);
  if (p.cloud) ph.append(el("div", "cloud", "☁︎ In iCloud"));
  else observer.observe(before);
  return card;
}

function cardOf(i) { return $(`.card[data-i="${i}"]`); }

// Show a look on a card. id "" clears it. With full=true the slider is moved aside (used while hovering the menu).
async function showOnCard(i, id, full = false) {
  const card = cardOf(i);
  if (!card) return;
  const ph = card.querySelector(".ph");
  const after = card.querySelector("img.after");
  card.classList.toggle("previewing", full);
  if (!id) { card.classList.remove("looked"); after.removeAttribute("src"); return; }
  const want = id;
  card.dataset.want = want;
  const uri = await getLook(i, id);
  if (card.dataset.want !== want || !uri) return;   // something newer was asked for meanwhile
  after.src = uri;
  card.classList.add("looked");
  if (!full) ph.style.setProperty("--pos", card.querySelector(".slide").value + "%");
}

function setChoice(i, id) {
  if (id) state.choices[i] = id; else delete state.choices[i];
  showOnCard(i, id);
  refresh();
}

function toggleSelect(i, range) {
  const cards = $$(".card");
  if (range && state.last >= 0) {
    const [a, b] = [Math.min(i, state.last), Math.max(i, state.last)];
    cards.slice(a, b + 1).forEach(c => c.style.display !== "none" && c.classList.add("sel"));
  } else {
    cardOf(i).classList.toggle("sel");
  }
  state.last = i;
  refresh();
}

function refresh() {
  let n = 0;
  for (const card of $$(".card")) {
    const id = state.choices[card.dataset.i] || "";
    card.classList.toggle("has", !!id);
    card.querySelector(".badge").textContent = presetName(id);
    card.querySelector(".pick-name").textContent = id ? presetName(id) : "Choose a look";
    if (id) n++;
    card.style.display = (state.filter === "todo" && id) || (state.filter === "done" && !id) ? "none" : "";
  }
  const total = state.photos.length;
  $("#stat").textContent = `${total} photo${total === 1 ? "" : "s"} · ${n} with a preset`;
  const sel = $$(".card.sel").length;
  $("#selCount").textContent = `${sel} selected`;
  $("#bar").classList.toggle("show", sel > 0);
  $("#export").disabled = n === 0;
  $("#export").textContent = n ? `Export ${n}` : "Export";
}

/* ------------------------------------------------------------ look menu */

// One tile: the photo with a preset (or the original), its name and settings.
function lookTile(i, id, onPick, onHover) {
  const t = el("button", "look" + ((state.choices[i] || "") === id ? " on" : ""));
  const img = el("img");
  const p = presetById(id);
  if (id) getLook(i, id).then(u => { if (u) img.src = u; });
  else img.src = thumbOf(i);
  t.append(img, el("b", null, id ? p.name : "Original"));
  if (p?.settings) t.title = p.settings;
  t.onclick = e => { e.stopPropagation(); onPick(id); };
  t.onmouseenter = () => onHover(id);
  return t;
}

function openLooks(i, anchor) {
  closeLooks();
  const menu = $("#looks");
  const name = state.photos[i].name;
  $("#looksTitle").textContent = `Looks for ${name}`;
  const grid = $("#looksGrid");
  grid.replaceChildren();
  const restore = () => showOnCard(i, state.choices[i] || "");
  for (const id of ["", ...state.presets.map(p => p.id)]) {
    grid.append(lookTile(i, id, chosen => { setChoice(i, chosen); closeLooks(); }, hovered => showOnCard(i, hovered, true)));
  }
  grid.onmouseleave = restore;
  menu.hidden = false;
  menu.dataset.i = i;
  // Place it under the button, kept inside the window.
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth, h = menu.offsetHeight;
  let x = Math.min(r.left, innerWidth - w - 12), y = r.bottom + 6;
  if (y + h > innerHeight - 12) y = Math.max(12, r.top - h - 6);
  menu.style.left = Math.max(12, x) + "px";
  menu.style.top = y + "px";
}

function closeLooks() {
  const menu = $("#looks");
  if (menu.hidden) return;
  menu.hidden = true;
  const i = Number(menu.dataset.i);
  showOnCard(i, state.choices[i] || "");
}

async function exportPhotos() {
  const btn = $("#export");
  btn.disabled = true;
  btn.textContent = "Exporting…";
  const r = await api.export(state.choices);
  if (r.error) { alert(r.error); refresh(); return; }
  const total = r.raw + r.other;
  $("#doneTitle").textContent = `${total} photo${total === 1 ? "" : "s"} ready for Lightroom`;
  $("#donePath").textContent = r.folder;
  $("#doneWarn").hidden = !r.other;
  $("#doneWarn").textContent = r.other
    ? `${r.other} JPEG/HEIC photo${r.other === 1 ? "" : "s"} came along too. Lightroom won't put the preset on ${r.other === 1 ? "it" : "those"} by itself, so apply it there with one click.`
    : "";
  $("#reveal").onclick = () => api.reveal(r.folder);
  show("done");
}

/* -------------------------------------------------------------- lightbox */

function setSplit(pos) {
  state.lb.pos = Math.max(0, Math.min(100, pos));
  $("#lbAfter").style.clipPath = `inset(0 0 0 ${state.lb.pos}%)`;
  $("#divider").style.left = state.lb.pos + "%";
}

function setMode(mode) {
  state.lb.mode = mode;
  $("#compare").className = "compare " + mode;
  $$("#lbMode button").forEach(b => b.classList.toggle("on", b.dataset.m === mode));
}

async function openLightbox(i) {
  if (i < 0 || i >= state.photos.length) return;
  closeLooks();
  const lb = state.lb;
  lb.i = i;
  const p = state.photos[i];
  $("#lightbox").hidden = false;
  $("#lbName").textContent = p.name;
  $("#lbMeta").textContent = `${p.ext} · ${p.time}`;
  $("#lbPrev").disabled = i === 0;
  $("#lbNext").disabled = i === state.photos.length - 1;
  renderStrip();
  await renderLightbox();
}

// The filmstrip of presets under the large preview: hover to see a look instantly, click to use it.
function renderStrip() {
  const i = state.lb.i;
  const strip = $("#lbLooks");
  strip.replaceChildren();
  for (const id of ["", ...state.presets.map(p => p.id)]) {
    strip.append(lookTile(i, id, chosen => { setChoice(i, chosen); renderStrip(); renderLightbox(); }, hoverLook));
  }
  strip.onmouseleave = () => hoverLook(null);
}

async function hoverLook(id) {
  const lb = state.lb;
  if (id === null) {                          // left the strip: back to the chosen look
    $("#lbAfter").src = lb.afterFull || "";
    $("#lbSettings").textContent = presetById(state.choices[lb.i])?.settings || "";
    if (!state.choices[lb.i]) setMode("before");
    return;
  }
  if (!id) { setMode("before"); $("#lbSettings").textContent = ""; return; }
  if (lb.mode === "before") setMode("split");
  $("#lbSettings").textContent = presetById(id)?.settings || "";
  const uri = await getLook(lb.i, id);
  if (uri) $("#lbAfter").src = uri;
}

async function renderLightbox() {
  const lb = state.lb;
  const token = ++lb.token;
  const preset = state.choices[lb.i] || "";
  // Show the small versions straight away; the sharp ones replace them when ready.
  $("#lbBefore").src = thumbOf(lb.i);
  if (preset) getLook(lb.i, preset).then(u => { if (token === lb.token && u) $("#lbAfter").src = u; });
  $("#lbSettings").textContent = presetById(preset)?.settings || "";
  if (!preset) setMode("before");
  else if (lb.mode === "before") setMode("split");
  setSplit(lb.pos);
  $("#stage").classList.add("loading");
  const r = await api.preview(lb.i, preset);
  if (token !== lb.token) return;          // user moved on while rendering
  $("#stage").classList.remove("loading");
  $("#lbError").hidden = !r.error;
  $("#compare").hidden = !!r.error;
  if (r.error) { $("#lbError").textContent = r.error; return; }
  $("#lbBefore").src = r.before;
  $("#lbAfter").src = lb.afterFull = r.after;
}

function closeLightbox() {
  $("#lightbox").hidden = true;
  state.lb.token++;
  const card = cardOf(state.lb.i);
  if (card) card.scrollIntoView({ block: "nearest" });
}

function bindLightbox() {
  $("#lbClose").onclick = closeLightbox;
  $("#lbPrev").onclick = () => openLightbox(state.lb.i - 1);
  $("#lbNext").onclick = () => openLightbox(state.lb.i + 1);
  $$("#lbMode button").forEach(b => b.onclick = () => setMode(b.dataset.m));
  const cmp = $("#compare");
  let dragging = false;
  const move = e => {
    const r = cmp.getBoundingClientRect();
    setSplit((e.clientX - r.left) / r.width * 100);
  };
  cmp.addEventListener("pointerdown", e => {
    if (state.lb.mode !== "split") return;
    dragging = true; cmp.setPointerCapture(e.pointerId); move(e);
  });
  cmp.addEventListener("pointermove", e => dragging && move(e));
  cmp.addEventListener("pointerup", () => { dragging = false; });
}

/* ------------------------------------------------------------------ keys */

document.addEventListener("keydown", e => {
  if (!$("#looks").hidden && e.key === "Escape") { closeLooks(); return; }
  if (!$("#lightbox").hidden) {
    if (e.key === "Escape") closeLightbox();
    else if (e.key === "ArrowLeft") openLightbox(state.lb.i - 1);
    else if (e.key === "ArrowRight") openLightbox(state.lb.i + 1);
    else if (e.key === "\\" || e.key === "b") setMode(state.lb.mode === "before" ? "split" : "before");
    return;
  }
  if ($("#grid").hidden || e.target.tagName === "SELECT") return;
  if ((e.metaKey || e.ctrlKey) && e.key === "a") {
    e.preventDefault();
    $$(".card").forEach(c => c.style.display !== "none" && c.classList.add("sel"));
    refresh();
  } else if (e.key === "Escape") {
    $$(".card.sel").forEach(c => c.classList.remove("sel")); refresh();
  } else if (e.key === " " && state.last >= 0) {
    e.preventDefault(); openLightbox(state.last);
  }
});

/* ------------------------------------------------------------------ boot */

async function boot() {
  api = window.pywebview.api;
  const init = await api.init();
  state.settings = init.settings;
  state.cards = init.cards;
  state.presets = init.presets;
  $("#version").textContent = "Version " + init.version;
  if (init.platform === "win32") {
    document.documentElement.classList.add("win");
    $("#reveal").textContent = "Show in Explorer";
  }
  renderSources();
  renderPresets();
  const startSource = state.cards[0]?.path || state.settings.source;
  if (startSource) pickSource(startSource);

  $("#rescan").onclick = () => state.settings.source && pickSource(state.settings.source, true);
  $("#from").onchange = e => { state.from = e.target.value; renderDays(); };
  $("#to").onchange = e => { state.to = e.target.value; renderDays(); };
  $("#allDates").onclick = () => { state.from = state.to = ""; renderDays(); };
  $$("[data-choose]").forEach(b => b.onclick = () => chooseFolder(b.dataset.choose));
  $("#showPhotos").onclick = showPhotos;

  $("#back").onclick = () => show("setup");
  $$("#filter button").forEach(b => b.onclick = () => {
    state.filter = b.dataset.f;
    $$("#filter button").forEach(x => x.classList.toggle("on", x === b));
    refresh();
  });
  $("#setAll").onchange = e => { state.photos.forEach(p => setChoice(p.i, e.target.value)); e.target.value = ""; };
  $("#bulkApply").onclick = () => {
    const v = $("#bulk").value;
    if (!v) return;
    $$(".card.sel").forEach(c => { setChoice(Number(c.dataset.i), v); c.classList.remove("sel"); });
    refresh();
  };
  $("#clearSel").onclick = () => { $$(".card.sel").forEach(c => c.classList.remove("sel")); refresh(); };
  $("#export").onclick = exportPhotos;

  $("#backToGrid").onclick = () => { show("grid"); refresh(); };
  $("#startOver").onclick = () => show("setup");
  $("#looksClose").onclick = closeLooks;
  document.addEventListener("click", e => { if (!e.target.closest("#looks")) closeLooks(); });
  $("#photos").addEventListener("scroll", closeLooks, { passive: true });
  bindLightbox();
  setInterval(pollCards, 3000);
}

if (window.pywebview?.api) boot();
else window.addEventListener("pywebviewready", boot);
