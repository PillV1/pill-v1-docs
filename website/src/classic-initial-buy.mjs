import {CLASSIC,quoteClassic,classicTradeInstruction} from '../vendor/sdk/classic.mjs';
export const classicInitialBuyMaximum=quoteClassic({sold:0n,quote:0n,side:'buy',tokens:CLASSIC.supply/100n}).walletLamports;
// The first purchase shares the creation transaction: a failed buy also rolls back creation.
export function classicInitialBuy({program,mint,owner,amount='0',slot=0n}){
 if(!/^(0|[1-9]\d*)$/.test(String(amount)))throw Error('Enter a valid initial buy amount.');
 const budget=BigInt(amount);if(!budget)return null;
 if(budget>classicInitialBuyMaximum)throw Error(`Classic initial buy is limited to 1% of supply (${Number(classicInitialBuyMaximum)/1e9} SOL including the platform fee). You can buy more in later slots.`);
 let lo=0n,hi=CLASSIC.supply/100n;
 while(lo<hi){const mid=(lo+hi+1n)/2n;if(quoteClassic({sold:0n,quote:0n,side:'buy',tokens:mid}).walletLamports<=budget)lo=mid;else hi=mid-1n;}
 if(!lo)throw Error('Initial buy amount is too small.');
 const quote=quoteClassic({sold:0n,quote:0n,side:'buy',tokens:lo});
 return {quote,instruction:classicTradeInstruction({program,mint,trader:owner,side:'buy',tokens:lo,limit:budget,deadlineSlot:BigInt(slot)+150n})};
}
