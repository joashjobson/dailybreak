// Daily Break Worker. Every path is a file from public/, except /api/check, /api/duel, /api/score, /api/group
// and the pages that get their own link preview (the home page and /c/... challenge links).
// /api/check is the backup referee: the page checks its own list of ~240,000 names first and only asks here on a miss.
// Here we look the answer up on Wikidata (free, CC0), decide if it fits the category, and save the verdict
// in the ANSWERS KV store so each name is only looked up once.

const UA = env => `DailyBreak/1.0 (${env.SITE_URL || 'https://daily-break.workers.dev'}; ${env.CONTACT_EMAIL || 'no contact set'})`;
const WD_API = 'https://www.wikidata.org/w/api.php';
const WD_SPARQL = 'https://query.wikidata.org/sparql';
const CACHE_DAYS = 90;

// Wikidata classes for each category. An answer fits when it is an instance of one of these (or of a subclass of one).
const CLASSES = {
  c: ['Q6256', 'Q3624078', 'Q7275', 'Q1763527', 'Q15634554'],                // country, sovereign state, state, constituent country, state with limited recognition
  t: ['Q515', 'Q486972', 'Q3957', 'Q5119', 'Q1549591', 'Q532'],              // city, human settlement, town, capital, big city, village
  l: ['Q2221906', 'Q570116', 'Q8502', 'Q4022', 'Q23397', 'Q82794', 'Q839954', 'Q811979', 'Q35145263', 'Q107425', 'Q23442', 'Q46831'], // place, attraction, mountain, river, lake, region, ruins, structure, natural feature, landscape, island, mountain range
  p: ['Q5'],                                                                 // human
  n: ['Q202444', 'Q12308941', 'Q11879590', 'Q3409032'],                      // given name, male, female, unisex
  a: ['Q16521', 'Q55983715'],                                                // taxon, organisms known by a common name
  f: ['Q2095', 'Q40050', 'Q746549', 'Q1364', 'Q11004', 'Q25403900', 'Q2424752', 'Q19861951'], // food, drink, dish, fruit, vegetable, food ingredient, product (food), type of food
  e: ['Q1656682', 'Q1190554', 'Q132241', 'Q1445650', 'Q178561', 'Q198', 'Q16510064', 'Q13406554', 'Q3839081'], // event, occurrence, festival, holiday, battle, war, sporting event, sports competition, disaster
  b: ['Q431289', 'Q7889', 'Q11424', 'Q5398426', 'Q4830453', 'Q7725634', 'Q167270', 'Q2088357', 'Q1004', 'Q482994', 'Q7397'], // brand, video game, film, TV series, business, literary work, trademark, musical work... comics, album, software
  h: ['Q95074', 'Q15632617', 'Q24334685', 'Q4271324', 'Q14897293', 'Q178885', 'Q15410431'], // fictional character, fictional human, mythical creature, mythical character, fictional entity, deity, legendary creature
  x: null, // "a thing": anything real that isn't a person
};

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
// Same as norm() in the page, so names compare the same way on both sides
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, 'and').trim().replace(/^the\s+/, '').replace(/[^a-z]/g, '');

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/check') return check(url, env, ctx);
    if (url.pathname.startsWith('/api/duel')) return duel(request, url, env);
    if (url.pathname === '/api/score') return score(request, env);
    if (url.pathname.startsWith('/api/group')) return group(request, url, env);
    if (url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
    if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname.startsWith('/c/')) return page(request, url, env);
    return env.ASSETS.fetch(request);
  },
};

async function check(url, env, ctx) {
  const q = (url.searchParams.get('q') || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const cat = url.searchParams.get('cat') || 'x';
  const k = norm(q);
  if (k.length < 2 || !(cat in CLASSES)) return json({ ok: false, reason: 'bad' }, 400);

  const key = `v1:${cat}:${k}`;
  if (env.ANSWERS) {
    const hit = await env.ANSWERS.get(key, 'json');
    if (hit) return json({ ...hit, cached: true });
  }

  let verdict;
  try { verdict = await lookup(q, k, cat, env); }
  catch (e) {
    console.log('wikidata error', String(e));
    return json({ ok: false, reason: 'offline' }, 503); // not cached, so it's tried again next time
  }
  if (env.ANSWERS) ctx.waitUntil(env.ANSWERS.put(key, JSON.stringify(verdict), { expirationTtl: CACHE_DAYS * 86400 }));
  return json(verdict);
}

async function wd(url, env) {
  const r = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { 'user-agent': UA(env), accept: 'application/json' }, cf: { cacheTtl: 86400, cacheEverything: true } });
  if (!r.ok) throw new Error(`${r.status} from ${new URL(url).host}`);
  return r.json();
}

async function lookup(q, k, cat, env) {
  // 1. find items whose name or alias matches what was typed (ignoring case, accents and spacing)
  const s = await wd(`${WD_API}?action=wbsearchentities&format=json&language=en&uselang=en&type=item&limit=10&search=${encodeURIComponent(q)}`, env);
  const items = (s.search || []).filter(it => norm(it.label || '') === k || norm(it.match?.text || '') === k).slice(0, 6);
  if (!items.length) return { ok: false, reason: 'unknown' };
  const ids = items.map(it => it.id);

  // 2. ask which of them fit the category, and how many Wikipedias have an article on each (more = more common = fewer points)
  const want = CLASSES[cat];
  const fit = want
    ? `?item wdt:P31/wdt:P279* ?cls . VALUES ?cls { ${want.map(c => 'wd:' + c).join(' ')} }`
    : `FILTER NOT EXISTS { ?item wdt:P31 wd:Q5 }`;
  const sparql = `SELECT ?item (MAX(?n) AS ?links) WHERE { VALUES ?item { ${ids.map(i => 'wd:' + i).join(' ')} } ${fit} OPTIONAL { ?item wikibase:sitelinks ?n } } GROUP BY ?item`;
  const r = await wd(`${WD_SPARQL}?format=json&query=${encodeURIComponent(sparql)}`, env);
  const rows = (r.results?.bindings || []).map(b => ({ id: b.item.value.split('/').pop(), links: +(b.links?.value || 0) }));
  if (!rows.length) return { ok: false, reason: 'wrongcat', name: items[0].label };

  const best = rows.sort((a, b) => b.links - a.links)[0];
  const item = items.find(it => it.id === best.id);
  // A name that is on Wikidata but not on the page's own list is fairly rare already
  const pts = best.links >= 60 ? 2 : best.links >= 10 ? 3 : 5;
  return { ok: true, name: item.label, pts, id: best.id };
}

/* ---------- friend duels ----------
   POST /api/duel/new        -> { code }   makes a room with a fresh invite code
   GET  /api/duel/CODE/ws    -> WebSocket  ?pid=<random id kept in the browser>&name=<nickname>
   Each code is one DuelRoom (a Durable Object). It keeps the chain, whose turn it is and the turn clock,
   so both players see the same thing and a turn runs out even if someone closes the tab. */
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0 or 1, so codes are easy to read out
const TURN_MS = 15000, HOLD_MS = 6000, START_MS = 3000;
const FIRST_LETTERS = 'abcdeghklmnprst';
const SAFE_CATS = ['t', 'p', 'n', 'a', 'f', 'x']; // fit every letter above, used for the first prompt
const ROOM_DAYS = 2;

async function duel(request, url, env) {
  if (!env.DUELS) return json({ error: 'Duels are not set up on this Worker' }, 503);
  if (url.pathname === '/api/duel/new' && request.method === 'POST') {
    for (let i = 0; i < 6; i++) {
      const code = Array.from(crypto.getRandomValues(new Uint8Array(5)), b => CODE_CHARS[b % CODE_CHARS.length]).join('');
      const r = await env.DUELS.get(env.DUELS.idFromName(code)).fetch('https://room/init', { method: 'POST' });
      if (r.ok) return json({ code });
    }
    return json({ error: 'busy' }, 503);
  }
  const m = url.pathname.match(/^\/api\/duel\/([A-Za-z0-9]{5})\/ws$/);
  if (m) {
    if (request.headers.get('upgrade') !== 'websocket') return json({ error: 'websocket only' }, 426);
    const code = m[1].toUpperCase();
    return env.DUELS.get(env.DUELS.idFromName(code)).fetch(request);
  }
  return json({ error: 'not found' }, 404);
}

export class DuelRoom {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }

  async load() { return this.room || (this.room = await this.ctx.storage.get('room')); }
  async save() { this.room.touched = Date.now(); await this.ctx.storage.put('room', this.room); }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/init') {
      if (await this.load()) return new Response('taken', { status: 409 });
      this.room = { status: 'waiting', players: [], links: [], used: [], game: 0 };
      await this.save();
      await this.ctx.storage.setAlarm(Date.now() + ROOM_DAYS * 864e5);
      return new Response('ok');
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const room = await this.load();
    const pid = (url.searchParams.get('pid') || '').slice(0, 40);
    const name = (url.searchParams.get('name') || '').trim().replace(/\s+/g, ' ').slice(0, 16) || 'Player';
    const fail = msg => { server.send(JSON.stringify({ t: 'error', msg })); server.close(1000, 'bye'); return new Response(null, { status: 101, webSocket: client }); };
    if (!room) return fail('There is no duel with that code. Check it and try again.');
    if (!pid) return fail('Something went wrong. Reload the page.');
    let p = room.players.find(x => x.pid === pid);
    if (!p) {
      if (room.players.length >= 2) return fail('That duel already has two players.');
      p = { pid, name, wins: 0 };
      room.players.push(p);
    } else p.name = name;
    // one socket per player: a reconnect replaces the old one
    for (const ws of this.ctx.getWebSockets()) if (ws !== server && ws.deserializeAttachment()?.pid === pid) { try { ws.close(1000, 'replaced'); } catch (e) {} }
    server.serializeAttachment({ pid });
    if (room.status === 'waiting' && room.players.length === 2) this.startGame();
    await this.save();
    this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  startGame() {
    const r = this.room, now = Date.now();
    const req = FIRST_LETTERS[Math.floor(Math.random() * FIRST_LETTERS.length)];
    // whoever lost the last game goes first; the person who made the code starts game one
    const first = r.game === 0 ? 0 : (r.winner === 0 ? 1 : 0);
    Object.assign(r, { status: 'playing', links: [], used: [], req, cat: SAFE_CATS[Math.floor(Math.random() * SAFE_CATS.length)],
      turn: first, startAt: now + START_MS, deadline: now + START_MS + TURN_MS, held: false, winner: null, why: '', rematch: [false, false] });
    r.game++;
    this.ctx.storage.setAlarm(r.deadline + 700);
  }

  online() { return new Set(this.ctx.getWebSockets().map(ws => ws.deserializeAttachment()?.pid).filter(Boolean)); }

  view() {
    const r = this.room, on = this.online();
    return { t: 'state', now: Date.now(), status: r.status, turn: r.turn, req: r.req, cat: r.cat, startAt: r.startAt, deadline: r.deadline,
      held: r.held, links: r.links, winner: r.winner, why: r.why, rematch: r.rematch, game: r.game,
      players: r.players.map(p => ({ name: p.name, wins: p.wins, on: on.has(p.pid) })) };
  }

  broadcast(extra) {
    const v = { ...this.view(), ...extra };
    for (const ws of this.ctx.getWebSockets()) {
      const you = this.room.players.findIndex(p => p.pid === ws.deserializeAttachment()?.pid);
      try { ws.send(JSON.stringify({ ...v, you })); } catch (e) {}
    }
  }

  async webSocketMessage(ws, raw) {
    const r = await this.load();
    if (!r) return;
    const me = r.players.findIndex(p => p.pid === ws.deserializeAttachment()?.pid);
    if (me < 0) return;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    const now = Date.now();
    const no = msg => ws.send(JSON.stringify({ t: 'nope', msg }));

    if (m.t === 'ping') return ws.send(JSON.stringify({ t: 'pong', now }));
    if (m.t === 'rematch' && r.status === 'over') {
      r.rematch[me] = true;
      if (r.rematch.every(Boolean)) this.startGame();
      await this.save(); return this.broadcast();
    }
    if (r.status !== 'playing') return;
    if (m.t === 'giveup') return this.end(me === 0 ? 1 : 0, `${r.players[me].name} gave up.`);
    if (r.turn !== me) return no("It's not your turn.");
    if (now < r.startAt) return no('Wait for the start.');
    if (now > r.deadline) return; // the alarm ends the game
    if (m.t === 'hold') {
      // the page is checking a rare answer: stop the clock for a moment (once a turn) so it doesn't cost the player time
      if (r.held) return;
      r.held = true; r.deadline = Math.max(r.deadline, now) + HOLD_MS;
      await this.ctx.storage.setAlarm(r.deadline + 700);
      await this.save(); return this.broadcast();
    }
    if (m.t === 'move') {
      const name = String(m.name || '').trim().slice(0, 60), key = norm(name);
      if (key.length < 2) return no('Type a name first.');
      if (key[0] !== r.req) return no(`That starts with ${key[0].toUpperCase()}. You need ${r.req.toUpperCase()}.`);
      if (r.used.includes(key)) return no(`${name} is already in this chain.`);
      const pts = [1, 2, 3, 5].includes(m.pts) ? m.pts : 1;
      r.links.push({ name, key, cat: r.cat, pts, by: me });
      r.used.push(key);
      r.req = key.slice(-1);
      r.cat = m.nextCat in CLASSES && m.nextCat !== r.cat ? m.nextCat : SAFE_CATS.filter(c => c !== r.cat)[Math.floor(Math.random() * 5)];
      r.turn = me === 0 ? 1 : 0; r.deadline = now + TURN_MS; r.held = false;
      await this.ctx.storage.setAlarm(r.deadline + 700);
      await this.save(); return this.broadcast({ played: { by: me, name } });
    }
  }

  async end(winner, why) {
    const r = this.room;
    Object.assign(r, { status: 'over', winner, why, rematch: [false, false] });
    r.players[winner].wins++;
    await this.ctx.storage.setAlarm(Date.now() + ROOM_DAYS * 864e5);
    await this.save(); this.broadcast();
  }

  async alarm() {
    const r = await this.load();
    if (!r) return;
    if (r.status === 'playing') {
      if (Date.now() < r.deadline) return this.ctx.storage.setAlarm(r.deadline + 700);
      const loser = r.turn, ask = `${CATS_SHORT[r.cat] || 'answer'} starting with ${r.req.toUpperCase()}`;
      return this.end(loser === 0 ? 1 : 0, `${r.players[loser].name} ran out of time on ${ask}.`);
    }
    if (Date.now() - (r.touched || 0) > ROOM_DAYS * 864e5 - 6e4) {
      for (const ws of this.ctx.getWebSockets()) { try { ws.close(1000, 'expired'); } catch (e) {} }
      this.room = null;
      return this.ctx.storage.deleteAll();
    }
    await this.ctx.storage.setAlarm((r.touched || Date.now()) + ROOM_DAYS * 864e5);
  }

  async webSocketClose(ws, code) { try { ws.close(1000, 'bye'); } catch (e) {} if (await this.load()) this.broadcastSoon(); }
  async webSocketError(ws) { if (await this.load()) this.broadcastSoon(); }
  broadcastSoon() { setTimeout(() => { if (this.room) this.broadcast(); }, 50); }
}

const CATS_SHORT = { c: 'a country', t: 'a city', l: 'a place', p: 'a famous person', n: 'a first name', a: 'an animal', f: 'a food', e: 'an event', b: 'a brand or show', h: 'a character', x: 'a thing' };

/* ---------- link previews ----------
   The home page and challenge links (/c/142-k-14?n=Archer) are the same index.html. Here we fill in the preview
   that WhatsApp, iMessage and Discord show: a title with the score and a picture of that chain's letter. */
const PREVIEW_LETTERS = 'abcdefghklmnprstw'; // the daily letters; there's a picture for each in public/og/
async function page(request, url, env) {
  const res = await env.ASSETS.fetch(new Request(new URL('/', url), request));
  if (!(res.headers.get('content-type') || '').includes('text/html')) return res;
  let title = 'Daily Chain · Daily Break', desc = "One quick game a day. Keep a word chain going for 90 seconds.", img = '/og/home.png';
  const m = url.pathname.match(/^\/c\/(\d{1,5})-([a-z])-(\d{1,2})$/i);
  if (m) {
    const [, day, letter, links] = m, who = cleanName(url.searchParams.get('n')) || 'A friend';
    title = `${who} got ${links} link${links === '1' ? '' : 's'} in Daily Chain. Can you beat it?`;
    desc = `Daily Chain No. ${day} starts with ${letter.toUpperCase()}. 90 seconds, one go a day.`;
    if (PREVIEW_LETTERS.includes(letter.toLowerCase())) img = `/og/${letter.toLowerCase()}.png`;
  }
  const set = v => ({ element(e) { e.setAttribute('content', v); } });
  return new HTMLRewriter()
    .on('meta[property="og:title"]', set(title))
    .on('meta[name="twitter:title"]', set(title))
    .on('meta[property="og:description"]', set(desc))
    .on('meta[property="og:image"]', set(url.origin + img))
    .on('meta[property="og:url"]', set(url.href))
    .transform(new Response(res.body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } }));
}
const cleanName = s => String(s || '').replace(/[<>"&]/g, '').trim().replace(/\s+/g, ' ').slice(0, 16);

/* ---------- daily scores and groups ----------
   POST /api/score            { day, pid, links, groups:[codes] } -> { rank, players }   saves a player's ranked go
   POST /api/group/new        { name, pid, pname }  -> { code }
   POST /api/group/CODE/join  { pid, pname }        -> { ok }
   POST /api/group/CODE/leave { pid }               -> { ok }
   GET  /api/group/CODE?day=N&pid=...               -> { name, members, today:[...] }
   Each day and each group is one Board (a Durable Object with its own small database). */
const GROUP_MAX = 50, GROUPS_PER_PLAYER = 10, GROUP_DAYS = 60, DAY_KEEP_DAYS = 3;
const START_DAY = Date.UTC(2026, 9, 28); // Daily Chain No. 1
const serverDay = () => Math.floor((Date.now() - START_DAY) / 864e5) + 1;
const board = (env, name) => env.BOARDS.get(env.BOARDS.idFromName(name));
const okPid = pid => typeof pid === 'string' && /^[a-z0-9]{6,40}$/.test(pid);
async function body(request) { try { return await request.json(); } catch (e) { return {}; } }

async function score(request, env) {
  if (!env.BOARDS) return json({ error: 'Scores are not set up on this Worker' }, 503);
  if (request.method !== 'POST') return json({ error: 'post only' }, 405);
  const b = await body(request), day = +b.day, links = +b.links, today = serverDay();
  // the day comes from the player's own clock, so allow a day either side for time zones
  if (!okPid(b.pid) || !Number.isInteger(day) || Math.abs(day - today) > 1 || !Number.isInteger(links) || links < 0 || links > 70) return json({ error: 'bad' }, 400);
  const codes = (Array.isArray(b.groups) ? b.groups : []).filter(c => /^[A-Z2-9]{5}$/.test(c)).slice(0, GROUPS_PER_PLAYER);
  const call = (name, path, data) => board(env, name).fetch(`https://board${path}`, { method: 'POST', body: JSON.stringify(data) });
  const [r] = await Promise.all([
    call(`day:${day}`, '/day', { pid: b.pid, links }),
    ...codes.map(c => call(`group:${c}`, '/score', { pid: b.pid, day, links }).catch(() => null)),
  ]);
  return json(await r.json());
}

async function group(request, url, env) {
  if (!env.BOARDS) return json({ error: 'Groups are not set up on this Worker' }, 503);
  if (url.pathname === '/api/group/new' && request.method === 'POST') {
    const b = await body(request), name = cleanName(b.name).slice(0, 24) || 'My group';
    if (!okPid(b.pid)) return json({ error: 'bad' }, 400);
    for (let i = 0; i < 6; i++) {
      const code = Array.from(crypto.getRandomValues(new Uint8Array(5)), x => CODE_CHARS[x % CODE_CHARS.length]).join('');
      const r = await board(env, `group:${code}`).fetch('https://board/init', { method: 'POST', body: JSON.stringify({ name, pid: b.pid, pname: cleanName(b.pname) || 'Player' }) });
      if (r.ok) return json({ code, name });
    }
    return json({ error: 'busy' }, 503);
  }
  const m = url.pathname.match(/^\/api\/group\/([A-Za-z0-9]{5})(\/join|\/leave)?$/);
  if (!m) return json({ error: 'not found' }, 404);
  const code = m[1].toUpperCase(), stub = board(env, `group:${code}`);
  if (m[2]) {
    if (request.method !== 'POST') return json({ error: 'post only' }, 405);
    const b = await body(request);
    if (!okPid(b.pid)) return json({ error: 'bad' }, 400);
    return stub.fetch(`https://board${m[2]}`, { method: 'POST', body: JSON.stringify({ pid: b.pid, pname: cleanName(b.pname) || 'Player' }) });
  }
  const day = Math.max(1, Math.min(serverDay() + 1, +url.searchParams.get('day') || serverDay()));
  return stub.fetch(`https://board/view?day=${day}&pid=${encodeURIComponent(url.searchParams.get('pid') || '')}&code=${code}`);
}

export class Board {
  constructor(ctx, env) {
    this.ctx = ctx; this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS day (pid TEXT PRIMARY KEY, links INTEGER, at INTEGER);
      CREATE TABLE IF NOT EXISTS members (pid TEXT PRIMARY KEY, name TEXT, joined INTEGER);
      CREATE TABLE IF NOT EXISTS scores (day INTEGER, pid TEXT, links INTEGER, PRIMARY KEY (day, pid));`);
  }
  meta(k) { const r = this.sql.exec('SELECT v FROM meta WHERE k = ?', k).toArray()[0]; return r ? r.v : null; }
  setMeta(k, v) { this.sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', k, String(v)); }
  // a group is deleted after 60 days with no scores; a day's scores are deleted 3 days after
  async keep(days) { await this.ctx.storage.setAlarm(Date.now() + days * 864e5); }

  async fetch(request) {
    const url = new URL(request.url), p = url.pathname;
    const b = request.method === 'POST' ? await body(request) : {};
    const out = (d, s = 200) => json(d, s);

    if (p === '/day') {
      // only the first ranked go of the day counts
      this.sql.exec('INSERT OR IGNORE INTO day (pid, links, at) VALUES (?, ?, ?)', b.pid, b.links, Date.now());
      const mine = this.sql.exec('SELECT links FROM day WHERE pid = ?', b.pid).one().links;
      const players = this.sql.exec('SELECT COUNT(*) AS n FROM day').one().n;
      const better = this.sql.exec('SELECT COUNT(*) AS n FROM day WHERE links > ?', mine).one().n;
      if (!this.meta('alarm')) { this.setMeta('alarm', 1); await this.keep(DAY_KEEP_DAYS); }
      return out({ links: mine, rank: better + 1, players, top: Math.max(1, Math.ceil((better + 1) / players * 100)) });
    }
    if (p === '/init') {
      if (this.meta('name')) return out({ error: 'taken' }, 409);
      this.setMeta('name', b.name);
      this.sql.exec('INSERT INTO members (pid, name, joined) VALUES (?, ?, ?)', b.pid, b.pname, Date.now());
      await this.keep(GROUP_DAYS);
      return out({ ok: true });
    }
    const name = this.meta('name');
    if (!name) return out({ error: 'There is no group with that code. Check it and try again.' }, 404);
    if (p === '/join') {
      const n = this.sql.exec('SELECT COUNT(*) AS n FROM members').one().n;
      const already = this.sql.exec('SELECT 1 FROM members WHERE pid = ?', b.pid).toArray().length;
      if (!already && n >= GROUP_MAX) return out({ error: `That group is full (${GROUP_MAX} people).` }, 409);
      this.sql.exec('INSERT INTO members (pid, name, joined) VALUES (?, ?, ?) ON CONFLICT(pid) DO UPDATE SET name = excluded.name', b.pid, b.pname, Date.now());
      return out({ ok: true, name });
    }
    if (p === '/leave') {
      this.sql.exec('DELETE FROM members WHERE pid = ?', b.pid);
      this.sql.exec('DELETE FROM scores WHERE pid = ?', b.pid);
      return out({ ok: true });
    }
    if (p === '/score') {
      if (!this.sql.exec('SELECT 1 FROM members WHERE pid = ?', b.pid).toArray().length) return out({ error: 'not a member' }, 403);
      this.sql.exec('INSERT OR IGNORE INTO scores (day, pid, links) VALUES (?, ?, ?)', b.day, b.pid, b.links);
      this.sql.exec('DELETE FROM scores WHERE day < ?', b.day - 14);
      await this.keep(GROUP_DAYS);
      return out({ ok: true });
    }
    if (p === '/view') {
      const day = +url.searchParams.get('day'), pid = url.searchParams.get('pid');
      const rows = this.sql.exec('SELECT m.pid, m.name, s.links FROM members m LEFT JOIN scores s ON s.pid = m.pid AND s.day = ? ORDER BY s.links IS NULL, s.links DESC, m.joined', day).toArray();
      const y = this.sql.exec('SELECT m.name, s.links FROM scores s JOIN members m ON m.pid = s.pid WHERE s.day = ? ORDER BY s.links DESC LIMIT 1', day - 1).toArray()[0];
      return out({ code: url.searchParams.get('code'), name, members: rows.length, member: rows.some(r => r.pid === pid),
        today: rows.map(r => ({ name: r.name, links: r.links, you: r.pid === pid })), yesterday: y ? { name: y.name, links: y.links } : null });
    }
    return out({ error: 'not found' }, 404);
  }

  async alarm() {
    // nothing has happened for a while: delete everything (a group's last score or a day that is over)
    await this.ctx.storage.deleteAll();
  }
}
