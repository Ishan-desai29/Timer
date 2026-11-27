/* =========================================================
   Flip Timer
   A phone-style timer whose countdown runs on split-flap cards.
   - Real split-flap mechanics: every card steps through its drum
   - The click is synthesized live with the Web Audio API
   ========================================================= */
(() => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const pad = (n, w = 2) => String(n).padStart(w, '0');

  /* ---------------------------------------------------------
     Settings + persistence
     --------------------------------------------------------- */
  const SETTINGS_KEY = 'fliptimer.settings.v1';
  const STATE_KEY = 'fliptimer.state.v1';
  const MAX_SEC = 23 * 3600 + 59 * 60 + 59;

  const DEFAULTS = {
    label: '',
    wallpaper: 'black',
    wallDim: 0,
    wallBlur: 0,
    volClick: 85,
    echo: 55,
    endSound: 'rattle',      // rattle | once | silent
    ignoreSilent: false,
    duration: 300,           // seconds, last value on the wheels
    recents: [60, 300, 600, 1500],
  };

  const readJSON = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
  const S = { ...DEFAULTS, ...(readJSON(SETTINGS_KEY) || {}) };
  const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(S)); } catch {} };

  // IndexedDB for big blobs (wallpaper photo, custom click sound)
  const idb = (() => {
    let dbp;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      const r = indexedDB.open('fliptimer', 1);
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
     Sound: the flap click, with a little room echo
     --------------------------------------------------------- */
  const Snd = (() => {
    let ctx = null, clickBus, verbSend, echoSend, noise;
    let customBuf = null, pendingCustom = null;
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
      applySession();
      ctx = new AC();

      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -12; comp.ratio.value = 5; comp.attack.value = 0.003; comp.release.value = 0.25;
      comp.connect(ctx.destination);

      clickBus = ctx.createGain();
      clickBus.connect(comp);

      // Room
      const verb = ctx.createConvolver();
      verb.buffer = makeIR(2.4, 3);
      verbSend = ctx.createGain();
      clickBus.connect(verbSend).connect(verb).connect(comp);

      // Echo: soft slapback, darker on every repeat
      const delay = ctx.createDelay(1);
      delay.delayTime.value = 0.13;
      const fb = ctx.createGain(); fb.gain.value = 0.28;
      const tone = ctx.createBiquadFilter(); tone.type = 'lowpass'; tone.frequency.value = 2600;
      echoSend = ctx.createGain();
      clickBus.connect(echoSend).connect(delay);
      delay.connect(tone).connect(fb).connect(delay);
      tone.connect(comp);

      noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const nd = noise.getChannelData(0);
      for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

      applyVolumes();
      if (pendingCustom) { const p = pendingCustom; pendingCustom = null; loadCustom(p); }
    }

    // iPhone: optionally keep playing with the silent switch on
    function applySession() {
      try { if (navigator.audioSession) navigator.audioSession.type = S.ignoreSilent ? 'playback' : 'auto'; } catch {}
    }

    function applyVolumes() {
      applySession();
      if (!ctx) return;
      const t = ctx.currentTime, e = S.echo / 100;
      clickBus.gain.setTargetAtTime(S.volClick / 100, t, 0.05);
      verbSend.gain.setTargetAtTime(e * 0.9, t, 0.05);
      echoSend.gain.setTargetAtTime(e * 0.45, t, 0.05);
    }

    function env(g, t, peak, attack, release) {
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + attack + release);
    }

    function burst(t, { type = 'bandpass', f, q = 1, dur, gain }) {
      const s = ctx.createBufferSource();
      s.buffer = noise;
      const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(gain, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(fl).connect(g).connect(clickBus);
      s.start(t, Math.random() * 1.8, dur + 0.05);
    }

    // One flap slapping down: release tick + card slap + body thunk
    function click(intensity = 1) {
      if (!ctx || ctx.state !== 'running' || S.volClick === 0) return;
      const now = ctx.currentTime;
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

    async function loadCustom(arrayBuffer) {
      if (!arrayBuffer) { customBuf = null; return true; }
      if (!ctx) { pendingCustom = arrayBuffer; return true; }
      try { customBuf = await ctx.decodeAudioData(arrayBuffer.slice(0)); return true; }
      catch { customBuf = null; return false; }
    }

    return { init, click, applyVolumes, loadCustom };
  })();

  /* ---------------------------------------------------------
     Split-flap card
     Each card sits on a drum it can only turn forward through.
     Drums run downward, so a countdown is one flip per tick.
     --------------------------------------------------------- */
  const FAST = 72;
  const NORMAL = 300;

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
        if (document.hidden) { this.snap(); continue; }
        await this.flipTo(nxt, left > 1 ? FAST + Math.random() * 18 : NORMAL);
      }
      this.busy = false;
    }

    snap() {
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

        const clackAt = half + fall * 0.62;
        const loud = dur >= NORMAL ? 1 : 0.62;
        const tid = setTimeout(() => Snd.click(loud), clackAt);

        let finished = false;
        const done = () => {
          if (finished) return; finished = true;
          clearTimeout(tid);
          this.bot.textContent = nxt;
          this.cur = nxt;
          this.el.classList.toggle('flipping', false);
          anims.forEach((a) => a.cancel());
          resolve();
        };
        anims[1].finished.then(done, done);
        setTimeout(done, dur + 120); // safety net for throttled tabs
      });
    }
  }

  /* ---------------------------------------------------------
     Flap display (lives inside the ring)
     --------------------------------------------------------- */
  const DIG = '9876543210';
  const SIX = '543210';
  const TWO = '210';

  const display = $('#display');
  const dial = $('#dial');
  let groups = [];
  let hasHours = false;

  function buildDisplay(withHours) {
    hasHours = withHours;
    display.innerHTML = '';
    groups = [];
    const layout = withHours
      ? [['h', [TWO, DIG]], ['m', [SIX, DIG]], ['s', [SIX, DIG]]]
      : [['m', [SIX, DIG]], ['s', [SIX, DIG]]];
    layout.forEach(([key, drums], i) => {
      if (i) {
        const c = document.createElement('div');
        c.className = 'colon'; c.textContent = ':';
        display.appendChild(c);
      }
      const g = document.createElement('div');
      g.className = 'fgroup';
      const flaps = drums.map((d) => { const f = new Flap(d); g.appendChild(f.el); return f; });
      display.appendChild(g);
      groups.push({ key, flaps });
    });
    sizeDisplay();
  }

  function sizeDisplay() {
    const size = dial.clientWidth || 340;
    const cards = hasHours ? 6 : 4, colons = hasHours ? 2 : 1;
    const cw = Math.min(hasHours ? 64 : 90, (size * 0.84) / (cards * 1.07 + colons * 0.4));
    display.style.setProperty('--cw', cw.toFixed(1) + 'px');
  }

  function render(sec) {
    sec = clamp(sec, 0, MAX_SEC);
    const parts = {
      h: pad(Math.floor(sec / 3600)),
      m: pad(Math.floor((sec % 3600) / 60)),
      s: pad(sec % 60),
    };
    groups.forEach((g) => g.flaps.forEach((f, i) => f.set(parts[g.key][i])));
  }

  /* ---------------------------------------------------------
     Formatting
     --------------------------------------------------------- */
  function clockText(sec) {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }
  function wordsText(sec) {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const out = [];
    if (h) out.push(`${h} hr`);
    if (m) out.push(`${m} min`);
    if (s) out.push(`${s} sec`);
    return out.join(', ') || '0 sec';
  }
  const timeOfDay = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  /* ---------------------------------------------------------
     Scroll wheels (set the time)
     --------------------------------------------------------- */
  class Wheel {
    constructor(el, onChange) {
      this.el = el;
      this.unit = el.dataset.unit;
      this.max = +el.dataset.max;
      this.label = el.dataset.label;
      this.value = 0;
      this.silent = true;
      this.onChange = onChange;
      const items = Array.from({ length: this.max + 1 }, (_, i) => `<div class="wheel-item" data-i="${i}">${i}</div>`).join('');
      el.innerHTML = `<div class="wheel-scroll"><div class="wheel-pad"></div>${items}<div class="wheel-pad"></div></div><span class="wheel-unit"></span>`;
      this.sc = $('.wheel-scroll', el);
      this.unitEl = $('.wheel-unit', el);
      this.items = $$('.wheel-item', el);
      this.sc.addEventListener('scroll', () => {
        if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.paint(); });
      }, { passive: true });
      this.sc.addEventListener('click', (e) => {
        const it = e.target.closest('.wheel-item');
        if (it) this.sc.scrollTo({ top: +it.dataset.i * this.ih(), behavior: 'smooth' });
      });
      this.setUnit();
    }
    ih() { return this.items[0].offsetHeight || 36; }
    setUnit() {
      this.unitEl.textContent = this.unit === 'h' ? (this.value === 1 ? 'hour' : 'hours') : this.label;
    }
    paint() {
      const c = this.sc.scrollTop / this.ih();
      const idx = clamp(Math.round(c), 0, this.max);
      if (idx !== this.value) {
        this.value = idx;
        this.setUnit();
        if (!this.silent) { Snd.click(0.4); this.onChange(); }
      }
      const lo = Math.max(0, Math.floor(c) - 5), hi = Math.min(this.max, Math.ceil(c) + 5);
      if (this.lo !== undefined) {
        for (let i = this.lo; i <= this.hi; i++) {
          if (i >= lo && i <= hi) continue;
          this.items[i].style.transform = ''; this.items[i].style.opacity = '';
        }
      }
      for (let i = lo; i <= hi; i++) {
        const d = i - c, it = this.items[i];
        it.style.transform = `perspective(420px) rotateX(${(-d * 17).toFixed(1)}deg)`;
        it.style.opacity = Math.max(0.15, 1 - Math.abs(d) * 0.2).toFixed(2);
      }
      this.lo = lo; this.hi = hi;
    }
    set(v) {
      this.silent = true;
      this.value = v;
      this.setUnit();
      this.sc.scrollTop = v * this.ih();
      this.paint();
      setTimeout(() => { this.silent = false; }, 80);
    }
  }

  let wheels = [];
  let wheelSaveT;
  function wheelTotal() {
    const v = { h: 0, m: 0, s: 0 };
    wheels.forEach((w) => { v[w.unit] = w.value; });
    return v.h * 3600 + v.m * 60 + v.s;
  }
  function setWheels(sec) {
    const v = { h: Math.floor(sec / 3600), m: Math.floor((sec % 3600) / 60), s: sec % 60 };
    requestAnimationFrame(() => { wheels.forEach((w) => w.set(v[w.unit])); refresh(); });
  }
  function onWheelChange() {
    S.duration = wheelTotal();
    refresh();
    clearTimeout(wheelSaveT);
    wheelSaveT = setTimeout(saveSettings, 300);
  }

  /* ---------------------------------------------------------
     Timer state machine
     --------------------------------------------------------- */
  const state = {
    status: 'idle',   // idle | running | paused | done
    endAt: 0,
    remainingMs: 0,
    totalMs: 0,
    lastSec: null,
  };

  const saveState = () => {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({
        status: state.status, endAt: state.endAt, remainingMs: state.remainingMs, totalMs: state.totalMs,
      }));
    } catch {}
  };

  function startFresh(sec) {
    if (sec <= 0) return;
    Snd.init();
    stopAlarm();
    S.duration = sec;
    addRecent(sec);
    state.totalMs = sec * 1000;
    state.remainingMs = state.totalMs;
    state.endAt = Date.now() + state.totalMs;
    state.status = 'running';
    state.lastSec = null;
    showFace();
    buildDisplay(sec >= 3600);
    keepAwake(true);
    saveState();
    refresh();
    tick();
  }

  function resume() {
    Snd.init();
    state.endAt = Date.now() + state.remainingMs;
    state.status = 'running';
    keepAwake(true);
    saveState();
    refresh();
  }

  function pause() {
    state.remainingMs = Math.max(0, state.endAt - Date.now());
    state.status = 'paused';
    keepAwake(false);
    saveState();
    refresh();
  }

  function cancel() {
    stopAlarm();
    state.status = 'idle';
    state.lastSec = null;
    keepAwake(false);
    showFace();
    setWheels(S.duration);
    saveState();
    refresh();
  }

  function finish() {
    state.status = 'done';
    state.remainingMs = 0;
    render(0);
    keepAwake(false);
    saveState();
    refresh();
    showAlarm();
  }

  function primary() {
    if (state.status === 'running') pause();
    else if (state.status === 'paused') resume();
    else startFresh(wheelTotal());
  }

  // Main loop
  function tick() {
    if (state.status !== 'running') return;
    const ms = state.endAt - Date.now();
    if (ms <= 0) { finish(); return; }
    const sec = Math.ceil(ms / 1000);
    if (sec !== state.lastSec) {
      state.lastSec = sec;
      render(sec);
      document.title = `${clockText(sec)} · ${S.label || 'Timer'}`;
    }
  }

  // Ring: drains smoothly every frame
  const ring = $('#ringProg');
  const C = 2 * Math.PI * 96;
  ring.style.strokeDasharray = C.toFixed(2);
  function frame() {
    requestAnimationFrame(frame);
    if (dial.hidden || !state.totalMs) return;
    const rem = state.status === 'running' ? Math.max(0, state.endAt - Date.now()) : state.remainingMs;
    ring.style.strokeDashoffset = (C * (1 - rem / state.totalMs)).toFixed(2);
  }

  /* ---------------------------------------------------------
     When the timer ends
     --------------------------------------------------------- */
  let alarmT = null, alarmCount = 0;
  function rattle() {
    groups.forEach((g, gi) => g.flaps.forEach((f, i) => setTimeout(() => f.spin(), (gi * 2 + i) * 70)));
  }
  function showAlarm() {
    $('#alertTitle').textContent = S.label || 'Timer';
    $('#alert').hidden = false;
    $('#alertStop').focus({ preventScroll: true });
    document.title = `Done · ${S.label || 'Timer'}`;
    try { navigator.vibrate?.([400, 150, 400, 150, 800]); } catch {}
    if (S.endSound === 'silent') return;
    rattle();
    if (S.endSound === 'rattle') {
      alarmCount = 0;
      alarmT = setInterval(() => {
        if (++alarmCount > 20 || state.status !== 'done') { stopAlarm(); return; }
        rattle();
      }, 2400);
    }
  }
  function stopAlarm() {
    clearInterval(alarmT); alarmT = null;
    $('#alert').hidden = true;
  }

  // Keep the phone screen on while the timer runs
  let wakeLock = null;
  async function keepAwake(on) {
    try {
      if (on && !wakeLock && navigator.wakeLock && !document.hidden) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!on && wakeLock) {
        const w = wakeLock; wakeLock = null; await w.release();
      }
    } catch { wakeLock = null; }
  }

  /* ---------------------------------------------------------
     View sync
     --------------------------------------------------------- */
  function showFace() {
    const idle = state.status === 'idle';
    $('#picker').hidden = !idle;
    dial.hidden = idle;
  }

  function refresh() {
    const st = state.status;
    document.body.classList.toggle('running', st === 'running');
    document.body.classList.toggle('paused', st === 'paused');

    const btn = $('#btnStart');
    const label = st === 'running' ? 'Pause' : st === 'paused' ? 'Resume' : 'Start';
    $('span', btn).textContent = label;
    btn.classList.toggle('pause', st === 'running');
    btn.classList.toggle('start', st !== 'running');
    btn.disabled = st === 'idle' && wheelTotal() === 0;
    $('#btnCancel').disabled = st === 'idle';

    $('#dialLabel').textContent = S.label;
    updateEndTime();

    if (st === 'idle') document.title = S.label || 'Timer';
    if (st === 'paused') {
      const sec = Math.ceil(state.remainingMs / 1000);
      render(sec);
      document.title = `${clockText(sec)} · Paused`;
    }
  }

  let lastEndText = '';
  function updateEndTime() {
    let ms = null;
    if (state.status === 'running') ms = state.endAt;
    else if (state.status === 'paused') ms = Date.now() + state.remainingMs;
    const txt = ms ? timeOfDay(ms) : '';
    if (txt !== lastEndText) { $('#endTime').textContent = txt; lastEndText = txt; }
    $('#dialEnd').style.visibility = ms ? 'visible' : 'hidden';
  }

  /* ---------------------------------------------------------
     Recents
     --------------------------------------------------------- */
  function addRecent(sec) {
    S.recents = [sec, ...S.recents.filter((x) => x !== sec)].slice(0, 6);
    saveSettings();
    renderRecents();
  }
  function renderRecents() {
    const box = $('#recents');
    box.innerHTML = S.recents.map((sec) => {
      const n = Number(sec) | 0;
      return `<div class="recent" data-sec="${n}">
        <div><div class="t">${clockText(n)}</div><div class="s">${wordsText(n)}</div></div>
        <button class="play" data-sec="${n}" aria-label="Start ${wordsText(n)}"><svg viewBox="0 0 24 24"><path d="M7 4.5v15l12.5-7.5z"/></svg></button>
      </div>`;
    }).join('');
  }

  /* ---------------------------------------------------------
     Wallpapers
     --------------------------------------------------------- */
  const WALLS = {
    black:    '#000',
    graphite: 'linear-gradient(180deg, #2c2c2f 0%, #111113 55%, #000 100%)',
    midnight: 'radial-gradient(120% 80% at 50% 0%, #1a3a6e 0%, #0a1830 45%, #000 85%)',
    aurora:   'radial-gradient(60% 45% at 15% 10%, rgba(94,92,230,.6), transparent 70%), radial-gradient(55% 45% at 90% 35%, rgba(48,209,88,.35), transparent 70%), radial-gradient(70% 55% at 50% 100%, rgba(10,132,255,.4), transparent 70%), #000',
    sunset:   'radial-gradient(90% 60% at 50% 0%, rgba(255,159,10,.6), transparent 65%), radial-gradient(80% 60% at 0% 60%, rgba(255,55,95,.45), transparent 70%), #0a0406',
    forest:   'radial-gradient(110% 70% at 50% 0%, #135a3c, #06200f 55%, #000 90%)',
  };
  let photoUrl = null;

  async function applyWallpaper() {
    const wp = $('#wallpaper');
    if (S.wallpaper === 'photo') {
      const blob = await idb.get('wallpaper');
      if (blob) {
        if (photoUrl) URL.revokeObjectURL(photoUrl);
        photoUrl = URL.createObjectURL(blob);
        wp.style.background = `#000 url(${JSON.stringify(photoUrl)}) center / cover no-repeat`;
      } else { S.wallpaper = 'black'; return applyWallpaper(); }
    } else {
      wp.style.background = WALLS[S.wallpaper] || WALLS.black;
    }
    wp.style.filter = S.wallBlur ? `blur(${S.wallBlur}px)` : '';
    $('#wallDim').style.opacity = S.wallDim / 100;
    renderSwatches();
  }

  function renderSwatches() {
    const box = $('#swatches');
    box.innerHTML = '';
    const add = (id, bg, name) => {
      const b = document.createElement('button');
      b.className = 'swatch' + (S.wallpaper === id ? ' on' : '');
      b.style.background = bg;
      b.setAttribute('aria-label', name);
      b.addEventListener('click', () => { S.wallpaper = id; saveSettings(); applyWallpaper(); });
      box.appendChild(b);
    };
    Object.entries(WALLS).forEach(([id, bg]) => add(id, bg, id[0].toUpperCase() + id.slice(1)));
    if (photoUrl) add('photo', `#000 url(${JSON.stringify(photoUrl)}) center / cover`, 'Your photo');
  }

  /* ---------------------------------------------------------
     Wiring
     --------------------------------------------------------- */
  function setFill(el) {
    const p = ((el.value - el.min) / (el.max - el.min)) * 100;
    el.style.setProperty('--p', p + '%');
  }

  function wire() {
    const unlock = () => { Snd.init(); if (state.status === 'running') keepAwake(true); };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });

    $('#btnStart').addEventListener('click', primary);
    $('#btnCancel').addEventListener('click', cancel);
    $('#alertStop').addEventListener('click', cancel);
    $('#alertRepeat').addEventListener('click', () => { const d = S.duration; cancel(); startFresh(d); });

    // Recents: play button starts it, tapping the row loads it onto the wheels
    $('#recents').addEventListener('click', (e) => {
      const row = e.target.closest('.recent');
      if (!row) return;
      const sec = +row.dataset.sec;
      if (e.target.closest('.play')) { cancelSilently(); startFresh(sec); return; }
      if (state.status === 'idle') { S.duration = sec; saveSettings(); setWheels(sec); refresh(); }
    });

    // Label
    const label = $('#label');
    label.value = S.label;
    label.addEventListener('input', () => { S.label = label.value.trim().slice(0, 28); saveSettings(); refresh(); });
    label.addEventListener('keydown', (e) => { if (e.key === 'Enter') label.blur(); });

    // When timer ends
    const endSel = $('#endSound');
    endSel.value = S.endSound;
    endSel.addEventListener('change', () => { S.endSound = endSel.value; saveSettings(); });

    // Sliders
    [['volClick', 'volClick', true], ['echo', 'echo', true], ['wallDimRange', 'wallDim'], ['wallBlur', 'wallBlur']].forEach(([id, k, sound]) => {
      const el = $('#' + id);
      el.value = S[k];
      setFill(el);
      el.addEventListener('input', () => {
        S[k] = +el.value;
        setFill(el);
        saveSettings();
        if (sound) Snd.applyVolumes(); else applyWallpaper();
      });
      if (sound) el.addEventListener('change', () => { Snd.init(); Snd.click(1); });
    });

    // Silent switch (only where the browser supports it)
    $('#silentRow').hidden = !('audioSession' in navigator);
    const sil = $('#optSilent');
    sil.checked = !!S.ignoreSilent;
    sil.addEventListener('change', () => { S.ignoreSilent = sil.checked; saveSettings(); Snd.applyVolumes(); });

    // Custom click sound
    $('#tickFile').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      Snd.init();
      const buf = await f.arrayBuffer();
      if (await Snd.loadCustom(buf)) {
        await idb.set('tick', { name: f.name, buf });
        setTickNote(f.name);
        Snd.click(1);
      } else {
        $('#tickNote').textContent = "Couldn't read that file";
      }
      e.target.value = '';
    });
    $('#tickClear').addEventListener('click', async () => {
      await Snd.loadCustom(null);
      await idb.del('tick');
      setTickNote(null);
    });

    // Wallpaper photo
    $('#wallFile').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      await idb.set('wallpaper', f);
      S.wallpaper = 'photo';
      saveSettings();
      await applyWallpaper();
      e.target.value = '';
    });

    // Light tactile click on the round buttons
    document.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.round, .play, .alert-actions button')) { Snd.init(); Snd.click(0.35); }
    });

    // Keyboard
    document.addEventListener('keydown', (e) => {
      if (e.target.closest('input, select, textarea')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!$('#alert').hidden) {
        if (e.key === 'Enter' || e.key === 'Escape' || e.key === ' ') { e.preventDefault(); cancel(); }
        return;
      }
      if (e.key === ' ') { e.preventDefault(); if (!$('#btnStart').disabled) primary(); }
      else if (e.key === 'Escape' || e.key.toLowerCase() === 'r') { if (state.status !== 'idle') cancel(); }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      tick();
      if (state.status === 'running') keepAwake(true);
    });
    window.addEventListener('resize', sizeDisplay);
  }

  function cancelSilently() {
    if (state.status !== 'idle') { stopAlarm(); state.status = 'idle'; }
  }

  function setTickNote(name) {
    $('#tickNote').textContent = name || 'Built-in';
    $('#tickClear').hidden = !name;
  }

  /* ---------------------------------------------------------
     Boot
     --------------------------------------------------------- */
  async function boot() {
    S.duration = clamp(S.duration | 0, 0, MAX_SEC);
    wheels = $$('#picker .wheel').map((el) => new Wheel(el, onWheelChange));
    wire();
    renderRecents();

    const savedPhoto = S.wallpaper === 'photo' ? await idb.get('wallpaper') : null;
    if (savedPhoto) photoUrl = URL.createObjectURL(savedPhoto);
    await applyWallpaper();

    const tick0 = await idb.get('tick');
    if (tick0 && tick0.buf) { await Snd.loadCustom(tick0.buf); setTickNote(tick0.name); }

    // Pick up a timer that was running or paused when the app closed
    const st = readJSON(STATE_KEY);
    if (st && st.totalMs > 0 && (st.status === 'running' || st.status === 'paused')) {
      if (st.status === 'running' && st.endAt > Date.now()) {
        Object.assign(state, { status: 'running', endAt: st.endAt, totalMs: st.totalMs });
      } else if (st.status === 'paused') {
        Object.assign(state, { status: 'paused', remainingMs: st.remainingMs, totalMs: st.totalMs });
      }
    }

    showFace();
    if (state.status === 'idle') {
      setWheels(S.duration);
    } else {
      buildDisplay(state.totalMs >= 3600 * 1000);
      // the cards roll up from zero to where the timer is
      setTimeout(() => { tick(); refresh(); }, 300);
    }
    refresh();
    requestAnimationFrame(frame);
    setInterval(() => { tick(); if (state.status === 'paused') updateEndTime(); }, 100);

    // Installable app: cache everything so it runs offline
    try {
      if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
        navigator.serviceWorker.register('sw.js').catch(() => {});
      }
    } catch {}
  }

  boot();
})();
