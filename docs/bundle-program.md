# Bundle program — design (Solana / Anchor)

Status: **design, not deployed.** The EVM side shipped `Bundle.sol` (settlement layer), a factory, and a testnet Zap. This page specifies the same three pieces as one Anchor program plus an off-chain Zap composer, so the library's mint path has a real target. `zap/quote-basket.ts` already produces the sourcing receipt against live Jupiter routes; the program is what receives it.

## Principle carried over unchanged

**Cash in, bundle out.** Nobody is ever asked to assemble a basket. The buyer pays USDC; the Zap sources every leg through Jupiter and the program mints bundle units against what landed in the vaults, in one transaction. Redemption runs in reverse: burn units, the vaults release pro-rata, the Zap sells the legs back to USDC at NAV. The right to take the underlying tokens instead is the backing guarantee, not the default flow.

## Accounts

| Account | Kind | Seeds | Holds |
|---|---|---|---|
| `Bundle` | PDA, program data | `["bundle", bundle_mint]` | curator pubkey, fee config (10 bps mint/redeem, 75 bps/yr annual as share inflation), leg list `[ { mint, weight_bps, vault } ]`, `units_outstanding`, `last_accrual_slot`, paused flag |
| `bundle_mint` | Token-2022 mint | created by `create_bundle` | mint authority = `Bundle` PDA, 9 decimals, metadata extension (ticker, name, curator URI) |
| `vault[i]` | Token / Token-2022 account | `["vault", bundle_mint, leg_mint]` | the leg's tokens, owner = `Bundle` PDA. Token-2022 legs with transfer hooks (xStocks, Ondo GM, Kalshi outcome tokens) are supported because the vault is an ordinary token account created with the leg's own program |
| `fee_vault` | Token account (USDC) | `["fees", bundle_mint]` | mint/redeem bps and the curator's share of the annual accrual |

## Instructions

1. **`create_bundle(ticker, name, legs[])`** — curator-signed. Validates 2–9 legs, weights sum to 10 000 bps, every leg mint is a live SPL / Token-2022 mint, creates the bundle mint and one vault per leg. Nothing is deposited here.
2. **`mint(units, max_usdc)`** — the Zap's last instruction. The same transaction has already run one Jupiter swap per leg (USDC → leg mint) with the buyer's ATA as destination, then `transfer_checked` of each leg into its vault. `mint` verifies that each vault's balance grew by at least `units × qty_per_unit[i]` since the transaction started (a `snapshot` instruction at the top records the balances into a scratch account), charges 10 bps of the USDC notional into `fee_vault`, and mints `units` to the buyer. If any leg is short, the whole transaction reverts, so the buyer never holds a partial basket.
3. **`redeem(units)`** — burns units, releases `units × vault_balance / units_outstanding` of every leg to the holder's ATAs (this is the permissionless in-underlying exit that backs the token), charges 10 bps. The Zap's redeem-to-cash path appends one Jupiter swap per leg after it.
4. **`accrue()`** — permissionless. Mints `units_outstanding × 0.0075 × Δt/year` new units to `fee_vault`'s bundle-unit account (share inflation), splits curator / house per the tier table (85/15 under $1M AUM, 70/30 to $10M, 60/40 above). Called by `mint` and `redeem` first, so NAV is always net.
5. **`pause` / `unpause`** — house multisig only, blocks `mint`, never `redeem`.

`qty_per_unit[i]` is fixed at `create_bundle` from the launch prices: a unit is sized at $100 of basket that day, exactly the convention the library's NAV uses (`q_i = w_i / p0_i`).

## The Zap (off-chain composer)

> **Superseded 2026-09-24** by `zap-escrow-spec-2026-09-24.md`: the Zap is now an on-chain escrow program (`open` → `fill` per leg → `finish`, cancel after a deadline) because a five-leg basket does not fit in one transaction. The paragraph below is the original single-transaction sketch, kept for the record.


For `mint`: `quote-basket.ts` → Jupiter `/swap-instructions` per leg (destination = buyer ATA, `wrapAndUnwrapSol`) → `snapshot` → swaps → `transfer_checked` × n → `mint`. Address lookup tables from Jupiter keep the transaction under the 1 232-byte limit for up to ~5 legs; 6–9 legs use a two-transaction flow guarded by a `pending_mint` escrow PDA (buyer's USDC held until the second transaction completes or expires).

Kalshi legs: the Jupiter swap is replaced by a DFlow `/order` (USDC → YES or NO mint) in the same slot; the outcome mint is Token-2022 and sits in a vault like any other leg. After resolution `redeem` releases the outcome token and the holder redeems it for USDC with DFlow.

## What the EVM contracts had that maps 1:1

| `Bundle.sol` / factory / Zap | Program |
|---|---|
| `mint(to, units)` after `transferFrom` of each ERC-20 | `snapshot` + `transfer_checked` × n + `mint` in one tx |
| `redeem(units)` pro-rata `transfer` out | `redeem` pro-rata to ATAs |
| Factory `createBundle(...)` | `create_bundle` (PDA-derived, no factory contract needed) |
| Uniswap-routed Zap, 10 bps, TVL cap | Jupiter-routed composer, 10 bps in `mint`/`redeem`, `max_units` cap in `Bundle` |
| Streaming fee via share inflation (v1.1) | `accrue` share inflation, same tier table |

## Open questions

- Token-2022 **transfer hooks** on xStocks and Ondo GM tokens: the hook program must allow the vault PDA as a destination. xStocks' hook is a compliance allow/deny list on the *sender* side today; Ondo GM requires whitelisted holders, which is why Ondo rows are `gated · primary` in the library until Ondo whitelists the program.
- **Compute**: 9 Jupiter swaps in one transaction exceed CU limits on busy routes; the two-transaction escrow is the fallback, or a Jito bundle.
- **Oracle-free by design**, like the EVM version: NAV is what the vaults hold; prices only exist in the Zap's quotes and the library's marks.
