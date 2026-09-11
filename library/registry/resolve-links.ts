/* Outbound links: what a curator clicks to LEARN about a row.
   Three kinds, all derived (never hand-written URLs):
   1. the token itself  — contract address on the chain's block explorer.
      Addresses come free from CoinGecko's /coins/list?include_platform=true
      (one call for the whole catalog, no per-coin rate-limit cost).
   2. the listed share  — finviz screener + Yahoo quote, but only for tickers
      our own Yahoo relay actually returns a quote for, so no dead links.
   3. the coin page     — CoinGecko, always available when we have an id.
   Chain choice: Solana first (the launch chain), then the issuer's other venues, and we only emit an explorer for
   chains with a known URL shape — an unknown chain gets no link, not a guess. */

const EXPLORER: Record<string, [string, string]> = {
  "robinhood":            ["Robinhood Chain", "https://robinscan.io/token/"],
  "ethereum":             ["Ethereum",        "https://etherscan.io/token/"],
  "arbitrum-one":         ["Arbitrum One",    "https://arbiscan.io/token/"],
  "solana":               ["Solana",          "https://solscan.io/token/"],
  "base":                 ["Base",            "https://basescan.org/token/"],
  "avalanche":            ["Avalanche",       "https://snowtrace.io/token/"],
  "binance-smart-chain":  ["BNB Chain",       "https://bscscan.com/token/"],
  "polygon-pos":          ["Polygon",         "https://polygonscan.com/token/"],
  "optimistic-ethereum":  ["Optimism",        "https://optimistic.etherscan.io/token/"],
  "mantle":               ["Mantle",          "https://mantlescan.xyz/token/"],
  "tron":                 ["Tron",            "https://tronscan.org/#/token20/"],
};
const PREF: Record<string, string[]> = {
  "Backed xStocks":       ["solana"],
  "Ondo Global Markets":  ["solana"],
};
/* Solana edition: the launch chain comes first, so a row's explorer link is the
   mint a bundle would actually hold; other chains only when Solana has nothing. */
const DEFAULT_PREF = ["solana", "ethereum", "base", "arbitrum-one", "polygon-pos", "binance-smart-chain", "avalanche"];

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function getJSON(url: string, tries = 8) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url);
    if (r.ok) return r.json();
    await sleep(r.status === 429 ? 25000 : 4000);
  }
  return null;
}

async function main() {
  const list = await getJSON("https://api.coingecko.com/api/v3/coins/list?include_platform=true");
  if (!list) { console.error("coingecko list unavailable — nothing written"); process.exit(1); }
  const byId: Record<string, any> = Object.fromEntries(list.map((c: any) => [c.id, c]));

  const shareQuotes = await fetch("https://j0n.zo.space/api/bundlr/library-stocks")
    .then(r => r.json()).then(d => d.quotes || {}).catch(() => ({}));

  const reg = JSON.parse(await Bun.file("registry/registry.json").text());
  let nTok = 0, nShare = 0, nCg = 0;

  for (const a of reg.assets) {
    if (a.cg && byId[a.cg]) {
      a.cgUrl = `https://www.coingecko.com/en/coins/${a.cg}`; nCg++;
      const plats = Object.entries(byId[a.cg].platforms || {})
        .filter(([k, v]) => k && v && EXPLORER[k]) as [string, string][];
      if (plats.length) {
        const pref = [...(PREF[a.issuer] || []), ...DEFAULT_PREF];
        const pick = pref.map(p => plats.find(([k]) => k === p)).find(Boolean) || plats[0];
        const [chain, addr] = pick!;
        a.chain = EXPLORER[chain][0];
        a.addr = addr;
        a.addrUrl = EXPLORER[chain][1] + addr;
        a.chains = plats.length;
        nTok++;
      }
    }
    /* the listed share behind a tokenized stock — gated on our own relay
       returning a quote, so every screener link points at a real symbol */
    if (a.cls === "stocks" && shareQuotes[a.t]) {
      a.screener = `https://finviz.com/quote.ashx?t=${encodeURIComponent(a.t)}`;
      a.quotePage = `https://finance.yahoo.com/quote/${encodeURIComponent(a.t)}`;
      nShare++;
    }
    /* futures: the front-month symbol's own quote page */
    if (a.cls === "commodities" && a.yf) a.quotePage = `https://finance.yahoo.com/quote/${encodeURIComponent(a.yf)}`;
  }

  await Bun.write("registry/registry.json", JSON.stringify(reg));
  const m = reg.assets.filter((a: any) => a.status === "mintable" || a.status === "weight-capped");
  const has = (f: string) => m.filter((a: any) => a[f]).length;
  console.log(`links: contract ${has("addrUrl")}/${m.length} · screener ${has("screener")} · quote page ${has("quotePage")} · coingecko ${has("cgUrl")} · wikipedia ${has("wiki")}`);
  console.log(`  (registry-wide: token ${nTok}, share ${nShare}, cg ${nCg})`);
}
main();
await Bun.$`bun ${new URL(".",import.meta.url).pathname}sync-js.ts`;
