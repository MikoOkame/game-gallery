/* ============================================================
   空巡り ホームのBGM：オルゴールの音源と再生
   音源は音綴り（mikookame/ototsuzuri）のオルゴール「音色2」（柔らかさ2・高音の抑えあり）と同じ作り。
   設計は音綴りの ref/web-audio-bgm-design.md に従う：
     ・AudioContext はボタンを押したときに作る（自動では鳴らない）
     ・先読み予約（25ms ごとに起きて 0.2 秒先まで）。曲の全部を一度に予約しない
     ・鳴り終わったノードは必ず切断する
     ・masterGain → コンプレッサー（-6dB・1/3）→ 持ち上げ 1.15 → 出力。残響は 300Hz より下を切ってから送る
   曲のデータは bgm/song.js（self.BGM_SONG）
   ============================================================ */
(() => {
  const SONG = self.BGM_SONG;
  if (!SONG) return;

  const LOOKAHEAD_MS = 25, AHEAD_SEC = .2;
  const VOLUME = .55;          // ページの BGM の大きさ
  const FADE_IN = 1.2, FADE_OUT = .6;

  /* ---- 曲データ → 秒 ---- */
  const NOTE = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 };
  const midiOf = s => { const m = /^([A-G])([b#]?)(-?\d)$/.exec(s); return 12*(+m[3] + 1) + NOTE[m[1]] + (m[2] === 'b' ? -1 : m[2] === '#' ? 1 : 0); };
  const beatSec = 60/SONG.bpm, barSec = beatSec*SONG.beatsPerBar;
  const LOOP = barSec*SONG.bars;
  const events = [];
  for (const part of ['bass', 'acc', 'melody'])
    for (const [bar, beat, name, len, vel] of SONG[part] || [])
      events.push({ t:(bar - 1)*barSec + (beat - 1)*beatSec, midi:midiOf(name), dur:len*beatSec, vel, part });
  events.sort((a, b) => a.t - b.t);

  /* ---- 音の経路 ---- */
  const midiToFreq = m => 440*Math.pow(2, (m - 69)/12);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // 部屋らしい残響：閉じていく低域通過（9kHz → 約 0.7kHz）・頭に 20ms の間・左右で別の雑音。音綴りの buildRoomImpulse と同じ
  function roomImpulse(ctx, seconds, decay) {
    const rate = ctx.sampleRate, pre = Math.floor(rate*.02), length = Math.max(1, Math.floor(rate*seconds));
    const ir = ctx.createBuffer(2, length + pre, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      let lp = 0, eNew = 0, eRef = 0;
      for (let i = 0; i < length; i++) {
        const env = Math.pow(1 - i/length, decay), n = Math.random()*2 - 1;
        const fc = 600 + 8400*Math.exp(-i/rate*1.6), a = Math.exp(-2*Math.PI*fc/rate);
        lp = (1 - a)*n + a*lp;
        const v = lp*env; d[pre + i] = v; eNew += v*v; eRef += (n*env)*(n*env);
      }
      const k = Math.sqrt(eRef/eNew);
      for (let i = pre; i < pre + length; i++) d[i] *= k;
    }
    return ir;
  }
  function buildGraph(ctx) {
    const G = { ctx, sources:new Set() };
    G.master = ctx.createGain(); G.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -6; comp.knee.value = 12; comp.ratio.value = 3; comp.attack.value = .01; comp.release.value = .25;
    const makeup = ctx.createGain(); makeup.gain.value = 1.15;
    G.master.connect(comp); comp.connect(makeup); makeup.connect(ctx.destination);
    const conv = ctx.createConvolver(); conv.buffer = roomImpulse(ctx, 2.8, 2.6);
    const wet = ctx.createGain(); wet.gain.value = .22;
    conv.connect(wet); wet.connect(G.master);
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 300; hp.Q.value = .7; hp.connect(conv);
    G.send = ctx.createGain(); G.send.gain.value = .5; G.send.connect(hp);   // 送り量は全部 0.5 なので1個を共有
    const n = Math.round(ctx.sampleRate*.06), b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random()*2 - 1;
    G.noise = b;
    return G;
  }

  /* ---- オルゴールの1音 ----
     基音＋2倍（-24dB）・3倍（-16dB）＋弾いた瞬間の 6.27 倍＋ピンの雑音。ファ6（1400Hz）より上は高さに反比例して弱める。
     低音のパートだけ 2倍・3倍を強める（iPhone のスピーカーや電車の中でも低音の高さが分かるように） */
  const HI_HZ = 1400;
  const OVERTONE = { bass:[.35, .2], acc:[.063, .158], melody:[.063, .158] };
  function musicbox(G, t, midi, dur, vel, part) {
    const ctx = G.ctx, freq = midiToFreq(midi);
    const hi = freq > HI_HZ ? HI_HZ/freq : 1;
    const peak = clamp(vel/127, .05, 1)*.5*hi, attack = .012, release = Math.min(dur*2.4 + .3, 2);
    const stopAt = t + attack + release + .05;
    const g = ctx.createGain();
    g.gain.setValueAtTime(.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(.0001, t + attack + release);
    const shelf = ctx.createBiquadFilter(); shelf.type = 'highshelf'; shelf.frequency.value = 4000; shelf.gain.value = -4;
    shelf.connect(G.master);
    g.connect(shelf); g.connect(G.send);
    const parts = [g, shelf];
    const track = o => { G.sources.add(o); o.addEventListener('ended', () => G.sources.delete(o)); return o; };
    const o0 = track(ctx.createOscillator()); o0.frequency.value = freq; o0.connect(g);
    o0.start(t); o0.stop(stopAt);
    const [a2, a3] = OVERTONE[part];
    for (const [ratio, amp, life] of [[2, a2*hi, release*.6], [3, a3*hi*hi*.7, release*.45], [6.27, .08*hi*hi, .07]]) {
      const f = freq*ratio; if (f > 15000 || amp < .002) continue;
      const o = track(ctx.createOscillator()); o.frequency.value = f;
      const og = ctx.createGain(), a = peak*amp;
      og.gain.setValueAtTime(.0001, t);
      og.gain.exponentialRampToValueAtTime(a, t + attack*.5);
      og.gain.exponentialRampToValueAtTime(.0001, t + attack*.5 + life);
      o.connect(og); og.connect(shelf); og.connect(G.send); parts.push(og);
      o.start(t); o.stop(Math.min(stopAt, t + attack + life + .05));
    }
    // ピンが歯を弾く雑音（5ms ほど）
    const ns = track(ctx.createBufferSource()); ns.buffer = G.noise;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = Math.min(6000, 2200 + freq*1.2); bp.Q.value = 1.2;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(.0001, t);
    ng.gain.exponentialRampToValueAtTime(peak*.125, t + .0008);
    ng.gain.exponentialRampToValueAtTime(.0001, t + .006);
    ns.connect(bp); bp.connect(ng); ng.connect(shelf); parts.push(bp, ng);
    ns.start(t, (midi % 7)*.004, .012);   // 雑音の読み始めは音の高さで決める（乱数にしない）
    o0.addEventListener('ended', () => parts.forEach(x => x.disconnect()));
  }

  /* ---- 先読み予約 ---- */
  let G = null, playing = false, gen = 0, timer = 0, songStart = 0, loopN = 0, cursor = 0;
  function seekTo(now) {   // 今の時刻に合わせてカーソルを置き直す（遅れたときの追いつき）
    const pos = now - songStart;
    loopN = Math.floor(pos/LOOP);
    const inLoop = pos - loopN*LOOP;
    cursor = events.findIndex(e => e.t >= inLoop);
    if (cursor < 0) { cursor = 0; loopN++; }
  }
  function tick(myGen) {
    if (myGen !== gen) return;
    const now = G.ctx.currentTime, until = now + AHEAD_SEC;
    for (let guard = 0; guard < 400; guard++) {
      const e = events[cursor], at = songStart + loopN*LOOP + e.t;
      if (at >= until) break;
      if (at < now - .05) { seekTo(now); continue; }
      musicbox(G, Math.max(at, now), e.midi, e.dur, e.vel, e.part);
      if (++cursor >= events.length) { cursor = 0; loopN++; }
    }
    timer = setTimeout(() => tick(myGen), LOOKAHEAD_MS);   // どの経路でも必ず次を予約する
  }

  function ensureCtx() {
    if (G) return G.ctx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    G = buildGraph(new Ctx());
    return G.ctx;
  }
  function play() {
    const ctx = ensureCtx(); if (!ctx) return false;
    if (ctx.state !== 'running') ctx.resume();
    if (playing) return true;
    playing = true; gen++;
    clearTimeout(timer);
    stopSources();
    const now = ctx.currentTime;
    G.master.gain.cancelScheduledValues(now);
    G.master.gain.setValueAtTime(0, now);
    G.master.gain.linearRampToValueAtTime(VOLUME, now + FADE_IN);
    songStart = now + .08; loopN = 0; cursor = 0;   // 押すたびに曲の頭から
    tick(gen);
    emit();
    return true;
  }
  function stop() {
    if (!playing) return;
    playing = false; gen++;
    clearTimeout(timer);
    const ctx = G.ctx, now = ctx.currentTime, g = G.master.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + FADE_OUT);
    const myGen = gen;
    setTimeout(() => { if (myGen === gen) stopSources(); }, FADE_OUT*1000 + 60);
    emit();
  }
  function stopSources() {   // 予約済みの音も止める（ended で切断される）
    if (!G) return;
    for (const s of [...G.sources]) { try { s.stop(); } catch (e) {} }
  }

  // 画面を離れたら音の時計ごと止め、戻ったら続きから（タブ裏で音が重なる・鳴りっぱなしを防ぐ）
  document.addEventListener('visibilitychange', () => {
    if (!G) return;
    if (document.hidden) G.ctx.suspend();
    else if (playing) G.ctx.resume();
  });

  const listeners = new Set();
  const emit = () => listeners.forEach(f => f(playing));

  /* ---- 書き出し（確認用）：曲の頭から sec 秒を OfflineAudioContext で合成して返す ---- */
  async function render(sec = LOOP, rate = 44100) {
    const ctx = new OfflineAudioContext(2, Math.ceil(sec*rate), rate);
    const R = buildGraph(ctx);
    R.master.gain.value = VOLUME;
    for (let n = 0; n*LOOP < sec; n++)
      for (const e of events) { const t = n*LOOP + e.t; if (t < sec) musicbox(R, t, e.midi, e.dur, e.vel, e.part); }
    return ctx.startRendering();
  }

  self.BGM = {
    play, stop,
    toggle: () => (playing ? (stop(), false) : play()),
    get playing() { return playing; },
    onChange: f => listeners.add(f),
    render,
    loopSec: LOOP,
    get activeNodes() { return G ? G.sources.size : 0; }
  };
})();
