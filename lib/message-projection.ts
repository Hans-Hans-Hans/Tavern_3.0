import type { MatrixEvent } from 'matrix-js-sdk';
export type Reaction={emoji:string;count:number;mine:number;users:string[]};
export function indexReactions(events:MatrixEvent[],me:string|null|undefined):Map<string,Reaction[]>{
  const index=new Map<string,Map<string,Set<string>>>();
  for(const event of events){if(event.getType()!=='m.reaction'||event.isRedacted())continue;const relation=event.getContent()['m.relates_to'],sender=event.getSender();if(!sender||relation?.rel_type!=='m.annotation'||typeof relation.event_id!=='string'||typeof relation.key!=='string')continue;const key=relation.key;if(!key||!(key.length<30||(/^mxc:\/\/[^/]+\/[^/?#]+$/.test(key)&&key.length<=1024)))continue;let reactions=index.get(relation.event_id);if(!reactions){reactions=new Map();index.set(relation.event_id,reactions);}let users=reactions.get(key);if(!users){users=new Set();reactions.set(key,users);}users.add(sender);}
  return new Map([...index].map(([id,reactions])=>[id,[...reactions].map(([emoji,users])=>({emoji,count:users.size,mine:Number(!!me&&users.has(me)),users:[...users]}))]));
}
