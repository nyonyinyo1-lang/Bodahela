'use strict';
/* Server-side game logic. The crash points come from CRASH_SECRET, which never leaves the server. */
const crypto = require('crypto');
const K = 0.085, WAIT_MS = 6000, CRASH_MS = 3000, HOUR = 3600000, LIMIT_MS = 150;

let _admin = null, _db = null;
function admin() {
  if (!_admin) {
    _admin = require('firebase-admin');
    if (!_admin.apps.length) {
      _admin.initializeApp({ credential: _admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    }
  }
  return _admin;
}
function db() { return _db || (_db = admin().firestore()); }

function err(status, msg) { const e = new Error(msg); e.status = status; return e; }
const r2 = n => Math.round(n * 100) / 100;

/* ---------- rounds (a pure function of the clock + the secret) ---------- */
function secret() {
  const s = process.env.CRASH_SECRET;
  if (!s || s.length < 16) throw new Error('CRASH_SECRET is missing or too short');
  return s;
}
function crashFor(hr, i) {
  const h = crypto.createHmac('sha256', secret()).update(hr + ':' + i).digest();
  const r = h.readUInt32BE(0) / 4294967296;
  return Math.min(1000, Math.max(1, Math.floor(97 / (1 - r)) / 100));
}
const cache = {};
function hourRounds(hr) {
  if (cache[hr]) return cache[hr];
  const list = [], h0 = hr * HOUR, h1 = h0 + HOUR;
  let cur = h0;
  for (let i = 0; ; i++) {
    const c = crashFor(hr, i), st = cur + WAIT_MS, end = st + Math.log(c) / K * 1000;
    if (end + CRASH_MS > h1) break;
    list.push({ n: hr * 1000 + i, hr, i, startAt: st, crashAt: c, endAt: end });
    cur = end + CRASH_MS;
  }
  const ks = Object.keys(cache); if (ks.length > 6) delete cache[ks[0]];
  return cache[hr] = list;
}
function roundByN(n) {
  if (!Number.isFinite(n)) return null;
  return hourRounds(Math.floor(n / 1000))[n % 1000] || null;
}
function currentRound(t) {
  let hr = Math.floor(t / HOUR);
  for (let k = 0; k < 2; k++, hr++) for (const r of hourRounds(hr)) if (t < r.endAt + CRASH_MS) return r;
  throw new Error('no round');
}
function nextAfter(r) { return hourRounds(r.hr)[r.i + 1] || hourRounds(r.hr + 1)[0]; }
function bettingRound(t) { const c = currentRound(t); return t < c.startAt ? c : nextAfter(c); }
function histBefore(r) {
  const prev = hourRounds(r.hr - 1), full = prev.concat(hourRounds(r.hr)), idx = prev.length + r.i;
  return full.slice(Math.max(0, idx - 20), idx).reverse().map(x => x.crashAt);
}
/* What anyone may see: never the crash point of a ride that has not crashed yet. */
function publicRound(t) {
  const r = currentRound(t);
  return { n: r.n, st: r.startAt, c: t >= r.endAt ? r.crashAt : null, hist: histBefore(r) };
}

/* ---------- player accounts ---------- */
function fresh(p, email, now) {
  p = p || {};
  const name = String(p.name || '').trim().slice(0, 60);
  const phone = /^254[17]\d{8}$/.test(String(p.phone || '')) ? String(p.phone) : '';
  return { bal: 1000, hist: [], best: [], bets: {}, name, phone, email: String(email || '').slice(0, 120), created: now };
}
function finish(u, b, m, now) {
  const w = m > 0 ? Math.floor(b.stake * m * 100) / 100 : 0;
  if (w > 0) u.bal = r2(u.bal + w);
  b.res = { m, w };
  u.hist.unshift({ n: b.n, s: b.stake, m, w, t: now });
  u.hist = u.hist.slice(0, 50);
  if (w > 0) { u.best.push({ n: b.n, s: b.stake, m, w, t: now }); u.best.sort((x, y) => y.w - x.w); u.best = u.best.slice(0, 5); }
}
/* Settles every open bet using the server clock only. */
function settle(u, now) {
  for (const k of Object.keys(u.bets)) {
    const b = u.bets[k]; if (b.res) continue;
    const r = roundByN(b.n); if (!r) continue;
    if (b.auto > 1.01 && r.crashAt >= b.auto) {
      if (now >= r.startAt + Math.log(b.auto) / K * 1000) finish(u, b, b.auto, now);
    } else if (now >= r.endAt) finish(u, b, 0, now);
  }
}
function slotOf(v) { const s = String(v); if (s !== '0' && s !== '1') throw err(400, 'Bad bet slot'); return s; }

function doBet(u, now, body) {
  const slot = slotOf(body.slot), ex = u.bets[slot];
  if (body.cancel) {
    if (!ex || ex.res) throw err(409, 'No bet to cancel');
    if (now >= roundByN(ex.n).startAt) throw err(409, 'Too late, the ride has started');
    u.bal = r2(u.bal + ex.stake); delete u.bets[slot]; return;
  }
  if (ex && !ex.res) throw err(409, 'You already have a bet in this slot');
  const stake = Math.floor(Number(body.stake));
  if (!(stake >= 10)) throw err(400, 'Minimum bet is KSh 10');
  if (stake > 100000) throw err(400, 'Maximum bet is KSh 100,000');
  if (stake > u.bal) throw err(400, 'Not enough play money');
  let au = Number(body.auto) || 0; au = au > 1.01 ? Math.min(1000, r2(au)) : 0;
  const t = bettingRound(now);
  u.bal = r2(u.bal - stake);
  u.bets[slot] = { n: t.n, stake, auto: au };
}
function doCash(u, now, body) {
  const slot = slotOf(body.slot), b = u.bets[slot];
  if (!b) throw err(409, 'No active bet');
  if (b.res) throw err(409, b.res.w > 0 ? 'Already cashed out' : 'Too late, the ride crashed');
  const r = roundByN(b.n);
  if (now < r.startAt) throw err(409, 'The ride has not started');
  let m = Math.floor(Math.min(r.crashAt, Math.exp(K * (now - r.startAt) / 1000)) * 100) / 100;
  if (m < 1) m = 1;
  finish(u, b, m, now);
}
function doReset(u, now) {
  if (Object.values(u.bets).some(b => !b.res)) throw err(409, 'Finish your bets first');
  if (u.bal >= 10) throw err(409, 'You can top up only when you have less than KSh 10');
  if (now - (u.lastReset || 0) < 60000) throw err(429, 'Wait a minute before topping up again');
  u.bal = 1000; u.lastReset = now;
}
function view(u, now) {
  const bets = {};
  for (const k of Object.keys(u.bets)) { const b = u.bets[k]; bets[k] = { n: b.n, stake: b.stake, auto: b.auto || 0, res: b.res || null }; }
  const crashOf = h => { if (h.n == null) return h.c || 0; const r = roundByN(h.n); return r && now >= r.endAt ? r.crashAt : 0; };
  return {
    now, bal: u.bal, name: u.name || '', bets,
    hist: u.hist.map(h => ({ s: h.s, m: h.m, w: h.w, t: h.t, c: crashOf(h) })),
    best: u.best.map(h => ({ s: h.s, m: h.m, w: h.w, t: h.t }))
  };
}
const ACTIONS = { me: () => {}, bet: doBet, cashout: doCash, reset: doReset };

function step(u, now, body) {
  u.bets = u.bets || {}; u.hist = u.hist || []; u.best = u.best || [];
  if (now - (u.lastAct || 0) < LIMIT_MS) throw err(429, 'Slow down');
  u.lastAct = now;
  settle(u, now);
  const f = ACTIONS[body.a]; if (!f) throw err(400, 'Unknown action');
  f(u, now, body);
  return view(u, now);
}
async function act(decoded, body) {
  const ref = db().doc('users/' + decoded.uid);
  return db().runTransaction(async tx => {
    const snap = await tx.get(ref), now = Date.now();
    let u = snap.exists ? snap.data() : null;
    if (!u || typeof u.bal !== 'number') u = fresh(body.profile, decoded.email, now);
    const out = step(u, now, body);
    tx.set(ref, u);
    return out;
  });
}
module.exports = { admin, act, err, publicRound, step, fresh, roundByN, currentRound, bettingRound, hourRounds, K, CRASH_MS };
