// Real native persistence, matrix-nio sender and two owning browser decryptors.
// Imported only by the guarded isolated live smoke; no application routes mock.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { expect } from '@playwright/test';
import { matrixSmokeRequest, matrixSmokeJoin, matrixSmokeLeave, matrixSmokeInvite, matrixSmokeCreateFixture } from './matrix-smoke-request.mjs';

const ORIGIN = 'https://chat.example.test', BOT = '@cisystembot:chat.example.test';
const OWNER = '@cialice:chat.example.test', BOB = '@cibob:chat.example.test', ADMIN = '@ciadmin:chat.example.test';
const SUBJECT = '@cinoticesubject:chat.example.test', TYPE = 'io.tavern.server.system_messages';
const HOOK = 'ci-system-notices', CONTROL = 'http://127.0.0.1:18086';
const run = promisify(execFile);
const roomId = value => typeof value === 'string' && /^![^\s/\\?#:]{1,200}:chat\.example\.test$/.test(value);

export async function openSystemMessageSettings(page, serverName) {
  const trigger = page.locator('.workspace-select');
  await trigger.click();
  await page.getByRole('menuitem', { name: serverName, exact: true }).click();
  await expect(trigger.locator('strong')).toHaveText(serverName);
  // Radix retains its closing content through the exit animation. Re-clicking
  // the toggle before that layer is removed can close the newly opened menu.
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.workspace-menu')).toHaveCount(0);
  await trigger.click();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('menuitem', { name: 'Server settings & categories', exact: true }).click();
}

async function isolatedHelperNetwork() {
  const docker = async args => (await run('docker', args, { timeout: 15000, maxBuffer: 262144 })).stdout.trim();
  assert.equal(await docker(['ps','--filter','label=com.docker.compose.project=tavern-ci','--filter','label=com.docker.compose.service=integrations','-q']), '', 'The canonical integration service must stay excluded from this isolated fixture.');
  const identity = await docker(['ps','--filter','label=com.docker.compose.project=tavern-ci','--filter','label=com.docker.compose.service=ci-system-bot','-q']);
  assert.match(identity, /^[a-f0-9]{12,64}$/);
  const [network] = JSON.parse(await docker(['network','inspect','tavern-ci_private']));
  assert.equal(network.Name,'tavern-ci_private'); assert.equal(network.Internal,true);
  assert.equal(network.Labels['com.docker.compose.project'],'tavern-ci');
  assert.equal(network.Labels['com.docker.compose.network'],'private');
  const containers = Object.keys(network.Containers || {}); assert.ok(containers.length > 0 && containers.length <= 32);
  let found = false;
  for (const id of containers) {
    const attached = JSON.parse(await docker(['inspect','--format','{{json .NetworkSettings.Networks}}',id]));
    const aliases = attached.tavern_ci_private?.Aliases || attached['tavern-ci_private']?.Aliases || [];
    if (aliases.includes('integrations')) {
      assert.ok(id.startsWith(identity), 'Only the isolated CI helper may own the private integrations alias.');
      found = true;
    }
  }
  assert.ok(found, 'The API must reach the actual CI bot through its fixed integrations hostname.');
  const ports = JSON.parse(await docker(['inspect','--format','{{json .HostConfig.PortBindings}}',identity]));
  assert.deepEqual(ports['8086/tcp'],[{HostIp:'127.0.0.1',HostPort:'18086'}]);
  assert.ok(!ports['8080/tcp'], 'The actual bot port must remain private.');
}

export async function systemMessagesSmoke({ admin, alice, bob, adminSession, aliceSession, bobSession, origin, api, ready, createPage, login }) {
  if (process.env.TAVERN_CI_SMOKE !== 'true' || origin !== ORIGIN || process.env.TAVERN_CI_TLS !== '/tmp/tavern-ci-tls'
    || adminSession?.userId !== ADMIN || adminSession.admin !== true || aliceSession?.userId !== OWNER || aliceSession.admin !== false
    || bobSession?.userId !== BOB || bobSession.admin !== false || typeof createPage !== 'function' || typeof login !== 'function') {
    throw new Error('System notice acceptance requires the exact isolated CI stack and accounts.');
  }
  await isolatedHelperNetwork();
  const capability = randomBytes(32).toString('hex');
  // The ephemeral directory is already mounted read-only in CI services. It
  // contains this run's TLS keys; nothing in it is served as a static asset.
  await writeFile(join(process.env.TAVERN_CI_TLS,'system-bot.capability'),capability+'\n',{flag:'wx',mode:0o644});
  const control = async (action, body = {}) => {
    assert.ok(['prepare','start','stop','status','recipient-pins'].includes(action));
    const response = await fetch(CONTROL+'/'+action,{method:'POST',redirect:'error',signal:AbortSignal.timeout(action==='prepare'?125000:25000),
      headers:{'Content-Type':'application/json','X-Tavern-CI-Capability':capability},body:JSON.stringify(body)});
    const raw = await response.text(); assert.ok(raw.length <= 32768);
    assert.equal(response.status,200,'The isolated bot '+action+' operation must succeed.');
    return JSON.parse(raw);
  };
  const checked = (response, status, description) => {
    assert.equal(response.status,status,description+': '+(response.data?.error || response.data?.errcode || 'unexpected status'));
    return response.data;
  };
  const native = (page,path,body,method) => {
    assert.equal(new URL(page.url()).origin,ORIGIN,'Native probes stay on the actual isolated browser origin.');
    const request = () => api(page,'/_matrix/client/v3'+path,body,true,false,method);
    return body === undefined || method === 'PUT' ? matrixSmokeRequest(request) : request();
  };
  const room = id => '/rooms/'+encodeURIComponent(id);
  const state = (id,type,key='') => room(id)+'/state/'+encodeURIComponent(type)+'/'+encodeURIComponent(key);
  const session = async (page,expected) => {
    assert.equal(new URL(page.url()).origin,ORIGIN,'Only the isolated owning browser is permitted.');
    const current = checked(await matrixSmokeRequest(() => api(page,'/api/auth/session')),200,'Inspect the owning CI session');
    assert.equal(current.userId,expected.userId); assert.equal(current.deviceId,expected.deviceId); assert.equal(current.admin,expected.admin);
  };
  for (const [page,expected] of [[admin,adminSession],[alice,aliceSession],[bob,bobSession]]) await session(page,expected);
  async function privacy(page) {
    await page.getByRole('button',{name:'Tavern settings',exact:true}).click();
    await page.getByRole('tab',{name:'Privacy',exact:true}).click();
  }
  async function ownFingerprint(page,expected) {
    // Earlier private-room acceptance deliberately leaves its modal open.
    // Return this same owning browser to its normal workspace before opening
    // Settings; never bypass the modal's accessibility/interaction boundary.
    await page.goto(ORIGIN); await ready(page); await session(page,expected);
    await privacy(page);
    const panel = page.locator('section.session-manager');
    const details = panel.locator('details');
    await details.locator('summary').click();
    await expect(details.locator('code')).toHaveText(/^[A-Za-z0-9+/]{43}=?$/);
    const fingerprint = (await details.locator('code').textContent()).trim();
    await expect(panel.locator('.device-row').filter({hasText:expected.deviceId})).toContainText('This device');
    await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
    await session(page,expected);
    return fingerprint;
  }
  const devices = {[OWNER]:{[aliceSession.deviceId]:await ownFingerprint(alice,aliceSession)},[BOB]:{[bobSession.deviceId]:await ownFingerprint(bob,bobSession)}};
  const botPassword='Ci!'+randomBytes(24).toString('base64url'), subjectPassword='Ci!'+randomBytes(24).toString('base64url');
  for (const [username,displayName,password] of [['cisystembot','CI system notice bot',botPassword],['cinoticesubject','CI notice subject',subjectPassword]]) {
    checked(await api(admin,'/api/admin/users',{username,displayName,password}),201,'Create only the dedicated isolated account');
  }
  const runId=randomBytes(12).toString('hex'), serverName='CI system notices '+runId+' server', channelName='CI system notices '+runId+' channel';
  const createFixture = config => matrixSmokeCreateFixture(body => native(alice,'/createRoom',body),config);
  const server = checked(await createFixture({name:serverName,visibility:'private',preset:'private_chat',
    creation_content:{type:'m.space','m.federate':false,'io.tavern.ci_system':runId}}),200,'Create a fresh isolated native Space').room_id;
  assert.ok(roomId(server));
  const channel = checked(await createFixture({name:channelName,visibility:'private',preset:'private_chat',
    creation_content:{'m.federate':false,'io.tavern.ci_system':runId},initial_state:[
      {type:'m.room.encryption',state_key:'',content:{algorithm:'m.megolm.v1.aes-sha2'}},
      {type:'m.room.history_visibility',state_key:'',content:{history_visibility:'joined'}},
      {type:'m.space.parent',state_key:server,content:{canonical:true,via:['chat.example.test']}},
    ]}),200,'Create the fresh encrypted CI child').room_id;
  assert.ok(roomId(channel)); assert.notEqual(server,channel);
  checked(await native(alice,state(server,'m.space.child',channel),{via:['chat.example.test']},'PUT'),200,'Publish the reciprocal CI child link');
  const membership = (viewer,id,user) => native(viewer,state(id,'m.room.member',user));
  const inviteRoom = async (id,user) => {
    assert.ok([server,channel].includes(id) && [BOB,BOT,SUBJECT,ADMIN].includes(user));
    checked(await matrixSmokeInvite(() => membership(alice,id,user),() => native(alice,room(id)+'/invite',{user_id:user})),200,'Invite only the known CI recipient');
    assert.ok(['invite','join'].includes(checked(await membership(alice,id,user),200,'Confirm the native invitation').membership));
  };
  const joinRoom = async (page,id,user) => checked(await matrixSmokeJoin(() => membership(alice,id,user),() => native(page,'/join/'+encodeURIComponent(id),{})),200,'Join an explicitly chosen CI room');
  const leaveRoom = async (page,id,user) => checked(await matrixSmokeLeave(() => membership(alice,id,user),() => native(page,room(id)+'/leave',{})),200,'Leave only the known CI fixture');
  for (const id of [server,channel]) for (const user of [BOB,BOT]) await inviteRoom(id,user);
  await joinRoom(bob,server,BOB); await joinRoom(bob,channel,BOB);
  for (const [id,name,space] of [[server,serverName,true],[channel,channelName,false]]) {
    const all=checked(await native(alice,room(id)+'/state'),200,'Guard the newly created native fixture');
    const content=type => all.find(event => event.type===type && event.state_key==='');
    assert.equal(content('m.room.create').sender,OWNER); assert.equal(content('m.room.create').content['io.tavern.ci_system'],runId);
    assert.equal(content('m.room.create').content['m.federate'],false); assert.equal(content('m.room.create').content.type==='m.space',space);
    assert.equal(content('m.room.name').content.name,name); assert.equal(content(TYPE),undefined);
  }
  let prepared=false, enabled=false, adminJoined=false, subject;
  const settingsPath='/api/servers/'+encodeURIComponent(server)+'/system-messages';
  const readSettings = async () => checked(await matrixSmokeRequest(() => api(alice,settingsPath)),200,'Read current CI notice state and durable counts');
  async function save(enabledValue) {
    const before=await readSettings();
    const settings={version:1,enabled:enabledValue,channelId:channel,hookId:HOOK,joins:true,leaves:true,'io.tavern.previous_event':before.eventId};
    checked(await api(alice,settingsPath,{settings,confirmation:server},false,false,'PUT'),200,'Save only the guarded CI notice route');
    enabled=enabledValue;
    return (await readSettings()).eventId;
  }
  async function waitFor(description,predicate,timeout=90000) {
    const deadline=Date.now()+timeout;
    while (Date.now()<deadline) { const result=await predicate(); if (result) return result; await pause(500); }
    throw new Error(description+' did not complete within the isolated deadline.');
  }
  async function startBot(expected) {
    await control('start');
    const result=await waitFor('Actual Matrix bot readiness',async () => { const status=await control('status'); return status.botReady===true && status.running===true ? status:false; });
    assert.deepEqual(result.identity,expected);
    return result;
  }
  async function botEvents() {
    const response=checked(await native(alice,room(channel)+'/messages?dir=b&limit=100'),200,'Inspect native encrypted CI history');
    assert.ok(Array.isArray(response.chunk));
    return response.chunk.filter(event => event.sender===BOT);
  }
  async function sourceEvent() {
    const all=checked(await native(alice,room(server)+'/state'),200,'Read the exact persisted native membership event');
    const event=all.find(item => item.type==='m.room.member' && item.state_key===SUBJECT);
    assert.ok(event?.event_id?.startsWith('$')); return event.event_id;
  }
  async function assertNotice(previous,change,sourceId) {
    const current=await waitFor('Confirmed native encrypted notice',async () => {
      const status=await control('status');
      const added=status.deliveries.filter(item => item.status==='sent' && !previous.has(item.eventId));
      assert.ok(added.length<=1,'Each native membership event must produce one confirmed bot delivery.');
      return added.length ? added[0].eventId : false;
    });
    const nativeEvent=checked(await native(alice,room(channel)+'/event/'+encodeURIComponent(current)),200,'Read the actual stored bot event');
    assert.equal(nativeEvent.sender,BOT); assert.equal(nativeEvent.type,'m.room.encrypted'); assert.ok(nativeEvent.content.ciphertext);
    assert.ok(!JSON.stringify(nativeEvent.content).includes(SUBJECT));
    const text=SUBJECT+(change==='join'?' joined the server.':' left the server.');
    for (const page of [alice,bob]) {
      await page.goto(ORIGIN+'/#room='+encodeURIComponent(channel)); await ready(page);
      await expect(page.locator('article.message[id='+JSON.stringify('message-'+current)+'] .message-body')).toHaveText(text,{timeout:60000});
    }
    return {eventId:current,change,sourceId,text};
  }
  async function exportProof(page,expected,notices) {
    await privacy(page);
    // Headless CI cannot interact with an OS file picker. Select the shipped
    // download fallback; the actual history/decryption/export code still runs.
    await page.evaluate(() => { delete window.showSaveFilePicker; if ('showSaveFilePicker' in window) throw new Error('The CI download fallback is unavailable.'); });
    const section=page.locator('section.settings-section').filter({has:page.getByRole('heading',{name:'Export message history',exact:true})});
    await section.getByLabel('Conversations',{exact:true}).selectOption(channel);
    await section.getByLabel('Only messages I sent',{exact:true}).uncheck();
    await section.getByLabel('I understand the downloaded file contains unencrypted message content and must be kept private.',{exact:true}).check();
    const [download]=await Promise.all([page.waitForEvent('download'),section.getByRole('button',{name:'Download history',exact:true}).click()]);
    const stream=await download.createReadStream(); assert.ok(stream); let raw='';
    for await (const chunk of stream) { raw+=chunk.toString('utf8'); assert.ok(raw.length<1048576); }
    const rows=raw.trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(rows[0].userId,expected.userId); assert.equal(rows.at(-1).type,'complete');
    for (const notice of notices) {
      const matches=rows.filter(row=>row.type==='event' && row.eventId===notice.eventId);
      assert.equal(matches.length,1); const event=matches[0];
      assert.equal(event.roomId,channel); assert.equal(event.sender,BOT); assert.equal(event.eventType,'m.room.message');
      assert.equal(event.content.msgtype,'m.notice'); assert.equal(event.content.body,notice.text);
      assert.deepEqual(event.content['io.tavern.system'],{kind:'member_'+notice.change,server_id:server,source_event_id:notice.sourceId});
    }
    await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
    await session(page,expected);
  }
  let failure;
  try {
    const initial=await control('status'); assert.equal(initial.helperReady,true); assert.equal(initial.prepared,false); assert.equal(initial.running,false); assert.equal(initial.botReady,false);
    const provisioned=await control('prepare',{runId,botUserId:BOT,password:botPassword,serverId:server,channelId:channel,devices});
    prepared=true; assert.equal(provisioned.prepared,true); assert.match(provisioned.fingerprint,/^[A-Za-z0-9+/]{43}=?$/);
    const identity={userId:BOT,deviceId:provisioned.deviceId,fingerprint:provisioned.fingerprint};
    await startBot(identity);
    for (const page of [alice,bob]) { await page.goto(ORIGIN+'/#room='+encodeURIComponent(channel)); await ready(page); }
    // Save once through the actual mounted server editor, including typed ID.
    await openSystemMessageSettings(alice, serverName);
    const editor=alice.locator('section.product-section').filter({has:alice.getByRole('heading',{name:'System notices',exact:true})});
    await expect(editor.getByText('System notices: Off',{exact:true})).toBeVisible();
    await editor.getByLabel('Post system notices',{exact:true}).check();
    await editor.getByLabel('Encrypted webhook destination',{exact:true}).selectOption(HOOK);
    await editor.getByLabel('Member leaves',{exact:true}).check();
    await editor.getByLabel('Confirm server ID',{exact:true}).fill(server);
    const [saved]=await Promise.all([alice.waitForResponse(response=>response.request().method()==='PUT' && new URL(response.url()).pathname===settingsPath),editor.getByRole('button',{name:'Save system notice settings',exact:true}).click()]);
    assert.equal(saved.status(),200); enabled=true;
    await expect(editor.getByRole('status')).toContainText('System notice settings saved');
    await alice.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click();
    subject=await createPage(); await login(subject,'cinoticesubject',subjectPassword);
    await inviteRoom(server,SUBJECT);
    await joinRoom(subject,server,SUBJECT);
    const joined=await assertNotice(new Set(),'join',await sourceEvent());
    await waitFor('API confirmed sent receipt',async () => (await readSettings()).counts.sent>=1);
    console.log('PASS: native post-persist Space join reaches the actual encrypted bot and both owning browser decryptors.');

    await control('stop'); await control('recipient-pins',{enabled:false}); await startBot(identity);
    await leaveRoom(subject,server,SUBJECT); const leftSource=await sourceEvent();
    await waitFor('Durable encrypted bot queue blocked on an unapproved device',async () => (await control('status')).deliveries.some(row=>row.status==='pending'));
    assert.deepEqual((await botEvents()).map(event=>event.event_id),[joined.eventId]);
    await control('stop'); await control('recipient-pins',{enabled:true}); await startBot(identity);
    const left=await assertNotice(new Set([joined.eventId]),'leave',leftSource);
    await waitFor('API acknowledged restart delivery',async () => (await readSettings()).counts.sent>=2);
    await control('stop'); await startBot(identity); await pause(3500);
    assert.deepEqual(new Set((await botEvents()).map(event=>event.event_id)),new Set([joined.eventId,left.eventId]));
    for (const [page,expected] of [[alice,aliceSession],[bob,bobSession]]) await exportProof(page,expected,[joined,left]);
    console.log('PASS: verified recipient pins gate delivery; queue/store restart sends one actual m.notice and both SDK history exports confirm decrypted metadata.');

    await control('stop');
    await inviteRoom(server,SUBJECT);
    await joinRoom(subject,server,SUBJECT);
    await waitFor('API pending while the bot is offline',async () => (await readSettings()).counts.pending>=1);
    const cancelledBefore=(await readSettings()).counts.cancelled;
    await save(false);
    await waitFor('Disabled route cancels queued work',async () => (await readSettings()).counts.cancelled>cancelledBefore);
    await startBot(identity); await save(true);
    await inviteRoom(channel,ADMIN);
    await joinRoom(admin,channel,ADMIN); adminJoined=true;
    assert.ok([403,404].includes((await membership(alice,server,ADMIN)).status) || (await membership(alice,server,ADMIN)).data.membership!=='join');
    const beforeAudience=(await readSettings()).counts.cancelled;
    await leaveRoom(subject,server,SUBJECT);
    await waitFor('New destination-only audience cancels the notice',async () => (await readSettings()).counts.cancelled>beforeAudience);
    await pause(3500);
    assert.deepEqual(new Set((await botEvents()).map(event=>event.event_id)),new Set([joined.eventId,left.eventId]));
    console.log('PASS: route disable and a destination-only outsider stop further queued notices without plaintext fallback or replay.');
  } catch (error) { failure=error; }
  finally {
    const cleanup=[];
    if (enabled) try { await save(false); } catch { cleanup.push('disable isolated route'); }
    if (adminJoined) try { await leaveRoom(admin,channel,ADMIN); } catch { cleanup.push('leave isolated outsider room'); }
    if (prepared) try { await control('stop'); } catch { cleanup.push('stop isolated bot'); }
    if (cleanup.length) failure ||= new Error('Isolated system notice cleanup failed: '+cleanup.join(', '));
  }
  if (failure) throw failure;
}
