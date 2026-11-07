import {classicTradeInstruction,collectClassicFeesInstruction} from '../../sdk/src/classic.mjs';
import {validateWalletResponse} from './wallet-response.mjs';
import {prepareClassicTrade} from '../../sdk/src/classic-client.mjs';
import {prepareTrade as prepareAdvancedTrade} from '../../sdk/src/read-client.mjs';
import {reconcileTrade,confirmTrade} from './trade-status.mjs';
import {base58} from './base58.mjs';
import {Connection,PublicKey,Transaction} from '@solana/web3.js';
export const validateAddress=v=>new PublicKey(v).toBase58();
export function availableWallets(){return [['Phantom',window.phantom?.solana],['Solflare',window.solflare],['Solana wallet',window.solana]].filter(([,p],i,a)=>p&&!a.slice(0,i).some(([,q])=>q===p))}
export async function authenticate(provider,api){
 const result=await provider.connect(),wallet=(result.publicKey??provider.publicKey).toString();
 const challenge=await api.challenge(wallet);if(!challenge.message.startsWith(location.origin+'\n')||challenge.expires*1000<Date.now())throw Error('Invalid sign-in challenge.');
 const signed=await provider.signMessage(new TextEncoder().encode(challenge.message),'utf8'),bytes=signed.signature??signed;
 const signature=btoa(String.fromCharCode(...bytes));await api.verify(challenge.id,signature);return wallet;
}
export async function sendPrepared(provider,prepared,config,onSigned){
 if(!config.rpcUrl||!config.genesis||!config.program)throw Error('Trading deployment is not configured.');
 const connection=new Connection(config.rpcUrl,'confirmed');if(await connection.getGenesisHash()!==config.genesis)throw Error('Wallet network does not match the launchpad.');
 const tx=Transaction.from(Uint8Array.from(atob(prepared.transaction),c=>c.charCodeAt(0)));
 if(!tx.feePayer?.equals(provider.publicKey)||![1,2].includes(tx.instructions.length)||tx.instructions[0].programId.toBase58()!==config.program)throw Error('Unexpected transaction.');
 if(tx.instructions.length===2){
  const trade=tx.instructions[0],collect=tx.instructions[1],mint=trade.keys[2]?.pubkey;
  if(!mint||trade.data.length!==32||!config.treasury)throw Error('Unexpected fee collection.');
  const buy=classicTradeInstruction({program:config.program,mint,trader:provider.publicKey,side:'buy',tokens:1n,limit:1n,deadlineSlot:1n});
  const sell=classicTradeInstruction({program:config.program,mint,trader:provider.publicKey,side:'sell',tokens:1n,limit:1n,deadlineSlot:1n});
  if(![buy,sell].some(ix=>ix.data.subarray(0,8).equals(trade.data.subarray(0,8))))throw Error('Unexpected fee collection.');
  const expected=collectClassicFeesInstruction({program:config.program,mint,treasury:config.treasury});
  if(!collect.programId.equals(expected.programId)||!collect.data.equals(expected.data)||collect.keys.length!==expected.keys.length||collect.keys.some((k,i)=>!k.pubkey.equals(expected.keys[i].pubkey)||k.isSigner!==k.pubkey.equals(tx.feePayer)||!k.isWritable))throw Error('Unexpected fee collection.');
 }
 if(!(await connection.isBlockhashValid(tx.recentBlockhash,{commitment:'confirmed'})).value)throw Error('Quote expired. Please request a new quote.');
 if(prepared.quote?.deadlineSlot&&BigInt(await connection.getSlot('confirmed'))+10n>=BigInt(prepared.quote.deadlineSlot))throw Error('Quote expired. Close this review and request a new quote.');
 const expected=Uint8Array.from(tx.serializeMessage());const signed=validateWalletResponse(expected,await provider.signTransaction(tx));const signature=base58(signed.signature);const bytes=signed.serialize();onSigned?.({signature,lastValidBlockHeight:prepared.lastValidBlockHeight,blockhash:tx.recentBlockhash});const returned=await connection.sendRawTransaction(bytes,{skipPreflight:false,maxRetries:2});if(returned!==signature)throw Error('Unexpected transaction signature returned by RPC.');
 // Keep the exact signature available if confirmation times out; never blindly re-sign.
 return {signature,confirm:()=>confirmTrade(connection,{signature,blockhash:tx.recentBlockhash,lastValidBlockHeight:prepared.lastValidBlockHeight})};
}

export async function reconcilePendingTrade(config,record){const connection=new Connection(config.rpcUrl,"confirmed");if(await connection.getGenesisHash()!==config.genesis)throw Error("Wallet network does not match the launchpad.");return reconcileTrade(connection,record)}

// Trading needs a transaction signature, not a separate website login.
export async function prepareWalletTrade(config,{mint,owner,version,side,amount,slippageBps=100}){
 if(!['v1','v1.1'].includes(version))throw Error('invalid_launch_version');
 const connection=new Connection(config.rpcUrl,'confirmed');
 const prepared=await (version==='v1'?prepareClassicTrade:prepareAdvancedTrade)({connection,program:config.program,mint,trader:owner,expectedGenesis:config.genesis,side,amount,slippageBps});
 const latest=await connection.getLatestBlockhash('confirmed');
 const tx=new Transaction({feePayer:new PublicKey(owner),recentBlockhash:latest.blockhash}).add(prepared.instruction,...(prepared.collectionInstruction?[prepared.collectionInstruction]:[]));
 return {transaction:tx.serialize({requireAllSignatures:false,verifySignatures:true}).toString('base64'),lastValidBlockHeight:latest.lastValidBlockHeight,slot:prepared.contextSlot,quote:JSON.parse(JSON.stringify(prepared.quote,(_,v)=>typeof v==='bigint'?v.toString():v)),requiresWalletSignature:true};
}
