import {checkBuySlot} from './launch-protection.mjs';
import {PublicKey,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {addresses,blockedAddress,tradeInstruction} from './instructions.mjs';
import {decodeLaunch,decodePosition} from './accounts.mjs';
import {quoteTrade} from './quotes.mjs';
const SYSVAR_PROGRAM_ID=new PublicKey('Sysvar1111111111111111111111111111111111111');

// One RPC bank supplies the curve, owner's balance, block status and chain clock.
// No server receives a user's private key; this returns an unsigned instruction.
export async function prepareTrade({connection,program,mint,trader,expectedGenesis,side,amount,slippageBps=100,minContextSlot,appAuthority}) {
 if(typeof expectedGenesis!=='string'||!expectedGenesis)throw Error('genesis_required');
 if(await connection.getGenesisHash()!==expectedGenesis)throw Error('wrong_cluster');
 const owner=new PublicKey(trader),a=addresses(program,mint,owner);
 const response=await connection.getMultipleAccountsInfoAndContext([a.launch,a.position,blockedAddress(program,a.launch,owner),SYSVAR_CLOCK_PUBKEY],{commitment:'confirmed',...(minContextSlot===undefined?{}:{minContextSlot})});
 if(!Number.isSafeInteger(response.context?.slot)||!Array.isArray(response.value)||response.value.length!==4)throw Error('invalid_rpc_snapshot');
 const [launchAccount,positionAccount,blockedAccount,clock]=response.value;
 if(!clock||!new PublicKey(clock.owner).equals(SYSVAR_PROGRAM_ID)||clock.data.length!==40)throw Error('invalid_clock');
 const slot=clock.data.readBigUInt64LE(),unixTime=clock.data.readBigInt64LE(32);
 if(slot!==BigInt(response.context.slot))throw Error('inconsistent_rpc_clock');
 const launch=decodeLaunch({account:launchAccount,address:a.launch,program,mint});
 if(side==='buy'&&launch.args.appMode!=='any'){
  if(!appAuthority)throw Error('registered_app_signature_required');const selected=launch.args.appAuthorities.includes(new PublicKey(appAuthority).toBase58());
  if((launch.args.appMode==='only'&&!selected)||(launch.args.appMode==='exclude'&&selected))throw Error('app_blocked');
 }
 const position=decodePosition({account:positionAccount,address:a.position,program,mint,owner});
 const blocked=blockedAccount!==null&&new PublicKey(blockedAccount.owner).equals(new PublicKey(program));
 const quote=quoteTrade({launch,position,trader:owner.toBase58(),blocked,side,amount,slot,unixTime,slippageBps});
 if(side==='buy')checkBuySlot(launch,slot,quote.tokens,launch.args.supply);
 const instruction=tradeInstruction({program,mint,trader:owner,side,amount:quote.amount,minimum:quote.minimumOutput,deadlineSlot:quote.deadlineSlot,ticker:launch.args.ticker,appAuthority});
 return {quote,instruction,contextSlot:response.context.slot,commitment:'confirmed'};
}
