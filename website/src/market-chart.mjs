import {movingAverage} from './chart-indicators.mjs';
import {createChart,CandlestickSeries,HistogramSeries,LineSeries} from './lightweight-charts.mjs';
import {marketCapCandles,compactUsd} from './market-format.mjs';
let active=null;
const drawingSessions=new Map();
export function destroyChart(){if(active){active.cleanup?.();active.chart.remove();active=null}}
export function updateChart(element,rows,key,supplyRaw,solUsd){
 const bars=marketCapCandles(rows,supplyRaw,solUsd);if(!bars.length)return false;
 if(!active||active.element!==element||active.key!==key){destroyChart();element.replaceChildren();const chart=createChart(element,{autoSize:true,layout:{background:{color:'#171b26'},textColor:'#aeb4c3',fontSize:11,attributionLogo:true},grid:{vertLines:{color:'#ffffff06'},horzLines:{color:'#ffffff09'}},rightPriceScale:{borderColor:'#363b4c',scaleMargins:{top:.15,bottom:.25}},timeScale:{borderColor:'#363b4c',timeVisible:true,secondsVisible:false,rightOffset:5,barSpacing:12},crosshair:{mode:0}});
 const price=chart.addSeries(CandlestickSeries,{upColor:'#26a69a',downColor:'#ef5350',wickUpColor:'#26a69a',wickDownColor:'#ef5350',borderVisible:false,autoscaleInfoProvider:base=>{const info=base();if(info&&info.priceRange.maxValue-info.priceRange.minValue<info.priceRange.maxValue*.005){const mid=(info.priceRange.maxValue+info.priceRange.minValue)/2;info.priceRange={minValue:mid*.975,maxValue:mid*1.025}}return info},priceFormat:{type:'custom',formatter:compactUsd,minMove:.01}});
 const volume=chart.addSeries(HistogramSeries,{priceScaleId:'volume',priceFormat:{type:'volume'},lastValueVisible:false,priceLineVisible:false});volume.priceScale().applyOptions({scaleMargins:{top:.83,bottom:0}});
 active={element,key,chart,price,volume,rows:[],fingerprint:'',indicators:{},drawings:[],redo:[],tool:'crosshair',anchor:null,scaleMode:0};
 const showLegend=bar=>{const legend=document.querySelector('#chart-legend');if(!legend||!bar)return;let values=legend.querySelector('.ohlc');if(!values){values=document.createElement('span');values.className='ohlc';legend.append(values)}values.textContent=`O ${compactUsd(bar.open)}  H ${compactUsd(bar.high)}  L ${compactUsd(bar.low)}  C ${compactUsd(bar.close)}  ${bar.close>=bar.open?'+':''}${compactUsd(bar.close-bar.open)} (${bar.open?((bar.close/bar.open-1)*100).toFixed(2):'0.00'}%)`;values.style.color=bar.close>=bar.open?'#26a69a':'#ef5350'};
 active.showLegend=showLegend;
 const state=active;
 const pointAt=point=>{const value=price.coordinateToPrice(point.y);if(value===null||!Number.isFinite(value))return null;const scale=chart.timeScale(),logical=scale.coordinateToLogical(point.x);if(logical===null||!state.rows.length)return null;const step=Number(state.key.split(':').at(-1))||900;const exact=scale.coordinateToTime(point.x);const time=typeof exact==='number'?exact:state.rows[0].time+Math.round(logical)*step;return {time,value}};
 const finish=(first,last)=>{if(state.tool==='horizontal'){addDrawing({type:'horizontal',value:last.value});return}if(first.time===last.time&&state.tool!=='fib')last={...last,time:last.time+(Number(state.key.split(':').at(-1))||900)};addDrawing({type:state.tool,first,last});state.anchor=null;drawingHint()};
 let down=null,ignoreClickUntil=0;
 const pointerDown=event=>{if(state!==active||state.tool==='crosshair'||event.button!==0)return;const rect=element.getBoundingClientRect();down={x:event.clientX-rect.left,y:event.clientY-rect.top};};
 const pointerUp=event=>{if(!down||state!==active)return;const rect=element.getBoundingClientRect(),end={x:event.clientX-rect.left,y:event.clientY-rect.top},start=down;down=null;if(Math.hypot(end.x-start.x,end.y-start.y)<5)return;const first=pointAt(start),last=pointAt(end);if(!first||!last)return;ignoreClickUntil=performance.now()+500;finish(first,last)};
 const cancel=()=>{down=null};
 const escape=event=>{if(event.key==='Escape'&&state===active){state.anchor=null;down=null;setDrawTool('crosshair');document.querySelectorAll('[data-action=draw-tool]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.value==='crosshair')))}};
 element.addEventListener('pointerdown',pointerDown);element.addEventListener('pointerup',pointerUp);element.addEventListener('pointercancel',cancel);document.addEventListener('keydown',escape);
 state.cleanup=()=>{element.removeEventListener('pointerdown',pointerDown);element.removeEventListener('pointerup',pointerUp);element.removeEventListener('pointercancel',cancel);document.removeEventListener('keydown',escape);state.hint?.remove()};
 chart.subscribeClick(param=>{if(state!==active||!param.point||state.tool==='crosshair'||performance.now()<ignoreClickUntil)return;const point=pointAt(param.point);if(!point)return;
 if(state.tool==='horizontal'){finish(point,point);return}
 if(!state.anchor){state.anchor=point;state.element.setAttribute('aria-label','First drawing point selected; choose the second point');drawingHint();return}
 finish(state.anchor,point);
 });chart.subscribeCrosshairMove(param=>showLegend(param.seriesData.get(price)||active?.rows.at(-1)));
 }
 const fingerprint=JSON.stringify(bars);if(fingerprint===active.fingerprint)return true;
 const previous=active.rows,canAppend=previous.length&&bars.length>=previous.length&&previous.slice(0,-1).every((row,i)=>JSON.stringify(row)===JSON.stringify(bars[i]));
 const vol=b=>({time:b.time,value:b.volume,color:b.close>=b.open?'#9af5bc65':'#f8717165'});
 if(canAppend){for(const bar of bars.slice(previous.length-1)){active.price.update(bar);active.volume.update(vol(bar))}}else{active.price.setData(bars);active.volume.setData(bars.map(vol))}
 if(!previous.length)active.chart.timeScale().setVisibleLogicalRange({from:Math.max(-5,bars.length-65),to:Math.max(25,bars.length+5)});
 if(active.line)active.line.setData(bars.map(b=>({time:b.time,value:b.close})));active.rows=bars;if(!previous.length)for(const spec of drawingSessions.get(key)||[])mountDrawing(spec);active.fingerprint=fingerprint;active.showLegend(bars.at(-1));for(const [name,series] of Object.entries(active.indicators))series.setData(movingAverage(bars,20,name==='ema'));return true;
}

export function resetChart(){if(active)active.chart.timeScale().setVisibleLogicalRange({from:Math.max(-5,active.rows.length-65),to:Math.max(25,active.rows.length+5)})}
export function setChartScale(mode){if(active){active.scaleMode=mode;active.chart.priceScale('right').applyOptions({mode})}}
export function setChartLog(on){setChartScale(on?1:0)}

export function setChartIndicator(name,on){if(!active||!['sma','ema'].includes(name))return;if(!on){if(active.indicators[name])active.chart.removeSeries(active.indicators[name]);delete active.indicators[name];return}if(!active.indicators[name])active.indicators[name]=active.chart.addSeries(LineSeries,{color:name==='sma'?'#f4c86a':'#ab8bfa',lineWidth:1,priceLineVisible:false,lastValueVisible:false,title:name.toUpperCase()+' 20'});active.indicators[name].setData(movingAverage(active.rows,20,name==='ema'))}
function mountDrawing(spec){
 if(!active)return;const handles=[];const level=(value,title='')=>handles.push({priceLine:active.price.createPriceLine({price:value,color:'#8ab4f8',lineWidth:1,lineStyle:0,axisLabelVisible:true,title})});
 if(spec.type==='horizontal')level(spec.value);
 else if(spec.type==='fib'){for(const ratio of [0,.236,.382,.5,.618,.786,1])level(spec.first.value+(spec.last.value-spec.first.value)*ratio,String(ratio))}
 else {const points=[spec.first,spec.last].sort((a,b)=>a.time-b.time);const series=active.chart.addSeries(LineSeries,{color:spec.type==='measure'?'#d9b562':'#8ab4f8',lineWidth:1,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false,autoscaleInfoProvider:()=>null});series.setData(points);handles.push({series});if(spec.type==='measure'){const percent=(spec.last.value/spec.first.value-1)*100;const minutes=Math.abs(spec.last.time-spec.first.time)/60;level(spec.last.value,`${percent>=0?'+':''}${percent.toFixed(2)}% · ${minutes}m`)}}
 active.drawings.push({spec,handles});
}
function persistDrawings(){drawingSessions.set(active.key,active.drawings.map(d=>d.spec));active.element.setAttribute('aria-label',active.drawings.length+' chart drawings');if(drawingSessions.size>50)drawingSessions.delete(drawingSessions.keys().next().value)}
function addDrawing(spec){if(active.drawings.length>=100){removeDrawing(active.drawings.shift())}mountDrawing(spec);active.element.setAttribute('aria-label',active.drawings.length+' chart drawings');active.redo=[];persistDrawings()}
function removeDrawing(d){for(const h of d.handles)h.priceLine?active.price.removePriceLine(h.priceLine):active.chart.removeSeries(h.series)}
export function undoChartDrawing(){if(!active?.drawings.length)return;const d=active.drawings.pop();removeDrawing(d);active.redo.push(d.spec);persistDrawings()}
export function redoChartDrawing(){if(!active?.redo.length)return;mountDrawing(active.redo.pop());persistDrawings()}
function drawingHint(){if(!active)return;const names={trend:'Trend line',horizontal:'Horizontal line',fib:'Fibonacci',measure:'Measure'};if(!active.hint){const hint=document.createElement('div');hint.setAttribute('role','status');Object.assign(hint.style,{position:'absolute',top:'8px',left:'8px',zIndex:'5',pointerEvents:'none',background:'#252b38',color:'#c7d5ea',padding:'5px 8px',fontSize:'11px',borderRadius:'3px'});active.element.style.position='relative';active.element.append(hint);active.hint=hint}active.hint.hidden=active.tool==='crosshair';active.hint.textContent=(names[active.tool]||'')+': '+(active.tool==='horizontal'?'click a price level':active.anchor?'click the second point':'drag, or click two points')+' · Esc to exit';}
export function setDrawTool(tool){if(active&&['crosshair','trend','horizontal','fib','measure'].includes(tool)){active.tool=tool;active.anchor=null;active.element.style.cursor=tool==='crosshair'?'default':'crosshair';active.chart.applyOptions({handleScroll:tool==='crosshair',handleScale:tool==='crosshair'});drawingHint()}}
export function clearChartDrawings(){if(!active)return;for(const d of active.drawings)removeDrawing(d);active.drawings=[];active.redo=[];active.anchor=null;persistDrawings();drawingHint()}
export function chartRange(days){if(!active?.rows.length)return;const to=active.rows.at(-1).time;active.chart.timeScale().setVisibleRange({from:to-days*86400,to})}
export function chartDate(date){if(!active?.rows.length)return;const from=Date.parse(date+'T00:00:00Z')/1000;if(!Number.isFinite(from))return;active.chart.timeScale().setVisibleRange({from,to:from+86400})}
export function chartDisplay(setting,on){if(!active)return;if(setting==='grid')active.chart.applyOptions({grid:{vertLines:{visible:on},horzLines:{visible:on}}});if(setting==='volume')active.volume.applyOptions({visible:on});if(setting==='line'){if(on){active.line=active.chart.addSeries(LineSeries,{color:'#26a69a',lineWidth:2,priceFormat:{type:'custom',formatter:compactUsd,minMove:.01}});active.line.setData(active.rows.map(b=>({time:b.time,value:b.close})));active.price.applyOptions({visible:false})}else{if(active.line)active.chart.removeSeries(active.line);active.line=null;active.price.applyOptions({visible:true})}}}
export function saveChartImage(){if(!active)return;const canvas=active.chart.takeScreenshot();canvas.toBlob(blob=>{if(!blob)return;const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='pill-market-cap-chart.png';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000)},'image/png')}
