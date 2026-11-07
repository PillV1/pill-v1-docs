const MAX=18446744073709551615n;
export function integer(value){
 if(typeof value!=='bigint' && (typeof value!=='string'||!/^(0|[1-9][0-9]*)$/.test(value)))throw Error('use_unsigned_decimal_string_or_bigint');
 const n=BigInt(value);if(n<0n||n>MAX)throw Error('u64_out_of_range');return n;
}
const check=n=>{if(n<0n||n>MAX)throw Error('arithmetic_overflow');return n};
const ceil=(a,b,c)=>check((a*b+c-1n)/c);
const floor=(a,b,c)=>check(a*b/c);
function timestamp(value){if(typeof value!=='bigint'&&(typeof value!=='string'||! /^-?(0|[1-9][0-9]*)$/.test(value)))throw Error('invalid_timestamp');const n=BigInt(value);if(n<-(1n<<63n)||n>=(1n<<63n))throw Error('invalid_timestamp');return n}
export function validateCurve(args){
 const c={};for(const k of ['supply','saleTokens','virtualTokens','virtualQuote','targetQuote','maxWalletBps','protectionSlots'])c[k]=integer(args[k]);
 if(c.supply!==1000000000000000n||c.saleTokens===0n||c.saleTokens>=c.supply||c.virtualTokens<=c.saleTokens||c.virtualQuote===0n||c.targetQuote<=50000000n||c.maxWalletBps<50n||c.maxWalletBps>400n||c.protectionSlots<1n||c.protectionSlots>4n)throw Error('invalid_curve_config');
 const maxQuote=ceil(c.virtualQuote,c.saleTokens,c.virtualTokens-c.saleTokens);
 if(c.targetQuote>=maxQuote)throw Error('invalid_curve_target');
 const sold=floor(c.virtualTokens,c.targetQuote,check(c.virtualQuote+c.targetQuote));
 const poolTokens=floor(c.targetQuote,c.virtualTokens-sold,c.virtualQuote+c.targetQuote);
 const initialTokens=floor(c.targetQuote-50000000n,c.virtualTokens-sold,c.virtualQuote+c.targetQuote);
 if(initialTokens===0n||poolTokens===0n||poolTokens>c.supply-c.saleTokens)throw Error('insufficient_liquidity_allocation');return c;
}
// A quote is a bound for an unsigned instruction, not a promise of execution.
// Callers must supply an authenticated, consistent RPC snapshot, including block status.
export function quoteTrade({launch,position,trader,blocked,side,amount,slot,unixTime,slippageBps=100,deadlineSlots=150}) {
 if(typeof blocked!=='boolean')throw Error('block_status_required');
 if(!['buy','sell'].includes(side))throw Error('invalid_side');
 if(!Number.isInteger(slippageBps)||slippageBps<0||slippageBps>5000)throw Error('invalid_slippage');
 if(!Number.isInteger(deadlineSlots)||deadlineSlots<1||deadlineSlots>150)throw Error('invalid_deadline');
 const c=validateCurve(launch.args),n=integer(amount),s=integer(slot),now=timestamp(unixTime),start=integer(launch.startSlot),sold=integer(launch.sold),quote=integer(launch.quote);
 if(n===0n)throw Error('zero_amount');
 if(launch.randomnessReady!==true)throw Error('not_activated');
 if(launch.graduated||quote>=c.targetQuote||s<start)throw Error('curve_closed');
 if(sold>c.saleTokens)throw Error('invalid_curve_state');
 if(launch.blockedUploaded!==launch.args.extraBlockedCount)throw Error('not_activated');
 if(blocked||launch.args.blocked.includes(trader))throw Error('wallet_blocked');
 if(position.owner!==trader)throw Error('position_owner_mismatch');
 const held=integer(position.balance),rate=s-start<c.protectionSlots?9900n:250n;
 let gross,net,tokens,fee;
 if(side==='buy'){
  if(!launch.developerExecuted&&rate===250n)throw Error('developer_allocation_pending');
  gross=n;fee=ceil(gross,rate,10000n);net=gross-fee;
  if(net===0n||net>c.targetQuote-quote)throw Error('insufficient_reserves');
  tokens=floor(c.virtualTokens-sold,net,check(check(c.virtualQuote+quote)+net));
  if(check(held+tokens)>floor(c.supply,c.maxWalletBps,10000n))throw Error('wallet_cap');
  if(check(sold+tokens)>c.saleTokens)throw Error('insufficient_reserves');
  if(!launch.developerExecuted){const budget=integer(launch.developerBudget),reserved=budget-ceil(budget,250n,10000n);if(quote+net+reserved>c.targetQuote)throw Error('developer_capacity_reserved')}
 }else{
  if(launch.args.quickBond&&now<timestamp(launch.createdAt)+3600n)throw Error('quick_bond_sell_locked');
  tokens=n;const locked=now<timestamp(position.unlockAt)?integer(position.locked):0n;
  if(tokens>held||tokens>sold)throw Error('insufficient_balance');
  if(tokens>(held>locked?held-locked:0n))throw Error('developer_tokens_locked');
  gross=floor(check(c.virtualQuote+quote),tokens,check(c.virtualTokens-sold+tokens));
  if(gross===0n||gross>quote)throw Error('insufficient_reserves');
  fee=ceil(gross,rate,10000n);net=gross-fee;
 }
 if(tokens===0n||net===0n)throw Error('zero_output');
 const output=side==='buy'?tokens:net;
 // Never serialize a zero minimum, even for small integer outputs.
 const minimum=output*BigInt(10000-slippageBps)/10000n;
 return {side,amount:n,expectedOutput:output,minimumOutput:minimum>0n?minimum:1n,tokens,grossLamports:gross,netLamports:net,feeLamports:fee,feeBps:rate,treasuryFeeLamports:ceil(gross,220n,10000n),coinFeeLamports:rate===9900n?0n:fee-ceil(gross,220n,10000n),sniperBurnLamports:rate===9900n?fee-ceil(gross,220n,10000n):0n,slot:s,deadlineSlot:check(s+BigInt(deadlineSlots)),sequence:integer(launch.sequence)};
}
