import {PublicKey} from '@solana/web3.js';
export const HILL_TARGET_SOL=45;
export const MARKET_SCHEMA=`CREATE TABLE IF NOT EXISTS onepill_market(id TEXT PRIMARY KEY,last_slot INTEGER NOT NULL DEFAULT 0,cap_sol REAL,progress_bps INTEGER NOT NULL DEFAULT 0,target_cap_sol REAL NOT NULL,crowned_slot INTEGER,crowned_at INTEGER,checked INTEGER NOT NULL DEFAULT 0,last_error TEXT)`;
export function marketSnapshot(history,coin,finalizedSlot){
 const m=history.launches?.find(m=>m.slug===coin.slug),supply=Number(coin.supply?.perChain?.solana);
 if(!m||!Number.isFinite(supply)||supply<=0)throw Error('onepill_market_unavailable');
 const trades=(m.recent??[]).filter(t=>t.chain==='solana'&&/^solana:\d+:/.test(t.id)&&Number(t.id.split(':')[1])<=finalizedSlot&&Number(t.tokenAmount)>0&&Number(t.quoteAmount)>0).sort((a,b)=>Number(a.id.split(':')[1])-Number(b.id.split(':')[1]));
 if(!trades.length)return null;
 const price=t=>Number(t.quoteAmount)/Number(t.tokenAmount)*supply;
 const last=trades.at(-1),cap=price(last),crown=null;
 return {lastSlot:Number(last.id.split(':')[1]),capSol:cap,progressBps:0,crownedSlot:crown?Number(crown.id.split(':')[1]):null,crownedAt:crown?.timestamp??null};
}
export function attachMarket(db,c){const m=db.prepare('SELECT * FROM onepill_market WHERE id=?').get(c.id);return {...c,mint:c.chains?.solana?.token,cap:m?.cap_sol??null,bumpSlot:Math.max(c.listedSlot||0,m?.last_slot||0),kingOfTheHill:{qualified:!!m?.crowned_slot,crownedSlot:m?.crowned_slot??null,crownedAt:m?.crowned_at??null,progressBps:m?.progress_bps??0,targetLiquiditySol:HILL_TARGET_SOL,liquiditySol:m?.liquidity_sol??null}};}
// Offsets from MeteoraAg/damm-v2-sdk src/idl/cp_amm.json (Pool).
const DAMM='cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',WSOL='So11111111111111111111111111111111111111112',TOKEN='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export async function poolSolReserve(connection,coin){
 const poolKey=new PublicKey(coin.chains.solana.pool),mint=coin.chains.solana.token;
 const pool=await connection.getAccountInfo(poolKey,'finalized');
 if(!pool?.owner.equals(new PublicKey(DAMM))||pool.data.length<296||pool.data.subarray(0,8).toString('hex')!=='f19a6d0411b16dbc')throw Error('invalid_onepill_pool');
 const key=o=>new PublicKey(pool.data.subarray(o,o+32)).toBase58(),a=key(168),b=key(200);
 if(!((a===mint&&b===WSOL)||(b===mint&&a===WSOL)))throw Error('invalid_onepill_pool_pair');
 const vault=new PublicKey(key(a===WSOL?232:264));
 const result=await connection.getAccountInfoAndContext(vault,{commitment:'finalized'}),v=result.value;
 if(!v?.owner.equals(new PublicKey(TOKEN))||v.data.length<165||new PublicKey(v.data.subarray(0,32)).toBase58()!==WSOL)throw Error('invalid_onepill_sol_vault');
 return {sol:Number(v.data.readBigUInt64LE(64))/1e9,slot:result.context.slot};
}
function ensureLiquiditySchema(db){const columns=db.prepare('PRAGMA table_info(onepill_market)').all();if(!columns.some(c=>c.name==='liquidity_sol')){db.exec('ALTER TABLE onepill_market ADD COLUMN liquidity_sol REAL');db.exec('UPDATE onepill_market SET progress_bps=0,crowned_slot=NULL,crowned_at=NULL,checked=0,target_cap_sol=45');}}
export async function pollOnepillMarkets(service){
 if(service.marketBusy)return;service.marketBusy=true;
 try{
 ensureLiquiditySchema(service.db);
 const rows=service.db.prepare("SELECT o.*,COALESCE(m.checked,0) AS market_checked FROM onepill_launches o LEFT JOIN onepill_market m ON m.id=o.id WHERE o.state='done' AND o.coin IS NOT NULL AND COALESCE(m.checked,0)<? ORDER BY market_checked LIMIT 3").all(service.clock()-5);
 if(!rows.length)return;const finalized=await service.connection.getSlot('finalized');
 await Promise.allSettled(rows.map(async row=>{try{const coin=JSON.parse(row.coin),history=await service.upstream('history?launch='+encodeURIComponent(row.id)+'&hours=168&interval=900');const reserve=await poolSolReserve(service.connection,coin);const m=marketSnapshot(history,coin,finalized)||{lastSlot:0,capSol:null};m.progressBps=Math.min(10000,Math.floor(reserve.sol/HILL_TARGET_SOL*10000));m.crownedSlot=reserve.sol>=HILL_TARGET_SOL?reserve.slot:null;m.crownedAt=m.crownedSlot?service.clock():null;if(m)service.db.prepare(`INSERT INTO onepill_market(id,last_slot,cap_sol,progress_bps,target_cap_sol,crowned_slot,crowned_at,checked) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_slot=MAX(last_slot,excluded.last_slot),cap_sol=CASE WHEN excluded.last_slot>=last_slot THEN excluded.cap_sol ELSE cap_sol END,progress_bps=excluded.progress_bps,crowned_slot=COALESCE(crowned_slot,excluded.crowned_slot),crowned_at=COALESCE(crowned_at,excluded.crowned_at),checked=excluded.checked,last_error=NULL`).run(row.id,m.lastSlot,m.capSol,m.progressBps,HILL_TARGET_SOL,m.crownedSlot,m.crownedAt,service.clock());service.db.prepare('UPDATE onepill_market SET liquidity_sol=?,target_cap_sol=? WHERE id=?').run(reserve.sol,HILL_TARGET_SOL,row.id);}catch{service.db.prepare('INSERT INTO onepill_market(id,target_cap_sol,checked,last_error) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET checked=excluded.checked,last_error=excluded.last_error').run(row.id,HILL_TARGET_SOL,service.clock(),'market_update_delayed');}}));
 }finally{service.marketBusy=false}
}
