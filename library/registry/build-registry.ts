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
//   crypto      CoinGecko markets, market cap > $1B, wrapped/staked/bridged
//               excluded; Solana mint attached where CoinGecko lists one.
//               BTC and ETH settle through aliases in rails.json (cbBTC, WETH).
//   yield       tokenized T-bills with a Solana mint (USDY, OUSG, BUIDL, USTB,
//               TBILL, USYC) + stables
//   currencies  FX stables with a Solana mint (EURC)

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

// ── CRYPTO + YIELD ──────────────────────────────────────────────────────
const EXCLUDE_CRYPTO = /wrapped|staked|bridged|restaked|weeth|wsteth|steth|cbbtc|wbtc|binance-peg|figure-heloc|figr/i;
const STABLE_IDS = new Set(["tether","usd-coin","dai","usds","ethena-usde","first-digital-usd","paypal-usd","usd1-wlfi","usdt0","falcon-finance","binance-bridged-usdt-bnb-smart-chain","usdtb","world-liberty-financial-usd","ripple-usd","global-dollar"]);
const TBILLS: [string, string, string, string][] = [
  ["USDY","Ondo US Dollar Yield","0–3mo","ondo-us-dollar-yield"],["OUSG","Ondo Short-Term US Gov","0–1yr","ousg"],
  ["BUIDL","BlackRock USD Institutional","0–3mo","blackrock-usd-institutional-digital-liquidity-fund"],["USTB","Superstate Short Duration","0–1yr","superstate-short-duration-us-government-securities-fund-ustb"],
  ["TBILL","OpenEden T-Bill Vault","0–3mo","openeden-tbill"],["USYC","Hashnote US Yield Coin","0–3mo","hashnote-usyc"],
];
function attachMint(row: any, plat: any) {
  const mint = plat?.solana; if (!mint) return row;
  row.chain = "Solana"; row.addr = mint; row.addrUrl = SOLSCAN + mint; row.chains = Object.values(plat).filter(Boolean).length;
  return row;
}
async function buildCrypto(platforms: Record<string, any>) {
  const mkts = await fetchJSON("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1");
  const out: any[] = [];
  const px = (c: any) => ({ cg: c.id, price: c.current_price, chg: c.price_change_percentage_24h ?? null });
  for (const c of mkts) {
    if (!((c.market_cap ?? 0) > 1e9)) continue;
    if (EXCLUDE_CRYPTO.test(c.id) || EXCLUDE_CRYPTO.test(c.name)) continue;
    const plat = c.id === "solana" ? { solana: "So11111111111111111111111111111111111111112" } : platforms[c.id];
    if (STABLE_IDS.has(c.id)) {
      out.push(attachMint({ t: c.symbol.toUpperCase(), n: c.name, cls: "crypto", sub: "Stables", venue: "stablecoin", status: "mintable", mcap: c.market_cap, src: "coingecko", ...px(c) }, plat));
    } else {
      out.push(attachMint({ t: c.symbol.toUpperCase(), n: c.name, cls: "crypto", sub: "Majors", venue: `spot · $${(c.market_cap / 1e9).toFixed(0)}B cap`, status: "mintable", mcap: c.market_cap, src: "coingecko", ...px(c) }, plat));
    }
  }
  const tbillIds = TBILLS.map(([,,,id]) => id).join(",");
  const tbillMkts = await fetchJSON(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${tbillIds}`);
  const tbillById: Record<string, any> = Object.fromEntries(tbillMkts.map((c: any) => [c.id, c]));
  for (const [t, n, dur, id] of TBILLS) {
    const c = tbillById[id];
    out.push(attachMint({ t, n, cls: "crypto", sub: "Tokenized T-bills", venue: `${dur} · yield`, status: "mintable", src: c ? "coingecko" : "hand-curated", ...(c ? px(c) : { cg: id }) }, platforms[id]));
  }
  // Jupiter marks for everything with a Solana mint (on-chain price + pooled liquidity)
  const jup = await jupPrices(out.map((a) => a.addr).filter(Boolean));
  for (const a of out) { const j = a.addr && jup[a.addr]; if (j) a.jup = { px: j.usdPrice ?? null, liq: j.liquidity != null ? Math.round(j.liquidity) : null, chg: j.priceChange24h ?? null, dec: j.decimals ?? null }; }
  return out;
}

// ── CURRENCIES (FX legs) ────────────────────────────────────────────────
const FX_IDS: Record<string, string> = { "euro-coin": "EUR", "stasis-eurs": "EUR", "gyen": "JPY", "jpy-coin": "JPY", "xsgd": "SGD" };
async function buildCurrencies(platforms: Record<string, any>) {
  const mkts = await fetchJSON(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${Object.keys(FX_IDS).join(",")}`);
  const out: any[] = mkts.map((c: any) => attachMint({
    t: c.symbol.toUpperCase(), n: c.name, cls: "currencies", sub: FX_IDS[c.id],
    venue: `FX stable · $${(c.market_cap / 1e6).toFixed(0)}M cap`, status: "mintable", src: "coingecko",
    cg: c.id, price: c.current_price, chg: c.price_change_percentage_24h ?? null,
  }, platforms[c.id]));
  out.sort((a, b) => a.sub.localeCompare(b.sub) || a.t.localeCompare(b.t));
  return out;
}

// ── ASSEMBLE ────────────────────────────────────────────────────────────
if (process.argv.includes("--predictions-only")) {
  const preds = await buildPredictions();
  const registry = JSON.parse(await Bun.file(OUT_DIR + "registry.json").text());
  registry.assets = [...registry.assets.filter((a: any) => a.cls !== "predictions"), ...preds.assets];
  registry.meta.built = new Date().toISOString();
  registry.meta.gates = GATES;
  registry.meta.funnel = preds.funnel;
  registry.meta.counts.predictions = preds.assets.length;
  registry.meta.counts.total = registry.assets.length;
  registry.meta.sources.predictions = PRED_SOURCE;
  if (registry.meta.rails) registry.meta.rails.counts.predictions = { tokenizable: preds.assets.length };
  await Bun.write(OUT_DIR + "registry.json", JSON.stringify(registry, null, 1));
  await Bun.write(OUT_DIR + "registry.js", "// generated by build-registry.ts — do not edit\nwindow.REGISTRY = " + JSON.stringify(registry) + ";\n");
  console.log("predictions spliced:", registry.meta.counts.predictions, "· total:", registry.meta.counts.total);
  console.log("kalshi funnel:", preds.funnel);
  await Bun.$`bun ${OUT_DIR}inline.ts`;
  process.exit(0);
}

// one platform map for every builder (id → { solana: mint, … })
const cgList: any[] = await fetchJSON("https://api.coingecko.com/api/v3/coins/list?include_platform=true");
const platforms: Record<string, any> = Object.fromEntries(cgList.map((c: any) => [c.id, c.platforms || {}]));

const [stocks, preds, crypto, commodities, currencies] = await Promise.all([
  buildStocks(), buildPredictions(), buildCrypto(platforms), buildCommodities(platforms), buildCurrencies(platforms),
]);
const predAssets = preds.assets;
const assets = [...stocks, ...commodities, ...predAssets, ...crypto, ...currencies];

const registry = {
  meta: {
    built: new Date().toISOString(),
    chain: "Solana",
    gates: GATES,
    funnel: preds.funnel,
    sources: {
      stocks: "CoinGecko coins list (platforms.solana) — Backed xStocks + Ondo Global Markets (issuer facet); sectors from S&P 500 GICS dataset; on-chain marks, pooled liquidity and underlying reference price from Jupiter Price API v3",
      commodities: "hand-curated CME/ICE/NYMEX/CBOT/COMEX contracts (no rail); tokenized gold XAUT0 live from CoinGecko, native Solana mint",
      predictions: PRED_SOURCE,
      crypto: "CoinGecko markets, cap > $1B, wrapped/staked excluded, Solana mint from the platform map; T-bills with a Solana mint",
      currencies: "CoinGecko FX stables with a Solana mint (EURC)",
    },
    counts: { total: assets.length, stocks: stocks.length, commodities: commodities.length, predictions: predAssets.length, crypto: crypto.length, currencies: currencies.length },
    issuers: Object.fromEntries([...new Set(stocks.map((s: any) => s.issuer))].map((i) => [i, stocks.filter((s: any) => s.issuer === i).length])),
    withMint: assets.filter((a: any) => a.addr).length,
  },
  assets,
};

await Bun.write(OUT_DIR + "registry.json", JSON.stringify(registry, null, 1));
await Bun.write(OUT_DIR + "registry.js", "// generated by build-registry.ts — do not edit\nwindow.REGISTRY = " + JSON.stringify(registry) + ";\n");
console.log("counts:", registry.meta.counts);
console.log("issuers:", registry.meta.issuers, "· rows with a Solana mint:", registry.meta.withMint);
console.log("kalshi funnel:", registry.meta.funnel);
console.log("stock subs:", [...new Set(stocks.map((s: any) => s.sub))].join(", "));
console.log("wrote", OUT_DIR + "registry.json and registry.js");

await Bun.$`bun ${OUT_DIR}inline.ts`;
