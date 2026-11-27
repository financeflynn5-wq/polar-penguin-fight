import { World, Penguin, SplatCause } from '../sim/World';
import { CFG, MITTEN_NAMES, REWARD_NAMES, GUN_NAMES } from '../sim/config';
import { vehicleOf, vehicleSide, nearVehicle, boardingBlock, maxHealth, VEHICLE_NAMES } from '../sim/Vehicles';
import { gunAmmoMax } from '../sim/Guns';
import { CLASSES, ClassId } from '../sim/Classes';

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
  private conquest: boolean;
  private bt: boolean;
  private lastStreak = '';
  private lastPoints = '';
  private lastGun = '';
  private cls: ClassId | null = null;

  constructor(w: World) {
    const conquest = this.conquest = w.mode === 'conquest';
    const bt = this.bt = w.mode === 'breakthrough';
    const flags = conquest || bt;
    this.el = h(`<div class="ui">
      <div class="frost"></div>
      <div class="chillfx"></div>
      <div class="splatfx"></div>
      <div class="score">
        <div class="team t0"><span id="s0">0</span><small>${bt ? 'tickets' : ''}</small></div>
        <div class="mid"><div class="clock" id="clock">1:00</div><div class="phase" id="phase">Build phase</div><div class="goal" id="goal">first to ${w.scoreToWin}</div>${bt ? '<div class="goal plow" id="plowT"></div>' : ''}</div>
        <div class="team t1"><span id="s1">0</span><small>${bt ? 'sections left' : ''}</small></div>
      </div>
      ${flags ? `<div class="points${bt ? ' low' : ''}" id="points"></div>` : ''}
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
        ${flags ? '' : `<div class="card streak"><div class="label">Splat streak <b id="streakN">0</b></div><div class="rewards" id="rewards">${
          REWARD_NAMES.map((n, i) => `<div class="rw" data-i="${i}"><span class="key">${i + 1}</span><span class="nm">${n}</span><span class="at">${CFG.streakAt[i]}</span></div>`).join('')}</div></div>`}
        <div class="card ride hidden" id="ride"><div class="label" id="rideName">Snowmobile</div><div class="packbar ridebar"><div id="rideBar"></div></div></div>
        <div class="card hidden" id="rushCard"><div class="label">Charge <span class="key">Shift</span></div><div class="rushbar"><div id="rushbar"></div></div><div class="rushtxt" id="rushTxt">READY</div></div>
        <div class="card"><div class="label">Mittens</div><div class="mitten"><span id="mitName">Wool Mittens</span><span class="pip"></span><span class="pip"></span><span class="pip"></span></div></div>
        <div class="card"><div class="label">Health</div><div class="hearts" id="hearts"></div></div>
        <div class="card"><div class="label">Snowballs</div><div class="balls" id="balls"></div><div class="packbar"><div id="packbar"></div></div></div>
        <div class="card gun hidden" id="gun"><div class="label" id="gunName"></div><div class="tank"><div id="gunTank"></div></div><div class="swap"><span class="key">X</span><span id="gunSwap"></span></div></div>
      </div>
      <div class="controls">
        <div><span class="key">LMB</span>throw (hold = farther)</div>
        <div><span class="key">RMB</span>push snow</div>
        <div><span class="key">F</span>pack snowball</div>
        <div><span class="key">R</span>build (sweep to draw, hold to stack)</div>
        <div><span class="key">Q</span>dig &nbsp; <span class="key">G</span>giant snowball</div>
        <div>hold <span class="key">T</span>build a turret (lots of snow)</div>
        ${flags ? '' : '<div><span class="key">1</span><span class="key">2</span><span class="key">3</span>streak rewards</div>'}
        <div><span class="key">E</span>grab / hop on a vehicle &nbsp;·&nbsp; hold <span class="key">E</span>stash</div>
        <div><span class="key">X</span>gun or blade / snowballs (find them on the gun pads)</div>
        <div id="shiftKey"></div>
        <div>sliding: <span class="key">A</span><span class="key">D</span>steer &nbsp; <span class="key">S</span>brake</div>
        <div><span class="key">Tab</span>scores</div>
      </div>
      <div class="board hidden" id="board"></div>
    </div>`);
    this.setClass(w.player.cls);
    document.body.appendChild(this.el);
  }

  /** Hearts, snowball slots and the Shift key are different for each class. */
  private setClass(cls: ClassId) {
    if (cls === this.cls) return;
    this.cls = cls;
    const def = CLASSES[cls];
    this.q('#hearts').innerHTML = '<div class="heart"></div>'.repeat(def.health);
    this.q('#balls').innerHTML = `<div class="ball off${def.splash > 0 ? ' big' : ''}"></div>`.repeat(def.maxCarry);
    this.lastCarried = -1;
    this.q('#rushCard').classList.toggle('hidden', !def.rush);
    this.q('#shiftKey').innerHTML = `${def.slide ? '<span class="key">Shift</span>belly slide &nbsp; ' : def.rush ? '<span class="key">Shift</span>charge &nbsp; ' : ''}<span class="key">Space</span>hop`;
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

  feed(killer: Penguin | undefined, victim: Penguin, cause: SplatCause) {
    const f = this.q('#feed');
    const k = killer ? `<span class="t${killer.team}">${esc(killer.name)}</span>` : '<span>Gravity</span>';
    const icon = cause === 'vehicle' ? 'ran over' : cause === 'bigball' ? 'flattened' : cause === 'turret' ? 'turret got' : cause === 'avalanche' ? 'buried' : cause === 'charge' ? 'ran over' : cause === 'cocoa' ? 'melted' : cause === 'blade' ? 'whacked' : cause === 'tankgun' ? 'peppered' : cause === 'catapult' ? 'catapulted' : 'splatted';
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
    const fightName = this.conquest ? 'Conquest' : !this.bt ? 'Team splat-match'
      : w.holdT > 0 ? `Regroup ${Math.ceil(w.holdT)}s` : w.lastStandT >= 0 ? `Last stand ${Math.ceil(w.lastStandT)}s` : 'Breakthrough';
    this.q('#phase').textContent = w.phase === 'build' ? 'Build phase' : w.phase === 'fight' ? fightName : 'Match over';
    if (this.bt) {
      const goal = `${w.map.sectors[w.sector].name} · ${w.sector + 1} of ${w.map.sectors.length}`;
      const g = this.q('#goal');
      if (g.textContent !== goal) g.textContent = goal;
      this.q('#phase').classList.toggle('warn', w.phase === 'fight' && w.lastStandT >= 0 && w.holdT <= 0);
    }

    if (this.conquest || this.bt) {
      // the flags: owner colour, a ring that fills as it's taken, and a blink while both teams are on it
      // (Breakthrough shows the objectives of the section in play)
      const pts = this.bt ? w.activePoints().map(i => w.points[i]) : w.points;
      const key = pts.map(p => `${p.id},${p.owner},${Math.round(p.cap * 30)},${p.n0 > 0 && p.n1 > 0 ? 1 : 0}`).join('|');
      if (key !== this.lastPoints) {
        this.lastPoints = key;
        this.q('#points').innerHTML = pts.map(p => {
          const side = p.cap < 0 ? 0 : 1, amt = Math.abs(p.cap), col = side === 0 ? '#59a8ff' : '#ff9a5c';
          const ring = amt > 0.01 ? `background: conic-gradient(${col} ${amt * 360}deg, rgba(255,255,255,.16) 0)` : '';
          const mine = p.owner === me.team ? ' mine' : '';
          return `<div class="pt o${p.owner < 0 ? 'n' : p.owner}${p.n0 > 0 && p.n1 > 0 ? ' fight' : ''}${mine}" style="${ring}"><span>${p.name}</span></div>`;
        }).join('');
      }
    } else {
      const key = `${me.streak}|${me.rewards.join(',')}|${me.frenzyT > 0 ? Math.ceil(me.frenzyT) : 0}`;
      if (key !== this.lastStreak) {
        this.lastStreak = key;
        this.q('#streakN').textContent = String(me.streak);
        const cycle = CFG.streakAt[CFG.streakAt.length - 1];
        const lap = me.streak === 0 ? 0 : ((me.streak - 1) % cycle) + 1;
        this.el.querySelectorAll<HTMLElement>('#rewards .rw').forEach((r, i) => {
          const n = me.rewards[i];
          r.classList.toggle('ready', n > 0);
          r.classList.toggle('live', i === 0 && me.frenzyT > 0);
          const left = CFG.streakAt[i] - lap;
          r.querySelector('.at')!.textContent = i === 0 && me.frenzyT > 0 ? `${Math.ceil(me.frenzyT)}s` : n > 1 ? `x${n}` : n === 1 ? 'READY' : `${left > 0 ? left : left + cycle} more`;
        });
      }
    }

    // hearts / balls / pack progress
    this.setClass(me.cls);
    const def = CLASSES[me.cls];
    if (def.rush) {
      const cd = Math.max(0, me.rushCd), all = CFG.rushTime + CFG.rushCooldown;
      (this.q('#rushbar') as HTMLElement).style.width = `${(1 - cd / all) * 100}%`;
      const txt = me.rushT > 0 ? 'CHARGING!' : cd > 0 ? `${Math.ceil(cd)}s` : 'READY';
      const t = this.q('#rushTxt');
      if (t.textContent !== txt) t.textContent = txt;
      this.q('#rushCard').classList.toggle('ready', cd <= 0);
    }
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

    // the gun you're carrying: what it is, how full its tank is, and whether it's in your mittens or on your back
    const gkey = `${me.gun}|${me.gunOut ? 1 : 0}`;
    if (gkey !== this.lastGun) {
      this.lastGun = gkey;
      const card = this.q('#gun');
      card.classList.toggle('hidden', !me.gun);
      card.classList.toggle('cocoa', me.gun === 1);
      card.classList.toggle('blade', me.gun === 3);
      card.classList.toggle('out', me.gunOut);
      this.q('#gunName').textContent = GUN_NAMES[me.gun] ?? '';
      this.q('#gunSwap').textContent = me.gunOut ? 'back to snowballs' : 'take it out';
    }
    if (me.gun) (this.q('#gunTank') as HTMLElement).style.width = `${Math.min(1, me.gunAmmo / gunAmmoMax(me.gun)) * 100}%`;
    this.q('.chillfx').classList.toggle('on', me.alive && me.chill > 0.05);
    (this.q('.chillfx') as HTMLElement).style.setProperty('--chill', String(Math.min(1, me.chill)));

    // charge ring
    const c = this.q('#charge');
    const len = 2 * Math.PI * 18;
    c.setAttribute('stroke-dasharray', `${(me.charging ? me.charge : 0) * len} 200`);
    this.q('#cross').classList.toggle('hidden', !me.alive || w.phase === 'end');

    // Breakthrough: when the attackers' snowplow turns up
    if (this.bt) {
      const plow = w.vehicles.find(v => v.kind === 'snowplow');
      const txt = w.phase !== 'fight' ? '' : plow ? (plow.seats[0] >= 0 ? (vehicleSide(w, plow) !== plow.team ? 'The defenders have the snowplow!' : 'Snowplow on the move') : plow.idleT > 3 && plow.lastDriver >= 0 ? 'Snowplow standing empty' : 'Snowplow waiting at the attackers\' camp') : w.garage.plowT > 0 ? `Snowplow in ${fmt(w.garage.plowT)}` : '';
      const el = this.q('#plowT');
      if (el.textContent !== txt) el.textContent = txt;
    }

    // the vehicle you're on
    const ride = me.alive ? vehicleOf(w, me) : null;
    this.q('#ride').classList.toggle('hidden', !ride);
    if (ride) {
      const name = VEHICLE_NAMES[ride.kind];
      let label = name[0].toUpperCase() + name.slice(1) + (ride.kind === 'snowplow' ? (ride.plowDown ? ' · blade down' : ' · blade up') : '');
      const g = ride.tank;
      if (g) label += me.seat === 0 ? (g.hot ? ' · gun jammed, cooling!' : g.heat > 0.7 ? ' · gun getting hot' : '') : g.catT > 0 ? ' · winding the catapult…' : ' · catapult loaded';
      if (this.q('#rideName').textContent !== label) this.q('#rideName').textContent = label;
      const frac = Math.max(0, ride.health / maxHealth(w, ride.kind));
      const bar = this.q('#rideBar');
      bar.style.width = `${frac * 100}%`;
      bar.classList.toggle('low', frac < 0.35);
    }

    // contextual prompts
    const prompts: string[] = [];
    const pile = ride ? -1 : w.nearPile(me);
    if (ride) {
      if (ride.kind === 'snowtank') prompts.push(me.seat === 0
        ? `<span class="key">W</span><span class="key">S</span>drive &nbsp; <span class="key">A</span><span class="key">D</span>steer &nbsp; <span class="key">LMB</span>snowball gun &nbsp; <span class="key">E</span>hop off`
        : `<span class="key">LMB</span>launch the catapult (aim where it lands) &nbsp; <span class="key">E</span>hop off`);
      else if (me.seat === 0) prompts.push(`<span class="key">W</span><span class="key">S</span>drive &nbsp; <span class="key">A</span><span class="key">D</span>steer &nbsp; ${ride.kind === 'snowplow' ? `<span class="key">Space</span>${ride.plowDown ? 'lift the blade (plow through)' : 'blade down (build a wall)'} &nbsp; ` : ''}<span class="key">E</span>hop off`);
      else prompts.push(`<span class="key">LMB</span>throw &nbsp; <span class="key">E</span>hop off`);
    } else {
      const v = nearVehicle(w, me);
      if (v) {
        const block = boardingBlock(w, v, me);
        if (!block) prompts.push(`<span class="key">E</span>${v.seats[0] < 0 ? (v.team !== me.team ? `Steal their ${VEHICLE_NAMES[v.kind]}!` : `Drive the ${VEHICLE_NAMES[v.kind]}`) : v.kind === 'snowtank' ? 'Work the catapult' : 'Hop on the back'}`);
      }
    }
    if (me.alive && pile >= 0) {
      const n = w.piles[pile];
      if (pile === me.team) {
        if (n >= def.ballCost && me.carried < def.maxCarry) prompts.push(`<span class="key">E</span>Grab snowballs (${n})`);
        if (me.carried > 0) prompts.push(`Hold <span class="key">E</span>Stash ${me.carried}`);
      } else if (n >= def.ballCost && me.carried < def.maxCarry) prompts.push(`<span class="key">E</span>Steal snowballs (${n})!`);
    }
    if (me.alive && pile < 0 && me.carried > 0 && !ride) {
      const t = w.nearTurret(me);
      if (t) prompts.push(`Hold <span class="key">E</span>Load the turret (${t.ammo} shots left)`);
    }
    if (me.alive && me.carried === 0 && w.phase === 'fight' && pile < 0 && !ride && !me.gunOut) prompts.push(`Out of snowballs: hold <span class="key">F</span> to pack`);
    if (aimOkHint) prompts.push(aimOkHint);
    const pr = this.q('#prompt');
    const html = prompts.map(p => `<div class="p">${p}</div>`).join('');
    if (pr.innerHTML !== html) pr.innerHTML = html;

    // splatted overlay
    const down = this.q('#down');
    down.classList.toggle('hidden', me.alive || w.phase === 'end');
    if (!me.alive) {
      const k = w.penguin(me.lastHitBy);
      const out = this.bt && me.team === 0 && w.phase === 'fight' && w.scores[0] <= 0;
      this.q('#downSmall').textContent = `${k ? `${k.name} got you. ` : ''}${out ? 'No tickets left: you\'re out unless your team takes the section' : `Back in ${Math.max(0, me.downT).toFixed(1)}s`}${me.nextCls !== me.cls ? ` as a ${CLASSES[me.nextCls].name}` : ''} · Esc to change class`;
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
      return `<div class="col"><h3 style="color:${t === 0 ? '#8fc6ff' : '#ffb48a'}">${t === 0 ? 'Team Blizzard' : 'Team Sunrise'} · ${w.scores[t]}${this.bt ? (t === 0 ? ' tickets' : w.scores[t] === 1 ? ' section left' : ' sections left') : ''}</h3>
        <div class="r hd"><span>Penguin</span><span>Splats</span><span>Downs</span></div>${rows}</div>`;
    }).join('');
    const b = this.q('#board');
    if (b.innerHTML !== cols) b.innerHTML = cols;
  }

  destroy() { this.el.remove(); }
}
