import {sha256} from '@noble/hashes/sha256';
import {Buffer} from 'buffer';
export function createHash(algorithm){if(algorithm!=='sha256')throw Error('Unsupported hash.');const h=sha256.create();return {update(data){h.update(typeof data==='string'?new TextEncoder().encode(data):data);return this},digest(encoding){const bytes=Buffer.from(h.digest());return encoding?bytes.toString(encoding):bytes}}}
