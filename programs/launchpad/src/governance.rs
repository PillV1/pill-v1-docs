//! Holder proposals and advisory likes, with a fixed moderator and public delay.
//! This deliberately does not misrepresent likes as stake-weighted governance.
use crate::*;
use anchor_spl::metadata::{update_metadata_accounts_v2, UpdateMetadataAccountsV2};
pub const RENAME_DELAY: i64 = 86_400;
pub const PROPOSAL_LIFETIME: i64 = 604_800;

fn holder(
    owner: Pubkey,
    launch: &Account<Launch>,
    position: &Option<Account<Position>>,
    tokens: &Option<Account<TokenAccount>>,
) -> Result<()> {
    let receipt = position
        .as_ref()
        .is_some_and(|p| p.owner == owner && p.launch == launch.key() && p.balance > 0);
    let wallet = launch.graduated
        && tokens
            .as_ref()
            .is_some_and(|t| t.owner == owner && t.mint == launch.mint && t.amount > 0);
    require!(receipt || wallet, LaunchError::Configuration);
    Ok(())
}
pub fn propose(ctx: Context<ProposeMetadata>, nonce: u64, name: String, uri: String) -> Result<()> {
    validate_metadata(&name, &uri)?;
    holder(
        ctx.accounts.owner.key(),
        &ctx.accounts.launch,
        &ctx.accounts.position,
        &ctx.accounts.tokens,
    )?;
    let now = Clock::get()?.unix_timestamp;
    let p = &mut ctx.accounts.proposal;
    p.launch = ctx.accounts.launch.key();
    p.proposer = ctx.accounts.owner.key();
    p.nonce = nonce;
    p.name = name;
    p.uri = uri;
    p.created_at = now;
    p.likes = 0;
    p.executed = false;
    emit!(MetadataProposed {
        launch: p.launch,
        proposal: p.key(),
        proposer: p.proposer
    });
    Ok(())
}
pub fn like(ctx: Context<LikeMetadata>) -> Result<()> {
    holder(
        ctx.accounts.owner.key(),
        &ctx.accounts.launch,
        &ctx.accounts.position,
        &ctx.accounts.tokens,
    )?;
    let p = &mut ctx.accounts.proposal;
    require!(
        !p.executed
            && Clock::get()?.unix_timestamp
                <= p.created_at
                    .checked_add(PROPOSAL_LIFETIME)
                    .ok_or(LaunchError::Arithmetic)?,
        LaunchError::Expired
    );
    p.likes = p.likes.checked_add(1).ok_or(LaunchError::Arithmetic)?;
    ctx.accounts.like.owner = ctx.accounts.owner.key();
    ctx.accounts.like.proposal = p.key();
    emit!(MetadataLiked {
        launch: p.launch,
        proposal: p.key(),
        owner: ctx.accounts.owner.key()
    });
    Ok(())
}
pub fn execute(ctx: Context<ExecuteMetadata>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let p = &mut ctx.accounts.proposal;
    require!(
        !p.executed
            && p.likes > 0
            && now
                >= p.created_at
                    .checked_add(RENAME_DELAY)
                    .ok_or(LaunchError::Arithmetic)?
            && now
                <= p.created_at
                    .checked_add(PROPOSAL_LIFETIME)
                    .ok_or(LaunchError::Arithmetic)?,
        LaunchError::Locked
    );
    let l = &ctx.accounts.launch;
    let bump = [l.bump];
    let seeds: &[&[u8]] = &[b"launch", l.mint.as_ref(), &bump];
    update_metadata_accounts_v2(
        CpiContext::new_with_signer(
            ctx.accounts.metadata_program.to_account_info(),
            UpdateMetadataAccountsV2 {
                metadata: ctx.accounts.metadata.to_account_info(),
                update_authority: l.to_account_info(),
            },
            &[seeds],
        ),
        None,
        Some(DataV2 {
            name: p.name.clone(),
            symbol: l.args.ticker.clone(),
            uri: p.uri.clone(),
            seller_fee_basis_points: 0,
            creators: None,
            collection: None,
            uses: None,
        }),
        None,
        None,
    )?;
    p.executed = true;
    emit!(TokenMetadataPublished {
        launch: l.key(),
        name: p.name.clone(),
        symbol: l.args.ticker.clone(),
        uri: p.uri.clone()
    });
    emit!(MetadataUpdated {
        launch: l.key(),
        proposal: p.key()
    });
    Ok(())
}
#[account]
#[derive(InitSpace)]
pub struct MetadataProposal {
    pub launch: Pubkey,
    pub proposer: Pubkey,
    pub nonce: u64,
    #[max_len(32)]
    pub name: String,
    #[max_len(200)]
    pub uri: String,
    pub created_at: i64,
    pub likes: u64,
    pub executed: bool,
}
#[account]
#[derive(InitSpace)]
pub struct MetadataLike {
    pub owner: Pubkey,
    pub proposal: Pubkey,
}
#[derive(Accounts)]
#[instruction(nonce:u64)]
pub struct ProposeMetadata<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds=[b"launch",launch.mint.as_ref()],bump=launch.bump)]
    pub launch: Account<'info, Launch>,
    pub position: Option<Account<'info, Position>>,
    pub tokens: Option<Account<'info, TokenAccount>>,
    #[account(init,payer=owner,space=8+MetadataProposal::INIT_SPACE,seeds=[b"rename",launch.key().as_ref(),owner.key().as_ref(),&nonce.to_le_bytes()],bump)]
    pub proposal: Account<'info, MetadataProposal>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct LikeMetadata<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds=[b"launch",launch.mint.as_ref()],bump=launch.bump)]
    pub launch: Account<'info, Launch>,
    pub position: Option<Account<'info, Position>>,
    pub tokens: Option<Account<'info, TokenAccount>>,
    #[account(mut,has_one=launch)]
    pub proposal: Account<'info, MetadataProposal>,
    #[account(init,payer=owner,space=8+MetadataLike::INIT_SPACE,seeds=[b"rename-like",proposal.key().as_ref(),owner.key().as_ref()],bump)]
    pub like: Account<'info, MetadataLike>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct ExecuteMetadata<'info> {
    pub authority: Signer<'info>,
    #[account(seeds=[b"config"],bump=config.bump,constraint=config.metadata_authority==authority.key())]
    pub config: Account<'info, Config>,
    #[account(seeds=[b"launch",launch.mint.as_ref()],bump=launch.bump)]
    pub launch: Account<'info, Launch>,
    #[account(mut,has_one=launch)]
    pub proposal: Account<'info, MetadataProposal>,
    /// CHECK: canonical account updated only through the fixed Metaplex program.
    #[account(mut,seeds=[b"metadata",metadata::ID.as_ref(),launch.mint.as_ref()],bump,seeds::program=metadata::ID)]
    pub metadata: UncheckedAccount<'info>,
    pub metadata_program: Program<'info, Metadata>,
}
#[event]
pub struct MetadataProposed {
    pub launch: Pubkey,
    pub proposal: Pubkey,
    pub proposer: Pubkey,
}
#[event]
pub struct MetadataLiked {
    pub launch: Pubkey,
    pub proposal: Pubkey,
    pub owner: Pubkey,
}
#[event]
pub struct MetadataUpdated {
    pub launch: Pubkey,
    pub proposal: Pubkey,
}
