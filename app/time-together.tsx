import { useState } from 'react';
import { getMatrixClient } from '@/lib/matrix';
import { readMemberProfile } from '@/lib/community';
import { localDateInput, sharedLocalTime } from '@/lib/time-together';
export function TimeTogether({ roomId, value, onChange }: { roomId:string; value:string; onChange:(value:string)=>void }) {
  const [selected,setSelected]=useState<string[]>([]),[query,setQuery]=useState('');
  const members=getMatrixClient()?.getRoom(roomId)?.getJoinedMembers()||[], instant=Date.parse(value);
  const people=members.filter(member=>selected.includes(member.userId)).map(member=>({...member,zone:readMemberProfile(roomId,member.userId).timezone}));
  return <details className="time-together"><summary>Find a time together</summary><p>Compare time zones members chose to share in their profiles. This does not show calendars or private availability.</p>
    <label>Find participants<input type="search" value={query} onChange={event=>setQuery(event.target.value)}/></label><div className="channel-invite-options">{members.filter(member=>selected.includes(member.userId)||member.name.toLowerCase().includes(query.toLowerCase())).slice(0,50).map(member=><label key={member.userId}><input type="checkbox" checked={selected.includes(member.userId)} onChange={event=>setSelected(current=>event.target.checked?[...current,member.userId].slice(0,20):current.filter(id=>id!==member.userId))}/>{member.name}</label>)}</div>
    {!Number.isFinite(instant)?<p>Choose an event start time above to compare it.</p>:<><ul>{people.map(person=>{const time=sharedLocalTime(instant,person.zone);return <li key={person.userId}><strong>{person.name}</strong>: {time?`${time.label}${time.daytime?'':' · Early or late locally'}`:'Time zone not shared'}</li>;})}</ul><div className="product-actions"><button type="button" className="secondary-button" onClick={()=>onChange(localDateInput(instant-30*60000))}>30 minutes earlier</button><button type="button" className="secondary-button" onClick={()=>onChange(localDateInput(instant+30*60000))}>30 minutes later</button></div><p className="login-help">“Early or late” means before 8 am or after 10 pm locally. It is a rough guide, not a person’s working hours.</p></>}
  </details>;
}
