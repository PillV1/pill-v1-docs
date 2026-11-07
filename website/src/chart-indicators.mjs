export function movingAverage(bars,period=20,exponential=false){
 if(!Number.isInteger(period)||period<1)throw new Error('Invalid indicator period');
 const output=[];let sum=0,ema=null;
 for(let i=0;i<bars.length;i++){
  sum+=bars[i].close;if(i>=period)sum-=bars[i-period].close;
  if(i<period-1)continue;
  ema=ema===null?sum/period:bars[i].close*(2/(period+1))+ema*(1-2/(period+1));
  output.push({time:bars[i].time,value:exponential?ema:sum/period});
 }
 return output;
}
