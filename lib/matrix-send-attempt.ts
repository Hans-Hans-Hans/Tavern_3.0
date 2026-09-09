import type { MatrixClient, Room } from 'matrix-js-sdk';
export type MatrixSendAttempt={attempted:true;preparedContent:Record<string,any>;preparedRoleUsers:string[];encrypted:boolean};
type Entry=MatrixSendAttempt&{room:Room;parent:string|undefined;current:()=>boolean};
let owners=new WeakMap<MatrixClient,Map<string,Entry>>();
export function assertMatrixSendAttemptCapacity(client:MatrixClient,transaction:string){
  const entries=owners.get(client);
  if(entries&&!entries.has(transaction)&&entries.size>=100)throw new Error('This session already has 100 unconfirmed sends. Retry an original message, or transfer it to Outbox and explicitly cancel it before sending another. Your draft is kept.');
}
/** In-memory counterpart to the SDK's pending local echo. Failed direct text
 * sends can explicitly transfer their immutable attempt to encrypted storage. */
export function readMatrixSendAttempt(client:MatrixClient,room:Room,parent:string|undefined,transaction:string):MatrixSendAttempt|undefined{
  const entry=owners.get(client)?.get(transaction);if(!entry)return;
  if(!entry.current()||entry.room!==room||entry.parent!==parent)throw new Error('This attempted transaction belongs to an earlier account or conversation. Reopen its original draft.');
  return structuredClone({attempted:true,preparedContent:entry.preparedContent,preparedRoleUsers:entry.preparedRoleUsers,encrypted:entry.encrypted});
}
export function rememberMatrixSendAttempt(client:MatrixClient,room:Room,parent:string|undefined,transaction:string,value:MatrixSendAttempt,current:()=>boolean){
  if(!current())throw new Error('Your account or conversation changed. Your draft is kept.');
  assertMatrixSendAttemptCapacity(client,transaction);
  const previous=readMatrixSendAttempt(client,room,parent,transaction);
  if(previous&&JSON.stringify(previous)!==JSON.stringify(value))throw new Error('An attempted transaction must keep its original content and recipients.');
  let entries=owners.get(client);if(!entries){entries=new Map();owners.set(client,entries);}entries.set(transaction,{...structuredClone(value),room,parent,current});
}
export function forgetMatrixSendAttempt(client:MatrixClient,transaction:string){owners.get(client)?.delete(transaction);}
export function resetMatrixSendAttempts(){owners=new WeakMap();}
