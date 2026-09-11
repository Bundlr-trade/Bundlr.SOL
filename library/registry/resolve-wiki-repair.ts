/* Repair pass. The first run cached a null for every stock whose fetch failed,
   not just for stocks that failed verification — Wikipedia rate-limits and the
   fetcher treated a 429 the same as "no match". This redoes only the nulls,
   with retries, and writes null ONLY when every request actually succeeded and
   the traded_as gate still refused the page. */
const UA = { "User-Agent": "bundlr-curator-studio/1.0 (https://bundlr.trade; asset library) node" };
const W = "https://en.wikipedia.org/w/api.php";
const REST = "https://en.wikipedia.org/api/rest_v1/page/summary/";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/* throws on transport/HTTP failure so callers can tell it apart from "no hit" */
async function j(u: string) {
  for (let i = 0; i < 5; i++) {
    try {
      const x = await fetch(u, { headers: UA });
      if (x.status === 429 || x.status >= 500) { await sleep(2000 * (i + 1)); continue; }
      if (!x.ok) throw new Error("http " + x.status);
      return await x.json();
    } catch (e) { if (i === 4) throw e; await sleep(1500 * (i + 1)); }
  }
  throw new Error("exhausted");
}
async function summary(title: string) {
  const d = await j(REST + encodeURIComponent(title.replace(/ /g, "_")));
  if (!d || d.type === "disambiguation" || !d.extract) return null;
  return { title: d.title, desc: d.description ?? null, extract: d.extract, url: d.content_urls?.desktop?.page };
}
async function tickerVerified(title: string, ticker: string) {
  const d = await j(`${W}?action=query&prop=revisions&rvprop=content&rvslots=main&rvsection=0&format=json&titles=${encodeURIComponent(title)}`);
  const txt = (Object.values(d?.query?.pages ?? {})[0] as any)?.revisions?.[0]?.slots?.main?.["*"];
  if (!txt) return false;
  const traded = /traded_as\s*=\s*([\s\S]{0,400})/.exec(txt);
  return !!traded && new RegExp(`\\b${ticker.replace(/\./g, "\\.")}\\b`).test(traded[1]);
}
async function resolveCompany(name: string, ticker: string) {
  const clean = name.replace(/\b(Inc\.?|Corp\.?|Corporation|Co\.?|Ltd\.?|plc|Class [A-C]|Holdings?)\b/gi, " ").replace(/\s+/g, " ").trim();
  for (const q of [name + " company", clean + " company", name]) {
    const d = await j(`${W}?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=5&format=json`);
    for (const s of (d?.query?.search ?? []).slice(0, 4)) {
      await sleep(120);
      if (await tickerVerified(s.title, ticker)) return summary(s.title);
    }
  }
  return null;
}

async function main() {
  const path = "registry/registry.json";
  const cacheFile = "registry/wiki-cache.json";
  const reg = JSON.parse(await Bun.file(path).text());
  const cache: Record<string, any> = JSON.parse(await Bun.file(cacheFile).text());
  const save = () => Bun.write(cacheFile, JSON.stringify(cache, null, 0));

  const live = reg.assets.filter((a: any) => a.status === "mintable" || a.status === "weight-capped");
  const stocks = [...new Map(live.filter((a: any) => a.cls === "stocks").map((a: any) => [a.t, a])).values()] as any[];
  const todo = stocks.filter(a => !cache["stocks:" + a.t]);
  console.log(`repairing ${todo.length} unresolved of ${stocks.length}`);

  let fixed = 0, i = 0;
  for (const a of todo) {
    try {
      const r = await resolveCompany(a.n, a.t);
      cache["stocks:" + a.t] = r;
      if (r) fixed++;
    } catch (e) { /* leave unset so a later run retries instead of caching a lie */ delete cache["stocks:" + a.t]; }
    await sleep(200);
    if (++i % 25 === 0) { await save(); console.log(`  …${i}/${todo.length} · recovered ${fixed}`); }
  }
  await save();

  for (const x of reg.assets) {
    const c = cache[x.cls + ":" + x.t];
    if (c) x.wiki = { t: c.title, d: c.desc, x: c.extract, u: c.url };
  }
  const withWiki = new Set(stocks.filter(a => cache["stocks:" + a.t]).map(a => a.t));
  reg.meta.wiki = { resolvedTickers: withWiki.size, stockTickers: stocks.length,
    method: "wikipedia search + traded_as ticker verification for companies; hand-mapped titles for commodities/crypto/FX; unverified matches dropped" };
  await Bun.write(path, JSON.stringify(reg));
  console.log(`recovered ${fixed}; stocks now ${withWiki.size}/${stocks.length} (${Math.round(100 * withWiki.size / stocks.length)}%)`);
}
main();
await Bun.$`bun ${new URL(".",import.meta.url).pathname}sync-js.ts`;
