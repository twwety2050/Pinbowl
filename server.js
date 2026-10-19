// Pinbowl server. Needs Node.js 18 or newer. No extra packages required.
// Stores everything in one file: DATA_DIR/db.json (plus one daily backup copy).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
// Matchplay moved its API to the api. subdomain. The website itself stays at app.matchplay.events.
const MP = process.env.MP_BASE || 'https://api.matchplay.events';
const SYNC_MS = Number(process.env.SYNC_SECONDS || 60) * 1000;
const ADMIN_DAYS = 30, PLAYER_DAYS = 365;
const SPARE_LAST_BALL = 3;

/* ---------------- storage ---------------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
function emptyDb() {
  return { admins: [], sessions: {}, settings: { mpToken: '' }, tournaments: [], machines: [], scorekeepers: [], playerAccounts: {}, playerSessions: {} };
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
// Machine categories. A full card is 4 of each: 3/3/4 in frames 1-10, then 11 and 12 from the two short ones.
const CATS = ['classic', 'mid', 'modern'];
const cleanCat = c => CATS.includes(String(c || '').toLowerCase()) ? String(c).toLowerCase() : '';
// Stored machines: every machine ever used, with its saved target, ball count and short name.
// A tournament's machine (arena) points at its stored machine with arena.mid.
function storedFor(a) {
  return (a.mid && db.machines.find(m => m.id === a.mid))
    || (a.mpId != null && db.machines.find(m => m.mpId === a.mpId))
    || db.machines.find(m => lower(m.name) === lower(a.name)) || null;
}
function remember(a, when = Date.now()) {
  let m = storedFor(a);
  if (!m) { m = { id: uid(), name: a.name, mpId: a.mpId ?? null, target: 0, balls: 3, abbr: a.abbr || abbrOf(a.name), inDraw: true, addedAt: when }; db.machines.push(m); }
  a.mid = m.id; m.name = a.name;
  if (a.mpId != null) m.mpId = a.mpId;
  if (a.target) m.target = a.target;
  if (a.balls) m.balls = a.balls;
  if (a.abbr) m.abbr = a.abbr;
  if (a.cat) m.cat = a.cat;
  m.lastUsed = Math.max(m.lastUsed || 0, when);
  return m;
}
const libPut = a => remember(a);
function newArena(name, mpId) {
  const a = { id: uid(), name, mpId: mpId ?? null, balls: 3, target: 0, active: true, abbr: abbrOf(name), targetSource: '' };
  const l = storedFor(a);
  if (l) { a.target = l.target || 0; a.balls = l.balls || 3; a.abbr = l.abbr || a.abbr; a.cat = l.cat || ''; if (a.target) a.targetSource = 'saved'; }
  return a;
}
// Upgrade data from earlier versions and build the stored machines list from past tournaments.
if (!Array.isArray(db.machines)) db.machines = [];
if (!Array.isArray(db.scorekeepers)) db.scorekeepers = [];
db.tournaments.sort((a, b) => a.createdAt - b.createdAt).forEach(t => t.arenas.forEach(a => {
  if (!a.abbr) a.abbr = abbrOf(a.name);
  if (!a.targetSource) a.targetSource = a.targetFromMp ? 'mp' : (a.target ? 'admin' : '');
  remember(a, t.createdAt);
}));
delete db.machineLib;

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
  return have < need ? { kind: 'bonus', idx: done.length - N } : { kind: 'done' };
}

/* ---------------- bonus frames 11 and 12: one random machine each, the same for everyone ---------------- */
// Highest bonus game anyone needs right now: -1 none, 0 frame 11, 1 frame 12.
function bonusNeeded(t) {
  if (!t.tenthBonus) return -1;
  const N = t.frames; let max = -1;
  for (const p of t.players) {
    const done = t.games.filter(g => g.playerId === p.id && g.status !== 'playing');
    if (done.length < N) continue;
    const last = rollsOf(t, done[N - 1]);
    if (last.type === 'open') continue;
    max = Math.max(max, 0);
    if (last.type === 'strike' && done[N] && rollsOf(t, done[N]).type === 'strike') max = 1;
  }
  return max;
}
function arenaForStored(t, m) {
  let a = t.arenas.find(x => x.mid === m.id)
    || t.arenas.find(x => (m.mpId != null && x.mpId === m.mpId) || lower(x.name) === lower(m.name));
  if (!a) { a = newArena(m.name, m.mpId); a.active = false; a.bonusOnly = true; t.arenas.push(a); }
  a.mid = m.id;
  if (!a.target) { a.target = m.target; a.targetSource = 'saved'; }
  return a;
}
// Pick the machine for bonus game idx: the one asked for, or a random stored machine with a target,
// from the category this tournament is shortest on (so 3/3/4 ends up 4/4/4), never one already in it.
function pickBonus(t, idx, machineId) {
  t.bonusArenas = t.bonusArenas || [];
  const otherIds = t.bonusArenas.filter((id, i) => i !== idx && id);
  const regular = t.arenas.filter(a => a.active && !a.bonusOnly && !t.bonusArenas.includes(a.id));
  const others = otherIds.map(id => t.arenas.find(a => a.id === id)).filter(Boolean);
  const current = t.arenas.find(a => a.id === t.bonusArenas[idx]);
  const used = new Set([...regular, ...others, current].filter(Boolean).map(a => a.mid).filter(Boolean));
  let m;
  if (machineId) m = db.machines.find(x => x.id === machineId) || fail(404, 'Machine not found.');
  else {
    const counts = {}; CATS.forEach(c => counts[c] = 0);
    [...regular, ...others].forEach(a => { if (counts[a.cat] != null) counts[a.cat]++; });
    const anyCats = [...regular, ...others].some(a => a.cat);
    const base = db.machines.filter(x => x.target > 0 && x.inDraw !== false && !used.has(x.id));
    // try the shortest category first (ties picked at random), then the next, then anything
    const order = anyCats ? CATS.filter(c => counts[c] < 4).sort((a, b) => (counts[a] - counts[b]) || (crypto.randomInt(3) - 1)) : [];
    let pool = [];
    for (const c of order) { pool = base.filter(x => x.cat === c); if (pool.length) break; }
    if (!pool.length) pool = base;
    if (!pool.length) return null;
    m = pool[crypto.randomInt(pool.length)];
  }
  if (!m.target) fail(400, `${m.name} has no target score. Set one on the Stored machines tab first.`);
  const a = arenaForStored(t, m);
  t.bonusArenas[idx] = a.id; t.bonusDrawnAt = Date.now();
  return a;
}
// Draw frame 11 the first time someone needs it, and frame 12 the first time someone strikes 10 and 11.
function ensureBonus(t) {
  const need = bonusNeeded(t);
  t.bonusArenas = t.bonusArenas || [];
  for (let i = 0; i <= need; i++) {
    if (!t.bonusArenas[i] || !t.arenas.some(a => a.id === t.bonusArenas[i])) pickBonus(t, i);
  }
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
function summary(t) { return { id: t.id, name: t.name, status: t.status, createdAt: t.createdAt, players: t.players.length, mpId: t.mpId, daily: !!t.daily, end: t.daily ? t.daily.end : null, finals: !!t.finals, done: !!t.done }; }

/* ---------------- NPC Daily Pinbowl Challenge ---------------- */
// Runs by itself: Friday 5 pm to midnight, Saturday and Sunday 11 am to 7 pm, Central time.
const TZ = 'America/Chicago';
const nowMs = () => Date.now() + Number(process.env.TIME_SHIFT_MS || 0); // TIME_SHIFT_MS is only for testing
const DAILY_HOURS = { Fri: [17, 24], Sat: [11, 19], Sun: [11, 19] };
function zoned(ms) {
  const o = {};
  new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).forEach(x => { o[x.type] = x.value; });
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, min: +o.minute, wd: o.weekday };
}
// Central wall-clock time to a real moment (handles daylight saving)
function zonedToMs(y, m, d, h, min = 0) {
  const want = Date.UTC(y, m - 1, d, h, min); let t = want;
  for (let i = 0; i < 3; i++) { const z = zoned(t); t += want - Date.UTC(z.y, z.m - 1, z.d, z.h, z.min); }
  return t;
}
// The challenge window for a Central calendar day, or null if there isn't one that day
function windowFor(y, m, d) {
  const noon = zonedToMs(y, m, d, 12), wd = zoned(noon).wd, hrs = DAILY_HOURS[wd];
  if (!hrs) return null;
  const start = zonedToMs(y, m, d, hrs[0]), end = zonedToMs(y, m, d, hrs[1]);
  const key = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const label = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(noon));
  return { key, start, end, label };
}
function nextWindow(from = nowMs()) {
  const z = zoned(from);
  for (let i = 0; i < 8; i++) {
    const day = new Date(Date.UTC(z.y, z.m - 1, z.d + i));
    const w = windowFor(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate());
    if (w && w.end > from) return w;
  }
  return null;
}
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
// 3 Classic, 3 Mid, 3 Modern, then 1 more from any category, from stored machines with a target
function pickDailyMachines() {
  const pool = shuffle(db.machines.filter(m => m.target > 0 && m.inDraw !== false));
  const picked = [];
  for (const c of CATS) picked.push(...pool.filter(m => m.cat === c).slice(0, 3));
  const rest = pool.filter(m => !picked.includes(m));
  while (picked.length < 10 && rest.length) picked.push(rest.shift());
  return picked;
}
function createDaily(w, manual) {
  const t = {
    id: uid(), name: `NPC Daily Pinbowl Challenge - ${w.label}`, mpId: null, status: 'active',
    createdAt: nowMs(), frames: 10, tenthBonus: true, allowRepeats: false,
    players: [], arenas: [], games: [], lastSync: null, lastSyncError: '',
    daily: { key: manual ? 'manual-' + nowMs() : w.key, start: w.start, end: w.end },
  };
  t.arenas = pickDailyMachines().map(m => { const a = newArena(m.name, m.mpId); a.mid = m.id; a.cat = m.cat || ''; remember(a, t.createdAt); return a; });
  db.tournaments.push(t); save();
  console.log(`Started ${t.name} with ${t.arenas.length} machines.`);
  return t;
}
// Bowling total for one player, counting only finished games (same scoring as the page)
function totalFor(t, pid) {
  const N = t.frames, all = t.games.filter(g => g.playerId === pid && g.status !== 'playing').map(g => rollsOf(t, g));
  const reg = all.slice(0, N), rolls = all.flatMap(f => f.rolls); let idx = 0, total = 0;
  reg.forEach((f, k) => {
    const own = f.rolls.length; let need = f.type === 'strike' ? 2 : f.type === 'spare' ? 1 : 0;
    if (k === N - 1 && !t.tenthBonus) need = 0;
    total += (f.type === 'open' ? f.rolls[0] + f.rolls[1] : 10) + rolls.slice(idx + own, idx + own + need).reduce((a, b) => a + b, 0);
    idx += own;
  });
  return total;
}
function closeDaily(t) {
  const scores = t.players.map(p => ({ name: p.name, total: totalFor(t, p.id) })).sort((a, b) => b.total - a.total);
  const top = scores.length && scores[0].total > 0 ? scores[0].total : null;
  t.winners = top == null ? [] : scores.filter(x => x.total === top);
  t.status = 'archived'; t.endedAt = nowMs(); save();
  console.log(`Closed ${t.name}. Winner: ${t.winners.map(w => w.name).join(', ') || 'none'}.`);
}
function dailyTick() {
  const now = nowMs();
  for (const t of db.tournaments) if (t.daily && t.status === 'active' && now >= t.daily.end) closeDaily(t);
  if (db.settings.dailyOn === false) return;
  const w = nextWindow(now);
  if (w && now >= w.start && now < w.end && !db.tournaments.some(t => t.daily && t.daily.key === w.key)) createDaily(w);
}
setInterval(() => { try { dailyTick(); } catch (e) { console.error(e); } }, 30000);
setTimeout(() => { try { dailyTick(); } catch (e) { console.error(e); } }, 2000);
function getT(id) { return db.tournaments.find(t => t.id === id) || fail(404, 'Tournament not found.'); }
function openT(id) {
  const t = getT(id);
  if (t.daily && t.status === 'active' && nowMs() >= t.daily.end) closeDaily(t); // a challenge locks the moment it ends
  if (t.status === 'archived') fail(409, t.daily ? 'This challenge has closed. Scores are locked.' : 'This tournament is archived. Scores are locked.');
  return t;
}
// Qualifying scores lock while a tournament is marked Done (undo Done to change them)
function scoringT(id) {
  const t = openT(id);
  if (t.done) fail(409, 'This tournament is marked done. Undo "Done" on the Finals tab to change scores.');
  if (t.finals) fail(409, 'Finals scores are entered on the Finals tab.');
  return t;
}

/* ---------------- Finals: PAPA-style groups, 3 games each, scored as a 3-frame pinbowl card ---------------- */
// Finalists: the number the admin set, or the top half rounded down
function finalsCount(t) { const n = t.players.length; return Math.max(0, Math.min(n, t.finalsCount ? t.finalsCount : Math.floor(n / 2))); }
// Seed order: by qualifying total, unless an admin set the order by hand
function seedOrder(t) {
  const tot = new Map(t.players.map(p => [p.id, totalFor(t, p.id)]));
  let order = t.players.slice().sort((a, b) => tot.get(b.id) - tot.get(a.id) || a.name.localeCompare(b.name)).map(p => p.id);
  if (Array.isArray(t.seedOverride)) { const ov = t.seedOverride.filter(id => order.includes(id)); order = [...ov, ...order.filter(id => !ov.includes(id))]; }
  return { order, tot };
}
// Deal seeds into groups like PAPA: 1-8-9-16, 2-7-10-15, 3-6-11-14, 4-5-12-13
function snake(seeds, groups) {
  const out = Array.from({ length: groups }, () => []);
  seeds.forEach((s, i) => { const row = Math.floor(i / groups), col = i % groups; out[row % 2 === 0 ? col : groups - 1 - col].push(s); });
  return out;
}
// Round 1: the top seeds get byes so round 2 is a full 4, 8, 16 or 32
function planFirstRound(N) {
  if (N <= 4) return { byes: 0, groups: 1 };
  let S = 4; while (S * 2 <= N) S *= 2;
  if (N === S) return { byes: 0, groups: S / 4 };
  const g = Math.ceil((N - S) / 2);
  return { byes: S - 2 * g, groups: g };
}
const LETTERS = 'ABCDEFGHIJKLMNOP';
function makeGroups(F, seedNums, groupCount) {
  return snake(seedNums.slice().sort((a, b) => a - b), groupCount).map((ss, i) => ({
    id: uid(), label: LETTERS[i] || String(i + 1), seeds: ss, players: ss.map(s => F.finals.seeds[s - 1].pid),
    machines: [], positions: {}, scores: {}, order: null,
  }));
}
// One player's 3 games as a mini bowling card: strikes and spares carry into the next game, game 3 counts flat
function groupCard(F, g, pid) {
  const res = (g.scores[pid] || []), frames = g.machines.map((aid, i) => res[i] && res[i].status !== 'playing' ? rollsOf(F, { arenaId: aid, ...res[i] }) : null);
  let total = 0;
  frames.forEach((f, k) => {
    if (!f) return;
    const need = k === frames.length - 1 ? 0 : (f.type === 'strike' ? 2 : f.type === 'spare' ? 1 : 0);
    const next = frames.slice(k + 1).filter(Boolean).flatMap(x => x.rolls).slice(0, need);
    total += (f.type === 'open' ? f.rolls[0] + f.rolls[1] : 10) + next.reduce((a, b) => a + b, 0);
  });
  return { total, complete: g.machines.length === 3 && frames.every(Boolean) };
}
function groupResult(F, g, final) {
  const rows = g.players.map(pid => ({ pid, seed: F.finals.seeds.find(s => s.pid === pid).seed, ...groupCard(F, g, pid) }));
  const complete = rows.every(r => r.complete);
  let ranked = rows.slice().sort((a, b) => b.total - a.total || a.seed - b.seed);
  if (Array.isArray(g.order) && g.order.length === rows.length) ranked = g.order.map(pid => rows.find(r => r.pid === pid)).filter(Boolean);
  let tie = false;
  if (complete && !g.order) {
    const t = ranked.map(r => r.total);
    tie = final ? t.some((v, i) => i > 0 && v === t[i - 1]) : (t.length > 2 && t[1] === t[2]);
  }
  return { rows, ranked, complete, tie };
}
function checkPicks(F, ms) {
  if (ms.length !== 3 || new Set(ms).size !== 3 || ms.some(id => !F.arenas.some(a => a.id === id))) fail(400, 'Pick 3 different machines.');
  const cats = ms.map(id => F.arenas.find(a => a.id === id).cat || '');
  if (CATS.every(c => F.arenas.some(a => a.cat === c)) && new Set(cats).size !== 3) fail(400, 'Pick one Classic, one Mid and one Modern.');
}
const seedOf = (F, pid) => (F.finals.seeds.find(x => x.pid === pid) || {}).seed || 99;
// Groups pick their games in order of their top seed (the group with seed 1 first)
const groupTopSeed = (F, g) => Math.min(...g.players.map(pid => seedOf(F, pid)));
function groupsBefore(F, round, g) { const s = groupTopSeed(F, g); return round.groups.filter(x => x !== g && groupTopSeed(F, x) < s); }
// The same machine can't be in the same game slot as another group in this round
function checkSlots(F, round, g, ms) {
  for (const x of round.groups) {
    if (x === g || x.machines.length !== 3) continue;
    ms.forEach((id, i) => { if (x.machines[i] === id) fail(400, `Group ${x.label} already has ${(F.arenas.find(a => a.id === id) || {}).name || 'that machine'} as game ${i + 1}. Pick it for a different game, or pick another machine.`); });
  }
}
// Position picks go 2nd seed, 3rd, 4th, then the top seed
function pickOrder(F, g) { const by = g.players.slice().sort((a, b) => seedOf(F, a) - seedOf(F, b)); return [...by.slice(1), by[0]]; }
function createFinals(t) {
  const { order, tot } = seedOrder(t), N = finalsCount(t);
  if (N < 2) fail(409, 'Finals need at least 2 players.');
  const keep = new Set([...t.arenas.filter(a => a.active && !a.bonusOnly).map(a => a.id), ...(t.bonusArenas || [])]);
  const F = {
    id: uid(), name: `${t.name} Finals`, mpId: null, status: 'active', createdAt: Date.now(),
    frames: 3, tenthBonus: false, allowRepeats: true, players: [], games: [],
    arenas: t.arenas.filter(a => keep.has(a.id) && a.target).map(a => ({ ...a, active: true })),
    finals: { parentId: t.id, seeds: [], byes: 0, rounds: [], champion: null, places: null },
  };
  order.slice(0, N).forEach((pid, i) => {
    const p = t.players.find(x => x.id === pid);
    F.players.push({ id: p.id, name: p.name, mpId: p.mpId ?? null });
    F.finals.seeds.push({ pid, name: p.name, seed: i + 1, qual: tot.get(pid) });
  });
  const plan = planFirstRound(N); F.finals.byes = plan.byes;
  const r1 = Array.from({ length: N - plan.byes }, (_, i) => plan.byes + i + 1);
  F.finals.rounds.push({ groups: makeGroups(F, r1, plan.groups), final: N <= 4 });
  db.tournaments.push(F); t.finalsId = F.id; save();
  return F;
}
function nextRound(F) {
  const fin = F.finals, cur = fin.rounds[fin.rounds.length - 1];
  const results = cur.groups.map(g => groupResult(F, g, cur.final));
  if (results.some(r => !r.complete)) fail(409, 'Every group needs all 3 games entered first.');
  if (results.some(r => r.tie)) fail(409, 'A group has a tie. Set its finishing order first.');
  if (cur.final) { fin.places = results[0].ranked.map(r => r.pid); fin.champion = fin.places[0]; save(); return; }
  const seeds = results.flatMap(r => r.ranked.slice(0, 2).map(x => x.seed));
  if (fin.rounds.length === 1) for (let s = 1; s <= fin.byes; s++) seeds.push(s);
  fin.rounds.push({ groups: makeGroups(F, seeds, Math.max(1, Math.floor(seeds.length / 4))), final: seeds.length <= 4 });
  save();
}

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
    remember(a, t.createdAt);
  });
  ensureBonus(t);
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
    if (t.status !== 'active' || !t.mpId || t.done) continue;
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
      player: player ? { name: player, scorekeeper: db.scorekeepers.includes(lower(player)) } : null,
      needsSetup: db.admins.length === 0,
      tournaments: db.tournaments.map(summary).sort((a, b) => b.createdAt - a.createdAt),
    });
  }
  if (m === 'GET' && (mt = p.match(/^\/api\/t\/(\w+)$/))) return send(res, 200, publicT(getT(mt[1])));
  if (m === 'GET' && p === '/api/players/known') {
    const names = new Map();
    db.tournaments.forEach(t => t.players.forEach(x => names.set(lower(x.name), x.name)));
    Object.values(db.playerAccounts).forEach(a => { if (!names.has(lower(a.name))) names.set(lower(a.name), a.name); });
    return send(res, 200, { names: [...names.values()].sort((a, b) => a.localeCompare(b)) });
  }

  // ----- players: PIN and own scores -----
  if (m === 'GET' && p === '/api/player/exists') return send(res, 200, { exists: !!db.playerAccounts[lower(url.searchParams.get('name'))] });
  if (m === 'POST' && p === '/api/player/claim') {
    const b = await readBody(req), name = String(b.name || '').trim(), pin = String(b.pin || '');
    if (!name) fail(400, 'Pick your name.');
    if (name.length > 40) fail(400, 'Use a shorter name.');
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
  if (m === 'POST' && (mt = p.match(/^\/api\/player\/t\/(\w+)\/join$/))) {
    if (!player) fail(401, 'Pick your name and enter your PIN first.');
    const t = scoringT(mt[1]);
    if (!t.daily) fail(409, 'Sign up for this tournament in Matchplay.');
    if (nowMs() >= t.daily.end) fail(409, 'This challenge has closed.');
    if (!t.players.some(x => lower(x.name) === lower(player))) { t.players.push({ id: uid(), name: player, mpId: null, joinedAt: nowMs() }); save(); }
    return send(res, 200, { tournament: publicT(t) });
  }
  if (m === 'POST' && (mt = p.match(/^\/api\/player\/t\/(\w+)\/finals\/(pick|ball|fix|cancel)$/))) {
    if (!player) fail(401, 'Pick your name and enter your PIN first.');
    const F = openT(mt[1]), act = mt[2], b = await readBody(req);
    if (!F.finals) fail(409, 'This is not a finals tournament.');
    const fin = F.finals; if (fin.champion) fail(409, 'The finals are finished.');
    const round = fin.rounds[fin.rounds.length - 1];
    const me = F.players.find(x => lower(x.name) === lower(player)) || fail(403, "You're not in these finals.");
    const g = round.groups.find(x => x.players.includes(me.id)) || fail(409, "You're not playing in this round.");
    const order = pickOrder(F, g), top = order[order.length - 1], N = g.players.length;
    const nameOf = pid => (F.players.find(x => x.id === pid) || {}).name || 'someone';
    if (act === 'pick') {
      if (Array.isArray(b.machines)) {
        if (me.id !== top) fail(403, 'The top seed in your group picks the games.');
        if (g.machines.length === 3) fail(409, 'The games are already picked.');
        const wait = groupsBefore(F, round, g).sort((a, c) => groupTopSeed(F, a) - groupTopSeed(F, c)).find(x => x.machines.length !== 3);
        if (wait) fail(409, `Group ${wait.label} picks their games before your group.`);
        const ms = b.machines.map(String); checkPicks(F, ms); checkSlots(F, round, g, ms); g.machines = ms;
      } else {
        if (g.machines.length !== 3) fail(409, 'The games get picked first.');
        const turn = order.find(pid => !g.positions[pid]);
        if (!turn) fail(409, 'Every position is already picked.');
        if (turn !== me.id) fail(409, `It's ${nameOf(turn)}'s turn to pick.`);
        const n = parseInt(b.position, 10);
        if (!(n >= 1 && n <= N) || Object.values(g.positions).includes(n)) fail(400, 'That position is taken.');
        g.positions[me.id] = n;
        // the last player gets the spot that's left
        const left = order.filter(pid => !g.positions[pid]);
        if (left.length === 1) g.positions[left[0]] = Array.from({ length: N }, (_, i) => i + 1).find(x => !Object.values(g.positions).includes(x));
      }
      save(); return send(res, 200, { tournament: publicT(F) });
    }
    if (g.machines.length !== 3 || Object.keys(g.positions).length !== N) fail(409, 'Games and positions need to be picked first.');
    g.scores[me.id] = g.scores[me.id] || [null, null, null];
    const mine = g.scores[me.id];
    if (act === 'ball') {
      const score = toInt(b.score); if (score == null) fail(400, 'Enter your score.');
      let i = mine.findIndex(r => r && r.status === 'playing');
      if (i < 0) { i = mine.findIndex(r => !r); if (i < 0) fail(409, 'All 3 of your games are done.'); mine[i] = { balls: [], by: player }; }
      const r = mine[i], a = F.arenas.find(x => x.id === g.machines[i]);
      const last = r.balls[r.balls.length - 1];
      if (last != null && score < last) fail(400, `Your score can't be lower than after ball ${r.balls.length} (${last.toLocaleString('en-US')}).`);
      r.balls.push(score); derive(r, a); r.at = Date.now();
    }
    if (act === 'fix') {
      const i = parseInt(b.game, 10), r = mine[i];
      if (!r || !Array.isArray(r.balls)) fail(409, 'A scorekeeper entered this game. Ask them to fix it.');
      const a = F.arenas.find(x => x.id === g.machines[i]), trial = { balls: cleanBalls(b.balls, a) }; derive(trial, a);
      if (trial.status === 'playing' && mine.some((x, j) => j !== i && x && x.status === 'playing')) fail(409, 'Finish your current game first.');
      Object.assign(r, trial, { at: Date.now() });
    }
    if (act === 'cancel') { const i = mine.findIndex(r => r && r.status === 'playing'); if (i >= 0) mine[i] = null; }
    if (!mine.some(Boolean)) delete g.scores[me.id];
    g.order = null; save(); return send(res, 200, { tournament: publicT(F) });
  }
  if ((mt = p.match(/^\/api\/player\/t\/(\w+)(\/.*)$/))) {
    if (!player) fail(401, 'Pick your name and enter your PIN first.');
    const t = scoringT(mt[1]), sub = mt[2], me = playerInT(t, player);
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
        const slot = slotFor(t, me.id);
        if (slot.kind === 'done') fail(409, 'Your card is complete.');
        let a;
        if (slot.kind === 'bonus') {
          // everyone plays the same drawn machine for frames 11 and 12
          ensureBonus(t);
          a = t.arenas.find(x => x.id === t.bonusArenas[slot.idx]) || fail(409, 'The bonus machine has not been picked yet. Ask an admin.');
        } else {
          a = t.arenas.find(x => x.id === String(b.arenaId || '')) || fail(400, 'Pick a machine.');
          if (!a.active) fail(400, `${a.name} is closed right now.`);
        }
        if (!a.target) fail(400, `${a.name} has no target score yet. Ask an admin.`);
        if (slot.kind === 'frame' && !t.allowRepeats && slot.regular.some(g => g.arenaId === a.id)) fail(409, `You already played ${a.name}.`);
        const g = { id: uid(), playerId: me.id, arenaId: a.id, balls: [score], ts: Date.now(), by: player };
        derive(g, a); t.games.push(g);
      }
      ensureBonus(t); save(); return send(res, 200, { tournament: publicT(t) });
    }
    if (m === 'PUT' && (mt = sub.match(/^\/games\/(\w+)$/))) {
      const g = mine.find(x => x.id === mt[1]) || fail(404, 'That is not one of your games.');
      if (!Array.isArray(g.balls)) fail(409, 'An admin entered this game. Ask an admin to fix it.');
      const a = t.arenas.find(x => x.id === g.arenaId);
      const b = await readBody(req);
      const trial = { balls: cleanBalls(b.balls, a) }; derive(trial, a);
      if (trial.status === 'playing' && playing && playing.id !== g.id) fail(409, 'Finish your current game first.');
      Object.assign(g, trial, { editedBy: player, editedAt: Date.now() });
      ensureBonus(t); save(); return send(res, 200, { tournament: publicT(t) });
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

  // ----- admin only from here (scorekeepers may enter, fix and remove games) -----
  if (!p.startsWith('/api/admin/')) fail(404, 'Not found.');
  const keeper = !admin && player && db.scorekeepers.includes(lower(player)) ? player : null;
  if (!admin && !(keeper && /^\/api\/admin\/t\/\w+\/(games(\/\w+(\/move)?)?|finals\/(picks|score|order))$/.test(p))) fail(401, 'Log in as an admin to do that.');
  const actor = admin ? admin.name : keeper;

  if (m === 'GET' && p === '/api/admin/settings') {
    return send(res, 200, { hasToken: !!(db.settings.mpToken || process.env.MATCHPLAY_TOKEN), admins: db.admins.map(a => ({ id: a.id, name: a.name })), pins: Object.keys(db.playerAccounts), scorekeepers: db.scorekeepers,
      daily: { on: db.settings.dailyOn !== false, next: nextWindow(), running: (db.tournaments.find(t => t.daily && t.status === 'active') || {}).id || null } });
  }
  if (m === 'POST' && p === '/api/admin/daily/start') {
    const now = nowMs(), w = nextWindow(now), open = w && now >= w.start;
    const label = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(now));
    const t = createDaily({ key: '', start: now, end: open ? w.end : now + 8 * 3600e3, label }, true);
    return send(res, 200, { tournament: publicT(t) });
  }
  if (m === 'POST' && p === '/api/admin/daily/end') {
    const b = await readBody(req), t = getT(String(b.id || ''));
    if (!t.daily || t.status !== 'active') fail(409, 'That challenge is not running.');
    t.daily.end = Math.min(t.daily.end, nowMs()); closeDaily(t);
    return send(res, 200, { tournament: publicT(t) });
  }
  if (m === 'POST' && p === '/api/admin/scorekeepers') {
    const b = await readBody(req), key = lower(b.name);
    if (!key) fail(400, 'Pick a player.');
    db.scorekeepers = db.scorekeepers.filter(n => n !== key);
    if (b.on) db.scorekeepers.push(key);
    save(); return send(res, 200, { scorekeepers: db.scorekeepers });
  }
  if (m === 'PUT' && p === '/api/admin/settings') {
    const b = await readBody(req);
    if (typeof b.mpToken === 'string') db.settings.mpToken = b.mpToken.trim();
    if (typeof b.dailyOn === 'boolean') db.settings.dailyOn = b.dailyOn;
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

  // ----- stats: every finished game in open and archived tournaments (deleted ones are gone) -----
  if (m === 'GET' && p === '/api/admin/stats') {
    const games = [];
    for (const t of db.tournaments) {
      if (t.status !== 'active' && t.status !== 'archived') continue;
      for (const g of t.games) {
        if (g.status === 'playing') continue;
        const a = t.arenas.find(x => x.id === g.arenaId);
        if (!a || !a.target) continue;
        games.push({
          key: a.mid || 'name:' + lower(a.name), name: a.name, cat: a.cat || '', target: a.target, nb: a.balls || 3,
          balls: Array.isArray(g.balls) ? g.balls : null, b1: g.b1, final: g.final, hit: g.hitBall,
          tid: t.id, tname: t.name, daily: !!t.daily, when: t.createdAt,
        });
      }
    }
    return send(res, 200, { games, machines: db.machines.map(x => ({ id: x.id, name: x.name, abbr: x.abbr, cat: x.cat || '', target: x.target, balls: x.balls })) });
  }

  // ----- stored machines -----
  if (m === 'GET' && p === '/api/admin/machines') {
    const list = db.machines.map(x => {
      let tournaments = 0, games = 0, current = false;
      for (const t of db.tournaments) {
        const ids = t.arenas.filter(a => a.mid === x.id).map(a => a.id);
        if (!ids.length) continue;
        tournaments++; games += t.games.filter(g => ids.includes(g.arenaId) && g.status !== 'playing').length;
        if (t.status === 'active') current = true;
      }
      return { ...x, tournaments, games, current };
    }).sort((a, b) => a.name.localeCompare(b.name));
    return send(res, 200, { machines: list });
  }
  if (m === 'POST' && p === '/api/admin/machines') {
    const b = await readBody(req), name = String(b.name || '').trim();
    if (!name) fail(400, 'Enter a machine name.');
    if (db.machines.some(x => lower(x.name) === lower(name))) fail(409, 'That machine is already stored.');
    const x = { id: uid(), name, mpId: null, target: toInt(b.target) || 0, balls: b.balls === 5 ? 5 : 3, abbr: cleanAbbr(b.abbr) || abbrOf(name), cat: cleanCat(b.cat), inDraw: true, addedAt: Date.now() };
    db.machines.push(x); save();
    return send(res, 200, { machine: x });
  }
  if (m === 'PATCH' && (mt = p.match(/^\/api\/admin\/machines\/(\w+)$/))) {
    const x = db.machines.find(y => y.id === mt[1]) || fail(404, 'Machine not found.'), b = await readBody(req);
    if (typeof b.abbr === 'string') x.abbr = cleanAbbr(b.abbr) || abbrOf(x.name);
    if (b.balls === 3 || b.balls === 5) x.balls = b.balls;
    if (b.target !== undefined) x.target = toInt(b.target) || 0;
    if (typeof b.inDraw === 'boolean') x.inDraw = b.inDraw;
    if (b.cat !== undefined) x.cat = cleanCat(b.cat);
    // keep open tournaments that use this machine in step
    for (const t of db.tournaments) {
      if (t.status !== 'active') continue;
      for (const a of t.arenas) {
        if (a.mid !== x.id) continue;
        if (b.target !== undefined) { a.target = x.target; a.targetSource = x.target ? 'admin' : ''; }
        if (b.balls === 3 || b.balls === 5) { a.balls = x.balls; a.ballsSetByAdmin = true; }
        if (typeof b.abbr === 'string') a.abbr = x.abbr;
        if (b.cat !== undefined) a.cat = x.cat;
        rederive(t, a);
      }
      ensureBonus(t);
    }
    save(); return send(res, 200, { machine: x });
  }
  if (m === 'DELETE' && (mt = p.match(/^\/api\/admin\/machines\/(\w+)$/))) {
    db.machines = db.machines.filter(y => y.id !== mt[1]); save();
    return send(res, 200, { ok: true });
  }

  if (m === 'POST' && p === '/api/admin/tournaments') {
    const b = await readBody(req);
    const mpId = toInt(String(b.mp || '').match(/tournaments\/(\d+)/)?.[1] ?? b.mp);
    const t = {
      id: uid(), name: String(b.name || '').trim() || 'New tournament', mpId: mpId || null, status: 'active',
      createdAt: Date.now(), frames: 10, tenthBonus: true, allowRepeats: false,
      players: [], arenas: [], games: [], lastSync: null, lastSyncError: '',
    };
    const prev = db.tournaments.filter(x => !x.daily).sort((a, b) => b.createdAt - a.createdAt)[0];
    if (prev) Object.assign(t, { frames: prev.frames, tenthBonus: prev.tenthBonus, allowRepeats: prev.allowRepeats });
    if (b.copyMachines && prev) t.arenas = prev.arenas.filter(a => !a.bonusOnly).map(a => { const n = { ...newArena(a.name, a.mpId), active: a.active }; remember(n, t.createdAt); return n; });
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
    if (typeof b.done === 'boolean') t.done = b.done;
    if (b.finalsCount !== undefined) t.finalsCount = b.finalsCount ? Math.max(2, Math.min(64, parseInt(b.finalsCount, 10) || 0)) : null;
    if (b.seedOverride !== undefined) t.seedOverride = Array.isArray(b.seedOverride) ? b.seedOverride.map(String).filter(id => t.players.some(p => p.id === id)) : null;
    if (t.status === 'active' && !t.done && !t.finals) ensureBonus(t);
    save(); return send(res, 200, { tournament: publicT(t) });
  }
  if (m === 'DELETE' && sub === '') {
    const t = getT(tid);
    if (t.status !== 'archived' && !t.finals) fail(409, 'Archive the tournament before deleting it.');
    if (t.finals) { const q = db.tournaments.find(x => x.id === t.finals.parentId); if (q && q.finalsId === t.id) q.finalsId = null; }
    db.tournaments = db.tournaments.filter(x => x.id !== tid); save();
    return send(res, 200, { ok: true });
  }
  if (m === 'POST' && sub === '/sync') { const t = openT(tid), r = await syncTournament(t); return send(res, 200, { tournament: publicT(t), ...r }); }
  if (m === 'GET' && sub === '/raw') return send(res, 200, getT(tid).mpRaw || {});

  if (m === 'POST' && sub === '/finals') {
    const t = openT(tid);
    if (t.daily || t.finals) fail(409, 'Finals are for weekly tournaments.');
    if (!t.done) fail(409, 'Mark the tournament as done first.');
    if (t.finalsId && db.tournaments.some(x => x.id === t.finalsId)) fail(409, 'Finals already exist. Delete them first to make new ones.');
    const F = createFinals(t);
    return send(res, 200, { tournament: publicT(F) });
  }
  if (m === 'POST' && (mt = sub.match(/^\/finals\/(picks|score|order|next|undo)$/))) {
    const F = openT(tid), b = await readBody(req), act = mt[1];
    if (!F.finals) fail(409, 'This is not a finals tournament.');
    if ((act === 'next' || act === 'undo') && !admin) fail(401, 'Only an admin can change rounds.');
    const fin = F.finals, round = fin.rounds[fin.rounds.length - 1];
    if (act === 'next') { nextRound(F); return send(res, 200, { tournament: publicT(F) }); }
    if (act === 'undo') {
      if (fin.champion) { fin.champion = null; fin.places = null; save(); return send(res, 200, { tournament: publicT(F) }); }
      if (fin.rounds.length < 2) fail(409, 'This is the first round. Delete the finals to start over.');
      if (round.groups.some(g => Object.keys(g.scores).length)) fail(409, 'Scores are already entered in this round. Clear them first.');
      fin.rounds.pop(); save(); return send(res, 200, { tournament: publicT(F) });
    }
    if (fin.champion) fail(409, 'The finals are finished. Undo the result first.');
    const g = round.groups.find(x => x.id === String(b.gid || '')) || fail(404, 'Group not found. Only the current round can be changed.');
    if (act === 'picks') {
      if (Array.isArray(b.machines)) {
        const ms = b.machines.map(String);
        checkPicks(F, ms); checkSlots(F, round, g, ms);
        if (Object.values(g.scores).some(r => r && r.some(Boolean)) && g.machines.join() !== ms.join()) fail(409, 'Scores are already entered for this group.');
        g.machines = ms;
      }
      if (b.positions && typeof b.positions === 'object') {
        const pos = {};
        for (const [pid, v] of Object.entries(b.positions)) {
          if (!g.players.includes(pid)) continue;
          const n = parseInt(v, 10); if (n >= 1 && n <= g.players.length) pos[pid] = n;
        }
        const used = Object.values(pos); if (new Set(used).size !== used.length) fail(400, 'Two players have the same position.');
        g.positions = pos;
      }
      save(); return send(res, 200, { tournament: publicT(F) });
    }
    if (act === 'score') {
      const pid = String(b.pid || ''), i = parseInt(b.game, 10);
      if (!g.players.includes(pid)) fail(400, 'That player is not in this group.');
      if (!(i >= 0 && i < 3) || g.machines.length !== 3) fail(400, 'Pick the 3 machines first.');
      g.scores[pid] = g.scores[pid] || [null, null, null];
      if (b.clear) g.scores[pid][i] = null;
      else {
        const hit = Number(b.hitBall), b1 = toInt(b.b1), final = toInt(b.final);
        if (![0, 1, 2, 3].includes(hit)) fail(400, 'Pick the ball the target was reached on.');
        if (hit !== 1 && b1 == null) fail(400, 'Enter the score after ball 1.');
        if (hit === 0 && final == null) fail(400, 'Enter the final score.');
        g.scores[pid][i] = { hitBall: hit, b1, final, by: actor, at: Date.now() };
      }
      if (!g.scores[pid].some(Boolean)) delete g.scores[pid];
      g.order = null; save(); return send(res, 200, { tournament: publicT(F) });
    }
    if (act === 'order') {
      if (b.order === null) g.order = null;
      else { const o = (b.order || []).map(String); if (o.length !== g.players.length || g.players.some(x => !o.includes(x))) fail(400, 'List every player once.'); g.order = o; }
      save(); return send(res, 200, { tournament: publicT(F) });
    }
  }
  if (m === 'POST' && sub === '/bonus') {
    const t = scoringT(tid), b = await readBody(req), idx = b.index === 1 ? 1 : 0;
    if (!t.tenthBonus) fail(409, 'Bonus frames are turned off for this tournament.');
    const a = pickBonus(t, idx, b.machineId ? String(b.machineId) : null);
    if (!a) fail(409, 'No stored machines have target scores yet, so there is nothing to draw from.');
    save(); return send(res, 200, { tournament: publicT(t) });
  }
  if (m === 'POST' && sub === '/players') {
    const t = scoringT(tid), b = await readBody(req), name = String(b.name || '').trim();
    if (!name) fail(400, 'Enter a name.');
    if (t.players.some(x => lower(x.name) === lower(name))) fail(409, 'That player is already here.');
    t.players.push({ id: uid(), name, mpId: null }); save();
    return send(res, 200, { tournament: publicT(t) });
  }
  if (m === 'DELETE' && (mt = sub.match(/^\/players\/(\w+)$/))) {
    const t = scoringT(tid);
    t.games = t.games.filter(g => g.playerId !== mt[1]); t.players = t.players.filter(x => x.id !== mt[1]); save();
    return send(res, 200, { tournament: publicT(t) });
  }

  if (m === 'POST' && sub === '/arenas') {
    const t = scoringT(tid), b = await readBody(req), name = String(b.name || '').trim();
    if (!name) fail(400, 'Enter a machine name.');
    const a = newArena(name, null); remember(a, t.createdAt); t.arenas.push(a); save();
    return send(res, 200, { tournament: publicT(t) });
  }
  if (m === 'PATCH' && (mt = sub.match(/^\/arenas\/(\w+)$/))) {
    const t = scoringT(tid), b = await readBody(req);
    const a = t.arenas.find(x => x.id === mt[1]) || fail(404, 'Machine not found.');
    if (typeof b.name === 'string' && b.name.trim()) a.name = b.name.trim();
    if (typeof b.abbr === 'string') a.abbr = cleanAbbr(b.abbr) || abbrOf(a.name);
    if (b.cat !== undefined) { a.cat = cleanCat(b.cat); const st = storedFor(a); if (st) st.cat = a.cat; }
    if (b.balls === 3 || b.balls === 5) { a.balls = b.balls; a.ballsSetByAdmin = true; }
    if (b.target !== undefined) { a.target = toInt(b.target) || 0; a.targetSource = a.target ? 'admin' : ''; }
    if (typeof b.active === 'boolean') a.active = b.active;
    rederive(t, a); libPut(a); ensureBonus(t); save();
    return send(res, 200, { tournament: publicT(t) });
  }
  if (m === 'DELETE' && (mt = sub.match(/^\/arenas\/(\w+)$/))) {
    const t = scoringT(tid);
    t.games = t.games.filter(g => g.arenaId !== mt[1]); t.arenas = t.arenas.filter(x => x.id !== mt[1]); save();
    return send(res, 200, { tournament: publicT(t) });
  }

  if (m === 'POST' && sub === '/games') {
    const t = scoringT(tid), g = adminGame(t, await readBody(req));
    if (t.games.some(x => x.playerId === g.playerId && x.status === 'playing')) fail(409, 'This player has a game in progress. Finish or delete it first.');
    const slot = slotFor(t, g.playerId);
    if (slot.kind === 'bonus') {
      ensureBonus(t);
      const ba = t.arenas.find(x => x.id === t.bonusArenas[slot.idx]);
      if (ba && g.arenaId !== ba.id) fail(409, `Frame ${t.frames + 1 + slot.idx} is played on ${ba.name} by everyone.`);
    }
    t.games.push({ id: uid(), ...g, ts: Date.now(), by: actor }); ensureBonus(t); save();
    return send(res, 200, { tournament: publicT(t) });
  }
  if (m === 'PUT' && (mt = sub.match(/^\/games\/(\w+)$/))) {
    const t = scoringT(tid), g = adminGame(t, await readBody(req));
    const old = t.games.find(x => x.id === mt[1]) || fail(404, 'Game not found.');
    Object.assign(old, g, { editedBy: actor, editedAt: Date.now() }); ensureBonus(t); save();
    return send(res, 200, { tournament: publicT(t) });
  }
  if (m === 'DELETE' && (mt = sub.match(/^\/games\/(\w+)$/))) {
    const t = scoringT(tid); t.games = t.games.filter(x => x.id !== mt[1]); save();
    return send(res, 200, { tournament: publicT(t) });
  }
  if (m === 'POST' && (mt = sub.match(/^\/games\/(\w+)\/move$/))) {
    const t = scoringT(tid), b = await readBody(req), dir = b.dir === -1 ? -1 : 1;
    const g = t.games.find(x => x.id === mt[1]) || fail(404, 'Game not found.');
    const idxs = t.games.map((x, i) => x.playerId === g.playerId ? i : -1).filter(i => i >= 0);
    const i = t.games.indexOf(g), other = idxs[idxs.indexOf(i) + dir];
    if (other !== undefined) { [t.games[i], t.games[other]] = [t.games[other], t.games[i]]; ensureBonus(t); save(); }
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
