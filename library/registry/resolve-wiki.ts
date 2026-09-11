/* Resolve each asset to its source of truth: an encyclopedia entry for things
   that exist in the world (companies, metals, chains), the venue's own market
   page for bets. Wikipedia's REST summary API is public + CORS-open; the risk
   is a confident WRONG match ("Vida Global" → the Coldplay song), so every
   company match must be VERIFIED: the page's traded_as infobox has to print
   our ticker. No verification, no blurb — same house rule as "no live venue".
   Results cache to wiki-cache.json so reruns are instant. */
const UA = { "User-Agent": "bundlr-curator-studio/1.0 (https://bundlr.trade; asset library) node" };
const W = "https://en.wikipedia.org/w/api.php";
const REST = "https://en.wikipedia.org/api/rest_v1/page/summary/";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const j = async (u: string) => { try { const x = await fetch(u, { headers: UA }); return x.ok ? await x.json() : null; } catch { return null; } };

/* Commodities + currencies are small hand-curated bins, so their pages are
   hand-mapped once and existence-checked at build (not guessed at runtime). */
export const WIKI_MAP: Record<string, string> = {
  GC:"Gold", SI:"Silver", HG:"Copper", PL:"Platinum", PA:"Palladium", ALI:"Aluminium",
  HRC:"Hot rolled steel", LTH:"Lithium hydroxide", CO:"Cobalt",
  CL:"West Texas Intermediate", BZ:"Brent Crude", NG:"Natural gas", RB:"Gasoline",
  HO:"Ultra-low-sulfur diesel", PJM:"PJM Interconnection", EH:"Ethanol fuel", MTF:"Coal",
  ZC:"Maize", ZW:"Wheat", KE:"Winter wheat", ZS:"Soybean", ZM:"Soybean meal", ZL:"Soybean oil",
  ZO:"Oat", ZR:"Rice", CT:"Cotton", KC:"Coffee", SB:"Sugar", CC:"Cocoa bean",
  OJ:"Orange juice", LBR:"Lumber", RS:"Rapeseed", DF:"Whey", ZP:"Peanut",
  LE:"Cattle", GF:"Cattle", HE:"Domestic pig", PRK:"Pork", DC:"Milk", CB:"Butter", EGGS:"Egg as food",
  XAUT:"Tether Gold", PAXG:"Paxos Standard",
  USDC:"USD Coin", USDT:"Tether (cryptocurrency)", DAI:"Dai (cryptocurrency)",
  PYUSD:"PayPal USD", BUIDL:"BlackRock", BENJI:"Franklin Templeton", WTGXX:"WisdomTree",
  USTB:"United States Treasury security", TBILL:"United States Treasury security",
  EURC:"Circle (company)", EURS:"Stasis Euro", XSGD:"StraitsX", JPYC:"JPY Coin",
  GYEN:"GMO Internet", JPYSC:"SBI Holdings",
};

async function summary(title: string) {
  const d = await j(REST + encodeURIComponent(title.replace(/ /g, "_")));
  if (!d || d.type === "disambiguation" || !d.extract) return null;
  return { title: d.title, desc: d.description ?? null, extract: d.extract, url: d.content_urls?.desktop?.page };
}

/* the verification gate: does this page's infobox actually list our ticker? */
async function tickerVerified(title: string, ticker: string) {
  const d = await j(`${W}?action=query&prop=revisions&rvprop=content&rvslots=main&rvsection=0&format=json&titles=${encodeURIComponent(title)}`);
  const txt = d && (Object.values(d.query?.pages ?? {})[0] as any)?.revisions?.[0]?.slots?.main?.["*"];
  if (!txt) return false;
  const traded = /traded_as\s*=\s*([\s\S]{0,400})/.exec(txt);
  return !!traded && new RegExp(`\\b${ticker.replace(/\./g, "\\.")}\\b`).test(traded[1]);
}

async function resolveCompany(name: string, ticker: string) {
  const d = await j(`${W}?action=query&list=search&srsearch=${encodeURIComponent(name + " company")}&srlimit=4&format=json`);
  for (const s of (d?.query?.search ?? []).slice(0, 3)) {
    await sleep(90);
    if (await tickerVerified(s.title, ticker)) return summary(s.title);
  }
  return null;
}

async function main() {
  const path = "registry/registry.json";
  const reg = JSON.parse(await Bun.file(path).text());
  const cacheFile = "registry/wiki-cache.json";
  const cache: Record<string, any> = await Bun.file(cacheFile).exists() ? JSON.parse(await Bun.file(cacheFile).text()) : {};
  const save = () => Bun.write(cacheFile, JSON.stringify(cache, null, 0));

  const live = reg.assets.filter((a: any) => a.status === "mintable" || a.status === "weight-capped");
  const stocks = [...new Map(live.filter((a: any) => a.cls === "stocks").map((a: any) => [a.t, a])).values()] as any[];
  const others = live.filter((a: any) => a.cls !== "stocks" && a.cls !== "predictions");

  let done = 0, hit = 0;
  for (const a of others) {
    const key = a.cls + ":" + a.t;
    if (!(key in cache)) { const t = WIKI_MAP[a.t]; cache[key] = t ? await summary(t) : null; await sleep(120); }
    if (cache[key]) hit++;
    done++;
  }
  console.log(`hand-mapped bins: ${hit}/${done} resolved`);
  await save();

  let sHit = 0, i = 0;
  for (const a of stocks) {
    const key = "stocks:" + a.t;
    if (!(key in cache)) { cache[key] = await resolveCompany(a.n, a.t); await sleep(140); if (++i % 25 === 0) { await save(); console.log(`  …${i}/${stocks.length}`); } }
    if (cache[key]) sHit++;
  }
  await save();
  console.log(`stocks: ${sHit}/${stocks.length} verified (${Math.round(100 * sHit / stocks.length)}%)`);

  for (const a of reg.assets) {
    const c = cache[a.cls + ":" + a.t];
    if (c) a.wiki = { t: c.title, d: c.desc, x: c.extract, u: c.url };
  }
  reg.meta.wiki = { resolved: Object.values(cache).filter(Boolean).length, checked: Object.keys(cache).length,
    method: "wikipedia search + traded_as ticker verification for companies; hand-mapped titles for commodities/crypto/FX; unverified matches dropped" };
  await Bun.write(path, JSON.stringify(reg));
  console.log("registry updated");
}
main();
await Bun.$`bun ${new URL(".",import.meta.url).pathname}sync-js.ts`;
