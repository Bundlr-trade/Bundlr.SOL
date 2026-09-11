# bundlr-solana — Project Guide

Solana port of the Bundlr library (curated baskets of tokenized stocks, gold, crypto, T-bills and Kalshi outcome tokens), built 2026-09-11 for Stocklana, the Solana Foundation one-week stocks hackathon (Sept 11 – 18, 2026, hackathons.solana.com/hackathons/stocklana); Colosseum has said Stocklana submissions are also eligible for Crypto World's Fair prizes (deadline Oct 12). Sibling of `Projects/bundlr` (strategy home; read its `AGENTS.md` for product rules — cash path, fee language, copy SOP, never "sit on top of" anyone). This repo is public on GitHub as `Bundlr-trade/Bundlr.SOL`; nothing private goes in it. It is a hackathon fork: nothing here flows back into the Robinhood Chain product (`Projects/bundlr`, `bundlr-frontend`, `app_MVP`).

## Layout

- `library/library-finder.html` — the self-contained finder mock (registry + logos inlined). Open from disk. Ported from `Projects/bundlr/curator-studio/library-finder-mock.html` with the chain layer swapped: Jupiter marks, Kalshi odds via the `library-kalshi?lib=solana` relay, Solscan links, Token-2022 facts on the preview and bundle page.
- `library/registry/` — `build-registry.ts` (Solana-first sources), `rails.json` (one chain, aliases, class rules), `settleable.ts` (RPC mint check + Jupiter depth), the chain-agnostic resolvers copied from curator-studio, `inline.ts`, `registry.json` (source of truth) / `registry.js` (mirror the mock reads), `rails-report.md`.
- `zap/quote-basket.ts` — the Zap's read side: live Jupiter sourcing receipt for a basket, optional unsigned swap instructions with `--user`.
- `docs/solana-equivalents.md` — the EVM → Solana mapping table, one row per dependency. `docs/bundle-program.md` — Anchor program design (not deployed).

## Rebuild order

```
bun library/registry/build-registry.ts        # ~5 min: CoinGecko paced, Kalshi pages, Jupiter prices
cd library && bun registry/resolve-links.ts   # cwd-relative scripts: run from library/
cd library && bun registry/resolve-wiki.ts && bun registry/resolve-wiki-repair.ts && bun registry/resolve-crypto-desc.ts
bun library/registry/resolve-wikidata.ts && bun library/registry/resolve-near.ts
bun library/registry/settleable.ts            # RPC + Jupiter quotes; --only T1,T2 or --max-quotes N to bound it
bun library/registry/inline.ts
```
`--predictions-only` on build-registry splices fresh Kalshi rows without refetching stocks.

## Rules carried over

- Live data only; never hand-type a mint address (CoinGecko platform map or issuer docs, then `settleable.ts` re-reads it on-chain).
- Copy: contents and the bet first, one joke max, last. No "in kind", no "expense ratio" (say annual fee), no "sits on top of".
- Relays on `j0n.zo.space` (`library-kalshi`, `library-draft`, `library-quotes`, `library-history`) accept `?lib=solana` where they read a registry file; they are Jon's Zo space routes, not part of this repo.

## Honest gaps (2026-09-11)

DFlow yes/no mint addresses need a production API key (dev host did not resolve from the build box) — prediction rails are `tokenizable`, not verified mints. Bundle program is a design doc. Ondo GM rows are `gated · primary` because Jupiter has no route for them.
