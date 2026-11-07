"""Failed direct buys are audit observations, never successful trade/fee events."""
import hashlib
from pump_market import unbase58
BUY=hashlib.sha256(b'global:buy').digest()[:8]
def blocked_buy(program,signature,tx):
 err=(tx.get('meta') or {}).get('err');failure=err.get('InstructionError') if isinstance(err,dict) else None
 if not isinstance(failure,list) or len(failure)!=2 or failure[1]!={'Custom':6007}:return []
 message=tx['transaction']['message'];instructions=message.get('instructions',[]);at=failure[0]
 if type(at) is not int or not 0<=at<len(instructions):raise ValueError('invalid_failed_instruction')
 keys=message['accountKeys'];loaded=tx['meta'].get('loadedAddresses') or {};keys=keys+loaded.get('writable',[])+loaded.get('readonly',[])
 ix=instructions[at];program_index=ix.get('programIdIndex')
 if type(program_index) is not int or not 0<=program_index<len(keys) or keys[program_index]!=program:return []
 raw=unbase58(ix.get('data',''));accounts=ix.get('accounts',[])
 if len(raw)!=32 or raw[:8]!=BUY or len(accounts)<2:return []
 trader,launch=accounts[:2];required=message.get('header',{}).get('numRequiredSignatures',0)
 if any(type(index) is not int or not 0<=index<len(keys) for index in accounts) or not 0<=trader<required:return []
 if tx['transaction']['signatures'][0]!=signature or type(tx.get('slot')) is not int:raise ValueError('failed_transaction_identity')
 return [{'signature':signature,'event_index':0,'slot':tx['slot'],'program':program,'body':{'kind':'TradeRefused','launch':keys[launch],'trader':keys[trader],'reason':'wallet_blocked','requestedLamports':str(int.from_bytes(raw[8:16],'little')),'source':'finalized_transaction_error','tradeExecuted':False}}]
