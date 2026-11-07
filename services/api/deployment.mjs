import {PublicKey} from '@solana/web3.js';
import {decodeConfig} from '../../sdk/src/accounts.mjs';
export async function verifyDeployment(connection,{program,genesis,treasury,operator}){
 if(!genesis||!treasury||!operator)throw Error('deployment_configuration_required');
 if(await connection.getGenesisHash()!==genesis)throw Error('wrong_cluster');
 program=new PublicKey(program);const address=PublicKey.findProgramAddressSync([Buffer.from('config')],program)[0];
 const result=await connection.getMultipleAccountsInfoAndContext([program,address],{commitment:'finalized'});
 if(!result.value[0]?.executable)throw Error('program_not_deployed');
 const config=decodeConfig({program,address,account:result.value[1]});
 if(config.treasury!==new PublicKey(treasury).toBase58()||config.operator!==new PublicKey(operator).toBase58())throw Error('deployment_authority_mismatch');
 return config;
}
