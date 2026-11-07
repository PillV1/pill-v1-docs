import test from 'node:test';import assert from 'node:assert/strict';
import {Keypair,SystemProgram} from '@solana/web3.js';
import {deploymentAddresses,initializeInstruction,verifyProgramAuthority,UPGRADEABLE_LOADER} from '../sdk/src/deployment.mjs';
import {Transaction} from '@solana/web3.js';
import {LiteSVM,FailedTransactionMetadata} from 'litesvm';
import {fileURLToPath} from 'node:url';
import {DEVELOPMENT_PROGRAM} from '../sdk/src/instructions.mjs';
import {decodeConfig} from '../sdk/src/accounts.mjs';
test('initialization binds treasury and the only signer to the deployment authority',()=>{
 const program=Keypair.generate().publicKey,authority=Keypair.generate().publicKey,treasury=Keypair.generate().publicKey;
 const ix=initializeInstruction({program,authority,treasury}),a=deploymentAddresses(program);
 assert(ix.keys[0].pubkey.equals(authority));assert.deepEqual(ix.keys.map(k=>k.isSigner),[true,false,false,false,false]);
 assert(ix.keys[1].pubkey.equals(a.config));assert(ix.keys[3].pubkey.equals(a.programData));assert(ix.data.subarray(8).equals(treasury.toBuffer()));
 assert.throws(()=>initializeInstruction({program,authority,treasury:SystemProgram.programId}),/invalid/);
});
test('compiled program initializes only under its upgrade authority and rejects reinitialization',()=>{
 const svm=new LiteSVM(),program=DEVELOPMENT_PROGRAM,authority=Keypair.generate(),attacker=Keypair.generate(),treasury=Keypair.generate().publicKey,a=deploymentAddresses(program);
 svm.addProgramFromFile(program.toBase58(),fileURLToPath(new URL('../target/deploy/custom_launchpad.so',import.meta.url)));
 const stored=svm.getAccount(a.programData.toBase58());assert(stored.exists,'runtime must expose upgradeable program data');
 const data=Buffer.from(stored.data);data[12]=1;authority.publicKey.toBuffer().copy(data,13);
 svm.setAccount({address:a.programData.toBase58(),programAddress:UPGRADEABLE_LOADER.toBase58(),lamports:stored.lamports,executable:false,data});
 for(const payer of [authority,attacker])svm.airdrop(payer.publicKey.toBase58(),1000000000n);
 function send(payer){svm.expireBlockhash();const tx=new Transaction({feePayer:payer.publicKey,recentBlockhash:svm.latestBlockhash()}).add(initializeInstruction({program,authority:payer.publicKey,treasury}));tx.sign(payer);return svm.sendTransaction({messageBytes:tx.serializeMessage(),signatures:{[payer.publicKey.toBase58()]:tx.signatures[0].signature}})}
 assert(send(attacker) instanceof FailedTransactionMetadata);
 const result=send(authority);assert(!(result instanceof FailedTransactionMetadata),result instanceof FailedTransactionMetadata?result.meta().logs().join('\n'):'');
 const config=svm.getAccount(a.config.toBase58());const decoded=decodeConfig({program,address:a.config,account:{owner:program,data:Buffer.from(config.data)}});
 assert.equal(decoded.treasury,treasury.toBase58());assert.equal(decoded.operator,authority.publicKey.toBase58());
 assert(send(authority) instanceof FailedTransactionMetadata);
});
test('initialization refuses missing code, wrong loader, unrelated program data and wrong authority',()=>{
 const program=Keypair.generate().publicKey,authority=Keypair.generate().publicKey,a=deploymentAddresses(program);
 const data=Buffer.alloc(36);data.writeUInt32LE(2);a.programData.toBuffer().copy(data,4);
 const pd=Buffer.alloc(45);pd.writeUInt32LE(3);pd[12]=1;authority.toBuffer().copy(pd,13);
 const good={program,authority,programAccount:{executable:true,owner:UPGRADEABLE_LOADER,data},dataAccount:{owner:UPGRADEABLE_LOADER,data:pd}};
 assert.doesNotThrow(()=>verifyProgramAuthority(good));
 for(const patch of [{programAccount:null},{authority:Keypair.generate().publicKey},{dataAccount:{...good.dataAccount,owner:SystemProgram.programId}},{program:Keypair.generate().publicKey}])assert.throws(()=>verifyProgramAuthority({...good,...patch}));
});
