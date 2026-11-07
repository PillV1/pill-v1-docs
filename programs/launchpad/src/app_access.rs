//! Origin means a registered integration co-signature, never a browser header.
//! Restrictions apply only to curve buys; sells remain available.
use crate::*;
pub fn validate_policy(mode: u8, authorities: &[Pubkey]) -> Result<()> {
    require!(
        mode <= 2
            && authorities.len() <= 8
            && ((mode == 0 && authorities.is_empty()) || (mode != 0 && !authorities.is_empty())),
        LaunchError::Configuration
    );
    for (i, a) in authorities.iter().enumerate() {
        require!(
            *a != Pubkey::default() && !authorities[..i].contains(a),
            LaunchError::Configuration
        )
    }
    Ok(())
}
pub fn check(
    launch: &Account<Launch>,
    authority: &Option<Signer>,
    record: &Option<Account<RegisteredApp>>,
) -> Result<()> {
    let mode = launch.args.app_mode;
    if mode == 0 {
        return Ok(());
    }
    let signer = authority.as_ref().ok_or(LaunchError::Configuration)?;
    let app = record.as_ref().ok_or(LaunchError::Configuration)?;
    require_keys_eq!(app.authority, signer.key(), LaunchError::Configuration);
    let expected = Pubkey::find_program_address(&[b"app", signer.key().as_ref()], &crate::ID).0;
    require_keys_eq!(expected, app.key(), LaunchError::Configuration);
    let selected = launch.args.app_authorities.contains(&signer.key());
    require!(
        (mode == 1 && selected) || (mode == 2 && !selected),
        LaunchError::Blocked
    );
    Ok(())
}
pub fn register(ctx: Context<RegisterApp>, name: String) -> Result<()> {
    require!(
        !name.trim().is_empty() && name.len() <= 32 && !name.chars().any(char::is_control),
        LaunchError::Configuration
    );
    ctx.accounts.record.authority = ctx.accounts.app_authority.key();
    ctx.accounts.record.name = name;
    Ok(())
}
#[account]
#[derive(InitSpace)]
pub struct RegisteredApp {
    pub authority: Pubkey,
    #[max_len(32)]
    pub name: String,
}
#[derive(Accounts)]
pub struct RegisterApp<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(seeds=[b"config"],bump=config.bump,constraint=config.metadata_authority==operator.key())]
    pub config: Account<'info, Config>,
    pub app_authority: Signer<'info>,
    #[account(init,payer=operator,space=8+RegisteredApp::INIT_SPACE,seeds=[b"app",app_authority.key().as_ref()],bump)]
    pub record: Account<'info, RegisteredApp>,
    pub system_program: Program<'info, System>,
}
