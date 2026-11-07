// Local-only readiness API. No deposit, signing or public launch endpoint exists.
import {createServer} from 'node:http';
const port=Number(process.env.PORT??8788);
if(!Number.isSafeInteger(port)||port<1024||port>65535)throw Error('invalid_port');
createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');if(req.method==='GET'&&req.url==='/health'){res.writeHead(200);res.end(JSON.stringify({status:'development',readyForFunds:false,contractsDeployed:false,feeSplit:{treasuryBps:1000,coinBps:9000},postGraduationFeePolicy:'pumpswap_native_only',tokenModel:'single_mint_custody',graduationVenue:'pumpswap'}));return}res.writeHead(503);res.end(JSON.stringify({error:'development_only',message:'Launch and payment endpoints are not enabled.'}))}).listen(port,'127.0.0.1');
