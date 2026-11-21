// bgm/song.js から MIDI（bgm/home-waltz.mid）を作る。 node bgm/make_midi.mjs
// 形式1・480分解能。トラック：0=テンポと拍子／1=旋律／2=伴奏／3=低音（GM の Music Box 10）／4=鳥a／5=鳥b（GM の Bird Tweet 123）。
// タイミングと強さは song.js の値そのまま（ずらし・乱数なし）。DAW で直したら、同じ値を song.js に戻す。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const self = {};
new Function('self', readFileSync(join(here, 'song.js'), 'utf8'))(self);
const S = self.BGM_SONG, PPQ = 480;
const NOTE = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 };
const midiOf = s => { const m = /^([A-G])([b#]?)(-?\d)$/.exec(s); return 12*(+m[3] + 1) + NOTE[m[1]] + (m[2] === 'b' ? -1 : m[2] === '#' ? 1 : 0); };

const vlq = n => { const b = [n & 127]; while ((n >>= 7)) b.unshift((n & 127) | 128); return b; };
const text = (type, s) => { const u = [...Buffer.from(s, 'utf8')]; return [0xff, type, ...vlq(u.length), ...u]; };
function track(events) {   // events: [tick, order, bytes]
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = []; let last = 0;
  for (const [t, , bytes] of events) { out.push(...vlq(t - last), ...bytes); last = t; }
  out.push(0, 0xff, 0x2f, 0);
  return [...Buffer.from('MTrk'), ...u32(out.length), ...out];
}
const u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

const usPerBeat = Math.round(60e6/S.bpm);
const tracks = [track([
  [0, 0, text(0x03, S.title)],
  [0, 1, [0xff, 0x51, 3, (usPerBeat >> 16) & 255, (usPerBeat >> 8) & 255, usPerBeat & 255]],
  [0, 2, [0xff, 0x58, 4, S.beatsPerBar, 2, 24, 8]],
  [0, 3, [0xff, 0x59, 2, 0, 0]],   // 調：ハ長調
  ...S.chords.map((c, i) => [i*S.beatsPerBar*PPQ, 4, text(0x06, `${i + 1}: ${c}`)])   // 小節ごとの和音をマーカーに
])];
[['melody', '旋律（オルゴール）', 10], ['acc', '伴奏（オルゴール）', 10], ['bass', '低音（オルゴール）', 10],
 ['bird', '鳥a（しゃくり上がる声）', 123, 'a'], ['bird', '鳥b（降りる声）', 123, 'b']].forEach(([part, name, program, who], ch) => {
  const ev = [[0, 0, text(0x03, name)], [0, 1, [0xc0 | ch, program]]];
  for (const [bar, beat, n, len, vel, w] of S[part]) {
    if (who && w !== who) continue;
    const on = Math.round(((bar - 1)*S.beatsPerBar + (beat - 1))*PPQ), off = on + Math.round(len*PPQ), m = midiOf(n);
    ev.push([on, 3, [0x90 | ch, m, vel]], [off, 2, [0x80 | ch, m, 0]]);   // 同じ位置では切ってから鳴らす
  }
  tracks.push(track(ev));
});
const head = [...Buffer.from('MThd'), ...u32(6), 0, 1, 0, tracks.length, (PPQ >> 8) & 255, PPQ & 255];
writeFileSync(join(here, 'home-waltz.mid'), Buffer.from([...head, ...tracks.flat()]));
console.log('wrote bgm/home-waltz.mid', tracks.length, 'tracks');
