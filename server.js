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
const ADMIN_DAYS = 30, PLAYER_DAYS = 365;
const SPARE_LAST_BALL = 3;

/* ---------------- storage ---------------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
function emptyDb() {
  return { admins: [], sessions: {}, settings: { mpToken: '' }, tournaments: [], machineLib: {}, playerAccounts: {}, playerSessions: {} };
}
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
    const old = fs.readdirSync(DATA_DIR).filter(f => /^backup-\d{4}-\d\d-\d\d\.json$/.test(f)).sort().slice(0, -30);
    old.forEach(f => fs.unlinkSync(path.join(DATA_DIR, f)));
  }
}

/* ---------------- helpers ---------------- */
const uid = () => crypto.randomBytes(6).toString('hex');
const toInt = v => { if (v === null || v === undefined || v === '') return null; const n = parseInt(String(v).replace(/[^\d]/g, ''), 10); return Number.isFinite(n) ? n : null; };
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const fail = (code, msg) => { throw new HttpError(code, msg); };
const lower = s => String(s || '').trim().toLowerCase();

function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}
function checkPw(pw, rec) {
  const h = crypto.scryptSync(pw, rec.salt, 64);
  return crypto.timingSafeEqual(h, Buffer.from(rec.hash, 'hex'));
}

/* ---------------- machines: abbreviations and the saved-targets library ---------------- */
function abbrOf(name) {
  const base = String(name).split(/[:(]/)[0].trim();
  const words = base.split(/\s+/).filter(w => /[A-Za-z0-9]/.test(w) && !/^(the|of|and|a|an)$/i.test(w));
  if (words.length >= 2) return words.map(w => w.replace(/[^A-Za-z0-9]/g, '')[0] || '').join('').toUpperCase().slice(0, 4);
  return (words[0] || name).replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase();
}
const cleanAbbr = s => String(s || '').replace(/[^A-Za-z0-9&]/g, '').slice(0, 5).toUpperCase();
function libKeys(a) { const k = []; if (a.mpId != null) k.push('mp:' + a.mpId); k.push('name:' + lower(a.name)); return k; }
function libGet(a) { for (const k of libKeys(a)) if (db.machineLib[k]) return db.machineLib[k]; return null; }
function libPut(a) { const v = { target: a.target || 0, balls: a.balls || 3, abbr: a.abbr || abbrOf(a.name) }; for (const k of libKeys(a)) db.machineLib[k] = { ...v }; }
function newArena(name, mpId) {
  const a = { id: uid(), name, mpId: mpId ?? null, balls: 3, target: 0, active: true, abbr: abbrOf(name), targetSource: '' };
  const l = libGet(a);
  if (l) { a.target = l.target || 0; a.balls = l.balls || 3; a.abbr = l.abbr || a.abbr; if (a.target) a.targetSource = 'saved'; }
  return a;
}
// Upgrade data from the earlier version and fill the library from past tournaments.
db.tournaments.sort((a, b) => a.createdAt - b.createdAt).forEach(t => t.arenas.forEach(a => {
  if (!a.abbr) a.abbr = abbrOf(a.name);
  if (!a.targetSource) a.targetSource = a.targetFromMp ? 'mp' : (a.target ? 'admin' : '');
  if (a.target) libPut(a);
}));

/* ---------------- scoring (mirrors the page) ---------------- */
function pins(score, target) { if (score == null || !target) return 0; return Math.max(0, Math.min(9, Math.floor(score * 10 / target))); }
function rollsOf(t, g) {
  const a = t.arenas.find(x => x.id === g.arenaId), tg = a ? a.target : 0;
  if (g.hitBall === 1) return { type: 'strike', rolls: [10] };
  const first = pins(g.b1, tg);
  if (g.hitBall >= 2 && g.hitBall <= SPARE_LAST_BALL) return { type: 'spare', rolls: [first, 10 - first] };
  const tot = Math.max(first, pins(g.final, tg));
  return { type: 'open', rolls: [first, tot - first] };
}
// What the player's next game counts as: a frame, a bonus game, or nothing (card done)
function slotFor(t, pid) {
  const done = t.games.filter(g => g.playerId === pid && g.status !== 'playing');
  const N = t.frames;
  if (done.length < N) return { kind: 'frame', regular: done };
  if (!t.tenthBonus) return { kind: 'done' };
  const all = done.map(g => rollsOf(t, g));
  const last = all[N - 1];
  const need = last.type === 'strike' ? 2 : last.type === 'spare' ? 1 : 0;
  const have = all.slice(N).flatMap(f => f.rolls).length;
  return have < need ? { kind: 'bonus' } : { kind: 'done' };
}
// Work out strike/spare/open from ball-by-ball scores
function derive(g, a) {
  const b = g.balls; if (!Array.isArray(b) || !b.length) return;
  let hit = 0;
  for (let i = 0; i < b.length; i++) if (a.target && b[i] >= a.target) { hit = i + 1; break; }
  if (hit) b.length = hit; // nothing after the target counts
  g.b1 = b[0]; g.final = b[b.length - 1];
  if (hit === 1) { g.hitBall = 1; g.status = 'done'; }
  else if (hit >= 2 && hit <= SPARE_LAST_BALL) { g.hitBall = hit; g.status = 'done'; }
  else if (hit > SPARE_LAST_BALL || b.length >= (a.balls || 3)) { g.hitBall = 0; g.status = 'done'; }
  else { g.hitBall = 0; g.status = 'playing'; }
}
function cleanBalls(list, a) {
  if (!Array.isArray(list) || !list.length) fail(400, 'Enter at least the ball 1 score.');
  const b = list.map(toInt);
  if (b.some(x => x == null)) fail(400, 'Every ball needs a score.');
  if (b.length > (a.balls || 3)) fail(400, `${a.name} is a ${a.balls}-ball game.`);
  for (let i = 1; i < b.length; i++) if (b[i] < b[i - 1]) fail(400, `Ball ${i + 1}'s score can't be lower than ball ${i}'s.`);
  return b;
}

/* ---------------- admin reset from the host ---------------- */
if (process.env.RESET_ADMIN && process.env.RESET_ADMIN.includes(':')) {
  const i = process.env.RESET_ADMIN.indexOf(':');
  const name = process.env.RESET_ADMIN.slice(0, i).trim(), pw = process.env.RESET_ADMIN.slice(i + 1);
  let a = db.admins.find(x => lower(x.name) === lower(name));
  if (!a) { a = { id: uid(), name, createdAt: Date.now() }; db.admins.push(a); }
  Object.assign(a, hashPw(pw));
  console.log(`Admin "${name}" reset. Remove RESET_ADMIN from your settings now.`);
}
save();

function publicT(t) { const { mpRaw, ...rest } = t; return rest; }
function summary(t) { return { id: t.id, name: t.name, status: t.status, createdAt: t.createdAt, players: t.players.length, mpId: t.mpId }; }
function getT(id) { return db.tournaments.find(t => t.id === id) || fail(404, 'Tournament not found.'); }
function openT(id) { const t = getT(id); if (t.status === 'archived') fail(409, 'This tournament is archived. Scores are locked.'); return t; }

/* ---------------- sessions ---------------- */
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function currentAdmin(req) {
  const s = db.sessions[parseCookies(req).pb_session];
  if (!s || s.exp < Date.now()) return null;
  return db.admins.find(a => a.id === s.adminId) || null;
}
function currentPlayer(req) {
  const s = db.playerSessions[parseCookies(req).pb_player];
  if (!s || s.exp < Date.now() || !db.playerAccounts[lower(s.name)]) return null;
  return db.playerAccounts[lower(s.name)].name;
}
function setCookie(res, req, name, val, days) {
  const secure = (req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted) ? '; Secure' : '';
  const prev = res.getHeader('Set-Cookie'); const list = prev ? [].concat(prev) : [];
  list.push(`${name}=${val}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${days * 86400}${secure}`);
  res.setHeader('Set-Cookie', list);
}
function startAdminSession(res, admin, req) {
  const tok = crypto.randomBytes(32).toString('hex');
  db.sessions[tok] = { adminId: admin.id, exp: Date.now() + ADMIN_DAYS * 864e5 };
  for (const [k, s] of Object.entries(db.sessions)) if (s.exp < Date.now()) delete db.sessions[k];
  save(); setCookie(res, req, 'pb_session', tok, ADMIN_DAYS);
}
function startPlayerSession(res, name, req) {
  const tok = crypto.randomBytes(32).toString('hex');
  db.playerSessions[tok] = { name, exp: Date.now() + PLAYER_DAYS * 864e5 };
  for (const [k, s] of Object.entries(db.playerSessions)) if (s.exp < Date.now()) delete db.playerSessions[k];
  save(); setCookie(res, req, 'pb_player', tok, PLAYER_DAYS);
}

const fails = new Map();
function throttle(key, max) {
  const now = Date.now(), rec = (fails.get(key) || []).filter(t => now - t < 15 * 60e3);
  fails.set(key, rec);
  if (rec.length >= max) fail(429, 'Too many wrong tries. Wait 15 minutes and try again.');
  return () => { rec.push(now); fails.set(key, rec); };
}
const ipOf = req => req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;

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
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }, signal: AbortSignal.timeout(15000),
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
    const p = t.players.find(q => q.mpId === id) || t.players.find(q => q.mpId == null && lower(q.name) === lower(name));
    if (p) { p.mpId = id; p.name = name; } else { t.players.push({ id: uid(), name, mpId: id }); addedPlayers++; }
  });
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
    let a = t.arenas.find(q => q.mpId === id) || t.arenas.find(q => q.mpId == null && lower(q.name) === lower(name));
    if (!a) { a = newArena(name, id); t.arenas.push(a); addedArenas++; }
    a.mpId = id; a.name = name;
    // Matchplay's target wins over a saved one, but not over one an admin typed for this tournament
    if (targets[id] && a.targetSource !== 'admin' && a.target !== targets[id]) { a.target = targets[id]; a.targetSource = 'mp'; rederive(t, a); libPut(a); }
    if (balls[id] && !a.ballsSetByAdmin) a.balls = balls[id];
  });
  const samples = {};
  for (const [k, v] of Object.entries(d)) if (Array.isArray(v) && v.length && typeof v[0] === 'object') samples[k] = v[0];
  t.mpRaw = { fetchedAt: Date.now(), tournamentKeys: Object.keys(d), firstItemOfEachList: samples };
  t.lastSync = Date.now(); t.lastSyncError = '';
  save();
  return { addedPlayers, addedArenas };
}
// Re-score ball-by-ball games after a target changes. A finished game stays finished.
function rederive(t, a) {
  t.games.forEach(g => {
    if (g.arenaId !== a.id || !Array.isArray(g.balls)) return;
    const wasDone = g.status === 'done';
    derive(g, a);
    if (wasDone && g.status === 'playing') g.status = 'done';
  });
}

async function autoSync() {
  for (const t of db.tournaments) {
    if (t.status !== 'active' || !t.mpId) continue;
    try { await syncTournament(t); } catch (e) { t.lastSyncError = e.message; }
  }
}
setInterval(() => { autoSync().catch(() => {}); }, SYNC_MS);

/* ---------------- request handling ---------------- */
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) { reject(new HttpError(413, 'Too much data.')); req.destroy(); } });
    req.on('end', () => { if (!data) return resolve({}); try { resolve(JSON.parse(data)); } catch (e) { reject(new HttpError(400, 'Bad request.')); } });
    req.on('error', reject);
  });
}
function adminGame(t, b) {
  const g = { playerId: String(b.playerId || ''), arenaId: String(b.arenaId || ''), hitBall: Number(b.hitBall), b1: toInt(b.b1), final: toInt(b.final) };
  if (!t.players.some(p => p.id === g.playerId)) fail(400, 'Unknown player.');
  if (!t.arenas.some(a => a.id === g.arenaId)) fail(400, 'Unknown machine.');
  if (![0, 1, 2, 3].includes(g.hitBall)) fail(400, 'Pick the ball the target was reached on.');
  if (g.hitBall !== 1 && g.b1 == null) fail(400, 'Enter the score after ball 1.');
  if (g.hitBall === 0 && g.final == null) fail(400, 'Enter the final score.');
  return { ...g, balls: null, status: 'done' };
}
function playerInT(t, name) {
  return t.players.find(p => lower(p.name) === lower(name)) || fail(403, "Your name isn't in this tournament yet. Sign up in Matchplay, then try again in a minute.");
}

async function route(req, res, url) {
  const m = req.method, p = url.pathname;
  const admin = currentAdmin(req), player = currentPlayer(req);
  let mt;

  // ----- public -----
  if (m === 'GET' && p === '/api/state') {
    return send(res, 200, {
      admin: admin ? { id: admin.id, name: admin.name } : null,
      player: player ? { name: player } : null,
      needsSetup: db.admins.length === 0,
      tournaments: db.tournaments.map(summary).sort((a, b) => b.createdAt - a.createdAt),
    });
  }
  if (m === 'GET' && (mt = p.match(/^\/api\/t\/(\w+)$/))) return send(res, 200, publicT(getT(mt[1])));

  // ----- players: PIN and own scores -----
  if (m === 'GET' && p === '/api/player/exists') return send(res, 200, { exists: !!db.playerAccounts[lower(url.searchParams.get('name'))] });
  if (m === 'POST' && p === '/api/player/claim') {
    const b = await readBody(req), name = String(b.name || '').trim(), pin = String(b.pin || '');
    if (!name) fail(400, 'Pick your name.');
    if (!/^\d{4}$/.test(pin)) fail(400, 'Your PIN is 4 digits.');
    const bad = throttle('pin:' + ipOf(req) + ':' + lower(name), 8);
    const acct = db.playerAccounts[lower(name)];
    if (acct) { if (!checkPw(pin, acct)) { bad(); fail(401, 'That PIN is not right. Ask an admin to reset it if you forgot.'); } }
    else db.playerAccounts[lower(name)] = { name, ...hashPw(pin), createdAt: Date.now() };
    startPlayerSession(res, name, req);
    return send(res, 200, { ok: true, created: !acct });
  }
  if (m === 'POST' && p === '/api/player/logout') {
    const tok = parseCookies(req).pb_player; if (tok) { delete db.playerSessions[tok]; save(); }
    setCookie(res, req, 'pb_player', '', 0);
    return send(res, 200, { ok: true });
  }
  if ((mt = p.match(/^\/api\/player\/t\/(\w+)(\/.*)$/))) {
    if (!player) fail(401, 'Pick your name and enter your PIN first.');
    const t = openT(mt[1]), sub = mt[2], me = playerInT(t, player);
    const mine = t.games.filter(g => g.playerId === me.id);
    const playing = mine.find(g => g.status === 'playing');

    if (m === 'POST' && sub === '/ball') {
      const b = await readBody(req), score = toInt(b.score);
      if (score == null) fail(400, 'Enter your score.');
      if (playing) {
        const a = t.arenas.find(x => x.id === playing.arenaId);
        const last = playing.balls[playing.balls.length - 1];
        if (score < last) fail(400, `Your score can't be lower than after ball ${playing.balls.length} (${last.toLocaleString('en-US')}).`);
        playing.balls.push(score); derive(playing, a); playing.editedAt = Date.now();
      } else {
        const a = t.arenas.find(x => x.id === String(b.arenaId || '')) || fail(400, 'Pick a machine.');
        if (!a.active) fail(400, `${a.name} is closed right now.`);
        if (!a.target) fail(400, `${a.name} has no target score yet. Ask an admin.`);
        const slot = slotFor(t, me.id);
        if (slot.kind === 'done') fail(409, 'Your card is complete.');
        if (slot.kind === 'frame' && !t.allowRepeats && slot.regular.some(g => g.arenaId === a.id)) fail(409, `You already played ${a.name}.`);
        const g = { id: uid(), playerId: me.id, arenaId: a.id, balls: [score], ts: Date.now(), by: player };
        derive(g, a); t.games.push(g);
      }
      save(); return send(res, 200, { tournament: publicT(t) });
    }
    if (m === 'PUT' && (mt = sub.match(/^\/games\/(\w+)$/))) {
      const g = mine.find(x => x.id === mt[1]) || fail(404, 'That is not one of your games.');
      if (!Array.isArray(g.balls)) fail(409, 'An admin entered this game. Ask an admin to fix it.');
      const a = t.arenas.find(x => x.id === g.arenaId);
      const b = await readBody(req);
      const trial = { balls: cleanBalls(b.balls, a) }; derive(trial, a);
      if (trial.status === 'playing' && playing && playing.id !== g.id) fail(409, 'Finish your current game first.');
      Object.assign(g, trial, { editedBy: player, editedAt: Date.now() });
      save(); return send(res, 200, { tournament: publicT(t) });
    }
    if (m === 'DELETE' && (mt = sub.match(/^\/games\/(\w+)$/))) {
      const g = mine.find(x => x.id === mt[1]) || fail(404, 'That is not one of your games.');
      if (g.status !== 'playing') fail(409, 'Only a game in progress can be cancelled. Ask an admin to remove a finished game.');
      t.games = t.games.filter(x => x.id !== g.id);
      save(); return send(res, 200, { tournament: publicT(t) });
    }
    fail(404, 'Not found.');
  }

  // ----- admin login -----
  if (m === 'POST' && p === '/api/setup') {
    if (db.admins.length) fail(409, 'Setup is already done. Log in instead.');
    const b = await readBody(req), name = String(b.name || '').trim(), pw = String(b.password || '');
    if (!name || pw.length < 6) fail(400, 'Enter a name and a password of at least 6 characters.');
    const a = { id: uid(), name, createdAt: Date.now(), ...hashPw(pw) };
    db.admins.push(a); save(); startAdminSession(res, a, req);
    return send(res, 200, { ok: true });
  }
  if (m === 'POST' && p === '/api/login') {
    const bad = throttle('admin:' + ipOf(req), 10);
    const b = await readBody(req);
    const a = db.admins.find(x => lower(x.name) === lower(b.name));
    if (!a || !checkPw(String(b.password || ''), a)) { bad(); fail(401, 'That name and password do not match.'); }
    startAdminSession(res, a, req);
    return send(res, 200, { ok: true });
  }
  if (m === 'POST' && p === '/api/logout') {
    const tok = parseCookies(req).pb_session; if (tok) { delete db.sessions[tok]; save(); }
    setCookie(res, req, 'pb_session', '', 0);
    return send(res, 200, { ok: true });
  }

  // ----- admin only from here -----
  if (!p.startsWith('/api/admin/')) fail(404, 'Not found.');
  if (!admin) fail(401, 'Log in as an admin to do that.');

  if (m === 'GET' && p === '/api/admin/settings') {
    return send(res, 200, { hasToken: !!(db.settings.mpToken || process.env.MATCHPLAY_TOKEN), admins: db.admins.map(a => ({ id: a.id, name: a.name })), pins: Object.keys(db.playerAccounts) });
  }
  if (m === 'PUT' && p === '/api/admin/settings') {
    const b = await readBody(req);
    if (typeof b.mpToken === 'string') db.settings.mpToken = b.mpToken.trim();
    save(); return send(res, 200, { ok: true });
  }
  if (m === 'POST' && p === '/api/admin/admins') {
    const b = await readBody(req), name = String(b.name || '').trim(), pw = String(b.password || '');
    if (!name || pw.length < 6) fail(400, 'Enter a name and a password of at least 6 characters.');
    if (db.admins.some(a => lower(a.name) === lower(name))) fail(409, 'There is already an admin with that name.');
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
    const b = await readBody(req), pw = String(b.password || '');
    if (pw.length < 6) fail(400, 'Use at least 6 characters.');
    const a = db.admins.find(x => x.id === mt[1]) || fail(404, 'Admin not found.');
    Object.assign(a, hashPw(pw)); save(); return send(res, 200, { ok: true });
  }
  if (m === 'POST' && p === '/api/admin/pin-reset') {
    const b = await readBody(req), key = lower(b.name);
    delete db.playerAccounts[key];
    for (const [k, s] of Object.entries(db.playerSessions)) if (lower(s.name) === key) delete db.playerSessions[k];
    save(); return send(res, 200, { ok: true });
  }

  if (m === 'POST' && p === '/api/admin/tournaments') {
    const b = await readBody(req);
    const mpId = toInt(String(b.mp || '').match(/tournaments\/(\d+)/)?.[1] ?? b.mp);
    const t = {
      id: uid(), name: String(b.name || '').trim() || 'New tournament', mpId: mpId || null, status: 'active',
      createdAt: Date.now(), frames: 10, tenthBonus: true, allowRepeats: false,
      players: [], arenas: [], games: [], lastSync: null, lastSyncError: '',
    };
    const prev = db.tournaments.slice().sort((a, b) => b.createdAt - a.createdAt)[0];
    if (prev) Object.assign(t, { frames: prev.frames, tenthBonus: prev.tenthBonus, allowRepeats: prev.allowRepeats });
    if (b.copyMachines && prev) t.arenas = prev.arenas.map(a => ({ ...newArena(a.name, a.mpId), active: a.active }));
    db.tournaments.push(t); save();
    let note = '';
    if (t.mpId) { try { await syncTournament(t); } catch (e) { t.lastSyncError = e.message; note = e.message; save(); } }
    return send(res, 200, { tournament: publicT(t), note });
  }
  if (!(mt = p.match(/^\/api\/admin\/t\/(\w+)(\/.*)?$/))) fail(404, 'Not found.');
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
  if (m === 'POST' && sub === '/sync') { const t = openT(tid), r = await syncTournament(t); return send(res, 200, { tournament: publicT(t), ...r }); }
  if (m === 'GET' && sub === '/raw') return send(res, 200, getT(tid).mpRaw || {});

  if (m === 'POST' && sub === '/players') {
    const t = openT(tid), b = await readBody(req), name = String(b.name || '').trim();
    if (!name) fail(400, 'Enter a name.');
    if (t.players.some(x => lower(x.name) === lower(name))) fail(409, 'That player is already here.');
    t.players.push({ id: uid(), name, mpId: null }); save();
    return send(res, 200, { tournament: publicT(t) });
  }
  if (m === 'DELETE' && (mt = sub.match(/^\/players\/(\w+)$/))) {
    const t = openT(tid);
    t.games = t.games.filter(g => g.playerId !== mt[1]); t.players = t.players.filter(x => x.id !== mt[1]); save();
    return send(res, 200, { tournament: publicT(t) });
  }

  if (m === 'POST' && sub === '/arenas') {
    const t = openT(tid), b = await readBody(req), name = String(b.name || '').trim();
    if (!name) fail(400, 'Enter a machine name.');
    t.arenas.push(newArena(name, null)); save();
    return send(res, 200, { tournament: publicT(t) });
  }
  if (m === 'PATCH' && (mt = sub.match(/^\/arenas\/(\w+)$/))) {
    const t = openT(tid), b = await readBody(req);
    const a = t.arenas.find(x => x.id === mt[1]) || fail(404, 'Machine not found.');
    if (typeof b.name === 'string' && b.name.trim()) a.name = b.name.trim();
    if (typeof b.abbr === 'string') a.abbr = cleanAbbr(b.abbr) || abbrOf(a.name);
    if (b.balls === 3 || b.balls === 5) { a.balls = b.balls; a.ballsSetByAdmin = true; }
    if (b.target !== undefined) { a.target = toInt(b.target) || 0; a.targetSource = a.target ? 'admin' : ''; }
    if (typeof b.active === 'boolean') a.active = b.active;
    rederive(t, a); libPut(a); save();
    return send(res, 200, { tournament: publicT(t) });
  }
  if (m === 'DELETE' && (mt = sub.match(/^\/arenas\/(\w+)$/))) {
    const t = openT(tid);
    t.games = t.games.filter(g => g.arenaId !== mt[1]); t.arenas = t.arenas.filter(x => x.id !== mt[1]); save();
    return send(res, 200, { tournament: publicT(t) });
  }

  if (m === 'POST' && sub === '/games') {
    const t = openT(tid), g = adminGame(t, await readBody(req));
    if (t.games.some(x => x.playerId === g.playerId && x.status === 'playing')) fail(409, 'This player has a game in progress. Finish or delete it first.');
    t.games.push({ id: uid(), ...g, ts: Date.now(), by: admin.name }); save();
    return send(res, 200, { tournament: publicT(t) });
  }
  if (m === 'PUT' && (mt = sub.match(/^\/games\/(\w+)$/))) {
    const t = openT(tid), g = adminGame(t, await readBody(req));
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
  fail(404, 'Not found.');
}

const PUBLIC = path.join(__dirname, 'public');
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
  const isQr = url.pathname === '/qrcode.js';
  fs.readFile(path.join(PUBLIC, isQr ? 'qrcode.js' : 'index.html'), (err, body) => {
    if (err) { res.writeHead(500); return res.end(`Missing public/${isQr ? 'qrcode.js' : 'index.html'}`); }
    res.writeHead(200, { 'Content-Type': isQr ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8', 'Cache-Control': isQr ? 'public, max-age=86400' : 'no-cache' });
    res.end(body);
  });
});
server.listen(PORT, () => console.log(`Pinbowl running on port ${PORT}. Data folder: ${DATA_DIR}`));
