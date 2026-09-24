// Pinbowl server. Needs Node.js 18 or newer. No extra packages required.
// Stores everything in one file: DATA_DIR/db.json (plus one daily backup copy).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const MP = process.env.MP_BASE || 'https://app.matchplay.events';
const SYNC_MS = Number(process.env.SYNC_SECONDS || 60) * 1000;
const SESSION_DAYS = 30;

/* ---------------- storage ---------------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
function emptyDb() { return { admins: [], sessions: {}, settings: { mpToken: '' }, tournaments: [] }; }
function loadDb() {
  try { return { ...emptyDb(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; }
  catch (e) { return emptyDb(); }
}
let db = loadDb();
function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
  const day = new Date().toISOString().slice(0, 10);
  const daily = path.join(DATA_DIR, `backup-${day}.json`);
  if (!fs.existsSync(daily)) {
    fs.copyFileSync(DB_FILE, daily);
    // keep the 30 newest daily backups
    const old = fs.readdirSync(DATA_DIR).filter(f => /^backup-\d{4}-\d\d-\d\d\.json$/.test(f)).sort().slice(0, -30);
    old.forEach(f => fs.unlinkSync(path.join(DATA_DIR, f)));
  }
}

/* ---------------- helpers ---------------- */
const uid = () => crypto.randomBytes(6).toString('hex');
const toInt = v => { if (v === null || v === undefined || v === '') return null; const n = parseInt(String(v).replace(/[^\d]/g, ''), 10); return Number.isFinite(n) ? n : null; };
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const fail = (code, msg) => { throw new HttpError(code, msg); };

function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}
function checkPw(pw, admin) {
  const h = crypto.scryptSync(pw, admin.salt, 64);
  return crypto.timingSafeEqual(h, Buffer.from(admin.hash, 'hex'));
}

// Emergency admin reset: set RESET_ADMIN="Name:password" and restart the server.
if (process.env.RESET_ADMIN && process.env.RESET_ADMIN.includes(':')) {
  const i = process.env.RESET_ADMIN.indexOf(':');
  const name = process.env.RESET_ADMIN.slice(0, i).trim(), pw = process.env.RESET_ADMIN.slice(i + 1);
  let a = db.admins.find(x => x.name.toLowerCase() === name.toLowerCase());
  if (!a) { a = { id: uid(), name, createdAt: Date.now() }; db.admins.push(a); }
  Object.assign(a, hashPw(pw));
  save();
  console.log(`Admin "${name}" reset. Remove RESET_ADMIN from your settings now.`);
}

function publicT(t) { const { mpRaw, ...rest } = t; return rest; }
function summary(t) { return { id: t.id, name: t.name, status: t.status, createdAt: t.createdAt, players: t.players.length, mpId: t.mpId }; }
function getT(id) { return db.tournaments.find(t => t.id === id) || fail(404, 'Tournament not found.'); }
function openT(id) { const t = getT(id); if (t.status === 'archived') fail(409, 'This tournament is archived. Reopen it to make changes.'); return t; }

/* ---------------- sessions ---------------- */
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function currentAdmin(req) {
  const tok = parseCookies(req).pb_session;
  const s = tok && db.sessions[tok];
  if (!s || s.exp < Date.now()) return null;
  return db.admins.find(a => a.id === s.adminId) || null;
}
function startSession(res, admin, req) {
  const tok = crypto.randomBytes(32).toString('hex');
  db.sessions[tok] = { adminId: admin.id, exp: Date.now() + SESSION_DAYS * 864e5 };
  for (const [k, s] of Object.entries(db.sessions)) if (s.exp < Date.now()) delete db.sessions[k];
  save();
  const secure = (req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `pb_session=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`);
}

const loginFails = new Map();
function throttle(ip) {
  const now = Date.now(), rec = (loginFails.get(ip) || []).filter(t => now - t < 15 * 60e3);
  loginFails.set(ip, rec);
  if (rec.length >= 10) fail(429, 'Too many wrong passwords. Wait 15 minutes and try again.');
  return () => { rec.push(now); loginFails.set(ip, rec); };
}

/* ---------------- Matchplay sync ---------------- */
function findNum(o, keys) {
  if (!o || typeof o !== 'object') return 0;
  for (const k of keys) if (o[k] != null && toInt(o[k])) return toInt(o[k]);
  if (o.pivot) return findNum(o.pivot, keys);
  return 0;
}
const TARGET_KEYS = ['targetScore', 'target_score', 'target', 'targetscore'];
const BALL_KEYS = ['balls', 'ballCount', 'numberOfBalls', 'ballsPerGame'];

async function syncTournament(t) {
  const token = db.settings.mpToken || process.env.MATCHPLAY_TOKEN;
  if (!t.mpId) fail(400, 'This tournament is not linked to a Matchplay tournament.');
  if (!token) fail(400, 'Add your Matchplay API token on the Tournaments tab first.');
  let r;
  try {
    r = await fetch(`${MP}/api/tournaments/${t.mpId}?includePlayers=true&includeArenas=true`, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) { fail(502, 'Could not reach Matchplay. Try again in a minute.'); }
  if (r.status === 401 || r.status === 403) fail(502, 'Matchplay rejected the API token. Check it on the Tournaments tab.');
  if (r.status === 404) fail(502, 'Matchplay has no tournament with that ID.');
  if (!r.ok) fail(502, `Matchplay returned an error (${r.status}).`);
  const j = await r.json(), d = j.data || j;

  if (!t.name || t.name === 'New tournament') t.name = d.name || t.name;
  let addedPlayers = 0, addedArenas = 0;

  (d.players || []).forEach(x => {
    const id = x.playerId ?? x.id, name = (x.name || '').trim();
    if (id == null || !name) return;
    let p = t.players.find(q => q.mpId === id)
      || t.players.find(q => q.mpId == null && q.name.toLowerCase() === name.toLowerCase());
    if (p) { p.mpId = id; p.name = name; }
    else { t.players.push({ id: uid(), name, mpId: id }); addedPlayers++; }
  });

  // Targets and ball counts may live on the arena objects or on another list (frames/holes) that points at arenas.
  const targets = {}, balls = {};
  for (const v of Object.values(d)) {
    if (!Array.isArray(v)) continue;
    for (const o of v) {
      if (!o || typeof o !== 'object' || o.arenaId == null) continue;
      const tg = findNum(o, TARGET_KEYS); if (tg) targets[o.arenaId] = tg;
      const b = findNum(o, BALL_KEYS); if (b === 3 || b === 5) balls[o.arenaId] = b;
    }
  }
  (d.arenas || []).forEach(x => {
    const id = x.arenaId ?? x.id, name = (x.name || '').trim();
    if (id == null || !name) return;
    let a = t.arenas.find(q => q.mpId === id)
      || t.arenas.find(q => q.mpId == null && q.name.toLowerCase() === name.toLowerCase());
    if (!a) { a = { id: uid(), name, mpId: id, balls: 3, target: 0, active: true, targetFromMp: false }; t.arenas.push(a); addedArenas++; }
    a.mpId = id; a.name = name;
    // Matchplay's target wins unless an admin typed their own
    if (targets[id] && (!a.target || a.targetFromMp)) { a.target = targets[id]; a.targetFromMp = true; }
    if (balls[id] && (a.ballsFromMp || !a.ballsSetByAdmin)) { a.balls = balls[id]; a.ballsFromMp = true; }
  });

  const samples = {};
  for (const [k, v] of Object.entries(d)) if (Array.isArray(v) && v.length && typeof v[0] === 'object') samples[k] = v[0];
  t.mpRaw = { fetchedAt: Date.now(), tournamentKeys: Object.keys(d), firstItemOfEachList: samples };
  t.lastSync = Date.now();
  t.lastSyncError = '';
  save();
  return { addedPlayers, addedArenas };
}

async function autoSync() {
  for (const t of db.tournaments) {
    if (t.status !== 'active' || !t.mpId) continue;
    try { await syncTournament(t); }
    catch (e) { t.lastSyncError = e.message; }
  }
}
setInterval(() => { autoSync().catch(() => {}); }, SYNC_MS);

/* ---------------- request handling ---------------- */
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) { reject(new HttpError(413, 'Too much data.')); req.destroy(); } });
    req.on('end', () => { if (!data) return resolve({}); try { resolve(JSON.parse(data)); } catch (e) { reject(new HttpError(400, 'Bad request.')); } });
    req.on('error', reject);
  });
}

function validGame(t, b) {
  const g = {
    playerId: String(b.playerId || ''), arenaId: String(b.arenaId || ''),
    hitBall: Number(b.hitBall), b1: toInt(b.b1), final: toInt(b.final),
  };
  if (!t.players.some(p => p.id === g.playerId)) fail(400, 'Unknown player.');
  if (!t.arenas.some(a => a.id === g.arenaId)) fail(400, 'Unknown machine.');
  if (![0, 1, 2, 3].includes(g.hitBall)) fail(400, 'Pick the ball the target was reached on.');
  if (g.hitBall !== 1 && g.b1 == null) fail(400, 'Enter the score after ball 1.');
  if (g.hitBall === 0 && g.final == null) fail(400, 'Enter the final score.');
  return g;
}

async function route(req, res, url) {
  const m = req.method, p = url.pathname;
  const admin = currentAdmin(req);
  const need = () => admin || fail(401, 'Log in as an admin to do that.');
  let mt;

  // ----- public -----
  if (m === 'GET' && p === '/api/state') {
    return send(res, 200, {
      admin: admin ? { id: admin.id, name: admin.name } : null,
      needsSetup: db.admins.length === 0,
      tournaments: db.tournaments.map(summary).sort((a, b) => b.createdAt - a.createdAt),
    });
  }
  if (m === 'GET' && (mt = p.match(/^\/api\/t\/([\w-]+)$/))) return send(res, 200, publicT(getT(mt[1])));

  // ----- login -----
  if (m === 'POST' && p === '/api/setup') {
    if (db.admins.length) fail(409, 'Setup is already done. Log in instead.');
    const b = await readBody(req);
    const name = String(b.name || '').trim(), pw = String(b.password || '');
    if (!name || pw.length < 6) fail(400, 'Enter a name and a password of at least 6 characters.');
    const a = { id: uid(), name, createdAt: Date.now(), ...hashPw(pw) };
    db.admins.push(a); save(); startSession(res, a, req);
    return send(res, 200, { ok: true });
  }
  if (m === 'POST' && p === '/api/login') {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
    const bad = throttle(ip);
    const b = await readBody(req);
    const a = db.admins.find(x => x.name.toLowerCase() === String(b.name || '').trim().toLowerCase());
    if (!a || !checkPw(String(b.password || ''), a)) { bad(); fail(401, 'That name and password do not match.'); }
    startSession(res, a, req);
    return send(res, 200, { ok: true });
  }
  if (m === 'POST' && p === '/api/logout') {
    const tok = parseCookies(req).pb_session; if (tok) { delete db.sessions[tok]; save(); }
    res.setHeader('Set-Cookie', 'pb_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return send(res, 200, { ok: true });
  }

  // ----- admin: settings and admins -----
  if (p.startsWith('/api/admin/')) need();
  if (m === 'GET' && p === '/api/admin/settings') {
    return send(res, 200, { hasToken: !!(db.settings.mpToken || process.env.MATCHPLAY_TOKEN), admins: db.admins.map(a => ({ id: a.id, name: a.name })) });
  }
  if (m === 'PUT' && p === '/api/admin/settings') {
    const b = await readBody(req);
    if (typeof b.mpToken === 'string') db.settings.mpToken = b.mpToken.trim();
    save(); return send(res, 200, { ok: true });
  }
  if (m === 'POST' && p === '/api/admin/admins') {
    const b = await readBody(req);
    const name = String(b.name || '').trim(), pw = String(b.password || '');
    if (!name || pw.length < 6) fail(400, 'Enter a name and a password of at least 6 characters.');
    if (db.admins.some(a => a.name.toLowerCase() === name.toLowerCase())) fail(409, 'There is already an admin with that name.');
    db.admins.push({ id: uid(), name, createdAt: Date.now(), ...hashPw(pw) }); save();
    return send(res, 200, { ok: true });
  }
  if (m === 'DELETE' && (mt = p.match(/^\/api\/admin\/admins\/(\w+)$/))) {
    if (db.admins.length <= 1) fail(409, 'You cannot remove the last admin.');
    if (mt[1] === admin.id) fail(409, 'You cannot remove yourself. Ask another admin.');
    db.admins = db.admins.filter(a => a.id !== mt[1]);
    for (const [k, s] of Object.entries(db.sessions)) if (s.adminId === mt[1]) delete db.sessions[k];
    save(); return send(res, 200, { ok: true });
  }
  if (m === 'PUT' && (mt = p.match(/^\/api\/admin\/admins\/(\w+)\/password$/))) {
    const b = await readBody(req); const pw = String(b.password || '');
    if (pw.length < 6) fail(400, 'Use at least 6 characters.');
    const a = db.admins.find(x => x.id === mt[1]) || fail(404, 'Admin not found.');
    Object.assign(a, hashPw(pw)); save(); return send(res, 200, { ok: true });
  }

  // ----- admin: tournaments -----
  if (m === 'POST' && p === '/api/admin/tournaments') {
    const b = await readBody(req);
    const mpId = toInt(String(b.mp || '').match(/tournaments\/(\d+)/)?.[1] ?? b.mp);
    const t = {
      id: uid(), name: String(b.name || '').trim() || 'New tournament', mpId: mpId || null, status: 'active',
      createdAt: Date.now(), frames: 10, tenthBonus: true, allowRepeats: false,
      players: [], arenas: [], games: [], lastSync: null, lastSyncError: '',
    };
    // copy machine setup from the most recent tournament, since weekly events usually reuse it
    const prev = db.tournaments.slice().sort((a, b) => b.createdAt - a.createdAt)[0];
    if (b.copyMachines && prev) {
      t.arenas = prev.arenas.map(a => ({ ...a, id: uid() }));
      Object.assign(t, { frames: prev.frames, tenthBonus: prev.tenthBonus, allowRepeats: prev.allowRepeats });
    }
    db.tournaments.push(t); save();
    let note = '';
    if (t.mpId) { try { await syncTournament(t); } catch (e) { t.lastSyncError = e.message; note = e.message; save(); } }
    return send(res, 200, { tournament: publicT(t), note });
  }
  if ((mt = p.match(/^\/api\/admin\/t\/(\w+)(\/.*)?$/))) {
    const tid = mt[1], sub = mt[2] || '';
    if (m === 'PATCH' && sub === '') {
      const t = getT(tid), b = await readBody(req);
      if (b.status === 'archived' || b.status === 'active') t.status = b.status;
      if (t.status === 'archived' && Object.keys(b).some(k => k !== 'status')) fail(409, 'Reopen the tournament to change its settings.');
      if (typeof b.name === 'string' && b.name.trim()) t.name = b.name.trim();
      if (b.frames != null) t.frames = Math.max(1, Math.min(20, parseInt(b.frames, 10) || 10));
      if (typeof b.tenthBonus === 'boolean') t.tenthBonus = b.tenthBonus;
      if (typeof b.allowRepeats === 'boolean') t.allowRepeats = b.allowRepeats;
      if (b.mp !== undefined) t.mpId = toInt(String(b.mp).match(/tournaments\/(\d+)/)?.[1] ?? b.mp) || null;
      save(); return send(res, 200, { tournament: publicT(t) });
    }
    if (m === 'DELETE' && sub === '') {
      const t = getT(tid);
      if (t.status !== 'archived') fail(409, 'Archive the tournament before deleting it.');
      db.tournaments = db.tournaments.filter(x => x.id !== tid); save();
      return send(res, 200, { ok: true });
    }
    if (m === 'POST' && sub === '/sync') {
      const t = openT(tid); const r = await syncTournament(t);
      return send(res, 200, { tournament: publicT(t), ...r });
    }
    if (m === 'GET' && sub === '/raw') return send(res, 200, getT(tid).mpRaw || {});

    // players
    if (m === 'POST' && sub === '/players') {
      const t = openT(tid), b = await readBody(req), name = String(b.name || '').trim();
      if (!name) fail(400, 'Enter a name.');
      t.players.push({ id: uid(), name, mpId: null }); save();
      return send(res, 200, { tournament: publicT(t) });
    }
    if (m === 'DELETE' && (mt = sub.match(/^\/players\/(\w+)$/))) {
      const t = openT(tid);
      t.games = t.games.filter(g => g.playerId !== mt[1]);
      t.players = t.players.filter(x => x.id !== mt[1]); save();
      return send(res, 200, { tournament: publicT(t) });
    }

    // machines
    if (m === 'POST' && sub === '/arenas') {
      const t = openT(tid), b = await readBody(req), name = String(b.name || '').trim();
      if (!name) fail(400, 'Enter a machine name.');
      t.arenas.push({ id: uid(), name, mpId: null, balls: 3, target: 0, active: true }); save();
      return send(res, 200, { tournament: publicT(t) });
    }
    if (m === 'PATCH' && (mt = sub.match(/^\/arenas\/(\w+)$/))) {
      const t = openT(tid), b = await readBody(req);
      const a = t.arenas.find(x => x.id === mt[1]) || fail(404, 'Machine not found.');
      if (typeof b.name === 'string' && b.name.trim()) a.name = b.name.trim();
      if (b.balls === 3 || b.balls === 5) { a.balls = b.balls; a.ballsSetByAdmin = true; a.ballsFromMp = false; }
      if (b.target !== undefined) { a.target = toInt(b.target) || 0; a.targetFromMp = false; }
      if (typeof b.active === 'boolean') a.active = b.active;
      save(); return send(res, 200, { tournament: publicT(t) });
    }
    if (m === 'DELETE' && (mt = sub.match(/^\/arenas\/(\w+)$/))) {
      const t = openT(tid);
      t.games = t.games.filter(g => g.arenaId !== mt[1]);
      t.arenas = t.arenas.filter(x => x.id !== mt[1]); save();
      return send(res, 200, { tournament: publicT(t) });
    }

    // games
    if (m === 'POST' && sub === '/games') {
      const t = openT(tid), g = validGame(t, await readBody(req));
      t.games.push({ id: uid(), ...g, ts: Date.now(), by: admin.name }); save();
      return send(res, 200, { tournament: publicT(t) });
    }
    if (m === 'PUT' && (mt = sub.match(/^\/games\/(\w+)$/))) {
      const t = openT(tid), g = validGame(t, await readBody(req));
      const old = t.games.find(x => x.id === mt[1]) || fail(404, 'Game not found.');
      Object.assign(old, g, { editedBy: admin.name, editedAt: Date.now() }); save();
      return send(res, 200, { tournament: publicT(t) });
    }
    if (m === 'DELETE' && (mt = sub.match(/^\/games\/(\w+)$/))) {
      const t = openT(tid); t.games = t.games.filter(x => x.id !== mt[1]); save();
      return send(res, 200, { tournament: publicT(t) });
    }
    if (m === 'POST' && (mt = sub.match(/^\/games\/(\w+)\/move$/))) {
      const t = openT(tid), b = await readBody(req), dir = b.dir === -1 ? -1 : 1;
      const g = t.games.find(x => x.id === mt[1]) || fail(404, 'Game not found.');
      const idxs = t.games.map((x, i) => x.playerId === g.playerId ? i : -1).filter(i => i >= 0);
      const i = t.games.indexOf(g), other = idxs[idxs.indexOf(i) + dir];
      if (other !== undefined) { [t.games[i], t.games[other]] = [t.games[other], t.games[i]]; save(); }
      return send(res, 200, { tournament: publicT(t) });
    }
  }
  fail(404, 'Not found.');
}

const INDEX = path.join(__dirname, 'public', 'index.html');
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    try { await route(req, res, url); }
    catch (e) {
      if (e instanceof HttpError) send(res, e.code, { error: e.message });
      else { console.error(e); send(res, 500, { error: 'Something went wrong on the server.' }); }
    }
    return;
  }
  if (url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
  fs.readFile(INDEX, (err, html) => {
    if (err) { res.writeHead(500); return res.end('Missing public/index.html'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(html);
  });
});
server.listen(PORT, () => console.log(`Pinbowl running on port ${PORT}. Data folder: ${DATA_DIR}`));
