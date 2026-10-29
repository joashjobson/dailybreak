// Daily Break Worker. Every path is a file from public/, except /api/check and /api/duel.
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
    if (url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
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
