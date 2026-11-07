// Private worker subprocess. Never expose this file through an HTTP route.
import {readFile,lstat} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {Connection,PublicKey,Keypair} from '@solana/web3.js';
import {tickerExpiryBuilder} from './ticker-expiry.mjs';
import {socialBuilder} from './social-worker.mjs';
import {maintenanceBuilder} from './maintenance.mjs';
import {verifyDeployment} from './deployment.mjs';
import {SignerVault,transactionBuilder} from './signing.mjs';
const config=JSON.parse(await readFile(process.env.LAUNCHPAD_CONFIG,'utf8'));
if(config.signingEnabled!==true)throw Error('signing_disabled');
const stat=await lstat(config.masterSeedFile);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)throw Error('private_seed_permissions_required');
const master=await readFile(config.masterSeedFile);if(master.length!==32)throw Error('master_seed_must_be_32_raw_bytes');
let input='';for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>4096)throw Error('input_too_large')}
const request=JSON.parse(input),db=new DatabaseSync(config.database);db.exec('PRAGMA busy_timeout=10000');
const job=db.prepare("SELECT * FROM jobs WHERE id=? AND lease=? AND phase='working' AND lease_until>=?").get(request.id,request.lease,Math.floor(Date.now()/1000));
if(!job)throw Error('invalid_job_lease');
const vault=new SignerVault(master,{program:config.program,genesis:config.genesis});master.fill(0);
const connection=new Connection(process.env.LAUNCHPAD_RPC_URL,{commitment:'confirmed',confirmTransactionInitialTimeout:15000});
const program=new PublicKey(config.program);
await verifyDeployment(connection,config);
let builder=transactionBuilder({connection,vault,program,expectedGenesis:config.genesis,loadIntent:async id=>db.prepare('SELECT * FROM intents WHERE id=?').get(id)});
if(job.kind.startsWith('keeper_')){
 if(config.keeperEnabled!==true||!config.keeperSeedFile)throw Error('keeper_disabled');
 const stat=await lstat(config.keeperSeedFile);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)throw Error('private_seed_permissions_required');
 const seed=await readFile(config.keeperSeedFile);if(seed.length!==32)throw Error('keeper_seed_must_be_32_raw_bytes');const signer=Keypair.fromSeed(seed);seed.fill(0);
 if(job.kind.startsWith('keeper_social_')&&config.socialEnabled!==true)throw Error('social_disabled');
 if(['keeper_social_publish','keeper_pool_fees','keeper_ticker_expiry'].includes(job.kind)&&signer.publicKey.toBase58()!==new PublicKey(config.operator).toBase58())throw Error('keeper_operator_key_required');
 if(job.kind==='keeper_ticker_expiry'&&config.bondedTickerReuseEnabled!==true)throw Error('ticker_expiry_disabled');
 builder=job.kind==='keeper_ticker_expiry'?tickerExpiryBuilder({db,connection,program,genesis:config.genesis,signer}):job.kind.startsWith('keeper_social_')?socialBuilder({db,connection,program,genesis:config.genesis,signer}):maintenanceBuilder({connection,program,genesis:config.genesis,signer});
}
try{process.stdout.write(JSON.stringify(await builder(job)))}finally{db.close()}
