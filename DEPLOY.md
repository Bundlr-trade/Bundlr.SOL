# Deploying the bundle program

This repo holds one Solana program, `programs/bundle` (`create_bundle`, `issue`, `redeem`, and a devnet-only `faucet`). It compiles in GitHub Actions and has never been deployed to any network. The previous program address, `41NTbgRwNoyYUjSd9xCuf7Ny6ZUYgMxk6knq2Lpvy1RD`, belongs to a keypair the original author kept, so a new owner deploys under a fresh address of their own.

## What you need

- A machine with the [Solana CLI](https://docs.anza.xyz/cli/install) (only for making keypairs and checking balances; the build itself runs in GitHub Actions).
- The [GitHub CLI](https://cli.github.com/) logged in with admin rights on this repo, or the repo's Settings page.
- About 5 devnet SOL. Devnet SOL is free test money with no value.

## Steps

1. **Make two keypairs.** Keep both files out of the repo; `.keys/` is already gitignored.

   ```sh
   mkdir -p .keys
   solana-keygen new --no-bip39-passphrase -o .keys/program-keypair.json
   solana-keygen new --no-bip39-passphrase -o .keys/deployer-keypair.json
   solana-keygen pubkey .keys/program-keypair.json    # your program address
   solana-keygen pubkey .keys/deployer-keypair.json   # the wallet that pays for and controls the deploy
   ```

2. **Put your program address in the code.** Replace `41NTbgRwNoyYUjSd9xCuf7Ny6ZUYgMxk6knq2Lpvy1RD` with your program address in all three places:
   - `programs/bundle/src/lib.rs` — `declare_id!("…")`
   - `Anchor.toml` — `[programs.devnet] bundle = "…"`
   - `devnet/bundle-client.ts` — the fallback in `PROGRAM_ID`

   `idl/bundle.json` and `idl/bundle.ts` update themselves after the first successful deploy.

3. **Fund the deployer on devnet.** Use the web faucet at https://faucet.solana.com (sign in with GitHub for a higher limit) and send about 5 SOL to the deployer address. Check it with:

   ```sh
   solana balance <deployer address> --url devnet
   ```

   The workflow also tries the command-line faucet, but that one is often dry. If the deployer already holds 1.5 SOL or more, the workflow skips it.

4. **Add the keypairs as repo secrets.**

   ```sh
   gh secret set PROGRAM_KEYPAIR  -R <org>/<repo> < .keys/program-keypair.json
   gh secret set DEPLOYER_KEYPAIR -R <org>/<repo> < .keys/deployer-keypair.json
   ```

   Add both before step 5. Without them the run fails at the keypair step, before it builds anything.

5. **Push the address change to `main`.** Any push that touches `programs/**`, `Anchor.toml`, `Cargo.toml` or the workflow starts `.github/workflows/program.yml`. To re-run it without a change: `gh workflow run program.yml -R <org>/<repo>`, or Actions → program → Run workflow.

6. **Check the result.** The run takes about 10 minutes. Its summary page shows the program address, whether it deployed, and explorer links. After deploying, the same job creates mock stock tokens on devnet (`devnet/setup-mocks.ts`) and runs an end-to-end create → issue → redeem (`devnet/e2e.ts`). A green run with "Deployed this run: true" means the program works on devnet.

## Who controls the program

The deployer keypair becomes the program's **upgrade authority**. Whoever holds that file can replace the program's code. On devnet that's fine. Before mainnet, move upgrade authority to a multisig (for example Squads) or a hardware wallet:

```sh
solana program set-upgrade-authority <program address> --new-upgrade-authority <multisig address> --url <cluster>
```

## What is not here yet

- **The Zap.** Buying a bundle with cash means swapping USDC into every leg and then calling `issue`. That purchase program is designed in `docs/zap-escrow-spec-2026-09-24.md` and not built. `zap/quote-basket.ts` only produces live Jupiter quotes for a basket. Without the Zap, `issue` only works for someone who already holds every leg.
- **Mainnet.** Nothing in this repo has been reviewed for mainnet. Before real money: build the Zap, have both programs audited, set a real upgrade authority, and add a `[programs.mainnet]` entry to `Anchor.toml`. The leg tokens also have their own gates: Ondo Global Markets tokens need the program's vaults whitelisted by Ondo, and xStocks transfer hooks have to allow the vault addresses (see "Open questions" in `docs/bundle-program.md`).
- **Real leg tokens on devnet.** xStocks and Ondo have no devnet mints, so devnet runs use the program's `faucet` mocks.
