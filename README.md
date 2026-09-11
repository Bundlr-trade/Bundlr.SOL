# bundlr on Solana

**One market, one chain.** Bundlr lets any curator — a person or an agent — turn a view into a basket in one click: tokenized stocks, gold, crypto, T-bills and Kalshi event contracts, side by side, minted as one token that is backed 1:1 by what it holds and redeemable at NAV. This repo is the Bundlr library rebuilt for Solana for the Colosseum Crypto World's Fair (Sept 14 – Oct 12, 2026).

Open `library/library-finder.html` in a browser. No server, no wallet. Everything on screen is live.

![finder](library/library-finder-preview.png)

## What you are looking at

A Finder. Departments on the left (Stocks · Commodities · Predictions · Crypto + Yield · Currencies), shelves inside them (GICS sector, metal, Kalshi category), assets inside those, a preview when you select one. Smart folders at the bottom are queries, not lists ("Everything Bitcoin", "Fed decision", "China", "Defense"). On the right, a 3×3 crafting bench: click a row and it lands in a slot; click the slot again and it stacks — the ×n is the weight. Two legs and a name and the output token turns green. Mint opens a quantity ticket, the sourcing receipt locks each leg's entry price, and the bundle lands on the Positions shelf where NAV = launch quantities × live marks, net of the 0.75%/yr annual fee and 10 bps each way. Paper today; the program it targets is in `docs/bundle-program.md`.

Every row carries a **rail**: the Solana mint a bundle would hold, verified on-chain, and how deep it is on Jupiter. The library shows what it cannot hold too (futures, most FX stables) and says why. That honesty is the product: a curator can only put on the bench what the protocol can actually source.

## The Solana edition, by the numbers

| | |
|---|---|
| Registry rows | 3671 (2800 mintable, 1249 with a Solana mint) |
| Tokenized stocks | 738 Backed xStocks + 449 Ondo Global Markets tickers, all Token-2022 |
| Rails verified on-chain | 1217 mints read from mainnet (owner program, decimals, freeze authority) |
| Live on Jupiter | 27 rows fill $50K of USDC under 1% impact · 741 thin · 449 gated (Ondo primary) |
| Predictions | 2360 Kalshi markets (138 watch-only inside the 30-day gate), each a YES/NO Token-2022 pair via DFlow |
| Gold | XAUT0 (Tether Gold, native Solana mint) + GLDx / GLDon / SLVon on the ETF shelf |
| Built | 2026-09-11 |

Full table of what each EVM dependency became: [`docs/solana-equivalents.md`](docs/solana-equivalents.md). Depth per ticker: [`library/registry/rails-report.md`](library/registry/rails-report.md).

## Why Solana made this simpler

On the EVM build the library lived across two launch chains and one settlement chain nobody could hold a bundle on: stocks on Robinhood Chain (gated on counsel) and Arbitrum (Dinari, gated), xStocks with no verified address, gold with no rail on Arbitrum One, and every prediction leg parked on Polygon as an ERC-1155 that needed a wrapper and a bridge before a bundle could hold it. On Solana all four departments have a native rail on one chain:

- **Stocks** — xStocks trade permissionlessly on Jupiter; Ondo Global Markets mint and redeem at NAV through the Ondo Stocks API. Both are Token-2022 mints a program can hold in a vault.
- **Predictions** — DFlow tokenizes every Kalshi market into a YES / NO Token-2022 pair on Solana. A prediction leg is just another mint in the vault, and redeems to USDC at resolution. No wrapper, no bridge, no "phase 3".
- **Gold** — Tether Gold's XAUT0 is a native Solana mint with a Jupiter route.
- **Depth** — Jupiter's quote API answers the question Uniswap's QuoterV2 answered on EVM, across every venue at once, with its own `priceImpactPct`.
- **Cash in** — USDC-SPL is where every card on-ramp lands. No cross-chain leg in front of the Zap.

## Run it

```bash
bun library/registry/build-registry.ts     # CoinGecko + Kalshi + Jupiter → registry.json  (~5 min, paced)
bun library/registry/settleable.ts         # read every mint on mainnet, quote depth on Jupiter → rail per row
bun library/registry/inline.ts             # bake registry + logos into library-finder.html
bun zap/quote-basket.ts --cash 1000 TSLA:2 NVDA:1 XAUT0:1 SOL:1     # live sourcing receipt for a basket
```

`quote-basket.ts` is the Zap's read side: for each leg, the Jupiter route from USDC at that leg's share of the cash, the quantity that would land in the vault, the price impact, and the 10 bps fee. Add `--user <pubkey>` and it also builds Jupiter's unsigned swap instructions, which is the half of the mint transaction that exists off-chain today.

## Rails, precisely

`rail.status` per row, written by `settleable.ts`:

- **live** — mint account read on mainnet, Jupiter fills $50K of USDC at ≤ 1% impact
- **thin** — mint verified, but over the threshold, no route, or under $10K pooled liquidity (marked without spending a quote)
- **gated** — token exists on Solana, a legal or transfer gate applies (Ondo GM: primary mint/redeem at NAV, whitelisted)
- **tokenizable** — Kalshi markets: the YES/NO pair is minted by DFlow on the first order if it does not already exist
- **none** — no Solana mint (futures, most FX stables). Shown anyway, greyed, so the shelf is honest.

Nothing is typed from memory. Mint addresses come from CoinGecko's platform map or the issuer's docs and are re-read on-chain; depth is a live quote; `rails-report.md` prints the run.

## What is not done

- DFlow's per-market mint addresses need a production API key; prediction rails are `tokenizable`, not verified mints.
- The Bundle program is a design (`docs/bundle-program.md`), not a deployment. `Bundle.sol` and the testnet Zap exist on the EVM side; this is the Anchor spec that replaces them.
- Ondo Global Markets rows are gated because their liquidity is primary; Jupiter has no route for most of them today.
- Kalshi's API refuses browser requests, so odds go through a small relay; Kalshi history is not browser-reachable, so prediction legs sit out of the 30-day backtest.

## Lineage

Ported from the Bundlr curator-studio library (EVM). The departments, shelves, smart folders, bench, lint, NAV math, resolvers and logo pipeline are unchanged; the chain layer (`rails.json`, `settleable.ts`, the price feeds and the rail copy in the mock) is new. Team: Jon, Milos, Daniel.
