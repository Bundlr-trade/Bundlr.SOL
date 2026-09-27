# Stocklana technical walkthrough — script

For the Stocklana submission (deadline **Fri Sept 25, 4:00 PM ET**). Written 2026-09-24. Untracked on purpose; do not commit speaker notes to the public repo.

## What they are looking for

From the official Stocklana page (hackathons.solana.com/hackathons/stocklana):

- A real user problem with a **working end-to-end demo**
- **Meaningful Solana integration** and evidence the idea belongs on Solana
- **Technical soundness**
- **Post-hackathon viability** ("projects that have a life beyond the hackathon")
- Usability

Their four suggested problem areas: 24/7 trading venues · **recurring buys and index baskets** · credit and yield on tokenized stocks · price feeds and corporate actions. Bundlr is the second one, exactly. Say that in the first thirty seconds.

Submission needs at least one link: GitHub, live demo, or video. "Technical walkthrough" almost certainly means a screen recording where you show the thing running and then show the code that makes it run. Judges have ~28 submissions per the trade press and will skim. So: **demo first, code second, gaps stated plainly, next steps last.** Five to seven minutes. Do not read code line by line; point at the three functions that matter and say what each one guarantees.

## One honesty flag before you record

The Anchor program in `program/src/lib.rs` is written but **not deployed**. Program ID `D1SBx…359t` has no account on devnet or mainnet, there is no compiled `.so`, and `devnet/e2e.ts` has never run (no `mocks.json`). The finder's Mint button is paper (localStorage), not a devnet transaction. `AGENTS.md` and `README.md` still say "design doc," which is out of date the other way: the code exists, it just never got built.

The script below says "written and specified, not yet deployed." Do not say "deployed to devnet" or show the e2e script as if it ran. If you want to deploy before 4 PM tomorrow, that is a separate job: the anchor CLI on this box is broken (glibc mismatch), `solana` CLI is not installed, and the deployer key has no known SOL. It is probably a two to three hour job with no guarantee. Your call; the walkthrough works either way.

## Pre-record checklist

1. Open `library/library-finder.html` from disk. Clear localStorage first so the Positions shelf is empty (`bundlr.ticket`, `bundlr.minted`).
2. In a terminal, from the repo root, have this ready to run on camera. It hits Jupiter live and takes ~10 seconds:
   ```
   bun zap/quote-basket.ts --cash 1000 TSLA:2 NVDA:1 XAUT0:1 SOL:1
   ```
3. Have these files open in tabs, in this order: `library/registry/rails-report.md`, `library/registry/settleable.ts`, `zap/quote-basket.ts`, `program/src/lib.rs`, `docs/solana-equivalents.md`.
4. Have the GitHub repo open: github.com/Bundlr-trade/Bundlr.SOL.

---

## The script

### 0:00 — What this is (30 sec)

**On screen:** the finder, empty bench.

> This is Bundlr on Solana. Bundlr lets anyone, a person or an agent, turn a view into a basket in one click. Tokenized stocks, gold, crypto, T-bills and Kalshi event contracts, side by side, minted as one token backed one-to-one by what it holds and redeemable at NAV.
>
> Your brief listed "recurring buys and index baskets." This is the index basket half, built as a protocol, not a product page. I'll show the app first, then the three pieces of code that make it honest: the rails check, the Zap, and the program.

### 0:30 — The app (90 sec)

**On screen:** click through the finder.

> The library is a Finder. Departments on the left: Stocks, Commodities, Predictions, Crypto and Yield, Currencies. Shelves inside them, GICS sector for stocks, Kalshi category for predictions. Smart folders at the bottom are queries, not lists. "Everything Bitcoin" pulls the coin, the ETFs, the miners and the Kalshi markets about it.

Click Stocks → a sector → select **TSLA**.

> Every row carries a rail. That's the Solana mint a bundle would hold, verified on-chain, and how deep it is on Jupiter. This one is a Backed xStock, Token-2022, live on Jupiter. Click the Solscan link and you're looking at the real mint.

Click a row with **rail: none** (a futures contract in Commodities) and one that is **gated** (an Ondo GM ticker).

> The library also shows what it can't hold, greyed out, and says why. Futures have no Solana mint. Ondo Global Markets tokens exist but are gated to primary mint and redeem at NAV; Jupiter has no route. That honesty is the product. A curator can only put on the bench what the protocol can actually source.

Build a bundle on the bench: TSLA ×2, NVDA ×1, XAUT0 ×1, SOL ×1. Name it.

> The bench on the right is a 3×3 crafting grid. Click a row, it lands in a slot. Click the slot again and it stacks; the ×2 is the weight. Two legs and a name and the output token turns green. The lint below the bench catches concentration, duplicate exposure, and a leg that isn't sourceable.

Click **Mint**, walk through the ticket.

> Mint opens a quantity ticket. A unit is $100 of basket on launch day. The sourcing receipt locks each leg's entry price, and the bundle lands on the Positions shelf where NAV is launch quantities times live marks, net of the 0.75% annual fee and 10 bps each way. This mint is paper today. The transaction it would send is what I'll show next.

### 2:00 — Piece one: the rails check (60 sec)

**On screen:** `library/registry/rails-report.md`, then `settleable.ts`.

> Nothing in the library is typed from memory. `build-registry.ts` compiles 3,671 rows from CoinGecko's platform map, Kalshi's public API, and Jupiter's price API. Then `settleable.ts` reads every mint account on mainnet with `getMultipleAccounts`, checks the owner program, decimals and freeze authority, and asks Jupiter for a $50K quote from USDC.

Point at the status legend and the counts table.

> Live means the mint is verified and $50K fills under 1% impact. Thin means verified but over the threshold. Gated means a legal or transfer gate. Tokenizable is the Kalshi rows, where DFlow mints the YES/NO pair on first order. None means nothing on Solana to hold. 1,217 mints were read from mainnet on this run. 878 Jupiter quotes were spent. The report prints every number.

**Why this matters to a judge:** this is the "evidence it belongs on Solana" criterion, made mechanical. On the EVM build the same library was spread across two launch chains and a settlement chain, and predictions needed a wrapper and a bridge. On Solana every department has a native Token-2022 rail on one chain. That's in `docs/solana-equivalents.md`, one row per dependency.

### 3:00 — Piece two: the Zap (60 sec)

**On screen:** terminal. Run the command.

> The Zap is "cash in, bundle out." Nobody assembles a basket by hand. The buyer pays USDC, the protocol sources every leg through Jupiter, and the program mints units against what landed in the vaults, in one transaction.
>
> `quote-basket.ts` is the read side of that, with no wallet. For each leg it takes the Jupiter route from USDC at that leg's share of the cash, the quantity that would land in the vault, Jupiter's own price impact, and the 10 bps fee.

Let the receipt print. Read one line.

> Every number here is a live quote right now. Add `--user` and a pubkey and it also pulls Jupiter's unsigned swap instructions per leg, which is the off-chain half of the mint transaction, built and ready to sign.

### 4:00 — Piece three: the program (90 sec)

**On screen:** `program/src/lib.rs`. Scroll to the header comment, then `create_bundle`, `issue`, `redeem`.

> The settlement layer is one Anchor program. One bundle is one Token-2022 mint whose authority is a program-derived address. The PDA owns one associated token account per leg; those are the vaults. NAV is what the vaults hold. No oracle.

Point at `create_bundle`.

> `create_bundle` is curator-signed. It creates the mint, records the recipe, two to nine legs with a fixed quantity per unit, and deposits nothing.

Point at `issue`.

> `issue` is the last instruction in the Zap transaction. For every leg it does a `transfer_checked` from the buyer into that leg's vault, and it verifies the vault is the PDA's associated token account for that exact mint, so you can't pass a fake vault. Then it mints units to the buyer. The 10 bps fee is taken in bundle units to the curator, so the vaults always back the units outstanding exactly. If any leg is short the whole transaction reverts. The buyer never holds a partial basket.

Point at `redeem`.

> `redeem` is permissionless. Burn units, take the underlying pro rata. That's the backing guarantee. The cash path appends Jupiter swaps after it.

Scroll to `Faucet`.

> `faucet` is devnet only. Backed's xStocks have no devnet mints, so `setup-mocks.ts` creates a mock with the same decimals and token program for every row the rails check marked live, and the e2e script runs create, faucet, issue, read the vaults, redeem, from the command line.

State it plainly:

> Where this stands: the program is written and compiles against Anchor and the Token-2022 interface, the client encoder in `devnet/bundle-client.ts` is hand-rolled with no Anchor runtime, and the e2e script exists. It is not deployed yet. The design doc in `docs/bundle-program.md` has the fee accrual, the pause switch, and the two-transaction flow for six-plus legs that aren't in this version.

*(If you deploy before recording, replace that paragraph with the Solscan links from `e2e.ts` output and skip the caveat.)*

### 5:30 — Why Solana (45 sec)

**On screen:** `docs/solana-equivalents.md`.

> Four things got simpler on Solana, and each one is a row in this table. Stocks: xStocks trade permissionlessly on Jupiter, Ondo mints at NAV through their API, both Token-2022. Predictions: DFlow tokenizes every Kalshi market into a YES/NO pair, so a prediction leg is just another mint in the vault, no wrapper, no bridge. Gold: Tether's XAUT0 is a native mint with a Jupiter route. Depth: Jupiter's quote API answers across every venue at once with its own price impact number, which took a QuoterV2 call per pool on EVM.

### 6:15 — What's not done, and what's next (45 sec)

> Honest gaps. DFlow's per-market mints need a production API key, so prediction rails are tokenizable, not verified. Ondo GM is gated because their liquidity is primary. Kalshi's API refuses browser requests so odds go through a small relay. And the program needs to go to devnet, then get the transfer-hook question answered for xStocks and Ondo before mainnet.
>
> After the hackathon: this library, the rails check and the Zap are the same code we run on the product. The Solana edition stays a public repo. Team is Jon and Milos.

End on the repo URL.

---

## If they want written, not video

Paste sections 0:00 through 6:15 without the stage directions, add the finder screenshot (`library/library-finder-preview.png`) and the rails counts table, and link the five files in the order above. It reads fine as a doc.

## Words to avoid

Per the Bundlr copy rules: no "in kind," no "expense ratio" (say annual fee), no "sits on top of" anyone. Contents and the bet first. One joke max, at the end.
