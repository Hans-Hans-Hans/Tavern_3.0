import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';
const roles = loadTs('../lib/roles.ts', { './api': {}, './conference-publication': loadTs('../lib/conference-publication.ts', {}), './matrix': {} });
const { memberRolePresentation } = loadTs('../lib/role-presentation.ts', { './roles': roles });
test('name color, single icon and group use their independent highest applicable roles', () => {
  const p=roles.defaultRolePolicy('@owner:local'); const role=(id,position,extra)=>({id,name:id,position,color:'',icon:'',permissions:[],separate:false,mentionable:false,...extra});
  p.roles.push(role('higher',30,{}),role('colored',20,{color:'#6699ff'}),role('icon',10,{icon:'🌱',separate:true}));p.members['@member:local']=['icon','higher','colored'];
  const before=structuredClone(p), result=memberRolePresentation(p,'@member:local');
  assert.equal(result.color,'#6699ff');assert.equal(result.iconRole.id,'icon');assert.equal(result.groupRole.id,'icon');assert.deepEqual(result.badges.map(r=>r.id),['higher','colored','icon']);assert.deepEqual(p,before);
  p.roles[1].color='#b48cf2';p.roles[1].icon='⭐'; assert.equal(memberRolePresentation(p,'@member:local').color,'#b48cf2');assert.equal(memberRolePresentation(p,'@member:local').iconRole.id,'higher');
  p.members['@member:local']=[];assert.equal(memberRolePresentation(p,'@member:local').color,'');assert.equal(memberRolePresentation(p,'@member:local').badges.length,0);
});
test('default membership grants no invented role badges and ownership does not invent a colored role', () => {
  const p=roles.defaultRolePolicy('@owner:local');assert.equal(memberRolePresentation(p,'@owner:local').owner,true);assert.equal(memberRolePresentation(p,'@owner:local').color,'');assert.deepEqual(memberRolePresentation(p,'@unknown:local').badges,[]);assert.equal(memberRolePresentation(null,'@owner:local').owner,false);
});
