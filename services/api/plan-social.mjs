// Isolated from fee/launch maintenance so provider outages cannot stop payments.
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {Connection} from '@solana/web3.js';
import {Social} from './social.mjs';import {XPostReader} from './x-client.mjs';
import {holderReader} from '../../sdk/src/holder-reader.mjs';
import {verifyDeployment} from './deployment.mjs';import {planSocialMint} from './social-worker.mjs';
const config=JSON.parse(await readFile(process.env.LAUNCHPAD_CONFIG,'utf8'));if(config.socialEnabled!==true)process.exit(0);
if(!config.keeperEnabled||!process.env.X_BEARER_TOKEN)throw Error('social_configuration_required');
const connection=new Connection(process.env.LAUNCHPAD_RPC_URL,'finalized');await verifyDeployment(connection,config);
const db=new DatabaseSync(config.database);db.exec('PRAGMA busy_timeout=10000; CREATE TABLE IF NOT EXISTS social_cursor(id INTEGER PRIMARY KEY CHECK(id=1),mint TEXT NOT NULL)');
try{
 const social=new Social(db,null,new XPostReader({bearerToken:process.env.X_BEARER_TOKEN}),holderReader(connection,config.genesis));
 const previous=db.prepare('SELECT mint FROM social_cursor WHERE id=1').get()?.mint??'';
 const row=db.prepare('SELECT mint FROM coins WHERE mint>? ORDER BY mint LIMIT 1').get(previous);
 // Advance before network access: one unavailable provider/coin cannot starve all other coins.
 db.prepare('INSERT INTO social_cursor VALUES(1,?) ON CONFLICT(id) DO UPDATE SET mint=excluded.mint').run(row?.mint??'');
 if(row)await planSocialMint({db,connection,program:config.program,mint:row.mint,social,now:Math.floor(Date.now()/1000)});
}finally{db.close()}
