import {test,expect} from '@playwright/test';
test('calendar compares only shared time zones, sends an event and records RSVP and reminder choices',async({page})=>{
 await page.route(url=>url.pathname==='/lib/matrix.ts',route=>route.fulfill({contentType:'text/javascript',body:`export const getMatrixClient=()=>window.eventPlanning.client;export const onMatrixUpdate=fn=>{window.eventPlanning.listeners.add(fn);return()=>window.eventPlanning.listeners.delete(fn)};`}));
 await page.route(url=>url.pathname==='/lib/api.ts',route=>route.fulfill({contentType:'text/javascript',body:`export const accountArtworkOwner=()=>window.eventPlanning.owner;`}));
 await page.route(url=>url.pathname==='/lib/community.ts',route=>route.fulfill({contentType:'text/javascript',body:`export const readMemberProfile=(room,user)=>({timezone:user==='@alice:local'?'America/New_York':''});`}));
 await page.route('**/event-planning-test',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>t=>t;window.__vite_plugin_react_preamble_installed__=true;await import('/tests/browser/fixtures/event-planning.tsx');</script></body></html>`}));
 await page.setViewportSize({width:390,height:844});await page.goto('/event-planning-test');
 await page.getByRole('button',{name:'Calendar',exact:true}).click();await page.getByRole('button',{name:'New event'}).click();
 await page.getByLabel('Title',{exact:true}).fill('Games night');await page.getByLabel('Event start (your local time)',{exact:true}).fill('2030-07-04T17:00');
 await page.getByText('Find a time together',{exact:true}).click();await page.getByLabel('Alice',{exact:true}).check();await page.getByLabel('Bob',{exact:true}).check();
 await expect(page.locator('.time-together')).toContainText('Time zone not shared');await expect(page.locator('.time-together')).toContainText('2030');
 await page.getByRole('button',{name:'30 minutes later'}).click();await expect(page.getByLabel('Event start (your local time)',{exact:true})).toHaveValue('2030-07-04T17:30');
 await page.getByRole('button',{name:'Create',exact:true}).click();await expect(page.getByRole('heading',{name:'Games night'})).toBeVisible();
 await page.getByRole('button',{name:'Going (0)',exact:true}).click();await expect(page.getByRole('button',{name:'Going (1)',exact:true})).toHaveAttribute('aria-pressed','true');
 await page.getByRole('button',{name:'Remind me',exact:true}).click();expect(await page.evaluate(()=>(window as any).eventPlanning.reminders)).toEqual(['$1']);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
