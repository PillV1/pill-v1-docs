import {createHash} from 'node:crypto';
import {PublicKey,TransactionInstruction,SystemProgram} from '@solana/web3.js';
import {addresses,u64} from './instructions.mjs';
import {integer} from './quotes.mjs';
const hash=(...parts)=>createHash('sha256').update(Buffer.concat(parts)).digest();
const pk=v=>new PublicKey(v);
const pda=(program,...seeds)=>PublicKey.findProgramAddressSync(seeds,pk(program))[0];
const meta=(v,writable=false,signer=false)=>({pubkey:pk(v),isWritable:writable,isSigner:signer});
const ix=(program,name,keys,parts=[])=>new TransactionInstruction({programId:pk(program),keys,data:Buffer.concat([hash(Buffer.from(`global:${name}`)).subarray(0,8),...parts])});
export const socialRoundAddress=(program,mint,hour)=>pda(program,Buffer.from('social-round'),addresses(program,mint).launch.toBuffer(),u64(hour));
export const rewardLeaf=(round,owner,amount)=>hash(Buffer.from('yap-v1'),pk(round).toBuffer(),pk(owner).toBuffer(),u64(amount));
const branch=(a,b)=>hash(Buffer.from('yap-node'),...([a,b].sort(Buffer.compare)));
// Rows are frozen, verified scoring output, not arbitrary HTTP client input.
export function rewardTree(round,rows){
 if(!Array.isArray(rows)||rows.length<1||rows.length>10000)throw Error('invalid_recipients');
 const entries=rows.map(r=>({owner:pk(r.owner).toBase58(),amount:integer(r.amount).toString()})).sort((a,b)=>a.owner<b.owner?-1:1);
 if(new Set(entries.map(e=>e.owner)).size!==entries.length||entries.some(e=>BigInt(e.amount)<=0n))throw Error('duplicate_or_zero_recipient');
 let level=entries.map(e=>rewardLeaf(round,e.owner,e.amount));const levels=[level];
 while(level.length>1){const next=[];for(let i=0;i<level.length;i+=2)next.push(i+1<level.length?branch(level[i],level[i+1]):level[i]);levels.push(next);level=next}
 const claims=entries.map((e,index)=>{let at=index;const proof=[];for(let i=0;i<levels.length-1;i++){const sibling=at^1;if(sibling<levels[i].length)proof.push(levels[i][sibling].toString('hex'));at=Math.floor(at/2)}return {...e,proof}});
 return {root:level[0].toString('hex'),budget:entries.reduce((n,e)=>n+BigInt(e.amount),0n).toString(),claims};
}
export function verifyReward(round,claim,root){let h=rewardLeaf(round,claim.owner,claim.amount);for(const sibling of claim.proof){if(!/^[a-f0-9]{64}$/.test(sibling))return false;h=branch(h,Buffer.from(sibling,'hex'))}return h.toString('hex')===root}
export function publishSocialRoundInstruction({program,mint,authority,hour,root,budget}){
 if(!/^[a-f0-9]{64}$/.test(root))throw Error('invalid_root');const a=addresses(program,mint);
 return ix(program,'publish_social_round',[meta(authority,true,true),meta(a.config),meta(a.launch,true),meta(socialRoundAddress(program,mint,hour),true),meta(SystemProgram.programId)],[u64(hour),Buffer.from(root,'hex'),u64(budget)]);
}
export function claimSocialRewardInstruction({program,round,payer,owner,amount,proof}){
 if(!Array.isArray(proof)||proof.length>32||proof.some(p=>! /^[a-f0-9]{64}$/.test(p)))throw Error('invalid_proof');
 const receipt=pda(program,Buffer.from('social-receipt'),pk(round).toBuffer(),pk(owner).toBuffer());const length=Buffer.alloc(4);length.writeUInt32LE(proof.length);
 return ix(program,'claim_social_reward',[meta(payer,true,true),meta(owner,true),meta(round,true),meta(receipt,true),meta(SystemProgram.programId)],[u64(amount),length,...proof.map(p=>Buffer.from(p,'hex'))]);
}
export function expireSocialRoundInstruction({program,mint,round}){return ix(program,'expire_social_round',[meta(addresses(program,mint).launch,true),meta(round,true)])}
