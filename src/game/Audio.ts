// All sound is synthesized: crunchy snow, whooshes, splats, chimes. No audio files to load.
export class Audio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private noise!: AudioBuffer;
  private plowGain: GainNode | null = null;
  private plowFilter: BiquadFilterNode | null = null;
  private rumbleGain: GainNode | null = null;
  private windGain: GainNode | null = null;
  private engine: { gain: GainNode; osc: OscillatorNode; sub: OscillatorNode; filter: BiquadFilterNode; lfo: OscillatorNode } | null = null;
  listener = { x: 0, y: 0, z: 0, yaw: 0 };
  volume = 0.7;
  muted = false;

  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = (window.AudioContext || (window as any).webkitAudioContext);
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);
    const len = this.ctx.sampleRate * 2;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    // looping beds: plow crunch, big-ball rumble, wind
    this.plowGain = this.loopNoise(1800, 0.9, 'bandpass');
    this.plowFilter = (this.plowGain as any)._filter;
    this.rumbleGain = this.loopNoise(140, 0.7, 'lowpass');
    this.windGain = this.loopNoise(500, 0.4, 'lowpass');
    this.windGain.gain.value = 0.05;
    {
      // the engine: a buzzy saw over a low square, chopped by a fast tremolo so it putters
      const ctx = this.ctx;
      const osc = ctx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = 70;
      const sub = ctx.createOscillator(); sub.type = 'square'; sub.frequency.value = 35;
      const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 500; filter.Q.value = 1.2;
      const trem = ctx.createGain(); trem.gain.value = 0.7;
      const lfo = ctx.createOscillator(); lfo.type = 'sawtooth'; lfo.frequency.value = 22;
      const depth = ctx.createGain(); depth.gain.value = 0.3;
      lfo.connect(depth); depth.connect(trem.gain);
      const gain = ctx.createGain(); gain.gain.value = 0;
      const subGain = ctx.createGain(); subGain.gain.value = 0.6;
      osc.connect(filter); sub.connect(subGain); subGain.connect(filter); filter.connect(trem); trem.connect(gain); gain.connect(this.master);
      osc.start(); sub.start(); lfo.start();
      this.engine = { gain, osc, sub, filter, lfo };
    }
  }

  setMuted(m: boolean) { this.muted = m; if (this.master) this.master.gain.value = m ? 0 : this.volume; }

  private loopNoise(freq: number, q: number, type: BiquadFilterType) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain(); g.gain.value = 0;
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start();
    (g as any)._filter = f;
    return g;
  }

  /** distance attenuation + stereo pan relative to the listener */
  private spatial(x?: number, y?: number, z?: number) {
    if (x === undefined || y === undefined || z === undefined) return { gain: 1, pan: 0 };
    const dx = x - this.listener.x, dz = z - this.listener.z, dy = y - this.listener.y;
    const d = Math.hypot(dx, dy, dz);
    const gain = 1 / (1 + d * d * 0.012);
    const rx = Math.cos(this.listener.yaw), rz = -Math.sin(this.listener.yaw);
    const pan = d > 0.5 ? Math.max(-1, Math.min(1, (dx * rx + dz * rz) / d)) * 0.8 : 0;
    return { gain, pan };
  }

  private out(gain: number, pan: number) {
    const ctx = this.ctx!;
    const g = ctx.createGain(); g.gain.value = gain;
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    g.connect(p); p.connect(this.master);
    return g;
  }

  private noiseBurst(dur: number, freq: number, q: number, vol: number, type: BiquadFilterType = 'bandpass', sweepTo?: number, x?: number, y?: number, z?: number) {
    if (!this.ctx || this.muted) return;
    const sp = this.spatial(x, y, z);
    if (sp.gain * vol < 0.004) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.008); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.out(sp.gain, sp.pan));
    src.start(t, Math.random() * 1.5); src.stop(t + dur + 0.05);
  }

  private tone(freq: number, dur: number, vol: number, type: OscillatorType = 'sine', slideTo?: number, delay = 0, x?: number, y?: number, z?: number) {
    if (!this.ctx || this.muted) return;
    const sp = this.spatial(x, y, z);
    if (sp.gain * vol < 0.004) return;
    const ctx = this.ctx, t = ctx.currentTime + delay;
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.out(sp.gain, sp.pan));
    o.start(t); o.stop(t + dur + 0.05);
  }

  crunch(x?: number, y?: number, z?: number, vol = 0.25) { this.noiseBurst(0.07 + Math.random() * 0.05, 1500 + Math.random() * 1500, 1.2, vol, 'bandpass', undefined, x, y, z); }
  step(x: number, y: number, z: number) { this.noiseBurst(0.05, 2400 + Math.random() * 800, 1.5, 0.08, 'bandpass', undefined, x, y, z); }
  pat(x: number, y: number, z: number) { this.noiseBurst(0.05, 900 + Math.random() * 400, 2, 0.18, 'bandpass', undefined, x, y, z); }
  packDone(x: number, y: number, z: number) { this.noiseBurst(0.08, 700, 2, 0.3, 'bandpass', undefined, x, y, z); this.tone(660, 0.12, 0.08, 'triangle', 880, 0.04, x, y, z); }
  whoosh(x: number, y: number, z: number, power: number) { this.noiseBurst(0.18 + power * 0.1, 500, 1.5, 0.22 + power * 0.1, 'bandpass', 2200, x, y, z); }
  splatSnow(x: number, y: number, z: number) { this.noiseBurst(0.12, 900, 0.9, 0.35, 'lowpass', 300, x, y, z); }
  hit(x: number, y: number, z: number) {
    this.noiseBurst(0.14, 1200, 0.8, 0.5, 'lowpass', 400, x, y, z);
    this.tone(180, 0.15, 0.25, 'sine', 70, 0, x, y, z);
    this.tone(900 + Math.random() * 200, 0.12, 0.07, 'square', 500, 0.03, x, y, z); // squawk
  }
  splat(x: number, y: number, z: number) {
    this.noiseBurst(0.35, 1500, 0.6, 0.7, 'lowpass', 200, x, y, z);
    this.tone(140, 0.35, 0.4, 'sine', 45, 0, x, y, z);
    this.tone(700, 0.25, 0.1, 'square', 250, 0.05, x, y, z);
  }
  hitMarker() { this.tone(1500, 0.06, 0.12, 'triangle', 1900); }
  jump(x: number, y: number, z: number) { this.tone(420, 0.12, 0.08, 'sine', 700, 0, x, y, z); }
  slide(x: number, y: number, z: number) { this.noiseBurst(0.4, 3000, 1, 0.15, 'highpass', 1200, x, y, z); this.tone(500, 0.18, 0.08, 'sine', 300, 0, x, y, z); }
  crush(x: number, y: number, z: number, vol: number) { this.noiseBurst(0.3, 400, 0.7, Math.min(0.9, vol), 'lowpass', 120, x, y, z); }
  flake(x: number, y: number, z: number) { [880, 1175, 1568, 2093].forEach((f, i) => this.tone(f, 0.35, 0.12, 'triangle', undefined, i * 0.07, x, y, z)); }
  grab() { this.tone(520, 0.08, 0.12, 'triangle', 780); this.tone(780, 0.1, 0.1, 'triangle', 1040, 0.06); }
  stash() { [700, 600, 500].forEach((f, i) => this.tone(f, 0.08, 0.1, 'triangle', undefined, i * 0.05)); }
  click() { this.tone(900, 0.05, 0.08, 'triangle', 1200); }
  /** the Hot Chocolate Blaster: a wet hiss per squirt */
  cocoaSpray(x: number, y: number, z: number) { this.noiseBurst(0.11, 2600 + Math.random() * 700, 0.7, 0.13, 'bandpass', 1300, x, y, z); }
  /** the Freeze Soaker: a pump-squirt, then a glassy tick */
  waterShot(x: number, y: number, z: number) { this.noiseBurst(0.13, 900, 1.4, 0.3, 'bandpass', 3200, x, y, z); this.tone(1250, 0.08, 0.05, 'sine', 1900, 0.02, x, y, z); }
  /** soaked: crackling ice */
  freeze(x: number, y: number, z: number) { this.noiseBurst(0.16, 5200, 3, 0.2, 'bandpass', 7400, x, y, z); [2637, 3136].forEach((f, i) => this.tone(f, 0.16, 0.06, 'triangle', undefined, i * 0.04, x, y, z)); }
  /** feet out from under you on an ice patch */
  slip(x: number, y: number, z: number) { this.tone(880, 0.3, 0.12, 'sine', 300, 0, x, y, z); this.noiseBurst(0.3, 3400, 1, 0.14, 'highpass', 1500, x, y, z); }
  /** one shot of the snow tank's snowball machine gun: a soft pop and a thock */
  tankGun(x: number, y: number, z: number, vol = 1) { this.noiseBurst(0.05, 1300 + Math.random() * 500, 1.6, 0.2 * vol, 'bandpass', 600, x, y, z); this.tone(150 + Math.random() * 40, 0.05, 0.07 * vol, 'square', 90, 0, x, y, z); }
  gunEmpty() { this.tone(330, 0.09, 0.1, 'square', 220); this.tone(220, 0.12, 0.08, 'square', 160, 0.08); }
  /** the Candy Cane Blade: a swish, a crunchy bonk, a ting off a snowball, and the snap when it breaks */
  bladeSwing(x: number, y: number, z: number) { this.noiseBurst(0.17, 1200, 1.1, 0.22, 'bandpass', 4200, x, y, z); }
  bladeHit(x: number, y: number, z: number) { this.tone(190, 0.13, 0.22, 'triangle', 85, 0, x, y, z); this.noiseBurst(0.09, 3200, 1, 0.26, 'highpass', 1300, x, y, z); this.tone(1750, 0.07, 0.07, 'triangle', 2300, 0.01, x, y, z); }
  bladeBlock(x: number, y: number, z: number) { this.tone(2200, 0.11, 0.1, 'triangle', 3100, 0, x, y, z); this.noiseBurst(0.07, 4800, 2, 0.14, 'bandpass', 2600, x, y, z); }
  bladeSnap() { this.noiseBurst(0.06, 2400, 1, 0.3, 'highpass', 900); this.tone(760, 0.14, 0.12, 'triangle', 190, 0.02); }
  noSnow() { this.tone(240, 0.12, 0.08, 'square', 200); }
  whistle() {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sine';
    const lfo = ctx.createOscillator(); lfo.frequency.value = 28;
    const lg = ctx.createGain(); lg.gain.value = 120;
    lfo.connect(lg); lg.connect(o.frequency);
    o.frequency.value = 2300;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.18, t + 0.03);
    g.gain.setValueAtTime(0.18, t + 0.5); g.gain.linearRampToValueAtTime(0, t + 0.7);
    o.connect(g); g.connect(this.master);
    o.start(t); lfo.start(t); o.stop(t + 0.75); lfo.stop(t + 0.75);
  }
  fanfare(win: boolean) {
    const notes = win ? [523, 659, 784, 1047] : [440, 392, 349, 262];
    notes.forEach((f, i) => this.tone(f, 0.4, 0.15, 'triangle', undefined, i * 0.15));
  }
  countdown(final: boolean) { this.tone(final ? 1046 : 523, final ? 0.4 : 0.15, 0.15, 'triangle'); }

  clank(x: number, y: number, z: number, vol = 1) { this.tone(310 + Math.random() * 60, 0.09, 0.14 * vol, 'square', 180, 0, x, y, z); this.noiseBurst(0.07, 2600, 3, 0.2 * vol, 'bandpass', undefined, x, y, z); }
  engineStart(x: number, y: number, z: number, heavy: boolean) {
    const f = heavy ? 55 : 90;
    this.tone(f, 0.35, 0.16, 'sawtooth', f * 2.2, 0, x, y, z);
    this.noiseBurst(0.3, 300, 0.8, 0.2, 'lowpass', 900, x, y, z);
  }

  /** The nearest running engine. level 0..1 (how loud from here), revs 0..1 and a bit over, heavy = the snowplow's diesel. */
  setEngine(level: number, revs: number, heavy: number) {
    const e = this.engine;
    if (!e || !this.ctx) return;
    const t = this.ctx.currentTime;
    e.gain.gain.setTargetAtTime(this.muted ? 0 : Math.min(0.16, level * 0.16), t, 0.08);
    if (level <= 0.001) return;
    const base = heavy ? 42 : 62, f = base * (1 + revs * (heavy ? 0.9 : 1.7));
    e.osc.frequency.setTargetAtTime(f, t, 0.08);
    e.sub.frequency.setTargetAtTime(f / 2, t, 0.08);
    e.lfo.frequency.setTargetAtTime(heavy ? 13 + revs * 10 : 20 + revs * 30, t, 0.08);
    e.filter.frequency.setTargetAtTime((heavy ? 320 : 480) + revs * (heavy ? 500 : 1300), t, 0.1);
  }

  /** continuous sounds, called every frame */
  setPlow(amount: number) {
    if (!this.plowGain || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.plowGain.gain.setTargetAtTime(this.muted ? 0 : Math.min(0.5, amount), t, 0.06);
    if (this.plowFilter) this.plowFilter.frequency.setTargetAtTime(1200 + Math.random() * 900, t, 0.03);
  }
  setRumble(amount: number) {
    if (!this.rumbleGain || !this.ctx) return;
    this.rumbleGain.gain.setTargetAtTime(this.muted ? 0 : Math.min(0.7, amount), this.ctx.currentTime, 0.1);
  }
  setWind(amount: number) {
    if (!this.windGain || !this.ctx) return;
    this.windGain.gain.setTargetAtTime(this.muted ? 0 : amount, this.ctx.currentTime, 0.3);
  }
}
