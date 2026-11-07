import {Connection,PublicKey,Transaction,TransactionInstruction,SystemProgram} from '@solana/web3.js';
import {getAccount,getMint,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction,createSyncNativeInstruction,createCloseAccountInstruction,TOKEN_PROGRAM_ID,TOKEN_2022_PROGRAM_ID,NATIVE_MINT} from '@solana/spl-token';
import {validateWalletResponse} from './wallet-response.mjs';
import {base58} from './base58.mjs';
const POOL='cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',COMPUTE='ComputeBudget111111111111111111111111111111';
const same=(a,b)=>a.programId.equals(b.programId)&&a.data.equals(b.data)&&JSON.stringify(a.keys.map(k=>[k.pubkey.toBase58(),k.isSigner,k.isWritable]))===JSON.stringify(b.keys.map(k=>[k.pubkey.toBase58(),k.isSigner,k.isWritable]));
export function validatePangeaQuote(q,{owner,mint,pool,side,amount}){
 if(q.chain!=='solana'||q.fromChain!=='solana'||q.crossChain||q.mode!=='direct'||q.details?.venue!=='meteora-direct'||q.details.currencyIn.amount!==amount)throw Error('Unexpected Solana quote.');
 const minimum=BigInt(q.details.currencyOut.minimumAmount||0);if(minimum<=0n||minimum>BigInt(q.details.currencyOut.amount))throw Error('Invalid minimum received.');
 const items=q.steps?.flatMap(s=>s.items??[])??[];if(items.length!==1||items[0].data?.addressLookupTableAddresses?.length)throw Error('Unsupported swap route.');
 const raw=items[0].data.instructions;if(!Array.isArray(raw)||raw.length>12)throw Error('Unsupported swap instructions.');
 const ownerKey=new PublicKey(owner),mintKey=new PublicKey(mint),wsol=getAssociatedTokenAddressSync(NATIVE_MINT,ownerKey),ata=getAssociatedTokenAddressSync(mintKey,ownerKey,false,TOKEN_2022_PROGRAM_ID);
 const allowed=[createAssociatedTokenAccountIdempotentInstruction(ownerKey,wsol,ownerKey,NATIVE_MINT),createAssociatedTokenAccountIdempotentInstruction(ownerKey,ata,ownerKey,mintKey,TOKEN_2022_PROGRAM_ID),createSyncNativeInstruction(wsol),createCloseAccountInstruction(wsol,ownerKey,ownerKey)];
 if(side==='buy')allowed.push(SystemProgram.transfer({fromPubkey:ownerKey,toPubkey:wsol,lamports:BigInt(amount)}));
 let swaps=0,transfer=0,units=0n,price=0n;const seen=new Set();
 const instructions=raw.map(r=>{if(!/^(?:[0-9a-f]{2})+$/i.test(r.data))throw Error('Invalid instruction data.');const ix=new TransactionInstruction({programId:new PublicKey(r.programId),keys:r.keys.map(k=>({...k,pubkey:new PublicKey(k.pubkey)})),data:Buffer.from(r.data,'hex')});
 if(ix.keys.some(k=>k.isSigner&&!k.pubkey.equals(ownerKey)))throw Error('Unexpected signer.');
 if(r.programId===COMPUTE){if(ix.keys.length||seen.has('compute'+ix.data[0]))throw Error('Invalid priority fee.');seen.add('compute'+ix.data[0]);if(ix.data[0]===2&&ix.data.length===5)units=BigInt(ix.data.readUInt32LE(1));else if(ix.data[0]===3&&ix.data.length===9)price=ix.data.readBigUInt64LE(1);else throw Error('Unsupported compute instruction.');}
 else if(r.programId===POOL){swaps++;const keys=ix.keys.map(k=>k.pubkey.toBase58());if(ix.data.length!==24||ix.data.subarray(0,8).toString('hex')!=='f8c69e91e17587c8'||ix.data.readBigUInt64LE(8)!==BigInt(amount)||ix.data.readBigUInt64LE(16)!==minimum||keys[1]!==pool||keys[2]!==(side==='buy'?wsol:ata).toBase58()||keys[3]!==(side==='buy'?ata:wsol).toBase58()||keys[6]!==mint||keys[7]!==NATIVE_MINT.toBase58()||keys[8]!==owner||keys[9]!==TOKEN_2022_PROGRAM_ID.toBase58()||keys[10]!==TOKEN_PROGRAM_ID.toBase58())throw Error('Swap does not match this coin or quote.');}
 else {const n=allowed.findIndex(a=>same(a,ix));if(n<0||seen.has(n))throw Error('Unexpected token or SOL instruction.');seen.add(n);if(ix.programId.equals(SystemProgram.programId))transfer++;}
 return ix;});
 if(swaps!==1||transfer!==(side==='buy'?1:0)||units<=0n||units>1400000n||(units*price+999999n)/1000000n>1000000n)throw Error('Invalid swap or network fee.');
 return instructions;
}
export async function prepareOnepillTrade(config,q,intent){
 const instructions=validatePangeaQuote(q,intent),connection=new Connection(config.rpcUrl,'confirmed');
 if(await connection.getGenesisHash()!==config.genesis)throw Error('Wrong Solana network.');
 const pool=await connection.getAccountInfo(new PublicKey(intent.pool));if(!pool?.owner.equals(new PublicKey(POOL)))throw Error('Solana pool could not be verified.');
 const latest=await connection.getLatestBlockhash('confirmed');const tx=new Transaction({feePayer:new PublicKey(intent.owner),recentBlockhash:latest.blockhash}).add(...instructions);
 return {tx,connection,latest,owner:intent.owner};
}
export async function sendOnepillTrade(provider,prepared,onSent){
 if(provider?.publicKey?.toString()!==prepared.owner)throw Error('Reconnect the wallet used for this quote.');
 const {tx,connection,latest}=prepared;if(!(await connection.isBlockhashValid(latest.blockhash)).value)throw Error('Quote expired. Request a new quote.');
 const signed=validateWalletResponse(tx.serializeMessage(),await provider.signTransaction(tx));const signature=base58(signed.signature);
 onSent(signature);
 try{await connection.sendRawTransaction(signed.serialize(),{skipPreflight:false,maxRetries:2});const result=await connection.confirmTransaction({...latest,signature},'confirmed');if(result.value.err)throw Error('Trade failed on chain.')}catch(error){error.signature=signature;throw error}
 return signature;
}
export async function checkOnepillPending(config,record){const connection=new Connection(config.rpcUrl,'confirmed');const r=(await connection.getSignatureStatuses([record.signature],{searchTransactionHistory:true})).value[0];if(r?.err)return 'failed';if(r?.confirmationStatus==='confirmed'||r?.confirmationStatus==='finalized')return 'confirmed';if(!r&&await connection.getBlockHeight('confirmed')>record.lastValidBlockHeight)return 'expired';return 'pending';}

export async function readOnepillBalance(config,owner,mint){
 const connection=new Connection(config.rpcUrl,'confirmed'),key=new PublicKey(mint),user=new PublicKey(owner);
 if(await connection.getGenesisHash()!==config.genesis)throw Error('Wrong Solana network.');
 const info=await getMint(connection,key,'confirmed',TOKEN_2022_PROGRAM_ID),ata=getAssociatedTokenAddressSync(key,user,false,TOKEN_2022_PROGRAM_ID);
 const raw=await connection.getAccountInfo(ata,'confirmed');
 if(!raw)return {owner,mint,amount:'0',decimals:info.decimals};
 const account=await getAccount(connection,ata,'confirmed',TOKEN_2022_PROGRAM_ID);
 if(!account.owner.equals(user)||!account.mint.equals(key))throw Error('Token balance could not be verified.');
 return {owner,mint,amount:account.amount.toString(),decimals:info.decimals};
}
export async function readOnepillReceipt(config,signature,{owner,mint,pool}){
 const connection=new Connection(config.rpcUrl,'confirmed');
 const tx=await connection.getParsedTransaction(signature,{commitment:'confirmed',maxSupportedTransactionVersion:0});
 if(!tx||tx.meta?.err||!tx.blockTime)return null;
 const instructions=tx.transaction.message.instructions,index=instructions.findIndex(ix=>ix.programId.toString()===POOL&&ix.accounts?.[1]?.toString()===pool&&ix.accounts?.[8]?.toString()===owner);
 if(index<0)throw Error('Confirmed transaction does not match this pool.');
 const sum=items=>(items||[]).filter(b=>b.mint===mint&&b.owner===owner).reduce((n,b)=>n+BigInt(b.uiTokenAmount.amount),0n),delta=sum(tx.meta.postTokenBalances)-sum(tx.meta.preTokenBalances);
 const token=(tx.meta.postTokenBalances||[]).find(b=>b.mint===mint&&b.owner===owner)||(tx.meta.preTokenBalances||[]).find(b=>b.mint===mint&&b.owner===owner);
 if(!token||delta===0n)return null;
 const side=delta>0n?'buy':'sell',wsol=getAssociatedTokenAddressSync(NATIVE_MINT,new PublicKey(owner)).toString();let quote=0n;
 for(const ix of tx.meta.innerInstructions?.find(g=>g.index===index)?.instructions||[]){const p=ix.parsed;if(ix.programId.toString()!==TOKEN_PROGRAM_ID.toString()||!['transfer','transferChecked'].includes(p?.type))continue;const info=p.info;if((side==='buy'?info.source:info.destination)!==wsol)continue;quote+=BigInt(info.amount??info.tokenAmount?.amount??0);}
 if(quote<=0n)return null;
 return {chain:'solana',id:'solana:'+tx.slot+':'+signature,txHash:signature,maker:owner,side,tokenAmount:Number(delta<0n?-delta:delta)/10**token.uiTokenAmount.decimals,quoteAmount:Number(quote)/1e9,timestamp:tx.blockTime,confirmed:true};
}
