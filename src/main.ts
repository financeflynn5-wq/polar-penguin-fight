import './style.css';
import { Game } from './game/Game';
import { HATS, World } from './sim/World';
import { TEAM_NAMES } from './render/Environment';
import { NetClient, serverStatus, serverUrl } from './net/NetClient';

const HAT_LABELS: Record<string, [string, string]> = {
  none: ['—', 'None'], beanie: ['🧶', 'Beanie'], tophat: ['🎩', 'Top hat'], propeller: ['🌀', 'Propeller'], viking: ['🪓', 'Viking'],
  crown: ['👑', 'Crown'], fish: ['🐟', 'Fish'], party: ['🎉', 'Party'], chef: ['🍳', 'Chef'], cone: ['🚧', 'Cone'],
};

const store = {
  get(k: string, d: string) { try { return localStorage.getItem('ppf.' + k) ?? d; } catch { return d; } },
  set(k: string, v: string) { try { localStorage.setItem('ppf.' + k, v); } catch { /* private mode */ } },
};

const app = document.getElementById('app')!;
const game = new Game(app);
const params = new URLSearchParams(location.search);

let hat = store.get('hat', 'beanie');
let teamSize = +store.get('teamSize', '5');
let name = store.get('name', 'Flynn');
game.setMenuHat(hat);
game.input.sensitivity = +store.get('sens', '1');

const el = (html: string) => { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstElementChild as HTMLElement; };

const menu = el(`<div class="menu">
  <div class="logo">Polar<span>Penguin Fight</span><small>Snowball arena · built live on stream</small></div>
  <div class="field"><label>Penguin name</label><input type="text" id="name" maxlength="16" /></div>
  <div class="field"><label>Hat</label><div class="hats" id="hats"></div></div>
  <div class="field"><label>Match</label><div class="modes">
    <button class="mode" data-size="5"><b>5 v 5</b><span>Bots fill the empty slots</span></button>
    <button class="mode" data-size="10"><b>10 v 10</b><span>Total snow chaos</span></button>
  </div></div>
  <div class="playrow">
    <button class="btn" id="playOnline">Play online</button>
    <button class="btn" id="play">Play</button>
    <button class="btn blue small" id="practice">Practice with bots</button>
  </div>
  <div class="online" id="online"></div>
  <div class="howto">
    <div><b>One minute build phase:</b> hold R and sweep the crosshair to draw snow walls, hold still to stack them higher. Dig trenches and tunnels, pack snowballs and stash them in your stockpile.</div>
    <div><b>Then fight:</b> 3 hits and you're splatted back to base. First team to 25 splats wins.</div>
    <div><b>Grab shiny snowflakes</b> in the middle to upgrade your mittens. <b>Roll your own giant snowball</b> with G, grow it in fresh snow and send it downhill to flatten forts.</div>
  </div>
  <div class="howto">
    <span class="key">WASD</span>move <span class="key">Mouse</span>look <span class="key">LMB</span>throw <span class="key">RMB</span>push snow
    <span class="key">F</span>pack <span class="key">R</span>build <span class="key">Q</span>dig <span class="key">G</span>giant snowball <span class="key">E</span>stockpile <span class="key">Shift</span>slide <span class="key">Space</span>hop
  </div>
  <div class="foot">Best on a computer with a mouse. Map: Frostbite Bay.</div>
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
menu.querySelectorAll<HTMLButtonElement>('.mode').forEach(b => b.addEventListener('click', () => {
  teamSize = +b.dataset.size!; store.set('teamSize', String(teamSize)); game.audio.unlock(); game.audio.click(); syncMenu();
}));
function syncMenu() {
  menu.querySelectorAll<HTMLElement>('.hat').forEach(b => b.classList.toggle('sel', b.dataset.hat === hat));
  menu.querySelectorAll<HTMLElement>('.mode').forEach(b => b.classList.toggle('sel', +b.dataset.size! === teamSize));
}
syncMenu();

function start() {
  menu.classList.add('hidden');
  pause.classList.add('hidden');
  end.classList.add('hidden');
  online = false;
  game.startMatch({ teamSize, playerName: name || 'Penguin', playerHat: hat });
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
  const net = new NetClient(serverUrl(), { name: name || 'Penguin', hat, size: teamSize }, {
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
      (end.querySelector('#endScore') as HTMLElement).innerHTML = `<span style="color:#8fc6ff">${w.scores[0]}</span> – <span style="color:#ffb48a">${w.scores[1]}</span>`;
      (end.querySelector('#endSub') as HTMLElement).textContent = w.winner < 0 ? 'Nobody wins the bay today.' : `${TEAM_NAMES[w.winner]} wins Frostbite Bay!`;
      const mvp = [...w.penguins].sort((a, b) => b.splats - a.splats || a.downs - b.downs)[0];
      (end.querySelector('#endMvp') as HTMLElement).textContent = `MVP: ${mvp.name} with ${mvp.splats} splats · You: ${me.splats} splats, ${me.downs} downs`;
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
if (params.get('autostart')) start();
(window as any).__game = game;
