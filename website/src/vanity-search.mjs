import {Keypair} from '@solana/web3.js';
const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function suffixMatcher(suffix){
 if(!suffix||suffix.length>4||[...suffix].some(c=>!alphabet.includes(c)))throw Error('Invalid mint suffix');
 const modulus=58**suffix.length,target=[...suffix].reduce((n,c)=>n*58+alphabet.indexOf(c),0);
 // A four-character Base58 suffix depends only on the integer modulo 58^4.
 // These intermediate values remain exact safe integers.
 return bytes=>{let n=0;for(const b of bytes)n=(n*256+b)%modulus;return n===target};
}
export async function searchVanity(suffix,onProgress,generate=()=>Keypair.generate()){
 const matches=suffixMatcher(suffix);let attempts=0;
 for(;;){for(let i=0;i<256;i++){
  const mint=generate();attempts++;
  if(matches(mint.publicKey.toBytes())&&mint.publicKey.toBase58().endsWith(suffix))return mint;
 }
 onProgress(attempts);
 await new Promise(resolve=>setTimeout(resolve,0));
 }
}
