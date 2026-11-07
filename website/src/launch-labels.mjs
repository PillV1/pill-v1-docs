export function launchLabels(version,rules){
 if(version===2||rules?.nativePump)return ['New School','Pump Holder Rewards'];
 const v=rules?.version??(version===1?'v1':version===11?'v1.1':null);
 if(v==='v1')return ['Stealth Classic · V1'];
 if(v!=='v1.1')return [];
 const labels=['Stealth · V1.1'];
 if(rules?.commitment!=='finalized')return labels;
 if(rules.graduated)return [...labels,'Graduated · curve rules ended'];
 if(Number.isFinite(rules.maxWalletBps)&&rules.maxWalletBps>0)labels.push(`${rules.maxWalletBps/100}% max wallet`);
 const mode={burn:'Burns',holders:'Holder rewards',liquidity:'Adds liquidity',yap:'Raider rewards',creator:'Creator rewards'}[rules.feeMode];
 if(mode)labels.push(mode);
 if(rules.blockedWalletCount>0)labels.push(`${rules.blockedWalletCount} blocked wallets`);
 if(rules.quickBond)labels.push('Quick bond');
 if(rules.protectionSlots>0)labels.push('Opening protection');
 return labels;
}
