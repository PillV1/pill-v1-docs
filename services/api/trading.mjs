import {PublicKey,Transaction} from '@solana/web3.js';
import {prepareClassicTrade} from '../../sdk/src/classic-client.mjs';
import {prepareTrade} from '../../sdk/src/read-client.mjs';
// Builds a single canonical instruction; never signs caller-provided transactions.
export class Trading {
 constructor({identity,connection,program,genesis,appSigner}){Object.assign(this,{identity,connection,program,genesis,appSigner})}
 async prepare(session,input,now){
  const user=this.identity.session(session,now),mint=new PublicKey(input.mint);
  if(input.version!==undefined&&!['v1','v1.1'].includes(input.version))throw Error('invalid_launch_version');
  const prepared=await (input.version==='v1'?prepareClassicTrade:prepareTrade)({connection:this.connection,program:this.program,mint,trader:user.wallet,expectedGenesis:this.genesis,side:input.side,amount:input.amount,slippageBps:input.slippageBps??100,appAuthority:this.appSigner?.publicKey});
  const latest=await this.connection.getLatestBlockhash('confirmed');
  const tx=new Transaction({feePayer:new PublicKey(user.wallet),recentBlockhash:latest.blockhash}).add(prepared.instruction,...(prepared.collectionInstruction?[prepared.collectionInstruction]:[]));
  if(this.appSigner&&input.version!=='v1')tx.partialSign(this.appSigner);
  return {transaction:tx.serialize({requireAllSignatures:false,verifySignatures:true}).toString('base64'),lastValidBlockHeight:latest.lastValidBlockHeight,slot:prepared.contextSlot,quote:JSON.parse(JSON.stringify(prepared.quote,(_,v)=>typeof v==='bigint'?v.toString():v)),requiresWalletSignature:true};
 }
}
