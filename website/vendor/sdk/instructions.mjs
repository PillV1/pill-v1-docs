import {createHash} from 'node:crypto';
import {PublicKey,TransactionInstruction,SystemProgram,SYSVAR_RENT_PUBKEY} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,ASSOCIATED_TOKEN_PROGRAM_ID,NATIVE_MINT,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {integer,validateCurve} from './quotes.mjs';
export const PUMP_SWAP=new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
export const DEVELOPMENT_PROGRAM=new PublicKey('FretS4xrZsx8VHf7Aw8VbishTRskq3nbmpQKuyHbJxAz');
export const METADATA_PROGRAM=new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
export function metadataAddress(mint){return PublicKey.findProgramAddressSync([Buffer.from('metadata'),METADATA_PROGRAM.toBuffer(),new PublicKey(mint).toBuffer()],METADATA_PROGRAM)[0]}
export function metadataData(name,uri){
 if(typeof name!=='string'||!name.trim()||Buffer.byteLength(name)>32||/[\u0000-\u001f\u007f-\u009f]/u.test(name))throw Error('invalid_name');
 if(typeof uri!=='string'||Buffer.byteLength(uri)>200||/[\s\u0000-\u001f\u007f-\u009f]/u.test(uri)||! /^(https:\/\/|ipfs:\/\/|ar:\/\/).+/.test(uri))throw Error('invalid_metadata_uri');
 return Buffer.concat([name,uri].map(s=>{const b=Buffer.from(s),n=Buffer.alloc(4);n.writeUInt32LE(b.length);return Buffer.concat([n,b])}));
}
export function u64(value){const n=integer(value);const b=Buffer.alloc(8);b.writeBigUInt64LE(n);return b}
const key=x=>new PublicKey(x);
const meta=(pubkey,isWritable=false,isSigner=false)=>({pubkey:key(pubkey),isWritable,isSigner});
const discriminator=name=>createHash('sha256').update(`global:${name}`).digest().subarray(0,8);
const pda=(program,...seeds)=>PublicKey.findProgramAddressSync(seeds,program)[0];
export function addresses(program,mint,owner){program=key(program);mint=key(mint);const launch=pda(program,Buffer.from('launch'),mint.toBuffer());return{config:pda(program,Buffer.from('config')),launch,position:owner?pda(program,Buffer.from('position'),launch.toBuffer(),key(owner).toBuffer()):null,vault:getAssociatedTokenAddressSync(mint,launch,true),authority:pda(program,Buffer.from('migration'),launch.toBuffer())}}
export function blockedAddress(program,launch,wallet){return pda(key(program),Buffer.from('blocked'),key(launch).toBuffer(),key(wallet).toBuffer())}
function ix(program,name,keys,data=[]){return new TransactionInstruction({programId:key(program),keys,data:Buffer.concat([discriminator(name),...data])})}
export function appAddress(program,authority){return pda(key(program),Buffer.from('app'),key(authority).toBuffer())}
export function tradeInstruction({program,mint,trader,side,amount,minimum,deadlineSlot,ticker,appAuthority}){if(!['buy','sell'].includes(side))throw Error('invalid_side');const a=addresses(program,mint,trader);return ix(program,side,[meta(trader,true,true),meta(a.launch,true),meta(a.position,true),meta(blockedAddress(program,a.launch,trader)),meta(tickerAddress(program,ticker),true),meta(SystemProgram.programId),meta(appAuthority??program,false,!!appAuthority),meta(appAuthority?appAddress(program,appAuthority):program)],[u64(amount),u64(minimum),u64(deadlineSlot)])}
export function collectTreasuryInstruction({program,mint,treasury}){const a=addresses(program,mint);return ix(program,'collect_treasury',[meta(a.launch,true),meta(treasury,true)])}
export function claimInstruction({program,mint,owner}){mint=key(mint);const a=addresses(program,mint,owner);return ix(program,'claim',[meta(owner,true,true),meta(a.launch),meta(mint),meta(a.position,true),meta(a.vault,true),meta(getAssociatedTokenAddressSync(mint,key(owner)),true),meta(TOKEN_PROGRAM_ID),meta(ASSOCIATED_TOKEN_PROGRAM_ID),meta(SystemProgram.programId)])}
export function graduationAddresses(program,mint){mint=key(mint);const a=addresses(program,mint);const index=Buffer.from([1,0]);const pool=pda(PUMP_SWAP,Buffer.from('pool'),index,a.authority.toBuffer(),mint.toBuffer(),NATIVE_MINT.toBuffer());const lpMint=pda(PUMP_SWAP,Buffer.from('pool_lp_mint'),pool.toBuffer());return{...a,pool,lpMint,global:pda(PUMP_SWAP,Buffer.from('global_config')),eventAuthority:pda(PUMP_SWAP,Buffer.from('__event_authority')),userBase:getAssociatedTokenAddressSync(mint,a.authority,true),userQuote:getAssociatedTokenAddressSync(NATIVE_MINT,a.authority,true),userLp:getAssociatedTokenAddressSync(lpMint,a.authority,true,TOKEN_2022_PROGRAM_ID),poolBase:getAssociatedTokenAddressSync(mint,pool,true),poolQuote:getAssociatedTokenAddressSync(NATIVE_MINT,pool,true)}}
export function graduateInstruction({program,mint,keeper,ticker}){const a=graduationAddresses(program,mint);return ix(program,'graduate',[meta(keeper,true,true),meta(a.launch,true),meta(mint,true),meta(NATIVE_MINT),meta(a.vault,true),meta(a.authority,true),meta(a.userBase,true),meta(a.userQuote,true),meta(a.pool,true),meta(a.global),meta(a.lpMint,true),meta(a.userLp,true),meta(a.poolBase,true),meta(a.poolQuote,true),meta(a.eventAuthority),meta(PUMP_SWAP),meta(TOKEN_PROGRAM_ID),meta(TOKEN_2022_PROGRAM_ID),meta(ASSOCIATED_TOKEN_PROGRAM_ID),meta(SystemProgram.programId),meta(tickerAddress(program,ticker),true)])}
export function createLaunchInstruction({program,mint,creator,config}){
 validateCurve(config);
 const appModes={any:0,only:1,exclude:2},appMode=config.appMode??'any',appAuthorities=(config.appAuthorities??[]).map(x=>key(x).toBase58());
 if(!Object.hasOwn(appModes,appMode)||appAuthorities.length>8||new Set(appAuthorities).size!==appAuthorities.length||(appMode==='any')!==(appAuthorities.length===0)||appAuthorities.includes(SystemProgram.programId.toBase58()))throw Error('invalid_app_policy');
 const appCount=Buffer.alloc(4);appCount.writeUInt32LE(appAuthorities.length);
 const ticker=normalizeTicker(config.ticker),tickerBytes=Buffer.from(ticker),tickerLength=Buffer.alloc(4);tickerLength.writeUInt32LE(tickerBytes.length);
 const modes={burn:0,holders:1,liquidity:2,yap:3,creator:4};if(!Object.hasOwn(modes,config.feeMode))throw Error('unsupported_mode');if(!Array.isArray(config.blocked)||config.blocked.length>32)throw Error('invalid_blocklist');
 for(const field of ['quickBond','transfersOpen'])if(config[field]!==undefined&&typeof config[field]!=='boolean')throw Error('invalid_boolean');
 const developerBuy=integer(config.developerBuyLamports??'0');const developerNet=developerBuy-(developerBuy*250n+9999n)/10000n;
 if(developerBuy!==0n&&(developerNet===0n||developerNet>=integer(config.targetQuote)))throw Error('invalid_developer_buy');
 if(integer(config.virtualTokens)*developerNet/(integer(config.virtualQuote)+developerNet)>integer(config.supply)/100n)throw Error('developer_buy_slot_limit');
 if(developerBuy!==0n&&config.blocked.some(x=>key(x).equals(key(config.beneficiary??creator))))throw Error('developer_is_blocked');
 if(config.quickBond && config.transfersOpen)throw Error('quick_bond_disables_transfers');
 const count=config.extraBlockedCount??0;if(!Number.isInteger(count)||count<0||count>10000)throw Error('invalid_blocked_count');
 const countBytes=Buffer.alloc(2);countBytes.writeUInt16LE(count);
 const a=addresses(program,mint),length=Buffer.alloc(4);length.writeUInt32LE(config.blocked.length);
 const data=['supply','saleTokens','virtualTokens','virtualQuote','targetQuote','maxWalletBps','protectionSlots'].map(k=>u64(config[k]));data.push(Buffer.from([modes[config.feeMode]]),length,...config.blocked.map(x=>key(x).toBuffer()),Buffer.from([config.transfersOpen===true?1:0,config.quickBond===true?1:0]),countBytes,u64(config.developerBuyLamports??'0'),key(config.beneficiary??creator).toBuffer());
 return ix(program,'create_launch',[meta(creator,true,true),meta(a.config),meta(mint,true,true),meta(a.launch,true),meta(a.vault,true),meta(tickerAddress(program,ticker),true),meta(TOKEN_PROGRAM_ID),meta(ASSOCIATED_TOKEN_PROGRAM_ID),meta(SystemProgram.programId),meta(metadataAddress(mint),true),meta(METADATA_PROGRAM),meta(SYSVAR_RENT_PUBKEY)],[tickerLength,tickerBytes,...data,metadataData(config.name,config.uri),Buffer.from([appModes[appMode]]),appCount,...appAuthorities.map(x=>key(x).toBuffer())])
}
// Serializes unsigned instruction plans only. This SDK never loads or accesses a signer.
export function serializePlan(instructions){return instructions.map(i=>({program:i.programId.toBase58(),accounts:i.keys.map(k=>({address:k.pubkey.toBase58(),writable:k.isWritable,signer:k.isSigner})),dataBase64:i.data.toString('base64')}))}
export function claimRewardsInstruction({program,mint,owner}){const a=addresses(program,mint,owner);return ix(program,'claim_rewards',[meta(owner,true,true),meta(a.launch,true),meta(a.position,true)])}
export function burnFeesInstruction({program,mint,maxLamports,minTokens,deadlineSlot}){const a=addresses(program,mint);return ix(program,'burn_fees',[meta(a.launch,true),meta(mint,true),meta(a.vault,true),meta(TOKEN_PROGRAM_ID)],[u64(maxLamports),u64(minTokens),u64(deadlineSlot)])}

export function transferPositionInstruction({program,mint,owner,recipient,amount,deadlineSlot}) {
 if(key(owner).equals(key(recipient))) throw Error('self_transfer');
 const from=addresses(program,mint,owner),to=addresses(program,mint,recipient);
 return ix(program,'transfer_position',[meta(owner,true,true),meta(recipient),meta(from.launch,true),meta(from.position,true),meta(to.position,true),meta(blockedAddress(program,from.launch,owner)),meta(blockedAddress(program,from.launch,recipient)),meta(SystemProgram.programId)],[u64(amount),u64(deadlineSlot)]);
}

export function addBlockedWalletInstruction({program,mint,creator,wallet}) {
 const a=addresses(program,mint);
 return ix(program,'add_blocked_wallet',[meta(creator,true,true),meta(a.launch,true),meta(blockedAddress(program,a.launch,wallet),true),meta(SystemProgram.programId)],[key(wallet).toBuffer()]);
}

export function normalizeTicker(value){if(typeof value!=='string')throw Error('ticker_required');const ticker=value.trim().toUpperCase();if(!/^[A-Z0-9]{1,10}$/.test(ticker))throw Error('invalid_ticker');return ticker}
export function tickerAddress(program,ticker){return pda(key(program),Buffer.from('ticker'),Buffer.from(normalizeTicker(ticker)))}

export function executeDeveloperBuyInstruction({program,mint,creator,keeper,ticker,ensure=false}) {
 const a=addresses(program,mint,creator);
 return ix(program,ensure?'ensure_developer_buy':'execute_developer_buy',[meta(keeper,true,true),meta(a.launch,true),meta(a.position,true),meta(blockedAddress(program,a.launch,creator)),meta(tickerAddress(program,ticker),true),meta(SystemProgram.programId)]);
}

export function claimForInstruction({program,mint,owner,keeper}) {
 mint=key(mint);const a=addresses(program,mint,owner);
 return ix(program,'claim_for',[meta(keeper,true,true),meta(owner),meta(a.launch),meta(mint),meta(a.position,true),meta(a.vault,true),meta(getAssociatedTokenAddressSync(mint,key(owner)),true),meta(TOKEN_PROGRAM_ID),meta(ASSOCIATED_TOKEN_PROGRAM_ID),meta(SystemProgram.programId)]);
}
export function metadataProposalAddress(program,mint,owner,nonce){return pda(key(program),Buffer.from('rename'),addresses(program,mint).launch.toBuffer(),key(owner).toBuffer(),u64(nonce))}
export function proposeMetadataInstruction({program,mint,owner,nonce,name,uri,postGraduation=false}){
 const a=addresses(program,mint,owner),proposal=metadataProposalAddress(program,mint,owner,nonce);
 return ix(program,'propose_metadata',[meta(owner,true,true),meta(a.launch),meta(postGraduation?program:a.position),meta(postGraduation?getAssociatedTokenAddressSync(key(mint),key(owner)):program),meta(proposal,true),meta(SystemProgram.programId)],[u64(nonce),metadataData(name,uri)]);
}
export function likeMetadataInstruction({program,mint,owner,proposal,postGraduation=false}){
 const a=addresses(program,mint,owner),like=pda(key(program),Buffer.from('rename-like'),key(proposal).toBuffer(),key(owner).toBuffer());
 return ix(program,'like_metadata',[meta(owner,true,true),meta(a.launch),meta(postGraduation?program:a.position),meta(postGraduation?getAssociatedTokenAddressSync(key(mint),key(owner)):program),meta(proposal,true),meta(like,true),meta(SystemProgram.programId)]);
}
export function executeMetadataInstruction({program,mint,authority,proposal}){
 const a=addresses(program,mint);
 return ix(program,'execute_metadata',[meta(authority,false,true),meta(a.config),meta(a.launch),meta(proposal,true),meta(metadataAddress(mint),true),meta(METADATA_PROGRAM)]);
}

export function registerAppInstruction({program,operator,authority,name}){
 if(typeof name!=='string'||!name.trim()||Buffer.byteLength(name)>32||/[\u0000-\u001f\u007f]/.test(name))throw Error('invalid_app_name');
 const bytes=Buffer.from(name),length=Buffer.alloc(4);length.writeUInt32LE(bytes.length);
 return ix(program,'register_app',[meta(operator,true,true),meta(pda(key(program),Buffer.from('config'))),meta(authority,false,true),meta(appAddress(program,authority),true),meta(SystemProgram.programId)],[length,bytes]);
}

export function cancelLaunchInstruction({program,mint,launcher,ticker}){const a=addresses(program,mint);return ix(program,'cancel_launch',[meta(launcher,true,true),meta(a.launch,true),meta(mint,true),meta(a.vault,true),meta(tickerAddress(program,ticker),true),meta(TOKEN_PROGRAM_ID)])}

export function creatorVestingAddress(program,mint){return pda(key(program),Buffer.from('creator-vesting'),addresses(program,mint).launch.toBuffer())}
export function collectCreatorFeesInstruction({program,mint,creator}){return ix(program,'collect_creator_fees',[meta(addresses(program,mint).launch,true),meta(creator,true)])}
export function lockCreatorTokensInstruction({program,mint,creator,amount}){const a=addresses(program,mint,creator);return ix(program,'lock_creator_tokens',[meta(creator,true,true),meta(a.launch),meta(a.position,true),meta(creatorVestingAddress(program,mint),true),meta(SystemProgram.programId)],[u64(amount)])}
export function claimCreatorVestingInstruction({program,mint,creator}){const a=addresses(program,mint,creator);return ix(program,'claim_creator_vesting',[meta(creator,true,true),meta(a.launch),meta(creatorVestingAddress(program,mint),true),meta(mint),meta(a.vault,true),meta(getAssociatedTokenAddressSync(key(mint),key(creator)),true),meta(TOKEN_PROGRAM_ID),meta(ASSOCIATED_TOKEN_PROGRAM_ID),meta(SystemProgram.programId)])}
