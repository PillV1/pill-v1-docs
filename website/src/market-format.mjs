export function compactUsd(value){return Number.isFinite(value)&&value>=0?new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',notation:'compact',maximumFractionDigits:2}).format(value):'—'}
export function tokenPrice(value){const n=Number(value);return Number.isFinite(n)&&n>0?n.toFixed(Math.min(12,Math.max(4,3-Math.floor(Math.log10(n))))).replace(/0+$/,'').replace(/\.$/,''):'—'}
export function normalizeCandles(rows){return rows.map(row=>{const bar={time:Number(row.time),open:Number(row.open),high:Number(row.high),low:Number(row.low),close:Number(row.close)};if(!Number.isSafeInteger(bar.time)||bar.time<0||[bar.open,bar.high,bar.low,bar.close].some(n=>!Number.isFinite(n)||n<=0)||bar.high<Math.max(bar.open,bar.close)||bar.low>Math.min(bar.open,bar.close)||bar.low>bar.high)throw Error('Invalid candle data');return {...bar,volume:Number(row.volumeLamports)/1e9}}).sort((a,b)=>a.time-b.time).filter((row,i,all)=>!i||row.time!==all[i-1].time)}

export function marketCapCandles(rows,supplyRaw,solUsd){
 const supply=Number(supplyRaw)/1e6,rate=Number(solUsd);
 if(!Number.isFinite(supply)||supply<=0||!Number.isFinite(rate)||rate<=0)throw Error('Market cap conversion unavailable');
 const multiplier=supply*rate;
 return normalizeCandles(rows).map(bar=>({...bar,open:bar.open*multiplier,high:bar.high*multiplier,low:bar.low*multiplier,close:bar.close*multiplier}));
}

export function supplyPercentage(balanceRaw,supplyRaw){try{const b=BigInt(balanceRaw),s=BigInt(supplyRaw);if(b<0n||s<=0n)return '—';if(b===0n)return '0%';const units=(b*1000000n+s/2n)/s;if(units===0n)return '<0.0001%';const whole=units/10000n,fraction=(units%10000n).toString().padStart(4,'0').replace(/0+$/,'');return whole.toString()+(fraction?'.'+fraction:'')+'%'}catch{return '—'}}
