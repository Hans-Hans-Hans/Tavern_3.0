import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTs} from './load-ts.mjs';

const {defaultRolePolicy,parseRolePolicy}=loadTs('../lib/roles.ts',{
  './api':{accountArtworkOwner:()=>0},'./matrix':{getMatrixClient:()=>null},
  './conference-publication':loadTs('../lib/conference-publication.ts',{}),
});
const owner='@owner:local',peer='@peer:local',room='!private';
function policy(){return {...defaultRolePolicy(owner),channelAdmissionVersion:1,channelAdmissions:{[room]:{roleIds:['everyone'],userIds:[peer]}}};}

test('role parsing retains private-channel targets as independent snapshots',()=>{
  const original=policy(),parsed=parseRolePolicy(original);assert.ok(parsed);
  assert.deepEqual(parsed.channelAdmissions,original.channelAdmissions);
  parsed.channelAdmissions[room].userIds.push('@second:local');parsed.channelAdmissions[room].roleIds.length=0;
  assert.deepEqual(original.channelAdmissions[room],{roleIds:['everyone'],userIds:[peer]});
  assert.equal(parsed.channelAdmissionVersion,1);
});

test('legacy policy has no audience marker while an explicit empty audience is preserved',()=>{
  assert.equal(Object.hasOwn(parseRolePolicy(defaultRolePolicy(owner)),'channelAdmissions'),false);
  const value=policy();value.channelAdmissions[room]={roleIds:[],userIds:[]};
  assert.deepEqual(parseRolePolicy(value).channelAdmissions[room],{roleIds:[],userIds:[]});
});

test('malformed, unknown and duplicate audience targets cannot be silently stripped by a role editor',()=>{
  for(const mutate of [value=>delete value.channelAdmissionVersion,value=>value.channelAdmissionVersion=true,
    value=>value.channelAdmissionVersion=2,value=>delete value.channelAdmissions,
    value=>value.channelAdmissions[room].roleIds=['missing'],value=>value.channelAdmissions[room].roleIds=['everyone','everyone'],
    value=>value.channelAdmissions[room].userIds=['@missing-domain'],value=>value.channelAdmissions[room].userIds=[peer,peer],
    value=>value.channelAdmissions[room].extra=true]){
    const value=policy();mutate(value);assert.equal(parseRolePolicy(value),null);
  }
});
