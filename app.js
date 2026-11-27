/* =========================================================
   T-MINUS · split-flap countdown
   - Real split-flap mechanics: every card steps through its drum
   - All sound is synthesized live with the Web Audio API
   ========================================================= */
(() => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const pad = (n, w) => String(n).padStart(w, '0');

  /* ---------------------------------------------------------
     Settings + persistence
     --------------------------------------------------------- */
  const SETTINGS_KEY = 'tminus.settings.v1';
  const STATE_KEY = 'tminus.state.v1';

  const DEFAULTS = {
    label: 'DOOMSDAY',
    wallpaper: 'bunker',
    wallUrl: '',
    wallDim: 45,
    wallBlur: 0,
    accent: 'doom',
    volMaster: 80,
    volClick: 85,
    volDrone: 45,
    minuteBoom: true,
    heartbeat: true,
    shake: true,
    crt: true,
    muted: false,
    mode: 'timer',
    duration: 300,          // seconds
    target: null,           // ISO string for date mode
  };

  const readJSON = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
  const S = { ...DEFAULTS, ...(readJSON(SETTINGS_KEY) || {}) };
  const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(S)); } catch {} };

  // Small IndexedDB wrapper for big blobs (wallpaper image, custom clack sound)
  const idb = (() => {
    let dbp;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      const r = indexedDB.open('tminus', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('blobs');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
    const run = async (mode, fn) => {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction('blobs', mode);
        const req = fn(t.objectStore('blobs'));
        t.oncomplete = () => res(req && req.result);
        t.onerror = () => rej(t.error);
      });
    };
    return {
      get: (k) => run('readonly', (s) => s.get(k)).catch(() => null),
      set: (k, v) => run('readwrite', (s) => s.put(v, k)).catch(() => null),
      del: (k) => run('readwrite', (s) => s.delete(k)).catch(() => null),
    };
  })();

  /* ---------------------------------------------------------
     Sound engine (all synthesized)
     --------------------------------------------------------- */
  const Snd = (() => {
    let ctx = null, master, clickBus, droneBus, fxBus, verbSend, noise;
    let customBuf = null, pendingCustom = null;
    let drone = null;
    const recent = [];

    function makeIR(seconds, decay) {
      const len = Math.floor(ctx.sampleRate * seconds);
      const ir = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let c = 0; c < 2; c++) {
        const d = ir.getChannelData(c);
        for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
      return ir;
    }

    function init() {
      if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();

      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -12; comp.ratio.value = 5; comp.attack.value = 0.003; comp.release.value = 0.25;
      master = ctx.createGain();
      master.connect(comp).connect(ctx.destination);

      // A big empty concrete room
      const verb = ctx.createConvolver();
      verb.buffer = makeIR(3.2, 2.6);
      verbSend = ctx.createGain(); verbSend.gain.value = 0.32;
      verbSend.connect(verb).connect(master);

      clickBus = ctx.createGain(); clickBus.connect(master);
      const clickVerb = ctx.createGain(); clickVerb.gain.value = 0.35; clickBus.connect(clickVerb).connect(verbSend);
      droneBus = ctx.createGain(); droneBus.connect(master);
      fxBus = ctx.createGain(); fxBus.connect(master); fxBus.connect(verbSend);

      noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const nd = noise.getChannelData(0);
      for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

      applyVolumes();
      if (pendingCustom) { const p = pendingCustom; pendingCustom = null; loadCustom(p); }
    }

    function applyVolumes() {
      if (!ctx) return;
      const t = ctx.currentTime;
      master.gain.setTargetAtTime(S.muted ? 0 : (S.volMaster / 100), t, 0.05);
      clickBus.gain.setTargetAtTime(S.volClick / 100, t, 0.05);
      droneBus.gain.setTargetAtTime((S.volDrone / 100) * 0.5, t, 0.2);
      fxBus.gain.setTargetAtTime(0.9, t, 0.05);
    }

    function env(g, t, peak, attack, release) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + attack + release);
    }

    function burst(t, { type = 'bandpass', f, q = 1, dur, gain, dest }) {
      const s = ctx.createBufferSource();
      s.buffer = noise;
      const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(fl).connect(g).connect(dest || clickBus);
      s.start(t, Math.random() * 1.8, dur + 0.05);
    }

    // One flap slapping down: release tick + card slap + housing thunk
    function click(intensity = 1) {
      if (!ctx || ctx.state !== 'running') return;
      const now = ctx.currentTime;
      // keep huge cascades from stacking into mush
      while (recent.length && now - recent[0] > 0.012) recent.shift();
      if (recent.length >= 3) return;
      recent.push(now);

      const t = now + 0.002;
      const v = intensity * (0.8 + Math.random() * 0.35);

      if (customBuf) {
        const s = ctx.createBufferSource();
        s.buffer = customBuf;
        s.playbackRate.value = 0.94 + Math.random() * 0.12;
        const g = ctx.createGain(); g.gain.value = v;
        s.connect(g).connect(clickBus);
        s.start(t);
        return;
      }

      burst(t, { f: 3600 + Math.random() * 1600, q: 1.6, dur: 0.01, gain: 0.45 * v });
      const t2 = t + 0.008 + Math.random() * 0.006;
      burst(t2, { f: 1250 + Math.random() * 600, q: 0.9, dur: 0.04, gain: 0.95 * v });
      burst(t2, { type: 'highpass', f: 6000, q: 0.5, dur: 0.006, gain: 0.25 * v });

      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(210 + Math.random() * 40, t2);
      o.frequency.exponentialRampToValueAtTime(75, t2 + 0.07);
      const g = ctx.createGain();
      env(g, t2, 0.42 * v, 0.003, 0.09);
      o.connect(g).connect(clickBus);
      o.start(t2); o.stop(t2 + 0.12);
    }

    // Deep cinematic impact (every minute)
    function boom(strength = 1) {
      if (!ctx || ctx.state !== 'running') return;
      const t = ctx.currentTime + 0.02;
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(68, t);
      o.frequency.exponentialRampToValueAtTime(24, t + 1.8);
      const g = ctx.createGain(); env(g, t, 0.9 * strength, 0.015, 2.6);
      o.connect(g).connect(fxBus); o.start(t); o.stop(t + 3);

      const sub = ctx.createOscillator(); sub.type = 'sine'; sub.frequency.value = 32;
      const sg = ctx.createGain(); env(sg, t, 0.5 * strength, 0.05, 3);
      sub.connect(sg).connect(fxBus); sub.start(t); sub.stop(t + 3.2);

      burst(t, { type: 'lowpass', f: 180, q: 0.7, dur: 1.4, gain: 0.7 * strength, dest: fxBus });
      // huge steel door resonance
      burst(t + 0.01, { f: 410, q: 16, dur: 1.6, gain: 0.5 * strength, dest: fxBus });
      burst(t + 0.01, { f: 1130, q: 22, dur: 0.9, gain: 0.25 * strength, dest: fxBus });
    }

    // Lub-dub for the final seconds
    function heartbeat() {
      if (!ctx || ctx.state !== 'running') return;
      const beat = (t, amp) => {
        const o = ctx.createOscillator(); o.type = 'sine';
        o.frequency.setValueAtTime(62, t); o.frequency.exponentialRampToValueAtTime(38, t + 0.16);
        const g = ctx.createGain(); env(g, t, amp, 0.008, 0.2);
        o.connect(g).connect(fxBus); o.start(t); o.stop(t + 0.3);
        burst(t, { type: 'lowpass', f: 120, dur: 0.12, gain: amp * 0.5, dest: fxBus });
      };
      const t = ctx.currentTime + 0.03;
      beat(t, 0.75); beat(t + 0.26, 0.5);
    }

    let shaper;
    function distortion() {
      if (shaper) return shaper;
      shaper = ctx.createWaveShaper();
      const n = 1024, curve = new Float32Array(n), k = 18;
      for (let i = 0; i < n; i++) { const x = (i / n) * 2 - 1; curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x)); }
      shaper.curve = curve; shaper.oversample = '2x';
      const post = ctx.createGain(); post.gain.value = 0.28;
      shaper.connect(post).connect(fxBus);
      return shaper;
    }

    // Ominous low brass cluster
    function stab(t, len = 1) {
      const freqs = [43.65, 65.41, 87.31, 103.83, 130.81];
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 4;
      lp.frequency.setValueAtTime(120, t);
      lp.frequency.exponentialRampToValueAtTime(1900, t + 0.12);
      lp.frequency.exponentialRampToValueAtTime(260, t + 1.1 * len);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.5, t + 0.05);
      g.gain.setTargetAtTime(0.0001, t + 0.5 * len, 0.35 * len);
      lp.connect(g).connect(distortion());
      freqs.forEach((f) => {
        [-7, 7].forEach((cents) => {
          const o = ctx.createOscillator(); o.type = 'sawtooth';
          o.frequency.value = f; o.detune.value = cents + (Math.random() * 4 - 2);
          o.connect(lp); o.start(t); o.stop(t + 2.8 * len);
        });
      });
    }

    // Zero: the whole thing
    function doom() {
      if (!ctx || ctx.state !== 'running') return;
      const t0 = ctx.currentTime + 0.05;
      boom(1.3);
      stab(t0, 1);
      stab(t0 + 1.3, 1);
      stab(t0 + 2.6, 1.8);
      setTimeout(() => boom(1.1), 2600);
    }

    function startDrone() {
      if (!ctx || drone) return;
      const t = ctx.currentTime;
      const out = ctx.createGain(); out.gain.value = 0.0001; out.connect(droneBus);
      out.gain.exponentialRampToValueAtTime(1, t + 3.5);

      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 200; lp.Q.value = 7;
      lp.connect(out);
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.055;
      const lfoAmt = ctx.createGain(); lfoAmt.gain.value = 110;
      lfo.connect(lfoAmt).connect(lp.frequency);

      const nodes = [lfo];
      const voice = (type, f, gain, detune = 0) => {
        const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.detune.value = detune;
        const g = ctx.createGain(); g.gain.value = gain;
        o.connect(g).connect(lp); nodes.push(o);
      };
      voice('sawtooth', 36.71, 0.35, -6);
      voice('sawtooth', 36.71, 0.35, 7);
      voice('sawtooth', 55.0, 0.18, 3);
      voice('triangle', 77.78, 0.08);        // the tritone: unease
      const sub = ctx.createOscillator(); sub.type = 'sine'; sub.frequency.value = 18.35;
      const sg = ctx.createGain(); sg.gain.value = 0.6; sub.connect(sg).connect(out); nodes.push(sub);

      // wind through the bunker
      const wind = ctx.createBufferSource(); wind.buffer = noise; wind.loop = true;
      const wf = ctx.createBiquadFilter(); wf.type = 'bandpass'; wf.frequency.value = 380; wf.Q.value = 0.6;
      const wg = ctx.createGain(); wg.gain.value = 0.06;
      const wl = ctx.createOscillator(); wl.frequency.value = 0.09;
      const wla = ctx.createGain(); wla.gain.value = 160;
      wl.connect(wla).connect(wf.frequency);
      wind.connect(wf).connect(wg).connect(out);
      nodes.push(wind, wl);

      nodes.forEach((n) => n.start(t));
      drone = { out, lp, nodes };
    }

    function droneTension(x) { // 0..1
      if (!drone) return;
      drone.lp.frequency.setTargetAtTime(200 + x * 520, ctx.currentTime, 1.2);
    }

    function stopDrone(fade = 1.6) {
      if (!drone) return;
      const d = drone; drone = null;
      const t = ctx.currentTime;
      d.out.gain.cancelScheduledValues(t);
      d.out.gain.setValueAtTime(Math.max(d.out.gain.value, 0.0001), t);
      d.out.gain.exponentialRampToValueAtTime(0.0001, t + fade);
      d.nodes.forEach((n) => { try { n.stop(t + fade + 0.1); } catch {} });
    }

    async function loadCustom(arrayBuffer) {
      if (!arrayBuffer) { customBuf = null; return true; }
      if (!ctx) { pendingCustom = arrayBuffer; return true; }
      try { customBuf = await ctx.decodeAudioData(arrayBuffer.slice(0)); return true; }
      catch { customBuf = null; return false; }
    }

    return {
      init, click, boom, heartbeat, doom, startDrone, stopDrone, droneTension, applyVolumes, loadCustom,
      get ready() { return !!ctx && ctx.state === 'running'; },
    };
  })();

  /* ---------------------------------------------------------
     Split-flap unit
     Each card has a drum of characters it can only rotate
     forward through, exactly like the real hardware. Drums
     are ordered downward so a countdown is one flip per tick.
     --------------------------------------------------------- */
  const FAST = 72;      // ms per card while spinning to a far value
  const NORMAL = 300;   // ms for a single deliberate flip

  class Flap {
    constructor(chars, initial = '0') {
      this.chars = chars;
      this.cur = initial;
      this.target = initial;
      this.extra = 0;
      this.busy = false;

      const el = document.createElement('div');
      el.className = 'flap';
      el.innerHTML =
        '<div class="half top"><span></span></div>' +
        '<div class="half bottom"><span></span><div class="shade"></div></div>' +
        '<div class="leaf front"><span></span></div>' +
        '<div class="leaf back"><span></span></div>';
      this.el = el;
      this.top = $('.top span', el);
      this.bot = $('.bottom span', el);
      this.shade = $('.shade', el);
      this.front = $('.leaf.front', el);
      this.back = $('.leaf.back', el);
      this.frontS = $('span', this.front);
      this.backS = $('span', this.back);
      this.top.textContent = this.bot.textContent = initial;
    }

    next(ch) { return this.chars[(this.chars.indexOf(ch) + 1) % this.chars.length]; }
    distance() {
      const L = this.chars.length;
      return (this.chars.indexOf(this.target) - this.chars.indexOf(this.cur) + L) % L;
    }

    set(ch) {
      if (!this.chars.includes(ch)) return;
      this.target = ch;
      if (!this.busy) this.run();
    }

    spin() { this.extra = this.chars.length; if (!this.busy) this.run(); }

    async run() {
      this.busy = true;
      while (this.cur !== this.target || this.extra > 0) {
        const left = this.distance() + this.extra;
        if (this.extra > 0) this.extra--;
        const nxt = this.next(this.cur);
        if (document.hidden) { this.snap(nxt); continue; }
        await this.flipTo(nxt, left > 1 ? FAST + Math.random() * 18 : NORMAL);
      }
      this.busy = false;
    }

    snap(ch) {
      this.cur = this.target;
      this.extra = 0;
      this.top.textContent = this.bot.textContent = this.cur;
      Snd.click(0.8);
    }

    flipTo(nxt, dur) {
      return new Promise((resolve) => {
        const from = this.cur;
        this.top.textContent = nxt;
        this.frontS.textContent = from;
        this.backS.textContent = nxt;
        this.bot.textContent = from;
        this.el.classList.add('flipping');

        const half = dur * 0.45;
        const fall = dur - half;
        const anims = [
          this.front.animate(
            [{ transform: 'rotateX(0deg)', filter: 'brightness(1)' },
             { transform: 'rotateX(-90deg)', filter: 'brightness(.35)' }],
            { duration: half, easing: 'cubic-bezier(.55,0,1,.6)', fill: 'forwards' }),
          this.back.animate(
            [{ transform: 'rotateX(90deg)', filter: 'brightness(1.3)' },
             { transform: 'rotateX(0deg)', filter: 'brightness(1)', offset: 0.62 },
             { transform: 'rotateX(16deg)', offset: 0.8 },
             { transform: 'rotateX(0deg)' }],
            { duration: fall, delay: half, easing: 'ease-in', fill: 'forwards' }),
          this.shade.animate(
            [{ opacity: 0 }, { opacity: 0.6, offset: 0.5 }, { opacity: 0 }],
            { duration: dur, easing: 'linear' }),
        ];

        // The clack lands when the leaf hits the stop
        const clackAt = half + fall * 0.62;
        const loud = dur >= NORMAL ? 1 : 0.62;
        const tid = setTimeout(() => Snd.click(loud), clackAt);

        let finished = false;
        const done = () => {
          if (finished) return; finished = true;
          clearTimeout(tid);
          this.bot.textContent = nxt;
          this.cur = nxt;
          this.el.classList.remove('flipping');
          anims.forEach((a) => a.cancel());
          resolve();
        };
        anims[1].finished.then(done, done);
        setTimeout(done, dur + 120); // safety net when the tab is throttled
      });
    }
  }

  /* ---------------------------------------------------------
     Display
     --------------------------------------------------------- */
  const DIG = '9876543210';
  const SIX = '543210';
  const TWO = '210';

  const LAYOUTS = {
    timer: [
      { key: 'h', label: 'HOURS', drums: [DIG, DIG], step: 3600 },
      { key: 'm', label: 'MINUTES', drums: [SIX, DIG], step: 60 },
      { key: 's', label: 'SECONDS', drums: [SIX, DIG], step: 1 },
    ],
    date: [
      { key: 'd', label: 'DAYS', drums: [DIG, DIG, DIG] },
      { key: 'h', label: 'HOURS', drums: [TWO, DIG] },
      { key: 'm', label: 'MINUTES', drums: [SIX, DIG] },
      { key: 's', label: 'SECONDS', drums: [SIX, DIG] },
    ],
  };

  const display = $('#display');
  let groups = [];   // [{key, flaps:[Flap]}]

  function buildDisplay(mode) {
    display.innerHTML = '';
    groups = [];
    LAYOUTS[mode].forEach((g, i) => {
      if (i > 0) {
        const sep = document.createElement('div');
        sep.className = 'sep' + (i === LAYOUTS[mode].length - 1 ? ' pulse' : '');
        sep.innerHTML = '<i></i><i></i>';
        display.appendChild(sep);
      }
      const wrap = document.createElement('div');
      wrap.className = 'group';
      wrap.dataset.key = g.key;
      const up = document.createElement('button'); up.className = 'nudge up'; up.textContent = '▲'; up.title = `Add ${g.label.toLowerCase()}`;
      const down = document.createElement('button'); down.className = 'nudge down'; down.textContent = '▼'; down.title = `Remove ${g.label.toLowerCase()}`;
      const flapsEl = document.createElement('div'); flapsEl.className = 'flaps';
      const flaps = g.drums.map((d) => { const f = new Flap(d); flapsEl.appendChild(f.el); return f; });
      const label = document.createElement('div'); label.className = 'group-label'; label.textContent = g.label;
      wrap.append(up, flapsEl, down, label);
      display.appendChild(wrap);
      groups.push({ ...g, flaps });

      if (g.step) {
        bindRepeat(up, () => nudge(g.step));
        bindRepeat(down, () => nudge(-g.step));
        wrap.addEventListener('wheel', (e) => {
          if (state.status === 'running' || S.mode !== 'timer') return;
          e.preventDefault();
          nudge(e.deltaY < 0 ? g.step : -g.step);
        }, { passive: false });
      }
    });
  }

  function render(totalSec) {
    totalSec = Math.max(0, totalSec);
    let parts;
    if (S.mode === 'date') {
      const d = Math.min(999, Math.floor(totalSec / 86400));
      const h = Math.floor((totalSec % 86400) / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      parts = { d: pad(d, 3), h: pad(h, 2), m: pad(m, 2), s: pad(s, 2) };
    } else {
      const h = Math.min(99, Math.floor(totalSec / 3600));
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      parts = { h: pad(h, 2), m: pad(m, 2), s: pad(s, 2) };
    }
    groups.forEach((g) => g.flaps.forEach((f, i) => f.set(parts[g.key][i])));
    return parts;
  }

  function bindRepeat(btn, fn) {
    let t1, t2;
    const stop = () => { clearTimeout(t1); clearInterval(t2); };
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      Snd.init();
      fn();
      t1 = setTimeout(() => { t2 = setInterval(fn, 110); }, 420);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, stop));
  }

  /* ---------------------------------------------------------
     Timer state machine
     --------------------------------------------------------- */
  const MAX_TIMER = 99 * 3600 + 59 * 60 + 59;
  const state = {
    status: 'idle',          // idle | running | paused | done
    endAt: 0,                // epoch ms when running
    remainingMs: S.duration * 1000,
    lastSec: null,
    startedSec: null,
  };

  const saveState = () => {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({
        status: state.status, endAt: state.endAt, remainingMs: state.remainingMs, mode: S.mode,
      }));
    } catch {}
  };

  const targetMs = () => (S.target ? new Date(S.target).getTime() : NaN);

  function currentRemainingMs() {
    if (state.status === 'running') return state.endAt - Date.now();
    return state.remainingMs;
  }

  function nudge(deltaSec) {
    if (S.mode !== 'timer' || state.status === 'running') return;
    const cur = Math.ceil(state.remainingMs / 1000);
    const next = clamp(cur + deltaSec, 0, MAX_TIMER);
    S.duration = next;
    state.remainingMs = next * 1000;
    state.status = 'idle';
    saveSettings(); saveState();
    refresh(true);
  }

  function setDuration(sec) {
    if (S.mode !== 'timer') setMode('timer');
    stopAudio();
    S.duration = clamp(sec, 0, MAX_TIMER);
    state.status = 'idle';
    state.remainingMs = S.duration * 1000;
    saveSettings(); saveState();
    refresh(true);
  }

  function start() {
    Snd.init();
    if (S.mode === 'date') {
      const tm = targetMs();
      if (!isFinite(tm)) { openDrawer(); $('#targetDate').focus(); return; }
      if (tm - Date.now() <= 0) { flashStatus('TARGET PASSED'); return; }
      state.endAt = tm;
    } else {
      if (state.remainingMs <= 0) { flashStatus('SET A TIME'); return; }
      state.endAt = Date.now() + state.remainingMs;
    }
    state.status = 'running';
    state.startedSec = Math.ceil((state.endAt - Date.now()) / 1000);
    Snd.startDrone();
    saveState();
    refresh();
  }

  function pause() {
    state.remainingMs = Math.max(0, state.endAt - Date.now());
    state.status = 'paused';
    stopAudio();
    saveState();
    refresh();
  }

  function reset() {
    stopAudio();
    state.status = 'idle';
    state.remainingMs = S.mode === 'date'
      ? Math.max(0, (targetMs() || Date.now()) - Date.now())
      : S.duration * 1000;
    document.body.classList.remove('critical');
    saveState();
    refresh(true);
  }

  function finish(silent = false) {
    state.status = 'done';
    state.remainingMs = 0;
    render(0);
    saveState();
    Snd.stopDrone(5);
    if (!silent) {
      Snd.doom();
      if (S.shake) {
        const stage = $('#stage');
        stage.classList.remove('shake'); void stage.offsetWidth; stage.classList.add('shake');
        const fl = $('#flash');
        fl.classList.remove('go'); void fl.offsetWidth; fl.classList.add('go');
      }
      // the board shudders through a full revolution and settles back on zero
      setTimeout(() => {
        groups.forEach((g, gi) => g.flaps.forEach((f, i) => setTimeout(() => f.spin(), (gi * 2 + i) * 90)));
      }, 2900);
    }
    refresh();
  }

  function stopAudio() { Snd.stopDrone(); }

  function toggle() {
    if (state.status === 'running') pause();
    else if (state.status === 'done') { reset(); }
    else start();
  }

  // Main loop
  function tick() {
    if (state.status === 'running') {
      const ms = state.endAt - Date.now();
      if (ms <= 0) { finish(); return; }
      const sec = Math.ceil(ms / 1000);
      if (sec !== state.lastSec) onSecond(sec);
    }
  }

  function onSecond(sec) {
    const prev = state.lastSec;
    state.lastSec = sec;
    const parts = render(sec);
    updateTitle(parts);

    const critical = sec <= 10;
    document.body.classList.toggle('critical', critical);
    $('#lampCrit').classList.toggle('on', critical);
    $('#lampCrit').classList.toggle('blink', critical);

    Snd.droneTension(critical ? 1 : sec <= 60 ? 0.45 : 0);
    if (critical && S.heartbeat) Snd.heartbeat();
    else if (S.minuteBoom && sec % 60 === 0 && prev !== null && sec !== state.startedSec) Snd.boom(0.8);

    $('#statusText').textContent = critical ? 'CRITICAL' : 'T-MINUS · LIVE';
  }

  function updateTitle(parts) {
    const txt = S.mode === 'date'
      ? `${parts.d}d ${parts.h}:${parts.m}:${parts.s}`
      : `${parts.h}:${parts.m}:${parts.s}`;
    document.title = `${txt} · ${S.label || 'T-MINUS'}`;
  }

  let statusFlashT;
  function flashStatus(msg) {
    const el = $('#statusText');
    el.textContent = msg;
    clearTimeout(statusFlashT);
    statusFlashT = setTimeout(() => refresh(), 1800);
  }

  // Sync everything visible to the state
  function refresh(rerender = false) {
    const running = state.status === 'running';
    document.body.classList.toggle('running', running);
    document.body.classList.toggle('mode-date', S.mode === 'date');

    const btn = $('#btnStart');
    btn.classList.toggle('live', running);
    $('span', btn).textContent =
      running ? 'PAUSE' :
      state.status === 'paused' ? 'RESUME' :
      state.status === 'done' ? 'AGAIN' :
      (S.mode === 'date' ? 'ARM' : 'START');

    const remMs = currentRemainingMs();
    $('#lampArmed').classList.toggle('on', remMs > 0 || running);
    $('#lampRun').classList.toggle('on', running);
    if (!running) {
      const crit = state.status === 'done';
      $('#lampCrit').classList.toggle('on', crit);
      $('#lampCrit').classList.toggle('blink', crit);
      if (!crit) document.body.classList.remove('critical');
    }

    const st = $('#statusText');
    if (!running) {
      st.textContent = { idle: 'STANDBY', paused: 'HOLD', done: '· ZERO ·' }[state.status];
    } else if (!st.textContent.startsWith('T-MINUS') && st.textContent !== 'CRITICAL') {
      st.textContent = 'T-MINUS · LIVE';
    }

    if (rerender || !running) {
      const sec = Math.max(0, Math.ceil(remMs / 1000));
      state.lastSec = running ? state.lastSec : null;
      updateTitle(render(sec));
    }
  }

  function setMode(mode) {
    if (mode === S.mode) return;
    stopAudio();
    S.mode = mode;
    saveSettings();
    $$('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    $('#dateRow').hidden = mode !== 'date';
    $('#presets').style.display = mode === 'date' ? 'none' : '';
    buildDisplay(mode);
    state.status = 'idle';
    state.remainingMs = mode === 'date'
      ? Math.max(0, (targetMs() || Date.now()) - Date.now())
      : S.duration * 1000;
    saveState();
    refresh(true);
  }

  /* ---------------------------------------------------------
     Wallpapers
     --------------------------------------------------------- */
  const svgNoise = (freq, oct, seed, matrix, size = 400) =>
    `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}'><filter id='f'><feTurbulence type='fractalNoise' baseFrequency='${freq}' numOctaves='${oct}' seed='${seed}' stitchTiles='stitch'/><feColorMatrix values='${matrix}'/></filter><rect width='100%' height='100%' filter='url(%23f)'/></svg>")`;

  const GRIT = svgNoise('.9', 4, 2, '0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 .7 0', 300);
  const LIGHT_GRIT = svgNoise('.65', 3, 9, '0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .18 0', 300);

  const WALLPAPERS = {
    bunker: {
      name: 'Bunker',
      css: `${GRIT}, ${svgNoise('.018', 5, 4, '0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1.6 1.1', 700)}, radial-gradient(ellipse at 50% 25%, #4d504b 0%, #2a2c29 45%, #101110 100%)`,
    },
    rust: {
      name: 'Rust',
      css: `${GRIT}, ${svgNoise('.011', 5, 11, '0 0 0 0 .55  0 0 0 0 .22  0 0 0 0 .06  0 0 0 -2.2 1.3', 800)}, ${svgNoise('.04', 3, 5, '0 0 0 0 .2  0 0 0 0 .08  0 0 0 0 .02  0 0 0 -3 1.6', 500)}, linear-gradient(160deg, #3d3b36, #1d1b18)`,
    },
    doom: {
      name: 'Doom Haze',
      css: `${GRIT}, radial-gradient(ellipse at 50% 55%, rgba(80,200,50,.28) 0%, rgba(30,90,20,.18) 35%, transparent 70%), ${svgNoise('.006 .02', 4, 21, '0 0 0 0 .1  0 0 0 0 .35  0 0 0 0 .08  0 0 0 -1.8 1.1', 900)}, linear-gradient(#070b06, #020302)`,
    },
    wood: {
      name: '90s Den',
      css: `${svgNoise('.003 .3', 3, 8, '0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 .55 0', 500)}, repeating-linear-gradient(90deg, #2a170b 0 3px, #5b3519 3px 72px, #4e2c14 72px 74px, #6a3f1f 74px 150px, #2a170b 150px 153px, #5f3a1b 153px 228px), #3a2210`,
    },
    crt: {
      name: 'Dead Channel',
      css: `${LIGHT_GRIT}, ${GRIT}, radial-gradient(ellipse at center, #26303a 0%, #10161c 55%, #040608 100%)`,
    },
    blood: {
      name: 'Blood Moon',
      css: `${GRIT}, radial-gradient(circle at 72% 22%, #e2643a 0 4.5%, rgba(190,50,25,.55) 5%, rgba(120,20,10,.18) 18%, transparent 38%), radial-gradient(ellipse at 50% 120%, #2a0806, transparent 60%), linear-gradient(#130504, #030101)`,
    },
    grid: {
      name: 'Vector',
      css: `${GRIT}, linear-gradient(rgba(0,0,0,0) 55%, rgba(0,0,0,.85)), repeating-linear-gradient(0deg, rgba(var(--accent-rgb), .16) 0 1px, transparent 1px 46px), repeating-linear-gradient(90deg, rgba(var(--accent-rgb), .16) 0 1px, transparent 1px 46px), radial-gradient(ellipse at 50% 40%, #0e150d, #020302)`,
    },
    cell: {
      name: 'Cell Block',
      css: `${GRIT}, repeating-linear-gradient(0deg, transparent 0 58px, rgba(0,0,0,.55) 58px 62px), repeating-linear-gradient(90deg, transparent 0 118px, rgba(0,0,0,.5) 118px 122px), radial-gradient(ellipse at 50% 10%, #5a5c55, #262723 60%, #0d0d0c)`,
    },
  };

  let customObjectUrl = null;

  async function applyWallpaper() {
    const wp = $('#wallpaper');
    if (S.wallpaper === 'custom-file') {
      const blob = await idb.get('wallpaper');
      if (blob) {
        if (customObjectUrl) URL.revokeObjectURL(customObjectUrl);
        customObjectUrl = URL.createObjectURL(blob);
        wp.style.background = `#000 url(${JSON.stringify(customObjectUrl)}) center / cover no-repeat`;
      } else { S.wallpaper = 'bunker'; return applyWallpaper(); }
    } else if (S.wallpaper === 'custom-url' && S.wallUrl) {
      wp.style.background = `#000 url(${JSON.stringify(S.wallUrl)}) center / cover no-repeat`;
    } else {
      const p = WALLPAPERS[S.wallpaper] || WALLPAPERS.bunker;
      wp.style.background = p.css;
    }
    wp.style.filter = S.wallBlur ? `blur(${S.wallBlur}px)` : '';
    $('#wallpaperDim').style.opacity = S.wallDim / 100;
    $$('.swatch').forEach((s) => s.classList.toggle('on', s.dataset.wp === S.wallpaper));
  }

  function buildSwatches() {
    const box = $('#swatches');
    box.innerHTML = '';
    Object.entries(WALLPAPERS).forEach(([id, p]) => {
      const b = document.createElement('button');
      b.className = 'swatch'; b.dataset.wp = id;
      b.style.background = p.css;
      b.innerHTML = `<span>${p.name}</span>`;
      b.addEventListener('click', () => { S.wallpaper = id; saveSettings(); applyWallpaper(); });
      box.appendChild(b);
    });
    const hasCustom = S.wallpaper === 'custom-file' || (S.wallpaper === 'custom-url' && S.wallUrl);
    if (hasCustom) {
      const b = document.createElement('button');
      b.className = 'swatch'; b.dataset.wp = S.wallpaper;
      b.style.background = $('#wallpaper').style.background;
      b.innerHTML = '<span>Yours</span>';
      b.addEventListener('click', () => applyWallpaper());
      box.appendChild(b);
    }
    $$('.swatch').forEach((s) => s.classList.toggle('on', s.dataset.wp === S.wallpaper));
  }

  /* ---------------------------------------------------------
     Film grain
     --------------------------------------------------------- */
  function startGrain() {
    const c = $('#grain');
    const g = c.getContext('2d');
    c.width = 240; c.height = 135;
    const img = g.createImageData(c.width, c.height);
    let last = 0;
    const frame = (t) => {
      requestAnimationFrame(frame);
      if (t - last < 70 || !S.crt) return;
      last = t;
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const v = (Math.random() * 255) | 0;
        d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
      }
      g.putImageData(img, 0, 0);
    };
    requestAnimationFrame(frame);
  }

  /* ---------------------------------------------------------
     UI wiring
     --------------------------------------------------------- */
  const drawer = $('#drawer');
  const openDrawer = () => { drawer.classList.add('open'); drawer.setAttribute('aria-hidden', 'false'); };
  const closeDrawer = () => { drawer.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true'); };

  function syncMuteBtn() { $('#btnMute').classList.toggle('toggled-off', S.muted); }

  function wire() {
    // unlock audio on first gesture anywhere
    const unlock = () => { Snd.init(); if (state.status === 'running') Snd.startDrone(); };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });

    // tactile key feedback
    document.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.key, .seg button, .swatch')) { Snd.init(); Snd.click(0.45); }
    });

    $('#btnStart').addEventListener('click', toggle);
    $('#btnReset').addEventListener('click', reset);
    $$('[data-preset]').forEach((b) => b.addEventListener('click', () => setDuration(+b.dataset.preset)));

    $('#btnMute').addEventListener('click', () => { S.muted = !S.muted; saveSettings(); Snd.applyVolumes(); syncMuteBtn(); });
    $('#btnFull').addEventListener('click', toggleFull);
    $('#btnSettings').addEventListener('click', () => (drawer.classList.contains('open') ? closeDrawer() : openDrawer()));
    $('#btnCloseSettings').addEventListener('click', closeDrawer);
    document.addEventListener('fullscreenchange', () => document.body.classList.toggle('fullscreen', !!document.fullscreenElement));

    // Editable label
    const label = $('#label');
    label.textContent = S.label;
    label.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); label.blur(); } });
    label.addEventListener('input', () => {
      S.label = label.textContent.replace(/\s+/g, ' ').trim().slice(0, 28).toUpperCase();
      saveSettings();
    });
    label.addEventListener('blur', () => { label.textContent = S.label || 'T-MINUS'; S.label = label.textContent; saveSettings(); });

    // Mode
    $$('#modeSeg button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
    const td = $('#targetDate');
    if (S.target) td.value = S.target;
    td.addEventListener('change', () => {
      S.target = td.value || null;
      saveSettings();
      if (S.mode === 'date') {
        const wasRunning = state.status === 'running';
        reset();
        if (wasRunning) start();
      }
    });

    // Wallpaper
    $('#wallFile').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      await idb.set('wallpaper', f);
      S.wallpaper = 'custom-file';
      saveSettings();
      await applyWallpaper();
      buildSwatches();
      e.target.value = '';
    });
    const wu = $('#wallUrl');
    wu.value = S.wallUrl || '';
    wu.addEventListener('change', async () => {
      const v = wu.value.trim();
      if (!v) return;
      S.wallUrl = v; S.wallpaper = 'custom-url';
      saveSettings(); await applyWallpaper(); buildSwatches();
    });
    const dim = $('#wallDim'), blur = $('#wallBlur');
    dim.value = S.wallDim; blur.value = S.wallBlur;
    dim.addEventListener('input', () => { S.wallDim = +dim.value; saveSettings(); applyWallpaper(); });
    blur.addEventListener('input', () => { S.wallBlur = +blur.value; saveSettings(); applyWallpaper(); });

    // Accent
    $$('#accentSeg button').forEach((b) => {
      b.classList.toggle('on', b.dataset.accent === S.accent);
      b.addEventListener('click', () => {
        S.accent = b.dataset.accent; saveSettings();
        document.body.dataset.accent = S.accent;
        $$('#accentSeg button').forEach((x) => x.classList.toggle('on', x === b));
      });
    });

    // Sound
    [['volMaster', 'volMaster'], ['volClick', 'volClick'], ['volDrone', 'volDrone']].forEach(([id, k]) => {
      const el = $('#' + id);
      el.value = S[k];
      el.addEventListener('input', () => { S[k] = +el.value; saveSettings(); Snd.applyVolumes(); });
    });
    $('#volClick').addEventListener('change', () => { Snd.init(); Snd.click(1); });

    [['optMinuteBoom', 'minuteBoom'], ['optHeartbeat', 'heartbeat'], ['optShake', 'shake'], ['optCrt', 'crt']].forEach(([id, k]) => {
      const el = $('#' + id);
      el.checked = !!S[k];
      el.addEventListener('change', () => {
        S[k] = el.checked; saveSettings();
        document.body.classList.toggle('no-crt', !S.crt);
      });
    });

    $('#tickFile').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      Snd.init();
      const buf = await f.arrayBuffer();
      const ok = await Snd.loadCustom(buf);
      if (ok) {
        await idb.set('tick', { name: f.name, buf });
        $('#tickNote').textContent = `Using your sound: ${f.name}`;
        Snd.click(1);
      } else {
        $('#tickNote').textContent = 'Could not read that audio file. Try a WAV, MP3 or OGG.';
      }
      e.target.value = '';
    });
    $('#tickClear').addEventListener('click', async () => {
      await Snd.loadCustom(null);
      await idb.del('tick');
      $('#tickNote').textContent = 'Using the built-in synthesized flap.';
    });

    // Keyboard
    document.addEventListener('keydown', (e) => {
      if (e.target.closest('input, [contenteditable="true"]')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === ' ') { e.preventDefault(); pressKey('#btnStart'); toggle(); }
      else if (k === 'r') { pressKey('#btnReset'); reset(); }
      else if (k === 'm') { pressKey('#btnMute'); $('#btnMute').click(); }
      else if (k === 'f') { pressKey('#btnFull'); toggleFull(); }
      else if (k === 's') { drawer.classList.contains('open') ? closeDrawer() : openDrawer(); }
      else if (k === 'escape') closeDrawer();
      else if (k === 'arrowup' && S.mode === 'timer') nudge(60);
      else if (k === 'arrowdown' && S.mode === 'timer') nudge(-60);
    });

    // When returning to a hidden tab, flaps catch up instantly instead of replaying
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  }

  function pressKey(sel) {
    const el = $(sel);
    el.classList.add('pressed');
    setTimeout(() => el.classList.remove('pressed'), 110);
    Snd.init(); Snd.click(0.45);
  }

  function toggleFull() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }

  /* ---------------------------------------------------------
     Boot
     --------------------------------------------------------- */
  async function boot() {
    document.body.dataset.accent = S.accent;
    document.body.classList.toggle('no-crt', !S.crt);
    $$('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === S.mode));
    $('#dateRow').hidden = S.mode !== 'date';
    $('#presets').style.display = S.mode === 'date' ? 'none' : '';
    syncMuteBtn();

    buildDisplay(S.mode);
    wire();
    await applyWallpaper();
    buildSwatches();
    startGrain();

    const saved = await idb.get('tick');
    if (saved && saved.buf) {
      await Snd.loadCustom(saved.buf);
      $('#tickNote').textContent = `Using your sound: ${saved.name}`;
    }

    // Restore a timer that was running when the page closed
    const st = readJSON(STATE_KEY);
    if (st && st.mode === S.mode) {
      if (st.status === 'running' && st.endAt > Date.now()) {
        state.status = 'running'; state.endAt = st.endAt;
        state.startedSec = Math.ceil((st.endAt - Date.now()) / 1000);
      } else if (st.status === 'running') {
        state.status = 'done'; state.remainingMs = 0;
      } else if (st.status === 'paused' || st.status === 'done') {
        state.status = st.status; state.remainingMs = st.remainingMs;
      } else {
        state.remainingMs = S.mode === 'date'
          ? Math.max(0, (targetMs() || Date.now()) - Date.now())
          : S.duration * 1000;
      }
    } else if (S.mode === 'date') {
      state.remainingMs = Math.max(0, (targetMs() || Date.now()) - Date.now());
    }

    // Startup: the board spins up from zero to the set time
    setTimeout(() => { refresh(true); }, 350);
    setInterval(tick, 100);
  }

  boot();
})();
