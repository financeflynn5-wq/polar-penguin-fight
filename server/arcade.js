// Hooks for the arcade hub. The same file lives in Time of War
// (server/arcade.js), Flynn Fall (server/arcade.js) and Scrapforge
// (arcade.js): keep the copies identical.
//
//   ipOf(req)              the visitor's address: cf-connecting-ip (Cloudflare
//                          tunnel), else the first x-forwarded-for, else the socket
//   new Bans()             banned addresses, kept in ARCADE_BANS (a JSON file
//                          {"ips": [...]}) that several games can share
//   createArcade({...})    a request handler for GET /healthz and the hub's
//                          admin API under /__arcade/
//
// The admin API is on only when ARCADE_ADMIN_TOKEN is set, and it answers only
// a request from this machine (loopback socket, no proxy headers) that carries
// the token in x-arcade-admin. Anything else gets a plain 404.
//   GET  /__arcade/players  {game, max, players: [{id, name, room, ip}]}
//   POST /__arcade/kick     {id}  close that player's socket (4001 "kicked")
//   POST /__arcade/ban      {id}  ban their address, close its sockets (4003 "banned")
//   POST /__arcade/unban    {ip}
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_BODY = 4096;

// "::ffff:1.2.3.4" (IPv4 on an IPv6 socket) is plain 1.2.3.4.
export const normIp = (ip) => {
  const s = String(ip ?? '').trim().toLowerCase();
  return /^::ffff:\d+\.\d+\.\d+\.\d+$/.test(s) ? s.slice(7) : s;
};
export const ipOf = (req) =>
  normIp(String(req.headers['cf-connecting-ip'] ?? '').trim() || String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress || '?');
export const isLoopback = (ip) => {
  const s = normIp(ip);
  return s === '::1' || s.startsWith('127.');
};
// Came through a proxy or tunnel (cloudflared connects from loopback too).
export const viaProxy = (req) => req.headers['cf-connecting-ip'] !== undefined || req.headers['x-forwarded-for'] !== undefined;

export class Bans {
  constructor(file = process.env.ARCADE_BANS) {
    this.file = file ? path.resolve(file) : null;
    this.ips = new Set();
    if (!this.file) return;
    this.reload();
    // Another game (or the hub) may change the file: pick that up.
    fs.watchFile(this.file, { interval: 2000 }, () => this.reload()).unref?.();
  }

  has(ip) {
    return this.ips.has(normIp(ip));
  }

  // The list in the file, or null when it is missing or unreadable.
  read() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(j?.ips)) return j.ips.filter((s) => typeof s === 'string').map(normIp).filter(Boolean);
    } catch {}
    return null;
  }

  // A missing or broken file leaves the list as it was.
  reload() {
    const ips = this.read();
    if (ips) this.ips = new Set(ips);
  }

  add(ip) {
    this.change(normIp(ip), true);
  }

  remove(ip) {
    this.change(normIp(ip), false);
  }

  change(ip, banned) {
    // Start from the file, which another game may have changed since we read it.
    if (this.file) this.reload();
    if (banned) this.ips.add(ip);
    else this.ips.delete(ip);
    this.save();
  }

  // Write a temp file and rename it over the list, so a reader never sees half a file.
  save() {
    if (!this.file) return;
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify({ ips: [...this.ips] }, null, 2)}\n`);
      for (let i = 0; ; i++) {
        try {
          fs.renameSync(tmp, this.file);
          break;
        } catch (e) {
          // Windows refuses while another process has the file open; that's brief.
          if (i >= 8) throw e;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        }
      }
    } catch (e) {
      console.error(`[arcade] could not save the ban list to ${this.file}: ${e.message}`);
      try {
        fs.unlinkSync(tmp);
      } catch {}
    }
  }
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function notFound(res) {
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found');
}

// Close a socket with a code the client sees, and cut it if it doesn't answer.
export function dropSocket(ws, code, reason) {
  try {
    ws.close(code, reason);
  } catch {}
  setTimeout(() => ws.terminate(), 2000).unref?.();
}

function readJson(req, done) {
  if (Number(req.headers['content-length']) > MAX_BODY) return done('too large');
  const chunks = [];
  let size = 0, over = false;
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) over = true;
    else chunks.push(c);
  });
  req.on('end', () => {
    if (over) return done('too large');
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      done(null, body && typeof body === 'object' ? body : {});
    } catch {
      done('bad json');
    }
  });
  req.on('error', () => done('bad request'));
}

// game: 'tow' | 'ff' | 'scrapforge'. max(): the player cap (or null).
// players(): the humans in play, [{id, name, room, ip, ws}]. sockets(): every
// open websocket, each with ws.arcadeIp. bans: a Bans. extra(): more /healthz fields.
// Returns handle(req, res), true when it answered the request.
export function createArcade({ game, max, players, sockets, bans, extra = () => ({}) }) {
  const token = process.env.ARCADE_ADMIN_TOKEN || '';
  const want = Buffer.from(token);
  const authorized = (req) => {
    if (!token || viaProxy(req) || !isLoopback(req.socket.remoteAddress)) return false;
    const got = Buffer.from(String(req.headers['x-arcade-admin'] ?? ''));
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  };
  const find = (id) => players().find((p) => p.id === String(id ?? ''));

  return function handle(req, res) {
    const url = (req.url || '/').split('?')[0];
    if (url === '/healthz') {
      sendJson(res, 200, { ok: true, ...extra(), players: players().length, max: max() }, { 'access-control-allow-origin': '*' });
      return true;
    }
    if (!url.startsWith('/__arcade/')) return false;
    if (!authorized(req)) {
      notFound(res);
      return true;
    }
    const route = url.slice('/__arcade/'.length);
    if (route === 'players' && req.method === 'GET') {
      sendJson(res, 200, { game, max: max(), players: players().map(({ id, name, room, ip }) => ({ id, name, room, ip })) });
      return true;
    }
    if (req.method !== 'POST' || !['kick', 'ban', 'unban'].includes(route)) {
      sendJson(res, 404, { ok: false });
      return true;
    }
    readJson(req, (err, body) => {
      if (res.headersSent) return;
      if (err) return sendJson(res, err === 'too large' ? 413 : 400, { ok: false, error: err });
      if (route === 'unban') {
        if (typeof body.ip !== 'string' || !body.ip.trim()) return sendJson(res, 400, { ok: false, error: 'ip' });
        bans.remove(body.ip);
        console.log(`[arcade] unbanned ${normIp(body.ip)}`);
        return sendJson(res, 200, { ok: true });
      }
      const p = find(body.id);
      if (!p) return sendJson(res, 404, { ok: false });
      if (route === 'kick') {
        console.log(`[arcade] kicked ${p.name} (${p.ip})`);
        dropSocket(p.ws, 4001, 'kicked');
        return sendJson(res, 200, { ok: true });
      }
      const ip = normIp(p.ip);
      if (isLoopback(ip) || !ip || ip === '?') return sendJson(res, 400, { ok: false, error: 'local' });
      bans.add(ip);
      for (const ws of sockets()) if (normIp(ws.arcadeIp) === ip) dropSocket(ws, 4003, 'banned');
      console.log(`[arcade] banned ${p.name} (${ip})`);
      sendJson(res, 200, { ok: true, ip });
    });
    return true;
  };
}
