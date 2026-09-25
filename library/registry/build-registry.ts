// bundlr on Solana — asset registry builder
// Compiles the library from live sources into registry.json + registry.js.
// Run: bun library/registry/build-registry.ts          (from the repo root or anywhere)
//
// One launch chain: Solana. Every row that can be held by a bundle carries a
// Solana mint address (`addr`) taken from CoinGecko's platform map or the
// issuer's docs; settleable.ts re-checks each mint on-chain and quotes depth
// through Jupiter before any row is called live.
//
// Sources:
//   stocks      CoinGecko coins list (include_platform) — two Solana issuers:
//               Backed xStocks (Token-2022, permissionless secondary) and
//               Ondo Global Markets (Token-2022, primary mint/redeem at NAV).
//               GICS sectors joined from the S&P 500 constituents dataset, ETFs
//               classified by name, rest "Other stocks". Every row carries an
//               `issuer` facet. On-chain marks + pooled liquidity + the
//               underlying's reference price from Jupiter Price API v3.
//   commodities hand-curated CME/ICE/NYMEX/CBOT/COMEX contract list (futures,
//               no rail — shown so the shelf is honest about what is missing)
//               + tokenized gold live from CoinGecko: XAUT0 (Tether Gold,
//               native Solana mint via LayerZero).
//   predictions Kalshi — every open market through the public trade API, gated:
//               open interest > $10K (deep tier at $25K printed on the row) ·
//               yes bid/ask spread < 5¢ · last price 2–98¢ · single-game and
//               player-prop series dropped · under 1 day to close dropped ·
//               inside 30d to close = watch-only (shown, not mintable).
//               Shelves are Kalshi's own series categories. Every row carries
//               the Solana rail: YES/NO Token-2022 outcome tokens minted by
//               DFlow's Prediction Markets API (tokenized on first order).
//               Run with --predictions-only to splice fresh rows into the
//               existing registry.json without refetching stocks/crypto.
//   crypto      Jupiter Tokens API v2 verified list, gated on Jupiter's own
//               mcap / pooled liquidity / holders / organic score, shelved by
//               Jupiter's tags (Majors, Stables, Staked SOL, Meme, Solana DeFi,
//               DePIN & infra, RWA & yield) with CoinGecko categories naming
//               the rest. BTC and ETH settle through rails.json aliases
//               (cbBTC, Portal WETH). Tokenized T-bills hand-curated. Pyth
//               feed id on every row Hermes covers.
//   currencies  one row per currency (every Pyth FX feed against USD, plus
//               ILS/AED): Yahoo spot at build, Pyth feed id stamped, rail =
//               the largest Jupiter-verified stablecoin on peg over $1M;
//               railless rows stay on the shelf like CME contracts.
//
// Splice: bun build-registry.ts --only crypto,currencies  (keeps the rest)

const OUT_DIR = new URL(".", import.meta.url).pathname;

const ETF_WORDS = /\b(etf|trust|fund|ishares|vanguard|spdr|invesco|proshares|direxion|ark|index|shares)\b/i;
const SOLSCAN = "https://solscan.io/token/";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// All CoinGecko calls funnel through one paced queue — parallel builders were
// tripping the public-API rate limit (429). One request at a time, >=6s apart.
let cgChain: Promise<any> = Promise.resolve();
const CG_GAP = 6_000;
// Jupiter's free tier (lite-api) wants ~1 request per second.
let jupChain: Promise<any> = Promise.resolve();
const JUP_GAP = 1_200;

async function rawFetch(url: string) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { headers: { "User-Agent": "bundlr-solana-registry/1.0" } });
    if (r.ok) return r.json();
    if ((r.status === 429 || r.status >= 500) && attempt < 8) {
      const wait = 20_000 * (attempt + 1);
      console.warn(`${r.status}, waiting ${wait / 1000}s… ${url.slice(0, 80)}`);
      await new Promise((res) => setTimeout(res, wait));
      continue;
    }
    throw new Error(`${r.status} ${url}`);
  }
}
function paced(chainRef: { p: Promise<any> }, gap: number, url: string) {
  const next = chainRef.p.then(async () => {
    const out = await rawFetch(url);
    await new Promise((r) => setTimeout(r, gap));
    return out;
  });
  chainRef.p = next.catch(() => {});
  return next;
}
const CG = { p: cgChain }, JUP = { p: jupChain };
function fetchJSON(url: string) {
  if (/coingecko\.com/.test(url)) return paced(CG, CG_GAP, url);
  if (/jup\.ag/.test(url)) return paced(JUP, JUP_GAP, url);
  return rawFetch(url);
}

// ── Jupiter Price API v3: on-chain mark, pooled liquidity, 24h change, and
//    for tokenized stocks the underlying's reference price (`stockData`). ──
async function jupPrices(mints: string[]): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  const ids = [...new Set(mints.filter(Boolean))];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    try {
      const d = await fetchJSON(`https://lite-api.jup.ag/price/v3?ids=${chunk.join(",")}`);
      for (const [mint, v] of Object.entries<any>(d ?? {})) out[mint] = v;
    } catch (e: any) { console.warn("jupiter price batch failed:", e.message); }
    if (i % 250 === 0) console.log(`jupiter prices ${Math.min(i + 50, ids.length)}/${ids.length}`);
  }
  return out;
}

// ── STOCKS ──────────────────────────────────────────────────────────────
const PRE_IPO = /spacex|space exploration technologies|openai|anthropic|prestocks/i;

async function buildStocks() {
  const list: any[] = await fetchJSON("https://api.coingecko.com/api/v3/coins/list?include_platform=true");

  const csv = await (await fetch("https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv")).text();
  const sectors: Record<string, string> = {};
  for (const line of csv.split("\n").slice(1)) {
    const m = line.match(/^([A-Z.\-]+),(?:"[^"]*"|[^,]*),([^,]+),/);
    if (m) sectors[m[1]] = m[2];
  }

  const out: any[] = [];
  const add = (issuer: string, venue: string, coins: any[], clean: (n: string) => string, tick: (c: any) => string) => {
    const seen = new Set<string>();
    for (const c of coins) {
      if (PRE_IPO.test(c.name)) continue;
      const mint = c.platforms?.solana;
      if (!mint) continue;                       // Solana or nothing
      const ticker = tick(c);
      if (!ticker || seen.has(ticker)) continue;
      seen.add(ticker);
      const name = clean(c.name);
      const isETF = ETF_WORDS.test(name);
      const sub = isETF ? "ETFs" : (sectors[ticker] ?? "Other stocks");
      out.push({ t: ticker, n: name, cls: "stocks", sub, issuer, venue, status: "mintable", src: "coingecko", id: c.id,
        chain: "Solana", addr: mint, addrUrl: SOLSCAN + mint, chains: Object.values(c.platforms || {}).filter(Boolean).length });
    }
  };

  add("Backed xStocks", "xStock · Solana",
    list.filter((c: any) => /\bxstock$/i.test(c.name) && !/wrapped|bridged/i.test(c.name)),
    (n) => n.replace(/\s*xstock$/i, "").replace(/\s+tokenized stock$/i, "").trim(),
    (c) => c.symbol.toUpperCase().replace(/X$/, ""));

  add("Ondo Global Markets", "Ondo GM · Solana · mint at NAV",
    list.filter((c: any) => /ondo tokenized/i.test(c.name)),
    (n) => n.replace(/\s*\(ondo tokenized[^)]*\)\s*$/i, "").replace(/\s*ondo tokenized.*$/i, "").trim(),
    (c) => c.symbol.toUpperCase().replace(/ON$/, ""));

  // CoinGecko markets: 24h volume across venues, reference price when Jupiter has none
  const mktById: Record<string, any> = {};
  const ids = out.map((s) => s.id);
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100).join(",");
    const mkts = await fetchJSON(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${chunk}&per_page=100`);
    for (const m of mkts) mktById[m.id] = m;
    console.log(`markets ${Math.min(i + 100, ids.length)}/${ids.length}`);
  }
  // Jupiter: the on-chain mark is what a Zap actually pays; pooled liquidity is the gate.
  const jup = await jupPrices(out.map((s) => s.addr));

  // liquidity gate (Solana): Jupiter pooled liquidity >= $100K = mintable, below = thin.
  const STOCK_LIQ_FLOOR = 100_000;
  for (const s of out) {
    const m = mktById[s.id];
    s.vol = Math.round(m?.total_volume ?? 0);
    s.cg = s.id;
    const j = jup[s.addr];
    if (j) {
      s.jup = { px: j.usdPrice ?? null, liq: j.liquidity != null ? Math.round(j.liquidity) : null, chg: j.priceChange24h ?? null, dec: j.decimals ?? null,
        stock: j.stockData ? { px: j.stockData.price, mcap: j.stockData.mcap ?? null, at: j.stockData.updatedAt ?? null } : null };
    }
    // price shown = on-chain mark when Jupiter has one; else the underlying reference; else CoinGecko
    if (j?.usdPrice != null) { s.price = j.usdPrice; s.chg = j.priceChange24h ?? null; s.pxSrc = "jupiter"; }
    else if (j?.stockData?.price != null) { s.price = j.stockData.price; s.chg = m?.price_change_percentage_24h ?? null; s.pxSrc = "reference"; }
    else if (m?.current_price != null) { s.price = m.current_price; s.chg = m.price_change_percentage_24h ?? null; s.pxSrc = "coingecko"; }
    if (s.jup?.stock?.px && s.jup?.px) s.premium = +(100 * (s.jup.px / s.jup.stock.px - 1)).toFixed(2);
    // Ondo (primary liquidity): the protocol sources from the issuer at NAV — secondary depth is the wrong gate.
    if (s.issuer === "Ondo Global Markets") { s.gate = "primary"; }
    else if (!((s.jup?.liq ?? 0) >= STOCK_LIQ_FLOOR)) { s.status = "thin"; s.venue += " · thin"; }
    delete s.id;
  }
  out.sort((a, b) => a.t.localeCompare(b.t) || a.issuer.localeCompare(b.issuer));
  return out;
}

// ── COMMODITIES (hand-curated, real contracts) ──────────────────────────
const COMMODITIES: [string, string, string, string, string?][] = [
  ["GC","Gold","Metals","COMEX · front-month"],["SI","Silver","Metals","COMEX · front-month"],
  ["HG","Copper","Metals","COMEX · front-month"],["PL","Platinum","Metals","NYMEX · front-month"],
  ["PA","Palladium","Metals","NYMEX · front-month"],["ALI","Aluminum","Metals","COMEX · front-month"],
  ["HRC","Steel HRC","Metals","NYMEX · weight-capped"],["LTH","Lithium Hydroxide","Metals","CME · weight-capped"],
  ["CO","Cobalt","Metals","CME · weight-capped"],
  ["CL","WTI Crude","Energy","NYMEX · front-month"],["BZ","Brent Crude","Energy","ICE · front-month"],
  ["NG","Natural Gas","Energy","NYMEX · front-month"],["RB","RBOB Gasoline","Energy","NYMEX · front-month"],
  ["HO","Heating Oil","Energy","NYMEX · front-month"],["PJM","PJM Power","Energy","NYMEX · weight-capped"],
  ["EH","Ethanol","Energy","CBOT · weight-capped"],["MTF","Coal API2","Energy","ICE · weight-capped"],
  ["ZC","Corn","Agriculture","CBOT · front-month"],["ZW","Chicago Wheat","Agriculture","CBOT · front-month"],
  ["KE","KC Wheat","Agriculture","CBOT · front-month"],["ZS","Soybeans","Agriculture","CBOT · front-month"],
  ["ZM","Soybean Meal","Agriculture","CBOT · front-month"],["ZL","Soybean Oil","Agriculture","CBOT · front-month"],
  ["ZO","Oats","Agriculture","CBOT · weight-capped"],["ZR","Rough Rice","Agriculture","CBOT · weight-capped"],
  ["CT","Cotton","Agriculture","ICE · front-month"],["KC","Coffee C","Agriculture","ICE · front-month"],
  ["SB","Sugar No.11","Agriculture","ICE · front-month"],["CC","Cocoa","Agriculture","ICE · front-month"],
  ["OJ","Orange Juice","Agriculture","ICE · weight-capped"],["LBR","Lumber","Agriculture","CME · weight-capped"],
  ["RS","Canola","Agriculture","ICE · weight-capped"],["DF","Dried Whey","Agriculture","CME · weight-capped"],
  ["ZP","Peanuts","Agriculture","illustrative","ill"],
  ["LE","Live Cattle","Livestock & dairy","CME · front-month"],["GF","Feeder Cattle","Livestock & dairy","CME · front-month"],
  ["HE","Lean Hogs","Livestock & dairy","CME · front-month"],["PRK","Pork Cutout","Livestock & dairy","CME · weight-capped"],
  ["DC","Class III Milk","Livestock & dairy","CME · front-month"],["CB","Cash-Settled Butter","Livestock & dairy","CME · weight-capped"],
  ["EGGS","Fresh Eggs (delisted 1982)","Livestock & dairy","illustrative · not mintable","ill"],
];
// Yahoo Finance front-month symbols — quoted live by the zo.space relay
// /api/bundlr/library-quotes (Yahoo blocks browser CORS, so it's server-relayed).
const COMMODITY_YF: Record<string, string> = {
  GC: "GC=F", SI: "SI=F", HG: "HG=F", PL: "PL=F", PA: "PA=F", ALI: "ALI=F", HRC: "HRC=F",
  CL: "CL=F", BZ: "BZ=F", NG: "NG=F", RB: "RB=F", HO: "HO=F",
  ZC: "ZC=F", ZW: "ZW=F", KE: "KE=F", ZS: "ZS=F", ZM: "ZM=F", ZL: "ZL=F", ZO: "ZO=F", ZR: "ZR=F",
  CT: "CT=F", KC: "KC=F", SB: "SB=F", CC: "CC=F", OJ: "OJ=F", LBR: "LBR=F", RS: "RS=F",
  LE: "LE=F", GF: "GF=F", HE: "HE=F", DC: "DC=F", CB: "CB=F",
};
async function buildCommodities(platforms: Record<string, any>) {
  const rows: any[] = COMMODITIES.map(([t, n, sub, venue, ill]) => ({
    t, n, cls: "commodities", sub, venue,
    status: ill ? "illustrative" : venue.includes("weight-capped") ? "weight-capped" : "mintable",
    ghost: !!ill, src: "hand-curated", yf: COMMODITY_YF[t],
  }));
  // tokenized gold with a native Solana mint: XAUT0 (Tether Gold via LayerZero). PAXG has no Solana issuance.
  const gold = await fetchJSON("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=tether-gold-tokens");
  for (const c of gold) {
    const mint = platforms[c.id]?.solana; if (!mint) continue;
    rows.push({
      t: c.symbol.toUpperCase(), n: "Tether Gold (XAUT0)", cls: "commodities", sub: "Metals",
      venue: `tokenized · redeemable · $${(c.market_cap / 1e6).toFixed(0)}M on Solana`,
      status: "mintable", ghost: false, src: "coingecko", cg: c.id,
      price: c.current_price, chg: c.price_change_percentage_24h ?? null,
      chain: "Solana", addr: mint, addrUrl: SOLSCAN + mint, chains: Object.values(platforms[c.id] || {}).filter(Boolean).length,
    });
  }
  return rows;
}

// ── PREDICTIONS (Kalshi via the public trade API, tokenized on Solana by DFlow) ──
const GATES = { minLiquidity: 10_000, deepLiquidity: 25_000, maxSpread: 0.05, oddsLo: 0.02, oddsHi: 0.98, mintDays: 30 };
const PRED_SOURCE = "Kalshi public trade API, every open market (OI>$10K · deep at $25K · spread<5¢ · 2–98¢ · single-game and player-prop series dropped · <1d dropped · <30d = watch-only) — shelves are Kalshi series categories; no per-event dedup, every market is inventory; Solana rail: YES/NO Token-2022 outcome tokens minted by DFlow (tokenizable)";
// Kalshi series categories → the library's shelf names (same set the Polygon-era build used).
const CATEGORY_SHELF: Record<string, string> = {
  "Politics": "Politics", "Elections": "Politics", "Economics": "Economy", "Financials": "Finance", "Companies": "Business",
  "Crypto": "Crypto", "Science and Technology": "Tech", "Technology": "Tech", "Science": "Science", "Climate and Weather": "Weather", "Weather": "Weather",
  "Entertainment": "Culture", "Culture": "Culture", "Sports": "Sports", "World": "Geopolitics", "Geopolitics": "Geopolitics", "Health": "Health", "Transportation": "World", "Social": "Culture",
};
// Single-game and player-prop series are a slot machine, not inventory. Kalshi
// game series end in GAME / MATCH / SPREAD / TOTAL; prop series carry the stat.
const SINGLE_GAME = /(GAME|MATCH|SPREAD|TOTAL|MONEYLINE|1H|HALF|QUARTER|SET|INNING|MAP|ROUND)$|^KX(MLB|NBA|NFL|NHL|WNBA|MLS|NCAA[A-Z]*|EPL|UCL|UEL|LALIGA|SERIEA|BUNDESLIGA|LIGUE1|ATP|WTA|UFC|PGA|F1|NASCAR|CFB|CBB)[A-Z]*(KS|HR|PTS|AST|REB|TD|YDS|RUNS|HITS|SAVES|GOALS|SOG|3PT|STL|BLK|PASS|RUSH|REC|SCORER|FIRSTGOAL|TOUCHDOWN|ANYTIME)/i;
const MIN_DAYS = 1;
const PRED_RAIL = { chain: "Solana", status: "tokenizable", launch: true, addr: null, as: "Kalshi YES / NO outcome token (Token-2022, minted by DFlow)", venue: "Kalshi order book via DFlow CLP", note: "DFlow tokenizes the market on the first /order (USDC → YES or NO mint); pre-minted yesMint/noMint come from the DFlow metadata API. Winning tokens redeem for USDC after resolution." };

async function kalshiSeries(): Promise<Record<string, { category: string; title: string; tags: string[] }>> {
  const map: Record<string, any> = {};
  let cursor = "";
  for (let page = 0; page < 200; page++) {
    const r = await fetchJSON(`https://api.elections.kalshi.com/trade-api/v2/series?limit=200${cursor ? `&cursor=${cursor}` : ""}`);
    for (const se of r.series ?? []) if (se.ticker) map[se.ticker] = { category: se.category ?? "", title: se.title ?? "", tags: se.tags ?? [] };
    cursor = r.cursor;
    if (!cursor || !(r.series ?? []).length) break;
    await new Promise((res) => setTimeout(res, 150));
  }
  return map;
}
async function buildPredictions() {
  const series = await kalshiSeries();
  console.log(`kalshi series: ${Object.keys(series).length}`);
  const minTs = Math.floor((Date.now() + MIN_DAYS * 86_400_000) / 1000);
  const raw: any[] = [];
  let cursor = "";
  for (let page = 0; page < 400; page++) {
    const r = await fetchJSON(`https://api.elections.kalshi.com/trade-api/v2/markets?limit=1000&status=open&min_close_ts=${minTs}${cursor ? `&cursor=${cursor}` : ""}`);
    raw.push(...(r.markets ?? []));
    cursor = r.cursor;
    if (!cursor || !(r.markets ?? []).length) break;
    if (page % 10 === 0) console.log(`kalshi markets ${raw.length}…`);
    await new Promise((res) => setTimeout(res, 150));
  }
  const f = (v: any) => parseFloat(v ?? "0") || 0;
  const now = Date.now();
  const funnel = { events: new Set(raw.map((m) => m.event_ticker)).size, singleGame: 0, fetched: raw.length, liquidity: 0, spread: 0, band: 0, kept: 0, watchOnly: 0, deep: 0 };
  const out: any[] = [];
  for (const m of raw) {
    const seriesTicker = String(m.event_ticker ?? m.ticker ?? "").split("-")[0];
    if (SINGLE_GAME.test(seriesTicker)) { funnel.singleGame++; continue; }
    const oi = f(m.open_interest_fp);               // Kalshi's liquidity_dollars reports 0 on the public feed; OI is the depth signal
    if (!(oi > GATES.minLiquidity)) continue;
    funnel.liquidity++;
    const bid = f(m.yes_bid_dollars), ask = f(m.yes_ask_dollars);
    const spread = ask > 0 && bid > 0 ? ask - bid : 1;
    if (!(spread < GATES.maxSpread)) continue;
    funnel.spread++;
    const price = f(m.last_price_dollars) || (bid && ask ? (bid + ask) / 2 : 0);
    if (!(price >= GATES.oddsLo && price <= GATES.oddsHi)) continue;
    funnel.band++;
    const end = new Date(m.close_time ?? 0).getTime();
    if (!end || end < now) continue;
    const days = (end - now) / 86_400_000;
    if (days < MIN_DAYS) continue;
    funnel.kept++;
    const watch = days <= GATES.mintDays; if (watch) funnel.watchOnly++;
    const deep = oi > GATES.deepLiquidity; if (deep) funnel.deep++;
    const se = series[seriesTicker];
    const sub = CATEGORY_SHELF[se?.category ?? ""] ?? (se?.category || "World");
    const leg = m.yes_sub_title && m.yes_sub_title !== m.title ? m.yes_sub_title : null;
    const tags = [...new Set([se?.category, se?.title, ...(se?.tags ?? [])].filter(Boolean))] as string[];
    out.push({
      t: "YES", n: leg && !m.title.includes(leg) ? `${m.title} [${leg}]` : m.title, cls: "predictions", sub, tags,
      ev: m.title, evId: m.event_ticker, leg,
      venue: `Kalshi · ${Math.round(price * 100)}¢ · $${Math.round(oi / 1000)}K OI`,
      status: watch ? "watch-only" : "mintable",
      endDate: m.close_time, liquidity: Math.round(oi), deep, spread: +spread.toFixed(3), price, prev: f(m.previous_price_dollars) || undefined, src: "kalshi",
      kid: m.ticker, series: seriesTicker, vol: Math.round(f(m.volume_fp)), vol24: Math.round(f(m.volume_24h_fp)), slug: m.event_ticker ?? undefined,
      rules: String(m.rules_primary ?? "").replace(/\s+/g, " ").trim().slice(0, 320) || null,
      rail: { ...PRED_RAIL, checked: new Date().toISOString().slice(0, 10) },
    });
  }
  return { assets: out, funnel };
}

// ── CRYPTO (Jupiter's verified list, gated; shelves are Jupiter's own tags) ──
// Research: bundlr/docs/solana-library-crypto-fx-research-2026-09-25.md.
// Universe = every mint Jupiter verifies (~3,700). Gates are Jupiter's own
// measures standing in for the Robinhood build's cap / volume / age; the $50K
// depth quote in settleable.ts is the rail test that actually matters.
// Shelves file once by priority: Stables › Majors › Staked SOL › Meme ›
// Solana DeFi › DePIN & infra › RWA & yield › a CoinGecko category (Layer 1,
// Layer 2, AI, Gaming, Privacy) › Other. BTC and ETH are rows in their own
// right, settled through the rails.json aliases (cbBTC, Portal WETH); the
// wrapped copies themselves are folded, not listed. Ticker and name come from
// CoinGecko when the mint maps to a CoinGecko id (keys stay stable across
// builds), else from Jupiter.
const CRYPTO_GATE = { minMcapUsd: 50_000_000, minLiqUsd: 250_000, minHolders: 5_000, minOrganic: 40, lstTop: 8, _about: "invented 2026-09-25, not signed off — Jupiter mcap · pooled liquidity · holders · organic score; $1M liquidity was the first draft and dropped JTO, PYTH, ORCA, RENDER, HNT, GRASS (Jupiter's pool figure sits at $300–500K for them), so the floor is $250K and settleable.ts's $50K depth quote decides live vs thin" };
const DROP_TAGS = new Set(["deprecated", "duplicate", "xstocks", "prestocks", "ondo", "stocks", "equities", "commodities", "pre-ipo"]);
const NOISE_TAGS = /^(verified|community|community-assist|strict|moonshot|moonshot-verified|birdeye-trending|backpack|internal|shift|tessera|launchpad|token-2022)$/;
const CG_SHELVES: [string, string[]][] = [["Layer 1", ["layer-1", "smart-contract-platform"]], ["Layer 2", ["layer-2"]], ["AI", ["artificial-intelligence"]], ["Gaming", ["gaming"]], ["Privacy", ["privacy-coins"]], ["DePIN & infra", ["depin"]]];
const SHELF_ORDER = ["Majors", "Stables", "Staked SOL", "Meme", "Solana DeFi", "DePIN & infra", "RWA & yield", "Layer 1", "Layer 2", "AI", "Gaming", "Privacy", "Other", "Tokenized T-bills"];
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const WSOL = "So11111111111111111111111111111111111111112";
const WRAPPED = /^(wbtc|weth|cbbtc|tbtc|zbtc|xbtc|wsol)$/i;
const STABLE_IDS = new Set(["tether","usd-coin","dai","usds","ethena-usde","first-digital-usd","paypal-usd","usd1-wlfi","usdt0","falcon-finance","binance-bridged-usdt-bnb-smart-chain","usdtb","world-liberty-financial-usd","ripple-usd","global-dollar"]);
const TBILLS: [string, string, string, string][] = [
  ["USDY","Ondo US Dollar Yield","0–3mo","ondo-us-dollar-yield"],["OUSG","Ondo Short-Term US Gov","0–1yr","ousg"],
  ["BUIDL","BlackRock USD Institutional","0–3mo","blackrock-usd-institutional-digital-liquidity-fund"],["USTB","Superstate Short Duration","0–1yr","superstate-short-duration-us-government-securities-fund-ustb"],
  ["TBILL","OpenEden T-Bill Vault","0–3mo","openeden-tbill"],["USYC","Hashnote US Yield Coin","0–3mo","hashnote-usyc"],
];
function attachMint(row: any, plat: any) {
  const mint = plat?.solana; if (!mint) return row;
  row.chain = "Solana"; row.addr = mint; row.addrUrl = SOLSCAN + mint; row.chains = Object.keys(plat).filter((k) => plat[k]).slice(0, 12);
  return row;
}
const RAILS = JSON.parse(await Bun.file(OUT_DIR + "rails.json").text());
const CARRY = ["wiki", "near", "wd", "about", "yld"];

type JupToken = { id: string; name: string; symbol: string; decimals?: number; tokenProgram?: string; holderCount?: number; mcap?: number; usdPrice?: number; liquidity?: number; organicScore?: number; tags?: string[]; audit?: any; firstPool?: { createdAt?: string }; stats24h?: { priceChange?: number; buyVolume?: number; sellVolume?: number } };
let jupVerifiedCache: JupToken[] | null = null;
async function jupVerified(): Promise<JupToken[]> {
  if (!jupVerifiedCache) { jupVerifiedCache = await fetchJSON("https://lite-api.jup.ag/tokens/v2/tag?query=verified"); console.log(`jupiter verified: ${jupVerifiedCache!.length}`); }
  return jupVerifiedCache!;
}
// Pyth Hermes feed ids (the id search is keyless; the price endpoint needs
// PYTH_API_KEY, so ids are stamped now and priced later by the API relay).
async function pythFeeds(assetType: string): Promise<Record<string, string>> {
  try { const d: any[] = await rawFetch(`https://hermes.pyth.network/v2/price_feeds?asset_type=${assetType}`); const m: Record<string, string> = {}; for (const f of d) if (f?.attributes?.symbol) m[f.attributes.symbol] = f.id; return m; }
  catch (e: any) { console.warn("pyth feeds:", e.message); return {}; }
}
const jupRow = (tk: JupToken) => ({ px: tk.usdPrice ?? null, liq: tk.liquidity != null ? Math.round(tk.liquidity) : null, chg: tk.stats24h?.priceChange ?? null, dec: tk.decimals ?? null, holders: tk.holderCount ?? null, organic: tk.organicScore != null ? Math.round(tk.organicScore) : null });
const fmtCap = (n: number) => n >= 1e9 ? `$${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B` : `$${(n / 1e6).toFixed(0)}M`;
const vol24 = (tk: JupToken) => (tk.stats24h?.buyVolume ?? 0) + (tk.stats24h?.sellVolume ?? 0);

async function buildCrypto(platforms: Record<string, any>, cgList: any[], old: Record<string, any>) {
  const verified = await jupVerified();
  const cgById: Record<string, any> = Object.fromEntries(cgList.map((c: any) => [c.id, c]));
  const mintToCg: Record<string, any> = {};
  for (const c of cgList) { const m = c.platforms?.solana; if (m && !mintToCg[m]) mintToCg[m] = c; }
  const pyth = await pythFeeds("crypto");
  const member: Record<string, Set<string>> = {};
  for (const [, cats] of CG_SHELVES) for (const cat of cats) {
    member[cat] = new Set();
    try { const rows = await fetchJSON(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=${cat}&order=market_cap_desc&per_page=250&page=1`); for (const r of rows) member[cat].add(r.id); }
    catch (e: any) { console.warn(`category ${cat}:`, e.message); }
  }
  // BTC and ETH: the alias mint carries the row (rails.json: BTC → cbBTC, ETH → WETH)
  const fold: Record<string, [string, string, string]> = {};
  for (const [t, cg, n] of [["BTC", "bitcoin", "Bitcoin"], ["ETH", "ethereum", "Ethereum"]]) {
    const alias = RAILS.aliases?.[t]; const r = RAILS.rails.find((x: any) => x.t === alias);
    if (r) fold[r.addr] = [t, n, cg];
  }
  const foldMkts = await fetchJSON(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin,ethereum,${TBILLS.map(([,,,id]) => id).join(",")}`);
  const cgMkt: Record<string, any> = Object.fromEntries(foldMkts.map((c: any) => [c.id, c]));
  const tbillMints = new Set(TBILLS.map(([,,,id]) => platforms[id]?.solana).filter(Boolean));

  const byMcap = [...verified].sort((a, b) => (b.mcap ?? 0) - (a.mcap ?? 0));
  const lstKeep = new Set(byMcap.filter((t) => t.tags?.includes("original-lst") && !(t.tags ?? []).some((x) => DROP_TAGS.has(x))).slice(0, CRYPTO_GATE.lstTop).map((t) => t.id));
  const funnel = { verified: verified.length, droppedTags: 0, lstBeyondTop: 0, mcap: 0, liquidity: 0, holders: 0, organic: 0, wrappedFolded: 0, fxStable: 0, kept: 0 };
  const seen = new Set<string>(); const out: any[] = []; const byShelf: Record<string, number> = {};
  for (const tk of byMcap) {
    const tags = tk.tags ?? [];
    if (tags.some((x) => DROP_TAGS.has(x))) { funnel.droppedTags++; continue; }
    if (tbillMints.has(tk.id)) continue;
    if (tags.includes("lst") && !lstKeep.has(tk.id)) { funnel.lstBeyondTop++; continue; }
    if (!((tk.mcap ?? 0) >= CRYPTO_GATE.minMcapUsd)) continue; funnel.mcap++;
    if (!((tk.liquidity ?? 0) >= CRYPTO_GATE.minLiqUsd)) continue; funnel.liquidity++;
    if (!((tk.holderCount ?? 0) >= CRYPTO_GATE.minHolders)) continue; funnel.holders++;
    if (!((tk.organicScore ?? 0) >= CRYPTO_GATE.minOrganic)) continue; funnel.organic++;
    const f = fold[tk.id];
    if (!f && WRAPPED.test(tk.symbol)) { funnel.wrappedFolded++; continue; }
    const cgc = f ? cgById[f[2]] : tk.id === WSOL ? cgById["solana"] : mintToCg[tk.id];
    const t = f ? f[0] : (cgc?.symbol || tk.symbol).replace(/^\$/, "").toUpperCase();
    if (seen.has(t)) continue; seen.add(t);
    const n = f ? f[1] : (cgc?.name || tk.name);
    const stable = tags.includes("stable") || (cgc && STABLE_IDS.has(cgc.id));
    if (stable && Math.abs((tk.usdPrice ?? 1) - 1) > 0.03) { funnel.fxStable++; continue; } // EURC and friends are currencies, not crypto
    const cats = cgc ? CG_SHELVES.flatMap(([shelf, ids]) => ids.some((i) => member[i]?.has(cgc.id)) ? [shelf] : []) : [];
    const sub = stable ? "Stables" : f || tags.includes("major") ? "Majors" : tags.includes("original-lst") ? "Staked SOL" : tags.includes("meme") ? "Meme"
      : tags.includes("defi") ? "Solana DeFi" : tags.includes("infra") ? "DePIN & infra" : tags.some((x) => x === "rwa" || x === "yield" || x === "yb") ? "RWA & yield" : cats[0] || "Other";
    const plats = cgc?.platforms || { solana: tk.id };
    const mk = f ? cgMkt[f[2]] : null;
    const mcap = Math.round(mk?.market_cap ?? tk.mcap ?? 0);
    const row: any = {
      t, n, cls: "crypto", sub, status: "mintable",
      venue: stable ? `stablecoin · ${fmtCap(mcap)} cap · Solana` : `Solana · ${fmtCap(mcap)} cap · $${(vol24(tk) / 1e6).toFixed(vol24(tk) >= 1e7 ? 0 : 1)}M 24h on Jupiter · ${((tk.holderCount ?? 0) / 1e3).toFixed(0)}K holders${f ? ` · settles as ${RAILS.aliases[t]}` : ""}`,
      chain: "Solana", addr: tk.id, addrUrl: SOLSCAN + tk.id, addrSrc: "jupiter verified list", chains: Object.keys(plats).filter((k) => plats[k]).slice(0, 12),
      program: tk.tokenProgram === TOKEN_2022 ? "Token-2022" : "Token",
      cg: cgc?.id, cgUrl: cgc ? `https://www.coingecko.com/en/coins/${cgc.id}` : undefined,
      price: mk?.current_price ?? tk.usdPrice ?? null, chg: mk?.price_change_percentage_24h ?? tk.stats24h?.priceChange ?? null,
      mcap, vol: Math.round(mk?.total_volume ?? vol24(tk)), holders: tk.holderCount ?? null, organic: tk.organicScore != null ? Math.round(tk.organicScore) : null,
      jupTags: tags.filter((x) => !NOISE_TAGS.test(x)), cats: cats.length ? cats : undefined,
      firstPool: tk.firstPool?.createdAt?.slice(0, 10) ?? null,
      jup: jupRow(tk), pyth: pyth[`Crypto.${t}/USD`] ?? null, src: "jupiter tokens v2 verified list", gates: CRYPTO_GATE,
    };
    const o = old[cgc?.id ?? ""] ?? old["t:" + t]; if (o) for (const k of CARRY) if (o[k] !== undefined) row[k] = o[k];
    out.push(row); byShelf[sub] = (byShelf[sub] || 0) + 1;
  }
  funnel.kept = out.length;
  for (const [t, n, dur, id] of TBILLS) {
    const c = cgMkt[id];
    const row: any = attachMint({ t, n, cls: "crypto", sub: "Tokenized T-bills", venue: `${dur} · yield`, status: "mintable", src: c ? "coingecko" : "hand-curated", cg: id, cgUrl: `https://www.coingecko.com/en/coins/${id}`, price: c?.current_price ?? null, chg: c?.price_change_percentage_24h ?? null, mcap: c?.market_cap ?? null }, platforms[id]);
    const tk = row.addr ? verified.find((x) => x.id === row.addr) : null; if (tk) row.jup = jupRow(tk);
    const o = old[id]; if (o) for (const k of CARRY) if (o[k] !== undefined) row[k] = o[k];
    out.push(row); byShelf["Tokenized T-bills"] = (byShelf["Tokenized T-bills"] || 0) + 1;
  }
  out.sort((a, b) => SHELF_ORDER.indexOf(a.sub) - SHELF_ORDER.indexOf(b.sub) || (b.mcap ?? 0) - (a.mcap ?? 0));
  let trending: string[] = [];
  try { const top: JupToken[] = await fetchJSON("https://lite-api.jup.ag/tokens/v2/toporganicscore/24h?limit=50"); const byMint: Record<string, any> = Object.fromEntries(out.map((a) => [a.addr, a])); trending = top.map((x) => byMint[x.id]?.cg).filter(Boolean); }
  catch (e: any) { console.warn("jupiter trending:", e.message); }
  console.log("crypto funnel", funnel); console.log("crypto shelves", byShelf);
  return { assets: out, meta: { built: new Date().toISOString(), gates: CRYPTO_GATE, funnel, shelves: SHELF_ORDER, byShelf }, trending };
}
const CRYPTO_SOURCE = `Jupiter Tokens API v2 verified list (~3,700 mints) · gates ≥ $${CRYPTO_GATE.minMcapUsd / 1e6}M cap, ≥ $${CRYPTO_GATE.minLiqUsd / 1e3}K pooled liquidity, ≥ ${CRYPTO_GATE.minHolders.toLocaleString()} holders, organic score ≥ ${CRYPTO_GATE.minOrganic} (invented) · stock, pre-IPO and commodity tokens belong to other departments · LSTs beyond the top ${CRYPTO_GATE.lstTop} dropped · shelves are Jupiter's own tags (Majors, Stables, Staked SOL, Meme, Solana DeFi, DePIN & infra, RWA & yield), CoinGecko categories name the rest · BTC and ETH settle through cbBTC and Portal WETH (rails.json aliases) · T-bills hand-curated · Pyth feed id on every row Hermes covers`;

// ── CURRENCIES (one row per currency; spot everywhere, rail where a Solana stable is on peg) ──
// The same shape as commodities: every currency Pyth publishes an FX feed
// for (plus ILS and AED, which Yahoo covers) is a row, priced at build from
// Yahoo spot (keyless) with the Pyth feed id stamped for the relay. The rail
// is the largest Jupiter-verified stablecoin for that currency that trades
// within 3% of spot and clears the cap floor; rows without one are shown
// railless, the way CME contracts are, and the site blocks them at the bench.
// A leg here is a currency you hold — EUR/USD is euros, not a pair; crosses
// (EUR/GBP, AUD/NZD, USDXY) are not rows.
const FX_GATE = { pegTolerance: 0.03, minMcapUsd: 1_000_000, _about: "peg tolerance computed against Yahoo spot; $1M cap floor for a rail invented 2026-09-25, not signed off — under it the stable is named on the row but the leg stays railless" };
const CUR: [string, string, string, string, RegExp][] = [
  ["EUR", "EURUSD=X", "EUR/USD", "Euro", /eur/i], ["JPY", "JPY=X", "USD/JPY", "Japanese yen", /jpy|yen/i], ["GBP", "GBPUSD=X", "GBP/USD", "British pound", /gbp|pound/i],
  ["CHF", "CHF=X", "USD/CHF", "Swiss franc", /chf|franc/i], ["AUD", "AUDUSD=X", "AUD/USD", "Australian dollar", /aud/i], ["NZD", "NZDUSD=X", "NZD/USD", "New Zealand dollar", /nzd/i],
  ["CAD", "CAD=X", "USD/CAD", "Canadian dollar", /cad/i], ["SGD", "SGD=X", "USD/SGD", "Singapore dollar", /sgd/i], ["CNY", "CNY=X", "USD/CNY", "Chinese yuan", /cny|cnh|yuan|rmb/i],
  ["CNH", "CNH=X", "USD/CNH", "Chinese yuan (offshore)", /cnh/i], ["HKD", "HKD=X", "USD/HKD", "Hong Kong dollar", /hkd/i], ["MXN", "MXN=X", "USD/MXN", "Mexican peso", /mxn|peso/i],
  ["KRW", "KRW=X", "USD/KRW", "South Korean won", /krw|won/i], ["TRY", "TRY=X", "USD/TRY", "Turkish lira", /try|lira/i], ["ILS", "ILS=X", "USD/ILS", "Israeli shekel", /ils|shekel/i],
  ["AED", "AED=X", "USD/AED", "UAE dirham", /aed|dirham/i], ["INR", "INR=X", "USD/INR", "Indian rupee", /inr|rupee/i], ["IDR", "IDR=X", "USD/IDR", "Indonesian rupiah", /idr|rupiah/i],
  ["BRL", "BRL=X", "USD/BRL", "Brazilian real", /brl|brz/i], ["ZAR", "ZAR=X", "USD/ZAR", "South African rand", /zar|rand/i], ["NOK", "NOK=X", "USD/NOK", "Norwegian krone", /nok/i],
  ["SEK", "SEK=X", "USD/SEK", "Swedish krona", /sek/i], ["DKK", "DKK=X", "USD/DKK", "Danish krone", /dkk/i], ["PLN", "PLN=X", "USD/PLN", "Polish zloty", /pln|zloty/i],
  ["CZK", "CZK=X", "USD/CZK", "Czech koruna", /czk|koruna/i], ["HUF", "HUF=X", "USD/HUF", "Hungarian forint", /huf|forint/i], ["RON", "RON=X", "USD/RON", "Romanian leu", /ron|leu/i],
  ["PHP", "PHP=X", "USD/PHP", "Philippine peso", /php/i], ["THB", "THB=X", "USD/THB", "Thai baht", /thb|baht/i], ["MYR", "MYR=X", "USD/MYR", "Malaysian ringgit", /myr|ringgit/i],
  ["TWD", "TWD=X", "USD/TWD", "Taiwan dollar", /twd/i], ["VND", "VND=X", "USD/VND", "Vietnamese dong", /vnd|dong/i],
];
const FX_NOT_STABLE = /meme|launchpad|stocks|xstocks|ondo|prestocks|yield|yb|lst|defi/;
async function yahooSpot(sym: string) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=2d`, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) return null; const m = (await r.json())?.chart?.result?.[0]?.meta; if (!m?.regularMarketPrice) return null;
    return { rate: m.regularMarketPrice as number, prev: (m.chartPreviousClose as number | undefined) ?? null };
  } catch { return null; }
}
async function buildCurrencies(_platforms: Record<string, any>, cgList: any[], old: Record<string, any>) {
  const verified = await jupVerified();
  const mintToCg: Record<string, any> = {};
  for (const c of cgList) { const m = c.platforms?.solana; if (m && !mintToCg[m]) mintToCg[m] = c; }
  const pyth = await pythFeeds("fx");
  const asOf = new Date().toISOString();
  const spots: Record<string, any> = {}; const rows: any[] = []; const funnel: Record<string, any> = {}; const railless: string[] = [];
  for (const [code, sym, pair, name, rx] of CUR) {
    const y = await yahooSpot(sym); if (!y) { console.warn("no spot", sym); continue; }
    const direct = pair.startsWith(code);
    const usdPer = direct ? y.rate : 1 / y.rate;
    const usdPerPrev = y.prev ? (direct ? y.prev : 1 / y.prev) : null;
    const feed = pyth[`FX.${pair}`] ?? null;
    spots[code] = { sym, pair, name, quote: y.rate, prevQuote: y.prev, usdPer, asOf, src: "Yahoo Finance", pyth: feed };
    const f = { onJupiter: 0, notStable: 0, offPeg: 0, underCap: 0, kept: 0 } as Record<string, number>;
    const cands: JupToken[] = [];
    let underFloor: JupToken | null = null;
    for (const tk of verified) {
      if (!rx.test(tk.symbol)) continue;
      f.onJupiter++;
      const tags = tk.tags ?? [];
      // VNX (VCHF, VGBP) and StraitsX carry neither the `stable` tag nor an open mint authority; the peg check below is the real test
      if (tags.some((x) => FX_NOT_STABLE.test(x))) { f.notStable++; continue; }
      const drift = (tk.usdPrice ?? 0) / usdPer - 1;
      if (Math.abs(drift) > FX_GATE.pegTolerance) { f.offPeg++; continue; }
      if (!((tk.mcap ?? 0) >= FX_GATE.minMcapUsd)) { f.underCap++; if (!underFloor || (tk.mcap ?? 0) > (underFloor.mcap ?? 0)) underFloor = tk; continue; }
      cands.push(tk);
    }
    cands.sort((a, b) => (b.mcap ?? 0) - (a.mcap ?? 0));
    const best = cands[0] ?? null; if (best) f.kept = 1;
    const cgc = best ? mintToCg[best.id] : null;
    const twins = cands.slice(1).map((c) => c.symbol);
    const row: any = {
      t: code, n: name, cls: "currencies", sub: code, status: "mintable",
      pair, spotSym: sym, spot: usdPer, spotQuote: y.rate, spotPrev: y.prev, pyth: feed,
      venue: best ? `FX stable · ${best.symbol} · ${fmtCap(best.mcap ?? 0)} cap · Solana` : `spot only · ${underFloor ? `${underFloor.symbol} is on peg at $${((underFloor.mcap ?? 0) / 1e6).toFixed(1)}M, under the $${FX_GATE.minMcapUsd / 1e6}M floor` : "no Solana stablecoin on peg yet"}`,
      chain: best ? "Solana" : null, addr: best?.id ?? null, addrUrl: best ? SOLSCAN + best.id : undefined, addrSrc: best ? "jupiter verified list" : undefined,
      chains: best ? Object.keys(cgc?.platforms || { solana: 1 }).filter((k) => (cgc?.platforms || { solana: 1 })[k]).slice(0, 12) : [],
      program: best ? (best.tokenProgram === TOKEN_2022 ? "Token-2022" : "Token") : undefined,
      stable: best ? { t: best.symbol, n: best.name, mint: best.id, mcap: Math.round(best.mcap ?? 0), liq: Math.round(best.liquidity ?? 0), holders: best.holderCount ?? null } : null,
      stableUnderFloor: !best && underFloor ? { t: underFloor.symbol, mint: underFloor.id, mcap: Math.round(underFloor.mcap ?? 0) } : undefined,
      cg: cgc?.id, cgUrl: cgc ? `https://www.coingecko.com/en/coins/${cgc.id}` : undefined,
      price: best?.usdPrice ?? usdPer, chg: best ? best.stats24h?.priceChange ?? null : usdPerPrev ? +(100 * (usdPer / usdPerPrev - 1)).toFixed(3) : null,
      pegDrift: best ? (best.usdPrice ?? 0) / usdPer - 1 : null, mcap: best ? Math.round(best.mcap ?? 0) : null, twins: twins.length ? twins : undefined,
      jup: best ? jupRow(best) : undefined, src: best ? "jupiter tokens v2 verified list + Yahoo spot" : "Yahoo spot (Pyth feed id attached)", gates: FX_GATE,
    };
    const o = old[cgc?.id ?? ""] ?? old["t:" + code]; if (o) for (const k of CARRY) if (o[k] !== undefined) row[k] = o[k];
    rows.push(row); funnel[code] = f; if (!best) railless.push(code);
  }
  console.log("fx spots", Object.fromEntries(Object.entries(spots).map(([k, v]: [string, any]) => [k, v.quote])));
  console.log("fx rails", rows.filter((r) => r.stable).map((r) => `${r.t}:${r.stable.t}`).join(" "), "· railless", railless.join(" "));
  return { assets: rows, meta: { built: asOf, gates: FX_GATE, spots, funnel, missing: {}, railless, order: CUR.map((c) => c[0]), src: "Yahoo spot at build (Pyth FX feed ids stamped for the relay); rail = largest Jupiter-verified stablecoin on peg over the floor" } };
}
const FX_SOURCE = `one row per currency (${CUR.length}: every Pyth FX feed against the dollar, plus ILS and AED) · spot from Yahoo Finance at build, Pyth Hermes feed id on the row · rail = largest Jupiter-verified stablecoin for the currency within ${Math.round(FX_GATE.pegTolerance * 100)}% of spot and over $${FX_GATE.minMcapUsd / 1e6}M cap (invented), twins listed · rows with no rail stay on the shelf railless like CME contracts · crosses are not rows`;

// ── ASSEMBLE ────────────────────────────────────────────────────────────
// Full build: bun build-registry.ts
// Splice one or more departments into the existing registry.json (no refetch
// of the rest): bun build-registry.ts --only crypto,currencies
// (--predictions-only is the nightly's alias for --only predictions.)
const onlyIdx = process.argv.indexOf("--only");
const ONLY: string[] | null = onlyIdx >= 0 ? (process.argv[onlyIdx + 1] || "").split(",").filter(Boolean) : process.argv.includes("--predictions-only") ? ["predictions"] : null;
const want = (cls: string) => !ONLY || ONLY.includes(cls);
const prior: any = (await Bun.file(OUT_DIR + "registry.json").exists()) ? JSON.parse(await Bun.file(OUT_DIR + "registry.json").text()) : null;
if (ONLY && !prior) throw new Error("--only needs an existing registry.json to splice into");
const old: Record<string, any> = {};
for (const a of prior?.assets ?? []) if (a.cls === "crypto" || a.cls === "currencies") { if (a.cg) old[a.cg] = a; old["t:" + a.t] ??= a; }

const needCg = want("stocks") || want("crypto") || want("commodities") || want("currencies");
const cgList: any[] = needCg ? await fetchJSON("https://api.coingecko.com/api/v3/coins/list?include_platform=true") : [];
const platforms: Record<string, any> = Object.fromEntries(cgList.map((c: any) => [c.id, c.platforms || {}]));

const [stocks, preds, crypto, commodities, currencies] = await Promise.all([
  want("stocks") ? buildStocks() : null,
  want("predictions") ? buildPredictions() : null,
  want("crypto") ? buildCrypto(platforms, cgList, old) : null,
  want("commodities") ? buildCommodities(platforms) : null,
  want("currencies") ? buildCurrencies(platforms, cgList, old) : null,
]);

const registry: any = prior && ONLY ? prior : { meta: { chain: "Solana", sources: {}, counts: {} }, assets: [] };
const built: Record<string, any[] | null> = { stocks, predictions: preds?.assets ?? null, crypto: crypto?.assets ?? null, commodities, currencies: currencies?.assets ?? null };
const keep = registry.assets.filter((a: any) => !built[a.cls]);
registry.assets = [...keep, ...(stocks ?? []), ...(commodities ?? []), ...(preds?.assets ?? []), ...(crypto?.assets ?? []), ...(currencies?.assets ?? [])];
if (!ONLY) registry.assets = [...(stocks ?? []), ...(commodities ?? []), ...(preds?.assets ?? []), ...(crypto?.assets ?? []), ...(currencies?.assets ?? [])];
registry.meta.built = new Date().toISOString();
registry.meta.chain = "Solana";
if (preds) { registry.meta.gates = GATES; registry.meta.funnel = preds.funnel; registry.meta.sources.predictions = PRED_SOURCE; if (registry.meta.rails?.counts) registry.meta.rails.counts.predictions = { tokenizable: preds.assets.length }; }
if (stocks) { registry.meta.sources.stocks = "CoinGecko coins list (platforms.solana) — Backed xStocks + Ondo Global Markets (issuer facet); sectors from S&P 500 GICS dataset; on-chain marks, pooled liquidity and underlying reference price from Jupiter Price API v3"; registry.meta.issuers = Object.fromEntries([...new Set(stocks.map((s: any) => s.issuer))].map((i) => [i, stocks.filter((s: any) => s.issuer === i).length])); }
if (commodities) registry.meta.sources.commodities = "hand-curated CME/ICE/NYMEX/CBOT/COMEX contracts (no rail); tokenized gold XAUT0 live from CoinGecko, native Solana mint";
if (crypto) { registry.meta.sources.crypto = CRYPTO_SOURCE; registry.meta.crypto = crypto.meta; registry.meta.cryptoTrending = { asOf: crypto.meta.built, ids: crypto.trending, src: "Jupiter tokens v2 top organic score, 24h (rows in the library only)" }; }
if (currencies) { registry.meta.sources.currencies = FX_SOURCE; registry.meta.fx = currencies.meta; }
registry.meta.counts = { total: registry.assets.length };
for (const cls of ["stocks", "commodities", "predictions", "crypto", "currencies"]) registry.meta.counts[cls] = registry.assets.filter((a: any) => a.cls === cls).length;
registry.meta.withMint = registry.assets.filter((a: any) => a.addr).length;

await Bun.write(OUT_DIR + "registry.json", JSON.stringify(registry, null, 1));
await Bun.write(OUT_DIR + "registry.js", "// generated by build-registry.ts — do not edit\nwindow.REGISTRY = " + JSON.stringify(registry) + ";\n");
console.log(ONLY ? `spliced ${ONLY.join(", ")} ·` : "full build ·", "counts:", registry.meta.counts, "· rows with a Solana mint:", registry.meta.withMint);
if (preds) console.log("kalshi funnel:", preds.funnel);
if (stocks) console.log("stock subs:", [...new Set(stocks.map((s: any) => s.sub))].join(", "));
console.log("wrote", OUT_DIR + "registry.json and registry.js");

await Bun.$`bun ${OUT_DIR}inline.ts`;
