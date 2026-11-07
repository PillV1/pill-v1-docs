import {checkBuySlot} from './launch-protection.mjs';
import {PublicKey,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {unpackAccount} from '@solana/spl-token';
import {integer} from './quotes.mjs';
import {CLASSIC,classicAddresses,decodeClassicLaunch,quoteClassic,classicTradeInstruction,collectClassicFeesInstruction} from './classic.mjs';
// Input buys are SOL budgets; the classic program executes exact-token orders.
export function quoteClassicBudget({launch,side,amount,slippageBps=100,slot}){
 if(!['buy','sell'].includes(side))throw Error('invalid_side');
 if(!Number.isInteger(slippageBps)||slippageBps<0||slippageBps>5000)throw Error('invalid_slippage');
 const n=integer(amount),deadlineSlot=integer(slot)+150n;
 if(!n||launch.graduated||launch.sold>=CLASSIC.saleTokens)throw Error('curve_closed_or_zero');
 let tokens=n;
 if(side==='buy'){
  // Reserve slippage within the entered budget, never above it.
  const budget=n*10000n/(10000n+BigInt(slippageBps));
  let lo=0n,hi=CLASSIC.saleTokens-launch.sold;
  while(lo<hi){const mid=(lo+hi+1n)/2n;const q=quoteClassic({...launch,side,tokens:mid});if(q.walletLamports<=budget)lo=mid;else hi=mid-1n;}
  tokens=lo;if(!tokens)throw Error('amount_too_small');
 }
 const q=quoteClassic({...launch,side,tokens});
 const limit=side==='buy'?n:q.walletLamports*(10000n-BigInt(slippageBps))/10000n;
 if(!limit)throw Error('amount_too_small');
 return {...q,version:'v1',side,amount:n,limit,minimumOutput:side==='buy'?tokens:limit,maximumInput:side==='buy'?limit:tokens,deadlineSlot};
}
export async function prepareClassicTrade({connection,program,mint,trader,expectedGenesis,side,amount,slippageBps=100}){
 if(!expectedGenesis||await connection.getGenesisHash()!==expectedGenesis)throw Error('wrong_cluster');
 const a=classicAddresses(program,mint,trader);
 const r=await connection.getMultipleAccountsInfoAndContext([a.launch,a.walletTokens,SYSVAR_CLOCK_PUBKEY],{commitment:'confirmed'});
 if(!Number.isSafeInteger(r.context?.slot)||r.value?.length!==3)throw Error('invalid_rpc_snapshot');
 const [account,tokens,clock]=r.value;
 if(!clock||new PublicKey(clock.owner).toBase58()!=='Sysvar1111111111111111111111111111111111111'||clock.data.length!==40||clock.data.readBigUInt64LE()!==BigInt(r.context.slot))throw Error('inconsistent_rpc_clock');
 const launch=decodeClassicLaunch({account,address:a.launch,program,mint});
 const quote=quoteClassicBudget({launch,side,amount,slippageBps,slot:BigInt(r.context.slot)});
 if(side==='buy')checkBuySlot(launch,BigInt(r.context.slot),quote.tokens,CLASSIC.supply);
 if(side==='sell'){
  if(!tokens)throw Error('insufficient_balance');
  const held=unpackAccount(a.walletTokens,tokens);
  if(!held.owner.equals(new PublicKey(trader))||!held.mint.equals(new PublicKey(mint))||held.amount<quote.tokens)throw Error('insufficient_balance');
 }
 return {collectionInstruction:collectClassicFeesInstruction({program,mint,treasury:launch.treasury}),quote,contextSlot:r.context.slot,instruction:classicTradeInstruction({program,mint,trader,side,tokens:quote.tokens,limit:quote.limit,deadlineSlot:quote.deadlineSlot})};
}
