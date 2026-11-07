import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair,Transaction,VersionedTransaction,SystemProgram,ComputeBudgetProgram,TransactionInstruction,PublicKey} from '@solana/web3.js';
import {validateWalletResponse} from '../src/wallet-response.mjs';
const payer=Keypair.generate(),recipient=Keypair.generate().publicKey;
const tx=()=>new Transaction({feePayer:payer.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58()}).add(SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:recipient,lamports:1}));
test('accepts signed wallet responses containing plain Uint8Arrays, independent of wallet encoding methods',()=>{
 const t=tx(),expected=Uint8Array.from(t.serializeMessage());t.partialSign(payer);
 const response={serialize:()=>Uint8Array.from(t.serialize()),serializeMessage:()=>Uint8Array.from(t.serializeMessage()),verifySignatures:()=>false};
 assert.notEqual(response.serializeMessage().toString('base64'),t.serializeMessage().toString('base64'));
 assert.equal(validateWalletResponse(expected,response).verifySignatures(),true);
});
test('rejects altered transfer instructions even with a valid wallet signature',()=>{
 const t=tx(),expected=Uint8Array.from(t.serializeMessage());t.instructions[0].data[4]=2;t.partialSign(payer);
 assert.throws(()=>validateWalletResponse(expected,t),/changed the transaction details/);
});
test('rejects missing and corrupt signatures without weakening message validation',()=>{
 const t=tx(),expected=Uint8Array.from(t.serializeMessage());assert.throws(()=>validateWalletResponse(expected,t),/without all required signatures/);
 t.partialSign(payer);t.signatures[0].signature[0]^=1;assert.throws(()=>validateWalletResponse(expected,t),/signature could not be verified/);
});
test('accepts equivalent account ordering without changing programs, amounts, recipients or permissions',()=>{
 const t=tx();t.add(SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:Keypair.generate().publicKey,lamports:2}));
 const expected=t.serializeMessage(),original=t.compileMessage();
 const keys=[...original.accountKeys];[keys[1],keys[2]]=[keys[2],keys[1]];
 const remap=index=>index===1?2:index===2?1:index;
 const reordered=new original.constructor({header:original.header,accountKeys:keys,recentBlockhash:original.recentBlockhash,instructions:original.instructions.map(ix=>({...ix,programIdIndex:remap(ix.programIdIndex),accounts:ix.accounts.map(remap)}))});
 const returned=new VersionedTransaction(reordered);returned.sign([payer]);
 assert.notDeepEqual(Buffer.from(returned.message.serialize()),expected);
 const validated=validateWalletResponse(expected,returned);assert.equal(validated.verifySignatures(),true);assert.deepEqual(Uint8Array.from(validated.serialize()),returned.serialize());
});
test('rejects changed blockhash and added instructions even when signed',()=>{
 for(const change of [t=>{t.recentBlockhash=Keypair.generate().publicKey.toBase58()},t=>{t.add(SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:recipient,lamports:1}))}]){
 const t=tx(),expected=t.serializeMessage();change(t);t.partialSign(payer);assert.throws(()=>validateWalletResponse(expected,t),/changed the transaction details/);
 }
});

const lighthouse=new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95');
const assertion=(variant=5,keys=[{pubkey:payer.publicKey,isSigner:false,isWritable:false}])=>new TransactionInstruction({programId:lighthouse,keys,data:Buffer.from([variant,0,7,0,0])});
function walletAdds(t){
 t.instructions.unshift(ComputeBudgetProgram.setComputeUnitLimit({units:300000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:10000}));
 t.add(assertion());
}
test('reproduces screenshot: compute budget and Lighthouse additions preserve signed bytes',()=>{
 const t=tx(),expected=t.serializeMessage();walletAdds(t);t.partialSign(payer);
 const wire=t.serialize(),result=validateWalletResponse(expected,t);
 assert.deepEqual(result.serialize(),wire);assert.equal(result.verifySignatures(),true);
});
test('wallet assertions may read extra accounts but never add writable accounts or signers',()=>{
 for(const flags of [{isSigner:false,isWritable:false},{isSigner:false,isWritable:true},{isSigner:true,isWritable:false}]){
  const extra=Keypair.generate(),t=tx(),expected=t.serializeMessage();t.add(assertion(5,[{pubkey:extra.publicKey,...flags}]));t.partialSign(payer,...(flags.isSigner?[extra]:[]));
  if(flags.isSigner||flags.isWritable)assert.throws(()=>validateWalletResponse(expected,t),/changed the transaction details/);
  else assert.equal(validateWalletResponse(expected,t).verifySignatures(),true);
 }
});
test('rejects Lighthouse writes, closes, unknown instructions and arbitrary programs',()=>{
 for(const variant of [0,1,16,18,255]){const t=tx(),expected=t.serializeMessage();t.add(assertion(variant));t.partialSign(payer);assert.throws(()=>validateWalletResponse(expected,t),/changed the transaction details/);}
 const t=tx(),expected=t.serializeMessage(),ix=assertion();ix.programId=Keypair.generate().publicKey;t.add(ix);t.partialSign(payer);assert.throws(()=>validateWalletResponse(expected,t),/changed the transaction details/);
});
test('rejects changed trade or additional transfer even alongside legitimate wallet additions',()=>{
 for(const change of [t=>{t.instructions[0].data[4]=2},t=>t.add(SystemProgram.transfer({fromPubkey:payer.publicKey,toPubkey:recipient,lamports:100}))]){
  const t=tx(),expected=t.serializeMessage();change(t);walletAdds(t);t.partialSign(payer);assert.throws(()=>validateWalletResponse(expected,t),/changed the transaction details/);
 }
});
test('rejects excessive priority fees and duplicate compute settings',()=>{
 for(const additions of [[ComputeBudgetProgram.setComputeUnitPrice({microLamports:1000000000})],[ComputeBudgetProgram.setComputeUnitLimit({units:300000}),ComputeBudgetProgram.setComputeUnitLimit({units:300000})]]){
  const t=tx(),expected=t.serializeMessage();t.add(...additions);t.partialSign(payer);assert.throws(()=>validateWalletResponse(expected,t),/changed the transaction details/);
 }
});
