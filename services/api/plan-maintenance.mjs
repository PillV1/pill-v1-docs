// Private bounded maintenance scan. Never accepts instructions from an HTTP client.
import {readFile} from 'node:fs/promises';import {DatabaseSync} from 'node:sqlite';import {Connection} from '@solana/web3.js';import {createHash} from 'node:crypto';
import {tickerExpiryInstruction} from './ticker-expiry.mjs';
import {maintenanceSnapshot,maintenanceKinds} from './maintenance.mjs';import {verifyDeployment} from './deployment.mjs';
const config=JSON.parse(await readFile(process.env.LAUNCHPAD_CONFIG,'utf8'));if(config.keeperEnabled!==true)process.exit(0);
const connection=new Connection(process.env.LAUNCHPAD_RPC_URL,'finalized');await verifyDeployment(connection,config);
const db=new DatabaseSync(config.database);db.exec('PRAGMA busy_timeout=10000; CREATE TABLE IF NOT EXISTS maintenance_cursor(id INTEGER PRIMARY KEY CHECK(id=1),mint TEXT NOT NULL)');
try{
 const previous=db.prepare('SELECT mint FROM maintenance_cursor WHERE id=1').get()?.mint??'';
 const rows=db.prepare('SELECT mint FROM coins WHERE mint>? ORDER BY mint LIMIT 10').all(previous);
 if(!rows.length){db.prepare("INSERT INTO maintenance_cursor VALUES(1,'') ON CONFLICT(id) DO UPDATE SET mint=''").run();process.exitCode=0}
 for(const {mint} of rows){
  try{
   const {launch,position,unixTime}=await maintenanceSnapshot(connection,config.program,mint);
   if(config.bondedTickerReuseEnabled===true&&await tickerExpiryInstruction({db,connection,program:config.program,mint,operator:config.operator,launch,unixTime})){
    db.prepare('INSERT OR IGNORE INTO jobs(id,kind,launch,body) VALUES(?,?,?,?)').run(`keeper_ticker_expiry:${mint}:${Math.floor(Number(unixTime)/60)}`,'keeper_ticker_expiry',mint,JSON.stringify({mint}));
   }
   for(const kind of maintenanceKinds(launch,position,unixTime)){
    const state=JSON.stringify([launch.sequence,launch.quote,launch.sniperFees,launch.coinFees,launch.treasuryFees,launch.fees,position?.balance??0n],(_,v)=>typeof v==='bigint'?v.toString():v),suffix=createHash('sha256').update(state).digest('hex').slice(0,24);
    db.prepare('INSERT OR IGNORE INTO jobs(id,kind,launch,body) VALUES(?,?,?,?)').run(`${kind}:${mint}:${suffix}`,kind,mint,JSON.stringify({mint}));
   }
  }catch(error){db.prepare("INSERT INTO worker_state(name,checked_at,last_error,failures) VALUES(?,?,?,1) ON CONFLICT(name) DO UPDATE SET checked_at=excluded.checked_at,last_error=excluded.last_error,failures=worker_state.failures+1").run('maintenance:'+mint,Math.floor(Date.now()/1000),error.name)}
  db.prepare('INSERT INTO maintenance_cursor VALUES(1,?) ON CONFLICT(id) DO UPDATE SET mint=excluded.mint').run(mint);
 }
}finally{db.close()}
