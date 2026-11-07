import {prepareWalletTrade,sendPrepared} from './wallet.mjs';
import {PublicKey,Connection} from '@solana/web3.js';
const config={rpcUrl:'https://solana-rpc.publicnode.com',genesis:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',program:'FretS4xrZsx8VHf7Aw8VbishTRskq3nbmpQKuyHbJxAz'};
const owner='CjNLWVWhVAqBjFrp4YWhJb4wLhg5p5ZcfffE1g3eUtsA',mint='inrdX5yJKU5PW4gr7si55Gdept9tMy2QMyZtAebfMkB';
const out=document.querySelector('pre');
for(const [side,amount] of [['buy','1000000'],['sell','3488296484635']]){
 try{
 const prepared=await prepareWalletTrade(config,{mint,owner,version:'v1',side,amount,slippageBps:100});
 const response=await fetch(config.rpcUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'simulateTransaction',params:[prepared.transaction,{encoding:'base64',sigVerify:false,commitment:'confirmed'}]})});
 const simulation=await response.json();if(simulation.error||simulation.result.value.err)throw Error(JSON.stringify(simulation));
 out.textContent+=JSON.stringify({side,lastValid:prepared.lastValidBlockHeight,current:await new Connection(config.rpcUrl).getBlockHeight('confirmed'),quoteSlot:prepared.slot,currentSlot:await new Connection(config.rpcUrl).getSlot('confirmed'),deadline:prepared.quote.deadlineSlot})+'\n';let reached=false;try{await sendPrepared({publicKey:new PublicKey(owner),signTransaction:async()=>{reached=true;throw Error('Stopped before signing')}},prepared,config)}catch(e){if(!reached)throw e}
 out.textContent+=side+': quote prepared; unsigned mainnet simulation passed; wallet approval reached. No signing or broadcasting.\n';
 }catch(e){out.textContent+=side+': FAIL '+e.message+'\n'}
}
