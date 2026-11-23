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
/* ---------- public riders list (what every player may see about other players) ---------- */
/* Shown to everyone: a short name, the stake and the result. Never email, phone or account id. */
function pubId(uid) { return crypto.createHash('sha256').update(String(uid)).digest('hex').slice(0, 10); }
function shortName(n) {
  const p = String(n || '').trim().split(/\s+/).filter(Boolean);
  if (!p.length) return 'Rider';
  const f = p[0].slice(0, 14);
  return p.length > 1 ? f + ' ' + p[p.length - 1][0].toUpperCase() + '.' : f;
}
async function writePub(uid, p) {
  const key = pubId(uid) + '_' + p.slot, ref = db().doc('rounds/' + p.n);
  if (p.op === 'set') await ref.set({ exp: new Date(Date.now() + 864e5), bets: { [key]: p.v } }, { merge: true });
  else if (p.op === 'cash') await ref.set({ bets: { [key]: { m: p.m } } }, { merge: true });
  else await ref.update({ ['bets.' + key]: admin().firestore.FieldValue.delete() }).catch(() => {});
}
async function publicRiders(t) {
  const c = currentRound(t), b = bettingRound(t), ns = c.n === b.n ? [c.n] : [c.n, b.n];
  const snaps = await Promise.all(ns.map(n => db().doc('rounds/' + n).get()));
  const rounds = ns.map((n, i) => {
    const r = roundByN(n), data = (snaps[i].exists && snaps[i].data().bets) || {};
    const bets = Object.keys(data).map(k => {
      const v = data[k], s = Number(v.s) || 0, a = v.a || 0;
      let st = 0, m = 0;                                   // 0 riding, 1 cashed out, 2 vanished
      if (v.m > 0) { st = 1; m = v.m; }
      else if (a > 1.01 && r.crashAt >= a) { if (t >= r.startAt + Math.log(a) / K * 1000) { st = 1; m = a; } }
      else if (t >= r.endAt) st = 2;
      return { k: k.split('_')[0], u: v.u || 'Rider', s, st, m, w: st === 1 ? Math.floor(s * m * 100) / 100 : 0 };
    }).sort((x, y) => y.s - x.s);
    return { n, bets };
  });
  return { t, rounds };
}

/* ---------- public chat: last 50 messages in one small doc. Phone numbers, links and account handles are hidden. ---------- */
function cleanChat(t) {
  return String(t || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '***')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '***')
    .replace(/\b[a-z0-9-]+\.(?:com|co|ke|me|net|org|io|app|link|ly|gl|tv|xyz|info|site|online|ug|tz|to|gg|cc)\b(?:\/\S*)?/gi, '***')
    .replace(/@\w{3,}/g, '***')
    .replace(/\+?\d(?:[\s\-().]*\d){6,}/g, '***').trim();
}
async function chatList() {
  const s = await db().doc('chat/recent').get();
  return { msgs: (s.exists && s.data().msgs) || [] };
}
async function chatSend(decoded, text) {
  const x = cleanChat(text); if (!x) throw err(400, 'Type a message');
  const us = await db().doc('users/' + decoded.uid).get(), name = shortName(us.exists ? us.data().name : ''), pid = pubId(decoded.uid), cref = db().doc('chat/recent');
  const msgs = await db().runTransaction(async tx => {
    const s = await tx.get(cref), d = s.exists ? s.data() : {}, now = Date.now(), last = d.last || {}, list = d.msgs || [];
    if (now - (last[pid] || 0) < 2000) throw err(429, 'Slow down');
    last[pid] = now; for (const k of Object.keys(last)) if (now - last[k] > 60000) delete last[k];
    list.push({ t: now, k: pid, u: name, x }); while (list.length > 50) list.shift();
    tx.set(cref, { msgs: list, last });
    return list;
  });
  return { msgs };
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
  let pub = null;
  const out = await db().runTransaction(async tx => {
    pub = null;
    const snap = await tx.get(ref), now = Date.now();
    let u = snap.exists ? snap.data() : null;
    if (!u || typeof u.bal !== 'number') u = fresh(body.profile, decoded.email, now);
    const slot = (body.slot === 0 || body.slot === 1 || body.slot === '0' || body.slot === '1') ? String(body.slot) : null;
    const ex = slot !== null && u.bets ? u.bets[slot] : null;
    const out = step(u, now, body);
    if (slot !== null) {
      const b = u.bets[slot];
      if (body.a === 'bet' && body.cancel) { if (ex && !ex.res) pub = { op: 'del', n: ex.n, slot }; }
      else if (body.a === 'bet' && b && b !== ex && !b.res) pub = { op: 'set', n: b.n, slot, v: { s: b.stake, a: b.auto || 0, u: shortName(u.name) } };
      else if (body.a === 'cashout' && b && b.res && b.res.w > 0) pub = { op: 'cash', n: b.n, slot, m: b.res.m };
    }
    tx.set(ref, u);
    out.id = pubId(decoded.uid);
    return out;
  });
  if (pub) { try { await writePub(decoded.uid, pub); } catch (e) { console.error('riders list', e); } }
  return out;
}
module.exports = { chatList, chatSend, admin, act, publicRiders, pubId, shortName, err, publicRound, step, fresh, roundByN, currentRound, bettingRound, hourRounds, K, CRASH_MS };
