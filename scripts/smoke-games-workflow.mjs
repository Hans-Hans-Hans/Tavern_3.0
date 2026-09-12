import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { expect } from '@playwright/test';
import { isCiRoomId, assertCiRoomCreation } from './ci-room-id.mjs';
import { matrixSmokeRequest, matrixSmokeCreateFixture, matrixSmokeInvite, matrixSmokeJoin } from './matrix-smoke-request.mjs';
import { conferenceSmoke } from './smoke-conference.mjs';
const ORIGIN = 'https://chat.example.test', ALICE = '@cialice:chat.example.test', BOB = '@cibob:chat.example.test';
  const MARKER = 'io.tavern.ci_games_workflow';
export async function gamesWorkflowSmoke({ alice, bob, aliceSession, bobSession, origin, api, ready }) {
  if (process.env.TAVERN_CI_SMOKE !== 'true' || process.env.TAVERN_CI_TLS !== '/tmp/tavern-ci-tls' || origin !== ORIGIN
      || aliceSession?.userId !== ALICE || bobSession?.userId !== BOB || aliceSession.admin !== false || bobSession.admin !== false
      || !aliceSession.deviceId || !bobSession.deviceId || alice.context() === bob.context()) throw new Error('Games workflow requires the exact isolated CI accounts and stack.');
  const owners = new Map([[alice, aliceSession], [bob, bobSession]]), runId = randomBytes(12).toString('hex');
  const name = 'CI Games ' + runId, rooms = new Map(); let server, stage = 'server-fixture';
  const checked = (result, label, expected = 200) => { assert.equal(result.status, expected, label); return result.data; };
  async function session(page) {
    assert.equal(new URL(page.url()).origin, ORIGIN); const owner = owners.get(page); assert.ok(owner);
    const actual = checked(await api(page, '/api/auth/session'), 'Read owning Games session');
    assert.equal(actual.userId, owner.userId); assert.equal(actual.deviceId, owner.deviceId); assert.equal(actual.admin, false);
  }
  async function native(page, path, body, method) { await session(page); return matrixSmokeRequest(() => api(page, '/_matrix/client/v3' + path, body, true, false, method)); }
  const path = id => { assert.ok(id === server || rooms.has(id)); return '/rooms/' + encodeURIComponent(id); };
  const member = id => native(alice, path(id) + '/state/m.room.member/' + encodeURIComponent(BOB));
  async function inspectParent() {
    const events = checked(await native(alice, path(server) + '/state'), 'Read marked Games server');
    const find = assertCiRoomCreation({ id: server, events, creator: ALICE, name, marker: MARKER, runId, space: true });
    assert.ok(events.filter(event => event.type === 'm.room.member').every(event => [ALICE, BOB].includes(event.state_key)));
    return find;
  }
  async function inspectChannel(id) {
    await inspectParent(); assert.ok(rooms.has(id));
    const events = checked(await native(alice, path(id) + '/state'), 'Read UI-created native channel');
    assert.ok(Array.isArray(events) && events.length < 100);
    const find = (kind, key = '') => events.find(event => event.type === kind && event.state_key === key);
    assert.equal(find('m.room.create')?.sender, ALICE); assert.equal(find('m.room.create').content['m.federate'], false);
    assert.equal(find('m.room.create').content.type, undefined); assert.equal(find('m.room.create').content.additional_creators, undefined);
    assert.equal(find('m.room.name')?.content.name, rooms.get(id)); assert.equal(find('m.room.encryption')?.content.algorithm, 'm.megolm.v1.aes-sha2');
    assert.equal(find('m.space.parent', server)?.content.canonical, true);
    assert.ok(events.filter(event => event.type === 'm.room.member').every(event => [ALICE, BOB].includes(event.state_key)));
    return find;
  }
  async function joinBob(id) {
    await inspectParent(); if (id !== server) await inspectChannel(id);
    checked(await matrixSmokeInvite(() => member(id), () => native(alice, path(id) + '/invite', { user_id: BOB })), 'Invite the exact ordinary peer');
    checked(await matrixSmokeJoin(() => member(id), () => native(bob, '/join/' + encodeURIComponent(id), {})), 'Join the exact native fixture');
  }
  const sidebar = page => page.locator('.channel-navigation');
  const row = (page, id) => sidebar(page).locator('[data-channel-id]').filter({ has: page.locator('.channel-navigation-row') }).filter({ has: page.getByRole('button', { name: rooms.get(id), exact: true }) }).locator('.channel-navigation-row');
  const category = (page, id) => sidebar(page).locator('[data-category-id]').filter({ has: page.getByRole('button', { name: id === games ? 'Games' : 'Other games', exact: true }) });
  let games, other, dragStage = 'idle';
  async function layout() { return (await inspectParent())('io.tavern.server.layout').content; }
  async function drag(id, destination, before = false) {
    dragStage = 'inspect';
    await session(alice); await inspectChannel(id);
    const source = row(alice, id), target = destination === games || destination === other ? category(alice, destination) : row(alice, destination);
    dragStage = 'locate';
    await source.scrollIntoViewIfNeeded(); await target.scrollIntoViewIfNeeded();
    const transfer = await alice.evaluateHandle(() => new DataTransfer());
    dragStage = 'start';
    await source.dispatchEvent('dragstart', { dataTransfer: transfer });
    const box = await target.boundingBox(); assert.ok(box);
    const clientY = box.y + (before ? 2 : box.height / 2);
    dragStage = 'hover';
    await target.dispatchEvent('dragover', { dataTransfer: transfer, clientY });
    await expect(target).toHaveAttribute('data-drop', before ? 'before' : 'inside');
    dragStage = 'drop';
    await target.dispatchEvent('drop', { dataTransfer: transfer, clientY });
    await source.dispatchEvent('dragend', { dataTransfer: transfer }); await transfer.dispose();
    dragStage = 'saved-order';
  }
  async function ordering(page, categoryId, ids) {
    assert.match(categoryId, /^[A-Za-z0-9_-]{1,80}$/);
    const group = sidebar(page).locator('.channel-category').filter({ has: page.locator('[data-category-id="' + categoryId + '"]') });
    await expect.poll(() => group.locator('[data-channel-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-channel-id'))), { timeout: 15000 }).toEqual(ids);
  }
  try {
    await session(alice); await session(bob);
    server = checked(await matrixSmokeCreateFixture(config => native(alice, '/createRoom', config), { name, preset: 'private_chat', visibility: 'private', creation_content: { 'm.federate': false, type: 'm.space', [MARKER]: runId } }), 'Create one marked native server').room_id;
    assert.ok(isCiRoomId(server)); await inspectParent();
    checked(await native(alice, path(server) + '/state/io.tavern.roles/', { version: 1, owner: ALICE,
      roles: [{ id: 'everyone', name: 'Member', position: 0, permissions: ['send_messages', 'join_calls'] }, { id: 'gaming', name: 'Gaming', color: '#4466aa', position: 1, permissions: [] }],
      members: {}, overrides: {} }, 'PUT'), 'Prepare native Gaming role');
    await joinBob(server);
    const roleEvent = (await inspectParent())('io.tavern.roles');
    checked(await native(alice, path(server) + '/state/io.tavern.roles/', { ...roleEvent.content, members: { [BOB]: ['gaming'] }, 'io.tavern.previous_event': roleEvent.event_id }, 'PUT'), 'Assign the joined peer to Gaming');
    for (const page of owners.keys()) { await page.reload(); await ready(page); await page.getByRole('button', { name, exact: true }).click(); }
    stage = 'category-ui';
    for (const categoryName of ['Games', 'Other games']) {
      await alice.getByRole('button', { name: 'Create category', exact: true }).click();
      await alice.getByRole('textbox', { name: 'Category name', exact: true }).fill(categoryName);
      await alice.getByRole('button', { name: 'Save category', exact: true }).click();
      await expect(alice.getByRole('dialog', { name: 'Create category' })).toHaveCount(0);
    }
    const initial = await layout(); games = initial.categories.find(value => value.name === 'Games').id; other = initial.categories.find(value => value.name === 'Other games').id;
    const ids = [];
    for (const channelName of ['tarkov', 'minecraft', 'Gaming Voice']) {
      stage = 'create-' + channelName;
      await alice.getByRole('button', { name: 'Create channel in Games', exact: true }).click();
      const form = alice.getByRole('form', { name: 'Create channel', exact: true });
      if (channelName === 'Gaming Voice') await form.getByRole('radio', { name: /^Voice/ }).check();
      await form.getByRole('textbox', { name: 'Channel name', exact: true }).fill(channelName);
      await form.getByRole('combobox', { name: 'Category', exact: true }).selectOption('');
      const response = alice.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/matrix/_matrix/client/v3/createRoom');
      await form.getByRole('button', { name: channelName === 'Gaming Voice' ? 'Create voice channel' : 'Create text channel', exact: true }).click();
      const created = await response; assert.equal(created.status(), 200);
      const body = created.request().postDataJSON(); assert.equal(body.name, channelName); assert.equal(body.creation_content['m.federate'], false);
      const id = (await created.json()).room_id; assert.ok(isCiRoomId(id) && !rooms.has(id)); rooms.set(id, channelName); ids.push(id);
      await expect(form).toHaveCount(0, { timeout: 30000 }); await inspectChannel(id); await joinBob(id);
    }
    const [tarkov, minecraft, voice] = ids;
    await bob.reload(); await ready(bob); await bob.getByRole('button', { name, exact: true }).click();
    stage = 'drag-category';
    for (const id of ids) { await drag(id, games); await expect.poll(async () => (await layout()).channels.find(value => value.id === id)?.category).toBe(games); }
    await drag(voice, minecraft, true);
    for (const page of owners.keys()) await ordering(page, games, [tarkov, voice, minecraft]);
    stage = 'private-voice-editor';
    await sidebar(alice).getByRole('button', { name: 'Gaming Voice', exact: true }).click({ button: 'right' });
    stage = 'open-channel-settings';
    await alice.getByRole('menuitem', { name: 'Edit channel & permissions', exact: true }).click();
    stage = 'open-permissions-section';
    await alice.getByRole('tab', { name: 'Permissions', exact: true }).click();
    const access = alice.getByRole('region', { name: 'Private channel access', exact: true });
    stage = 'enable-private-audience';
    await access.getByRole('checkbox', { name: 'Use selected roles and members', exact: true }).check();
    stage = 'choose-gaming-role';
    await access.getByRole('checkbox', { name: 'Gaming', exact: true }).check();
    stage = 'save-private-audience';
    await access.getByRole('button', { name: 'Save channel access', exact: true }).click();
    stage = 'confirm-private-audience';
    await expect(access.getByRole('status')).toContainText('Private channel access saved');
    await alice.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
    stage = 'select-voice-for-both-accounts';
    for (const page of owners.keys()) await page.getByRole('button', { name: 'Gaming Voice', exact: true }).click();
    stage = 'two-user-voice';
    await conferenceSmoke({ alice, bob, aliceSession, bobSession, roomId: voice, origin, api }, { voiceFixture: { roomId: voice, serverId: server, runId }, onConnected: async () => {
      for (const page of owners.keys()) await expect(sidebar(page).getByRole('list', { name: 'Voice participants in Gaming Voice', exact: true }).getByRole('listitem')).toHaveCount(2, { timeout: 15000 });
      await drag(tarkov, other);
      for (const page of owners.keys()) { await ordering(page, games, [voice, minecraft]); await ordering(page, other, [tarkov]); }
    } });
    stage = 'reload-persistence';
    for (const page of owners.keys()) {
      await page.reload(); await ready(page); await page.getByRole('button', { name, exact: true }).click();
      await ordering(page, games, [voice, minecraft]); await ordering(page, other, [tarkov]);
      await expect(sidebar(page).getByRole('list', { name: 'Voice participants in Gaming Voice', exact: true })).toHaveCount(0);
    }
    console.log('PASS: real UI creates Games, tarkov, minecraft and Gaming Voice; drag/drop synchronizes and persists, selected Gaming roles govern voice, and both native conference participants appear and leave correctly.');
  } catch {
    const ui = await Promise.all([...owners.keys()].map(async page => {
      let timer;
      try { return await Promise.race([page.evaluate(() => {
        const state = (element) => !element ? 'missing' : element.closest('[aria-hidden="true"]') ? 'aria-hidden' : element.closest('[inert]') ? 'inert' : !element.getClientRects().length ? 'hidden' : element.disabled ? 'disabled' : 'visible';
        const tabs = document.querySelector('[aria-label="Channel settings sections"]');
        return { channel: state(document.querySelector('.channel-navigation button[aria-label="Gaming Voice"]')),
          settings: state(tabs), permissions: state([...tabs?.querySelectorAll('[role="tab"]') || []].find(tab => tab.textContent === 'Permissions')),
          sheet: state(document.querySelector('.detail-sheet')), dialogs: Math.min(10, document.querySelectorAll('[role="dialog"]').length),
          audience: state(document.querySelector('[aria-label="Private channel access"]')) };
      }), new Promise(resolve => { timer = setTimeout(() => resolve({ state: 'unavailable' }), 2500); })]); }
      catch { return { state: 'unavailable' }; } finally { clearTimeout(timer); }
    }));
    throw new Error('Native Games workflow failed at bounded stage: ' + stage + '; drag: ' + dragStage + '. UI observations: ' + JSON.stringify(ui));
  }
}
