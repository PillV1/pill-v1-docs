import test from 'node:test';import assert from 'node:assert/strict';import {settlementQuote} from '../sdk/src/pool-settlement.mjs';
const fixture={budget:100000000n,baseReserve:200000000000000n,quoteReserve:85000000000n,effectiveQuote:84999900000n,lpSupply:100000000000n,feeBps:125n,liquidity:false};
test('residual pool settlement budgets fees, positive slippage minimums, and paired LP minimums',()=>{
 const burn=settlementQuote(fixture);assert.equal(burn.minLp,0n);assert(burn.minTokens>0n);assert(burn.minTokens<fixture.baseReserve*fixture.budget/(fixture.effectiveQuote+fixture.budget));
 const lp=settlementQuote({...fixture,liquidity:true});assert(lp.minLp>0n);assert(lp.minTokens<burn.minTokens);assert.equal(lp.budget,fixture.budget);
});
test('pool settlement rejects invalid reserves, unbounded budgets and excessive fee configurations',()=>{
 for(const overrides of [{budget:100000001n},{budget:0n},{baseReserve:0n},{effectiveQuote:0n},{feeBps:1001n},{feeBps:-1n},{lpSupply:0n},{budget:1n,liquidity:true}])assert.throws(()=>settlementQuote({...fixture,...overrides}));
});

import {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';import {Keypair,PublicKey,Transaction} from '@solana/web3.js';
import {TOKEN_PROGRAM_ID,NATIVE_MINT,getAssociatedTokenAddressSync} from '@solana/spl-token';
import {DEVELOPMENT_PROGRAM,addresses,PUMP_SWAP} from '../sdk/src/instructions.mjs';
import {poolSettlementInstruction,FEE_PROGRAM} from '../sdk/src/pool-settlement.mjs';
test('pool settlement builder validates pool identity, uses captured fees and fits a signed packet without claim custody',async()=>{
 const program=DEVELOPMENT_PROGRAM,mint=Keypair.generate().publicKey,operator=Keypair.generate(),a=addresses(program,mint),pool=Keypair.generate().publicKey,lp=PublicKey.findProgramAddressSync([Buffer.from('pool_lp_mint'),pool.toBuffer()],PUMP_SWAP)[0],base=getAssociatedTokenAddressSync(mint,pool,true),quote=getAssociatedTokenAddressSync(NATIVE_MINT,pool,true);
 const p=Buffer.alloc(300);createHash('sha256').update('account:Pool').digest().subarray(0,8).copy(p);for(const [offset,key] of [[11,a.authority],[43,mint],[75,NATIVE_MINT],[107,lp],[139,base],[171,quote]])key.toBuffer().copy(p,offset);p.writeBigUInt64LE(fixture.lpSupply,203);
 const token=(mint,amount)=>{const data=Buffer.alloc(165);mint.toBuffer().copy(data);pool.toBuffer().copy(data,32);data.writeBigUInt64LE(amount,64);return {owner:TOKEN_PROGRAM_ID,data}};
 const g=JSON.parse(readFileSync(new URL('../artifacts/external/pumpswap-global.json',import.meta.url))),f=JSON.parse(readFileSync(new URL('../artifacts/external/pumpswap-fees.json',import.meta.url))).result.value,c=Buffer.alloc(40);c.writeBigUInt64LE(100n);
 const rows=[{owner:PUMP_SWAP,data:p},token(mint,fixture.baseReserve),token(NATIVE_MINT,fixture.quoteReserve),{owner:PUMP_SWAP,data:Buffer.from(g.dataBase64,'base64')},{owner:FEE_PROGRAM,data:Buffer.from(f.data[0],'base64')},{owner:new PublicKey('Sysvar1111111111111111111111111111111111111'),data:c}];
 const connection={getMultipleAccountsInfoAndContext:async()=>({context:{slot:100},value:rows})},launch={pool:pool.toBase58(),sniperFees:0n,coinFees:100000000n,args:{feeMode:'liquidity'}};
 const ix=await poolSettlementInstruction({connection,program,mint,operator:operator.publicKey,launch});assert(ix.data.readBigUInt64LE(16)>0n);assert(ix.data.readBigUInt64LE(24)>0n);assert.equal(ix.data.readBigUInt64LE(32),120n);assert(!ix.keys.some(k=>k.pubkey.equals(a.vault)));
 const tx=new Transaction({feePayer:operator.publicKey,recentBlockhash:Keypair.generate().publicKey.toBase58()}).add(ix);tx.sign(operator);assert(tx.serialize().length<=1232);
 p[43]^=1;await assert.rejects(()=>poolSettlementInstruction({connection,program,mint,operator:operator.publicKey,launch}),/identity/);
});
