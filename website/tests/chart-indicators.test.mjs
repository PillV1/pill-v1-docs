import test from 'node:test';
import assert from 'node:assert/strict';
import {movingAverage} from '../src/chart-indicators.mjs';
const bars=[2,4,6,8,20].map((close,time)=>({close,time}));
test('SMA and EMA wait for a full period and differ correctly after a price jump',()=>{
 assert.deepEqual(movingAverage(bars,3),[{time:2,value:4},{time:3,value:6},{time:4,value:34/3}]);
 assert.deepEqual(movingAverage(bars,3,true),[{time:2,value:4},{time:3,value:6},{time:4,value:13}]);
 assert.deepEqual(movingAverage(bars,20),[]);
});
