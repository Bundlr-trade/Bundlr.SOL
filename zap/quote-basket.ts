#!/usr/bin/env bun
/* quote-basket.ts — the Zap's read side, on Solana, with no wallet.

   A bundle is "cash in, bundle out": the buyer pays USDC, the protocol sources
   every leg and mints the bundle token in one transaction. Before that
   transaction exists, this is the exact sourcing receipt it would print:
   for each leg, the Jupiter route from USDC to the leg's mint at its share of
   the cash, the quantity that lands in the vault, Jupiter's price impact, and
   the 10 bps house fee. Everything here is a live quote; nothing is signed.

   Usage
     bun zap/quote-basket.ts --cash 1000 TSLA:2 NVDA:1 XAUT0:1 SOL:1
     bun zap/quote-basket.ts --cash 250 --json TSLA NVDA
     bun zap/quote-basket.ts --cash 500 --user <pubkey> TSLA NVDA   # also builds unsigned swap instructions

   Legs are registry tickers (library/registry/registry.json) with an optional
   stack count (TSLA:2 = weight 2 ÷ total). Weights are stacks, like the bench.
   --user adds Jupiter's swap-instructions for each leg so a wallet can sign —
   that is the half of the Zap that already exists off-chain; the Bundle
   program's deposit + mint instruction is specified in docs/bundle-program.md. */

const REG_PATH = new URL("../library/registry/registry.json", import.meta.url).pathname;
const RAILS_PATH = new URL("../library/registry/rails.json", import.meta.url).pathname;
const QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote";
const SWAP_IX_URL = "https://lite-api.jup.ag/swap/v1/swap-instructions";
const FEE_WAY = 0.001;

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const cash = +(flag("--cash") ?? 1000);
const user = flag("--user");
const asJson = args.includes("--json");
const legArgs = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && ["--cash", "--user"].includes(args[i - 1])));
if (!legArgs.length) { console.error("give at least two legs, e.g. TSLA:2 NVDA:1"); process.exit(1); }

const REG = JSON.parse(await Bun.file(REG_PATH).text());
const RAILS = JSON.parse(await Bun.file(RAILS_PATH).text());
const USDC = RAILS.quoteTokens.Solana.USDC;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/* pick the registry row a bundle would hold: best rail first, then Jupiter liquidity */
const rk = (a: any) => ({ live: 0, thin: 1, gated: 2, tokenizable: 3, none: 4 }[a.rail?.status as string] ?? 5);
function rowFor(ticker: string) {
  const t = ticker.toUpperCase();
  const rows = REG.assets.filter((a: any) => a.t === t && a.cls !== "predictions");
  if (!rows.length) return null;
  rows.sort((x: any, y: any) => rk(x) - rk(y) || (y.jup?.liq ?? 0) - (x.jup?.liq ?? 0));
  return rows[0];
}
type Leg = { t: string; w: number; row: any; mint: string | null; decimals: number | null; alias?: string };
const legs: Leg[] = legArgs.map(s => {
  const [t, w] = s.split(":"); const row = rowFor(t);
  const alias = RAILS.aliases[t.toUpperCase()];
  const railRow = RAILS.rails.find((r: any) => r.t === (alias || t.toUpperCase())) ?? null;
  const mint = row?.rail?.addr ?? railRow?.addr ?? row?.addr ?? null;
  return { t: t.toUpperCase(), w: Math.max(1, +(w ?? 1) || 1), row, mint, decimals: row?.rail?.decimals ?? railRow?.decimals ?? row?.jup?.dec ?? null, alias: alias || undefined };
});
const totalW = legs.reduce((s, l) => s + l.w, 0);

async function quote(mint: string, usd: number) {
  const amount = BigInt(Math.round(usd * 10 ** USDC.decimals));
  const r = await fetch(`${QUOTE_URL}?inputMint=${USDC.addr}&outputMint=${mint}&amount=${amount}&slippageBps=50`);
  const j: any = await r.json().catch(() => ({}));
  if (j.error || j.errorCode) return { err: j.errorCode || j.error };
  return { q: j, out: BigInt(j.outAmount), impact: parseFloat(j.priceImpactPct ?? "0"), labels: [...new Set((j.routePlan ?? []).map((p: any) => p.swapInfo?.label).filter(Boolean))] as string[] };
}
async function swapInstructions(quoteResponse: any) {
  const r = await fetch(SWAP_IX_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ quoteResponse, userPublicKey: user, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }) });
  return r.json().catch(() => null);
}

const fee = cash * FEE_WAY, spend = cash - fee;
const receipt: any[] = [];
for (const l of legs) {
  const share = spend * l.w / totalW;
  const line: any = { leg: l.t, as: l.alias ?? null, weight: +(100 * l.w / totalW).toFixed(2), usd: +share.toFixed(2), mint: l.mint, rail: l.row?.rail?.status ?? (l.mint ? "alias" : "none") };
  if (!l.mint) { line.error = l.row ? `no Solana mint for ${l.t} (${l.row.rail?.note ?? "no rail"})` : `${l.t} is not in the registry`; receipt.push(line); continue; }
  const q = await quote(l.mint, share);
  await sleep(1100);
  if ("err" in q) { line.error = `Jupiter: ${q.err}`; receipt.push(line); continue; }
  const dec = l.decimals ?? 0;
  const qty = Number(q.out) / 10 ** dec;
  line.qty = qty; line.unitPrice = +(share / qty).toFixed(6); line.priceImpact = +(q.impact * 100).toFixed(3); line.route = q.labels.join(" + ");
  if (user) { const ix = await swapInstructions(q.q); await sleep(1100); line.swapInstructions = ix?.swapInstruction ? { computeBudget: (ix.computeBudgetInstructions ?? []).length, setup: (ix.setupInstructions ?? []).length, swapProgram: ix.swapInstruction.programId, lookupTables: (ix.addressLookupTableAddresses ?? []).length } : (ix?.error ?? "unavailable"); }
  receipt.push(line);
}

const out = { cash, fee: +fee.toFixed(4), spent: +spend.toFixed(4), quote: "USDC", chain: "Solana", venue: "Jupiter Swap API v1 (lite)", at: new Date().toISOString(), legs: receipt,
  unit: "one bundle unit = these quantities, held in the Bundle program's vaults; NAV = Σ qty × live mark" };
if (asJson) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

console.log(`\nSourcing receipt · $${cash.toFixed(2)} USDC → bundle · Solana via Jupiter · ${out.at}`);
console.log(`house fee 10 bps $${fee.toFixed(2)} · spent $${spend.toFixed(2)}\n`);
console.log("leg      weight   usd        qty              unit price     impact   rail    route / note");
for (const l of receipt) {
  const left = `${l.leg.padEnd(8)} ${String(l.weight + "%").padStart(6)}   $${l.usd.toFixed(2).padStart(8)}`;
  if (l.error) { console.log(`${left}   ${"—".padEnd(16)} ${"—".padEnd(14)} ${"—".padEnd(8)} ${String(l.rail).padEnd(7)} ${l.error}`); continue; }
  console.log(`${left}   ${l.qty.toFixed(6).padEnd(16)} $${String(l.unitPrice).padEnd(13)} ${(l.priceImpact + "%").padEnd(8)} ${String(l.rail).padEnd(7)} ${l.route}${l.as ? ` (as ${l.as})` : ""}${l.swapInstructions ? ` · swap ix ready (${typeof l.swapInstructions === "string" ? l.swapInstructions : l.swapInstructions.swapProgram})` : ""}`);
}
const bad = receipt.filter(l => l.error).length;
console.log(`\n${receipt.length - bad} of ${receipt.length} legs sourceable right now. ${bad ? bad + " cannot be sourced on Solana today (see notes)." : "Every leg has a live route."}`);
console.log(out.unit + "\n");
