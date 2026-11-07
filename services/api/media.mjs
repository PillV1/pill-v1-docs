import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export class Media {
 constructor({identity,directory,origin,pinataJwt=process.env.PINATA_JWT,fetcher=fetch}) {
  this.identity=identity;this.directory=directory;this.origin=new URL(origin).origin;this.active=0;this.pinataJwt=pinataJwt;this.fetcher=fetcher;
  identity.db.exec('CREATE TABLE IF NOT EXISTS media_uploads(wallet TEXT NOT NULL,created INTEGER NOT NULL,bytes INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS media_uploads_wallet_time ON media_uploads(wallet,created)');
 }
 async publish(session,input,now,ipfs=false) {
  if(ipfs&&!this.pinataJwt)throw Error("ipfs_storage_not_configured");
  const {wallet}=this.identity.session(session,now);
  if(this.active>=2)throw Error('media_busy');
  const name=String(input.name??'').trim(),symbol=String(input.symbol??'').toUpperCase(),description=String(input.description??'');
  if(!name||Buffer.byteLength(name)>32||! /^[A-Z0-9]{1,10}$/.test(symbol)||description.length>2000)throw Error('invalid_metadata');
  const links={};
  for(const field of ['twitter','telegram','website']){const raw=String(input[field]??'').trim();if(!raw)continue;let url;try{url=new URL(raw)}catch{throw Error('invalid_social_link')}
   if(url.protocol!=='https:'||url.username||url.password||raw.length>500)throw Error('invalid_social_link');
   if(field==='twitter'&&!['x.com','www.x.com','twitter.com','www.twitter.com'].includes(url.hostname))throw Error('invalid_social_link');
   if(field==='telegram'&&!['t.me','telegram.me'].includes(url.hostname))throw Error('invalid_social_link');
   links[field]=url.href;
  }
  if(typeof input.image!=='string'||input.image.length>5592408||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.image))throw Error('invalid_image');
  const bytes=Buffer.from(input.image,'base64');if(!bytes.length||bytes.length>4*1024*1024)throw Error('invalid_image');
  const db=this.identity.db;
  // Reserve quota synchronously before awaiting image work so concurrent requests count.
  if(db.prepare('SELECT COUNT(*) n FROM media_uploads WHERE wallet=? AND created>?').get(wallet,now-86400).n>=10)throw Error('upload_rate_limit');
  const reservation=db.prepare('INSERT INTO media_uploads VALUES(?,?,?)').run(wallet,now,bytes.length).lastInsertRowid;
  this.active++;
  try {
   const decoder=sharp(bytes,{limitInputPixels:16000000,animated:false,failOn:'warning'});
   const metadata=await decoder.metadata();
   if(!['png','jpeg','webp'].includes(metadata.format)||(metadata.pages??1)>1)throw Error('invalid_image');
   const image=await decoder.rotate().resize({width:1024,height:1024,fit:'inside',withoutEnlargement:true}).webp({quality:88}).toBuffer();
   const imageName=hash(image)+'.webp',document=Buffer.from(JSON.stringify({name,symbol,description,...links,image:this.origin+'/media/'+imageName}));
   const documentName=hash(document)+'.json';await mkdir(this.directory,{recursive:true,mode:0o750});
   for(const [name,data] of [[imageName,image],[documentName,document]])try{await writeFile(join(this.directory,name),data,{flag:'wx',mode:0o640})}catch(e){if(e.code!=='EEXIST')throw e}
   if(ipfs){
    const imageCid=await this.pin(image,imageName,'image/webp');
    const ipfsDocument=Buffer.from(JSON.stringify({name,symbol,description,...links,image:'ipfs://'+imageCid}));
    const cid=await this.pin(ipfsDocument,hash(ipfsDocument)+'.json','application/json');
    return {uri:'ipfs://'+cid,image:(process.env.IPFS_GATEWAY_ORIGIN||'https://ipfs.io').replace(/\/$/,'')+'/ipfs/'+imageCid};
   }
   return {uri:this.origin+'/media/'+documentName,image:this.origin+'/media/'+imageName};
  }catch(e){db.prepare('DELETE FROM media_uploads WHERE rowid=?').run(reservation);throw e}finally{this.active--}
 }
 async pin(bytes,name,type){
  const form=new FormData();form.append('network','public');form.append('file',new Blob([bytes],{type}),name);form.append('name',name);
  const response=await this.fetcher('https://uploads.pinata.cloud/v3/files',{method:'POST',headers:{Authorization:'Bearer '+this.pinataJwt},body:form,signal:AbortSignal.timeout(45000)});
  if(!response.ok)throw Error('ipfs_upload_failed');
  const result=await response.json(),cid=result?.data?.cid;
  if(!/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,120})$/.test(cid??''))throw Error('ipfs_upload_failed');
  return cid;
 }
 async get(name) {
  if(!/^[a-f0-9]{64}\.(webp|json)$/.test(name))throw Error('media_not_found');
  try{return {bytes:await readFile(join(this.directory,name)),type:name.endsWith('.json')?'application/json':'image/webp'}}catch{throw Error('media_not_found')}
 }
}
