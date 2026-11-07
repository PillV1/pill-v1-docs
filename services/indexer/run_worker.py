"""Private worker entry point. No HTTP listener and no secrets in command arguments."""
import argparse,json,os,subprocess,time,signal
from pathlib import Path
from store import Store
from payments import Payments
from workflows import Workflows,finalized_stage_cost
from payment_ingest import PaymentIngest
from worker import Worker
from ingest import Rpc

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--config',required=True);parser.add_argument('--once',action='store_true');args=parser.parse_args()
 config=json.loads(Path(args.config).read_text())
 if config.get('signingEnabled') is not True:raise ValueError('signing_disabled')
 rpc=Rpc(os.environ['LAUNCHPAD_RPC_URL']);store=Store(config['database']);payments=Payments(store);flows=Workflows(store)
 poller=PaymentIngest(store,payments,rpc,config['genesis'])
 script=Path(__file__).resolve().parents[1]/'api/sign-job.mjs'
 def build(job):
  env=dict(os.environ,LAUNCHPAD_CONFIG=str(Path(args.config).resolve()))
  result=subprocess.run([os.environ.get('NODE_BIN','node'),str(script)],input=json.dumps({'id':job['id'],'lease':job['lease']}),text=True,capture_output=True,timeout=25,env=env)
  if result.returncode:raise RuntimeError('private_signer_failed')
  return json.loads(result.stdout)
 worker=Worker(store,rpc,build,config['genesis']);running=True;last_maintenance=0;last_social=0
 def stop(*_):
  nonlocal running
  running=False
 signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
 while running:
  now=int(time.time());worker.check_network();poller.poll(now);payments.expire(now);flows.advance();worker.reconcile()
  rows=store.db.execute("SELECT j.id,j.signature,i.deposit_address FROM jobs j JOIN intents i ON i.id=j.launch LEFT JOIN launch_costs c ON c.job=j.id WHERE j.kind='launch_stage' AND j.phase='confirmed' AND c.job IS NULL LIMIT 100").fetchall()
  for row in rows:
   try:flows.record_cost(row['id'],row['signature'],finalized_stage_cost(rpc,row['signature'],row['deposit_address'],config['genesis']))
   except Exception as error:store.heartbeat('cost:'+row['id'],type(error).__name__)
   else:store.heartbeat('cost:'+row['id'])
  cancelled=store.db.execute("SELECT j.id,j.signature,i.deposit_address FROM jobs j JOIN intents i ON i.id=j.launch LEFT JOIN cancellation_costs c ON c.job=j.id WHERE j.kind='cancel_launch' AND j.phase='confirmed' AND c.job IS NULL LIMIT 100").fetchall()
  for row in cancelled:
   try:flows.record_cancellation(row['id'],row['signature'],finalized_stage_cost(rpc,row['signature'],row['deposit_address'],config['genesis'],allow_credit=True))
   except Exception as error:store.heartbeat('cancel-cost:'+row['id'],type(error).__name__)
   else:store.heartbeat('cancel-cost:'+row['id'])
  flows.advance()
  if config.get('keeperEnabled') is True and now-last_maintenance>=10:
   last_maintenance=now
   try:
    result=subprocess.run([os.environ.get('NODE_BIN','node'),str(script.with_name('plan-maintenance.mjs'))],env=dict(os.environ,LAUNCHPAD_CONFIG=str(Path(args.config).resolve())),capture_output=True,timeout=25)
    store.heartbeat('maintenance',None if result.returncode==0 else 'planner_failed')
   except Exception as error:store.heartbeat('maintenance',type(error).__name__)
  if config.get('socialEnabled') is True and now-last_social>=10:
   last_social=now
   try:
    result=subprocess.run([os.environ.get('NODE_BIN','node'),str(script.with_name('plan-social.mjs'))],env=dict(os.environ,LAUNCHPAD_CONFIG=str(Path(args.config).resolve())),capture_output=True,timeout=25)
    store.heartbeat('social',None if result.returncode==0 else 'planner_failed')
   except Exception as error:store.heartbeat('social',type(error).__name__)
  try:worker.prepare_one()
  except Exception as error:store.heartbeat('signing',type(error).__name__)
  else:store.heartbeat('signing')
  store.heartbeat('worker')
  if args.once:break
  time.sleep(1)
 store.db.close()
if __name__=='__main__':main()
