/* bundle-client.ts — hand-encoded client for the Bundle program (no Anchor runtime).
   Anchor wire format: 8-byte discriminator = sha256("global:<ix>")[0..8], then Borsh args.
   Shared by the devnet scripts; the finder inlines the same encoding in plain JS. */
import { createHash } from "node:crypto";
import { PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";

export const PROGRAM_ID = new PublicKey(process.env.BUNDLE_PROGRAM_ID ?? "41NTbgRwNoyYUjSd9xCuf7Ny6ZUYgMxk6knq2Lpvy1RD");
export const UNIT = 1_000_000n;

export const disc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
const str = (s: string) => { const b = Buffer.from(s, "utf8"); const l = Buffer.alloc(4); l.writeUInt32LE(b.length); return Buffer.concat([l, b]); };

export const bundlePda = (bundleMint: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("bundle"), bundleMint.toBuffer()], PROGRAM_ID)[0];
export const faucetPda = () => PublicKey.findProgramAddressSync([Buffer.from("faucet")], PROGRAM_ID)[0];
export const tokenProgramOf = (p: string) => p === "Token-2022" ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

export type LegSpec = { mint: PublicKey; qtyPerUnit: bigint; tokenProgram: PublicKey };

export function createBundleIx(curator: PublicKey, bundleMint: PublicKey, ticker: string, name: string, legs: LegSpec[]) {
  const n = Buffer.alloc(4); n.writeUInt32LE(legs.length);
  const data = Buffer.concat([disc("create_bundle"), str(ticker), str(name), n, ...legs.map(l => Buffer.concat([l.mint.toBuffer(), u64(l.qtyPerUnit)]))]);
  const keys: AccountMeta[] = [
    { pubkey: curator, isSigner: true, isWritable: true },
    { pubkey: bundleMint, isSigner: true, isWritable: true },
    { pubkey: bundlePda(bundleMint), isSigner: false, isWritable: true },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
}

function legMetas(bundle: PublicKey, user: PublicKey, legs: LegSpec[]): AccountMeta[] {
  return legs.flatMap(l => [
    { pubkey: l.mint, isSigner: false, isWritable: false },
    { pubkey: getAssociatedTokenAddressSync(l.mint, user, false, l.tokenProgram), isSigner: false, isWritable: true },
    { pubkey: getAssociatedTokenAddressSync(l.mint, bundle, true, l.tokenProgram), isSigner: false, isWritable: true },
    { pubkey: l.tokenProgram, isSigner: false, isWritable: false },
  ]);
}

function unitsIx(name: "issue" | "redeem", user: PublicKey, curator: PublicKey, bundleMint: PublicKey, legs: LegSpec[], units: bigint) {
  const bundle = bundlePda(bundleMint);
  const keys: AccountMeta[] = [
    { pubkey: user, isSigner: true, isWritable: true },
    { pubkey: bundle, isSigner: false, isWritable: true },
    { pubkey: bundleMint, isSigner: false, isWritable: true },
    { pubkey: getAssociatedTokenAddressSync(bundleMint, user, false, TOKEN_2022_PROGRAM_ID), isSigner: false, isWritable: true },
    { pubkey: getAssociatedTokenAddressSync(bundleMint, curator, false, TOKEN_2022_PROGRAM_ID), isSigner: false, isWritable: true },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ...legMetas(bundle, user, legs),
  ];
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data: Buffer.concat([disc(name), u64(units)]) });
}
export const issueIx = (buyer: PublicKey, curator: PublicKey, bundleMint: PublicKey, legs: LegSpec[], units: bigint) => unitsIx("issue", buyer, curator, bundleMint, legs, units);
export const redeemIx = (holder: PublicKey, curator: PublicKey, bundleMint: PublicKey, legs: LegSpec[], units: bigint) => unitsIx("redeem", holder, curator, bundleMint, legs, units);

export function faucetIx(user: PublicKey, mint: PublicKey, tokenProgram: PublicKey, amount: bigint) {
  const keys: AccountMeta[] = [
    { pubkey: user, isSigner: true, isWritable: false },
    { pubkey: faucetPda(), isSigner: false, isWritable: false },
    { pubkey: mint, isSigner: false, isWritable: true },
    { pubkey: getAssociatedTokenAddressSync(mint, user, false, tokenProgram), isSigner: false, isWritable: true },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
  ];
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data: Buffer.concat([disc("faucet"), u64(amount)]) });
}

/* Bundle account layout (Anchor): 8 disc · curator 32 · mint 32 · ticker str · name str · legs vec · fee u16 · units u64 · created i64 · bump */
export function decodeBundle(data: Buffer) {
  let o = 8; const pk = () => { const k = new PublicKey(data.subarray(o, o + 32)); o += 32; return k; };
  const rs = () => { const l = data.readUInt32LE(o); o += 4; const s = data.subarray(o, o + l).toString("utf8"); o += l; return s; };
  const curator = pk(), mint = pk(), ticker = rs(), name = rs();
  const n = data.readUInt32LE(o); o += 4; const legs = [];
  for (let i = 0; i < n; i++) { const m = pk(); const q = data.readBigUInt64LE(o); o += 8; legs.push({ mint: m, qtyPerUnit: q }); }
  const feeBps = data.readUInt16LE(o); o += 2; const unitsOutstanding = data.readBigUInt64LE(o); o += 8; const createdAt = data.readBigInt64LE(o); o += 8;
  return { curator, mint, ticker, name, legs, feeBps, unitsOutstanding, createdAt, bump: data[o] };
}

if (import.meta.main) for (const n of ["create_bundle", "issue", "redeem", "faucet"]) console.log(n, JSON.stringify([...disc(n)]));
