"""Versioned, explainable launch indicators. Not a safety guarantee or fraud verdict.
Caller must supply finalized trades AND a finalized current holder snapshot. Trade
receipts alone cannot determine current balances (SPL tokens may be transferred).
"""
from collections import defaultdict
POLICY='pill-launch-indicators-v1'
def launch_safety(*,created_slot,supply,creator,trades,holders,snapshot_slot,complete_history,finalized):
 unknown={'policy':POLICY,'grade':None,'status':'insufficient_data','reasons':[]}
 if not finalized or not complete_history or holders is None:return unknown
 if type(created_slot) is not int or type(snapshot_slot) is not int or snapshot_slot<created_slot:raise ValueError('invalid_snapshot')
 if type(supply) is not int or supply<=0:raise ValueError('invalid_supply')
 if any(not isinstance(w,str) or not w or type(n) is not int or n<0 for w,n in holders.items()) or sum(holders.values())>supply:raise ValueError('invalid_holders')
 early=set();blocks=defaultdict(set);dev_sold=0;seen=set()
 for t in trades:
  if type(t.get('slot')) is not int or not created_slot<=t['slot']<=snapshot_slot:raise ValueError('invalid_trade_slot')
  if type(t.get('tokens')) is not int or t['tokens']<=0 or type(t.get('buy')) is not bool or not isinstance(t.get('trader'),str) or not t['trader']:raise ValueError('invalid_trade')
  key=(t['signature'],t['event_index'])
  if key in seen:continue
  seen.add(key)
  if t['buy']:
   # Same-block timing is a signal only, not proof of common ownership or a bundle.
   if t['slot']<created_slot+4:early.add(t['trader'])
   if t['slot']<created_slot+20:blocks[t['slot']].add(t['trader'])
  elif t['trader']==creator:dev_sold+=t['tokens']
 clustered=set().union(*(w for w in blocks.values() if len(w)>=3)) if blocks else set()
 def held_bps(wallets):return sum(holders.get(w,0) for w in wallets)*10000//supply
 early_bps=held_bps(early);cluster_bps=held_bps(clustered);top10=sum(sorted(holders.values(),reverse=True)[:10])*10000//supply
 score=0;reasons=[]
 for condition,penalty,reason in [(early_bps>=1000,2,'early_buyers_hold_at_least_10_percent'),(cluster_bps>=2000,2,'same_block_buyers_hold_at_least_20_percent'),(top10>=5000,1,'top10_hold_at_least_50_percent'),(dev_sold>0,1,'creator_has_sold')]:
  if condition:score+=penalty;reasons.append(reason)
 grade='A' if score==0 else 'B' if score==1 else 'C' if score==2 else 'D' if score<=4 else 'F'
 return {'policy':POLICY,'grade':grade,'status':'observed','reasons':reasons,'earlyBuyerCount':len(early),'earlyBuyerHeldBps':early_bps,'sameBlockBuyerCount':len(clustered),'sameBlockBuyerHeldBps':cluster_bps,'top10HeldBps':top10,'creatorSoldTokens':str(dev_sold),'snapshotSlot':snapshot_slot,'caveat':'Timing signals do not prove sniping, bundling, or common ownership. A grade does not guarantee safety.'}
