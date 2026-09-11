/* Wikidata pass: structured facts about the company behind each stock row —
   headquarters city, US state, country, industries, founding year. The
   Wikipedia pass gives prose; this gives fields a collection can be a query
   over ("based in Florida" = wd.state includes "Florida"), so a collection's
   count is a fact, not a hand list.

   Two proof gates, same house rule as the wiki pass (a wrong match is worse
   than a blank):
   1. rows with a verified Wikipedia article resolve through that article's
      own Wikidata item (pageprops.wikibase_item) — strongest link we have.
   2. the rest resolve by ticker (P414 stock exchange, P249 ticker qualifier)
      AND the Wikidata label must share a distinctive word with our name —
      "AIA" alone hits Auckland Airport on the ASX when our row is AIA Group.
   Facts are fetched in one SPARQL batch per 60 items. Cache: wikidata-cache.json. */
const UA = { "User-Agent": "bundlr-curator-studio/1.0 (https://bundlr.trade; asset library) node", Accept: "application/sparql-results+json" };
const W = "https://en.wikipedia.org/w/api.php";
const SPARQL = "https://query.wikidata.org/sparql";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const dir = new URL(".", import.meta.url).pathname;

async function sparql(q: string): Promise<any[]> {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(SPARQL + "?query=" + encodeURIComponent(q), { headers: UA });
    if (r.status === 429) { await sleep(8000 * (i + 1)); continue; }
    if (!r.ok) { console.log("  sparql", r.status); await sleep(3000); continue; }
    return (await r.json()).results.bindings;
  }
  return [];
}
const v = (b: any, k: string) => b[k]?.value ?? null;
const qid = (u: string | null) => u ? u.replace(/.*\//, "") : null;

const STOP = new Set(("inc corp corporation co company ltd limited plc holdings holding group the of and & sa ag nv se llc lp trust fund etf class shares "+
  "energy capital technologies technology international global financial bank industries systems partners resources services solutions sciences life health therapeutics pharmaceuticals media entertainment digital platforms networks").split(" "));
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(w => w.length >= 3 && !STOP.has(w));
const nameOverlap = (a: string, b: string) => { const A = words(a), B = new Set(words(b)); return A.some(w => B.has(w)); };

async function main() {
  const reg = JSON.parse(await Bun.file(dir + "registry.json").text());
  const cacheFile = dir + "wikidata-cache.json";
  const cache: Record<string, any> = await Bun.file(cacheFile).exists() ? JSON.parse(await Bun.file(cacheFile).text()) : {};
  const save = () => Bun.write(cacheFile, JSON.stringify(cache));

  const live = reg.assets.filter((a: any) => a.status === "mintable" || a.status === "weight-capped");
  const stocks = [...new Map(live.filter((a: any) => a.cls === "stocks").map((a: any) => [a.t, a])).values()] as any[];

  /* gate 1: verified article → item */
  const byTitle = stocks.filter(a => a.wiki?.t && !(("q:" + a.t) in cache));
  for (let i = 0; i < byTitle.length; i += 50) {
    const chunk = byTitle.slice(i, i + 50);
    const d = await fetch(`${W}?action=query&prop=pageprops&ppprop=wikibase_item&format=json&redirects=1&titles=${encodeURIComponent(chunk.map(a => a.wiki.t).join("|"))}`, { headers: UA }).then(r => r.json()).catch(() => null);
    const pages: any[] = Object.values(d?.query?.pages ?? {});
    const norm: Record<string, string> = {};
    for (const rd of d?.query?.normalized ?? []) norm[rd.from] = rd.to;
    for (const rd of d?.query?.redirects ?? []) norm[rd.from] = rd.to;
    for (const a of chunk) {
      let t = a.wiki.t; t = norm[t] ?? t; t = norm[t] ?? t;
      const p = pages.find(p => p.title === t);
      cache["q:" + a.t] = p?.pageprops?.wikibase_item ? { q: p.pageprops.wikibase_item, via: "article" } : null;
    }
    await sleep(200);
  }
  await save();
  console.log(`gate 1 (article → item): ${stocks.filter(a => cache["q:" + a.t]?.via === "article").length}/${byTitle.length + stocks.filter(a => a.wiki?.t && ("q:" + a.t) in cache).length}`);

  /* gate 2: ticker + name overlap */
  const byTicker = stocks.filter(a => !cache["q:" + a.t] && !(("q:" + a.t) in cache && cache["q:" + a.t]?.via === "ticker-miss"));
  for (let i = 0; i < byTicker.length; i += 60) {
    const chunk = byTicker.slice(i, i + 60);
    const rows = await sparql(`SELECT ?tick ?item ?itemLabel ?ex WHERE {
      VALUES ?tick { ${chunk.map(a => JSON.stringify(a.t)).join(" ")} }
      ?item p:P414 ?st . ?st ps:P414 ?ex . ?st pq:P249 ?tick .
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } }`);
    const US = new Set(["Q82059", "Q13677", "Q846302", "Q1055364"]); // Nasdaq, NYSE, NYSE American, Cboe
    for (const a of chunk) {
      const hits = rows.filter(b => v(b, "tick") === a.t && nameOverlap(a.n, v(b, "itemLabel") ?? ""));
      hits.sort((x, y) => (US.has(qid(v(y, "ex"))!) ? 1 : 0) - (US.has(qid(v(x, "ex"))!) ? 1 : 0));
      cache["q:" + a.t] = hits.length ? { q: qid(v(hits[0], "item")), via: "ticker" } : { via: "ticker-miss" };
    }
    await sleep(1500);
  }
  await save();
  console.log(`gate 2 (ticker + name): ${stocks.filter(a => cache["q:" + a.t]?.via === "ticker").length} more`);

  /* facts for every resolved item */
  const items = [...new Set(stocks.map(a => cache["q:" + a.t]?.q).filter(Boolean))] as string[];
  const need = items.filter(q => !(("f:" + q) in cache));
  for (let i = 0; i < need.length; i += 60) {
    const chunk = need.slice(i, i + 60);
    const rows = await sparql(`SELECT ?item ?hqLabel ?stateLabel ?hqCountryLabel ?countryLabel ?indLabel ?inc WHERE {
      VALUES ?item { ${chunk.map(q => "wd:" + q).join(" ")} }
      OPTIONAL { ?item wdt:P159 ?hq . OPTIONAL { ?hq wdt:P17 ?hqCountry . } OPTIONAL { ?hq wdt:P131* ?state . ?state wdt:P31 wd:Q35657 . } }
      OPTIONAL { ?item wdt:P17 ?country . }
      OPTIONAL { ?item wdt:P452 ?ind . }
      OPTIONAL { ?item wdt:P571 ?inc . }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } }`);
    for (const q of chunk) {
      const rs = rows.filter(b => qid(v(b, "item")) === q);
      const set = (k: string) => [...new Set(rs.map(b => v(b, k)).filter(x => x && !/^Q\d+$/.test(x)))] as string[];
      const inc = set("inc")[0];
      cache["f:" + q] = rs.length ? { hq: set("hqLabel"), state: set("stateLabel"), country: set("countryLabel").length ? set("countryLabel") : set("hqCountryLabel"), ind: set("indLabel").slice(0, 6), founded: inc ? +inc.slice(0, 4) : null } : {};
    }
    await sleep(1500);
    console.log(`  facts …${Math.min(i + 60, need.length)}/${need.length}`);
  }
  await save();

  let n = 0, st = 0, fl = 0, cn = 0;
  for (const a of reg.assets) {
    delete a.wd;
    if (a.cls !== "stocks") continue;
    const c = cache["q:" + a.t]; if (!c?.q) continue;
    const f = cache["f:" + c.q] ?? {};
    a.wd = { q: c.q, via: c.via, ...f };
    if (a.status === "mintable" || a.status === "weight-capped") { n++; if (f.state?.length) st++; if (f.state?.includes("Florida")) fl++; if (f.country?.some((x: string) => /China/.test(x))) cn++; }
  }
  const uniq = (fn: (a: any) => boolean) => new Set(stocks.filter(a => a.wd && fn(a.wd)).map(a => a.t)).size;
  reg.meta.wikidata = { built: new Date().toISOString(), tickers: stocks.length, resolved: uniq(() => true), withState: uniq(w => w.state?.length), withCountry: uniq(w => w.country?.length), florida: uniq(w => w.state?.includes("Florida")), china: uniq(w => w.country?.some((x: string) => /China/.test(x))),
    method: "article → wikibase_item for ticker-verified Wikipedia rows; else P414/P249 ticker match + name-word overlap; facts P159 (HQ, US state via P131*), P17, P452, P571; unresolved rows carry no wd field" };
  await Bun.write(dir + "registry.json", JSON.stringify(reg));
  console.log(`wikidata: ${reg.meta.wikidata.resolved}/${stocks.length} tickers · state ${reg.meta.wikidata.withState} · country ${reg.meta.wikidata.withCountry} · Florida ${reg.meta.wikidata.florida} · China ${reg.meta.wikidata.china}`);
}
await main();
await Bun.$`bun ${dir}sync-js.ts`;
