// Polar Penguin Fight game server: serves the built game (dist/) and runs the online matches on /ws.
//
//   PORT            where to listen (default 8080)
//   MAX_PLAYERS     people online at once across all matches (default 40)
//   MAX_CONN_PER_IP connections one address may hold (default 6)
//   ARCADE_*        Flynn Arcade hub hooks (see arcade.js)
//
// Matches: one 5v5 and one 10v10 at a time per "room"; when a room's slots are all people, the next person starts
// another room of that size. Bots fill every slot nobody is playing.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { Room, Client } from './Room';
import { PROTOCOL, TICK_HZ, TEAM_SIZES, MODES } from '../src/net/Protocol';
import type { Mode } from '../src/world/Maps';
import { HATS, emptyInput } from '../src/sim/World';
import { asClass } from '../src/sim/Classes';
import { cleanName } from './names.js';
import { Bans, createArcade, ipOf } from './arcade.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STATIC = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT) || 8080;
const MAX_PLAYERS = Math.max(1, Number(process.env.MAX_PLAYERS) || 40);
const MAX_CONN_PER_IP = Math.max(1, Number(process.env.MAX_CONN_PER_IP) || 6);
const MSG_PER_SEC = 120;
const DT = 1 / TICK_HZ;

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg',
  '.webp': 'image/webp', '.glb': 'model/gltf-binary', // the Blender-made models and their textures
};

const rooms: Room[] = [];
let roomN = 0;
const humans = () => rooms.reduce((n, r) => n + r.humans, 0);
const roomFor = (size: number, mode: Mode) => {
  let r = rooms.find(r => r.size === size && r.mode === mode && r.open);
  if (!r) { r = new Room(size, mode, `${mode}-${size}v${size}#${++roomN}`); rooms.push(r); console.log(`[${r.key}] room opened`); }
  return r;
};

const bans = new Bans();
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: { threshold: 256, zlibDeflateOptions: { level: 3 } } });

const arcade = createArcade({
  game: 'penguin',
  max: () => MAX_PLAYERS,
  bans,
  sockets: () => wss.clients,
  players: () => rooms.flatMap(r => r.players().map(({ c, name }) => ({ id: `${r.key}|${(c.ws as any).arcadeId}`, name, room: r.key, ip: (c.ws as any).arcadeIp, ws: c.ws }))),
  extra: () => ({ rooms: rooms.map(r => ({ room: r.key, mode: r.mode, players: r.humans, phase: r.world.phase })) }),
});

function serveFile(req: http.IncomingMessage, res: http.ServerResponse) {
  if (!fs.existsSync(STATIC)) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('Polar Penguin Fight game server'); return; }
  let url: string;
  try { url = decodeURIComponent((req.url || '/').split('?')[0]); } catch { res.writeHead(400); res.end(); return; }
  let file = path.join(STATIC, url);
  if (url.includes('\0') || (file !== STATIC && !file.startsWith(STATIC + path.sep))) { res.writeHead(403); res.end(); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(STATIC, 'index.html');
  const cache = file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache';
  const stream = fs.createReadStream(file);
  stream.on('error', () => { if (!res.headersSent) res.writeHead(404); res.end(); });
  stream.once('open', () => {
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': cache });
    stream.pipe(res);
  });
}

const server = http.createServer((req, res) => {
  try {
    if ((req.url || '').split('?')[0] === '/status') {
      // the menu's live head count (also answers the GitHub Pages copy of the game, so it can offer online play)
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({ game: 'polar-penguin-fight', protocol: PROTOCOL, players: humans(), max: MAX_PLAYERS,
        rooms: rooms.map(r => ({ size: r.size, mode: r.mode, players: r.humans, phase: r.world.phase })) }));
      return;
    }
    if (!arcade(req, res)) serveFile(req, res);
  } catch (e) {
    console.error('http error:', e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

const refuse = (socket: import('node:stream').Duplex, status: number) => {
  socket.once('finish', () => socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
};

const perIp = new Map<string, number>();
server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => {});
  if (!req.url?.startsWith('/ws')) { socket.destroy(); return; }
  const ip = ipOf(req);
  if (bans.has(ip)) return refuse(socket, 403);
  if ((perIp.get(ip) ?? 0) >= MAX_CONN_PER_IP) return refuse(socket, 429);
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req, ip));
});

let lastId = 0;
wss.on('connection', (ws: WebSocket, _req: http.IncomingMessage, ip: string) => {
  perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
  const meta = ws as any;
  meta.arcadeId = ++lastId;
  meta.arcadeIp = ip;
  meta.isAlive = true;
  ws.on('pong', () => { meta.isAlive = true; });
  let room: Room | null = null;
  let client: Client | null = null;
  let sec = 0, count = 0;
  ws.on('message', (data, isBinary) => {
    const now = Math.floor(performance.now() / 1000);
    if (now !== sec) { sec = now; count = 0; }
    if (++count > MSG_PER_SEC || isBinary) return;
    let msg: any;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    try {
      if (msg.t === 'in' && client && room) room.onInput(client, msg.s, Array.isArray(msg.i) ? msg.i : []);
      else if (msg.t === 'cls' && client && room) room.setClass(client, asClass(msg.cls));
      else if (msg.t === 'ping') ws.send(JSON.stringify({ t: 'pong', c: Number(msg.c) || 0 }));
      else if (msg.t === 'join' && !client) {
        if (msg.v !== PROTOCOL) { ws.send(JSON.stringify({ t: 'joinErr', err: 'The game was just updated. Refresh the page to play.' })); return; }
        if (humans() >= MAX_PLAYERS) { ws.send(JSON.stringify({ t: 'joinErr', err: `The server is full (${MAX_PLAYERS} players). Try again in a minute!` })); return; }
        const size = TEAM_SIZES.includes(msg.size) ? msg.size : 5;
        const mode: Mode = MODES.includes(msg.mode) ? msg.mode : 'tdm';
        const hat = HATS.includes(msg.hat) ? msg.hat : 'beanie';
        const c: Client = {
          ws, name: cleanName(msg.name, 'Penguin', { max: 16, prefix: 'Penguin' }), hat, cls: asClass(msg.cls),
          // Breakthrough: you can ask to attack or defend, and get it when that side has room
          team: mode === 'breakthrough' && (msg.team === 0 || msg.team === 1) ? msg.team : -1, penguinId: -1,
          queue: [], last: emptyInput(), lastSeq: -1, ack: 0, held: null, resync: false,
        };
        const r = roomFor(size, mode);
        if (!r.join(c)) { ws.send(JSON.stringify({ t: 'joinErr', err: 'That match just filled up. Try again!' })); return; }
        room = r; client = c;
      }
    } catch (e) {
      console.error(`[${room?.key ?? '-'}] message error:`, e);
    }
  });
  ws.on('close', () => {
    perIp.set(ip, (perIp.get(ip) ?? 1) - 1);
    if ((perIp.get(ip) ?? 0) <= 0) perIp.delete(ip);
    try {
      if (room && client) room.leave(client);
      if (room && room.humans === 0) { rooms.splice(rooms.indexOf(room), 1); console.log(`[${room.key}] room closed`); }
    } catch (e) { console.error('leave error:', e); }
  });
  ws.on('error', () => {});
});

// drop connections that stopped answering, so they don't hold a slot
setInterval(() => {
  for (const ws of wss.clients) {
    const m = ws as any;
    if (!m.isAlive) { ws.terminate(); continue; }
    m.isAlive = false;
    try { ws.ping(); } catch { /* closing */ }
  }
}, 15000);

// fixed 60 Hz steps; setInterval alone drifts, so accumulate real time
let last = performance.now(), acc = 0;
setInterval(() => {
  const now = performance.now();
  acc = Math.min(acc + (now - last) / 1000, 0.25);
  last = now;
  while (acc >= DT) {
    acc -= DT;
    for (const r of rooms) {
      try { r.step(); } catch (e) { console.error(`[${r.key}] step error:`, e); }
    }
  }
}, 4);

server.listen(PORT, () => console.log(`Polar Penguin Fight server on http://localhost:${PORT} (up to ${MAX_PLAYERS} players)`));
