import test from 'node:test';import assert from 'node:assert/strict';
import {Keypair,PublicKey,Transaction,TransactionInstruction} from '@solana/web3.js';
import {classicInitialBuy,classicInitialBuyMaximum} from '../src/classic-initial-buy.mjs';
import {CLASSIC,quoteClassic} from '../vendor/sdk/classic.mjs';
import {plan} from '../src/direct-launch.mjs';
const key=()=>Keypair.generate().publicKey.toBase58();
const input={program:key(),mint:key(),owner:key()};
test('classic initial buy respects budget including 2.2% fee and the shared slot cap',()=>{
 assert.equal(classicInitialBuy({...input,amount:'0'}),null);
 for(const amount of ['10000000','100000000',String(classicInitialBuyMaximum)]){
  const {quote,instruction}=classicInitialBuy({...input,amount,slot:100n});
  assert(quote.walletLamports<=BigInt(amount));assert(quote.tokens<=CLASSIC.supply/100n);
  assert.equal(quote.fee,(quote.principal*220n+9999n)/10000n);
  assert.equal(instruction.data.readBigUInt64LE(16),BigInt(amount));assert.equal(instruction.data.readBigUInt64LE(24),250n);
  if(quote.tokens<CLASSIC.supply/100n)assert(quoteClassic({sold:0n,quote:0n,side:'buy',tokens:quote.tokens+1n}).walletLamports>BigInt(amount));
 }
 assert.equal(classicInitialBuy({...input,amount:String(classicInitialBuyMaximum)}).quote.tokens,CLASSIC.supply/100n);
 for(const amount of ['-1','1.2','1e9','1',String(classicInitialBuyMaximum+1n)])assert.throws(()=>classicInitialBuy({...input,amount}));
});
test('classic create and initial buy fit one transaction even with maximum metadata lengths',()=>{
 const record={...input,treasury:key(),payload:{version:'v1',config:{name:'N'.repeat(32),ticker:'S'.repeat(10),uri:'https://example.com/'+ 'a'.repeat(180),developerBuyLamports:'100000000'}}};
 const p=plan(record,100n);assert.equal(p.stages.length,1);assert.equal(p.stages[0].instructions.length,3);
 const tx=new Transaction({feePayer:new PublicKey(input.owner),recentBlockhash:key()});
 for(const i of p.stages[0].instructions)tx.add(new TransactionInstruction({programId:new PublicKey(i.program),keys:i.accounts.map(a=>({pubkey:new PublicKey(a.address),isSigner:a.signer,isWritable:a.writable})),data:Buffer.from(i.dataBase64,'base64')}));
 assert(tx.serialize({requireAllSignatures:false,verifySignatures:false}).length<=1232);
 record.payload.config.developerBuyLamports='0';assert.equal(plan(record).stages[0].instructions.length,1);
});
