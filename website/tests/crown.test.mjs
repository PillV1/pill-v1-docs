import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {safeText} from '../src/api.mjs';
const source=readFileSync(new URL('../dist/app.js',import.meta.url),'utf8');
const context=vm.createContext({e:safeText});
vm.runInContext(source.slice(source.indexOf('function crownBadge('),source.indexOf('function coinCard(')),context);
test('crown is permanent and shows the confirmed timestamp',()=>{
 const coin={kingOfTheHill:{qualified:true,crownedAt:1700000000,crownedSlot:10}};
 assert.match(context.crownBadge(coin),/👑/);
 assert.match(context.crownPanel(coin),/Crowned king of the hill on/);
 assert.match(context.crownPanel(coin),/2023-11-14T22:13:20.000Z/);
});
test('progress below the boundary never rounds up to crowned',()=>{
 const coin={kingOfTheHill:{qualified:false,progressBps:9999}};
 assert.equal(context.crownBadge(coin),'');
 assert.match(context.crownPanel(coin),/99%/);
 assert.doesNotMatch(context.crownPanel(coin),/Crowned/);
});
test('missing chain timestamp is not replaced with the current date',()=>{
 const output=context.crownPanel({kingOfTheHill:{qualified:true,crownedAt:null,crownedSlot:123}});
 assert.match(output,/slot 123/);assert.doesNotMatch(output,/<time/);
});
