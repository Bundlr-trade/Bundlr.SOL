/* settleable.ts — the settleability layer, Solana edition.
   For every registry row, answer: can a bundle hold it on Solana, at which
   mint, bought where, and how deep is that venue. Writes a `rail` field per
   row into registry.json and a rails-report.md, then syncs the mock.

   A rail comes from rails.json (hand-verified, sourced) or from the row's own
   Solana mint (CoinGecko platform map). Nothing here is trusted as typed:
   every mint is re-read on-chain (getMultipleAccounts → owner program,
   decimals, freeze authority) and depth is quoted live from Jupiter's swap
   quote at $1K / $10K / $50K / $250K of USDC, using Jupiter's own
   priceImpactPct for the route.

   rail.status:
     live        — mint verified, quoted, price impact at $50K within threshold
     thin        — verified, but impact over threshold, no route, or pooled
                   liquidity under the quote floor
     gated       — a token exists on Solana but a legal/transfer gate applies
                   (Ondo GM: primary mint/redeem at NAV, whitelisted)
     tokenizable — predictions: Kalshi YES/NO pair minted by DFlow on first order
     none        — no Solana mint (futures, most FX stables)

   Run: bun library/registry/settleable.ts [--no-sync] [--only TSLA,NVDA] [--max-quotes N]   (needs network)
*/
const dir = new URL(".", import.meta.url).pathname;
const args = process.argv.slice(2);
const NO_SYNC = args.includes("--no-sync");
const ONLY = args.includes("--only") ? (args[args.indexOf("--only") + 1] || "").split(",").filter(Boolean) : [];
const MAX_QUOTES = args.includes("--max-quotes") ? +(args[args.indexOf("--max-quotes") + 1] || 0) : Infinity;

type Rail = { t: string; chain: string; addr: string; decimals: number; issuer?: string; restrictions?: string; gate?: string | null; verified?: string; source?: string; isQuote?: boolean; skipQuote?: boolean; fromRegistry?: boolean };
const RAILS = JSON.parse(await Bun.file(dir + "rails.json").text());
const REG = JSON.parse(await Bun.file(dir + "registry.json").text());
const CHAIN = RAILS.chains["Solana"];
const QUOTE = RAILS.quoteTokens["Solana"][CHAIN.quote];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/* ── Solana JSON-RPC, zero deps: read the Mint account layout ──
   SPL Mint (82 bytes): mintAuthorityOption u32 · mintAuthority 32 · supply u64 ·
   decimals u8 @44 · isInitialized u8 @45 · freezeAuthorityOption u32 @46 · freezeAuthority 32 @50.
   Token-2022 mints share the first 82 bytes and append TLV extensions. */
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
type MintInfo = { program: string; decimals: number; freeze: boolean; supply: bigint; space: number } | null;
async function rpc(method: string, params: unknown[]) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(CHAIN.rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (r.status === 429) { await sleep(3000 * (attempt + 1)); continue; }
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    return j.result;
  }
  throw new Error("rpc rate-limited");
}
async function readMints(mints: string[]): Promise<Record<string, MintInfo>> {
  const out: Record<string, MintInfo> = {};
  for (let i = 0; i < mints.length; i += 100) {
    const chunk = mints.slice(i, i + 100);
    const res = await rpc("getMultipleAccounts", [chunk, { encoding: "base64", dataSlice: { offset: 0, length: 82 } }]);
    chunk.forEach((m, k) => {
      const v = res?.value?.[k];
      if (!v || !v.data?.[0]) { out[m] = null; return; }
      const b = Buffer.from(v.data[0], "base64");
      if (b.length < 82) { out[m] = null; return; }
      out[m] = { program: v.owner, decimals: b[44], freeze: b.readUInt32LE(46) === 1, supply: b.readBigUInt64LE(36), space: v.space ?? 0 };
    });
    process.stderr.write(`mints read ${Math.min(i + 100, mints.length)}/${mints.length}\n`);
    await sleep(600);
  }
  return out;
}

/* ── depth: Jupiter swap quote, USDC → mint, at each size ── */
type Depth = { venue: string; route: string[]; impact: Record<string, number | null>; unitPrice: number | null; err?: string };
let quotesUsed = 0;
async function jupQuote(mint: string, usd: number): Promise<{ out: bigint; impact: number; labels: string[] } | { err: string }> {
  const amount = BigInt(usd) * 10n ** BigInt(QUOTE.decimals);
  const u = `${CHAIN.quoteUrl}?inputMint=${QUOTE.addr}&outputMint=${mint}&amount=${amount}&slippageBps=50`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(u);
    quotesUsed++;
    if (r.status === 429) { await sleep(4000 * (attempt + 1)); continue; }
    const j: any = await r.json().catch(() => ({}));
    if (j.error || j.errorCode) return { err: j.errorCode || j.error };
    if (!j.outAmount) return { err: "no quote" };
    return { out: BigInt(j.outAmount), impact: parseFloat(j.priceImpactPct ?? "0"), labels: [...new Set((j.routePlan ?? []).map((p: any) => p.swapInfo?.label).filter(Boolean))] as string[] };
  }
  return { err: "rate-limited" };
}
async function depth(mint: string, decimals: number): Promise<Depth | null> {
  if (mint === QUOTE.addr) return { venue: `${CHAIN.quote} itself`, route: [], impact: Object.fromEntries(RAILS.thresholds.sizesUsd.map((s: number) => [String(s), 0])), unitPrice: 1 };
  const sizes: number[] = RAILS.thresholds.sizesUsd;
  const impact: Record<string, number | null> = {}; let labels: string[] = []; let unit: number | null = null; let firstErr: string | undefined;
  for (const s of sizes) {
    if (quotesUsed >= MAX_QUOTES) { impact[String(s)] = null; continue; }
    const q = await jupQuote(mint, s);
    await sleep(1100);
    if ("err" in q) { impact[String(s)] = null; firstErr ??= q.err; if (s === sizes[0]) break; continue; }
    impact[String(s)] = q.impact;
    if (!labels.length) labels = q.labels;
    if (s === sizes[0]) unit = s / (Number(q.out) / 10 ** decimals);
  }
  if (unit == null && !labels.length) return firstErr ? { venue: "", route: [], impact, unitPrice: null, err: firstErr } : null;
  return { venue: labels.length ? `Jupiter · ${labels.join(" + ")}` : "Jupiter", route: labels, impact, unitPrice: unit };
}

/* ── which rail applies to a row ── */
const aliasOf = (a: any) => RAILS.aliases[a.t] || null;
function classRule(a: any) {
  if (a.cls === "stocks") return RAILS.classRules[`stocks:${a.issuer}`] || null;
  return RAILS.classRules[a.cls] || null;
}
function railsFor(a: any): Rail[] {
  const out: Rail[] = [];
  const alias = aliasOf(a);
  const want = alias || a.t;
  for (const r of RAILS.rails) { if (r.t === want) out.push({ ...r }); }
  if (!out.length && a.chain === "Solana" && a.addr) {
    const cr = classRule(a);
    out.push({ t: a.t, chain: "Solana", addr: a.addr, decimals: a.jup?.dec ?? 0, issuer: cr?.note ?? a.issuer ?? null, restrictions: cr?.gate ?? null, gate: cr?.gate ?? null, verified: "registry (CoinGecko platform map)", source: "mint re-read on-chain by settleable.ts", fromRegistry: true });
  }
  return out;
}

/* ── main ── */
const rows = REG.assets.filter((a: any) => !ONLY.length || ONLY.includes(a.t));
const allMints = [...new Set(rows.flatMap((a: any) => railsFor(a).map(r => r.addr)))] as string[];
process.stderr.write(`${rows.length} rows · ${allMints.length} distinct mints to read\n`);
const MINTS = await readMints(allMints);

const cache = new Map<string, Depth | null>();
const counts: Record<string, Record<string, number>> = {};
const bump = (cls: string, st: string) => { counts[cls] ??= {}; counts[cls][st] = (counts[cls][st] || 0) + 1; };
const built = new Date().toISOString();
const minLiq: number = RAILS.thresholds.minLiqToQuote;

// quote the deepest first so a --max-quotes cap spends its budget where it matters
rows.sort((x: any, y: any) => (y.jup?.liq ?? 0) - (x.jup?.liq ?? 0));

for (const a of rows) {
  if (a.cls === "predictions") { a.rail = { ...(a.rail || RAILS.classRules.predictions), chain: "Solana", status: "tokenizable", launch: true, checked: built }; bump(a.cls, "tokenizable"); continue; }
  const rails = railsFor(a);
  const options: any[] = [];
  for (const r of rails) {
    const m = MINTS[r.addr];
    let status: string, note: string | null = null, d: Depth | null = null;
    if (!m) { status = "none"; note = "mint account not found on Solana mainnet"; }
    else if (m.program !== TOKEN && m.program !== TOKEN_2022) { status = "none"; note = `account owner is not a token program (${m.program})`; }
    else {
      if (r.decimals && r.decimals !== m.decimals && !r.fromRegistry) note = `decimals mismatch: chain says ${m.decimals}, rails.json says ${r.decimals}`;
      r.decimals = m.decimals;
      const cr = classRule(a);
      if (r.gate) status = "gated";
      else {
        const liq = a.jup?.liq ?? null;
        if (liq != null && liq < minLiq) { status = "thin"; note = `pooled liquidity $${liq.toLocaleString()} (Jupiter), under the $${minLiq.toLocaleString()} quote floor`; }
        else {
          if (!cache.has(r.addr)) cache.set(r.addr, await depth(r.addr, m.decimals));
          d = cache.get(r.addr)!;
          if (!d || d.err) { status = "thin"; note = d?.err === "TOKEN_NOT_TRADABLE" ? "Jupiter: token not tradable (no pool)" : d?.err === "NO_ROUTES_FOUND" ? "Jupiter: no route from USDC" : d?.err ?? "no quote"; }
          else { const i50 = d.impact["50000"]; status = i50 != null && i50 <= RAILS.thresholds.liveMaxImpactAt50k ? "live" : "thin"; }
        }
      }
      process.stderr.write(`${a.t.padEnd(7)} ${status.padEnd(6)} ${m.program === TOKEN_2022 ? "t22" : "spl"}/${m.decimals}${m.freeze ? " freeze" : ""} ${d && !d.err ? Object.entries(d.impact).map(([s, i]) => `$${Number(s) / 1000}K:${i == null ? "—" : (i * 100).toFixed(2) + "%"}`).join(" ") + ` (${d.venue})` : note ?? ""}\n`);
    }
    options.push({ status, chain: "Solana", launch: true, addr: r.addr, decimals: m?.decimals ?? r.decimals ?? null, program: m ? (m.program === TOKEN_2022 ? "Token-2022" : "Token") : null, freeze: m?.freeze ?? null,
      issuer: r.issuer ?? null, restrictions: r.restrictions ?? null, gate: r.gate ?? null, venue: d && !d.err ? d.venue : null, route: d && !d.err ? d.route : null, impact: d && !d.err ? d.impact : null, unitPrice: d?.unitPrice ?? null,
      liq: a.jup?.liq ?? null, note: note ?? r.issuer ?? null, verified: r.verified ?? null, source: r.source ?? null, explorer: CHAIN.explorer + r.addr });
  }
  const rank = (o: any) => ({ live: 0, thin: 1, gated: 2, none: 3 }[o.status as string] ?? 9);
  options.sort((x, y) => rank(x) - rank(y));
  let rail: any;
  if (options.length) rail = { ...options[0], options: options.length > 1 ? options.slice(1) : undefined, as: aliasOf(a) || undefined, checked: built };
  else { const cr = classRule(a) || { chain: null, status: "none", note: "no rule" }; rail = { status: "none", chain: null, launch: false, addr: null, note: cr.note, checked: built }; }
  a.rail = rail;
  bump(a.cls, rail.status);
}

REG.meta.rails = { built, chain: "Solana", thresholds: RAILS.thresholds, counts, quotesUsed, chains: { Solana: { launch: true, quote: CHAIN.quote, quoted: true, quoter: CHAIN.quoter } } };
await Bun.write(dir + "registry.json", JSON.stringify(REG));

/* ── report ── */
const report: string[] = [];
report.push(`# Rails report — Solana — ${built.slice(0, 10)}`, "", "Generated by `settleable.ts`. Status per row: live (mint verified on-chain + Jupiter quote ≤" + (RAILS.thresholds.liveMaxImpactAt50k * 100) + "% impact at $50K) · thin (verified, but over threshold, no route, or under the $" + minLiq.toLocaleString() + " pooled-liquidity floor) · gated (token on Solana, legal/transfer gate) · tokenizable (Kalshi YES/NO pair minted by DFlow on first order) · none (no Solana mint).", "", `Jupiter quotes spent this run: ${quotesUsed}.`, "");
report.push("## Counts by department", "", "| Department | live | thin | gated | tokenizable | none |", "|---|---|---|---|---|---|");
for (const [cls, c] of Object.entries(counts)) report.push(`| ${cls} | ${c.live || 0} | ${c.thin || 0} | ${c.gated || 0} | ${c.tokenizable || 0} | ${c.none || 0} |`);
report.push("", "## Quoted rails", "", "| Ticker | as | Status | Program | Venue | $1K | $10K | $50K | $250K | Unit price | Pooled liq | Mint |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const a of REG.assets) {
  const r = a.rail; if (!r || !r.addr || !r.venue) continue;
  const pct = (s: string) => r.impact?.[s] == null ? "—" : (r.impact[s] * 100).toFixed(2) + "%";
  report.push(`| ${a.t} | ${r.as || ""} | ${r.status} | ${r.program || ""} | ${r.venue} | ${pct("1000")} | ${pct("10000")} | ${pct("50000")} | ${pct("250000")} | ${r.unitPrice ? "$" + r.unitPrice.toLocaleString("en-US", { maximumFractionDigits: 2 }) : ""} | ${r.liq != null ? "$" + r.liq.toLocaleString() : ""} | \`${r.addr}\` |`);
}
report.push("", "## Gated rails (token exists, gate open)", "");
const gatedNotes = new Map<string, number>();
for (const a of REG.assets) if (a.rail?.status === "gated") { const k = `${a.cls} · ${a.rail.gate || a.rail.note}`; gatedNotes.set(k, (gatedNotes.get(k) || 0) + 1); }
for (const [k, n] of gatedNotes) report.push(`- ${n} rows: ${k}`);
report.push("", "## Thin rails (verified mint, not deep enough yet)", "");
const thinNotes = new Map<string, number>();
for (const a of REG.assets) if (a.rail?.status === "thin") { const k = `${a.cls} · ${String(a.rail.note || "over the impact threshold").replace(/\$[\d,]+ \(Jupiter\)/, "$N (Jupiter)")}`; thinNotes.set(k, (thinNotes.get(k) || 0) + 1); }
for (const [k, n] of [...thinNotes].sort((x, y) => y[1] - x[1])) report.push(`- ${n} rows: ${k}`);
report.push("", "## Why the rest has no rail", "");
const noneNotes = new Map<string, number>();
for (const a of REG.assets) if (a.rail?.status === "none") { const k = `${a.cls} · ${a.rail.note}`; noneNotes.set(k, (noneNotes.get(k) || 0) + 1); }
for (const [k, n] of [...noneNotes].sort((x, y) => y[1] - x[1])) report.push(`- ${n} rows: ${k}`);
await Bun.write(dir + "rails-report.md", report.join("\n") + "\n");
console.log(JSON.stringify(counts, null, 1));
console.log(`wrote registry.json (+rail) and rails-report.md · ${quotesUsed} Jupiter quotes`);
if (!NO_SYNC) await Bun.$`bun ${dir}sync-js.ts`;
