import {integer} from './quotes.mjs';
export function checkBuySlot(launch,slot,tokens,supply){
 const previous=integer(launch.buySlot),used=integer(launch.slotBought),current=integer(slot);
 if(current<previous)throw Error('invalid_buy_slot');
 if(integer(tokens)+(current===previous?used:0n)>integer(supply)/100n)throw Error('buy_slot_limit');
}
