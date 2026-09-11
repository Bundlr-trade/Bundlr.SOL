/* Crypto and FX rows can't use the stock resolver's proof gate (a coin has no
   `traded_as` infobox). A topical gate alone is not enough — "is this article
   about crypto" matched Bitcoin to "Cryptocurrency wallet" and Canton to
   "Cocoa bean". So identity is proven by NAME: the article title, with any
   parenthetical qualifier stripped, must equal the asset's name. Anything less
   exact gets no blurb. */
const UA = { "User-Agent": "bundlr-curator-studio/1.0 (registry build; rjonathanmurray@gmail.com)" };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const TOPICAL = /\b(cryptocurrency|blockchain|crypto|stablecoin|digital currency|token|distributed ledger|ledger|coin)\b/i;
const norm = (s: string) => s.toLowerCase().replace(/\s*\([^)]*\)\s*$/, "").replace(/[^a-z0-9]/g, "");

async function summary(title: string) {
  const r = await fetch("https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(title), { headers: UA });
  return r.ok ? r.json() : null;
}
async function search(q: string) {
  const u = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=4&format=json&origin=*`;
  const d = await fetch(u, { headers: UA }).then(r => r.ok ? r.json() : null).catch(() => null);
  return (d?.query?.search || []).map((s: any) => s.title);
}

const dir = new URL(".", import.meta.url).pathname;
const reg = JSON.parse(await Bun.file(dir + "registry.json").text());
const rows = reg.assets.filter((a: any) => (a.status === "mintable" || a.status === "weight-capped")
  && (a.cls === "crypto" || a.cls === "currencies"));
for (const a of rows) delete a.wiki;   // clear the loose-gate run

const seen = new Map<string, any>();
let hit = 0;
for (const a of rows) {
  if (!seen.has(a.n)) {
    let found = null;
    const cands = [a.n, `${a.n} (cryptocurrency)`, `${a.n} (blockchain platform)`, ...await search(`${a.n} cryptocurrency`)];
    for (const title of cands) {
      if (norm(title) !== norm(a.n)) continue;            // name must match
      const s = await summary(title);
      await sleep(250);
      if (!s || s.type === "disambiguation" || !s.extract) continue;
      const blob = `${s.description || ""} ${s.extract}`;
      if (!TOPICAL.test(blob)) continue;                   // and it must be the crypto one
      found = { t: s.title, d: s.description || "", x: String(s.extract).split(/(?<=\.)\s/).slice(0, 3).join(" "), u: s.content_urls?.desktop?.page };
      break;
    }
    seen.set(a.n, found);
  }
  const w = seen.get(a.n);
  if (w) { a.wiki = w; hit++; }
}
await Bun.write(dir + "registry.json", JSON.stringify(reg));
console.log(`crypto/fx wikipedia: ${hit}/${rows.length} rows (${[...seen.values()].filter(Boolean).length}/${seen.size} names verified by title)`);
await Bun.$`bun ${dir}sync-js.ts`;
