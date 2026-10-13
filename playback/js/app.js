import * as db from './db.js';
import { Engine, outputOptions } from './engine.js';
import {
  formatTime, parseTime, beatDuration, barDuration, gainToDb, faderToGain, gainToFader,
} from './music.js';

const $ = (sel) => document.querySelector(sel);
const engine = new Engine();
const PEAKS = 800;
const TIME_SIGS = [[4, 4], [3, 4], [6, 8], [2, 4], [5, 4], [7, 8], [12, 8]];
const SECTION_PRESETS = ['Intro', 'Strofa', 'Pre-Rit', 'Ritornello', 'Bridge', 'Interludio', 'Tag', 'Finale'];

const state = {
  songs: new Map(),
  setlists: [],
  setlistId: null,
  index: -1,           // posizione nella scaletta del brano caricato
  songId: null,
  cache: new Map(),    // songId → Map(trackId → AudioBuffer)
  decoding: new Map(), // songId → Promise
  editing: false,
  settings: {
    jumpMode: 'bar',
    clickMode: 'auto',
    clickSound: 'beep',
    countIn: false,
    countInBars: 1,
    padOn: false,
    padFade: 3,
    master: 1,
    click: { volume: 1, pan: 0, mute: false, output: 's0' },
    pad: { volume: 0.6, pan: 0, mute: false, output: 's0' },
  },
};

// ---------- Utility ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

const saveSettings = debounce(() => db.setSetting('settings', state.settings), 300);
const saveSong = debounce((song) => db.put('songs', song), 400);

function currentSetlist() {
  return state.setlists.find((s) => s.id === state.setlistId) || state.setlists[0];
}

function currentSong() {
  return state.songId ? state.songs.get(state.songId) : null;
}

function sectionColor(name) {
  const n = (name || '').toLowerCase();
  if (/intro/.test(n)) return '#4b5d79';
  if (/pre/.test(n)) return '#7c4dcc';
  if (/strof|verse|verso/.test(n)) return '#2563eb';
  if (/rit|chorus|coro/.test(n)) return '#d9480f';
  if (/bridge|ponte/.test(n)) return '#16a34a';
  if (/inter|instr|solo/.test(n)) return '#0e7490';
  if (/tag|vamp/.test(n)) return '#b45309';
  if (/fin|outro|end/.test(n)) return '#6b7280';
  return '#475569';
}

function detectRole(name) {
  const n = name.toLowerCase();
  if (/click|metro/.test(n)) return 'click';
  if (/guide|guida|cue/.test(n)) return 'guide';
  return 'track';
}

function cleanName(fileName) {
  return fileName.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
}

function sigOptions(sel, value) {
  sel.innerHTML = TIME_SIGS.map(([a, b]) => `<option value="${a}/${b}">${a}/${b}</option>`).join('');
  sel.value = value ? value.join('/') : '4/4';
}

function parseSig(v) {
  const [a, b] = String(v).split('/').map((x) => parseInt(x, 10));
  return [a || 4, b || 4];
}

// ---------- Audio: analisi file ----------
function computePeaks(buf) {
  const out = new Array(PEAKS).fill(0);
  const block = Math.max(1, Math.floor(buf.length / PEAKS));
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < PEAKS; i++) {
      let m = 0;
      const start = i * block;
      const end = Math.min(d.length, start + block);
      for (let j = start; j < end; j += 4) {
        const v = d[j] < 0 ? -d[j] : d[j];
        if (v > m) m = v;
      }
      if (m > out[i]) out[i] = m;
    }
  }
  return out.map((v) => Math.round(v * 1000) / 1000);
}

function songPeaks(song) {
  const tracks = song.tracks.filter((t) => t.role === 'track');
  const use = tracks.length ? tracks : song.tracks;
  const out = new Array(PEAKS).fill(0);
  for (const t of use) {
    if (!t.peaks) continue;
    const scale = (t.durationSec || song.duration) / song.duration;
    for (let i = 0; i < PEAKS; i++) {
      const j = Math.floor(i / scale);
      if (j < PEAKS) out[i] = Math.max(out[i], t.peaks[j] || 0);
    }
  }
  const max = Math.max(0.01, ...out);
  return out.map((v) => Math.round((v / max) * 1000) / 1000);
}

async function importFiles(files, song, progressEl) {
  await engine.init();
  const bar = progressEl.querySelector('div');
  const label = progressEl.querySelector('span');
  progressEl.hidden = false;
  const firstNew = song.tracks.length;
  let i = 0;
  for (const file of files) {
    i++;
    label.textContent = `Analisi ${i}/${files.length}: ${file.name}`;
    bar.style.width = `${((i - 1) / files.length) * 100}%`;
    const blob = new Blob([await file.arrayBuffer()], { type: file.type || 'audio/wav' });
    let buf;
    try {
      buf = await engine.decode(blob);
    } catch (e) {
      toast(`Formato non supportato: ${file.name}`, 3500);
      continue;
    }
    const blobId = db.uid();
    await db.put('blobs', { id: blobId, data: blob, name: file.name });
    const role = detectRole(file.name);
    song.tracks.push({
      id: db.uid(),
      name: cleanName(file.name),
      blobId,
      role,
      volume: 1,
      pan: 0,
      mute: false,
      solo: false,
      output: 's0',
      durationSec: buf.duration,
      peaks: computePeaks(buf),
    });
    song.duration = Math.max(song.duration || 0, buf.duration);
  }
  // "Titolo - Basso.wav", "Titolo - Click.wav" → "Basso", "Click"
  const added = song.tracks.slice(firstNew);
  if (added.length > 1) {
    // taglia solo a un separatore, così "Bass" e "Bells" non diventano "ass" ed "ells"
    const m = commonPrefix(added.map((t) => t.name)).match(/^(.*[\s\-–_.])/);
    const prefix = m ? m[1] : '';
    if (prefix.length > 2 && added.every((t) => t.name.length > prefix.length + 1)) {
      for (const t of added) t.name = t.name.slice(prefix.length).replace(/^[\s\-–_.]+/, '') || t.name;
    }
  }
  // Ordine tipico: click e guide in testa, poi le tracce.
  const order = { click: 0, guide: 1, track: 2 };
  song.tracks.sort((a, b) => order[a.role] - order[b.role]);
  song.peaks = songPeaks(song);
  bar.style.width = '100%';
  label.textContent = 'Fatto';
  state.cache.delete(song.id);
}

async function decodeSong(song) {
  if (state.cache.has(song.id)) return state.cache.get(song.id);
  if (state.decoding.has(song.id)) return state.decoding.get(song.id);
  const p = (async () => {
    const map = new Map();
    for (const t of song.tracks) {
      const row = await db.get('blobs', t.blobId);
      if (!row) continue;
      try { map.set(t.id, await engine.decode(row.data)); } catch (_) { /* file danneggiato */ }
    }
    state.cache.set(song.id, map);
    state.decoding.delete(song.id);
    return map;
  })();
  state.decoding.set(song.id, p);
  return p;
}

// In memoria teniamo solo il brano attuale e il successivo (gli stem decodificati pesano molto).
function evictCache() {
  const keep = new Set([state.songId, nextSongId()]);
  for (const id of state.cache.keys()) if (!keep.has(id)) state.cache.delete(id);
}

function nextSongId() {
  const sl = currentSetlist();
  return sl && sl.songIds[state.index + 1];
}

// ---------- Caricamento brano ----------
async function loadIndex(index, { autoplay = false } = {}) {
  const sl = currentSetlist();
  if (!sl || index < 0 || index >= sl.songIds.length) return;
  const song = state.songs.get(sl.songIds[index]);
  if (!song) return;
  await engine.init();
  engine.stop();
  state.index = index;
  state.songId = song.id;
  state.loading = true;
  renderSetlist();
  renderNow();
  $('#loading').hidden = state.cache.has(song.id);
  const bufs = await decodeSong(song);
  if (state.songId !== song.id) return; // nel frattempo è stato scelto un altro brano
  $('#loading').hidden = true;
  state.loading = false;
  engine.setSong(song, bufs);
  engine.setLoop(null);
  $('#loopBtn').classList.remove('on');
  renderMixer();
  renderSections();
  drawWaveBase();
  if (state.settings.padOn) engine.pad.start(song.key, state.settings.padFade);
  evictCache();
  const nid = nextSongId();
  if (nid && state.songs.get(nid)) setTimeout(() => decodeSong(state.songs.get(nid)).then(evictCache), 800);
  if (autoplay) play();
}

function play() {
  if (state.loading) return;
  if (!engine.song) {
    const sl = currentSetlist();
    if (sl && sl.songIds.length) loadIndex(Math.max(0, state.index), { autoplay: true });
    return;
  }
  engine.settings.countInBars = state.settings.countIn ? state.settings.countInBars : 0;
  engine.play();
  keepAwake(true);
}

function togglePlay() {
  if (engine.playing) { engine.pause(); keepAwake(false); } else play();
}

function stopAll() {
  engine.stop();
  keepAwake(false);
}

function confirmSwitch() {
  return !engine.playing || confirm('Il brano è in riproduzione. Vuoi interromperlo?');
}

function changeSong(delta) {
  const sl = currentSetlist();
  if (!sl) return;
  const i = state.index + delta;
  if (i < 0 || i >= sl.songIds.length) return;
  if (!confirmSwitch()) return;
  loadIndex(i);
}

engine.onEnded = () => {
  const song = currentSong();
  keepAwake(false);
  const sl = currentSetlist();
  if (!sl || state.index + 1 >= sl.songIds.length) { engine.pausedAt = 0; return; }
  const cont = song && song.transition && song.transition.mode === 'continue';
  const gap = song && song.transition ? Number(song.transition.gap) || 0 : 0;
  loadIndex(state.index + 1).then(() => {
    if (cont) setTimeout(() => { if (!engine.playing) play(); }, gap * 1000);
  });
};

// Evita che lo schermo dell'iPad si spenga durante il live.
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch (_) { /* non supportato */ }
}

// ---------- Sezioni ----------
function sortedSections(song) {
  return [...(song.sections || [])].sort((a, b) => a.time - b.time);
}

function currentSectionIndex(song, pos) {
  const secs = sortedSections(song);
  let idx = -1;
  secs.forEach((s, i) => { if (s.time <= pos + 0.001) idx = i; });
  return idx;
}

function sectionRegion(song, idx) {
  const secs = sortedSections(song);
  if (idx < 0 || idx >= secs.length) return null;
  return { start: secs[idx].time, end: secs[idx + 1] ? secs[idx + 1].time : song.duration };
}

function jumpToSection(idx) {
  const song = currentSong();
  if (!song) return;
  const secs = sortedSections(song);
  if (!secs[idx]) return;
  engine.jumpTo(secs[idx].time, state.settings.jumpMode);
  if (engine.loop) {
    const r = sectionRegion(song, idx);
    engine.setLoop(r);
  }
  renderSections();
}

function stepSection(delta) {
  const song = currentSong();
  if (!song) return;
  const secs = sortedSections(song);
  if (!secs.length) return;
  const target = engine.pendingJump ? engine.pendingJump.target : engine.position;
  let idx = currentSectionIndex(song, target);
  // "indietro" vicino all'inizio di una sezione va alla precedente
  if (delta < 0 && idx >= 0 && target - secs[idx].time > 2) idx += 1;
  jumpToSection(Math.max(0, Math.min(secs.length - 1, idx + delta)));
}

function toggleLoop() {
  const song = currentSong();
  if (!song) return;
  if (engine.loop) {
    engine.setLoop(null);
  } else {
    const idx = currentSectionIndex(song, engine.position);
    const r = idx >= 0 ? sectionRegion(song, idx) : { start: 0, end: song.duration };
    engine.setLoop(r);
  }
  $('#loopBtn').classList.toggle('on', !!engine.loop);
}

function addSectionAt(name, time) {
  const song = currentSong();
  if (!song) return;
  song.sections = song.sections || [];
  song.sections.push({ id: db.uid(), name, time: Math.max(0, time) });
  saveSong(song);
  renderSections();
  drawWaveBase();
}

// ---------- Render: scaletta ----------
function renderSetlistSelect() {
  const sel = $('#setlistSelect');
  sel.innerHTML = state.setlists.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  sel.value = state.setlistId;
}

function renderSetlist() {
  const sl = currentSetlist();
  const ol = $('#setlist');
  ol.classList.toggle('editing', state.editing);
  $('#editSetlistBtn').textContent = state.editing ? 'Fine' : 'Modifica';
  if (!sl || !sl.songIds.length) {
    ol.innerHTML = '<li class="empty-msg">Scaletta vuota. Aggiungi brani dalla Libreria.</li>';
  } else {
    ol.innerHTML = sl.songIds.map((id, i) => {
      const s = state.songs.get(id);
      if (!s) return '';
      const meta = [s.key, s.bpm ? `${s.bpm} BPM` : '', formatTime(s.duration || 0)].filter(Boolean).join(' · ');
      const cls = i === state.index ? 'active' : i === state.index + 1 ? 'next' : '';
      return `<li data-i="${i}" class="${cls}">
        <span class="num">${i + 1}</span>
        <div class="info"><div class="t">${esc(s.title)}</div><div class="m">${esc(meta)}</div></div>
        <div class="acts">
          <button data-act="up" title="Su">↑</button>
          <button data-act="down" title="Giù">↓</button>
          <button data-act="remove" title="Togli dalla scaletta">✕</button>
        </div>
      </li>`;
    }).join('');
  }
  $('#empty').hidden = state.songs.size > 0;
}

function renderNow() {
  const song = currentSong();
  $('#songTitle').textContent = song ? song.title + (song.artist ? ' — ' + song.artist : '') : 'Nessun brano';
  $('#songKey').textContent = song && song.key ? song.key : '–';
  $('#songBpm').textContent = song && song.bpm ? `${song.bpm} BPM` : '– BPM';
  $('#songSig').textContent = song && song.timeSig ? song.timeSig.join('/') : '4/4';
}

// ---------- Render: sezioni ----------
function renderSections() {
  const song = currentSong();
  const el = $('#sections');
  if (!song) { el.innerHTML = ''; return; }
  const secs = sortedSections(song);
  if (!secs.length) {
    el.innerHTML = '<span class="none">Nessuna sezione: usa “+ Sezione” mentre ascolti per segnare Strofa, Ritornello…</span>';
    return;
  }
  el.innerHTML = secs.map((s, i) => `<button class="sec" data-i="${i}" style="background:${sectionColor(s.name)}">
    ${esc(s.name)}<small>${formatTime(s.time)}</small></button>`).join('');
  lastSecIdx = null;
}

// ---------- Render: mixer ----------
const stripEls = [];

function stripTemplate({ key, name, role, output, showSolo, showPadBtn }) {
  const opts = outputOptions(engine.channelCount || 2)
    .map((o) => `<option value="${o.value}" ${o.value === output ? 'selected' : ''}>Out ${o.label}</option>`).join('');
  return `<div class="strip role-${role}" data-key="${key}">
    <div class="strip-name" title="${esc(name)}">${esc(name)}</div>
    ${role === 'master' ? '<select disabled><option>Master</option></select>' : `<select class="out">${opts}</select>`}
    ${role === 'master' ? '<div style="height:18px"></div>' : '<input class="pan" type="range" min="-1" max="1" step="0.01" title="Panorama (doppio tocco = centro)">'}
    <div class="fader-area">
      <div class="meter"><i></i></div>
      <div class="fader"><div class="unity"></div><div class="thumb"></div></div>
    </div>
    <div class="db">0.0</div>
    <div class="strip-btns">
      ${role === 'master' ? '' : '<button class="m" title="Mute">M</button>'}
      ${showSolo ? '<button class="s" title="Solo">S</button>' : ''}
      ${showPadBtn ? '<button class="p" title="Pad on/off">ON</button>' : ''}
    </div>
  </div>`;
}

function renderMixer() {
  const mixer = $('#mixer');
  const song = currentSong();
  const st = state.settings;
  const defs = [];
  if (song) {
    for (const t of song.tracks) {
      defs.push({
        key: t.id, name: t.name, role: t.role, output: t.output || 's0', showSolo: true,
        get: () => t, strip: () => engine.trackStrips.get(t.id), save: () => saveSong(song),
      });
    }
  }
  defs.push({
    key: '__click', name: 'Metronomo', role: 'click', output: st.click.output,
    get: () => st.click, strip: () => engine.clickStrip, save: saveSettings,
  });
  defs.push({
    key: '__pad', name: 'Pad', role: 'pad', output: st.pad.output, showPadBtn: true,
    get: () => st.pad, strip: () => engine.padStrip, save: saveSettings,
  });
  defs.push({
    key: '__master', name: 'Master', role: 'master', output: 's0',
    get: () => ({ get volume() { return st.master; }, set volume(v) { st.master = v; } }),
    strip: () => null, save: saveSettings, master: true,
  });

  mixer.innerHTML = defs.map(stripTemplate).join('');
  stripEls.length = 0;
  defs.forEach((def, i) => {
    const el = mixer.children[i];
    const cfg = def.get();
    const strip = def.strip();
    const entry = { el, def, strip, meterEl: el.querySelector('.meter i'), level: 0 };
    stripEls.push(entry);

    const fader = el.querySelector('.fader');
    const thumb = el.querySelector('.thumb');
    const dbEl = el.querySelector('.db');
    const setFader = (f, apply = true) => {
      f = Math.max(0, Math.min(1, f));
      const g = faderToGain(f);
      const h = fader.clientHeight - 12;
      thumb.style.top = `${6 + (1 - f) * h}px`;
      dbEl.textContent = gainToDb(g);
      if (!apply) return;
      cfg.volume = g;
      if (def.master) engine.setMasterVolume(g);
      else if (strip) strip.setVolume(g);
      def.save();
    };
    requestAnimationFrame(() => {
      el.querySelector('.unity').style.top = `${6 + 0.2 * (fader.clientHeight - 12)}px`;
      setFader(gainToFader(cfg.volume ?? 1), false);
    });
    let dragging = false;
    let lastTap = 0;
    const fromEvent = (e) => {
      const r = fader.getBoundingClientRect();
      return 1 - (e.clientY - r.top - 6) / (r.height - 12);
    };
    let startY = 0;
    let startF = 0;
    fader.addEventListener('pointerdown', (e) => {
      const now = Date.now();
      if (now - lastTap < 300) { setFader(0.8); lastTap = 0; return; } // doppio tocco = 0 dB
      lastTap = now;
      dragging = true;
      fader.setPointerCapture(e.pointerId);
      startY = e.clientY;
      startF = gainToFader(cfg.volume ?? 1);
      // tocco sulla corsia (fuori dal cursore) = salto diretto
      const tr = thumb.getBoundingClientRect();
      if (e.clientY < tr.top - 4 || e.clientY > tr.bottom + 4) { startF = fromEvent(e); setFader(startF); }
    });
    fader.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const r = fader.getBoundingClientRect();
      setFader(startF - (e.clientY - startY) / (r.height - 12));
    });
    const end = () => { dragging = false; };
    fader.addEventListener('pointerup', end);
    fader.addEventListener('pointercancel', end);

    const out = el.querySelector('select.out');
    if (out) {
      out.value = cfg.output || 's0';
      out.addEventListener('change', () => {
        cfg.output = out.value;
        if (strip) strip.route(out.value);
        def.save();
      });
    }
    const pan = el.querySelector('.pan');
    if (pan) {
      pan.value = cfg.pan || 0;
      pan.addEventListener('input', () => {
        cfg.pan = parseFloat(pan.value);
        if (strip) strip.setPan(cfg.pan);
        def.save();
      });
      pan.addEventListener('dblclick', () => { pan.value = 0; pan.dispatchEvent(new Event('input')); });
    }
    const m = el.querySelector('.m');
    if (m) {
      m.classList.toggle('on', !!cfg.mute);
      m.addEventListener('click', () => {
        cfg.mute = !cfg.mute;
        m.classList.toggle('on', cfg.mute);
        if (strip) strip.setMute(cfg.mute);
        def.save();
      });
    }
    const s = el.querySelector('.s');
    if (s) {
      s.classList.toggle('on', !!cfg.solo);
      s.addEventListener('click', () => {
        cfg.solo = !cfg.solo;
        s.classList.toggle('on', cfg.solo);
        engine.updateSolo();
        updateDimmed();
        def.save();
      });
    }
    const p = el.querySelector('.p');
    if (p) {
      p.classList.toggle('on', state.settings.padOn);
      p.addEventListener('click', togglePad);
    }
  });
  updateDimmed();
}

function updateDimmed() {
  for (const e of stripEls) {
    const s = e.strip;
    e.el.classList.toggle('dimmed', !!(s && s.soloMuted));
  }
}

function applyStripSettings() {
  const st = state.settings;
  for (const [cfg, strip] of [[st.click, engine.clickStrip], [st.pad, engine.padStrip]]) {
    strip.setVolume(cfg.volume ?? 1);
    strip.setPan(cfg.pan || 0);
    strip.setMute(!!cfg.mute);
    strip.route(cfg.output || 's0');
  }
  engine.setMasterVolume(st.master ?? 1);
}

function togglePad() {
  const song = currentSong();
  state.settings.padOn = !state.settings.padOn;
  if (state.settings.padOn) {
    const key = song && song.key;
    if (!key || !engine.pad.start(key, state.settings.padFade)) {
      toast('Imposta la tonalità del brano per usare il pad');
      state.settings.padOn = false;
    }
  } else {
    engine.pad.stop(state.settings.padFade);
  }
  $('#padBtn').classList.toggle('on', state.settings.padOn);
  document.querySelectorAll('.strip-btns .p').forEach((b) => b.classList.toggle('on', state.settings.padOn));
  saveSettings();
}

// ---------- Forma d'onda ----------
const wave = $('#wave');
const wctx = wave.getContext('2d');
let waveBase = null;

function drawWaveBase() {
  const dpr = window.devicePixelRatio || 1;
  const w = wave.clientWidth;
  const h = wave.clientHeight;
  wave.width = Math.round(w * dpr);
  wave.height = Math.round(h * dpr);
  const off = document.createElement('canvas');
  off.width = wave.width;
  off.height = wave.height;
  const c = off.getContext('2d');
  c.scale(dpr, dpr);
  c.fillStyle = '#0b0d11';
  c.fillRect(0, 0, w, h);
  const song = currentSong();
  if (song && song.duration) {
    const secs = sortedSections(song);
    const top = 22;
    secs.forEach((s, i) => {
      const x0 = (s.time / song.duration) * w;
      const x1 = ((secs[i + 1] ? secs[i + 1].time : song.duration) / song.duration) * w;
      c.fillStyle = sectionColor(s.name);
      c.globalAlpha = 0.22;
      c.fillRect(x0, top, x1 - x0, h - top);
      c.globalAlpha = 1;
      c.fillRect(x0, 0, Math.max(1, x1 - x0 - 1), top - 2);
      c.fillStyle = '#fff';
      c.font = '600 11px -apple-system, sans-serif';
      c.save();
      c.beginPath();
      c.rect(x0, 0, x1 - x0 - 2, top);
      c.clip();
      c.fillText(s.name, x0 + 5, 15);
      c.restore();
    });
    const peaks = song.peaks || [];
    const mid = top + (h - top) / 2;
    const amp = (h - top) / 2 - 4;
    const bw = w / peaks.length;
    c.fillStyle = '#5b6b86';
    for (let i = 0; i < peaks.length; i++) {
      const v = Math.max(0.01, peaks[i]) * amp;
      c.fillRect(i * bw, mid - v, Math.max(1, bw - 0.4), v * 2);
    }
  }
  waveBase = off;
}

function drawWave(pos) {
  if (!waveBase) return;
  const dpr = window.devicePixelRatio || 1;
  const w = wave.width / dpr;
  const h = wave.height / dpr;
  wctx.setTransform(1, 0, 0, 1, 0, 0);
  wctx.drawImage(waveBase, 0, 0);
  wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const song = currentSong();
  if (!song || !song.duration) return;
  const x = (Math.max(0, pos) / song.duration) * w;
  wctx.fillStyle = 'rgba(61,139,255,0.18)';
  wctx.fillRect(0, 22, x, h - 22);
  if (engine.loop) {
    const a = (engine.loop.start / song.duration) * w;
    const b = (engine.loop.end / song.duration) * w;
    wctx.strokeStyle = '#f5b62e';
    wctx.lineWidth = 2;
    wctx.strokeRect(a + 1, 23, b - a - 2, h - 24);
  }
  if (engine.pendingJump) {
    const jx = (engine.pendingJump.target / song.duration) * w;
    wctx.fillStyle = '#f5b62e';
    wctx.fillRect(jx - 1, 22, 2, h - 22);
  }
  wctx.fillStyle = '#fff';
  wctx.fillRect(x - 1, 0, 2, h);
}

wave.addEventListener('pointerdown', (e) => {
  const song = currentSong();
  if (!song || !song.duration) return;
  const r = wave.getBoundingClientRect();
  const t = ((e.clientX - r.left) / r.width) * song.duration;
  engine.jumpTo(t, 'now');
});

// ---------- Ciclo di aggiornamento ----------
let lastSecIdx = null;
function frame() {
  const song = currentSong();
  const pos = engine.position;
  document.body.classList.toggle('playing', engine.playing);
  document.body.classList.toggle('countin', engine.ctx ? engine.isCountingIn : false);
  if (song) {
    const shown = Math.max(0, pos);
    $('#timeElapsed').textContent = engine.isCountingIn ? 'Count-in' : formatTime(shown);
    $('#timeRemain').textContent = '-' + formatTime(Math.max(0, song.duration - shown));
    if (song.bpm) {
      const rel = pos - (song.firstBeat || 0);
      const bar = barDuration(song);
      const b = Math.floor(rel / bar) + 1;
      const beat = Math.floor((((rel % bar) + bar) % bar) / beatDuration(song)) + 1;
      $('#barBeat').textContent = rel < 0 ? '–' : `${b}.${beat}`;
    } else {
      $('#barBeat').textContent = '–';
    }
    const idx = currentSectionIndex(song, pos);
    const secs = sortedSections(song);
    const chip = $('#songSection');
    if (idx !== lastSecIdx) {
      lastSecIdx = idx;
      chip.textContent = idx >= 0 ? secs[idx].name : '–';
      chip.style.background = idx >= 0 ? sectionColor(secs[idx].name) : '';
      document.querySelectorAll('#sections .sec').forEach((b, i) => b.classList.toggle('current', i === idx));
    }
    const pendingIdx = engine.pendingJump ? secs.findIndex((s) => Math.abs(s.time - engine.pendingJump.target) < 0.001) : -1;
    document.querySelectorAll('#sections .sec').forEach((b, i) => b.classList.toggle('pending', i === pendingIdx));
    drawWave(pos);
  }
  if (engine.ctx) {
    for (const e of stripEls) {
      const strip = e.def.master ? null : e.strip;
      let peak = 0;
      if (strip) peak = strip.meter();
      else if (e.def.master) peak = Math.max(0, ...stripEls.filter((x) => x.strip).map((x) => x.level)) * (state.settings.master ?? 1);
      e.level = Math.max(peak, e.level * 0.9);
      const dbv = 20 * Math.log10(Math.max(1e-5, e.level));
      const pct = Math.max(0, Math.min(1, (dbv + 48) / 48)) * 100;
      e.meterEl.style.height = `${pct}%`;
    }
  }
  requestAnimationFrame(frame);
}

// ---------- Dialog: import ----------
let pendingFiles = [];
function openImport() {
  pendingFiles = [];
  $('#impList').innerHTML = '';
  $('#impTitle').value = '';
  $('#impArtist').value = '';
  $('#impBpm').value = '';
  $('#impKey').value = '';
  sigOptions($('#impSig'));
  $('#impProgress').hidden = true;
  $('#dlgImport').showModal();
}

function setPendingFiles(list) {
  pendingFiles = [...list].filter((f) => /^audio\//.test(f.type) || /\.(wav|mp3|m4a|aif|aiff|caf|flac|ogg|aac)$/i.test(f.name));
  pendingFiles.sort((a, b) => a.name.localeCompare(b.name));
  $('#impList').innerHTML = pendingFiles.map((f) => {
    const role = detectRole(f.name);
    return `<li><span>${esc(f.name)}</span><b>${role === 'track' ? '' : role.toUpperCase()}</b></li>`;
  }).join('');
  if (!$('#impTitle').value && pendingFiles.length) {
    const first = pendingFiles[0];
    const dir = first.webkitRelativePath ? first.webkitRelativePath.split('/')[0] : '';
    $('#impTitle').value = dir || guessTitle(pendingFiles.map((f) => cleanName(f.name)));
  }
  const all = pendingFiles.map((f) => f.name).join(' ');
  const bpm = all.match(/(\d{2,3}(?:\.\d+)?)\s?bpm/i);
  if (bpm && !$('#impBpm').value) $('#impBpm').value = bpm[1];
}

function commonPrefix(names) {
  let prefix = names[0] || '';
  for (const n of names) while (prefix && !n.startsWith(prefix)) prefix = prefix.slice(0, -1);
  return prefix;
}

function guessTitle(names) {
  if (names.length === 1) return names[0];
  return commonPrefix(names).replace(/[\s\-–_]+$/, '') || 'Nuovo brano';
}

$('#impFiles').addEventListener('change', (e) => setPendingFiles(e.target.files));
$('#impFolder').addEventListener('change', (e) => setPendingFiles(e.target.files));

$('#impSave').addEventListener('click', async (e) => {
  e.preventDefault();
  if (!pendingFiles.length) { toast('Scegli almeno un file audio'); return; }
  const title = $('#impTitle').value.trim();
  if (!title) { $('#impTitle').focus(); return; }
  $('#impSave').disabled = true;
  const song = {
    id: db.uid(),
    title,
    artist: $('#impArtist').value.trim(),
    bpm: parseFloat($('#impBpm').value) || null,
    key: $('#impKey').value.trim(),
    timeSig: parseSig($('#impSig').value),
    firstBeat: 0,
    duration: 0,
    tracks: [],
    sections: [],
    transition: { mode: 'stop', gap: 2 },
    created: Date.now(),
  };
  try {
    await importFiles(pendingFiles, song, $('#impProgress'));
    if (!song.tracks.length) throw new Error('nessuna traccia');
    await db.put('songs', song);
    state.songs.set(song.id, song);
    const sl = currentSetlist();
    sl.songIds.push(song.id);
    await db.put('setlists', sl);
    $('#dlgImport').close();
    renderSetlist();
    toast(`“${song.title}” importato`);
    if (!engine.song) loadIndex(sl.songIds.length - 1);
  } catch (err) {
    toast('Importazione non riuscita: ' + err.message, 4000);
  } finally {
    $('#impSave').disabled = false;
  }
});

// ---------- Dialog: modifica brano ----------
let editDraft = null;
function openSongEditor(songId) {
  const song = state.songs.get(songId);
  if (!song) return;
  editDraft = JSON.parse(JSON.stringify(song));
  $('#edTitle').value = song.title;
  $('#edArtist').value = song.artist || '';
  $('#edKey').value = song.key || '';
  $('#edBpm').value = song.bpm || '';
  sigOptions($('#edSig'), song.timeSig);
  $('#edFirstBeat').value = song.firstBeat || 0;
  $('#edTransition').value = (song.transition && song.transition.mode) || 'stop';
  $('#edGap').value = song.transition ? song.transition.gap : 2;
  $('#edProgress').hidden = true;
  renderEditLists();
  $('#dlgSong').showModal();
}

function renderEditLists() {
  const secs = editDraft.sections.sort((a, b) => a.time - b.time);
  $('#edSections').innerHTML = secs.length ? secs.map((s) => `<li data-id="${s.id}">
      <input class="name" value="${esc(s.name)}" list="secPresets">
      <input class="time" value="${formatTime(s.time, true)}" inputmode="decimal" title="minuti:secondi">
      <button type="button" class="x" title="Elimina">✕</button></li>`).join('')
    : '<li class="hint">Nessuna sezione.</li>';
  $('#edTracks').innerHTML = editDraft.tracks.map((t) => `<li data-id="${t.id}">
      <input class="name" value="${esc(t.name)}">
      <select class="role">
        <option value="track" ${t.role === 'track' ? 'selected' : ''}>Traccia</option>
        <option value="click" ${t.role === 'click' ? 'selected' : ''}>Click</option>
        <option value="guide" ${t.role === 'guide' ? 'selected' : ''}>Guide</option>
      </select>
      <button type="button" class="x" title="Elimina">✕</button></li>`).join('');
}

function readEditLists() {
  document.querySelectorAll('#edSections li[data-id]').forEach((li) => {
    const s = editDraft.sections.find((x) => x.id === li.dataset.id);
    s.name = li.querySelector('.name').value.trim() || 'Sezione';
    const t = parseTime(li.querySelector('.time').value);
    if (isFinite(t)) s.time = Math.max(0, t);
  });
  document.querySelectorAll('#edTracks li[data-id]').forEach((li) => {
    const t = editDraft.tracks.find((x) => x.id === li.dataset.id);
    t.name = li.querySelector('.name').value.trim() || 'Traccia';
    t.role = li.querySelector('.role').value;
  });
}

$('#edSections').addEventListener('click', (e) => {
  if (!e.target.classList.contains('x')) return;
  readEditLists();
  const id = e.target.closest('li').dataset.id;
  editDraft.sections = editDraft.sections.filter((s) => s.id !== id);
  renderEditLists();
});
$('#edTracks').addEventListener('click', (e) => {
  if (!e.target.classList.contains('x')) return;
  readEditLists();
  const id = e.target.closest('li').dataset.id;
  const t = editDraft.tracks.find((x) => x.id === id);
  if (!confirm(`Eliminare la traccia “${t.name}”?`)) return;
  editDraft.tracks = editDraft.tracks.filter((x) => x.id !== id);
  editDraft.removedBlobs = [...(editDraft.removedBlobs || []), t.blobId];
  renderEditLists();
});
$('#edAddSection').addEventListener('click', () => {
  readEditLists();
  const pos = editDraft.id === state.songId ? Math.max(0, engine.position) : 0;
  const n = editDraft.sections.length;
  editDraft.sections.push({ id: db.uid(), name: SECTION_PRESETS[Math.min(n, SECTION_PRESETS.length - 1)], time: pos });
  renderEditLists();
});
$('#edBarSections').addEventListener('click', () => {
  readEditLists();
  const bpm = parseFloat($('#edBpm').value);
  if (!bpm) { toast('Inserisci prima il BPM'); return; }
  const tmp = { bpm, timeSig: parseSig($('#edSig').value) };
  const step = barDuration(tmp) * 8;
  const fb = parseFloat($('#edFirstBeat').value) || 0;
  editDraft.sections = [];
  for (let t = fb, i = 1; t < editDraft.duration - 1; t += step, i++) {
    editDraft.sections.push({ id: db.uid(), name: `Parte ${i}`, time: t });
  }
  renderEditLists();
});
$('#edAddTracks').addEventListener('change', async (e) => {
  readEditLists();
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  const before = new Set(editDraft.tracks.map((t) => t.blobId));
  await importFiles(files, editDraft, $('#edProgress'));
  editDraft.addedBlobs = [...(editDraft.addedBlobs || []),
    ...editDraft.tracks.map((t) => t.blobId).filter((b) => !before.has(b))];
  renderEditLists();
});
$('#edSave').addEventListener('click', async (e) => {
  e.preventDefault();
  readEditLists();
  const d = editDraft;
  d.title = $('#edTitle').value.trim() || d.title;
  d.artist = $('#edArtist').value.trim();
  d.key = $('#edKey').value.trim();
  d.bpm = parseFloat($('#edBpm').value) || null;
  d.timeSig = parseSig($('#edSig').value);
  d.firstBeat = parseFloat($('#edFirstBeat').value) || 0;
  d.transition = { mode: $('#edTransition').value, gap: parseFloat($('#edGap').value) || 0 };
  d.duration = Math.max(0, ...d.tracks.map((t) => t.durationSec || 0));
  d.peaks = songPeaks(d);
  for (const b of d.removedBlobs || []) await db.del('blobs', b);
  delete d.removedBlobs;
  delete d.addedBlobs;
  await db.put('songs', d);
  state.songs.set(d.id, d);
  state.cache.delete(d.id);
  editDraft = null;
  $('#dlgSong').close();
  renderSetlist();
  if (d.id === state.songId) {
    const wasPos = engine.position;
    await loadIndex(state.index);
    engine.pausedAt = Math.min(Math.max(0, wasPos), d.duration);
  }
  toast('Brano salvato');
});
$('#edDelete').addEventListener('click', async () => {
  if (!confirm(`Eliminare “${editDraft.title}” e tutti i suoi file audio da questo dispositivo?`)) return;
  const id = editDraft.id;
  editDraft = null;
  await deleteSong(id);
  $('#dlgSong').close();
});

// Se si annulla la modifica, i file appena aggiunti vengono rimossi.
$('#dlgSong').addEventListener('close', () => {
  if (editDraft && editDraft.addedBlobs) for (const b of editDraft.addedBlobs) db.del('blobs', b);
  editDraft = null;
});

async function deleteSong(id) {
  const song = state.songs.get(id);
  if (!song) return;
  if (id === state.songId) {
    engine.stop();
    engine.setSong({ tracks: [], duration: 0, sections: [] }, new Map());
    engine.song = null;
    state.songId = null;
    state.index = -1;
  }
  for (const t of song.tracks) await db.del('blobs', t.blobId);
  await db.del('songs', id);
  state.songs.delete(id);
  state.cache.delete(id);
  for (const sl of state.setlists) {
    if (sl.songIds.includes(id)) {
      sl.songIds = sl.songIds.filter((x) => x !== id);
      await db.put('setlists', sl);
    }
  }
  const cur = currentSetlist();
  if (state.songId) state.index = cur.songIds.indexOf(state.songId);
  renderSetlist();
  renderNow();
  renderSections();
  renderMixer();
  drawWaveBase();
  renderLibrary();
}

// ---------- Dialog: libreria ----------
async function renderLibrary() {
  const q = $('#libSearch').value.trim().toLowerCase();
  const sl = currentSetlist();
  const songs = [...state.songs.values()]
    .filter((s) => !q || (s.title + ' ' + (s.artist || '')).toLowerCase().includes(q))
    .sort((a, b) => a.title.localeCompare(b.title));
  $('#libList').innerHTML = songs.length ? songs.map((s) => {
    const inSet = sl.songIds.includes(s.id);
    const meta = [s.artist, s.key, s.bpm ? `${s.bpm} BPM` : '', formatTime(s.duration), `${s.tracks.length} tracce`].filter(Boolean).join(' · ');
    return `<li data-id="${s.id}"><div class="info"><div class="t">${esc(s.title)}</div><div class="m">${esc(meta)}</div></div>
      <button type="button" class="btn small ghost" data-act="edit">Modifica</button>
      <button type="button" class="btn small ${inSet ? 'ghost' : 'primary'}" data-act="add">${inSet ? 'Aggiungi ancora' : '+ Scaletta'}</button></li>`;
  }).join('') : '<li class="hint">Nessun brano. Usa “+ Nuovo brano”.</li>';
  const est = await db.storageEstimate();
  $('#libStorage').textContent = est ? `Spazio usato: ${(est.usage / 1048576).toFixed(0)} MB di ${(est.quota / 1048576 / 1024).toFixed(1)} GB` : '';
}

$('#libSearch').addEventListener('input', renderLibrary);
$('#libList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const id = btn.closest('li').dataset.id;
  if (btn.dataset.act === 'add') {
    const sl = currentSetlist();
    sl.songIds.push(id);
    await db.put('setlists', sl);
    renderSetlist();
    renderLibrary();
    toast('Aggiunto alla scaletta');
  } else if (btn.dataset.act === 'edit') {
    $('#dlgLibrary').close();
    openSongEditor(id);
  }
});

// ---------- Scalette ----------
async function setlistMenu() {
  const sl = currentSetlist();
  const choice = prompt(
    `Scaletta “${sl.name}”\n\n1 = Nuova scaletta\n2 = Rinomina\n3 = Duplica\n4 = Elimina\n\nScrivi il numero:`, '1');
  if (!choice) return;
  if (choice.trim() === '1') {
    const name = prompt('Nome della nuova scaletta:', `Culto ${new Date().toLocaleDateString('it-IT')}`);
    if (!name) return;
    const n = { id: db.uid(), name, songIds: [], created: Date.now() };
    state.setlists.push(n);
    await db.put('setlists', n);
    selectSetlist(n.id);
  } else if (choice.trim() === '2') {
    const name = prompt('Nuovo nome:', sl.name);
    if (!name) return;
    sl.name = name;
    await db.put('setlists', sl);
    renderSetlistSelect();
  } else if (choice.trim() === '3') {
    const n = { id: db.uid(), name: sl.name + ' (copia)', songIds: [...sl.songIds], created: Date.now() };
    state.setlists.push(n);
    await db.put('setlists', n);
    selectSetlist(n.id);
  } else if (choice.trim() === '4') {
    if (state.setlists.length === 1) { toast('Deve esserci almeno una scaletta'); return; }
    if (!confirm(`Eliminare la scaletta “${sl.name}”? I brani restano in libreria.`)) return;
    state.setlists = state.setlists.filter((x) => x.id !== sl.id);
    await db.del('setlists', sl.id);
    selectSetlist(state.setlists[0].id);
  }
}

function selectSetlist(id) {
  state.setlistId = id;
  db.setSetting('setlistId', id);
  const sl = currentSetlist();
  state.index = state.songId ? sl.songIds.indexOf(state.songId) : -1;
  renderSetlistSelect();
  renderSetlist();
}

$('#setlistSelect').addEventListener('change', (e) => selectSetlist(e.target.value));
$('#setlistMenuBtn').addEventListener('click', setlistMenu);
$('#editSetlistBtn').addEventListener('click', () => { state.editing = !state.editing; renderSetlist(); });

$('#setlist').addEventListener('click', async (e) => {
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  const i = parseInt(li.dataset.i, 10);
  const sl = currentSetlist();
  const act = e.target.closest('button') && e.target.closest('button').dataset.act;
  if (act) {
    if (act === 'up' && i > 0) [sl.songIds[i - 1], sl.songIds[i]] = [sl.songIds[i], sl.songIds[i - 1]];
    else if (act === 'down' && i < sl.songIds.length - 1) [sl.songIds[i + 1], sl.songIds[i]] = [sl.songIds[i], sl.songIds[i + 1]];
    else if (act === 'remove') sl.songIds.splice(i, 1);
    await db.put('setlists', sl);
    state.index = state.songId ? sl.songIds.indexOf(state.songId) : -1;
    renderSetlist();
    return;
  }
  if (state.editing) { openSongEditor(sl.songIds[i]); return; }
  if (i === state.index) return;
  if (!confirmSwitch()) return;
  loadIndex(i);
  if (window.matchMedia('(max-width: 900px)').matches) document.body.classList.remove('setlist-open');
});

// ---------- Impostazioni ----------
function openSettings() {
  const st = state.settings;
  $('#setClickMode').value = st.clickMode;
  $('#setClickSound').value = st.clickSound;
  $('#setCountIn').value = String(st.countInBars);
  $('#setPadFade').value = st.padFade;
  $('#setChannels').textContent = engine.channelCount || 2;
  $('#dlgSettings').showModal();
}

function applyEngineSettings() {
  const st = state.settings;
  engine.settings.clickMode = st.clickMode;
  engine.settings.clickSound = st.clickSound;
  $('#jumpMode').value = st.jumpMode;
  $('#countInBtn').classList.toggle('on', st.countIn);
  $('#countInBtn').textContent = st.countIn ? `Count-in ${st.countInBars}` : 'Count-in';
  $('#padBtn').classList.toggle('on', st.padOn);
}

$('#setClickMode').addEventListener('change', (e) => { state.settings.clickMode = e.target.value; applyEngineSettings(); saveSettings(); });
$('#setClickSound').addEventListener('change', (e) => { state.settings.clickSound = e.target.value; applyEngineSettings(); saveSettings(); });
$('#setCountIn').addEventListener('change', (e) => { state.settings.countInBars = parseInt(e.target.value, 10); applyEngineSettings(); saveSettings(); });
$('#setPadFade').addEventListener('change', (e) => { state.settings.padFade = parseFloat(e.target.value) || 3; saveSettings(); });
$('#setDetect').addEventListener('click', () => {
  const n = engine.rebuildOutputs();
  $('#setChannels').textContent = n;
  renderMixer();
  toast(`${n} uscite disponibili`);
});
document.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
  const preset = b.dataset.preset;
  const n = engine.channelCount || 2;
  if (preset === 'multi' && n < 4) { toast('Servono almeno 4 uscite: collega l\'interfaccia e premi “Rileva uscite”'); return; }
  const forRole = (role) => {
    if (preset === 'all') return 's0';
    if (preset === 'split') return role === 'track' || role === 'pad' ? 'm1' : 'm0';
    return role === 'track' || role === 'pad' ? 's1' : 's0';
  };
  const song = currentSong();
  if (song) {
    for (const t of song.tracks) t.output = forRole(t.role);
    saveSong(song);
  }
  state.settings.click.output = forRole('click');
  state.settings.pad.output = forRole('pad');
  for (const t of song ? song.tracks : []) engine.trackStrips.get(t.id)?.route(t.output);
  applyStripSettings();
  saveSettings();
  renderMixer();
  toast('Routing applicato al brano attuale');
}));

// ---------- MIDI ----------
async function enableMidi() {
  if (!navigator.requestMIDIAccess) {
    $('#setMidiStatus').textContent = 'Web MIDI non supportato da questo browser (usa Chrome/Edge su Mac).';
    return;
  }
  try {
    const access = await navigator.requestMIDIAccess();
    const bind = () => {
      let n = 0;
      access.inputs.forEach((inp) => { inp.onmidimessage = onMidi; n++; });
      $('#setMidiStatus').textContent = `${n} dispositivi MIDI collegati`;
    };
    access.onstatechange = bind;
    bind();
  } catch (e) {
    $('#setMidiStatus').textContent = 'Accesso MIDI negato';
  }
}

function onMidi(msg) {
  const [st, d1, d2] = msg.data;
  const type = st & 0xf0;
  if (type === 0x90 && d2 > 0) {
    const map = { 60: togglePlay, 62: stopAll, 64: () => changeSong(-1), 65: () => changeSong(1), 67: () => stepSection(-1), 69: () => stepSection(1), 71: toggleLoop };
    if (map[d1]) map[d1]();
  } else if (type === 0xc0) {
    const sl = currentSetlist();
    if (sl && d1 < sl.songIds.length && !engine.playing) loadIndex(d1);
  }
}
$('#setMidi').addEventListener('click', enableMidi);

// ---------- Comandi ----------
$('#playBtn').addEventListener('click', togglePlay);
$('#stopBtn').addEventListener('click', stopAll);
$('#prevSong').addEventListener('click', () => changeSong(-1));
$('#nextSong').addEventListener('click', () => changeSong(1));
$('#loopBtn').addEventListener('click', toggleLoop);
$('#padBtn').addEventListener('click', togglePad);
$('#countInBtn').addEventListener('click', () => {
  state.settings.countIn = !state.settings.countIn;
  applyEngineSettings();
  saveSettings();
});
$('#settingsBtn').addEventListener('click', openSettings);
$('#libraryBtn').addEventListener('click', () => { $('#libSearch').value = ''; renderLibrary(); $('#dlgLibrary').showModal(); });
$('#importBtn').addEventListener('click', openImport);
$('#editSongBtn').addEventListener('click', () => { if (state.songId) openSongEditor(state.songId); else toast('Nessun brano caricato'); });
$('#jumpMode').addEventListener('change', (e) => { state.settings.jumpMode = e.target.value; saveSettings(); });
$('#toggleSetlist').addEventListener('click', () => {
  if (window.matchMedia('(max-width: 900px)').matches) document.body.classList.toggle('setlist-open');
  else document.body.classList.toggle('setlist-hidden');
  setTimeout(drawWaveBase, 0);
});
$('#sections').addEventListener('click', (e) => {
  const b = e.target.closest('.sec');
  if (b) jumpToSection(parseInt(b.dataset.i, 10));
});
$('#addMarkerBtn').addEventListener('click', () => {
  const song = currentSong();
  if (!song) { toast('Nessun brano caricato'); return; }
  const pos = Math.max(0, engine.position);
  const n = (song.sections || []).length;
  const suggestion = SECTION_PRESETS[Math.min(n, SECTION_PRESETS.length - 1)];
  const name = prompt(`Nome della sezione a ${formatTime(pos, true)}\n(${SECTION_PRESETS.join(', ')})`, suggestion);
  if (name) addSectionAt(name.trim(), pos);
});

document.addEventListener('keydown', (e) => {
  if (document.querySelector('dialog[open]')) return;
  if (e.target.matches('input, select, textarea')) return;
  const k = e.key;
  if (k === ' ') { e.preventDefault(); togglePlay(); }
  else if (k === 'Escape') stopAll();
  else if (k === 'ArrowRight') { e.preventDefault(); stepSection(1); }
  else if (k === 'ArrowLeft') { e.preventDefault(); stepSection(-1); }
  else if (k === 'ArrowDown') { e.preventDefault(); changeSong(1); }
  else if (k === 'ArrowUp') { e.preventDefault(); changeSong(-1); }
  else if (k === 'l' || k === 'L') toggleLoop();
  else if (k === 'p' || k === 'P') togglePad();
  else if (/^[1-9]$/.test(k)) jumpToSection(parseInt(k, 10) - 1);
});

window.addEventListener('resize', debounce(() => { drawWaveBase(); renderMixer(); }, 150));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { engine.resume(); if (engine.playing) keepAwake(true); }
});

// ---------- Avvio ----------
async function boot() {
  const [songs, setlists, settings, setlistId] = await Promise.all([
    db.getAll('songs'), db.getAll('setlists'), db.getSetting('settings', null), db.getSetting('setlistId', null),
  ]);
  for (const s of songs) state.songs.set(s.id, s);
  if (settings) {
    state.settings = { ...state.settings, ...settings };
    state.settings.click = { ...{ volume: 1, pan: 0, mute: false, output: 's0' }, ...settings.click };
    state.settings.pad = { ...{ volume: 0.6, pan: 0, mute: false, output: 's0' }, ...settings.pad };
  }
  state.settings.padOn = false; // il pad parte sempre spento
  state.setlists = setlists.sort((a, b) => (a.created || 0) - (b.created || 0));
  if (!state.setlists.length) {
    const sl = { id: db.uid(), name: 'Scaletta principale', songIds: [], created: Date.now() };
    state.setlists.push(sl);
    await db.put('setlists', sl);
  }
  state.setlistId = state.setlists.some((s) => s.id === setlistId) ? setlistId : state.setlists[0].id;
  renderSetlistSelect();
  renderSetlist();
  renderNow();
  applyEngineSettings();
  drawWaveBase();
  requestAnimationFrame(frame);
}

$('#startBtn').addEventListener('click', async () => {
  await engine.init();
  applyStripSettings();
  db.requestPersistence();
  $('#start').hidden = true;
  renderMixer();
  const sl = currentSetlist();
  if (sl && sl.songIds.length) loadIndex(0);
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

boot();

// datalist con i nomi tipici delle sezioni
const dl = document.createElement('datalist');
dl.id = 'secPresets';
dl.innerHTML = SECTION_PRESETS.map((n) => `<option value="${n}">`).join('');
document.body.appendChild(dl);
