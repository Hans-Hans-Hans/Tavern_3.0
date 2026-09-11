import { test, expect, type Page } from '@playwright/test';

async function fixture(page: Page) {
  await page.route(url => url.pathname === '/lib/api.ts', route => route.fulfill({ contentType: 'text/javascript', body: `export const accountArtworkOwner=()=>window.searchFixture.owner;` }));
  await page.route(url => url.pathname === '/lib/matrix.ts', route => route.fulfill({ contentType: 'text/javascript', body: `
    const f=window.searchFixture={owner:{},actor:'@me:local',device:'UNIFIED',chosen:[],resolved:[],downloads:[],watchers:new Set(),listeners:new Map(),ignored:[]};
    const member=(userId,name)=>({userId,name,membership:'join'});
    const room=(roomId,name,space,members)=>({roomId,name,space,membership:'join',events:[],members,getMyMembership(){return this.membership;},isSpaceRoom(){return this.space;},getJoinedMembers(){return this.members.filter(m=>m.membership==='join');},getMember(id){return this.members.find(m=>m.userId===id);},getLiveTimeline(){return {getEvents:()=>this.events,getPaginationToken:()=>null};},findEventById(id){return this.events.find(e=>e.getId()===id);}});
    const joined=room('!room:local','Project channel',false,[member('@alice:local','Captain Alice'),member('@me:local','Me')]),server=room('!server:local','Project server',true,[]),hidden=room('!hidden:local','Hidden project',false,[member('@hidden:local','Hidden')]);hidden.membership='invite';f.rooms=[joined,server,hidden];
    const event=(id,content,ts)=>({status:null,event:{},isRedacted:()=>false,isRedaction:()=>false,isEncrypted:()=>false,isDecryptionFailure:()=>false,getType:()=> 'm.room.message',getId:()=>id,getRoomId:()=>joined.roomId,getSender:()=> '@alice:local',getTs:()=>ts,getContent:()=>content,replacingEventDate:()=>null});
    joined.events=[event('$text',{msgtype:'m.text',body:'Private launch plan'},100),event('$file',{msgtype:'m.file',body:'Design review',filename:'Secret_roadmap-final.pdf',url:'mxc://old/indexed',info:{mimetype:'application/pdf',size:12}},200),event('$image',{msgtype:'m.image',body:'Tower image',filename:'Tower.png',url:'mxc://old/image',info:{mimetype:'image/png',size:4}},300)];
    f.client={getUserId:()=>f.actor,getDeviceId:()=>f.device,getIgnoredUsers:()=>f.ignored,getRooms:()=>f.rooms,getRoom:id=>f.rooms.find(r=>r.roomId===id),on:(name,fn)=>{const set=f.listeners.get(name)||new Set();set.add(fn);f.listeners.set(name,set);},off:(name,fn)=>f.listeners.get(name)?.delete(fn),decryptEventIfNeeded:async()=>{}};
    f.notify=()=>f.watchers.forEach(fn=>fn());
    export const getMatrixClient=()=>f.client;
    export const onMatrixUpdate=fn=>{f.watchers.add(fn);return()=>f.watchers.delete(fn);};
    export async function resolveMatrixMessage(roomId,id){f.resolved.push({roomId,id});if(f.holdResolve)await new Promise(resolve=>f.releaseResolve=resolve);return {id,conversation_id:roomId,body:'Current native content',attachments:id==='$text'?[]:[{id,name:id==='$file'?'Current-roadmap.pdf':'Current-tower.png',size:12,type:id==='$file'?'application/pdf':'image/png',url:'mxc://current/'+id.slice(1)}]};}
    export async function matrixFileBlob(item,signal){f.downloads.push({url:item.url,aborted:signal?.aborted});if(f.holdBlob)await new Promise(resolve=>f.releaseBlob=resolve);return new Blob(['file payload'],{type:'application/octet-stream'});}
    export const downloadMatrixFile=async item=>{f.downloads.push({url:item.url,direct:true});};
  ` }));
  await page.route('**/unified-search-test', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;await(await import('/tests/browser/fixtures/unified-search.tsx')).mountFixture();</script></body></html>` }));
  await page.goto('/unified-search-test'); await page.waitForFunction(() => (window as any).searchFixture?.ready === true);
  await expect(page.getByRole('textbox', { name: 'Search Tavern' })).toBeVisible();
}

test('one search selects cached people, joined places and indexed messages without downloading history', async ({ page }) => {
  await fixture(page); const input = page.getByRole('textbox', { name: 'Search Tavern' });
  await input.fill('project'); await page.getByRole('button', { name: /Project channel.*Open conversation/ }).click();
  await page.getByRole('button', { name: /Project server.*Open server/ }).click();
  await expect(page.getByText('Hidden project')).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Result type' }).selectOption('people'); await input.fill('captain');
  const person = page.getByRole('button', { name: /Captain Alice.*Open profile/ }); await person.focus(); await person.press('Enter');
  await page.getByRole('combobox', { name: 'Result type' }).selectOption('messages'); await input.fill('launch');
  await page.getByRole('button', { name: 'Open message in Project channel by Captain Alice' }).click();
  expect(await page.evaluate(() => (window as any).searchFixture.chosen)).toEqual(['room:!room:local', 'server:!server:local', 'person:@alice:local:!room:local', 'message:$text']);
  expect(await page.evaluate(() => (window as any).searchFixture.downloads)).toEqual([]);
});

test('filename-only match uses encrypted postings and opens the current native attachment for download', async ({ page }) => {
  await fixture(page); await page.getByRole('combobox', { name: 'Result type' }).selectOption('files'); await page.getByRole('textbox', { name: 'Search Tavern' }).fill('roadmap');
  const file = page.getByRole('button', { name: 'Open file Secret_roadmap-final.pdf' }); await expect(file).toBeVisible();
  expect(await page.evaluate(() => (window as any).searchFixture.downloads)).toEqual([]);
  const rows = await page.evaluate(async () => {
    const request = indexedDB.open('tavern-search-v1-' + encodeURIComponent('@me:local') + '-UNIFIED');
    const database = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const read = database.transaction('documents').objectStore('documents').getAll();
    const result = await new Promise<any[]>((resolve, reject) => { read.onsuccess = () => resolve(read.result); read.onerror = () => reject(read.error); }); database.close(); return JSON.stringify(result);
  });
  for (const value of ['Secret_roadmap', 'Design review', 'application/pdf', 'mxc://']) expect(rows).not.toContain(value);
  await file.click(); await expect(page.getByRole('dialog', { name: 'Current-roadmap.pdf' })).toBeVisible();
  const download = page.waitForEvent('download'); await page.getByRole('link', { name: 'Download', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('Current-roadmap.pdf');
  expect(await page.evaluate(() => (window as any).searchFixture.downloads)).toEqual([{ url: 'mxc://current/file', aborted: false }]);
});

test('continuous Matrix updates do not starve a pending indexed query or reset loaded results', async ({ page }) => {
  await fixture(page);
  await expect(page.getByRole('button', { name: 'Refresh results' })).toBeEnabled();
  await page.evaluate(() => {
    const f = (window as any).searchFixture, decrypt = SubtleCrypto.prototype.decrypt;
    f.queryDecrypts = 0;
    SubtleCrypto.prototype.decrypt = async function (...args) {
      const plain = await decrypt.apply(this, args); f.queryDecrypts++;
      if (!f.releaseSearch) await new Promise<void>(resolve => { f.releaseSearch = resolve; });
      return plain;
    };
    f.restoreDecrypt = () => { SubtleCrypto.prototype.decrypt = decrypt; };
    f.eventStream = setInterval(f.notify, 30);
  });
  await page.getByRole('textbox', { name: 'Search Tavern' }).fill('roadmap');
  await page.waitForFunction(() => typeof (window as any).searchFixture.releaseSearch === 'function');
  await page.evaluate(() => (window as any).searchFixture.releaseSearch());
  await expect(page.getByRole('button', { name: 'Open file Secret_roadmap-final.pdf' })).toBeVisible();
  await page.waitForFunction(() => (window as any).searchFixture.queryDecrypts === 1);
  await page.evaluate(() => { const f = (window as any).searchFixture; clearInterval(f.eventStream); f.restoreDecrypt(); });
});

test('additional inventory pages remain loaded across unrelated Matrix events', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => { const f = (window as any).searchFixture; for (let i = 0; i < 32; i++) f.rooms.push({ ...f.rooms[0], roomId: '!extra' + i + ':local', name: 'Project extra ' + i, members: [], events: [] }); });
  await page.getByRole('combobox', { name: 'Result type' }).selectOption('channels');
  await page.getByRole('textbox', { name: 'Search Tavern' }).fill('project');
  const region = page.getByRole('region', { name: 'People and places' });
  await expect(region.getByRole('button', { name: /Open conversation/ })).toHaveCount(20);
  await page.getByRole('button', { name: 'More people and places' }).click();
  await expect(region.getByRole('button', { name: /Open conversation/ })).toHaveCount(33);
  await page.evaluate(() => { const f = (window as any).searchFixture; for (let i = 0; i < 20; i++) f.notify(); });
  await expect(region.getByRole('button', { name: /Open conversation/ })).toHaveCount(33);
});

test('an API-owner replacement cannot rebuild the previous account cached people or places', async ({ page }) => {
  await fixture(page); await page.getByRole('combobox', { name: 'Result type' }).selectOption('people');
  await page.getByRole('textbox', { name: 'Search Tavern' }).fill('captain');
  await expect(page.getByRole('button', { name: /Captain Alice.*Open profile/ })).toBeVisible();
  await page.evaluate(() => { const f = (window as any).searchFixture; f.owner = {}; f.owner = {}; f.notify(); });
  await expect(page.getByRole('alert')).toContainText('Close and reopen search');
  await expect(page.getByRole('button', { name: /Captain Alice.*Open profile/ })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Search Tavern' }).fill('project');
  await page.getByRole('combobox', { name: 'Result type' }).selectOption('channels');
  await expect(page.getByRole('alert')).toContainText('Close and reopen search');
  await expect(page.getByRole('button', { name: /Project channel.*Open conversation/ })).toHaveCount(0);
});

test('awaited record decryption rechecks current membership, ignore rules, room model and account ownership', async ({ page }) => {
  for (const change of ['room', 'ignore', 'replace', 'owner', 'device']) {
    await fixture(page); await expect(page.getByRole('button', { name: 'Refresh results' })).toBeEnabled();
    await page.evaluate(async () => {
      const f = (window as any).searchFixture, decrypt = SubtleCrypto.prototype.decrypt;
      f.holdQuery = true; const waiting: (() => void)[] = [];
      SubtleCrypto.prototype.decrypt = async function (...args) {
        const plain = await decrypt.apply(this, args);
        if (f.holdQuery) await new Promise<void>(resolve => {
          waiting.push(resolve);
          f.releaseQuery = () => { f.holdQuery = false; for (const release of waiting.splice(0)) release(); };
        });
        return plain;
      };
      f.restoreDecrypt = () => { SubtleCrypto.prototype.decrypt = decrypt; };
      const search = f.search;
      void search.searchMessages('roadmap').then(result => { f.queryResult = { ok: true, ids: result.hits.map(hit => hit.id) }; }, () => { f.queryResult = { ok: false }; });
    });
    await page.waitForFunction(() => typeof (window as any).searchFixture.releaseQuery === 'function');
    await page.evaluate(change => {
      const f = (window as any).searchFixture;
      if (change === 'room') f.rooms[0].membership = 'leave'; else if (change === 'ignore') f.ignored.push('@alice:local');
      else if (change === 'replace') f.rooms[0] = { ...f.rooms[0] }; else if (change === 'device') f.device = 'NEW'; else { f.owner = {}; f.owner = {}; }
      f.restoreDecrypt(); f.releaseQuery();
    }, change);
    await expect.poll(() => page.evaluate(() => (window as any).searchFixture.queryResult)).toEqual(['owner', 'device'].includes(change) ? { ok: false } : { ok: true, ids: [] });
  }
});

test('revoked room and changed API generation discard delayed native message opens', async ({ page }) => {
  for (const change of ['room', 'owner']) {
    await fixture(page); await page.getByRole('textbox', { name: 'Search Tavern' }).fill('roadmap');
    await page.evaluate(() => { (window as any).searchFixture.holdResolve = true; });
    await page.getByRole('button', { name: 'Open file Secret_roadmap-final.pdf' }).click();
    await page.waitForFunction(() => typeof (window as any).searchFixture.releaseResolve === 'function');
    await page.evaluate(change => { const f = (window as any).searchFixture; if (change === 'room') f.rooms[0].membership = 'leave'; else { f.owner = {}; f.owner = {}; } f.notify(); f.releaseResolve(); }, change);
    await expect(page.getByRole('button', { name: 'Open file Secret_roadmap-final.pdf' })).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).searchFixture.downloads)).toEqual([]);
  }
});

test('media scope revocation discards late blobs and revokes an already displayed object URL', async ({ page }) => {
  for (const late of [true, false]) {
    await fixture(page); await page.getByRole('textbox', { name: 'Search Tavern' }).fill('roadmap');
    await page.evaluate(late => {
      const f = (window as any).searchFixture, create = URL.createObjectURL, revoke = URL.revokeObjectURL; f.urls = []; f.revoked = []; f.holdBlob = late;
      URL.createObjectURL = blob => { const value = create(blob); f.urls.push(value); return value; }; URL.revokeObjectURL = value => { f.revoked.push(value); revoke(value); };
    }, late);
    await page.getByRole('button', { name: 'Open file Secret_roadmap-final.pdf' }).click();
    if (late) await page.waitForFunction(() => typeof (window as any).searchFixture.releaseBlob === 'function');
    else { await expect(page.getByRole('link', { name: 'Download', exact: true })).toBeVisible(); await page.evaluate(() => (window as any).searchFixture.notify()); await expect(page.getByRole('link', { name: 'Download', exact: true })).toBeVisible(); }
    await page.evaluate(late => { const f = (window as any).searchFixture; f.rooms[0].membership = 'leave'; f.notify(); if (late) f.releaseBlob(); }, late);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const state = await page.evaluate(() => { const f = (window as any).searchFixture; return { urls: f.urls, revoked: f.revoked, reads: f.downloads.length }; });
    expect(state.reads).toBe(1); expect(state.urls.length).toBe(late ? 0 : 1); expect(state.revoked).toEqual(state.urls);
  }
});
