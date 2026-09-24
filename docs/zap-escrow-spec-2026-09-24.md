# The Zap on Solana — escrow spec

*2026-09-24. Migration plan phase 3 (`Projects/bundlr/docs/solana-migration-plan-2026-09-24.md`). This is the Solana reading of `Projects/bundlr/docs/zap-v2-spec-2026-09-07.md`, written before code. It is new design, not a port: a five-leg basket does not fit in one Solana transaction, so the Zap becomes an escrow that fills legs across transactions and only issues when every leg is in. All-or-nothing survives. Single-transaction does not, except where it happens to fit. Put this in front of someone at Skyline or the Foundation before mainnet.*

## What stays true from Zap v2

- **Cash in, bundle out.** The buyer pays USDC and receives bundle units. Nobody at Bundlr touches the cash: the escrow is a program-derived account and no key can move what it holds.
- **The settlement layer has no owner and no oracle.** The `bundle` program (`programs/bundle/src/lib.rs`: `create_bundle`, `issue`, `redeem`) stays as written. Tokens in, units out; units in, tokens out. Its upgrade authority is burned after audit.
- **Every product control lives on the Zap**: fee, cap, pause, fee sink, owner. The Zap can never move a user's tokens, change a recipe, or touch a vault except through `issue` and `redeem` with the user's own units.
- **Exact-output per leg** so the unit count is deterministic. **Recipe verification** from the bundle account: the caller chooses routes and bounds, never what is bought.
- **In-kind exit always works.** `bundle.redeem` is permissionless and pause never blocks it.
- **$500 cap per bundle until the audit.** Owner key off the server (Jon's wallet, phase 7). Pause-only key on the box.

## Two programs

| Program | Authority | Holds | Purpose |
|---|---|---|---|
| `bundle` | none after audit | vaults (one ATA per leg, owner = bundle PDA) | settlement: create, issue, redeem |
| `zap` | Jon's wallet (upgradeable) | escrows (USDC + leg ATAs per open order), `ZapConfig`, `BundleControls` | the automated Authorized Participant: escrow, fills, cap, pause, fee |

## Accounts (zap)

| Account | Seeds | Fields |
|---|---|---|
| `ZapConfig` | `["config"]` | `owner`, `pauser`, `fee_bps` (≤ 30), `fee_sink` (USDC ATA), `usdc_mint`, `relayer_allowlist_on` |
| `BundleControls` | `["controls", bundle]` | `cap_usdc`, `tvl_usdc` (net in minus out, no oracle), `paused`, `closed` (a leg resolved; see Kalshi) |
| `Escrow` | `["escrow", bundle, buyer, nonce]` | `kind` (issue / redeem), `buyer`, `target_units`, `usdc_in`, `fee_taken`, `max_in[i]` per leg, `filled[i]` per leg, `deadline`, `state` (open / filled / done / cancelled), `bump` |
| escrow USDC ATA | ATA of escrow PDA | the buyer's cash while legs fill |
| escrow leg ATA × n | ATA of escrow PDA per leg mint (leg's own token program) | legs as they land |

Rent for the escrow and its ATAs is paid by whoever signs `open` and returned on `finish` or `cancel`. The relayer sponsors it for embedded-wallet users; that is what the SOL drip becomes.

## Instructions

### Buy

1. **`open_issue(bundle, target_units, usdc_in, max_in[], deadline)`** — buyer signs once. Checks `!paused`, `!closed`, `deadline ≤ now + 1h`, `Σ max_in ≤ usdc_in − fee`. Pulls `usdc_in` from the buyer. `fee = usdc_in × fee_bps / 10 000` goes to `fee_sink` now. Checks `tvl + (usdc_in − fee) ≤ cap`; adds it to `tvl`. Creates the escrow and its ATAs. Emits `Opened`.
2. **`fill(leg_index, route)`** — anyone (the relayer, or the buyer). One leg per transaction. The route is an opaque Jupiter `/swap-instructions` (or DFlow `/order`) instruction executed by CPI with the escrow PDA as `user_transfer_authority`, source = escrow USDC ATA, destination = escrow leg ATA. The program checks, before and after the CPI: the leg is not yet filled; USDC spent ≤ `max_in[i]`; the leg ATA's balance grew by ≥ `target_units × qty_per_unit[i]` (ExactOut; an ExactIn route may overshoot, the excess is dust returned at finish). Marks `filled[i]`. Emits `Filled`.
3. **`finish_issue()`** — anyone, once every `filled[i]` is set. Transfers each leg from the escrow ATAs to the buyer's leg ATAs would defeat the point, so instead the escrow PDA is the `buyer` of `bundle.issue` by CPI: legs move escrow → vaults, units mint to the escrow's unit ATA, then the escrow transfers the units to the buyer's unit ATA. Refunds leftover USDC and leg dust to the buyer. Closes the escrow and its ATAs, rent back to the opener. Emits `Issued`.
4. **`cancel_issue(route?)`** — anyone after `deadline`, or the buyer at any time before `finish`. For each filled leg, sells it back to USDC by the supplied route (same checks as `fill`, reversed); a leg whose route fails is returned to the buyer as tokens instead, never stranded. Refunds all USDC. `tvl −= (usdc_in − fee)`. The fee is not refunded (it paid for the attempt; Jon may set it to 0 at launch). Closes the escrow.

### Sell to cash

5. **`open_redeem(bundle, units, min_out[], deadline)`** — holder signs once; units move to the escrow's unit ATA. Escrow calls `bundle.redeem` by CPI immediately: legs land in the escrow leg ATAs. (Redeem is atomic on the bundle side; only the selling is spread out.)
6. **`unwind(leg_index, route)`** — anyone. Sells one leg escrow → USDC by CPI; checks proceeds ≥ `min_out[i]`.
7. **`finish_redeem()`** — anyone, once every leg is sold. `fee` on the proceeds to `fee_sink`, the rest to the holder's USDC ATA. `tvl −=` proceeds. Closes the escrow.
8. **`cancel_redeem()`** — after `deadline` or by the holder: unsold legs go to the holder as tokens, sold proceeds as USDC. The holder is never worse off than in-kind redemption.

A holder who wants the tokens calls `bundle.redeem` directly and never touches the Zap.

### Controls (owner unless noted)

`set_cap(bundle, usdc)`, `set_paused(bundle, bool)` (owner or pauser), `set_closed(bundle, bool)`, `set_fee_bps(≤ 30)`, `set_fee_sink`, `set_pauser`, `transfer_owner`. Pause blocks `open_issue` and `open_redeem`. It never blocks `fill`, `finish`, `cancel`, or `unwind`: an in-flight escrow holds a user's money and must always be able to complete or unwind.

## Why the design is transaction-agnostic

`open`, `fill × n`, and `finish` are separate instructions with no requirement to be in separate transactions. The client packs as many as fit: a two-leg crypto bundle with short routes fits `open + fill + fill + finish` in one transaction with Jupiter's lookup tables, and then the Robinhood-era promise holds. A five-leg stock bundle takes two to four transactions. Same program, same guarantees, no second code path. The ticket shows fill progress per leg either way.

## Decisions recorded

| # | Decision | Default | Why |
|---|---|---|---|
| 1 | Quote token | USDC (Circle native, `EPjF…Dt1v`) | what Jupiter routes and Privy's on-ramp deliver |
| 2 | Fees | `bundle` keeps 10 bps in units to the curator on issue and redeem (as coded); Zap `fee_bps` = 0 at launch | one fee, the curator's, protocol-enforced; the house takes its share through the curator/house split later. Jon can raise `fee_bps` without a deploy |
| 3 | Route type | opaque instruction, Jupiter or DFlow | the Zap v2 `bytes path` rule; the program checks balances, not venues |
| 4 | Sizing | ExactOut where the route supports it; ExactIn accepted, overshoot returned as dust | Jupiter ExactOut coverage is partial |
| 5 | Unit count | `finish` requires every leg ≥ `target_units × qty`, issues exactly `target_units` | deterministic, all-or-nothing on the target |
| 6 | Who cranks | permissionless; Bundlr runs a relayer; `relayer_allowlist_on` can restrict `fill` to an allowlist if griefing shows up | a stranger can only help an order complete or unwind on the buyer's own bounds |
| 7 | Rent | opener pays, refunded on close; relayer sponsors embedded-wallet users | about 0.002 SOL per ATA, six ATAs for a five-leg bundle |
| 8 | Deadline | ≤ 1 hour | matches the envelope expiry rule; a stale quote should not fill |
| 9 | Pause semantics | blocks opens only | never strand user funds |
| 10 | `bundle` program changes | none before audit | its issue/redeem already work with a PDA as buyer/holder, which is what the escrow needs |

## Kalshi legs

DFlow tokenizes every Kalshi market as YES and NO mints (Token-2022). A Kalshi leg fills through a DFlow `/order` instruction in `fill`, same balance check. Two rules the bundle program cannot know:

- **Resolution.** When a leg's market resolves, the owner (or a keeper watching DFlow) calls `set_closed(bundle, true)`: no new `open_issue`; `open_redeem` and in-kind `bundle.redeem` keep working, and the resolved outcome token redeems at $1 or $0 with DFlow. The pane says "closed · settling". A bundle with a resolved leg is not a live product, and the spec says so rather than pretending the leg can be replaced.
- **KYC.** DFlow trading requires KYC on the order. The relayer holds the DFlow key; a Kalshi leg fills only through the relayer, and the ticket says so. Until the production key lands (phase 7), Kalshi legs are paper.

## Token-2022 and transfer hooks

The vaults and escrow ATAs are created with each leg's own token program, so Token-2022 legs work as long as their transfer hook allows the PDA as a destination. To verify before mainnet: xStocks (Backed) hook behavior for program-owned destinations; Ondo GM requires whitelisted holders, so Ondo rows stay `gated · primary` until Ondo whitelists the vault and escrow PDAs; DFlow outcome mints.

## Testing

Jupiter and DFlow are not deployed on devnet. So:

- **Devnet** (phase 2, GitHub Actions): `bundle` program only, mock mints via `faucet`, `devnet/e2e.ts` create → issue → redeem. The Zap's escrow logic is tested there with a **mock router program** that moves tokens for a fixed price, standing in for Jupiter.
- **Mainnet fork** (`surfpool` or `solana-test-validator` with cloned Jupiter accounts): the real routes, at $100, $1 000, $10 000, on the launch bundles. This is the Foundry fork-test equivalent and the audit's test bed.
- The Zap v2 test list carries over: round trip; a bound breach reverts the fill and the order cancels clean; wrong recipe rejected; fee accounting; cap crossed reverts `open`; pause blocks opens only; refunds of dust; a leg that cannot be sold back is returned as tokens; a CPI that lands tokens in the wrong ATA is rejected; a second `finish` is a no-op.

## What it costs the user

A five-leg buy: one signature, two to four transactions cranked by the relayer, a few thousandths of a SOL in rent held and returned, priority fees paid by the relayer, and the Jupiter price impact per leg shown in the sourcing receipt before signing. Compared with Robinhood Chain: one signature instead of one transaction, and no bridge.

## Open before code

1. Confirm Jupiter's `shared_accounts_route` accepts a PDA `user_transfer_authority` by CPI with the current v6 program and that a single-leg CPI fits the 1 232-byte limit with lookup tables for the deepest xStocks routes.
2. Whether `finish_issue` should call `bundle.issue` with the escrow as buyer (as written) or transfer legs to the buyer first and have the buyer's delegate sign; the first keeps the buyer's wallet out of the fill path entirely and is preferred.
3. The fee default (decision 2) and the relayer allowlist (decision 6) are Jon's calls; the defaults above stand until he says otherwise.
