import {validateWalletResponse} from './wallet-response.mjs';
import {confirmTrade} from './trade-status.mjs';
import {Connection,PublicKey,Transaction,ComputeBudgetProgram} from '@solana/web3.js';
import {NATIVE_MINT,TOKEN_2022_PROGRAM_ID} from '@solana/spl-token';
import {PUMP_SDK,OnlinePumpSdk,PUMP_PROGRAM_ID,bondingCurvePda,getBuyTokenAmountFromSolAmount,getSellSolAmountFromTokenAmount} from '@pump-fun/pump-sdk';
import {generateVanityMint} from './vanity-mint.mjs';
import {base58} from './base58.mjs';
const signers=new Map(),preparedTrades=new WeakSet();
const mainnet='5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
async function online(config){if(!config.nativePumpEnabled||config.genesis!==mainnet)throw Error('Native Pump launches are not enabled.');const rpc=new Connection(config.rpcUrl,'confirmed');if(await rpc.getGenesisHash()!==mainnet)throw Error('Wrong Solana network.');return {rpc,sdk:new OnlinePumpSdk(rpc)}}
function enabled(global){if(!global.createV2Enabled||!global.isHolderRewardEnabled)throw Error('Pump has temporarily disabled Holder Rewards launches. No funds were sent.')}
export async function buildNativeCreate({global,feeConfig,mint,owner,config}){
 enabled(global);const BN=global.initialVirtualSolReserves.constructor,user=new PublicKey(owner),budget=new BN(config.developerBuyLamports),params={global,mint:new PublicKey(mint),user,creator:user,name:config.name,symbol:config.ticker,uri:config.uri,mayhemMode:false,cashback:false,holderReward:true};
 if(budget.isZero())return [await PUMP_SDK.createV2Instruction(params)];
 const quotedBudget=budget.muln(100).divn(101);
 const amount=getBuyTokenAmountFromSolAmount({global,feeConfig,mintSupply:null,bondingCurve:null,amount:quotedBudget,quoteMint:NATIVE_MINT});
 if(amount.isZero())throw Error('Initial buy is too small.');
 return PUMP_SDK.createV2AndBuyInstructions({...params,amount,solAmount:quotedBudget});
}
export async function prepareDirectLaunch(config,payload,owner,options={}){
 if(payload.owner!==owner||payload.config.beneficiary!==owner)throw Error('Launch wallet changed.');
 const status=await fetch('/api/launch/native/status',{credentials:'same-origin'});if(!status.ok||!(await status.json()).enabled)throw Error('Native Holder Rewards service is unavailable. No funds were sent.');
 const {sdk}=await online(config),[global,feeConfig]=await Promise.all([sdk.fetchGlobal(),sdk.fetchFeeConfig()]);enabled(global);
 const mint=await generateVanityMint(options),record={route:'native-pump',version:1,owner,program:PUMP_PROGRAM_ID.toBase58(),genesis:mainnet,mint:mint.publicKey.toBase58(),payload,step:0,stageCount:1,blockedCount:0,oracleFeeLamports:'0',history:[],pending:null,createdAt:Date.now()};
 const combined=await buildNativeCreate({global,feeConfig,mint:mint.publicKey,owner,config:payload.config});
 try{new Transaction({feePayer:new PublicKey(owner),recentBlockhash:PublicKey.default.toBase58()}).add(ComputeBudgetProgram.setComputeUnitLimit({units:500000}),...combined).serialize({requireAllSignatures:false})}catch(error){if(BigInt(payload.config.developerBuyLamports)===0n)throw error;record.splitBuy=true;record.stageCount=2}
 signers.set(record.mint,mint);return record;
}
function identity(config,record,owner){if(record.route!=='native-pump'||record.program!==PUMP_PROGRAM_ID.toBase58()||record.genesis!==mainnet||config.genesis!==mainnet||record.owner!==owner)throw Error('Launch wallet or deployment changed.')}
async function register(record){const response=await fetch('/api/launch/native/register',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({mint:record.mint,signature:record.pending.signature})});if(!response.ok)throw Error('Launch finalized. Reconnect and check status to finish indexing; do not launch again.');return response.json()}
export async function reconcileDirectLaunch(config,record,owner,persist){
 identity(config,record,owner);if(!record.pending)return record;
 const {rpc}=await online(config),{value}=await rpc.getSignatureStatuses([record.pending.signature],{searchTransactionHistory:true}),status=value[0];if(status?.confirmationStatus!=='finalized')return record;
 if(!status.err){if(record.pending.kind==='create_launch'){await register(record);signers.delete(record.mint)}record.step++}else record.failure='The transaction failed on chain. Review before retrying.';
 record.history.push({...record.pending,state:status.err?'failed':'finalized'});record.pending=null;persist(record);return record;
}
export async function advanceDirectLaunch(config,record,provider,persist){
 identity(config,record,provider.publicKey?.toBase58());if(record.pending){await reconcileDirectLaunch(config,record,record.owner,persist);return {done:record.step>=record.stageCount,waiting:record.pending?'Waiting for finality or indexing. Do not launch again.':null}}if(record.step>=record.stageCount)return {done:true};if(record.failure)throw Error(record.failure);
 const mint=signers.get(record.mint);if(record.step===0&&!mint)throw Error('Unsigned mint draft expired. Review a new launch; no transaction was sent.');
 const {rpc,sdk}=await online(config),[global,feeConfig]=await Promise.all([sdk.fetchGlobal(),sdk.fetchFeeConfig()]);
 let tx,latest;
 if(record.step===1&&record.splitBuy){const prepared=await prepareTrade(config,{mint:record.mint,owner:record.owner,side:'buy',amount:record.payload.config.developerBuyLamports,slippageBps:100});tx=Transaction.from(Buffer.from(prepared.transaction,'base64'));latest={blockhash:prepared.blockhash,lastValidBlockHeight:prepared.lastValidBlockHeight}}else{const instructions=await buildNativeCreate({global,feeConfig,mint:mint.publicKey,owner:record.owner,config:{...record.payload.config,...(record.splitBuy?{developerBuyLamports:'0'}:{})}});latest=await rpc.getLatestBlockhash('confirmed');tx=new Transaction({feePayer:provider.publicKey,recentBlockhash:latest.blockhash}).add(ComputeBudgetProgram.setComputeUnitLimit({units:500000}),...instructions);tx.partialSign(mint)}
 // Check wire size before requesting a wallet signature.
 tx.serialize({requireAllSignatures:false});
 const message=Uint8Array.from(tx.serializeMessage()),signed=validateWalletResponse(message,await provider.signTransaction(tx));
 const wire=signed.serialize(),signature=base58(signed.signature);record.pending={signature,wire:wire.toString('base64'),blockhash:latest.blockhash,lastValidBlockHeight:latest.lastValidBlockHeight,kind:record.step===0?'create_launch':'initial_buy'};persist(record);
 try{const sent=await rpc.sendRawTransaction(wire,{skipPreflight:false,maxRetries:2});if(sent!==signature)throw Error('Unexpected signature');await rpc.confirmTransaction({signature,...latest},'finalized')}catch{return {waiting:'Submission pending or uncertain. Check this saved signature before trying again.'}}
 await reconcileDirectLaunch(config,record,record.owner,persist);return {done:record.step>=record.stageCount};
}
export async function prepareTrade(config,{mint,owner,side,amount,slippageBps}){
 if(!['buy','sell'].includes(side)||!/^\d+$/.test(amount)||BigInt(amount)<=0n||!Number.isInteger(slippageBps)||slippageBps<0||slippageBps>1000)throw Error('Invalid trade amount or slippage.');
 const {rpc,sdk}=await online(config),user=new PublicKey(owner),key=new PublicKey(mint),[global,feeConfig,state]=await Promise.all([sdk.fetchGlobal(),sdk.fetchFeeConfig(),sdk.fetchBuyState(key,user,TOKEN_2022_PROGRAM_ID)]),curve=state.bondingCurve;
 if(!curve.isHolderReward||curve.isCashbackCoin||curve.complete||!state.quoteMint.equals(NATIVE_MINT))throw Error('This is not an active SOL Holder Rewards curve.');
 const BN=global.initialVirtualSolReserves.constructor,input=new BN(amount),params={global,feeConfig,mintSupply:curve.tokenTotalSupply,bondingCurve:curve,amount:input,quoteMint:NATIVE_MINT};
 const tokens=side==='buy'?getBuyTokenAmountFromSolAmount(params).muln(10000-slippageBps).divn(10000):input;
 if(tokens.isZero())throw Error('Trade amount is too small.');
 const sol=side==='buy'?input:getSellSolAmountFromTokenAmount(params);
 const common={global,...state,mint:key,user,amount:tokens,solAmount:sol,slippage:side==='buy'?0:slippageBps/100,tokenProgram:TOKEN_2022_PROGRAM_ID,mayhemMode:false,cashback:false};
 const instructions=await PUMP_SDK[side==='buy'?'buyInstructions':'sellInstructions'](common),latest=await rpc.getLatestBlockhash('confirmed'),tx=new Transaction({feePayer:user,recentBlockhash:latest.blockhash}).add(ComputeBudgetProgram.setComputeUnitLimit({units:300000}),...instructions);
 const prepared={nativePump:true,transaction:tx.serialize({requireAllSignatures:false}).toString('base64'),...latest,quote:{venue:'Pump native Holder Rewards',side,input:amount,inputUnit:side==='buy'?'lamports':'raw token units',minimumOutput:side==='buy'?tokens.toString():sol.muln(10000-slippageBps).divn(10000).toString(),slippageBps}};preparedTrades.add(prepared);return prepared;
}
export async function sendPrepared(provider,prepared,config,onSigned){
 if(!preparedTrades.has(prepared))throw Error('Native trade must be prepared on this device.');const {rpc}=await online(config);if(!(await rpc.isBlockhashValid(prepared.blockhash,{commitment:'confirmed'})).value)throw Error('Quote expired.');const tx=Transaction.from(Buffer.from(prepared.transaction,'base64'));if(!tx.feePayer.equals(provider.publicKey))throw Error('Wallet changed.');
 const message=Uint8Array.from(tx.serializeMessage()),signed=validateWalletResponse(message,await provider.signTransaction(tx));const wire=signed.serialize(),signature=base58(signed.signature);preparedTrades.delete(prepared);onSigned?.({signature,blockhash:prepared.blockhash,lastValidBlockHeight:prepared.lastValidBlockHeight});const returned=await rpc.sendRawTransaction(wire,{skipPreflight:false,maxRetries:2});if(returned!==signature)throw Error('Unexpected signature');return {signature,confirm:()=>confirmTrade(rpc,{signature,blockhash:prepared.blockhash,lastValidBlockHeight:prepared.lastValidBlockHeight})};
}
