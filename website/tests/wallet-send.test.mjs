import test from 'node:test';
import assert from 'node:assert/strict';
import {Connection,Keypair,Transaction,SystemProgram,ComputeBudgetProgram,TransactionInstruction,PublicKey} from '@solana/web3.js';
import {sendPrepared} from '../src/wallet.mjs';
import {base58} from '../src/base58.mjs';
test('shared trade signing flow submits exact wallet-signed bytes with ComputeBudget and Lighthouse additions',async t=>{
 const payer=Keypair.generate(),recipient=Keypair.generate().publicKey;
 const tx=new Transaction({feePayer:payer.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58()}).add(SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:recipient,lamports:1}));
 let signedWire,saved;
 t.mock.method(Connection.prototype,'getGenesisHash',async()=> 'test-genesis');
 t.mock.method(Connection.prototype,'isBlockhashValid',async()=>({value:true}));
 t.mock.method(Connection.prototype,'sendRawTransaction',async bytes=>{assert.deepEqual(bytes,signedWire);assert.ok(saved.signature);return saved.signature;});
 const provider={publicKey:payer.publicKey,signTransaction:async original=>{
  original.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({units:300000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:10000}));
  original.add(new TransactionInstruction({programId:new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'),keys:[{pubkey:payer.publicKey,isSigner:false,isWritable:false}],data:Buffer.from([5,0,7,0,0])}));
  original.partialSign(payer);signedWire=original.serialize();return original;
 }};
 const result=await sendPrepared(provider,{transaction:tx.serialize({requireAllSignatures:false}).toString('base64'),lastValidBlockHeight:123},{rpcUrl:'https://unused.invalid',genesis:'test-genesis',program:SystemProgram.programId.toBase58()},record=>{saved=record;});
 assert.equal(result.signature,base58(Transaction.from(signedWire).signature));
 assert.equal(saved.blockhash,tx.recentBlockhash);
});

test('Classic collection signs with the trade and rejects a different treasury',async t=>{
 const {classicTradeInstruction,collectClassicFeesInstruction}=await import('../../sdk/src/classic.mjs');
 const payer=Keypair.generate(),mint=Keypair.generate().publicKey,program=Keypair.generate().publicKey,treasury=Keypair.generate().publicKey;
 const make=recipient=>new Transaction({feePayer:payer.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58()}).add(classicTradeInstruction({program,mint,trader:payer.publicKey,side:'sell',tokens:1n,limit:1n,deadlineSlot:999n}),collectClassicFeesInstruction({program,mint,treasury:recipient}));
 t.mock.method(Connection.prototype,'getGenesisHash',async()=> 'test-genesis');
 t.mock.method(Connection.prototype,'isBlockhashValid',async()=>({value:true}));
 let signed=0;
 const provider={publicKey:payer.publicKey,signTransaction:async tx=>{signed++;tx.partialSign(payer);return tx;}};
 t.mock.method(Connection.prototype,'sendRawTransaction',async bytes=>base58(Transaction.from(bytes).signature));
 const config={rpcUrl:'https://unused.invalid',genesis:'test-genesis',program:program.toBase58(),treasury:treasury.toBase58()};
 const prepared=tx=>({transaction:tx.serialize({requireAllSignatures:false}).toString('base64'),lastValidBlockHeight:123});
 await sendPrepared(provider,prepared(make(treasury)),config);assert.equal(signed,1);
 await assert.rejects(()=>sendPrepared(provider,prepared(make(Keypair.generate().publicKey)),config),/Unexpected fee collection/);assert.equal(signed,1);
 await sendPrepared(provider,prepared(make(payer.publicKey)),{...config,treasury:payer.publicKey.toBase58()});assert.equal(signed,2);
});
