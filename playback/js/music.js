// Utility musicali: tonalità, durate, formattazione del tempo.
export const KEYS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const NOTE_INDEX = {
  C: 0, 'B#': 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, Fb: 4, F: 5, 'E#': 5,
  'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11, Cb: 11,
};
const IT_NAMES = { DO: 'C', RE: 'D', MI: 'E', FA: 'F', SOL: 'G', LA: 'A', SI: 'B' };

// Restituisce { root: 0-11, minor: bool } oppure null.
export function parseKey(text) {
  if (!text) return null;
  let t = String(text).trim();
  if (!t) return null;
  const it = t.toUpperCase().match(/^(DO|RE|MI|FA|SOL|LA|SI)(.*)$/);
  if (it) t = IT_NAMES[it[1]] + it[2];
  const m = t.match(/^([A-Ga-g])([#b♯♭]?)(.*)$/);
  if (!m) return null;
  const name = m[1].toUpperCase() + (m[2] === '♯' ? '#' : m[2] === '♭' ? 'b' : m[2]);
  const rest = m[3].trim().toLowerCase();
  const minor = rest.startsWith('m') && !rest.startsWith('maj') || rest.startsWith('min') || rest === '-';
  const root = NOTE_INDEX[name];
  return root === undefined ? null : { root, minor };
}

export function midiToFreq(n) {
  return 440 * Math.pow(2, (n - 69) / 12);
}

export function beatDuration(song) {
  return 60 / (song.bpm || 120);
}

// Il BPM si riferisce all'unità del denominatore (x/4 → semiminime, x/8 → crome).
export function barDuration(song) {
  const [num] = song.timeSig || [4, 4];
  return num * beatDuration(song);
}

export function formatTime(sec, withMs = false) {
  if (!isFinite(sec)) sec = 0;
  const neg = sec < 0;
  sec = Math.abs(sec);
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  let out = `${neg ? '-' : ''}${m}:${String(s).padStart(2, '0')}`;
  if (withMs) out += '.' + String(Math.floor((sec % 1) * 100)).padStart(2, '0');
  return out;
}

export function parseTime(text) {
  const t = String(text).trim().replace(',', '.');
  if (!t) return NaN;
  const parts = t.split(':');
  if (parts.length === 1) return parseFloat(parts[0]);
  return parseInt(parts[0], 10) * 60 + parseFloat(parts[1]);
}

export function gainToDb(g) {
  if (g <= 0.0001) return '-∞';
  const db = 20 * Math.log10(g);
  return (db > 0 ? '+' : '') + db.toFixed(1);
}

// Il fader va da 0 a 1: 0.8 = 0 dB (guadagno 1), 1 = +6 dB; sotto 0.8 curva quadratica.
export function faderToGain(f) {
  if (f <= 0) return 0;
  if (f <= 0.8) return Math.pow(f / 0.8, 2);
  return Math.pow(10, ((f - 0.8) * 30) / 20);
}

export function gainToFader(g) {
  if (g <= 0) return 0;
  if (g <= 1) return Math.sqrt(g) * 0.8;
  return Math.min(1, 0.8 + (20 * Math.log10(g)) / 30);
}
