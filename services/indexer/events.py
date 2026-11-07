"""Strict Anchor event parsing scoped to the currently executing program."""
import base64,hashlib,re,struct
ALPHABET='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
def base58(data):
 n=int.from_bytes(data,'big');s=''
 while n:n,r=divmod(n,58);s=ALPHABET[r]+s
 return '1'*(len(data)-len(data.lstrip(b'\0')))+s
LAYOUTS={
 'GraduationCosts':[('launch','key'),('setup_lamports','u64'),('max_setup_lamports','u64')],
 'CurveConfigured':[('launch','key'),('sale_tokens','u64'),('supply','u64'),('virtual_tokens','u64'),('virtual_quote','u64')],
 'LaunchVersionSelected':[('launch','key'),('mint','key'),('version','version')],
 'CreatorFeesPaid':[('launch','key'),('creator','key'),('amount','u64')],
 'CreatorTokensLocked':[('launch','key'),('creator','key'),('amount','u64')],
 'CreatorVestingPaid':[('launch','key'),('creator','key'),('amount','u64')],
 'BondedTickerReleased':[('launch','key'),('last_trade','i64'),('observed_at','i64')],
 'PoolFeesSettled':[('launch','key'),('spent','u64'),('burned','u64'),('liquidity','bool'),('sniper','bool')],
 'LaunchCancelled':[('launch','key'),('launcher','key'),('recovered','u64')],
 'ActivationRequested':[('launch','key'),('randomness','key')],
 'LaunchActivated':[('launch','key'),('randomness','key'),('start_slot','u64'),('protection_slots','u64')],
 'SocialRoundPublished':[('launch','key'),('round','key'),('hour','u64'),('budget','u64'),('root','hash')],
 'SocialRewardPaid':[('launch','key'),('round','key'),('owner','key'),('amount','u64')],
 'SocialRoundExpired':[('launch','key'),('round','key'),('amount','u64')],
 'TokenMetadataPublished':[('launch','key'),('name','text32'),('symbol','text10'),('uri','text200')],
 'MetadataProposed':[('launch','key'),('proposal','key'),('proposer','key')],
 'MetadataLiked':[('launch','key'),('proposal','key'),('owner','key')],
 'MetadataUpdated':[('launch','key'),('proposal','key')],
 'DeveloperAllocated':[('launch','key'),('owner','key'),('tokens','u64'),('unlock_at','i64')],
 'PositionTransferred':[('launch','key'),('sender','key'),('recipient','key'),('amount','u64'),('sequence','u64')],
 'LaunchCreated':[('launch','key'),('mint','key'),('creator','key'),('treasury','key')],
 'TradeRecorded':[('launch','key'),('trader','key'),('sequence','u64'),('buy','bool'),('tokens','u64'),('quote','u64'),('fee','u64')],
 'TreasuryPaid':[('launch','key'),('amount','u64')],
 'TokensClaimed':[('launch','key'),('owner','key'),('amount','u64')],
 'Graduated':[('launch','key'),('pool','key'),('quote','u64'),('tokens','u64')],
 'CoinFeesUsed':[('launch','key'),('mode','mode'),('quote','u64'),('tokens','u64')],
}
TAGS={hashlib.sha256(('event:'+name).encode()).digest()[:8]:name for name in LAYOUTS}
def decode(data):
 name=TAGS.get(data[:8])
 if name is None:return None
 pos=8;out={'kind':name}
 for field,typ in LAYOUTS[name]:
  if typ.startswith('text'):
   if len(data)<pos+4:raise ValueError('truncated_event')
   size=struct.unpack('<I',data[pos:pos+4])[0];pos+=4
   if size>int(typ[4:]) or len(data)<pos+size:raise ValueError('invalid_event_string')
   out[field]=data[pos:pos+size].decode('utf-8',errors='strict');pos+=size;continue
  size={'key':32,'hash':32,'u64':8,'i64':8,'bool':1,'mode':1,'version':1}[typ]
  if len(data)<pos+size:raise ValueError('truncated_event')
  part=data[pos:pos+size];pos+=size
  if typ=='key':v=base58(part)
  elif typ=='hash':v=part.hex()
  elif typ=='u64':v=str(struct.unpack('<Q',part)[0])
  elif typ=='i64':v=str(struct.unpack('<q',part)[0])
  elif typ=='version':
   if part[0] not in (1,11):raise ValueError('invalid_launch_version')
   v=part[0]
  elif typ=='bool':
   if part[0]>1:raise ValueError('invalid_bool')
   v=bool(part[0])
  else:
   if part[0]>4:raise ValueError('invalid_fee_mode')
   v=['burn','holders','liquidity','yap','creator'][part[0]]
  out[field]=v
 if len(data)!=pos:raise ValueError('unexpected_event_length')
 return out
INVOKE=re.compile(r'^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)\]$')
END=re.compile(r'^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (?:success|failed:.*)$')
def transaction_events(program,signature,transaction,*,finalized):
 if not finalized:raise ValueError('finality_required')
 if not transaction or not isinstance(transaction.get('slot'),int):raise ValueError('transaction_missing')
 meta=transaction.get('meta')
 if meta is None:raise ValueError('meta_missing')
 if meta.get('err') is not None:return []
 stack=[];events=[]
 for index,line in enumerate(meta.get('logMessages') or []):
  match=INVOKE.fullmatch(line)
  if match:
   depth=int(match[2])
   if depth!=len(stack)+1:raise ValueError('invalid_invocation_stack')
   stack.append(match[1]);continue
  match=END.fullmatch(line)
  if match:
   if not stack or stack[-1]!=match[1]:raise ValueError('invalid_invocation_stack')
   stack.pop();continue
  if line.startswith('Program data: ') and stack and stack[-1]==program:
   raw=base64.b64decode(line[14:],validate=True)
   if len(raw)>4096:raise ValueError('event_too_large')
   body=decode(raw)
   if body is not None:events.append({'program':program,'signature':signature,'event_index':index,'slot':transaction['slot'],'body':body})
 if stack:raise ValueError('truncated_logs')
 return events
