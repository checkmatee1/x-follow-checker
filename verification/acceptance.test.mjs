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
    const health = await fetch(app.origin + '/health'); assert.equal(health.status, 200); assert.deepEqual(await health.json(), { service: 'x-follow-checker-folder', protocol: 1 });
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
