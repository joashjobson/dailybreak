// Daily Break Worker. Every path is a file from public/, except /api/check.
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
  const r = await fetch(url, { headers: { 'user-agent': UA(env), accept: 'application/json' }, cf: { cacheTtl: 86400, cacheEverything: true } });
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
