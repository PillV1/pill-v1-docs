import {createHash} from 'node:crypto';
import {PublicKey,TransactionInstruction,SystemProgram} from '@solana/web3.js';
export const UPGRADEABLE_LOADER=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
export function deploymentAddresses(program){
 program=new PublicKey(program);
 return {program,config:PublicKey.findProgramAddressSync([Buffer.from('config')],program)[0],programData:PublicKey.findProgramAddressSync([program.toBuffer()],UPGRADEABLE_LOADER)[0]};
}
export function initializeInstruction({program,authority,treasury}){
 const a=deploymentAddresses(program);authority=new PublicKey(authority);treasury=new PublicKey(treasury);
 if(authority.equals(SystemProgram.programId)||treasury.equals(SystemProgram.programId))throw Error('invalid_authority_or_treasury');
 return new TransactionInstruction({programId:a.program,keys:[
  {pubkey:authority,isSigner:true,isWritable:true},
  {pubkey:a.config,isSigner:false,isWritable:true},
  {pubkey:a.program,isSigner:false,isWritable:false},
  {pubkey:a.programData,isSigner:false,isWritable:false},
  {pubkey:SystemProgram.programId,isSigner:false,isWritable:false},
 ],data:Buffer.concat([createHash('sha256').update('global:initialize').digest().subarray(0,8),treasury.toBuffer()])});
}
// Validate the loader's actual authority before preparing initialization.
export function verifyProgramAuthority({program,authority,programAccount,dataAccount}){
 const a=deploymentAddresses(program);
 if(!programAccount?.executable||!new PublicKey(programAccount.owner).equals(UPGRADEABLE_LOADER)||programAccount.data.length!==36||programAccount.data.readUInt32LE(0)!==2||!new PublicKey(programAccount.data.subarray(4)).equals(a.programData))throw Error('program_not_deployed');
 if(!dataAccount||!new PublicKey(dataAccount.owner).equals(UPGRADEABLE_LOADER)||dataAccount.data.length<45||dataAccount.data.readUInt32LE(0)!==3||dataAccount.data[12]!==1||!new PublicKey(dataAccount.data.subarray(13,45)).equals(new PublicKey(authority)))throw Error('upgrade_authority_mismatch');
 return a;
}
