/* bundle.test.ts — the bundle program, run for real inside LiteSVM (an in-process Solana VM).
   Loads the compiled program from target/deploy/bundle.so (anchor build, or the CI artifact)
   and drives it with the same hand-encoded client the devnet scripts use.
   cd tests && bun install && bun test */
import { describe, expect, test, beforeEach } from "bun:test";
import { existsSync } from "node:fs";
import { LiteSVM, FailedTransactionMetadata, TransactionMetadata } from "litesvm";
import { Keypair, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, MINT_SIZE, AccountLayout, MintLayout,
  createInitializeMint2Instruction, createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction, createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  PROGRAM_ID, UNIT, bundlePda, faucetPda, createBundleIx, issueIx, redeemIx, faucetIx, decodeBundle, type LegSpec,
} from "../devnet/bundle-client";

const SO = new URL("../target/deploy/bundle.so", import.meta.url).pathname;
if (!existsSync(SO)) throw new Error(`no compiled program at ${SO} — run anchor build, or download the CI artifact`);

let svm: LiteSVM;
let curator: Keypair, buyer: Keypair;

function send(ixs: TransactionInstruction[], signers: Keypair[]) {
  const tx = new Transaction();
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = signers[0].publicKey;
  tx.add(...ixs);
  tx.sign(...signers);
  const res = svm.sendTransaction(tx);
  svm.expireBlockhash();
  return res;
}
function ok(ixs: TransactionInstruction[], signers: Keypair[]) {
  const res = send(ixs, signers);
  if (res instanceof FailedTransactionMetadata) throw new Error(`tx failed: ${res.err()}\n${res.meta().logs().join("\n")}`);
  return res as TransactionMetadata;
}
/** expects failure; returns the joined logs so the caller can check which error fired */
function fails(ixs: TransactionInstruction[], signers: Keypair[]) {
  const res = send(ixs, signers);
  expect(res).toBeInstanceOf(FailedTransactionMetadata);
  return (res as FailedTransactionMetadata).meta().logs().join("\n");
}

function newMint(decimals: number, tokenProgram = TOKEN_2022_PROGRAM_ID, authority = curator.publicKey) {
  const mint = Keypair.generate();
  ok([
    SystemProgram.createAccount({ fromPubkey: curator.publicKey, newAccountPubkey: mint.publicKey, lamports: 10_000_000, space: MINT_SIZE, programId: tokenProgram }),
    createInitializeMint2Instruction(mint.publicKey, decimals, authority, null, tokenProgram),
  ], [curator, mint]);
  return mint.publicKey;
}
const ata = (mint: PublicKey, owner: PublicKey, tp = TOKEN_2022_PROGRAM_ID) => getAssociatedTokenAddressSync(mint, owner, true, tp);
const ataIx = (payer: PublicKey, mint: PublicKey, owner: PublicKey, tp = TOKEN_2022_PROGRAM_ID) =>
  createAssociatedTokenAccountIdempotentInstruction(payer, ata(mint, owner, tp), owner, mint, tp);
function balance(addr: PublicKey) {
  const a = svm.getAccount(addr);
  return a ? AccountLayout.decode(a.data.slice(0, 165)).amount : 0n;
}
const supply = (mint: PublicKey) => MintLayout.decode(svm.getAccount(mint)!.data.slice(0, 82)).supply;
const bundleState = (bundleMint: PublicKey) => decodeBundle(Buffer.from(svm.getAccount(bundlePda(bundleMint))!.data));

/** a live bundle: legs created, vault + unit ATAs opened, buyer funded with plenty of every leg */
function setupBundle(specs: { decimals: number; qty: bigint; tp?: PublicKey }[], fund = 1_000_000_000_000n) {
  const legs: LegSpec[] = specs.map(s => {
    const tp = s.tp ?? TOKEN_2022_PROGRAM_ID;
    return { mint: newMint(s.decimals, tp), qtyPerUnit: s.qty, tokenProgram: tp };
  });
  const bundleMint = Keypair.generate();
  ok([createBundleIx(curator.publicKey, bundleMint.publicKey, "TEST", "Test basket", legs)], [curator, bundleMint]);
  const pda = bundlePda(bundleMint.publicKey);
  const prep: TransactionInstruction[] = [];
  for (const l of legs) {
    prep.push(ataIx(curator.publicKey, l.mint, buyer.publicKey, l.tokenProgram));
    prep.push(ataIx(curator.publicKey, l.mint, pda, l.tokenProgram));
    prep.push(createMintToInstruction(l.mint, ata(l.mint, buyer.publicKey, l.tokenProgram), curator.publicKey, fund, [], l.tokenProgram));
  }
  prep.push(ataIx(curator.publicKey, bundleMint.publicKey, buyer.publicKey));
  prep.push(ataIx(curator.publicKey, bundleMint.publicKey, curator.publicKey));
  ok(prep, [curator]);
  return { legs, bundleMint: bundleMint.publicKey, pda };
}
const vaults = (b: ReturnType<typeof setupBundle>) => b.legs.map(l => balance(ata(l.mint, b.pda, l.tokenProgram)));
const buyerUnits = (b: ReturnType<typeof setupBundle>, who = buyer.publicKey) => balance(ata(b.bundleMint, who));
const feeUnits = (b: ReturnType<typeof setupBundle>) => balance(ata(b.bundleMint, curator.publicKey));

/** the backing invariant: every leg's vault covers the recipe quantity for every unit in existence */
function expectFullyBacked(b: ReturnType<typeof setupBundle>) {
  const outstanding = bundleState(b.bundleMint).unitsOutstanding;
  expect(outstanding).toBe(supply(b.bundleMint));
  vaults(b).forEach((v, i) => expect(v * UNIT).toBeGreaterThanOrEqual(outstanding * b.legs[i].qtyPerUnit));
}

beforeEach(() => {
  svm = new LiteSVM();
  svm.addProgramFromFile(PROGRAM_ID, SO);
  curator = Keypair.generate();
  buyer = Keypair.generate();
  svm.airdrop(curator.publicKey, 100_000_000_000n);
  svm.airdrop(buyer.publicKey, 100_000_000_000n);
});

const TWO_LEGS = [{ decimals: 6, qty: 2_500_000n }, { decimals: 8, qty: 40_000_000n }];

describe("create_bundle", () => {
  function tryCreate(legs: LegSpec[], ticker = "TEST", name = "Test basket") {
    const m = Keypair.generate();
    return send([createBundleIx(curator.publicKey, m.publicKey, ticker, name, legs)], [curator, m]);
  }
  const legsOf = (n: number, qty = 1n) => Array.from({ length: n }, () => ({ mint: newMint(6), qtyPerUnit: qty, tokenProgram: TOKEN_2022_PROGRAM_ID }));

  test("records the recipe, curator, fee and a PDA-controlled 6-decimal mint", () => {
    const b = setupBundle(TWO_LEGS);
    const s = bundleState(b.bundleMint);
    expect(s.curator.equals(curator.publicKey)).toBe(true);
    expect(s.mint.equals(b.bundleMint)).toBe(true);
    expect(s.ticker).toBe("TEST");
    expect(s.feeBps).toBe(10);
    expect(s.unitsOutstanding).toBe(0n);
    expect(s.legs.map(l => l.qtyPerUnit)).toEqual([2_500_000n, 40_000_000n]);
    const mint = MintLayout.decode(svm.getAccount(b.bundleMint)!.data.slice(0, 82));
    expect(mint.decimals).toBe(6);
    expect(new PublicKey(mint.mintAuthority).equals(b.pda)).toBe(true);
    expect(new PublicKey(mint.freezeAuthority).equals(b.pda)).toBe(true);
  });

  test("accepts 2 and 9 legs", () => {
    expect(tryCreate(legsOf(2))).not.toBeInstanceOf(FailedTransactionMetadata);
    expect(tryCreate(legsOf(9))).not.toBeInstanceOf(FailedTransactionMetadata);
  });

  test("rejects 1 leg and 10 legs", () => {
    for (const n of [0, 1, 10]) {
      const res = tryCreate(legsOf(n));
      expect(res).toBeInstanceOf(FailedTransactionMetadata);
      expect((res as FailedTransactionMetadata).meta().logs().join("\n")).toContain("LegCount");
    }
  });

  test("rejects a zero quantity", () => {
    const legs = legsOf(2); legs[1].qtyPerUnit = 0n;
    expect((tryCreate(legs) as FailedTransactionMetadata).meta().logs().join("\n")).toContain("ZeroQty");
  });

  test("rejects the same mint twice", () => {
    const legs = legsOf(2); legs[1].mint = legs[0].mint;
    expect((tryCreate(legs) as FailedTransactionMetadata).meta().logs().join("\n")).toContain("DuplicateLeg");
  });

  test("rejects a ticker over 8 chars or a name over 48", () => {
    expect((tryCreate(legsOf(2), "TOOLONGTK") as FailedTransactionMetadata).meta().logs().join("\n")).toContain("TooLong");
    expect((tryCreate(legsOf(2), "OK", "x".repeat(49)) as FailedTransactionMetadata).meta().logs().join("\n")).toContain("TooLong");
  });

  test("the same bundle mint can't back a second bundle", () => {
    const m = Keypair.generate();
    ok([createBundleIx(curator.publicKey, m.publicKey, "ONE", "One", legsOf(2))], [curator, m]);
    const res = send([createBundleIx(curator.publicKey, m.publicKey, "TWO", "Two", legsOf(2))], [curator, m]);
    expect(res).toBeInstanceOf(FailedTransactionMetadata);
    expect(bundleState(m.publicKey).ticker).toBe("ONE");
  });
});

describe("issue", () => {
  test("pulls units × qty of every leg into the vaults and mints units less the 10 bps fee", () => {
    const b = setupBundle(TWO_LEGS);
    const units = 10n * UNIT;
    ok([issueIx(buyer.publicKey, curator.publicKey, b.bundleMint, b.legs, units)], [buyer]);
    expect(vaults(b)).toEqual([25_000_000n, 400_000_000n]);
    expect(buyerUnits(b)).toBe(units - units / 1000n);
    expect(feeUnits(b)).toBe(units / 1000n);
    expect(bundleState(b.bundleMint).unitsOutstanding).toBe(units);
    expectFullyBacked(b);
  });

  test("works across classic SPL Token and Token-2022 legs in one bundle", () => {
    const b = setupBundle([{ decimals: 6, qty: 1_000_000n, tp: TOKEN_PROGRAM_ID }, { decimals: 9, qty: 3_000_000_000n }]);
    ok([issueIx(buyer.publicKey, curator.publicKey, b.bundleMint, b.legs, 2n * UNIT)], [buyer]);
    expect(vaults(b)).toEqual([2_000_000n, 6_000_000_000n]);
    expectFullyBacked(b);
  });

  test("zero units is rejected", () => {
    const b = setupBundle(TWO_LEGS);
    expect(fails([issueIx(buyer.publicKey, curator.publicKey, b.bundleMint, b.legs, 0n)], [buyer])).toContain("ZeroUnits");
  });

  test("fails whole when the buyer is short one leg — nothing moves", () => {
    const b = setupBundle(TWO_LEGS, 30_000_000n); // enough of leg 0 for 12 units, far too little of leg 1
    fails([issueIx(buyer.publicKey, curator.publicKey, b.bundleMint, b.legs, 10n * UNIT)], [buyer]);
    expect(vaults(b)).toEqual([0n, 0n]);
    expect(supply(b.bundleMint)).toBe(0n);
  });

  test("legs out of recipe order are rejected", () => {
    const b = setupBundle(TWO_LEGS);
    const ix = issueIx(buyer.publicKey, curator.publicKey, b.bundleMint, b.legs, UNIT);
    const legKeys = ix.keys.slice(6);
    ix.keys = [...ix.keys.slice(0, 6), ...legKeys.slice(4), ...legKeys.slice(0, 4)];
    expect(fails([ix], [buyer])).toContain("LegMismatch");
  });

  test("a vault that isn't the bundle PDA's ATA is rejected", () => {
    const b = setupBundle(TWO_LEGS);
    const thief = Keypair.generate();
    ok([ataIx(curator.publicKey, b.legs[0].mint, thief.publicKey)], [curator]);
    const ix = issueIx(buyer.publicKey, curator.publicKey, b.bundleMint, b.legs, UNIT);
    ix.keys[6 + 2] = { pubkey: ata(b.legs[0].mint, thief.publicKey), isSigner: false, isWritable: true };
    expect(fails([ix], [buyer])).toContain("VaultMismatch");
  });

  test("the wrong number of leg accounts is rejected", () => {
    const b = setupBundle(TWO_LEGS);
    const ix = issueIx(buyer.publicKey, curator.publicKey, b.bundleMint, b.legs, UNIT);
    ix.keys = ix.keys.slice(0, ix.keys.length - 4);
    expect(fails([ix], [buyer])).toContain("LegAccounts");
  });

  test("the fee can't be routed anywhere but the curator's account", () => {
    const b = setupBundle(TWO_LEGS);
    const ix = issueIx(buyer.publicKey, curator.publicKey, b.bundleMint, b.legs, 10n * UNIT);
    ix.keys[4] = { pubkey: ata(b.bundleMint, buyer.publicKey), isSigner: false, isWritable: true };
    fails([ix], [buyer]);
  });

  test("a fake bundle mint can't be swapped in", () => {
    const b = setupBundle(TWO_LEGS);
    const fake = newMint(6);
    const ix = issueIx(buyer.publicKey, curator.publicKey, b.bundleMint, b.legs, UNIT);
    ix.keys[2] = { pubkey: fake, isSigner: false, isWritable: true };
    fails([ix], [buyer]);
  });

  test("never mints a unit the vaults don't back, even for tiny amounts", () => {
    // 0.5 base units of leg 0 per base unit of bundle: issuing 1 base unit must still deposit something
    const b = setupBundle([{ decimals: 6, qty: 500_000n }, { decimals: 6, qty: 1_500_000n }]);
    ok([issueIx(buyer.publicKey, curator.publicKey, b.bundleMint, b.legs, 1n)], [buyer]);
    expect(vaults(b)[0]).toBeGreaterThan(0n);
    expectFullyBacked(b);
  });

  test("many tiny issues can't farm units: the vaults always cover the whole supply", () => {
    const b = setupBundle([{ decimals: 6, qty: 999_999n }, { decimals: 8, qty: 12_345_678n }]);
    for (let i = 0; i < 20; i++) ok([issueIx(buyer.publicKey, curator.publicKey, b.bundleMint, b.legs, 1n)], [buyer]);
    expectFullyBacked(b);
  });
});

describe("redeem", () => {
  test("burns units and releases the legs pro-rata, less the 10 bps fee in units", () => {
    const b = setupBundle(TWO_LEGS);
    ok([issueIx(buyer.publicKey, curator.publicKey, b.bundleMint, b.legs, 10n * UNIT)], [buyer]);
    const before = buyerUnits(b), feeBefore = feeUnits(b);
    const units = 4n * UNIT, fee = units / 1000n, net = units - fee;
    const legBefore = b.legs.map(l => balance(ata(l.mint, buyer.publicKey, l.tokenProgram)));
    ok([redeemIx(buyer.publicKey, curator.publicKey, b.bundleMint, b.legs, units)], [buyer]);
    expect(buyerUnits(b)).toBe(before - units);
    expect(feeUnits(b)).toBe(feeBefore + fee);
    b.legs.forEach((l, i) => expect(balance(ata(l.mint, buyer.publicKey, l.tokenProgram)) - legBefore[i]).toBe(net * l.qtyPerUnit / UNIT));
    expect(bundleState(b.bundleMint).unitsOutstanding).toBe(10n * UNIT - net);
    expectFullyBacked(b);
  });

  test("is permissionless: anyone holding units can redeem, not just the original buyer", () => {
    const b = setupBundle(TWO_LEGS);
    ok([issueIx(buyer.publicKey, curator.publicKey, b.bundleMint, b.legs, 5n * UNIT)], [buyer]);
    const stranger = Keypair.generate();
    svm.airdrop(stranger.publicKey, 10_000_000_000n);
    ok([
      ataIx(stranger.publicKey, b.bundleMint, stranger.publicKey),
      ...b.legs.map(l => ataIx(stranger.publicKey, l.mint, stranger.publicKey, l.tokenProgram)),
    ], [stranger]);
    ok([createTransferCheckedInstruction(ata(b.bundleMint, buyer.publicKey), b.bundleMint, ata(b.bundleMint, stranger.publicKey), buyer.publicKey, 2n * UNIT, 6, [], TOKEN_2022_PROGRAM_ID)], [buyer]);
    ok([redeemIx(stranger.publicKey, curator.publicKey, b.bundleMint, b.legs, 2n * UNIT)], [stranger]);
    expect(balance(ata(b.legs[0].mint, stranger.publicKey))).toBeGreaterThan(0n);
    expectFullyBacked(b);
  });

  test("can't redeem units you don't hold", () => {
    const b = setupBundle(TWO_LEGS);
    ok([issueIx(buyer.publicKey, curator.publicKey, b.bundleMint, b.legs, UNIT)], [buyer]);
    fails([redeemIx(buyer.publicKey, curator.publicKey, b.bundleMint, b.legs, 2n * UNIT)], [buyer]);
  });

  test("can't pay yourself out of the vault by pointing 'your' leg account at someone else's", () => {
    const b = setupBundle(TWO_LEGS);
    ok([issueIx(buyer.publicKey, curator.publicKey, b.bundleMint, b.legs, 2n * UNIT)], [buyer]);
    const ix = redeemIx(buyer.publicKey, curator.publicKey, b.bundleMint, b.legs, UNIT);
    ix.keys[6 + 2] = { pubkey: ata(b.legs[0].mint, buyer.publicKey), isSigner: false, isWritable: true }; // vault slot → own ATA
    expect(fails([ix], [buyer])).toContain("VaultMismatch");
  });

  test("zero units is rejected", () => {
    const b = setupBundle(TWO_LEGS);
    expect(fails([redeemIx(buyer.publicKey, curator.publicKey, b.bundleMint, b.legs, 0n)], [buyer])).toContain("ZeroUnits");
  });

  test("the last holder can always redeem everything, and the vaults never go short", () => {
    const b = setupBundle([{ decimals: 6, qty: 333_333n }, { decimals: 8, qty: 7_777_777n }, { decimals: 9, qty: 1_000_000_001n }]);
    const issues = [1n, 7n, 999n, 123_457n, 3n * UNIT + 1n, 17n];
    for (const u of issues) ok([issueIx(buyer.publicKey, curator.publicKey, b.bundleMint, b.legs, u)], [buyer]);
    for (const u of [5n, 1_001n, UNIT]) { ok([redeemIx(buyer.publicKey, curator.publicKey, b.bundleMint, b.legs, u)], [buyer]); expectFullyBacked(b); }
    // hand the curator's fee units to the buyer and redeem the entire supply in one go
    ok([createTransferCheckedInstruction(ata(b.bundleMint, curator.publicKey), b.bundleMint, ata(b.bundleMint, buyer.publicKey), curator.publicKey, feeUnits(b), 6, [], TOKEN_2022_PROGRAM_ID)], [curator]);
    ok([redeemIx(buyer.publicKey, curator.publicKey, b.bundleMint, b.legs, buyerUnits(b))], [buyer]);
    expectFullyBacked(b);
  });
});

describe("faucet (devnet mock legs)", () => {
  test("mints a mock leg whose authority is the faucet PDA", () => {
    const mint = newMint(6, TOKEN_2022_PROGRAM_ID, faucetPda());
    ok([ataIx(buyer.publicKey, mint, buyer.publicKey)], [buyer]);
    ok([faucetIx(buyer.publicKey, mint, TOKEN_2022_PROGRAM_ID, 5_000_000n)], [buyer]);
    expect(balance(ata(mint, buyer.publicKey))).toBe(5_000_000n);
  });

  test("can't mint a token whose authority is anyone else", () => {
    const mint = newMint(6);
    ok([ataIx(buyer.publicKey, mint, buyer.publicKey)], [buyer]);
    fails([faucetIx(buyer.publicKey, mint, TOKEN_2022_PROGRAM_ID, 5_000_000n)], [buyer]);
  });

  test("can't mint bundle units (their authority is the bundle PDA)", () => {
    const b = setupBundle(TWO_LEGS);
    fails([faucetIx(buyer.publicKey, b.bundleMint, TOKEN_2022_PROGRAM_ID, 5_000_000n)], [buyer]);
    expect(supply(b.bundleMint)).toBe(0n);
  });
});
