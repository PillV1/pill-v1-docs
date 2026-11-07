"""Read-only SOL deposit verification from a configured, trusted RPC endpoint.
Never accept caller-provided `finalized` flags as a public payment proof.
"""
SYSTEM='11111111111111111111111111111111'
ALPHABET='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
def decoded_length(value):
 if not isinstance(value,str) or not value or len(value)>128:raise ValueError('invalid_base58')
 number=0
 for char in value:
  if char not in ALPHABET:raise ValueError('invalid_base58')
  number=number*58+ALPHABET.index(char)
 return len(value)-len(value.lstrip('1'))+(number.bit_length()+7)//8

def verify_sol_receipts(rpc,signature,expected_genesis):
 if decoded_length(signature)!=64:raise ValueError('invalid_signature')
 if not expected_genesis or rpc.call('getGenesisHash',[])!=expected_genesis:raise ValueError('wrong_network')
 result=rpc.call('getSignatureStatuses',[[signature],{'searchTransactionHistory':True}])
 values=result.get('value',[]) if isinstance(result,dict) else []
 if len(values)!=1 or not values[0] or values[0].get('confirmationStatus')!='finalized':raise ValueError('not_finalized')
 status=values[0]
 if status.get('err') is not None:return []
 tx=rpc.call('getTransaction',[signature,{'encoding':'jsonParsed','commitment':'finalized','maxSupportedTransactionVersion':0}])
 if not tx or tx.get('transaction',{}).get('signatures',[None])[0]!=signature:raise ValueError('transaction_mismatch')
 if type(tx.get('slot')) is not int or tx['slot']!=status.get('slot'):raise ValueError('slot_mismatch')
 if type(tx.get('blockTime')) is not int:raise ValueError('block_time_required')
 meta=tx.get('meta')
 if meta is None:raise ValueError('metadata_missing')
 if meta.get('err') is not None:return []
 instructions=tx['transaction'].get('message',{}).get('instructions')
 if not isinstance(instructions,list) or len(instructions)>1024:raise ValueError('invalid_instructions')
 indexed=[(i<<16,ix) for i,ix in enumerate(instructions)]
 groups=meta.get('innerInstructions') or [];seen=set()
 for group in groups:
  index=group.get('index');inner=group.get('instructions')
  if type(index) is not int or index<0 or index>=len(instructions) or index in seen:raise ValueError('invalid_inner_index')
  if not isinstance(inner,list) or len(inner)>65535:raise ValueError('invalid_inner_instructions')
  seen.add(index);indexed.extend(((index<<16)+j+1,ix) for j,ix in enumerate(inner))
 receipts=[]
 for index,ix in indexed:
  if ix.get('programId')!=SYSTEM:continue
  parsed=ix.get('parsed',{})
  if not isinstance(parsed,dict) or parsed.get('type') not in ('transfer','transferWithSeed'):continue
  info=parsed.get('info',{});source=info.get('source');destination=info.get('destination');amount=info.get('lamports')
  if decoded_length(source)!=32 or decoded_length(destination)!=32:raise ValueError('invalid_transfer_address')
  if type(amount) is not int or not 0<amount<=9_000_000_000_000_000:raise ValueError('invalid_transfer_amount')
  receipts.append({'finalized':True,'successful':True,'source_authorized':True,'signature':signature,
    'instruction_index':index,'sender':source,'destination':destination,'amount':amount,'slot':tx['slot'],'block_time':tx['blockTime']})
 return receipts

def credit_signature(payments,rpc,signature,expected_genesis):
 receipts=verify_sol_receipts(rpc,signature,expected_genesis)
 return [payments.record(receipt) for receipt in receipts]
