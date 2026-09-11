/* Crypto rows don't have Wikipedia pages (no article for MemeCore or Aster),
   but CoinGecko — the same API that lists them — carries a written description
   per coin. Cached alongside the wiki cache; source labelled separately in the
   sheet so a CoinGecko blurb never poses as an encyclopedia entry. */
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function main() {
  const reg = JSON.parse(await Bun.file("registry/registry.json").text());
  const f = "registry/coin-desc-cache.json";
  const cache: Record<string, any> = await Bun.file(f).exists() ? JSON.parse(await Bun.file(f).text()) : {};
  const rows = reg.assets.filter((a: any) => (a.status === "mintable" || a.status === "weight-capped") && a.cg && (a.cls === "crypto" || a.cls === "currencies" || a.cls === "commodities"));
  const ids = [...new Set(rows.map((a: any) => a.cg))] as string[];
  let i = 0, hit = 0;
  for (const id of ids) {
    if (!(id in cache)) {
      let ok = false;
      for (let attempt = 0; attempt < 4 && !ok; attempt++) {
        const r = await fetch(`https://api.coingecko.com/api/v3/coins/${id}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`);
        if (r.status === 429) { await sleep(20000); continue; }
        const d = r.ok ? await r.json() : null;
        const raw = (d?.description?.en ?? "").replace(/<[^>]+>/g, "").trim();
        cache[id] = raw ? raw.split(/(?<=\.)\s/).slice(0, 3).join(" ").slice(0, 420) : null;
        ok = true;
      }
      await sleep(6500);
      if (++i % 10 === 0) { await Bun.write(f, JSON.stringify(cache)); console.log(`  …${i}/${ids.length}`); }
    }
    if (cache[id]) hit++;
  }
  await Bun.write(f, JSON.stringify(cache));
  const reg2 = JSON.parse(await Bun.file("registry/registry.json").text());   // re-read: wiki pass may have written
  for (const a of reg2.assets) if (a.cg && cache[a.cg] && !a.wiki) a.about = cache[a.cg];
  await Bun.write("registry/registry.json", JSON.stringify(reg2));
  console.log(`coingecko descriptions: ${hit}/${ids.length}`);
}
main();
await Bun.$`bun ${new URL(".",import.meta.url).pathname}sync-js.ts`;
