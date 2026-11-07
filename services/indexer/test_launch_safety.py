import unittest
from launch_safety import launch_safety
class SafetyTests(unittest.TestCase):
 def args(self):return dict(created_slot=100,supply=1000,creator='dev',trades=[],holders={},snapshot_slot=200,complete_history=True,finalized=True)
 def test_missing_evidence_never_gets_a_grade(self):
  for patch in [dict(finalized=False),dict(complete_history=False),dict(holders=None)]:self.assertIsNone(launch_safety(**(self.args()|patch))['grade'])
 def test_current_holdings_not_historical_buys_are_used(self):
  trades=[dict(signature=str(i),event_index=0,slot=101,trader=str(i),tokens=100,buy=True) for i in range(3)]
  result=launch_safety(**(self.args()|dict(trades=trades+trades,holders={'0':10,'1':20,'2':30})))
  self.assertEqual(result['earlyBuyerCount'],3);self.assertEqual(result['earlyBuyerHeldBps'],600);self.assertEqual(result['sameBlockBuyerHeldBps'],600)
 def test_creator_sale_and_concentration_explain_grade(self):
  t=dict(signature='s',event_index=0,slot=105,trader='dev',tokens=1,buy=False)
  result=launch_safety(**(self.args()|dict(trades=[t],holders={'whale':600})));self.assertEqual(result['grade'],'C');self.assertEqual(len(result['reasons']),2)
 def test_invalid_snapshot_rejected(self):
  with self.assertRaises(ValueError):launch_safety(**(self.args()|dict(holders={'x':1001})))
