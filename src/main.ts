import './style.css';
import { Game } from './game/Game';
import { HATS, World, Mode, asSkin } from './sim/World';
import { CFG } from './sim/config';
import { TEAM_NAMES } from './render/Environment';
import { NetClient, serverStatus, serverUrl } from './net/NetClient';
import { loadAssets } from './render/Assets';

const HAT_LABELS: Record<string, [string, string]> = {
  none: ['—', 'None'], beanie: ['🧶', 'Beanie'], tophat: ['🎩', 'Top hat'], propeller: ['🌀', 'Propeller'], viking: ['🪓', 'Viking'],
  crown: ['👑', 'Crown'], fish: ['🐟', 'Fish'], party: ['🎉', 'Party'], chef: ['🍳', 'Chef'], cone: ['🚧', 'Cone'],
};

const store = {
  get(k: string, d: string) { try { return localStorage.getItem('ppf.' + k) ?? d; } catch { return d; } },
  set(k: string, v: string) { try { localStorage.setItem('ppf.' + k, v); } catch { /* private mode */ } },
};

const app = document.getElementById('app')!;
// the penguin and hat models load first: everything in the game wears them
{
  const bar = document.querySelector<HTMLElement>('#boot .fill');
  await loadAssets(f => { if (bar) bar.style.width = `${Math.round(f * 100)}%`; });
  document.getElementById('boot')?.remove();
}
const game = new Game(app);
const params = new URLSearchParams(location.search);

let hat = store.get('hat', 'beanie');
let skin = asSkin(params.get('skin') ?? store.get('skin', ''));
let teamSize = +store.get('teamSize', '5');
const asMode = (m: string | null): Mode => (m === 'conquest' || m === 'breakthrough' ? m : 'tdm');
let mode: Mode = asMode(store.get('mode', 'tdm'));
// Breakthrough: 0 = attack with Team Blizzard, 1 = defend with Team Sunrise
let side = store.get('side', '0') === '1' ? 1 : 0;
let name = store.get('name', 'Flynn');
game.setMenuHat(hat);
game.setMenuSkin(skin);
game.input.sensitivity = +store.get('sens', '1');

const el = (html: string) => { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild as HTMLElement; };

const menu = el(`<div class="menu">
  <div class="logo">Polar<span>Penguin Fight</span><small>Snowball arena · built live on stream</small></div>
  <div class="field"><label>Penguin name</label><input type="text" id="name" maxlength="16" /></div>
  <div class="field"><label>Penguin</label><div class="modes">
    <button class="mode sm" data-skin="new"><b>New penguin</b><span>Quilted jacket, knitted scarf</span></button>
    <button class="mode sm" data-skin="classic"><b>Classic penguin</b><span>The original look and hats</span></button>
  </div></div>
  <div class="field"><label>Hat</label><div class="hats" id="hats"></div></div>
  <div class="field"><label>Game mode</label><div class="modes">
    <button class="mode gm" data-mode="tdm"><b>Team Deathmatch</b><span>First to ${CFG.scoreToWin} splats · Frostbite Bay</span></button>
    <button class="mode gm" data-mode="conquest"><b>Conquest</b><span>Hold the flags · Glacier Gap</span></button>
    <button class="mode gm" data-mode="breakthrough"><b>Breakthrough</b><span>Attack or defend · Peppermint Pass</span></button>
  </div><div class="modes" id="sides">
    <button class="mode sm" data-side="0"><b>Attack</b><span>Team Blizzard: take all three sections</span></button>
    <button class="mode sm" data-side="1"><b>Defend</b><span>Team Sunrise: dig in and hold them off</span></button>
  </div><div class="modes">
    <button class="mode sm" data-size="5"><b>5 v 5</b><span>Bots fill the empty slots</span></button>
    <button class="mode sm" data-size="10"><b>10 v 10</b><span>Total snow chaos</span></button>
  </div></div>
  <div class="playrow">
    <button class="btn" id="playOnline">Play online</button>
    <button class="btn" id="play">Play</button>
    <button class="btn blue small" id="practice">Practice with bots</button>
  </div>
  <div class="online" id="online"></div>
  <div class="howto">
    <div><b>Build phase first:</b> hold R and sweep the crosshair to draw snow walls, hold still to stack them higher. Dig trenches and tunnels, pack snowballs and stash them in your stockpile.</div>
    <div id="howMode"></div>
    <div><b>Hold T to build a snowman turret.</b> It takes a lot of snow, throws at any enemy it can see, and you reload it with your own snowballs.</div>
    <div><b>Grab shiny snowflakes</b> to upgrade your mittens. <b>Roll your own giant snowball</b> with G, grow it in fresh snow and send it downhill to flatten forts and turrets.</div>
  </div>
  <div class="howto">
    <span class="key">WASD</span>move <span class="key">Mouse</span>look <span class="key">LMB</span>throw <span class="key">RMB</span>push snow
    <span class="key">F</span>pack <span class="key">R</span>build <span class="key">Q</span>dig <span class="key">T</span>turret <span class="key">G</span>giant snowball <span class="key">E</span>stockpile <span class="key">Shift</span>slide <span class="key">Space</span>hop
  </div>
  <div class="foot">Best on a computer with a mouse.</div>
</div>`);
document.body.appendChild(menu);
const playOnlineBtn = menu.querySelector('#playOnline') as HTMLButtonElement;
const playBtn = menu.querySelector('#play') as HTMLButtonElement;
const practiceBtn = menu.querySelector('#practice') as HTMLButtonElement;
const onlineEl = menu.querySelector('#online') as HTMLElement;
const nameInput = menu.querySelector('#name') as HTMLInputElement;
nameInput.value = name;
nameInput.addEventListener('input', () => { name = nameInput.value.trim() || 'Penguin'; store.set('name', name); });
nameInput.addEventListener('keydown', e => e.stopPropagation());

const hatsEl = menu.querySelector('#hats')!;
for (const h of HATS) {
  const [em, label] = HAT_LABELS[h];
  const b = el(`<button class="hat" data-hat="${h}"><span class="em">${em}</span>${label}</button>`);
  b.addEventListener('click', () => { hat = h; store.set('hat', h); game.setMenuHat(h); game.audio.unlock(); game.audio.click(); syncMenu(); });
  hatsEl.appendChild(b);
}
menu.querySelectorAll<HTMLButtonElement>('.mode[data-skin]').forEach(b => b.addEventListener('click', () => {
  skin = asSkin(b.dataset.skin); store.set('skin', skin); game.setMenuSkin(skin); game.audio.unlock(); game.audio.click(); syncMenu();
}));
menu.querySelectorAll<HTMLButtonElement>('.mode[data-size]').forEach(b => b.addEventListener('click', () => {
  teamSize = +b.dataset.size!; store.set('teamSize', String(teamSize)); game.audio.unlock(); game.audio.click(); syncMenu();
}));
menu.querySelectorAll<HTMLButtonElement>('.mode[data-mode]').forEach(b => b.addEventListener('click', () => {
  mode = b.dataset.mode as Mode; store.set('mode', mode); game.audio.unlock(); game.audio.click(); syncMenu();
}));
menu.querySelectorAll<HTMLButtonElement>('.mode[data-side]').forEach(b => b.addEventListener('click', () => {
  side = +b.dataset.side!; store.set('side', String(side)); game.audio.unlock(); game.audio.click(); syncMenu();
}));
const HOW_MODE: Record<Mode, string> = {
  tdm: `<b>Team Deathmatch:</b> 3 hits and you're splatted. You come back somewhere along your team's side of the map, and there's a stockpile at each end of it as well as at the igloo. First team to ${CFG.scoreToWin} splats wins. <b>Splat streaks</b> earn rewards: ${CFG.streakAt[0]} in one life for a Snowball Frenzy, ${CFG.streakAt[1]} for an instant turret, ${CFG.streakAt[2]} for an Avalanche. Use them with 1, 2 and 3.`,
  conquest: `<b>Conquest:</b> three flags, A, B and C. Stand in a flag's ring to take it, and every flag your team holds keeps scoring points. First to ${CFG.conquestScore} wins. You come back at the nearest flag you hold, so wall yours in and guard it with turrets.`,
  breakthrough: `<b>Breakthrough:</b> Team Blizzard attacks, Team Sunrise defends. The map has three sections: the Flats, Crumble Town and the Summit. The attackers stand in a section's rings (A and B) to take them, and when they hold every ring the defenders fall back to the next section. Every attacker who gets splatted costs a ticket, starting with ${CFG.btTickets} per penguin, and taking a section wins some back. Take the Summit to win. If the tickets run out first, the defenders win.`,
};
function syncMenu() {
  menu.querySelectorAll<HTMLElement>('.hat').forEach(b => b.classList.toggle('sel', b.dataset.hat === hat));
  menu.querySelectorAll<HTMLElement>('.mode[data-skin]').forEach(b => b.classList.toggle('sel', b.dataset.skin === skin));
  menu.querySelectorAll<HTMLElement>('.mode[data-size]').forEach(b => b.classList.toggle('sel', +b.dataset.size! === teamSize));
  menu.querySelectorAll<HTMLElement>('.mode[data-mode]').forEach(b => b.classList.toggle('sel', b.dataset.mode === mode));
  menu.querySelectorAll<HTMLElement>('.mode[data-side]').forEach(b => b.classList.toggle('sel', +b.dataset.side! === side));
  menu.querySelector('#sides')!.classList.toggle('hidden', mode !== 'breakthrough');
  menu.querySelector('#howMode')!.innerHTML = HOW_MODE[mode];
}
syncMenu();

function start() {
  menu.classList.add('hidden');
  pause.classList.add('hidden');
  end.classList.add('hidden');
  online = false;
  game.startMatch({ teamSize, playerName: name || 'Penguin', playerHat: hat, playerSkin: skin, mode, playerTeam: mode === 'breakthrough' ? side : 0 });
}
playBtn.addEventListener('click', start);
practiceBtn.addEventListener('click', start);

// ───────── online ─────────
// Shown when a game server answers: the page is being served by it, or the build/URL points at one (VITE_SERVER, ?server=).
let online = false; // the current or last match was online
let serverUp = false;
let joining = false;
async function checkServer() {
  if (!menu.classList.contains('hidden') || !serverUp) {
    const st = await serverStatus();
    serverUp = !!st;
    playOnlineBtn.classList.toggle('hidden', !serverUp);
    practiceBtn.classList.toggle('hidden', !serverUp);
    playBtn.classList.toggle('hidden', serverUp);
    if (!joining) onlineEl.textContent = st ? `${st.players} ${st.players === 1 ? 'penguin' : 'penguins'} online now · bots fill the empty slots` : '';
  }
}
checkServer();
setInterval(checkServer, 10000);

function playOnline() {
  if (joining) return;
  joining = true;
  online = true;
  game.audio.unlock(); game.audio.click();
  onlineEl.textContent = 'Joining a match…';
  playOnlineBtn.disabled = true;
  let started = false;
  const net = new NetClient(serverUrl(), { name: name || 'Penguin', hat, skin, size: teamSize, mode, ...(mode === 'breakthrough' ? { team: side } : {}) }, {
    onMatch: (info, density, hard) => {
      started = true; joining = false; playOnlineBtn.disabled = false;
      menu.classList.add('hidden');
      game.beginOnlineMatch(net, info, density, hard);
    },
    onRoster: () => game.refreshModels(),
    onClose: reason => {
      joining = false; playOnlineBtn.disabled = false;
      if (game.net !== net && started) return; // we already left
      if (started) { toMenu(); }
      onlineEl.textContent = reason;
    },
  });
}
playOnlineBtn.addEventListener('click', playOnline);

// pause overlay (pointer lock lost)
const pause = el(`<div class="overlay dim hidden"><div class="panel">
  <h2>Paused</h2><p>Click Resume to jump back in.</p>
  <div class="set"><span>Mouse sensitivity</span><input type="range" id="sens" min="0.3" max="2.5" step="0.05"></div>
  <div class="set"><span>Sound</span><button class="btn small blue" id="mute">On</button></div>
  <div class="set"><span>Graphics</span><button class="btn small blue" id="gfx">High</button></div>
  <div class="row"><button class="btn" id="resume">Resume</button><button class="btn blue" id="quit">Quit to menu</button></div>
</div></div>`);
document.body.appendChild(pause);
const sens = pause.querySelector('#sens') as HTMLInputElement;
sens.value = String(game.input.sensitivity);
sens.addEventListener('input', () => { game.input.sensitivity = +sens.value; store.set('sens', sens.value); });
const muteBtn = pause.querySelector('#mute') as HTMLButtonElement;
muteBtn.addEventListener('click', () => { game.audio.setMuted(!game.audio.muted); muteBtn.textContent = game.audio.muted ? 'Off' : 'On'; });
const gfxBtn = pause.querySelector('#gfx') as HTMLButtonElement;
gfxBtn.textContent = game.quality === 'high' ? 'High' : 'Fast';
gfxBtn.addEventListener('click', () => { game.setQuality(game.quality === 'high' ? 'low' : 'high'); gfxBtn.textContent = game.quality === 'high' ? 'High' : 'Fast'; });
pause.querySelector('#resume')!.addEventListener('click', () => game.resume());
pause.querySelector('#quit')!.addEventListener('click', () => { pause.classList.add('hidden'); toMenu(); });

// end of match
const end = el(`<div class="overlay dim hidden"><div class="panel">
  <h2 id="endTitle">Victory!</h2>
  <div class="result-big" id="endScore">25 – 18</div>
  <p id="endSub"></p>
  <div class="mvp" id="endMvp"></div>
  <p class="next hidden" id="endNext">Next match starts in a few seconds…</p>
  <div class="row"><button class="btn" id="again">Play again</button><button class="btn blue" id="menuBtn">Menu</button></div>
</div></div>`);
document.body.appendChild(end);
const againBtn = end.querySelector('#again') as HTMLButtonElement;
againBtn.addEventListener('click', () => {
  if (online && game.net) { end.classList.add('hidden'); game.resume(); return; } // stay for the next match
  if (online && serverUp) { end.classList.add('hidden'); toMenu(); playOnline(); return; }
  start();
});
end.querySelector('#menuBtn')!.addEventListener('click', () => { end.classList.add('hidden'); toMenu(); });

function toMenu() {
  pause.classList.add('hidden');
  end.classList.add('hidden');
  game.enterMenu();
  game.setMenuSkin(skin);
  game.setMenuHat(hat);
  menu.classList.remove('hidden');
  checkServer();
}

game.hooks = {
  onPauseChange: p => {
    pause.classList.toggle('hidden', !p);
    (pause.querySelector('p') as HTMLElement).textContent = game.net ? 'The match keeps going while you\'re here. Click Resume to jump back in.' : 'Click Resume to jump back in.';
  },
  onMatchStart: () => { end.classList.add('hidden'); },
  onGameOver: (w: World) => {
    setTimeout(() => {
      const me = w.player;
      const won = w.winner === me.team;
      (end.querySelector('#endTitle') as HTMLElement).textContent = w.winner < 0 ? 'Draw!' : won ? 'Victory!' : 'Defeat!';
      const bt = w.mode === 'breakthrough';
      // Breakthrough's score is how far the attack got
      (end.querySelector('#endScore') as HTMLElement).innerHTML = bt
        ? `<span style="color:#8fc6ff">${w.winner === 0 ? w.map.sectors.length : w.sector}</span> <small>of ${w.map.sectors.length} sections taken</small>`
        : `<span style="color:#8fc6ff">${w.scores[0]}</span> – <span style="color:#ffb48a">${w.scores[1]}</span>`;
      (end.querySelector('#endSub') as HTMLElement).textContent = bt
        ? (w.winner === 0 ? `${TEAM_NAMES[0]} broke through ${w.map.name} with ${w.scores[0]} tickets to spare!` : `${TEAM_NAMES[1]} held ${w.map.sectors[w.sector].name}: ${w.map.name} stands!`)
        : w.winner < 0 ? `Nobody wins ${w.map.name} today.` : `${TEAM_NAMES[w.winner]} wins ${w.map.name}!`;
      const mvp = [...w.penguins].sort((a, b) => b.splats - a.splats || a.downs - b.downs)[0];
      (end.querySelector('#endMvp') as HTMLElement).textContent = `Most splats: ${mvp.name} with ${mvp.splats} · You: ${me.splats} splats, ${me.downs} downs`;
      const live = !!game.net;
      (end.querySelector('#endNext') as HTMLElement).classList.toggle('hidden', !live);
      againBtn.textContent = live ? 'Stay for the next match' : 'Play again';
      (end.querySelector('#menuBtn') as HTMLElement).textContent = live ? 'Leave' : 'Menu';
      if (w !== game.world) return; // a new match already started
      end.classList.remove('hidden');
    }, 1800);
  },
};

// dev/test hooks: ?autostart=1 skips the menu
if (params.get('q')) game.setQuality(params.get('q') === 'low' ? 'low' : 'high');
if (params.get('mode')) mode = asMode(params.get('mode'));
if (params.get('side')) side = params.get('side') === 'defend' || params.get('side') === '1' ? 1 : 0;
if (params.get('autostart')) start();
(window as any).__game = game;
