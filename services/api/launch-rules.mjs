import {PublicKey} from '@solana/web3.js';
import {CLASSIC,classicAddresses,decodeClassicLaunch} from '../../sdk/src/classic.mjs';
import {addresses} from '../../sdk/src/instructions.mjs';
import {decodeLaunch} from '../../sdk/src/accounts.mjs';
export async function readLaunchRules({connection,program,genesis,mint}){
 mint=new PublicKey(mint);program=new PublicKey(program);
 if(!genesis||await connection.getGenesisHash()!==genesis)throw Error('wrong_cluster');
 const classic=classicAddresses(program,mint),enhanced=addresses(program,mint);
 const r=await connection.getMultipleAccountsInfoAndContext([classic.launch,enhanced.launch],{commitment:'finalized'});
 if(!Number.isSafeInteger(r.context?.slot)||r.value?.length!==2)throw Error('invalid_rpc_snapshot');
 if(r.value[0]&&r.value[1])throw Error('ambiguous_launch');
 if(r.value[0]){
 const l=decodeClassicLaunch({account:r.value[0],address:classic.launch,program,mint});
 return {curve:curveSnapshot(l,{...CLASSIC,virtualQuote:CLASSIC.virtualSol}),graduationCostSource:'curve',maxGraduationSetupLamports:'50000000',version:'v1',feeBps:220,platformFeeBps:220,buySlotCapBps:100,buySlotCapScope:'all-wallets-pregraduation',feeMode:'protocol',maxWalletBps:null,blockedWalletCount:0,quickBond:false,developerBuyLamports:'0',protectionSlots:0,graduated:l.graduated,slot:r.context.slot,commitment:'finalized'};
 }
 const l=decodeLaunch({account:r.value[1],address:enhanced.launch,program,mint});
 return {curve:curveSnapshot(l,l.args),graduationCostSource:'curve',maxGraduationSetupLamports:'50000000',version:'v1.1',feeBps:250,platformFeeBps:220,customFeeBps:30,buySlotCapBps:100,buySlotCapScope:'all-wallets-pregraduation',feeMode:l.args.feeMode,maxWalletBps:Number(l.args.maxWalletBps),blockedWalletCount:l.args.blocked.length+Number(l.args.extraBlockedCount),quickBond:l.args.quickBond,developerBuyLamports:l.args.developerBuyLamports.toString(),protectionSlots:Number(l.args.protectionSlots),graduated:l.graduated,slot:r.context.slot,commitment:'finalized'};
}

export function curveSnapshot(launch,args){
 const {supply,saleTokens,virtualTokens,virtualQuote}=args,sold=launch.sold,reserve=launch.quote;
 const remaining=saleTokens>sold?saleTokens-sold:0n;
 const cap=(virtualQuote+reserve)*supply/(virtualTokens-sold);
 const finalVirtualQuote=((virtualQuote+reserve)*(virtualTokens-sold)+(virtualTokens-saleTokens)-1n)/(virtualTokens-saleTokens);
 return {saleTokensRaw:saleTokens.toString(),soldTokensRaw:sold.toString(),remainingTokensRaw:remaining.toString(),reserveLamports:reserve.toString(),progressBps:Number(sold*10000n/saleTokens),marketCapLamports:launch.graduated?null:cap.toString(),estimatedGraduationMarketCapLamports:(finalVirtualQuote*supply/(virtualTokens-saleTokens)).toString()};
}
