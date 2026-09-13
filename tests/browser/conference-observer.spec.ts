import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { conferenceFailureFields, installConferenceObserver, requestConferenceObserverBinding } from '../../scripts/smoke-conference.mjs';

test('late native voice observer obtains a fresh owned handshake and rejects a different device', async ({ page }) => {
  const origin = 'https://chat.example.test', roomId = '!voice:chat.example.test', widgetId = 'widget_nonce_123456789012345', session = 'session_nonce_123456789012345';
  const owner = { userId: '@cialice:chat.example.test', deviceId: 'ALICE' }, peer = { userId: '@cibob:chat.example.test', deviceId: 'BOB' };
  for (const name of ['conference-telemetry', 'conference-telemetry-protocol']) {
    const source = await readFile(`lib/${name}.ts`, 'utf8');
    const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
    await page.route(origin + '/lib/' + name, route => route.fulfill({ contentType: 'text/javascript', body: output }));
  }
  const query = new URLSearchParams({ widgetId, tavernTelemetry: session, roomId, userId: owner.userId, deviceId: owner.deviceId, baseUrl: origin, parentUrl: origin, perParticipantE2EE: 'true' });
  const peers = [owner, peer].map((p, index) => ({ identity: 'native-' + index, ...p, displayName: 'Participant', avatarMxc: null, local: index === 0, microphoneEnabled: true, cameraEnabled: false, screenShareEnabled: false, speaking: false, encrypted: true, e2eeEnabled: true }));
  await page.route(origin + '/element-call/index.html', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><body>Owned call<script>
    let documentNonce='',sequence=0;const params=new URLSearchParams(location.hash.slice(2));window.send=()=>parent.postMessage({type:'io.tavern.call.telemetry',version:1,widgetId:params.get('widgetId'),session:params.get('tavernTelemetry'),roomId:params.get('roomId'),document:documentNonce,sequence:++sequence,connected:true,reconnecting:false,participants:${JSON.stringify(peers)},complete:true,e2eeEnabled:true,metrics:{rttMs:1,jitterMs:1,packetLossPercent:0,sampledTracks:1,totalTracks:1}},location.origin);
    addEventListener('message',event=>{if(event.source===parent&&event.origin===location.origin&&event.data.type==='io.tavern.call.telemetry.bind'){documentNonce=event.data.document;window.currentChallenge=documentNonce;sequence=0;window.send();}});
  </script></body>` }));
  await page.route(origin + '/probe', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><body><iframe title="Tavern encrypted conference" src="/element-call/index.html#?${query}"></iframe><script type="module">
    import {observeConferenceTelemetry} from '/lib/conference-telemetry';window.updates=[];window.stop=observeConferenceTelemetry({iframe:document.querySelector('iframe'),widgetId:${JSON.stringify(widgetId)},session:${JSON.stringify(session)},roomId:${JSON.stringify(roomId)},isCurrent:()=>true,onUpdate:value=>window.updates.push(value)});
  </script></body>` }));
  await page.goto(origin + '/probe');
  await expect.poll(() => page.evaluate(() => (window as any).updates?.at(-1)?.connected)).toBe(true);
  const frame = page.frameLocator('iframe'), oldChallenge = await frame.locator('body').evaluate(() => (window as any).currentChallenge);
  expect(await page.evaluate(installConferenceObserver, { nonce: 'probe', roomId, owner, owners: [owner, peer], failureFields: conferenceFailureFields })).toBe(true);
  await frame.locator('body').evaluate(() => (window as any).send());
  expect(await page.evaluate(() => (window as any).__tavernCiConferenceSmoke.read().status)).toBe('waiting');
  expect(await frame.locator('body').evaluate(requestConferenceObserverBinding, { roomId, owner: { ...owner, deviceId: 'REPLACEMENT' } })).toBe(false);
  expect(await frame.locator('body').evaluate(requestConferenceObserverBinding, { roomId, owner })).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).__tavernCiConferenceSmoke.read().status)).toBe('ready');
  expect(await frame.locator('body').evaluate(() => (window as any).currentChallenge)).not.toBe(oldChallenge);
});
