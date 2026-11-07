import {Buffer} from 'buffer';
import {ed25519} from '@noble/curves/ed25519';
import {VersionedTransaction,Message} from '@solana/web3.js';

// Wallets may return buffers from another library/realm or plain Uint8Arrays.
// Compare resolved transaction semantics, then verify the actual signed message.
// Equivalent account-table orderings are valid; changed privileges or actions are not.
function intent(message){
 const keys=message.accountKeys.map(k=>k.toBase58());
 return {payer:keys[0],blockhash:message.recentBlockhash,accounts:keys.map((key,index)=>({key,signer:message.isAccountSigner(index),writable:message.isAccountWritable(index)})).sort((a,b)=>a.key.localeCompare(b.key)),instructions:message.compiledInstructions.map(ix=>({program:keys[ix.programIdIndex],accounts:ix.accountKeyIndexes.map(index=>keys[index]),data:Array.from(ix.data)}))};
}
const COMPUTE='ComputeBudget111111111111111111111111111111';
const LIGHTHOUSE='L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
// Wallet-added instructions must not change the trade or grant extra privileges.
// Lighthouse's published enum: 0/1 write/close memory; 2..15 are assertions.
// Merkle-tree assertion 16 invokes another program and is intentionally excluded.
function compatible(expected,actual){
 if(expected.payer!==actual.payer||expected.blockhash!==actual.blockhash)return false;
 const actualKeys=new Map(actual.accounts.map(a=>[a.key,a]));
 const expectedKeys=new Map(expected.accounts.map(a=>[a.key,a]));
 if(expected.accounts.some(a=>JSON.stringify(a)!==JSON.stringify(actualKeys.get(a.key))))return false;
 if(actual.accounts.some(a=>!expectedKeys.has(a.key)&&(a.signer||a.writable)))return false;
 let cursor=0,units=1400000n,price=0n;
 const computeKinds=new Set(),usedExtras=new Set();
 for(const ix of actual.instructions){
  // Preserve every original instruction, including any original safety checks.
  const original=JSON.stringify(ix)===JSON.stringify(expected.instructions[cursor]);
  if(original){cursor++;if(ix.program!==COMPUTE)continue;}
  const data=Buffer.from(ix.data);
  if(ix.program===COMPUTE){
   if(ix.accounts.length||computeKinds.has(data[0]))return false;
   computeKinds.add(data[0]);
   if(data[0]===2&&data.length===5){units=BigInt(data.readUInt32LE(1));if(units<1n||units>1400000n)return false;}
   else if(data[0]===3&&data.length===9)price=data.readBigUInt64LE(1);
   else if(data[0]===1&&data.length===5){const heap=data.readUInt32LE(1);if(heap<32768||heap>262144||heap%1024)return false;}
   else if(data[0]===4&&data.length===5){const size=data.readUInt32LE(1);if(!size||size>67108864)return false;}
   else return false;
  }else if(ix.program===LIGHTHOUSE){
   if(data.length<3||!((data[0]>=2&&data[0]<=15)||data[0]===17))return false;
   const count=data[0]===4?2:data[0]===15?0:1;
   if(ix.accounts.length!==count)return false;
  }else return false;
  usedExtras.add(ix.program);ix.accounts.forEach(key=>usedExtras.add(key));
 }
 if(cursor!==expected.instructions.length)return false;
 if(actual.accounts.some(a=>!expectedKeys.has(a.key)&&!usedExtras.has(a.key)))return false;
 // Added priority fees cannot exceed 0.001 SOL. Never accept deprecated fee instructions.
 return (units*price+999999n)/1000000n<=1000000n;
}
export function validateWalletResponse(expectedMessage,response){
 if(typeof response?.serialize!=='function')throw Error('Wallet did not return a signed transaction.');
 let signed,wire;
 try{wire=Buffer.from(response.serialize({requireAllSignatures:false,verifySignatures:false}));signed=VersionedTransaction.deserialize(wire)}
 catch{throw Error('Wallet returned an unreadable transaction. No transaction was submitted.');}
 if(signed.version!=='legacy')throw Error('Wallet changed the transaction format. No transaction was submitted.');
 const message=signed.message.serialize();
 const expected=intent(Message.from(expectedMessage)),actual=intent(Message.from(message));
 if(!compatible(expected,actual)){const field=['payer','blockhash','accounts','instructions'].find(key=>JSON.stringify(actual[key])!==JSON.stringify(expected[key]));const expectedKeys=new Map(expected.accounts.map(account=>[account.key,account]));
 const actualKeys=new Map(actual.accounts.map(account=>[account.key,account]));
 const added=actual.accounts.filter(account=>!expectedKeys.has(account.key)).map(account=>account.key);
 const removed=expected.accounts.filter(account=>!actualKeys.has(account.key)).map(account=>account.key);
 const permissions=actual.accounts.filter(account=>expectedKeys.has(account.key)&&JSON.stringify(account)!==JSON.stringify(expectedKeys.get(account.key))).map(account=>({address:account.key,before:expectedKeys.get(account.key),after:account}));
 const programs=actual.instructions.map(ix=>ix.program).filter(program=>!expected.instructions.some(ix=>ix.program===program));
 const diagnostic={reason:field,addedAccounts:added,removedAccounts:removed,permissionChanges:permissions,addedPrograms:[...new Set(programs)],expectedInstructionCount:expected.instructions.length,returnedInstructionCount:actual.instructions.length};
 try{globalThis.sessionStorage?.setItem('pill-wallet-diagnostic',JSON.stringify(diagnostic))}catch{}
 const details=[added.length?'added '+added.join(', '):'',removed.length?'removed '+removed.join(', '):'',permissions.length?'permissions changed for '+permissions.map(item=>item.address+' (signer '+item.before.signer+' → '+item.after.signer+', writable '+item.before.writable+' → '+item.after.writable+')').join(', '):'',programs.length?'added programs '+[...new Set(programs)].join(', '):''].filter(Boolean).join('; ');
 throw Error('Wallet changed the transaction details ('+field+'): '+(details||'instruction data or lifetime differs')+'. No transaction was submitted.');}
 if(signed.signatures.length!==signed.message.header.numRequiredSignatures||signed.signatures.some(sig=>!sig.some(byte=>byte!==0)))throw Error('Wallet returned the transaction without all required signatures. No transaction was submitted.');
 const verified=signed.signatures.every((sig,index)=>ed25519.verify(sig,message,signed.message.staticAccountKeys[index].toBytes()));
 if(!verified)throw Error('Wallet signature could not be verified. No transaction was submitted.');
 return {signature:signed.signatures[0],serialize:()=>Buffer.from(wire),verifySignatures:()=>verified};
}
