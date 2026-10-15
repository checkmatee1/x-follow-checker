// End-only integration acceptance: real unpacked extension + synthetic HTTPS X pages.
// Never opens an existing browser profile or connects to a real X account.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadPlaywright } from '../src/browser.mjs';
import { createApp } from '../src/server.mjs';
const { chromium } = loadPlaywright();
const extension = fileURLToPath(new URL('../extension', import.meta.url));
const scratch = fileURLToPath(new URL('./artifacts/', import.meta.url));
const user = (id, username, name = username) => ({ __typename: 'User', rest_id: String(id), core: { screen_name: username, name }, legacy: { screen_name: username, name } });
const people = [user(1, 'alice', '=2+2'), user(2, 'bob'), user(3, 'carol', '<img src=x onerror=alert(1)>'), user(4, 'dave')];
const timeline = users => ({ data: { user: { result: { timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries: [
  ...users.map(person => ({ entryId: `user-${person.rest_id}`, content: { itemContent: { user_results: { result: person } } } })),
  { entryId: 'who-to-follow-900', content: { itemContent: { user_results: { result: user(900, 'recommendation') } } } },
  { entryId: 'cursor-bottom-0', content: { cursorType: 'Bottom', value: 'fixture' } }
] }] } } } } } });
async function until(predicate, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(50);
  }
}
async function setup({ mode = 'normal', loggedIn = true, online = true } = {}) {
  const profileDirectory = await mkdtemp(path.join(tmpdir(), 'x-checker-acceptance-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profileDirectory, {
      channel: 'chromium', headless: true, viewport: { width: 1280, height: 1050 },
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
    });
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 10_000 });
    const extensionId = worker.url().split('/')[2];
    const fixture = { mode, profileReads: 0, loginVisits: 0, paths: [] };
    // Synthetic cookie establishes an already logged-in fixture before opening the extension.
    if (loggedIn) await context.addCookies([{ name: 'fixture_signed_in', value: 'yes', domain: 'x.com', path: '/', secure: true }]);
    await context.route('https://x.com/**', async route => {
      const url = new URL(route.request().url());
      fixture.paths.push(url.pathname);
      if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204, body: '' });
      if (url.pathname.includes('/i/flow/login')) fixture.loginVisits++;
      if (url.pathname.includes('/graphql/')) {
        const operation = url.pathname.split('/').at(-1);
        const variables = JSON.parse(url.searchParams.get('variables') ?? 'null') ?? route.request().postDataJSON()?.variables ?? {};
        if (operation === 'UserByScreenName') {
          const name = variables.screen_name;
          if (name === 'unrelated' && fixture.mode === 'unrelated-error') return route.fulfill({ status: 500, json: { errors: [{}] } });
          if (name === 'target') fixture.profileReads++;
          const person = user(name === 'target' ? 99 : 101, name);
          person.legacy.friends_count = 3;
          person.legacy.followers_count = fixture.mode === 'incomplete' || (fixture.mode === 'changing' && fixture.profileReads > 1) ? 3 : 2;
          if (fixture.mode.startsWith('modern-')) {
            if (fixture.mode !== 'modern-root') { delete person.legacy.friends_count; delete person.legacy.followers_count; }
            return route.fulfill({ json: { data: { user_result_by_screen_name: { result: person } } } });
          }
          return route.fulfill({ json: { data: { user: { result: person } } } });
        }
        if (fixture.mode === 'rate-limited' && operation === 'Followers') return route.fulfill({ status: 429, json: {} });
        const second = url.searchParams.get('page') === '2';
        const users = operation === 'Following' ? (second ? [people[1], people[2]] : [people[0], people[1]]) : (second ? [people[3]] : [people[1]]);
        return route.fulfill({ json: timeline(users) });
      }
      const operation = url.pathname.endsWith('/following') ? 'Following' : url.pathname.endsWith('/followers') ? 'Followers' : 'UserByScreenName';
      const viewing = /^\/([\w]{1,15})\/?$/.exec(url.pathname)?.[1];
      const doProfile = viewing && !['home', 'explore', 'login'].includes(viewing);
      const name = fixture.mode === 'account-change' && operation === 'Followers' ? 'other' : 'target';
      const variables = operation === 'UserByScreenName' ? { screen_name: viewing } : { userId: '99' };
      const shouldFetch = operation !== 'UserByScreenName' || doProfile;
      const html = `<!doctype html><html><head><link rel="icon" href="data:,"></head><body style="height:5000px">
        <div id="nav"></div><main data-testid="primaryColumn">Synthetic X fixture, viewing ${url.pathname}
          ${fixture.mode.startsWith('modern-') && doProfile ? `<a href="/${viewing}/following"><span ${fixture.mode === 'modern-title' ? 'title="3"' : ''}>${fixture.mode === 'modern-abbreviated' || fixture.mode === 'modern-title' ? '3K' : '3'}</span> Following</a><a href="/${viewing}/followers"><span>2</span> Followers</a>` : ''}</main>
        <script>
        window.__fixtureDebug={bridge:!!window.__x_follow_checker_bridge_v2,data:!!window.XFollowData,events:[]};
        document.addEventListener('x-follow-checker-public-data-v2',event=>window.__fixtureDebug.events.push(JSON.parse(event.detail)));
        const signedIn=document.cookie.includes('fixture_signed_in=yes');
        if(signedIn) document.querySelector('#nav').innerHTML='<button data-testid="SideNav_AccountSwitcher_Button"><span>@${name}</span></button><a data-testid="AppTabBar_Profile_Link" href="/${name}">Profile</a>';
        else document.querySelector('#nav').textContent='Sign in to X';
        const postLists=${fixture.mode === 'modern-post' && operation !== 'UserByScreenName'};
        const variables=${JSON.stringify(variables)};
        const endpoint='/i/api/graphql/fixture/${operation}'+(postLists?'':'?variables='+encodeURIComponent(JSON.stringify(variables)));
        const readPage=url=>postLists?fetch(new Request(new URL(url,location.href),{method:'POST',body:JSON.stringify({variables})})):fetch(url);
        if(${Boolean(shouldFetch)} && signedIn){
          ${operation === 'Followers' ? "const xhr=new XMLHttpRequest();xhr.open(postLists?'POST':'GET',endpoint);xhr.send(postLists?JSON.stringify({variables}):null);" : 'readPage(endpoint);'}
          ${fixture.mode === 'unrelated-error' && operation === 'UserByScreenName' ? "fetch('/i/api/graphql/fixture/UserByScreenName?variables='+encodeURIComponent(JSON.stringify({screen_name:'unrelated'})));" : ''}
          let next=false;addEventListener('scroll',()=>{if(!next && scrollY>150){next=true;readPage(endpoint+(postLists?'?':'&')+'page=2')}});
        }
        </script></body></html>`;
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    });
    const source = await context.newPage();
    await source.goto('https://x.com/someone');
    const sourceId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://x.com/someone' }))[0].id);
    const dashboard = await context.newPage();
    const errors = [];
    dashboard.on('pageerror', error => errors.push(error.message));
    await dashboard.goto(`chrome-extension://${extensionId}/dashboard.html?tab=${sourceId}`);
    if (online && loggedIn) {
      await dashboard.locator('#online-mode').click();
      await dashboard.locator('#reconnect').click();
      await until(async () => (await dashboard.locator('#account').textContent()) === '@target', 'connection ready');
    }
    return { context, source, sourceId, dashboard, worker, fixture, extensionId, errors, async close() { await context.close(); await rm(profileDirectory, { recursive: true, force: true }); } };
  } catch (error) { await context?.close(); await rm(profileDirectory, { recursive: true, force: true }); throw error; }
}
async function directScan(env, options = {}) {
  return env.dashboard.evaluate(async ({ tabId, options }) => {
    const { ExistingTabScanner } = await import(chrome.runtime.getURL('scan.mjs'));
    window.acceptanceProgress = [];
    const scanner = new ExistingTabScanner(tabId, patch => window.acceptanceProgress.push(patch), { tick: 70, idleLimit: 1500, navigationTimeout: 4000, ...options });
    window.acceptanceScanner = scanner;
    try { return { results: await scanner.run(), progress: window.acceptanceProgress }; }
    catch (error) { return { error: error.message, progress: window.acceptanceProgress }; }
  }, { tabId: env.sourceId, options });
}

test('real extension E2E: detect self from other profile, reuse login, scan, search, export, retain original tab', { timeout: 45_000 }, async () => {
  const env = await setup();
  try {
    await until(async () => (await env.dashboard.locator('#account').textContent()) === '@target', 'auto-detect self');
    assert.equal(await env.dashboard.locator('#username').count(), 0);
    assert.equal(await env.dashboard.locator('#confirm').count(), 0);
    assert.equal(await env.dashboard.locator('input:not([type="search"]):not([type="file"])').count(), 0);
    assert.equal(await env.worker.evaluate(async () => (await chrome.windows.getAll()).length), 1);
    await mkdir(scratch, { recursive: true });
    await env.dashboard.screenshot({ path: path.join(scratch, 'extension-ready.png'), fullPage: true });
    await env.dashboard.locator('#start').click();
    try { await env.dashboard.locator('#results').waitFor({ state: 'visible', timeout: 25_000 }); }
    catch {
      assert.fail(JSON.stringify({ message: await env.dashboard.locator('#message').textContent(), source: env.source.url(), paths: env.fixture.paths, errors: env.errors, debug: await env.source.evaluate(() => window.__fixtureDebug), snapshot: await env.worker.evaluate(id => chrome.tabs.sendMessage(id, { type: 'snapshot' }), env.sourceId) }));
    }
    assert.equal(await env.dashboard.locator('#result-count').textContent(), '2');
    assert.equal(await env.dashboard.locator('#rows tr').count(), 2);
    assert.equal(await env.dashboard.locator('#rows img').count(), 0);
    assert.match(await env.dashboard.locator('#rows').textContent(), /alice/);
    assert.match(await env.dashboard.locator('#rows').textContent(), /<img src=x onerror=alert\(1\)>/);
    assert.doesNotMatch(await env.dashboard.locator('#rows').textContent(), /recommendation/);
    await env.dashboard.locator('#search').fill('carol');
    assert.equal(await env.dashboard.locator('#rows tr').count(), 1);
    await env.dashboard.locator('#search').fill('');
    const downloadPromise = env.dashboard.waitForEvent('download');
    await env.dashboard.locator('#export').click();
    const download = await downloadPromise;
    const csv = await readFile(await download.path(), 'utf8');
    assert.match(csv, /"'=2\+2"/);
    assert.equal(download.suggestedFilename(), 'target-not-following-back.csv');
    assert.equal(env.source.isClosed(), false);
    assert.equal(env.source.url(), 'https://x.com/someone');
    assert.equal(await env.source.locator('[data-testid="SideNav_AccountSwitcher_Button"]').textContent(), '@target');
    assert.equal(env.fixture.loginVisits, 0);
    assert.equal(env.fixture.profileReads, 2);
    assert.deepEqual(env.errors, []);
    await env.dashboard.screenshot({ path: path.join(scratch, 'extension-results.png'), fullPage: true });
    await env.dashboard.setViewportSize({ width: 390, height: 844 });
    assert.ok(await env.dashboard.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await env.dashboard.screenshot({ path: path.join(scratch, 'extension-mobile.png'), fullPage: true });
  } finally { await env.close(); }
});

for (const [mode, message] of [['incomplete', /未读取完整/], ['rate-limited', /读取频率/], ['changing', /人数发生变化/], ['account-change', /账号已变化/]]) {
  test(`real extension scanner stops without false results: ${mode}`, { timeout: 20_000 }, async () => {
    const env = await setup({ mode });
    try {
      const result = await directScan(env);
      assert.match(result.error ?? '', message);
      assert.equal(result.results, undefined);
      assert.equal(env.source.isClosed(), false);
      assert.equal(env.fixture.loginVisits, 0);
    } finally { await env.close(); }
  });
}

test('real extension cancel preserves source tab and login', { timeout: 20_000 }, async () => {
  const env = await setup({ mode: 'incomplete' });
  try {
    const pending = directScan(env, { idleLimit: 5000 });
    await until(() => env.source.url().endsWith('/followers'), 'followers page');
    await env.dashboard.evaluate(() => window.acceptanceScanner.cancel());
    const result = await pending;
    assert.match(result.error, /取消/);
    await env.source.waitForURL('https://x.com/someone');
    assert.equal(env.source.url(), 'https://x.com/someone');
    assert.equal(env.source.isClosed(), false);
    assert.equal(await env.source.locator('[data-testid="SideNav_AccountSwitcher_Button"]').textContent(), '@target');
    assert.equal(env.fixture.loginVisits, 0);
  } finally { await env.close(); }
});

test('concurrent dashboards cannot scan the same tab simultaneously', { timeout: 20_000 }, async () => {
  const env = await setup({ mode: 'incomplete' });
  let second;
  try {
    const pending = directScan(env, { idleLimit: 5000 });
    await until(() => env.source.url().endsWith('/followers'), 'first scanner active');
    second = await env.context.newPage();
    await second.goto(`chrome-extension://${env.extensionId}/dashboard.html?tab=${env.sourceId}`);
    const result = await directScan({ ...env, dashboard: second });
    assert.match(result.error, /另一个检查页面/);
    await env.dashboard.evaluate(() => window.acceptanceScanner.cancel());
    assert.match((await pending).error, /取消/);
  } finally { await env.close(); }
});

test('manual navigation is respected and not overwritten during cancellation/failure', { timeout: 20_000 }, async () => {
  const env = await setup({ mode: 'incomplete' });
  try {
    const pending = directScan(env, { idleLimit: 5000 });
    await until(() => env.source.url().endsWith('/followers'), 'scanner at followers');
    await env.source.goto('https://x.com/explore');
    const result = await pending;
    assert.ok(result.error);
    assert.equal(env.source.url(), 'https://x.com/explore');
  } finally { await env.close(); }
});

test('logged-out browser gets a useful message and never opens a login window', { timeout: 15_000 }, async () => {
  const env = await setup({ loggedIn: false });
  try {
    const result = await directScan(env, { navigationTimeout: 500 });
    assert.match(result.error, /未识别到当前登录账号/);
    assert.equal(env.fixture.loginVisits, 0);
    assert.equal(env.source.url(), 'https://x.com/someone');
  } finally { await env.close(); }
});

test('unrelated failed profile response cannot poison self-profile verification', { timeout: 20_000 }, async () => {
  const env = await setup({ mode: 'unrelated-error' });
  try {
    const result = await directScan(env);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.results.map(row => row.username), ['alice', 'carol']);
  } finally { await env.close(); }
});

test('content-message integration reports overflow instead of truncating into a false complete list', { timeout: 20_000 }, async () => {
  const env = await setup();
  try {
    await env.source.goto('https://x.com/target/following');
    await env.source.evaluate(() => {
      for (let start = 0; start < 100_001; start += 1000) {
        const users = Array.from({ length: Math.min(1000, 100_001 - start) }, (_, offset) => {
          const index = start + offset;
          return { id: String(1000 + index), username: 'u' + index, name: 'User ' + index };
        });
        document.dispatchEvent(new CustomEvent('x-follow-checker-public-data-v2', { detail: JSON.stringify({ operation: 'Following', userId: '99', path: location.pathname, users }) }));
      }
    });
    const result = await env.worker.evaluate(async id => {
      const state = await chrome.tabs.sendMessage(id, { type: 'snapshot', kind: 'Following', userId: '99' });
      return { error: state.list?.error, count: state.list?.users.length };
    }, env.sourceId);
    assert.match(result.error, /超过当前版本上限/);
    assert.equal(result.count, 100_000);
  } finally { await env.close(); }
});

test('installation guide replaces username form and retires all old scanning APIs', async () => {
  const app = await createApp();
  try {
    const response = await fetch(app.origin);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /chrome:\/\/extensions/);
    assert.match(html, /manifest\.json/);
    assert.doesNotMatch(html, /id="username"|id="confirm"|打开 Chrome 登录|__EXTENSION_DIRECTORY__/);
    assert.equal((await fetch(app.origin + '/api/start', { method: 'POST' })).status, 410);
    assert.equal((await fetch(app.origin + '/api/export')).status, 410);
    assert.equal((await fetch(app.origin + '/src/server.mjs')).status, 404);
    const foreignHostStatus = await new Promise((resolve, reject) => {
      const req = http.get(app.origin + '/', { headers: { Host: 'evil.invalid' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
    });
    assert.equal(foreignHostStatus, 403);
  } finally { await app.close(); }
});

// Integration regressions for the new profile envelope and count-less profile data.
for (const mode of ['modern-root', 'modern-lite', 'modern-title', 'modern-post', 'modern-abbreviated']) {
  test(`profile compatibility through real extension: ${mode}`, { timeout: 20_000 }, async () => {
    const env = await setup({ mode });
    try {
      const outcome = await directScan(env, { navigationTimeout: 1600 });
      if (mode === 'modern-abbreviated') {
        assert.match(outcome.error, /无法读取精确/);
        assert.equal(outcome.results, undefined);
        assert.equal(env.fixture.paths.some(path => path === '/target/following'), false);
      } else {
        assert.equal(outcome.error, undefined);
        assert.deepEqual(outcome.results.map(person => person.username), ['alice', 'carol']);
        assert.equal(env.fixture.profileReads, 2);
      }
    } finally { await env.close(); }
  });
}

const archiveFile = (kind, part, rows) => ({ name: `${kind}${part ? '-part' + part : ''}.js`, mimeType: 'text/javascript', buffer: Buffer.from(`window.YTD.${kind}.part${part} = ${JSON.stringify(rows)};`) });
const archiveRow = (kind, id, extra = {}) => ({ [kind]: { accountId: String(id), userLink: `https://x.com/intent/user?user_id=${id}`, ...extra } });

test('offline archive UI works without X tabs or login: multipart, IDs, search, CSV, pagination, no network', { timeout: 20_000 }, async () => {
  const env = await setup({ loggedIn: false, online: false });
  try {
    await env.source.close();
    const network = [];
    env.context.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
    assert.equal(await env.dashboard.locator('#offline-mode').getAttribute('aria-selected'), 'true');
    assert.equal(await env.dashboard.locator('#online-card').isVisible(), false);
    assert.equal(await env.dashboard.locator('#import-archive').isDisabled(), true);
    await env.dashboard.reload();
    assert.equal(await env.dashboard.locator('#account').textContent(), '尚未连接');
    const rows = Array.from({ length: 120 }, (_, i) => archiveRow('following', i + 1, i === 0 ? { name: '<img src=x onerror=alert(1)>' } : {}));
    rows.push(archiveRow('following', '9007199254740993'), archiveRow('following', 121, { screenName: 'named_user', name: '=2+2' }));
    await env.dashboard.locator('#following-files').setInputFiles([
      archiveFile('following', 1, [...rows.slice(61), rows[2]]), archiveFile('following', 0, rows.slice(0, 61))
    ]);
    await env.dashboard.locator('#follower-files').setInputFiles(archiveFile('follower', 0, [archiveRow('follower', 2), archiveRow('follower', 4)]));
    await env.dashboard.locator('#import-archive').click();
    await env.dashboard.locator('#results').waitFor({ state: 'visible' });
    assert.equal(await env.dashboard.locator('#result-count').textContent(), '120');
    assert.match(await env.dashboard.locator('#following-count').textContent(), /122/);
    assert.equal(await env.dashboard.locator('#rows tr').count(), 100);
    assert.equal(await env.dashboard.locator('#rows img').count(), 0);
    await env.dashboard.locator('#more').click();
    assert.equal(await env.dashboard.locator('#rows tr').count(), 120);
    assert.match(await env.dashboard.locator('#rows').textContent(), /<img src=x onerror=alert/);
    await env.dashboard.locator('#search').fill('9007199254740993');
    assert.equal(await env.dashboard.locator('#rows tr').count(), 1);
    assert.equal(await env.dashboard.locator('#rows a').getAttribute('href'), 'https://x.com/i/user/9007199254740993');
    assert.doesNotMatch(await env.dashboard.locator('#rows').textContent(), /@null|@undefined/);
    const pending = env.dashboard.waitForEvent('download');
    await env.dashboard.locator('#export').click();
    const download = await pending;
    const csv = await readFile(await download.path(), 'utf8');
    assert.equal(download.suggestedFilename(), 'archive-not-following-back.csv');
    assert.match(csv, /账号ID/);
    assert.match(csv, /9007199254740993/);
    assert.match(csv, /"'=2\+2"/);
    assert.match(await env.dashboard.locator('#result-note').textContent(), /不是实时/);
    await env.dashboard.locator('#search').fill('');
    await env.dashboard.screenshot({ path: path.join(scratch, 'offline-results.png'), fullPage: true });
    await env.dashboard.setViewportSize({ width: 390, height: 844 });
    assert.equal(await env.dashboard.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await env.dashboard.screenshot({ path: path.join(scratch, 'offline-mobile.png'), fullPage: true });
    await env.dashboard.locator('#following-files').setInputFiles([]);
    assert.equal(await env.dashboard.locator('#results').isVisible(), false);
    assert.equal(await env.dashboard.locator('#import-archive').isDisabled(), true);
    assert.deepEqual(network, []);
    assert.deepEqual(env.errors, []);
  } finally { await env.close(); }
});

test('offline archive UI rejects invalid, swapped, missing, duplicate and executable inputs with no stale results', { timeout: 20_000 }, async () => {
  const env = await setup({ loggedIn: false, online: false });
  try {
    await env.source.close();
    const good = archiveFile('follower', 0, []);
    const invalidCases = [
      [archiveFile('follower', 0, [archiveRow('follower', 1)]), /选反/],
      [archiveFile('following', 1, []), /不连续/],
      [[archiveFile('following', 0, []), { ...archiveFile('following', 0, []), name: 'copy.js' }], /重复/],
      [archiveFile('following', 0, [{ following: { accountId: 9007199254740992 } }]), /无效的账号 ID/],
      [{ name: 'following.js', mimeType: 'text/javascript', buffer: Buffer.from('window.YTD.following.part0 = []; window.__archiveExecuted=true;') }, /不是有效/],
      [{ name: 'following.js', mimeType: 'text/javascript', buffer: Buffer.from('window.YTD.following.part0 = [') }, /不是有效/]
    ];
    for (const [files, expected] of invalidCases) {
      await env.dashboard.locator('#following-files').setInputFiles(files);
      await env.dashboard.locator('#follower-files').setInputFiles(good);
      await env.dashboard.locator('#import-archive').click();
      await until(async () => (await env.dashboard.locator('#status-label').textContent()) === '导入未完成', 'invalid archive rejected');
      assert.match(await env.dashboard.locator('#message').textContent(), expected);
      assert.equal(await env.dashboard.locator('#results').isVisible(), false);
      assert.equal(await env.dashboard.evaluate(() => window.__archiveExecuted), undefined);
    }
    await env.dashboard.locator('#following-files').setInputFiles(archiveFile('following', 0, []));
    await env.dashboard.locator('#import-archive').click();
    await env.dashboard.locator('#results').waitFor({ state: 'visible' });
    assert.equal(await env.dashboard.locator('#result-count').textContent(), '0');
    assert.match(await env.dashboard.locator('#empty').textContent(), /所选存档/);
    await env.dashboard.locator('#online-mode').click();
    assert.equal(await env.dashboard.locator('#results').isVisible(), false);
    assert.equal(await env.dashboard.locator('#account').textContent(), '尚未连接');
    await env.dashboard.locator('#offline-mode').click();
    assert.equal(await env.dashboard.locator('#offline-card').isVisible(), true);
    assert.deepEqual(env.errors, []);
  } finally { await env.close(); }
});
