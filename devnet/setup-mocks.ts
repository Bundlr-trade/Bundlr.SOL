#!/usr/bin/env bun
/* setup-mocks.ts — devnet stand-ins for the library's live rails.
   Backed's xStocks, XAUT0, cbBTC etc. have no devnet mints, so for every row the
   settleability pass marked `live` on mainnet we create one devnet mint with the
   same decimals and the same token program, mint authority = the Bundle program's
   faucet PDA. The finder's Mint button faucets these in place of the Jupiter Zap.
   Writes devnet/mocks.json (inlined into the finder by library/registry/inline.ts). */
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { MINT_SIZE, TOKEN_2022_PROGRAM_ID, createInitializeMint2Instruction, getMinimumBalanceForRentExemptMint } from "@solana/spl-token";
import { PROGRAM_ID, faucetPda, tokenProgramOf } from "./bundle-client";

const RPC = process.env.SOLANA_RPC ?? "https://api.devnet.solana.com";
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await Bun.file(process.env.DEPLOYER_KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`).text())));
const conn = new Connection(RPC, "confirmed");
const REG = JSON.parse(await Bun.file(new URL("../library/registry/registry.json", import.meta.url).pathname).text());
const outPath = new URL("./mocks.json", import.meta.url).pathname;
const prev = await Bun.file(outPath).exists() ? JSON.parse(await Bun.file(outPath).text()) : { mints: {} };

const rows = new Map<string, any>();
for (const a of REG.assets) if (a.cls !== "predictions" && a.rail?.status === "live" && a.rail.addr && !rows.has(a.t)) rows.set(a.t, a);
console.log(`${rows.size} live rails → devnet mocks (program ${PROGRAM_ID.toBase58()}, faucet ${faucetPda().toBase58()})`);

const lamports = await getMinimumBalanceForRentExemptMint(conn);
const mints: Record<string, any> = { ...prev.mints };
for (const [t, a] of rows) {
  if (mints[t]?.mint && mints[t].mainnet === a.rail.addr) { console.log(`  ${t} kept ${mints[t].mint}`); continue; }
  const program = a.rail.program === "Token-2022" ? "Token-2022" : "Token";
  const tp = tokenProgramOf(program); const kp = Keypair.generate(); const decimals = a.rail.decimals ?? 6;
  const tx = new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: kp.publicKey, space: MINT_SIZE, lamports, programId: tp }),
    createInitializeMint2Instruction(kp.publicKey, decimals, faucetPda(), null, tp),
  );
  const sig = await sendAndConfirmTransaction(conn, tx, [payer, kp]);
  mints[t] = { mint: kp.publicKey.toBase58(), decimals, program, mainnet: a.rail.addr, name: a.n, cls: a.cls, sig };
  console.log(`  ${t} ${kp.publicKey.toBase58()} (${program}, ${decimals}dp) ${sig.slice(0, 12)}…`);
  await Bun.write(outPath, JSON.stringify({ cluster: "devnet", programId: PROGRAM_ID.toBase58(), faucet: faucetPda().toBase58(), builtAt: new Date().toISOString(), mints }, null, 1));
}
console.log(`wrote ${outPath}`);
