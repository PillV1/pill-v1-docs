import {secp256k1} from '@noble/curves/secp256k1';
import {ed25519} from '@noble/curves/ed25519';
import {keccak_256} from '@noble/hashes/sha3';
import {PublicKey} from '@solana/web3.js';
const hex=bytes=>Buffer.from(bytes).toString('hex');
export function personalHash(message){const bytes=Buffer.from(message,'utf8');return keccak_256(Buffer.concat([Buffer.from('\x19Ethereum Signed Message:\n'+bytes.length),bytes]));}
export function verifyProof(proof,signature,evm,sol){
 if(typeof proof.message!=='string'||typeof signature!=='string'||!/^0x[0-9a-f]+$/i.test(signature))throw Error('onepill_invalid_ownership_proof');
 try{const bytes=Buffer.from(signature.slice(2),'hex');
  if(proof.signer?.toLowerCase()===evm.toLowerCase()){
   if(bytes.length!==65)throw Error();const recovery=bytes[64]>=27?bytes[64]-27:bytes[64];if(recovery>1)throw Error();
   const publicKey=secp256k1.Signature.fromCompact(bytes.subarray(0,64)).addRecoveryBit(recovery).recoverPublicKey(personalHash(proof.message)).toRawBytes(false);
   if('0x'+hex(keccak_256(publicKey.subarray(1)).slice(-20))!==evm.toLowerCase())throw Error();
  }else if(proof.signer===sol){if(bytes.length!==64||!ed25519.verify(bytes,Buffer.from(proof.message),new PublicKey(sol).toBytes()))throw Error();}
  else throw Error();
 }catch{throw Error('onepill_invalid_ownership_proof');}
}
export const paymentData=id=>'0x'+hex(keccak_256(Buffer.from('pay(bytes32)'))).slice(0,8)+id.slice(2).toLowerCase();
