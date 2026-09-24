//! Bundle program — the Solana settlement layer for Bundlr baskets.
//!
//! One bundle = one SPL mint (Token-2022, 6 decimals) whose mint authority is a
//! program-derived address. The PDA owns one associated token account per leg
//! (the vaults). `issue` moves `units × qty_per_unit` of every leg from the buyer
//! into the vaults and mints `units` to the buyer, in one instruction; `redeem`
//! burns units and releases the legs pro-rata. Ten bps each way is taken in
//! bundle units to the curator's fee account, so the vaults always back the
//! units outstanding exactly. NAV is what the vaults hold — no oracle.
//!
//! `faucet` exists for devnet only: mock legs whose mint authority is the
//! program's faucet PDA stand in for Backed's xStocks, which have no devnet mints.
//! The mainnet Zap (Jupiter swaps in front of `issue`) is off-chain; see
//! docs/bundle-program.md.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::get_associated_token_address_with_program_id,
    token_interface::{
        self, Burn, Mint, MintTo, TokenAccount, TokenInterface, TransferChecked,
    },
};

declare_id!("41NTbgRwNoyYUjSd9xCuf7Ny6ZUYgMxk6knq2Lpvy1RD");

pub const MAX_LEGS: usize = 9;
pub const UNIT: u128 = 1_000_000; // bundle mint decimals = 6
pub const FEE_BPS: u64 = 10;

#[program]
pub mod bundle {
    use super::*;

    /// Curator-signed. Creates the bundle mint (authority = bundle PDA) and
    /// records the recipe. Nothing is deposited here. `qty_per_unit` is in the
    /// leg's base units per one whole bundle unit — the library sizes a unit at
    /// $100 of basket on launch day (q_i = w_i / p0_i).
    pub fn create_bundle(
        ctx: Context<CreateBundle>,
        ticker: String,
        name: String,
        legs: Vec<LegInput>,
    ) -> Result<()> {
        require!(legs.len() >= 2 && legs.len() <= MAX_LEGS, BundleError::LegCount);
        require!(ticker.len() <= 8 && name.len() <= 48, BundleError::TooLong);
        let mut seen: Vec<Pubkey> = Vec::with_capacity(legs.len());
        for l in &legs {
            require!(l.qty_per_unit > 0, BundleError::ZeroQty);
            require!(!seen.contains(&l.mint), BundleError::DuplicateLeg);
            seen.push(l.mint);
        }
        let b = &mut ctx.accounts.bundle;
        b.curator = ctx.accounts.curator.key();
        b.mint = ctx.accounts.bundle_mint.key();
        b.ticker = ticker;
        b.name = name;
        b.legs = legs.into_iter().map(|l| Leg { mint: l.mint, qty_per_unit: l.qty_per_unit }).collect();
        b.fee_bps = FEE_BPS as u16;
        b.units_outstanding = 0;
        b.created_at = Clock::get()?.unix_timestamp;
        b.bump = ctx.bumps.bundle;
        emit!(BundleCreated { bundle: b.key(), mint: b.mint, curator: b.curator, legs: b.legs.len() as u8 });
        Ok(())
    }

    /// Cash-in, bundle-out's last instruction. The Zap's swaps (or, on devnet,
    /// `faucet`) have already put the legs in the buyer's token accounts.
    /// Remaining accounts, four per leg in recipe order:
    ///   leg_mint · buyer's leg ATA · vault (bundle PDA's ATA) · that leg's token program
    pub fn issue<'info>(ctx: Context<'_, '_, 'info, 'info, Issue<'info>>, units: u64) -> Result<()> {
        require!(units > 0, BundleError::ZeroUnits);
        let b = &ctx.accounts.bundle;
        let n = b.legs.len();
        require!(ctx.remaining_accounts.len() == n * 4, BundleError::LegAccounts);
        let bundle_key = b.key();

        for (i, leg) in b.legs.iter().enumerate() {
            let acc = &ctx.remaining_accounts[i * 4..i * 4 + 4];
            let (leg_mint, from, vault, tp) = (&acc[0], &acc[1], &acc[2], &acc[3]);
            require_keys_eq!(leg_mint.key(), leg.mint, BundleError::LegMismatch);
            let expected_vault = get_associated_token_address_with_program_id(&bundle_key, &leg.mint, tp.key);
            require_keys_eq!(vault.key(), expected_vault, BundleError::VaultMismatch);
            let decimals = mint_decimals(leg_mint)?;
            let amount = leg_amount(units, leg.qty_per_unit)?;
            token_interface::transfer_checked(
                CpiContext::new(
                    tp.to_account_info(),
                    TransferChecked {
                        from: from.to_account_info(),
                        mint: leg_mint.to_account_info(),
                        to: vault.to_account_info(),
                        authority: ctx.accounts.buyer.to_account_info(),
                    },
                ),
                amount,
                decimals,
            )?;
        }

        let fee = units * FEE_BPS / 10_000;
        let net = units - fee;
        let mint_key = b.mint;
        let signer: &[&[&[u8]]] = &[&[b"bundle", mint_key.as_ref(), &[b.bump]]];
        mint_units(&ctx.accounts, net, &ctx.accounts.buyer_units, signer)?;
        if fee > 0 { mint_units(&ctx.accounts, fee, &ctx.accounts.fee_units, signer)?; }

        let b = &mut ctx.accounts.bundle;
        b.units_outstanding = b.units_outstanding.checked_add(units).ok_or(BundleError::Overflow)?;
        emit!(Issued { bundle: b.key(), buyer: ctx.accounts.buyer.key(), units: net, fee });
        Ok(())
    }

    /// Burn units, take the underlying. Permissionless; this is the backing
    /// guarantee. The Zap's redeem-to-cash path appends Jupiter swaps after it.
    /// Remaining accounts as in `issue` (holder's leg ATA in slot 2).
    pub fn redeem<'info>(ctx: Context<'_, '_, 'info, 'info, Redeem<'info>>, units: u64) -> Result<()> {
        require!(units > 0, BundleError::ZeroUnits);
        let b = &ctx.accounts.bundle;
        let n = b.legs.len();
        require!(ctx.remaining_accounts.len() == n * 4, BundleError::LegAccounts);
        let fee = units * FEE_BPS / 10_000;
        let net = units - fee;
        let bundle_key = b.key();
        let mint_key = b.mint;
        let bump = b.bump;

        token_interface::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.bundle_mint.to_account_info(),
                    from: ctx.accounts.holder_units.to_account_info(),
                    authority: ctx.accounts.holder.to_account_info(),
                },
            ),
            units,
        )?;
        let signer: &[&[&[u8]]] = &[&[b"bundle", mint_key.as_ref(), &[bump]]];
        if fee > 0 { mint_units_r(&ctx.accounts, fee, signer)?; }

        for (i, leg) in b.legs.iter().enumerate() {
            let acc = &ctx.remaining_accounts[i * 4..i * 4 + 4];
            let (leg_mint, to, vault, tp) = (&acc[0], &acc[1], &acc[2], &acc[3]);
            require_keys_eq!(leg_mint.key(), leg.mint, BundleError::LegMismatch);
            let expected_vault = get_associated_token_address_with_program_id(&bundle_key, &leg.mint, tp.key);
            require_keys_eq!(vault.key(), expected_vault, BundleError::VaultMismatch);
            let decimals = mint_decimals(leg_mint)?;
            let amount = leg_amount(net, leg.qty_per_unit)?;
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    tp.to_account_info(),
                    TransferChecked {
                        from: vault.to_account_info(),
                        mint: leg_mint.to_account_info(),
                        to: to.to_account_info(),
                        authority: ctx.accounts.bundle.to_account_info(),
                    },
                    signer,
                ),
                amount,
                decimals,
            )?;
        }

        let b = &mut ctx.accounts.bundle;
        b.units_outstanding = b.units_outstanding.checked_sub(net).ok_or(BundleError::Overflow)?;
        emit!(Redeemed { bundle: b.key(), holder: ctx.accounts.holder.key(), units: net, fee });
        Ok(())
    }

    /// Devnet only. Mints `amount` of a mock leg whose mint authority is the
    /// faucet PDA. Stands in for the Jupiter Zap where no real xStocks exist.
    pub fn faucet(ctx: Context<Faucet>, amount: u64) -> Result<()> {
        require!(amount > 0 && amount <= 1_000_000_000_000_000, BundleError::ZeroUnits);
        let signer: &[&[&[u8]]] = &[&[b"faucet", &[ctx.bumps.faucet]]];
        token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.to.to_account_info(),
                    authority: ctx.accounts.faucet.to_account_info(),
                },
                signer,
            ),
            amount,
        )
    }
}

fn leg_amount(units: u64, qty_per_unit: u64) -> Result<u64> {
    let v = (units as u128) * (qty_per_unit as u128) / UNIT;
    u64::try_from(v).map_err(|_| error!(BundleError::Overflow))
}

fn mint_decimals(mint: &AccountInfo) -> Result<u8> {
    let data = mint.try_borrow_data()?;
    require!(data.len() >= 82, BundleError::LegMismatch);
    Ok(data[44])
}

fn mint_units<'info>(a: &Issue<'info>, amount: u64, to: &InterfaceAccount<'info, TokenAccount>, signer: &[&[&[u8]]]) -> Result<()> {
    token_interface::mint_to(
        CpiContext::new_with_signer(
            a.token_program.to_account_info(),
            MintTo { mint: a.bundle_mint.to_account_info(), to: to.to_account_info(), authority: a.bundle.to_account_info() },
            signer,
        ),
        amount,
    )
}
fn mint_units_r<'info>(a: &Redeem<'info>, amount: u64, signer: &[&[&[u8]]]) -> Result<()> {
    token_interface::mint_to(
        CpiContext::new_with_signer(
            a.token_program.to_account_info(),
            MintTo { mint: a.bundle_mint.to_account_info(), to: a.fee_units.to_account_info(), authority: a.bundle.to_account_info() },
            signer,
        ),
        amount,
    )
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct LegInput { pub mint: Pubkey, pub qty_per_unit: u64 }

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct Leg { pub mint: Pubkey, pub qty_per_unit: u64 }

#[account]
#[derive(InitSpace)]
pub struct Bundle {
    pub curator: Pubkey,
    pub mint: Pubkey,
    #[max_len(8)]
    pub ticker: String,
    #[max_len(48)]
    pub name: String,
    #[max_len(9)]
    pub legs: Vec<Leg>,
    pub fee_bps: u16,
    pub units_outstanding: u64,
    pub created_at: i64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct CreateBundle<'info> {
    #[account(mut)]
    pub curator: Signer<'info>,
    #[account(
        init, payer = curator,
        mint::decimals = 6, mint::authority = bundle, mint::freeze_authority = bundle,
        mint::token_program = token_program,
    )]
    pub bundle_mint: InterfaceAccount<'info, Mint>,
    #[account(init, payer = curator, space = 8 + Bundle::INIT_SPACE, seeds = [b"bundle", bundle_mint.key().as_ref()], bump)]
    pub bundle: Account<'info, Bundle>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Issue<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(mut, seeds = [b"bundle", bundle_mint.key().as_ref()], bump = bundle.bump)]
    pub bundle: Account<'info, Bundle>,
    #[account(mut, address = bundle.mint)]
    pub bundle_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = bundle_mint, token::authority = buyer)]
    pub buyer_units: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = bundle_mint, token::authority = bundle.curator)]
    pub fee_units: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(mut)]
    pub holder: Signer<'info>,
    #[account(mut, seeds = [b"bundle", bundle_mint.key().as_ref()], bump = bundle.bump)]
    pub bundle: Account<'info, Bundle>,
    #[account(mut, address = bundle.mint)]
    pub bundle_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = bundle_mint, token::authority = holder)]
    pub holder_units: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = bundle_mint, token::authority = bundle.curator)]
    pub fee_units: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Faucet<'info> {
    pub user: Signer<'info>,
    /// CHECK: PDA signer only; seeds checked here.
    #[account(seeds = [b"faucet"], bump)]
    pub faucet: UncheckedAccount<'info>,
    #[account(mut, mint::authority = faucet)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint)]
    pub to: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[event] pub struct BundleCreated { pub bundle: Pubkey, pub mint: Pubkey, pub curator: Pubkey, pub legs: u8 }
#[event] pub struct Issued { pub bundle: Pubkey, pub buyer: Pubkey, pub units: u64, pub fee: u64 }
#[event] pub struct Redeemed { pub bundle: Pubkey, pub holder: Pubkey, pub units: u64, pub fee: u64 }

#[error_code]
pub enum BundleError {
    #[msg("a bundle is 2 to 9 legs")] LegCount,
    #[msg("ticker over 8 or name over 48 chars")] TooLong,
    #[msg("qty_per_unit must be > 0")] ZeroQty,
    #[msg("duplicate leg mint")] DuplicateLeg,
    #[msg("units must be > 0")] ZeroUnits,
    #[msg("pass four accounts per leg, in recipe order")] LegAccounts,
    #[msg("leg mint does not match the recipe")] LegMismatch,
    #[msg("vault is not the bundle's ATA for this leg")] VaultMismatch,
    #[msg("arithmetic overflow")] Overflow,
}
