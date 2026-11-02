// End-only integration acceptance: local server, real Chromium, synthetic archives.
// Never reads existing browser profiles or real account data.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readFile, mkdir, writeFile, symlink, truncate } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { loadPlaywright } from './browser.mjs';
import { createApp } from '../src/server.mjs';
const { chromium } = loadPlaywright();
const scratch = fileURLToPath(new URL('./artifacts/', import.meta.url));
async function until(predicate, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(50);
  }
}
const archiveRow = (kind, id, extra = {}) => ({ [kind]: { accountId: String(id), ...extra } });

const runFixture = promisify(execFile);
async function zipFixture(filename, entries) {
  // Synthetic records only. No existing user archive or private file is opened.
  await runFixture('python3', ['-c', `import json,sys,zipfile
with zipfile.ZipFile(sys.argv[1], 'w', compression=zipfile.ZIP_DEFLATED) as archive:
 for name, text in json.loads(sys.argv[2]).items(): archive.writestr(name, text)
`, filename, JSON.stringify(entries)]);
}
const partText = (kind, part, rows) => `window.YTD.${kind}.part${part} = ${JSON.stringify(rows)};`;
const postArchive = (origin, id, headers = {}) => fetch(origin + '/api/compare', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ id }) });

test('folder homepage reads dropped ZIP automatically, refreshes, separates archives, searches and exports without external requests', { timeout: 30_000 }, async () => {
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(path.join(tmpdir(), 'x-folder-ui-'));
  const app = await createApp({ archiveDirectory: directory });
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chromium', headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1050 }, acceptDownloads: true });
    const network = []; const errors = [];
    page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(app.origin);
    await until(async () => (await page.locator('#status').textContent()).includes('还没有存档'), 'empty folder guidance');
    const rows = Array.from({ length: 120 }, (_, i) => archiveRow('following', i + 1));
    rows.push(archiveRow('following', '9007199254740993', { name: '<img src=x onerror=alert(1)>' }), archiveRow('following', 121, { name: '=2+2' }));
    await zipFixture(path.join(directory, 'download.zip'), {
      'twitter-archive/data/following.js': partText('following', 0, rows.slice(0, 61)),
      'twitter-archive/data/following-part1.js': partText('following', 1, [...rows.slice(61), rows[2]]),
      'twitter-archive/data/follower.js': partText('follower', 0, [archiveRow('follower', 2), archiveRow('follower', 4)]),
      'twitter-archive/data/direct-messages.js': 'not a relationship file; this content must never be parsed'
    });
    await page.locator('#refresh').click();
    await page.locator('#results').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#result-count').textContent(), '120');
    assert.equal(await page.locator('#rows tr').count(), 100);
    await page.locator('#more').click();
    assert.equal(await page.locator('#rows tr').count(), 120);
    assert.equal(await page.locator('#rows img').count(), 0);
    await page.locator('#search').fill('9007199254740993');
    assert.equal(await page.locator('#rows tr').count(), 1);
    assert.equal(await page.locator('#rows a').getAttribute('href'), 'https://x.com/i/user/9007199254740993');
    const pending = page.waitForEvent('download');
    await page.locator('#export').click();
    const download = await pending;
    const csv = await readFile(await download.path(), 'utf8');
    assert.match(csv, /9007199254740993/);
    assert.match(csv, /"'=2\+2"/);
    await page.locator('#search').fill('');
    await page.screenshot({ path: path.join(scratch, 'folder-results.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(scratch, 'folder-mobile.png'), fullPage: true });
    await zipFixture(path.join(directory, 'second.zip'), {
      'data/following.js': partText('following', 0, [archiveRow('following', 999)]),
      'data/follower.js': partText('follower', 0, [])
    });
    await page.locator('#refresh').click();
    await until(async () => !(await page.locator('#refresh').isDisabled()), 'folder refresh completed');
    assert.equal(await page.locator('#archive-source').inputValue(), 'second.zip');
    assert.equal(await page.locator('#result-count').textContent(), '1');
    await page.locator('#archive-source').selectOption('download.zip');
    await until(async () => (await page.locator('#result-count').textContent()) === '120', 'manual older archive selection');
    assert.equal(await page.locator('#archive-source').inputValue(), 'download.zip');
    await page.locator('#refresh').click();
    await until(async () => !(await page.locator('#refresh').isDisabled()), 'refresh resets to latest archive');
    assert.equal(await page.locator('#archive-source').inputValue(), 'second.zip');
    await until(async () => (await page.locator('#result-count').textContent()) === '1', 'separate archive result');
    assert.match(await page.locator('#rows').textContent(), /999/);
    await page.reload();
    await page.locator('#results').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#archive-source').inputValue(), 'second.zip');
    await writeFile(path.join(directory, 'second.zip'), 'incomplete download');
    await page.locator('#refresh').click();
    await page.locator('#error').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#results').isVisible(), false);
    assert.equal(network.every(url => new URL(url).origin === app.origin), true);
    assert.deepEqual(errors, []);
  } finally { if (browser) await browser.close(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('folder API handles extracted shards and rejects path escape, mixed ZIPs, oversized files and foreign origins', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'x-folder-api-'));
  const app = await createApp({ archiveDirectory: directory });
  try {
    for (const [name, id] of [['one', 41], ['two', 42]]) {
      const data = path.join(directory, name, 'data'); await mkdir(data, { recursive: true });
      await writeFile(path.join(data, 'following.js'), partText('following', 0, [archiveRow('following', id)]));
      await writeFile(path.join(data, 'follower.js'), partText('follower', 0, []));
    }
    await symlink(path.join(directory, 'one'), path.join(directory, 'linked'));
    await symlink(path.join(directory, 'one/data/following.js'), path.join(directory, 'following.js'));
    const catalog = await (await fetch(app.origin + '/api/archives')).json();
    assert.equal(catalog.archives.length, 2);
    assert.equal(JSON.stringify(catalog).includes('accountId'), false);
    const result = await (await postArchive(app.origin, 'one/data')).json();
    assert.deepEqual(result.results.map(row => row.id), ['41']);
    assert.equal((await postArchive(app.origin, '../one/data')).status, 400);
    assert.equal((await fetch(app.origin + '/archives/one/data/following.js')).status, 404);
    assert.equal((await fetch(app.origin + '/api/archives', { headers: { Origin: 'https://evil.invalid' } })).status, 403);
    assert.equal((await postArchive(app.origin, 'one/data', { 'Content-Type': 'text/plain' })).status, 415);
    await writeFile(path.join(directory, 'one/data/following-part2.js'), partText('following', 2, []));
    const gap = await postArchive(app.origin, 'one/data'); assert.equal(gap.status, 400); assert.match((await gap.json()).error, /不连续/);
    await zipFixture(path.join(directory, 'mixed.zip'), {
      'a/following.js': partText('following', 0, []), 'a/follower.js': partText('follower', 0, []),
      'b/following.js': partText('following', 0, []), 'b/follower.js': partText('follower', 0, [])
    });
    const mixed = await postArchive(app.origin, 'mixed.zip'); assert.equal(mixed.status, 400); assert.match((await mixed.json()).error, /多组名单/);
    await truncate(path.join(directory, 'two/data/following.js'), 100 * 1024 * 1024 + 1);
    const large = await postArchive(app.origin, 'two/data'); assert.equal(large.status, 400); assert.match((await large.json()).error, /100 MB/);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});


test('local API rejects executable, swapped, duplicate, missing and invalid lists; valid empty archive succeeds', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'x-local-invalid-'));
  const app = await createApp({ archiveDirectory: directory });
  try {
    await writeFile(path.join(directory, 'follower.js'), partText('follower', 0, []));
    const invalidCases = [
      [partText('follower', 0, []), /选反/],
      [partText('following', 1, []), /不连续/],
      [partText('following', 0, [{ following: { accountId: 9007199254740992 } }]), /无效的账号 ID/],
      ['window.YTD.following.part0 = []; globalThis.__archiveExecuted=true;', /不是有效/],
      ['window.YTD.following.part0 = [', /不是有效/]
    ];
    for (const [text, expected] of invalidCases) {
      await writeFile(path.join(directory, 'following.js'), text);
      const response = await postArchive(app.origin, '.');
      assert.equal(response.status, 400); assert.match((await response.json()).error, expected);
    }
    await writeFile(path.join(directory, 'following.js'), partText('following', 0, []));
    await writeFile(path.join(directory, 'following-part1.js'), partText('following', 0, []));
    const duplicate = await postArchive(app.origin, '.'); assert.equal(duplicate.status, 400); assert.match((await duplicate.json()).error, /重复/);
    await rm(path.join(directory, 'following-part1.js'));
    const empty = await postArchive(app.origin, '.'); assert.equal(empty.status, 200); assert.deepEqual((await empty.json()).results, []);
    await rm(path.join(directory, 'follower.js'));
    const missing = await postArchive(app.origin, '.'); assert.equal(missing.status, 400); assert.match((await missing.json()).error, /缺少关注或粉丝名单/);
    assert.equal(globalThis.__archiveExecuted, undefined);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('standalone local assets, health and request boundaries work without retired routes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'x-local-boundaries-'));
  const app = await createApp({ archiveDirectory: directory });
  try {
    const homepage = await fetch(app.origin);
    assert.equal(homepage.status, 200);
    const html = await homepage.text();
    assert.doesNotMatch(html, /__ARCHIVE_DIRECTORY__|chrome-extension:|扩展安装/);
    for (const asset of ['/style.css', '/local.js', '/csv.mjs']) assert.equal((await fetch(app.origin + asset)).status, 200);
    for (const retired of ['/install', '/shared.js', '/extension/manifest.json', '/src/server.mjs', '/archives/following.js']) assert.equal((await fetch(app.origin + retired)).status, 404);
    const health = await fetch(app.origin + '/health'); assert.equal(health.status, 200); assert.deepEqual(await health.json(), { service: 'x-follow-checker-folder', protocol: 1, profileVersion: 2, proxyVersion: 1 });
    const unavailable = await (await fetch(app.origin + '/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ['123'] }) })).json();
    assert.match(unavailable.message, /独立临时代理未接入/);
    assert.equal((await fetch(app.origin + '/health', { headers: { Origin: 'https://evil.invalid' } })).status, 403);
    assert.equal((await fetch(app.origin + '/api/archives', { headers: { 'Sec-Fetch-Site': 'same-site' } })).status, 403);
    const foreignHost = await new Promise((resolve, reject) => {
      const req = http.get(app.origin + '/', { headers: { Host: 'evil.invalid' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject);
    });
    assert.equal(foreignHost, 403);
    assert.equal((await fetch(app.origin + '/api/compare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'invalid' })).status, 400);
    assert.equal((await fetch(app.origin + '/api/compare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'x'.repeat(17000) }) })).status, 413);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('public username workflow persists cache across reload and restart, updates on demand and keeps results on failure', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'x-profile-ui-'));
  let calls = []; let revision = 1; let unavailable = false;
  const lookup = async id => {
    calls.push(id);
    if (unavailable) throw new Error('公开查询暂不可用');
    if (id === '103') return null;
    return { username: `user${id}v${revision}`, name: `Name ${id} v${revision}` };
  };
  await writeFile(path.join(directory, 'following.js'), partText('following', 0, ['101', '102', '103'].map(id => archiveRow('following', id))));
  await writeFile(path.join(directory, 'follower.js'), partText('follower', 0, []));
  let app = await createApp({ archiveDirectory: directory, profileLookup: lookup });
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chromium', headless: true });
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(app.origin); await page.locator('#results').waitFor({ state: 'visible' });
    assert.deepEqual(calls, []);
    await page.locator('#lookup').click();
    await until(async () => !(await page.locator('#lookup').isDisabled()), 'username lookup');
    assert.deepEqual(calls, ['101', '102', '103']);
    assert.match(await page.locator('#rows').textContent(), /@user101v1/);
    assert.match(await page.locator('#rows').textContent(), /ID 103/);
    const cached = JSON.parse(await readFile(path.join(directory, '.profile-cache/user-profiles.json'), 'utf8'));
    assert.equal(cached.users['101'].username, 'user101v1');
    // A cached current handle must also supersede an older handle in a later archive.
    await writeFile(path.join(directory, 'following.js'), partText('following', 0, ['101', '102', '103'].map(id => archiveRow('following', id, id === '101' ? { screenName: 'old101' } : {}))));
    await page.reload(); await page.locator('#results').waitFor({ state: 'visible' });
    assert.match(await page.locator('#rows').textContent(), /@user102v1/);
    assert.match(await page.locator('#rows').textContent(), /@user101v1/);
    await page.locator('#lookup').click();
    await until(async () => !(await page.locator('#lookup').isDisabled()), 'negative cache reuse');
    assert.equal(calls.length, 3);
    await app.close();
    app = await createApp({ archiveDirectory: directory, profileLookup: lookup });
    await page.goto(app.origin); await page.locator('#results').waitFor({ state: 'visible' });
    assert.match(await page.locator('#rows').textContent(), /@user101v1/);
    assert.equal(calls.length, 3);
    revision = 2;
    await page.locator('#update-profiles').click();
    await until(async () => !(await page.locator('#lookup').isDisabled()), 'manual update');
    assert.match(await page.locator('#rows').textContent(), /@user101v2/);
    assert.equal(calls.length, 6);
    await page.locator('#search').fill('user102v2');
    assert.equal(await page.locator('#rows tr').count(), 1);
    const pending = page.waitForEvent('download'); await page.locator('#export').click();
    const download = await pending;
    assert.match(await readFile(await download.path(), 'utf8'), /user101v2/);
    unavailable = true;
    await page.locator('#update-profiles').click();
    await until(async () => !(await page.locator('#lookup').isDisabled()), 'failed update');
    assert.match(await page.locator('#profile-status').textContent(), /暂不可用/);
    assert.equal(await page.locator('#results').isVisible(), true);
    assert.match(await page.locator('#rows').textContent(), /@user102v2/);
    await page.locator('#update-profiles').click();
    await until(async () => !(await page.locator('#lookup').isDisabled()), 'failure cooldown');
    assert.equal(calls.length, 7);
    const bad = await fetch(app.origin + '/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ['../bad'] }) });
    assert.equal(bad.status, 400);
    const foreign = await fetch(app.origin + '/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' }, body: JSON.stringify({ ids: ['101'] }) });
    assert.equal(foreign.status, 403);
    const hidden = await fetch(app.origin + '/archives/.profile-cache/user-profiles.json');
    assert.equal(hidden.status, 404);
    assert.deepEqual(errors, []);
  } finally { if (browser) await browser.close(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});


test('profile details migrate old cache, render local avatars and counts, and refresh only after seven days', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'x-details-ui-'));
  const week = 7 * 24 * 60 * 60 * 1000;
  let clock = Date.now(); let calls = 0; let failLookup = false; let partialLookup = false;
  const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=';
  const lookup = async id => {
    calls++;
    if (failLookup) throw new Error('模拟断网');
    if (partialLookup) return { username: `profile${id}`, name: `Name ${id}`, avatar: null, description: null, followersCount: null, followingCount: null };
    return { username: `profile${id}`, name: `Name ${id}`, description: id === '201' ? '研究者 <img src=x onerror=alert(1)>' : '', followersCount: id === '201' ? 12345 : -1, followingCount: id === '201' ? 0 : undefined, avatar: id === '201' ? avatar : 'https://example.com/not-allowed.png' };
  };
  const options = { archiveDirectory: directory, profileLookup: lookup, profileNow: () => clock };
  await writeFile(path.join(directory, 'following.js'), partText('following', 0, ['201', '202'].map(id => archiveRow('following', id))));
  await writeFile(path.join(directory, 'follower.js'), partText('follower', 0, []));
  await mkdir(path.join(directory, '.profile-cache'));
  const cacheFile = path.join(directory, '.profile-cache/user-profiles.json');
  await writeFile(cacheFile, JSON.stringify({ version: 1, users: { '201': { username: 'old201', name: 'Old Name', checkedAt: clock } }, retryAt: 0 }));
  let app = await createApp(options); let browser;
  const compare = async () => (await postArchive(app.origin, '.')).json();
  try {
    browser = await chromium.launch({ channel: 'chromium', headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1050 }, acceptDownloads: true });
    const network = []; const errors = [];
    page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(app.origin); await page.locator('#results').waitFor({ state: 'visible' });
    assert.equal(calls, 0);
    assert.match(await page.locator('#rows').textContent(), /old201/);
    assert.equal((await compare()).results.find(row => row.id === '201').profileNeedsUpdate, true);
    assert.equal(await page.locator('#lookup').isVisible(), true);
    assert.equal(await page.evaluate(() => document.querySelector('#lookup').getBoundingClientRect().top < document.querySelector('#results').getBoundingClientRect().top), true);
    await page.locator('#lookup').click();
    await until(async () => !(await page.locator('#lookup').isDisabled()), 'profile details queried');
    assert.equal(calls, 2);
    const row = page.locator('#rows tr').filter({ hasText: '@profile201' });
    assert.equal(await row.locator('img').count(), 1);
    await until(async () => row.locator('img').evaluate(image => image.complete && image.naturalWidth > 0), 'cached avatar loaded');
    assert.match(await row.locator('td').nth(2).textContent(), /研究者 <img/);
    assert.equal(await row.locator('td').nth(3).textContent(), '12,345');
    assert.equal(await row.locator('td').nth(4).textContent(), '0');
    const unknown = page.locator('#rows tr').filter({ hasText: '@profile202' });
    assert.equal(await unknown.locator('td').nth(3).textContent(), '—');
    assert.equal(await unknown.locator('td').nth(4).textContent(), '—');
    assert.equal(await unknown.locator('img').count(), 0);
    assert.equal(await page.locator('#rows img').count(), 1);
    const cache = JSON.parse(await readFile(cacheFile, 'utf8'));
    assert.equal(cache.users['201'].avatar, avatar);
    assert.equal(cache.users['201'].followingCount, 0);
    assert.equal(cache.users['202'].followersCount, null);
    await page.locator('#search').fill('研究者'); assert.equal(await page.locator('#rows tr').count(), 1);
    const pending = page.waitForEvent('download'); await page.locator('#export').click();
    const download = await pending; const csv = await readFile(await download.path(), 'utf8');
    assert.match(csv, /简介.*粉丝数.*关注数/); assert.match(csv, /"12345","0"/);
    await page.locator('#search').fill('');
    await page.screenshot({ path: path.join(scratch, 'profile-details-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(scratch, 'profile-details-mobile.png'), fullPage: true });
    await app.close(); app = await createApp(options);
    clock += week - 1;
    await page.goto(app.origin); await page.locator('#results').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#rows img').getAttribute('src'), avatar);
    await page.locator('#lookup').click(); assert.equal(calls, 2);
    const post = ids => fetch(app.origin + '/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
    assert.equal((await (await post(['201', '202'])).json()).queried, 0);
    assert.equal(calls, 2);
    clock += 1;
    const expired = (await compare()).results.find(row => row.id === '201');
    assert.equal(expired.profileNeedsUpdate, true); assert.equal(expired.profileExpired, true); assert.equal(expired.followersCount, 12345);
    await page.reload(); await page.locator('#results').waitFor({ state: 'visible' });
    failLookup = true;
    await page.locator('#lookup').click(); await until(async () => !(await page.locator('#lookup').isDisabled()), 'expired query fails');
    assert.equal(calls, 3);
    assert.match(await page.locator('#rows').textContent(), /12,345/);
    assert.equal(JSON.parse(await readFile(cacheFile, 'utf8')).users['201'].checkedAt, cache.users['201'].checkedAt);
    clock += 300001; failLookup = false;
    await page.locator('#lookup').click(); await until(async () => !(await page.locator('#lookup').isDisabled()), 'expired profiles refreshed');
    assert.equal(calls, 5);
    assert.equal((await compare()).results.every(row => !row.profileNeedsUpdate), true);
    partialLookup = true;
    const partial = await (await fetch(app.origin + '/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ['201'], force: true }) })).json();
    assert.equal(partial.profiles['201'].avatar, avatar);
    assert.equal(partial.profiles['201'].followersCount, 12345);
    assert.equal(partial.profiles['201'].followingCount, 0);
    assert.match(partial.profiles['201'].description, /研究者/);
    assert.equal(network.every(url => new URL(url).hostname === '127.0.0.1'), true);
    assert.deepEqual(errors, []);
  } finally { if (browser) await browser.close(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});


test('profile cache capacity sheds old avatar bytes without blocking new profile persistence', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'x-profile-capacity-'));
  const cacheDirectory = path.join(directory, '.profile-cache'); await mkdir(cacheDirectory);
  const avatar = 'data:image/png;base64,' + Buffer.alloc(128 * 1024, 65).toString('base64');
  const clock = Date.now(); const users = {};
  for (let id = 1; id <= 119; id++) users[String(id)] = { username: `cached${id}`, checkedAt: clock - id, profileVersion: 2, avatar, followersCount: id, followingCount: 0 };
  const filename = path.join(cacheDirectory, 'user-profiles.json');
  await writeFile(filename, JSON.stringify({ version: 1, users, retryAt: 0 }));
  const app = await createApp({ archiveDirectory: directory, profileNow: () => clock, profileLookup: async id => ({ username: `new${id}`, avatar, followersCount: 100, followingCount: 0 }) });
  try {
    const response = await fetch(app.origin + '/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ['201', '202', '203'] }) });
    assert.equal(response.status, 200);
    const result = await response.json(); assert.equal(result.queried, 3); assert.equal(result.message, '');
    const text = await readFile(filename, 'utf8'); const stored = JSON.parse(text);
    assert.equal(Buffer.byteLength(text) <= 20 * 1024 * 1024, true);
    assert.equal(Object.keys(stored.users).length, 122);
    assert.equal(stored.users['203'].username, 'new203');
    assert.equal(stored.users['119'].followersCount, 119);
    assert.equal(stored.users['119'].avatar, null);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('private mihomo isolates cached nodes, proxies profile/avatar, bounds 429 rotation and cleans up on exit', { timeout: 90_000 }, async () => {
  // Real core and curl with a local TLS fixture: no X, subscriptions or user nodes.
  const { access, readdir } = await import('node:fs/promises');
  try { await access('/opt/homebrew/bin/mihomo'); } catch { return; }
  const tls = await import('node:tls');
  const net = await import('node:net');
  const { startPrivateProxy } = await import('../src/proxy.mjs');
  const directory = await mkdtemp(path.join(tmpdir(), 'x-proxy-acceptance-'));
  const source = path.join(directory, 'source.json');
  const proxyServers = []; const connections = new Set();
  const requests = []; let alwaysLimit = false; let profiles = 0; let proxy;
  const originalCA = process.env.CURL_CA_BUNDLE;
  try {
    const key = path.join(directory, 'fixture.key'); const cert = path.join(directory, 'fixture.crt');
    await runFixture('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=syndication.twitter.com', '-addext', 'subjectAltName=DNS:syndication.twitter.com,DNS:pbs.twimg.com', '-keyout', key, '-out', cert, '-days', '1']);
    const secureContext = tls.createSecureContext({ key: await readFile(key), cert: await readFile(cert) });
    process.env.CURL_CA_BUNDLE = cert;
    const nodes = [];
    for (let index = 0; index < 3; index++) {
      const origin = http.createServer((req, res) => {
        requests.push({ index, url: req.url, host: req.headers.host, at: Date.now() });
        if (req.headers.host === 'pbs.twimg.com') { res.end(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])); return; }
        if (++profiles === 1 || alwaysLimit) { res.writeHead(429); res.end('fixture limit'); return; }
        const id = req.url.split('/').at(-1);
        const body = { props: { pageProps: { userId: id, headerProps: { screenName: 'fixture_user' }, timeline: { entries: [{ content: { tweet: { user: { id_str: id, screen_name: 'fixture_user', name: 'Fixture', description: 'local only', followers_count: 12, friends_count: 3, profile_image_url_https: 'https://pbs.twimg.com/profile_images/fixture.png' } } } }] } } } };
        res.end(`<script id="__NEXT_DATA__">${JSON.stringify(body)}</script>`);
      });
      const tunnel = http.createServer();
      tunnel.on('connect', (req, socket) => {
        assert.ok(['syndication.twitter.com:443', 'pbs.twimg.com:443'].includes(req.url));
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        const encrypted = new tls.TLSSocket(socket, { isServer: true, secureContext });
        encrypted.on('error', () => {}); origin.emit('connection', encrypted);
      });
      tunnel.on('connection', socket => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
      await new Promise(resolve => tunnel.listen(0, '127.0.0.1', resolve)); proxyServers.push(tunnel);
      nodes.push({ name: `fixture-${index}`, type: 'http', server: '127.0.0.1', port: tunnel.address().port });
    }
    await writeFile(path.join(directory, 'cached.json'), JSON.stringify({ proxies: nodes.slice(1) }));
    const sourceText = JSON.stringify({ 'mixed-port': proxyServers[0].address().port, 'allow-lan': true, tun: { enable: true }, proxies: nodes.slice(0, 1), 'proxy-providers': { cached: { type: 'file', path: 'cached.json' } } });
    await writeFile(source, sourceText);
    const before = new Set((await readdir(tmpdir())).filter(name => name.startsWith('x-follow-mihomo-')));
    proxy = await startPrivateProxy({ source });
    assert.equal(proxy.status().nodeCount, 3);
    assert.equal(proxy.status().state, 'ready');
    assert.ok(!nodes.some(node => node.port === proxy.status().port));
    const created = (await readdir(tmpdir())).filter(name => name.startsWith('x-follow-mihomo-') && !before.has(name));
    assert.equal(created.length, 1);
    const runtimeDirectory = path.join(tmpdir(), created[0]);
    const runtimeConfig = JSON.parse(await readFile(path.join(runtimeDirectory, 'config.yaml'), 'utf8'));
    assert.equal(runtimeConfig['allow-lan'], false); assert.equal(runtimeConfig.tun.enable, false);
    assert.equal(runtimeConfig['bind-address'], '127.0.0.1');
    assert.ok(runtimeConfig['external-controller'].startsWith('127.0.0.1:'));
    const found = await proxy.lookup('123');
    assert.equal(found.username, 'fixture_user'); assert.equal(found.followersCount, 12);
    assert.ok(found.avatar.startsWith('data:image/png;base64,'));
    const firstProfiles = requests.filter(r => r.host === 'syndication.twitter.com');
    assert.equal(firstProfiles.length, 2); assert.notEqual(firstProfiles[0].index, firstProfiles[1].index);
    assert.ok(firstProfiles[1].at - firstProfiles[0].at >= 14_500);
    assert.equal(requests.find(r => r.host === 'pbs.twimg.com').index, firstProfiles[1].index);
    alwaysLimit = true;
    await assert.rejects(proxy.lookup('456'), /次数已达上限/);
    assert.equal(profiles, 4); // two switches total; never a fourth-node loop
    assert.equal(await readFile(source, 'utf8'), sourceText);
    const port = proxy.status().port;
    await proxy.close();
    assert.equal(proxy.status().state, 'stopped');
    await assert.rejects(proxy.lookup('789'), /不会直连/);
    await assert.rejects(access(runtimeDirectory));
    await assert.rejects(new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1'); socket.on('error', reject); socket.on('connect', () => { socket.destroy(); resolve(); });
    }));
    await assert.rejects(startPrivateProxy({ source: path.join(directory, 'missing.yaml') }), /无法启动/);
    const { spawn } = await import('node:child_process');
    const url = new URL('../src/proxy.mjs', import.meta.url).href;
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import { startPrivateProxy } from ${JSON.stringify(url)}; await startPrivateProxy({source:${JSON.stringify(source)}}); process.exit(0);`], { stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(await new Promise(resolve => child.once('exit', resolve)), 0);
    await until(async () => !(await readdir(tmpdir())).some(name => name.startsWith('x-follow-mihomo-') && !before.has(name)), 'parent exit supervisor cleanup');
  } finally {
    if (originalCA === undefined) delete process.env.CURL_CA_BUNDLE; else process.env.CURL_CA_BUNDLE = originalCA;
    await proxy?.close();
    for (const socket of connections) socket.destroy();
    await Promise.all(proxyServers.map(server => new Promise(resolve => server.close(resolve))));
    await rm(directory, { recursive: true, force: true });
  }
});
