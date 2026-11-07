import {activateInstruction,ORAO} from '../../sdk/src/activation.mjs';
import {executeDeveloperBuyInstruction} from '../../sdk/src/instructions.mjs';
import {CLASSIC,classicAddresses,decodeClassicLaunch,graduateClassicInstruction,collectClassicFeesInstruction} from '../../sdk/src/classic.mjs';
import {PublicKey,SYSVAR_CLOCK_PUBKEY,Transaction,ComputeBudgetProgram} from '@solana/web3.js';
import {poolSettlementInstruction} from '../../sdk/src/pool-settlement.mjs';
import {createHash} from 'node:crypto';
import {addresses,collectTreasuryInstruction,graduateInstruction,burnFeesInstruction,claimForInstruction} from '../../sdk/src/instructions.mjs';
import {decodeLaunch,decodePosition} from '../../sdk/src/accounts.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes){let n=BigInt('0x'+Buffer.from(bytes).toString('hex')),s='';while(n){s=alphabet[Number(n%58n)]+s;n/=58n}for(const b of bytes){if(b!==0)break;s='1'+s}return s}
export function maintenanceKinds(launch,position,unixTime){
 const kinds=[];if(launch.cancelled)return kinds;
 if(launch.version==='v1'){if(launch.fees>=10000n)kinds.push('keeper_treasury');if(!launch.graduated&&launch.sold===CLASSIC.saleTokens)kinds.push('keeper_graduate');return kinds;}
 if(launch.treasuryFees>=10000n)kinds.push('keeper_treasury');
 if(!launch.randomnessReady){if(launch.activationRequested&&launch.blockedUploaded===launch.args.extraBlockedCount)kinds.push('keeper_activate');return kinds;}
 if(!launch.developerExecuted){kinds.push('keeper_developer_buy');return kinds;}
 if(launch.graduated){if(launch.sniperFees>=10000n||['burn','liquidity'].includes(launch.args.feeMode)&&launch.coinFees>=10000n)kinds.push('keeper_pool_fees');if(position?.balance>0n&&unixTime>=position.unlockAt)kinds.push('keeper_developer_claim');return kinds}
 if(launch.quote>=launch.args.targetQuote){kinds.push('keeper_graduate');return kinds}
 const budget=launch.sniperFees>0n?launch.sniperFees:launch.args.feeMode==='burn'?launch.coinFees:0n;
 if(budget>=10000n)kinds.push('keeper_burn');return kinds;
}
export async function maintenanceSnapshot(connection,program,mint){
 const address=addresses(program,mint).launch,result=await connection.getMultipleAccountsInfoAndContext([address,SYSVAR_CLOCK_PUBKEY,classicAddresses(program,mint).launch],{commitment:'finalized'});
 const [account,clock]=result.value;
 if(!clock||!new PublicKey(clock.owner).equals(new PublicKey('Sysvar1111111111111111111111111111111111111'))||clock.data.length!==40||clock.data.readBigUInt64LE()!==BigInt(result.context.slot))throw Error('invalid_clock_snapshot');
 if(account&&result.value[2])throw Error('ambiguous_launch_version');
 if(!account){const launch=decodeClassicLaunch({account:result.value[2],address:classicAddresses(program,mint).launch,program,mint});return {launch,slot:BigInt(result.context.slot),unixTime:clock.data.readBigInt64LE(32)};}
 const launch=decodeLaunch({account,address,program,mint});let position;
 if(launch.graduated){const pa=addresses(program,mint,launch.creator).position;position=decodePosition({account:await connection.getAccountInfo(pa,'finalized'),address:pa,program,mint,owner:launch.creator})}
 return {launch,position,slot:BigInt(result.context.slot),unixTime:clock.data.readBigInt64LE(32)};
}
export function maintenanceInstruction({kind,program,mint,keeper,launch,position,slot,unixTime}){
 if(!['keeper_treasury','keeper_graduate','keeper_developer_claim','keeper_burn','keeper_activate','keeper_developer_buy'].includes(kind))throw Error('unsupported_maintenance');
 if(!maintenanceKinds(launch,position,unixTime).includes(kind))return null;
 if(launch.version==='v1'){if(kind==='keeper_treasury')return collectClassicFeesInstruction({program,mint,treasury:launch.treasury});if(kind==='keeper_graduate')return graduateClassicInstruction({program,mint,keeper});throw Error('unsupported_maintenance');}
 if(kind==='keeper_activate')return activateInstruction({program,mint,payer:keeper,randomness:launch.randomnessRequest,ticker:launch.args.ticker});
 if(kind==='keeper_developer_buy'){if(slot<launch.startSlot+launch.args.protectionSlots)return null;return executeDeveloperBuyInstruction({program,mint,creator:launch.creator,keeper,ticker:launch.args.ticker,ensure:true});}
 if(kind==='keeper_treasury')return collectTreasuryInstruction({program,mint,treasury:launch.treasury});
 if(kind==='keeper_graduate')return graduateInstruction({program,mint,keeper,ticker:launch.args.ticker});
 if(kind==='keeper_developer_claim')return claimForInstruction({program,mint,keeper,owner:launch.creator});
 if(kind==='keeper_burn'){
  const available=launch.sniperFees>0n?launch.sniperFees:launch.coinFees;
  const quote=[available,launch.args.targetQuote-launch.quote,100000000n].reduce((a,b)=>a<b?a:b);
  const tokens=(launch.args.virtualTokens-launch.sold)*quote/(launch.args.virtualQuote+launch.quote+quote);
  if(tokens===0n||tokens>launch.args.saleTokens-launch.sold)return null;
  const minimum=tokens*99n/100n;
  return burnFeesInstruction({program,mint,maxLamports:quote,minTokens:minimum>0n?minimum:1n,deadlineSlot:slot+20n});
 }
 throw Error('unsupported_maintenance');
}
export async function signedEnvelope(connection,signer,instruction){
 const latest=await connection.getLatestBlockhash('confirmed'),tx=new Transaction({feePayer:signer.publicKey,recentBlockhash:latest.blockhash}).add(...(Array.isArray(instruction)?instruction:[instruction]));tx.sign(signer);const wire=tx.serialize();if(wire.length>1232)throw Error('transaction_too_large');
 return {wire_transaction:wire.toString('base64'),wire_hash:hash(wire),message_hash:hash(tx.serializeMessage()),signature:base58(tx.signature),last_valid_height:latest.lastValidBlockHeight};
}
export function maintenanceBuilder({connection,program,genesis,signer}){
 return async job=>{
  if(await connection.getGenesisHash()!==genesis)throw Error('wrong_cluster');
  const body=typeof job.body==='string'?JSON.parse(job.body):job.body,mint=new PublicKey(body.mint);
  const snapshot=await maintenanceSnapshot(connection,program,mint);
  if(job.kind==='keeper_activate'&&!snapshot.launch.randomnessReady){const account=await connection.getAccountInfo(new PublicKey(snapshot.launch.randomnessRequest),'finalized');const data=account&&Buffer.from(account.data),tag=createHash('sha256').update('account:RandomnessV2').digest().subarray(0,8);if(!account||!account.owner.equals(ORAO)||!data.subarray(0,8).equals(tag))throw Error('invalid_randomness_account');if(data[8]===0)return {deferred:'oracle_fulfillment',retryAfter:5};if(data[8]!==1||data.length<137||!data.subarray(73,137).some(v=>v!==0))throw Error('invalid_randomness_result');}
  if(job.kind==='keeper_developer_buy'&&!snapshot.launch.developerExecuted&&snapshot.slot<snapshot.launch.startSlot+snapshot.launch.args.protectionSlots)return {deferred:'protection_window',retryAfter:2};
  const instruction=job.kind==='keeper_pool_fees'?(maintenanceKinds(snapshot.launch,snapshot.position,snapshot.unixTime).includes(job.kind)?await poolSettlementInstruction({connection,program,mint,operator:signer.publicKey,launch:snapshot.launch}):null):maintenanceInstruction({kind:job.kind,program,mint,keeper:signer.publicKey,...snapshot});
  if(!instruction)return {noop:'maintenance_already_satisfied'};
  return signedEnvelope(connection,signer,['keeper_pool_fees','keeper_graduate'].includes(job.kind)?[ComputeBudgetProgram.setComputeUnitLimit({units:600000}),instruction]:instruction);
 };
}
