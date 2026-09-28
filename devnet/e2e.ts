#!/usr/bin/env bun
/* e2e.ts — the whole life of a bundle on devnet, from the command line:
   create_bundle (3 legs) → faucet the mock legs → issue 10 units → read the vaults → redeem 4 units.
   Checks every balance against the recipe and exits non-zero on any mismatch.
   bun devnet/e2e.ts [TSLA NVDA AAPL] */
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAccount, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PROGRAM_ID, UNIT, bundlePda, createBundleIx, decodeBundle, faucetIx, issueIx, redeemIx, tokenProgramOf, type LegSpec } from "./bundle-client";

const RPC = process.env.SOLANA_RPC ?? "https://api.devnet.solana.com";
const me = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await Bun.file(process.env.DEPLOYER_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`).text())));
const conn = new Connection(RPC, "confirmed");
const MOCKS = JSON.parse(await Bun.file(new URL("./mocks.json", import.meta.url).pathname).text());
const REG = JSON.parse(await Bun.file(new URL("../library/registry/registry.json", import.meta.url).pathname).text());
const tickers = process.argv.slice(2).length ? process.argv.slice(2) : ["TSLA", "NVDA", "AAPL"];

/* a unit is $100 of basket, equal weights: qty_i = (100/n) / price_i, in the leg's base units */
const legs: LegSpec[] = [], human: any[] = [];
for (const t of tickers) {
  const m = MOCKS.mints[t]; if (!m) throw new Error(`${t} has no devnet mock — run setup-mocks.ts`);
  const row = REG.assets.find((a: any) => a.t === t && a.cls !== "predictions" && a.price > 0);
  const px = row?.price ?? 100;
  const qty = BigInt(Math.round((100 / tickers.length / px) * 10 ** m.decimals));
  legs.push({ mint: new PublicKey(m.mint), qtyPerUnit: qty, tokenProgram: tokenProgramOf(m.program) });
  human.push({ t, px, qtyPerUnit: Number(qty) / 10 ** m.decimals });
}
console.table(human);

const bundleMint = Keypair.generate();
const bundle = bundlePda(bundleMint.publicKey);
const ticker = tickers.map(t => t[0]).join("").slice(0, 6), name = `${tickers.join(" + ")} basket`;
const sig1 = await sendAndConfirmTransaction(conn, new Transaction().add(createBundleIx(me.publicKey, bundleMint.publicKey, ticker, name, legs)), [me, bundleMint]);
console.log(`create_bundle  $${ticker}  mint ${bundleMint.publicKey.toBase58()}  pda ${bundle.toBase58()}\n  https://solscan.io/tx/${sig1}?cluster=devnet`);

const units = 10n * UNIT;
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
let failures = 0;
function check(label: string, got: bigint, want: bigint) {
  const pass = got === want;
  if (!pass) failures++;
  console.log(`${pass ? "ok  " : "FAIL"} ${label}: ${got}${pass ? "" : ` (expected ${want})`}`);
}
const prep = new Transaction();
for (const l of legs) {
  prep.add(createAssociatedTokenAccountIdempotentInstruction(me.publicKey, getAssociatedTokenAddressSync(l.mint, me.publicKey, false, l.tokenProgram), me.publicKey, l.mint, l.tokenProgram));
  prep.add(createAssociatedTokenAccountIdempotentInstruction(me.publicKey, getAssociatedTokenAddressSync(l.mint, bundle, true, l.tokenProgram), bundle, l.mint, l.tokenProgram));
  prep.add(faucetIx(me.publicKey, l.mint, l.tokenProgram, ceilDiv(units * l.qtyPerUnit, UNIT)));
}
prep.add(createAssociatedTokenAccountIdempotentInstruction(me.publicKey, getAssociatedTokenAddressSync(bundleMint.publicKey, me.publicKey, false, TOKEN_2022_PROGRAM_ID), me.publicKey, bundleMint.publicKey, TOKEN_2022_PROGRAM_ID));
const sig2 = await sendAndConfirmTransaction(conn, prep, [me]);
console.log(`faucet + ATAs  https://solscan.io/tx/${sig2}?cluster=devnet`);

const sig3 = await sendAndConfirmTransaction(conn, new Transaction().add(issueIx(me.publicKey, me.publicKey, bundleMint.publicKey, legs, units)), [me]);
console.log(`issue 10 units https://solscan.io/tx/${sig3}?cluster=devnet`);

/* the deployer is both buyer and curator here, so the net units and the fee land in the same account */
const myUnits = async () => (await getAccount(conn, getAssociatedTokenAddressSync(bundleMint.publicKey, me.publicKey, false, TOKEN_2022_PROGRAM_ID), "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
const vault = async (l: LegSpec) => (await getAccount(conn, getAssociatedTokenAddressSync(l.mint, bundle, true, l.tokenProgram), "confirmed", l.tokenProgram)).amount;
const outstanding = async () => decodeBundle((await conn.getAccountInfo(bundle))!.data).unitsOutstanding;

console.log("after issue");
check("units outstanding", await outstanding(), units);
check("my units (net + curator fee)", await myUnits(), units);
for (const [i, l] of legs.entries()) check(`${tickers[i]} vault`, await vault(l), ceilDiv(units * l.qtyPerUnit, UNIT));

const redeemUnits = 4n * UNIT, redeemNet = redeemUnits - redeemUnits * 10n / 10_000n;
const sig4 = await sendAndConfirmTransaction(conn, new Transaction().add(redeemIx(me.publicKey, me.publicKey, bundleMint.publicKey, legs, redeemUnits)), [me]);
console.log(`redeem 4 units https://solscan.io/tx/${sig4}?cluster=devnet`);
console.log("after redeem");
check("units outstanding", await outstanding(), units - redeemNet);
check("my units", await myUnits(), units - redeemNet);
for (const [i, l] of legs.entries()) check(`${tickers[i]} vault`, await vault(l), ceilDiv(units * l.qtyPerUnit, UNIT) - redeemNet * l.qtyPerUnit / UNIT);
console.log(JSON.stringify({ programId: PROGRAM_ID.toBase58(), bundleMint: bundleMint.publicKey.toBase58(), bundle: bundle.toBase58(), txs: [sig1, sig2, sig3, sig4] }));
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
