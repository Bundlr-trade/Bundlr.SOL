# Site fork plan — bundlr.trade on Solana

**Status:** plan, not started. Written 2026-09-24 for the Stocklana submission (Fri Sept 25, 4:00 PM ET).
**Scope:** fork the deployed bundlr.trade app (`Projects/bundlr-frontend` + `Projects/bundlr-api`) into this repo and make it run on Solana. Supersedes nothing; `docs/stocklana-technical-walkthrough.md` is the recording script and stays valid either way.
**Rule carried over:** this repo is public and a hackathon fork. Nothing flows back into the Robinhood Chain product, and nothing private (keys, float wallets, PostHog tokens, Robinhood testnet addresses) goes in.

## 1. What the fork is

bundlr.trade today = a Vite/React app (105 source files, `src/v3/` is the product) + a Bun/Hono/sqlite API (`bundlr-api`, one shared store so everyone sees the same Market) + a registry artifact exported from curator-studio. The chain touches exactly four places: the wallet layer (Privy → wagmi), the money path (`src/v3/chain/`, Robinhood testnet BundleZapV3), the API's signature check (viem `verifyMessage`) and testnet writer, and the registry's `rail` rows. Everything else — Market, desks, bundle pane, Finder + bench, Portfolio, Library, plate, terms, feeds orchestration, NAV math — is chain-agnostic and copies as is.

The Solana registry here (`library/registry/registry.json`, 3,671 rows) is already in the curator-studio row schema plus three extra fields (`jup`, `premium`, `pxSrc`), so the site's registry loader takes it with one export-script change.

## 2. Layout after the fork

```
bundlr-solana/
  site/      ← copy of bundlr-frontend (src, public, scripts, vite/tsconfig/package). Drop: src/pages/{Owner,Admin,OptionsChain,HowItWorks,Manifesto}, src/components/options, src/config/wagmi.ts, vercel.json
  api/       ← copy of bundlr-api. Drop: src/testnet/, src/routes/{gas,testnet}.ts, src/sanctions.ts (EVM RPC screen)
  library/   ← unchanged (the standalone finder stays as the no-server demo)
  program/   ← unchanged Anchor source
  zap/       ← quote-basket.ts becomes an API route (see §4.5)
```

One repo, one GitHub link for the judges. `site/` and `api/` each keep their own `package.json`.

## 3. What changes, by layer

### 3.1 Registry (2h)
- `curator-studio/registry/export-site.ts` takes `--registry <path> --out <dir>`; run it against `library/registry/registry.json` → `site/public/registry/`. Logos come from `library/tile-assets/`; the emoji word index is extracted from `library/library-finder.html` the same way it is from the mock today.
- `pxKey` (`site/src/v3/store/prices.ts:14`) keys prices by `cg || yf || clob`. Kalshi rows carry `kid`, not `clob`; add `kid`. Stock rows with a mint should key by `addr` so the Jupiter feed can land on them.
- `lint.ts:109` hard-codes predictions → "Polygon". Predictions here are DFlow Token-2022 on Solana; the chain note becomes "on-chain legs settle on Solana" for every leg. Test in `src/v3/test/lint.test.ts` changes with it.
- `types.ts` `ChainInfo` (Robinhood testnet twin) stays as a type but is always null until §4.5 tier 2.

### 3.2 Feeds (2h)
| Feed | Today | Solana fork |
|---|---|---|
| coingecko, coinbase (crypto) | CoinGecko via API relay + Coinbase ws | unchanged |
| quotes (commodities, FX) | `library-quotes` relay | unchanged |
| stocks | Yahoo relay via `GET /stocks`, 30s | **Jupiter Price v3** via a new `api/src/relays/jupiter.ts` (`GET /jupiter?ids=<mints>`), keyed by mint; `stockData.price` gives the underlying so the pane can print the premium. Rows without a mint (Ondo primary, futures) keep the nightly price. |
| polymarket (predictions) | CLOB midpoints REST + websocket (~2,900 books, batched in `batch.ts`) | **Kalshi** through the existing `library-kalshi?lib=solana` relay on j0n.zo.space, polled every 20s, no websocket. `feeds/polymarket.ts` → `feeds/kalshi.ts`; `batch.ts` stays but idles. |

Uncertainty: Jupiter Price v3 rate limits at ~1,200 mints per refresh. Batch by 100, refresh 60s, and accept that thin xStocks lag a minute. If it throttles, stocks fall back to registry prices (static, labelled).

### 3.3 Identity (2h)
- Privy already ships Solana embedded wallets (`@privy-io/react-auth/solana`; `@solana/kit` is in its deps). New Privy app with Solana enabled and the fork's origins allowed; `VITE_PRIVY_APP_ID` swaps. Plate flow (email → 6-digit code → wallet made silently → signed `enter`) is the same code path with `useSignMessage` from the Solana entry point. "Use my own wallet" side door = Phantom via wallet-standard.
- `src/lib/connect.tsx`, `src/providers/web3.tsx`, `Gate.tsx`, `Plate.tsx`, `Bench.tsx`, `WalletPill.tsx`, `Search.tsx`, `access.ts`: replace the wagmi hooks (13 import sites). Addresses are base58, never lower-cased, never `0x`.
- `api/src/auth.ts`: viem `verifyMessage` → ed25519 verify (`tweetnacl` or `@noble/ed25519`), signature base58. Keep envelope v1 only; v2's `chainId 46630` line has no Solana meaning and nothing signs v2 yet. Nonce route unchanged. `privy.ts` token check unchanged.

### 3.4 API instance (1.5h)
- New Zo service `bundlr-sol-api` from `api/`, own sqlite (`BUNDLR_DB_PATH`), `BUNDLR_REGISTRY_PATH` → this repo's registry, `BUNDLR_HOUSE_PATH` → `api/data/house.json` rewritten for Solana, `TESTNET_BOT=off`, no gas float key. `VITE_BUNDLR_API` in the site points at it.
- `house.json`: 15 house bundles, legs keyed `s:` `q:` `x:` `k:` `c:` `f:`. `q:` legs are Polymarket questions and have to be re-pointed at Kalshi markets (`p:`/`k:` keys per `registry.ts:35`); `s:` tickers resolve only if the ticker is an xStock or Ondo row. Jon picks which house bundles survive; the ones with SpaceX / private-market `x:` legs may not.
- `routes/bundles.ts` stops making a chain twin on list; `bundle.chain` is null, the dock reads "not on chain" until §4.5.
- `geo.ts`: the restricted list mirrors Robinhood's. xStocks and Ondo GM exclude **US persons**; the fork's list and the Terms page must say that plainly, or the site is dishonest about who can hold a leg. Decision for Jon (§6).

### 3.5 Copy sweep (1h)
28 files mention Robinhood / testnet / test dollars (list: `grep -rln "Robinhood\|46630\|testnet" src`). Replace "we launch on Robinhood Chain" → "we launch on Solana", never "on top of" anyone. Footers: "test dollars · no real money · 10 bps each way" stays true under §4.5 tier 0/1. Terms: pause/redeem language rewritten for the program's `redeem` (pro-rata vault). Prerender script's canonical base URL and `robots.txt` → the fork's host.

### 3.6 Hosting (1h)
Publish `site/` as a Zo Site (fastest today, custom domain `sol.bundlr.trade` when Jon wants it; Amplify from a monorepo subdir is the slower equivalent). `api/` as a Zo service. Run `scripts/walk/walk.mjs` against the published URL with the plate bypass; adjust the one check that expects a real ticket in the dock.

## 4. The money path — pick a tier

### 4.5 Tiers
- **Tier 0 — paper + live sourcing receipt (3h, certain).** Restore the paper ticket deleted in bundlr-frontend commit `9ff7feb` (buy/redeem through the API's `holdings` routes, which still exist). The dock shows the Zap's live Jupiter receipt: `zap/quote-basket.ts` becomes `GET /quote?legs=TSLA:2,NVDA:1&cash=1000` and the ticket prints route, fill quantity, price impact, 10 bps per leg before the paper buy lands. Every screen says test dollars. This is exactly the honesty posture bundlr.trade has today.
- **Tier 1 — devnet program, mock legs (3h+, no guarantee).** The Anchor program is written, never compiled: `program/target` has no `.so`, no IDL, `anchor` on this box fails on glibc 2.38/2.39, there is no `cargo`, `rustc` or `solana` CLI, and the deployer key has no SOL. The realistic build path is a GitHub Actions job in this repo (Solana + Anchor toolchain image) that builds, airdrops devnet SOL to a CI keypair, deploys, and commits the IDL + program ID. Then `devnet/setup-mocks.ts` (faucet mints for each leg) and `e2e.ts` run for the first time, and `useChainBundle.ts` is rewritten on `devnet/bundle-client.ts` (create_bundle / issue / redeem, vault reads). "Test dollars" = faucet mocks. Run this in parallel with tier 0; wire it in only if it lands by Friday noon.
- **Tier 2 — real legs on mainnet through Jupiter swaps.** Not for Friday.

Recommendation: tier 0 as the submission, tier 1 as a parallel track that upgrades the dock if it works.

## 5. Sequence (about 13h of work, two tracks)

| # | Track A — the app | hrs | Track B — devnet program | hrs |
|---|---|---|---|---|
| 1 | Copy `site/` + `api/`, delete dead pages, stub wagmi, `npm run build` green | 1 | GitHub Actions build workflow, CI keypair, airdrop | 1.5 |
| 2 | Registry export + `pxKey` + lint | 2 | Deploy, commit IDL/program ID, run `setup-mocks.ts`, `e2e.ts` | 1.5 |
| 3 | Feeds: Jupiter relay, Kalshi poller | 2 | `useChainBundle` on `bundle-client.ts` (only if 1–2 land) | 2 |
| 4 | Privy Solana + ed25519 verify; API instance + house.json | 3.5 | | |
| 5 | Paper ticket + Jupiter receipt in the dock | 2 | | |
| 6 | Copy sweep, publish, walk robot, README/AGENTS update | 2 | | |

Order matters: 1 → 2 → 3 unblock the front page; 4 unblocks list/buy; 5 and 6 close. Track B never blocks Track A.

## 6. Decisions for Jon

1. **Money path:** tier 0 ship + tier 1 parallel (recommended), or tier 1 or bust.
2. **US-person gate:** xStocks/Ondo exclude US persons. Show the red geo bar to US visitors with paper trading open under it (like today), or say nothing and let Terms carry it?
3. **House bundles:** which of the 15 survive on Solana; `q:` Polymarket legs need Kalshi equivalents, `x:` private-market legs have no rail.
4. **Host and name:** Zo Site at a `*.zocomputer.io` URL for the submission, or `sol.bundlr.trade` today.
5. **Repo shape:** `site/` + `api/` inside Bundlr.SOL (recommended, one judge link) vs. a second repo.

## 7. Risks
- Jupiter Price v3 throttling on ~1,200 mints → stocks go static; labelled, not broken.
- Privy Solana embedded-wallet signing path untested by us; fallback is Phantom-only sign-in, which loses the email flow.
- Kalshi relay is a j0n.zo.space route, not in this repo; the public repo must say so (it already does in AGENTS.md).
- Toolchain for the program is fully absent locally; CI is the only credible build path before Friday.
- Public repo hygiene: no `.env`, no PostHog token, new Privy app ID only.
