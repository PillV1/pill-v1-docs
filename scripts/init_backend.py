import argparse,sys,os
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'services/indexer'))
from store import Store
from payments import Payments
from workflows import Workflows
from projections import Projections
parser=argparse.ArgumentParser();parser.add_argument('--database',required=True);args=parser.parse_args()
os.umask(0o077)
store=Store(args.database);Payments(store);Workflows(store);Projections(store);store.db.close()
print('Backend database initialized; signing and public payments remain controlled by deployment configuration.')
