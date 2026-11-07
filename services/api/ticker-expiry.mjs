import {createHash} from 'node:crypto';import {PublicKey,TransactionInstruction} from '@solana/web3.js';
import {addresses,tickerAddress} from '../../sdk/src/instructions.mjs';
import {maintenanceSnapshot,signedEnvelope} from './maintenance.mjs';
const tag=n=>createHash('sha256').update(n).digest().subarray(0,8),i64=n=>{const b=Buffer.alloc(8);b.writeBigInt64LE(BigInt(n));return b};
export function inactivityEvidence(db,pool,now){
 const coverage=db.prepare('SELECT * FROM pump_cursors WHERE pool=?').get(pool);
 if(!coverage||coverage.last_error||!coverage.coverage_started||coverage.last_polled>now||now-coverage.last_polled>60)return null;
 const last=db.prepare('SELECT MAX(time) stamp FROM pump_trades WHERE pool=?').get(pool)?.stamp??0,lastTrade=Math.max(last,coverage.coverage_started);
 if(!Number.isSafeInteger(lastTrade)||coverage.last_polled-lastTrade<21600)return null;
 return {lastTrade,observedAt:coverage.last_polled};
}
export async function tickerExpiryInstruction({db,connection,program,mint,operator,launch,unixTime}){
 if(launch.version==='v1'||!launch.graduated)return null;const evidence=inactivityEvidence(db,launch.pool,Number(unixTime));if(!evidence)return null;
 const registry=tickerAddress(program,launch.args.ticker),account=await connection.getAccountInfo(registry,'finalized');
 if(!account||!new PublicKey(account.owner).equals(new PublicKey(program))||account.data.length!==49||!account.data.subarray(0,8).equals(tag('account:TickerRegistry')))throw Error('invalid_ticker_registry');
 const a=addresses(program,mint);if(!new PublicKey(account.data.subarray(8,40)).equals(a.launch))return null;
 return new TransactionInstruction({programId:new PublicKey(program),keys:[[operator,false,true],[a.config],[a.launch],[registry,true]].map(([key,isWritable=false,isSigner=false])=>({pubkey:new PublicKey(key),isWritable,isSigner})),data:Buffer.concat([tag('global:release_bonded_ticker'),i64(evidence.lastTrade),i64(evidence.observedAt)])});
}
export function tickerExpiryBuilder({db,connection,program,genesis,signer}){return async job=>{if(job.kind!=='keeper_ticker_expiry'||await connection.getGenesisHash()!==genesis)throw Error('invalid_ticker_job');const body=JSON.parse(job.body),snapshot=await maintenanceSnapshot(connection,program,body.mint),ix=await tickerExpiryInstruction({db,connection,program,mint:body.mint,operator:signer.publicKey,...snapshot});return ix?signedEnvelope(connection,signer,ix):{noop:'maintenance_already_satisfied'}}}
