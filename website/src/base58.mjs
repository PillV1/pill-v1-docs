// Encode bytes for Solana transaction IDs; no key material is handled here.
export function base58(bytes){const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=0n;for(const b of bytes)n=(n<<8n)+BigInt(b);let out='';while(n){out=alphabet[Number(n%58n)]+out;n/=58n}for(const b of bytes){if(b!==0)break;out='1'+out}return out}
