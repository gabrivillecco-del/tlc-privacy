// Motore audio: stem sincronizzati, mixer, routing multi-uscita, click, count-in, pad, salti e loop.
import { midiToFreq, beatDuration, barDuration, parseKey } from './music.js';

const LOOKAHEAD = 0.2;   // secondi di click programmati in anticipo
const TICK_MS = 25;
const FADE = 0.008;      // micro-dissolvenza per salti senza "click"

export function parseOutput(spec, channelCount) {
  const kind = spec && spec[0] === 'm' ? 'm' : 's';
  let n = parseInt(String(spec || 's0').slice(1), 10) || 0;
  if (kind === 's') n = Math.min(n, Math.floor(channelCount / 2) - 1);
  else n = Math.min(n, channelCount - 1);
  return { kind, n: Math.max(0, n) };
}

export function outputOptions(channelCount) {
  const opts = [];
  for (let p = 0; p * 2 + 1 < channelCount; p++) opts.push({ value: 's' + p, label: `${p * 2 + 1}-${p * 2 + 2}` });
  for (let c = 0; c < channelCount; c++) {
    const label = channelCount === 2 ? (c === 0 ? '1 (L)' : '2 (R)') : String(c + 1);
    opts.push({ value: 'm' + c, label: label + ' mono' });
  }
  return opts;
}

class Strip {
  constructor(engine, id) {
    const ctx = engine.ctx;
    this.engine = engine;
    this.id = id;
    this.volume = 1;
    this.muted = false;
    this.soloMuted = false;
    this.output = 's0';
    this.input = ctx.createGain();
    this.panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    this.muteGain = ctx.createGain();
    this.post = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.meterBuf = new Float32Array(this.analyser.fftSize);
    if (this.panner) { this.input.connect(this.panner); this.panner.connect(this.muteGain); }
    else this.input.connect(this.muteGain);
    this.muteGain.connect(this.post);
    this.post.connect(this.analyser);
    this.routeNodes = [];
    this.route('s0');
  }

  setVolume(g) {
    this.volume = g;
    this.input.gain.setTargetAtTime(g, this.engine.ctx.currentTime, 0.01);
  }

  setPan(p) {
    if (this.panner) this.panner.pan.setTargetAtTime(p, this.engine.ctx.currentTime, 0.01);
  }

  setMute(m) {
    this.muted = m;
    this.updateMute();
  }

  updateMute() {
    const on = !(this.muted || this.soloMuted);
    this.muteGain.gain.setTargetAtTime(on ? 1 : 0, this.engine.ctx.currentTime, 0.005);
  }

  route(spec) {
    const { ctx, merger, channelCount } = this.engine;
    this.output = spec;
    for (const n of this.routeNodes) n.disconnect();
    this.routeNodes = [];
    this.post.disconnect();
    this.post.connect(this.analyser);
    const { kind, n } = parseOutput(spec, channelCount);
    if (kind === 's') {
      const split = ctx.createChannelSplitter(2);
      this.post.connect(split);
      split.connect(merger, 0, n * 2);
      split.connect(merger, 1, n * 2 + 1);
      this.routeNodes.push(split);
    } else {
      // Downmix L+R → mono (media dei due canali) verso una singola uscita.
      const mono = ctx.createGain();
      mono.channelCount = 1;
      mono.channelCountMode = 'explicit';
      mono.channelInterpretation = 'speakers';
      this.post.connect(mono);
      mono.connect(merger, 0, n);
      this.routeNodes.push(mono);
    }
  }

  meter() {
    if (this.analyser.getFloatTimeDomainData) {
      this.analyser.getFloatTimeDomainData(this.meterBuf);
      let peak = 0;
      for (let i = 0; i < this.meterBuf.length; i++) {
        const v = Math.abs(this.meterBuf[i]);
        if (v > peak) peak = v;
      }
      return peak;
    }
    return 0;
  }

  destroy() {
    for (const n of [this.input, this.panner, this.muteGain, this.post, this.analyser, ...this.routeNodes]) {
      if (n) n.disconnect();
    }
  }
}

class Pad {
  constructor(engine) {
    this.engine = engine;
    const ctx = engine.ctx;
    this.voice = null;
    this.key = null;
    this.out = ctx.createGain();
    const dry = ctx.createGain();
    dry.gain.value = 0.55;
    const wet = ctx.createGain();
    wet.gain.value = 0.9;
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(4.5);
    this.out.connect(dry);
    this.out.connect(this.reverb);
    this.reverb.connect(wet);
    dry.connect(engine.padStrip.input);
    wet.connect(engine.padStrip.input);
  }

  impulse(seconds) {
    const ctx = this.engine.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    }
    return buf;
  }

  get playing() { return !!this.voice; }

  start(keyText, fade = 3) {
    const key = parseKey(keyText);
    if (!key) return false;
    const id = key.root + (key.minor ? 'm' : '');
    if (this.voice && this.key === id) return true;
    this.stop(fade);
    this.key = id;
    this.voice = this.buildVoice(key, fade);
    return true;
  }

  buildVoice(key, fade) {
    const ctx = this.engine.ctx;
    const now = ctx.currentTime;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.exponentialRampToValueAtTime(1, now + fade);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1100;
    filter.Q.value = 0.4;
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 0.07;
    lfoGain.gain.value = 450;
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);
    filter.connect(env);
    env.connect(this.out);
    const base = 48 + key.root; // C3..B3
    const notes = [base - 12, base, base + 7, base + 12, base + (key.minor ? 15 : 16), base + 19];
    const levels = [0.5, 0.8, 0.6, 0.5, 0.35, 0.3];
    const oscs = [lfo];
    notes.forEach((n, i) => {
      for (const detune of [-8, 8]) {
        const o = ctx.createOscillator();
        o.type = i === 0 ? 'sine' : 'sawtooth';
        o.frequency.value = midiToFreq(n);
        o.detune.value = detune + (Math.random() * 4 - 2);
        const g = ctx.createGain();
        g.gain.value = levels[i] * 0.05;
        o.connect(g);
        g.connect(filter);
        o.start(now);
        oscs.push(o);
      }
    });
    lfo.start(now);
    return { env, oscs, filter };
  }

  stop(fade = 3) {
    if (!this.voice) return;
    const { env, oscs } = this.voice;
    const now = this.engine.ctx.currentTime;
    env.gain.cancelScheduledValues(now);
    env.gain.setValueAtTime(Math.max(env.gain.value, 0.0001), now);
    env.gain.exponentialRampToValueAtTime(0.0001, now + fade);
    for (const o of oscs) o.stop(now + fade + 0.1);
    setTimeout(() => env.disconnect(), (fade + 0.3) * 1000);
    this.voice = null;
    this.key = null;
  }
}

export class Engine {
  constructor() {
    this.ctx = null;
    this.song = null;
    this.buffers = new Map();
    this.trackStrips = new Map();
    this.sources = [];
    this.anchors = [];
    this.clickNodes = [];
    this.playing = false;
    this.pausedAt = 0;
    this.loop = null;
    this.pendingJump = null;
    this.countInUntil = 0;
    this.schedUntil = 0;
    this.onEnded = null;
    this.settings = { clickMode: 'auto', countInBars: 0, clickSound: 'beep' };
  }

  async init() {
    if (this.ctx) return this.resume();
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    // iOS: suona anche con l'interruttore silenzioso attivo.
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (_) { /* ignorato */ }
    this.setupOutputs();
    this.clickStrip = new Strip(this, '__click');
    this.padStrip = new Strip(this, '__pad');
    this.pad = new Pad(this);
    this.timer = setInterval(() => this.tick(), TICK_MS);
    await this.resume();
  }

  async resume() {
    if (this.ctx && this.ctx.state !== 'running') {
      try { await this.ctx.resume(); } catch (_) { /* serve un gesto dell'utente */ }
    }
  }

  setupOutputs() {
    const dest = this.ctx.destination;
    let n = Math.max(2, Math.min(32, dest.maxChannelCount || 2));
    try {
      dest.channelCount = n;
      dest.channelCountMode = 'explicit';
      dest.channelInterpretation = 'discrete';
    } catch (_) {
      n = 2;
    }
    this.channelCount = n;
    this.merger = this.ctx.createChannelMerger(n);
    this.master = this.ctx.createGain();
    this.master.channelCount = n;
    this.master.channelCountMode = 'explicit';
    this.master.channelInterpretation = 'discrete';
    this.merger.connect(this.master);
    this.master.connect(dest);
  }

  rebuildOutputs() {
    const vol = this.master.gain.value;
    this.merger.disconnect();
    this.master.disconnect();
    this.setupOutputs();
    this.master.gain.value = vol;
    for (const s of this.allStrips()) s.route(s.output);
    return this.channelCount;
  }

  allStrips() {
    return [...this.trackStrips.values(), this.clickStrip, this.padStrip];
  }

  setMasterVolume(g) {
    this.master.gain.setTargetAtTime(g, this.ctx.currentTime, 0.01);
  }

  decode(blob) {
    return blob.arrayBuffer().then((ab) => new Promise((resolve, reject) => {
      this.ctx.decodeAudioData(ab, resolve, reject);
    }));
  }

  // ---- Brano ----
  setSong(song, buffers) {
    this.pause();
    for (const s of this.trackStrips.values()) s.destroy();
    this.trackStrips.clear();
    this.song = song;
    this.buffers = buffers || new Map();
    this.loop = null;
    this.pausedAt = 0;
    for (const t of song.tracks) {
      const s = new Strip(this, t.id);
      s.setVolume(t.volume ?? 1);
      s.setPan(t.pan || 0);
      s.setMute(!!t.mute);
      s.route(t.output || 's0');
      this.trackStrips.set(t.id, s);
    }
    this.updateSolo();
  }

  updateSolo() {
    if (!this.song) return;
    const anySolo = this.song.tracks.some((t) => t.solo);
    for (const t of this.song.tracks) {
      const s = this.trackStrips.get(t.id);
      if (!s) continue;
      s.soloMuted = anySolo && !t.solo && (t.role || 'track') === 'track';
      s.updateMute();
    }
  }

  get duration() {
    return this.song ? this.song.duration || 0 : 0;
  }

  // ---- Tempo ----
  songTimeAt(t) {
    let a = this.anchors[0];
    for (const an of this.anchors) {
      if (an.ctx <= t) a = an;
      else break;
    }
    return a ? a.song + (t - a.ctx) : this.pausedAt;
  }

  ctxAt(songTime) {
    const a = this.anchors[this.anchors.length - 1];
    return a.ctx + (songTime - a.song);
  }

  get position() {
    if (!this.playing) return this.pausedAt;
    return this.songTimeAt(this.ctx.currentTime);
  }

  get isCountingIn() {
    return this.playing && this.ctx.currentTime < this.countInUntil;
  }

  generatedClickOn() {
    if (!this.song || !this.song.bpm) return false;
    const mode = this.settings.clickMode;
    if (mode === 'off') return false;
    if (mode === 'always') return true;
    return !this.song.tracks.some((t) => t.role === 'click');
  }

  // ---- Trasporto ----
  async play(from = this.pausedAt) {
    await this.init();
    if (this.playing || !this.song) return;
    if (from >= this.duration - 0.05) from = 0;
    const T0 = this.ctx.currentTime + 0.06;
    const bars = this.song.bpm ? this.settings.countInBars || 0 : 0;
    const ci = bars * barDuration(this.song);
    this.countInUntil = T0 + ci;
    this.anchors = [{ ctx: T0, song: from - ci }];
    this.startSources(T0 + ci, from);
    this.schedUntil = T0;
    this.playing = true;
    this.pendingJump = null;
    this.tick();
  }

  pause() {
    if (!this.playing) return;
    const now = this.ctx.currentTime;
    this.pausedAt = Math.max(0, Math.min(this.songTimeAt(now), this.duration));
    if (now < this.countInUntil) this.pausedAt = Math.max(0, this.ctxToStemsStart());
    this.stopSources(now);
    this.cancelClicksAfter(now);
    this.anchors = [];
    this.playing = false;
    this.pendingJump = null;
  }

  ctxToStemsStart() {
    return this.songTimeAt(this.countInUntil);
  }

  stop() {
    this.pause();
    this.pausedAt = 0;
  }

  // mode: 'now' | 'bar' | 'section'
  jumpTo(target, mode = 'now') {
    target = Math.max(0, Math.min(target, this.duration));
    if (!this.playing) {
      this.pausedAt = target;
      return;
    }
    const now = this.ctx.currentTime;
    let T = now + 0.04;
    if (mode !== 'now' && this.song.bpm && now >= this.countInUntil) {
      const s = this.songTimeAt(T);
      let boundary = null;
      if (mode === 'section') {
        const next = (this.song.sections || []).map((x) => x.time).filter((x) => x > s + 0.02).sort((a, b) => a - b)[0];
        if (next !== undefined) boundary = next;
      }
      if (boundary === null) {
        const fb = this.song.firstBeat || 0;
        const bar = barDuration(this.song);
        boundary = fb + Math.ceil((s - fb) / bar - 1e-6) * bar;
        if (boundary < s) boundary += bar;
      }
      T = this.ctxAt(boundary);
    }
    this.pendingJump = { at: T, target };
    this.scheduleJump(T, target);
  }

  scheduleJump(T, target) {
    this.stopSources(T);
    this.cancelClicksAfter(T);
    this.anchors = this.anchors.filter((a) => a.ctx < T);
    this.anchors.push({ ctx: T, song: target });
    this.startSources(T, target);
    this.schedUntil = Math.min(this.schedUntil, T);
    this.countInUntil = Math.min(this.countInUntil, T);
  }

  setLoop(region) {
    this.loop = region;
    const a = this.anchors[this.anchors.length - 1];
    if (a) a.loopDone = false;
  }

  startSources(T, songTime) {
    for (const t of this.song.tracks) {
      const buf = this.buffers.get(t.id);
      const strip = this.trackStrips.get(t.id);
      if (!buf || !strip) continue;
      if (songTime >= buf.duration) continue;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const env = this.ctx.createGain();
      env.gain.setValueAtTime(0, T);
      env.gain.linearRampToValueAtTime(1, T + FADE);
      src.connect(env);
      env.connect(strip.input);
      if (songTime >= 0) src.start(T, songTime);
      else src.start(T - songTime, 0);
      const entry = { src, env, stopped: false };
      src.onended = () => {
        env.disconnect();
        const i = this.sources.indexOf(entry);
        if (i >= 0) this.sources.splice(i, 1);
      };
      this.sources.push(entry);
    }
  }

  stopSources(T) {
    for (const e of this.sources) {
      if (e.stopped) continue;
      e.stopped = true;
      e.env.gain.cancelScheduledValues(T);
      e.env.gain.setValueAtTime(1, T);
      e.env.gain.linearRampToValueAtTime(0, T + FADE);
      try { e.src.stop(T + FADE + 0.005); } catch (_) { /* già fermato */ }
    }
  }

  // ---- Click ----
  scheduleClicks(t0, t1) {
    const song = this.song;
    if (!song || !song.bpm) return;
    const gen = this.generatedClickOn();
    const beat = beatDuration(song);
    const num = (song.timeSig || [4, 4])[0];
    const fb = song.firstBeat || 0;
    for (let i = 0; i < this.anchors.length; i++) {
      const a = this.anchors[i];
      const next = this.anchors[i + 1];
      const start = Math.max(t0, a.ctx);
      const end = Math.min(t1, next ? next.ctx : Infinity);
      if (start >= end) continue;
      const s0 = a.song + (start - a.ctx);
      const s1 = a.song + (end - a.ctx);
      for (let k = Math.ceil((s0 - fb) / beat - 1e-9); fb + k * beat < s1; k++) {
        const st = fb + k * beat;
        const ct = a.ctx + (st - a.song);
        const countIn = ct < this.countInUntil - 1e-4;
        if (!countIn && (!gen || st > this.duration || st < 0)) continue;
        const inBar = ((k % num) + num) % num;
        this.playClick(ct, inBar === 0, countIn);
      }
    }
  }

  playClick(t, accent, countIn) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    const sound = this.settings.clickSound;
    osc.type = sound === 'wood' ? 'triangle' : sound === 'hard' ? 'square' : 'sine';
    osc.frequency.value = sound === 'wood' ? (accent ? 1250 : 800) : (accent ? 1760 : 1320);
    const peak = (accent ? 0.9 : 0.6) * (countIn ? this.clickStrip.volume : 1) * (sound === 'hard' ? 0.4 : 1);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.0015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (sound === 'wood' ? 0.03 : 0.05));
    osc.connect(g);
    // Il count-in salta il mute del click, così si sente sempre.
    g.connect(countIn ? this.clickStrip.post : this.clickStrip.input);
    osc.start(t);
    osc.stop(t + 0.07);
    const entry = { t, g };
    this.clickNodes.push(entry);
    osc.onended = () => {
      g.disconnect();
      const i = this.clickNodes.indexOf(entry);
      if (i >= 0) this.clickNodes.splice(i, 1);
    };
  }

  cancelClicksAfter(T) {
    for (const c of this.clickNodes) if (c.t >= T - 0.001) c.g.disconnect();
  }

  // ---- Scheduler ----
  tick() {
    if (!this.ctx || !this.playing || !this.song) return;
    const now = this.ctx.currentTime;
    const until = now + LOOKAHEAD;
    if (this.schedUntil < now - 0.05) this.schedUntil = now;
    if (until > this.schedUntil) {
      this.scheduleClicks(this.schedUntil, until);
      this.schedUntil = until;
    }
    if (this.pendingJump && now >= this.pendingJump.at) this.pendingJump = null;

    const a = this.anchors[this.anchors.length - 1];
    if (this.loop && a && !a.loopDone && a.song < this.loop.end - 0.02) {
      const Tend = a.ctx + (this.loop.end - a.song);
      if (Tend - now < LOOKAHEAD) {
        a.loopDone = true;
        this.scheduleJump(Math.max(Tend, now + 0.01), this.loop.start);
      }
    }

    const last = this.anchors[this.anchors.length - 1];
    const Tsong = last.ctx + (this.duration - last.song);
    if (now >= Tsong) {
      this.stopSources(now);
      this.anchors = [];
      this.playing = false;
      this.pausedAt = this.duration;
      if (this.onEnded) this.onEnded();
    }
  }
}
