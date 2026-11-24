import { World, Penguin } from '../sim/World';
import { CFG, MITTEN_NAMES } from '../sim/config';

const h = (html: string) => { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild as HTMLElement; };
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const fmt = (t: number) => { t = Math.max(0, Math.ceil(t)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };

export class Hud {
  readonly el: HTMLElement;
  private q = <T extends HTMLElement>(s: string) => this.el.querySelector(s) as T;
  private bannerT = 0;
  private toastT = 0;
  private hitT = 0;
  private splatT = 0;
  private lastCarried = -1;
  private showBoard = false;

  constructor() {
    this.el = h(`<div class="ui">
      <div class="frost"></div>
      <div class="splatfx"></div>
      <div class="score">
        <div class="team t0" id="s0">0</div>
        <div class="mid"><div class="clock" id="clock">1:00</div><div class="phase" id="phase">Build phase</div><div class="goal">first to ${CFG.scoreToWin}</div></div>
        <div class="team t1" id="s1">0</div>
      </div>
      <div class="feed" id="feed"></div>
      <div class="crosshair" id="cross">
        <svg viewBox="0 0 46 46"><circle cx="23" cy="23" r="18" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="3"/>
          <circle id="charge" cx="23" cy="23" r="18" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-dasharray="0 200" transform="rotate(-90 23 23)"/></svg>
        <div class="dot"></div>
      </div>
      <div class="hitmark" id="hitmark"></div>
      <div class="banner" id="banner"><div class="big" id="bannerBig"></div><div class="small" id="bannerSmall"></div></div>
      <div class="down hidden" id="down"><div class="big">SPLAT!</div><div class="small" id="downSmall"></div></div>
      <div class="toast" id="toast"></div>
      <div class="prompt" id="prompt"></div>
      <div class="status">
        <div class="card"><div class="label">Mittens</div><div class="mitten"><span id="mitName">Wool Mittens</span><span class="pip"></span><span class="pip"></span><span class="pip"></span></div></div>
        <div class="card"><div class="label">Health</div><div class="hearts" id="hearts"></div></div>
        <div class="card"><div class="label">Snowballs</div><div class="balls" id="balls"></div><div class="packbar"><div id="packbar"></div></div></div>
      </div>
      <div class="controls">
        <div><span class="key">LMB</span>throw (hold = farther)</div>
        <div><span class="key">RMB</span>push snow</div>
        <div><span class="key">F</span>pack snowball</div>
        <div><span class="key">R</span>build (sweep to draw, hold to stack)</div>
        <div><span class="key">Q</span>dig &nbsp; <span class="key">G</span>giant snowball</div>
        <div><span class="key">E</span>grab &nbsp;·&nbsp; hold <span class="key">E</span>stash</div>
        <div><span class="key">Shift</span>belly slide &nbsp; <span class="key">Space</span>hop</div>
        <div><span class="key">Tab</span>scores</div>
      </div>
      <div class="board hidden" id="board"></div>
    </div>`);
    const hearts = this.q('#hearts');
    for (let i = 0; i < CFG.maxHealth; i++) hearts.appendChild(h('<div class="heart"></div>'));
    const balls = this.q('#balls');
    for (let i = 0; i < CFG.maxCarry; i++) balls.appendChild(h('<div class="ball off"></div>'));
    document.body.appendChild(this.el);
  }

  banner(big: string, small = '', time = 2.2) {
    this.q('#bannerBig').textContent = big;
    this.q('#bannerSmall').textContent = small;
    this.q('#banner').classList.add('on');
    this.bannerT = time;
  }

  toast(text: string, time = 1.4) {
    const t = this.q('#toast');
    t.textContent = text; t.classList.add('on');
    this.toastT = time;
  }

  hitMarker(splat: boolean) {
    const m = this.q('#hitmark');
    m.classList.toggle('splat', splat);
    m.classList.add('on');
    this.hitT = splat ? 0.35 : 0.18;
  }

  splatScreen() { this.q('.splatfx').classList.add('on'); this.splatT = 0.25; }

  feed(killer: Penguin | undefined, victim: Penguin, cause: 'snowball' | 'bigball') {
    const f = this.q('#feed');
    const k = killer ? `<span class="t${killer.team}">${esc(killer.name)}</span>` : '<span>Gravity</span>';
    const icon = cause === 'bigball' ? 'flattened' : 'splatted';
    const row = h(`<div class="row">${k}<span class="ic">${icon}</span><span class="t${victim.team}">${esc(victim.name)}</span></div>`);
    f.prepend(row);
    while (f.children.length > 5) f.lastElementChild!.remove();
    setTimeout(() => row.remove(), 6000);
  }

  setBoard(on: boolean) { this.showBoard = on; this.q('#board').classList.toggle('hidden', !on); }

  update(w: World, me: Penguin, dt: number, aimOkHint: string | null) {
    this.q('#s0').textContent = String(w.scores[0]);
    this.q('#s1').textContent = String(w.scores[1]);
    this.q('#clock').textContent = w.phase === 'end' ? '0:00' : fmt(w.phaseT);
    this.q('#phase').textContent = w.phase === 'build' ? 'Build phase' : w.phase === 'fight' ? 'Team splat-match' : 'Match over';

    // hearts / balls / pack progress
    const hearts = this.q('#hearts').children;
    for (let i = 0; i < hearts.length; i++) hearts[i].classList.toggle('off', i >= me.health);
    const balls = this.q('#balls').children;
    for (let i = 0; i < balls.length; i++) {
      balls[i].classList.toggle('off', i >= me.carried);
      if (me.carried > this.lastCarried && i === me.carried - 1 && this.lastCarried >= 0) { balls[i].classList.remove('pop'); void (balls[i] as HTMLElement).offsetWidth; balls[i].classList.add('pop'); }
    }
    this.lastCarried = me.carried;
    (this.q('#packbar') as HTMLElement).style.width = `${(me.action === 'pack' ? me.packProgress : 0) * 100}%`;
    this.q('#mitName').textContent = MITTEN_NAMES[me.mitten];
    this.el.querySelectorAll('.mitten .pip').forEach((p, i) => p.classList.toggle('on', i < me.mitten));

    // charge ring
    const c = this.q('#charge');
    const len = 2 * Math.PI * 18;
    c.setAttribute('stroke-dasharray', `${(me.charging ? me.charge : 0) * len} 200`);
    this.q('#cross').classList.toggle('hidden', !me.alive || w.phase === 'end');

    // contextual prompts
    const prompts: string[] = [];
    const pile = w.nearPile(me);
    if (me.alive && pile >= 0) {
      const n = w.piles[pile];
      if (pile === me.team) {
        if (n > 0 && me.carried < CFG.maxCarry) prompts.push(`<span class="key">E</span>Grab snowballs (${n})`);
        if (me.carried > 0) prompts.push(`Hold <span class="key">E</span>Stash ${me.carried}`);
      } else if (n > 0 && me.carried < CFG.maxCarry) prompts.push(`<span class="key">E</span>Steal snowballs (${n})!`);
    }
    if (me.alive && me.carried === 0 && w.phase === 'fight' && pile < 0) prompts.push(`Out of snowballs: hold <span class="key">F</span> to pack`);
    if (aimOkHint) prompts.push(aimOkHint);
    const pr = this.q('#prompt');
    const html = prompts.map(p => `<div class="p">${p}</div>`).join('');
    if (pr.innerHTML !== html) pr.innerHTML = html;

    // splatted overlay
    const down = this.q('#down');
    down.classList.toggle('hidden', me.alive || w.phase === 'end');
    if (!me.alive) {
      const k = w.penguin(me.lastHitBy);
      this.q('#downSmall').textContent = `${k ? `${k.name} got you. ` : ''}Back to base in ${Math.max(0, me.downT).toFixed(1)}s`;
    }
    this.q('.frost').classList.toggle('on', me.alive && me.health === 1);

    // timers
    this.bannerT -= dt; if (this.bannerT <= 0) this.q('#banner').classList.remove('on');
    this.toastT -= dt; if (this.toastT <= 0) this.q('#toast').classList.remove('on');
    this.hitT -= dt; if (this.hitT <= 0) this.q('#hitmark').classList.remove('on');
    this.splatT -= dt; if (this.splatT <= 0) this.q('.splatfx').classList.remove('on');

    if (this.showBoard) this.renderBoard(w, me);
  }

  private renderBoard(w: World, me: Penguin) {
    const cols = [0, 1].map(t => {
      const ps = w.penguins.filter(p => p.team === t).sort((a, b) => b.splats - a.splats || a.downs - b.downs);
      const rows = ps.map(p => `<div class="r ${p === me ? 'me' : ''}"><span>${esc(p.name)}${p.bot ? '' : ' ★'}</span><span>${p.splats}</span><span>${p.downs}</span></div>`).join('');
      return `<div class="col"><h3 style="color:${t === 0 ? '#8fc6ff' : '#ffb48a'}">${t === 0 ? 'Team Blizzard' : 'Team Sunrise'} · ${w.scores[t]}</h3>
        <div class="r hd"><span>Penguin</span><span>Splats</span><span>Downs</span></div>${rows}</div>`;
    }).join('');
    const b = this.q('#board');
    if (b.innerHTML !== cols) b.innerHTML = cols;
  }

  destroy() { this.el.remove(); }
}
