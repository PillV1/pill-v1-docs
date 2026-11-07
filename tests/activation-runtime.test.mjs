import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {socialBuilder} from '../services/api/social-worker.mjs';
import {rewardTree,socialRoundAddress} from '../sdk/src/social-rewards.mjs';
import {maintenanceBuilder} from '../services/api/maintenance.mjs';
import {SignerVault,sealedLaunchPlan,transactionBuilder} from '../services/api/signing.mjs';
import {fileURLToPath} from 'node:url';
import {LiteSVM,FailedTransactionMetadata} from 'litesvm';
import {Keypair,PublicKey,SystemProgram,Transaction,TransactionInstruction,Ed25519Program,SYSVAR_INSTRUCTIONS_PUBKEY} from '@solana/web3.js';
import {DEVELOPMENT_PROGRAM,addresses,executeDeveloperBuyInstruction,createLaunchInstruction,tradeInstruction,u64,METADATA_PROGRAM} from '../sdk/src/instructions.mjs';
import {ORAO,networkAddress,randomnessAddress,requestActivationInstruction,activateInstruction,activationFulfilled} from '../sdk/src/activation.mjs';
import {decodeLaunch} from '../sdk/src/accounts.mjs';
const tag=(kind,name)=>createHash('sha256').update(`${kind}:${name}`).digest().subarray(0,8);
const file=p=>fileURLToPath(new URL(p,import.meta.url));
for(const combined of [false,true])test(`compiled launch ${combined?'atomic creation and request':'legacy steps'} verifies ORAO and worker activation`,async()=>{
 const svm=new LiteSVM(),program=DEVELOPMENT_PROGRAM,id='local_launch_intent_123456',genesis='local-fixture',vault=new SignerVault(randomBytes(32),{program,genesis}),payer=vault.derive(id,'deposit'),mint=vault.derive(id,'mint'),oracle=Keypair.generate();
 svm.addProgramFromFile(program.toBase58(),file('../target/deploy/custom_launchpad.so'));
 svm.addProgramFromFile(METADATA_PROGRAM.toBase58(),file('../artifacts/external/token_metadata.so'));
 svm.addProgramFromFile(ORAO.toBase58(),file('../artifacts/external/orao_vrf.so'));
 svm.airdrop(payer.publicKey.toBase58(),10_000_000_000n);svm.airdrop(oracle.publicKey.toBase58(),1_000_000n);
 const a=addresses(program,mint.publicKey),bump=PublicKey.findProgramAddressSync([Buffer.from('config')],program)[1];
 const account=(address,owner,data)=>svm.setAccount({address:address.toBase58(),programAddress:owner.toBase58(),lamports:svm.minimumBalanceForRentExemption(BigInt(data.length)),executable:false,data});
 account(a.config,program,Buffer.concat([tag('account','Config'),payer.publicKey.toBuffer(),Buffer.from([bump]),payer.publicKey.toBuffer()]));
 const n=Buffer.alloc(4);n.writeUInt32LE(1);
 account(networkAddress(),ORAO,Buffer.concat([tag('account','NetworkState'),oracle.publicKey.toBuffer(),oracle.publicKey.toBuffer(),u64('10000'),n,oracle.publicKey.toBuffer(),Buffer.from([0]),u64('0')]));
 function send(instructions,extra=[]){svm.expireBlockhash();const tx=new Transaction({feePayer:payer.publicKey,recentBlockhash:svm.latestBlockhash()}).add(...instructions);tx.sign(payer,...extra);return svm.sendTransaction({messageBytes:tx.serializeMessage(),signatures:Object.fromEntries(tx.signatures.map(s=>[s.publicKey.toBase58(),s.signature]))})}
 const success=result=>assert(!(result instanceof FailedTransactionMetadata),result instanceof FailedTransactionMetadata?result.meta().logs().join('\n'):'');
 const config={ticker:'VRF',name:'Oracle test',uri:'ipfs://test',supply:'1000000000000000',saleTokens:'800000000000000',virtualTokens:'1000000000000000',virtualQuote:'30000000000',targetQuote:'85000000000',maxWalletBps:'400',protectionSlots:'4',feeMode:'burn',blocked:[],developerBuyLamports:'10000000'};
 const activation={oracleTreasury:oracle.publicKey.toBase58(),maxFee:'10000'},intent={id,owner:payer.publicKey.toBase58(),deposit_address:payer.publicKey.toBase58(),state:'paid',expires_at:Math.floor(Date.now()/1000)+900,params:{config,activation}};
 const reader={getAccountInfo:async address=>{const x=svm.getAccount(address.toBase58());return x.exists?{owner:new PublicKey(x.programAddress),data:Buffer.from(x.data)}:null},getGenesisHash:async()=>genesis,getLatestBlockhash:async()=>({blockhash:svm.latestBlockhash(),lastValidBlockHeight:10000}),getSlot:async()=>Number(svm.getClock().slot)};
 const sealed=sealedLaunchPlan({vault,program,intent,config,activation}),build=transactionBuilder({connection:reader,vault,program,expectedGenesis:genesis,loadIntent:async()=>intent});
 const job=stage=>({kind:'launch_stage',body:{intent:id,stage,plan_hash:sealed.hash}});
 const deliver=async stage=>{svm.expireBlockhash();const prepared=await build(job(stage)),tx=Transaction.from(Buffer.from(prepared.wire_transaction,'base64'));assert(tx.verifySignatures());return svm.sendTransaction({messageBytes:tx.serializeMessage(),signatures:Object.fromEntries(tx.signatures.map(s=>[s.publicKey.toBase58(),s.signature]))})};
 if(combined)success(send([createLaunchInstruction({program,mint:mint.publicKey,creator:payer.publicKey,config:{...config,beneficiary:payer.publicKey.toBase58()}}),requestActivationInstruction({program,mint:mint.publicKey,payer:payer.publicKey,seed:vault.activationSeed(id),oracleTreasury:oracle.publicKey,maxFee:'10000'})],[mint]));else success(await deliver(0));
 const buy=()=>tradeInstruction({program,mint:mint.publicKey,trader:payer.publicKey,side:'buy',amount:'1000000',minimum:'1',deadlineSlot:(svm.getClock().slot+1000n).toString(),ticker:'VRF'});
 assert(send([buy()]) instanceof FailedTransactionMetadata);
 const seed=vault.activationSeed(id),args={program,mint:mint.publicKey,payer:payer.publicKey,seed,oracleTreasury:oracle.publicKey,maxFee:'10000'};
 const attacker=Keypair.generate();svm.airdrop(attacker.publicKey.toBase58(),1_000_000_000n);
 function attack(instruction){svm.expireBlockhash();const tx=new Transaction({feePayer:attacker.publicKey,recentBlockhash:svm.latestBlockhash()}).add(instruction);tx.sign(attacker);return svm.sendTransaction({messageBytes:tx.serializeMessage(),signatures:Object.fromEntries(tx.signatures.map(s=>[s.publicKey.toBase58(),s.signature]))})}
 assert(attack(requestActivationInstruction({...args,payer:attacker.publicKey})) instanceof FailedTransactionMetadata);
 assert(send([requestActivationInstruction({...args,maxFee:'9999'})]) instanceof FailedTransactionMetadata);
 if(!combined)success(await deliver(1));
 const activate=activateInstruction({...args,ticker:'VRF'});
 assert(send([activate]) instanceof FailedTransactionMetadata);
 assert.equal((await build(job(2))).deferred,'oracle_fulfillment');
 assert.equal(await activationFulfilled(reader,seed,payer.publicKey),false);
 const verify=Ed25519Program.createInstructionWithPrivateKey({privateKey:oracle.secretKey,message:Buffer.from(seed,'hex')});
 const meta=(pubkey,isWritable=false,isSigner=false)=>({pubkey,isWritable,isSigner});
 const fulfill=new TransactionInstruction({programId:ORAO,keys:[meta(payer.publicKey,true,true),meta(SYSVAR_INSTRUCTIONS_PUBKEY),meta(networkAddress(),true),meta(randomnessAddress(seed),true),meta(payer.publicKey,true),meta(SystemProgram.programId)],data:tag('global','fulfill_v2')});
 success(send([verify,fulfill]));assert.equal(await activationFulfilled(reader,seed,payer.publicKey),true);
 // Anyone can pay to activate, but cannot change the committed oracle or launch rules.
 success(attack(activateInstruction({...args,ticker:'VRF',payer:attacker.publicKey})));
 const state=decodeLaunch({account:await reader.getAccountInfo(a.launch),address:a.launch,program,mint:mint.publicKey});
 assert.equal(state.randomnessReady,true);assert(state.args.protectionSlots>=1n&&state.args.protectionSlots<=4n);
 assert(send([activate]) instanceof FailedTransactionMetadata);assert(send([requestActivationInstruction(args)]) instanceof FailedTransactionMetadata);
 svm.warpToSlot(state.startSlot+10n);success(attack(executeDeveloperBuyInstruction({program,mint:mint.publicKey,creator:payer.publicKey,keeper:attacker.publicKey,ticker:'VRF',ensure:true})));
 const before=Buffer.from(svm.getAccount(a.launch.toBase58()).data);success(await deliver(3));assert.deepEqual(Buffer.from(svm.getAccount(a.launch.toBase58()).data),before);success(send([buy()]));
 reader.getMultipleAccountsInfoAndContext=async keys=>({context:{slot:Number(svm.getClock().slot)},value:await Promise.all(keys.map(key=>reader.getAccountInfo(key)))});
 const keeperBuild=maintenanceBuilder({connection:reader,program,genesis,signer:oracle});
 for(const kind of ['keeper_treasury','keeper_burn']){
  svm.expireBlockhash();const prepared=await keeperBuild({kind,body:{mint:mint.publicKey.toBase58()}}),tx=Transaction.from(Buffer.from(prepared.wire_transaction,'base64'));assert(tx.verifySignatures());success(svm.sendTransaction({messageBytes:tx.serializeMessage(),signatures:Object.fromEntries(tx.signatures.map(s=>[s.publicKey.toBase58(),s.signature]))}));
 }
 const settled=decodeLaunch({account:await reader.getAccountInfo(a.launch),address:a.launch,program,mint:mint.publicKey});assert.equal(settled.treasuryFees,0n);assert.equal(settled.coinFees,0n);assert(settled.burned>0n);
 assert.equal((await keeperBuild({kind:'keeper_treasury',body:{mint:mint.publicKey.toBase58()}})).noop,'maintenance_already_satisfied');

 // Exercise the private social signer against compiled payout contracts as well.
 const socialMint=Keypair.generate(),sa=addresses(program,socialMint.publicKey);
 success(send([createLaunchInstruction({program,mint:socialMint.publicKey,creator:payer.publicKey,config:{...config,ticker:'YAP',feeMode:'yap',developerBuyLamports:'0'}})],[socialMint]));
 const socialSeed=randomBytes(32).toString('hex'),socialArgs={...args,mint:socialMint.publicKey,seed:socialSeed};
 success(send([requestActivationInstruction(socialArgs)]));
 const socialVerify=Ed25519Program.createInstructionWithPrivateKey({privateKey:oracle.secretKey,message:Buffer.from(socialSeed,'hex')});
 const socialFulfill=new TransactionInstruction({programId:ORAO,keys:[meta(payer.publicKey,true,true),meta(SYSVAR_INSTRUCTIONS_PUBKEY),meta(networkAddress(),true),meta(randomnessAddress(socialSeed),true),meta(payer.publicKey,true),meta(SystemProgram.programId)],data:tag('global','fulfill_v2')});
 success(send([socialVerify,socialFulfill]));success(send([activateInstruction({...socialArgs,ticker:'YAP'})]));
 const socialActive=decodeLaunch({account:await reader.getAccountInfo(sa.launch),address:sa.launch,program,mint:socialMint.publicKey});svm.warpToSlot(socialActive.startSlot+10n);
 success(send([tradeInstruction({program,mint:socialMint.publicKey,trader:payer.publicKey,side:'buy',amount:'10000000',minimum:'1',deadlineSlot:svm.getClock().slot+1000n,ticker:'YAP'})]));
 const socialState=decodeLaunch({account:await reader.getAccountInfo(sa.launch),address:sa.launch,program,mint:socialMint.publicKey});assert(socialState.coinFees>0n);
 const clock=svm.getClock();clock.unixTimestamp=10000n;svm.setClock(clock);
 const round=socialRoundAddress(program,socialMint.publicKey,1n).toBase58(),plan={program:program.toBase58(),mint:socialMint.publicKey.toBase58(),hour:1,round,...rewardTree(round,[{owner:oracle.publicKey.toBase58(),amount:socialState.coinFees.toString()}])};
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE social_round_plans(mint TEXT,hour INTEGER,body TEXT,hash TEXT)');const encoded=JSON.stringify(plan);db.prepare('INSERT INTO social_round_plans VALUES(?,?,?,?)').run(plan.mint,1,encoded,createHash('sha256').update(encoded).digest('hex'));
 const socialBuild=socialBuilder({db,connection:reader,program,genesis,signer:payer});
 const socialJob=kind=>({kind,body:JSON.stringify({mint:plan.mint,hour:1,owner:oracle.publicKey.toBase58()})});
 for(const kind of ['keeper_social_publish','keeper_social_claim']){svm.expireBlockhash();const prepared=await socialBuild(socialJob(kind)),tx=Transaction.from(Buffer.from(prepared.wire_transaction,'base64'));success(svm.sendTransaction({messageBytes:tx.serializeMessage(),signatures:Object.fromEntries(tx.signatures.map(s=>[s.publicKey.toBase58(),s.signature]))}));}
 assert.equal((await socialBuild(socialJob('keeper_social_claim'))).noop,'maintenance_already_satisfied');
 assert.equal((await socialBuild(socialJob('keeper_social_publish'))).noop,'maintenance_already_satisfied');db.close();

});
