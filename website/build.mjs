import {copyFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const {build}=require('esbuild');
const path=v=>fileURLToPath(new URL(v,import.meta.url));
const dependency=name=>{try{return require.resolve(name)}catch{return require.resolve(name,{paths:[require.resolve('@solana/web3.js')]})}};
await copyFile(path('./src/api.mjs'),path('./dist/api.mjs'));
for(const name of ['market-chart','market-format','chart-indicators','launch-labels','onepill','onepill-market','launch-flow'])await copyFile(path('./src/'+name+'.mjs'),path('./dist/'+name+'.mjs'));
await copyFile(path('./src/vendor/lightweight-charts.mjs'),path('./dist/lightweight-charts.mjs'));

const shared={bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true};

for(const name of ['wallet','claims','direct-launch','vanity-worker','native-pump','onepill-trade'])await build({...shared,entryPoints:[path('./src/'+name+'.mjs')],outfile:path('./dist/'+name+'.js'),inject:[path('./src/buffer-shim.mjs')],alias:{'node:crypto':path('./src/browser-crypto.mjs'),'@noble/hashes/sha256':dependency('@noble/hashes/sha256'),buffer:dependency('buffer/')}});

await build({...shared,entryPoints:[path('./src/privy.jsx')],outfile:path('./dist/privy.js'),define:{'process.env.NODE_ENV':'"production"'}});
