import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const validId = id => typeof id === 'string' && /^[1-9]\d{0,24}$/.test(id);
const validHandle = name => typeof name === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(name);
const DAY = 24 * 60 * 60 * 1000;

// Only read embedded JSON. Never execute HTML/scripts or use browser cookies.
export async function publicProfile(id) {
  const url = `https://syndication.twitter.com/srv/timeline-profile/user-id/${id}`;
  let stdout;
  try {
    ({ stdout } = await run('curl', ['-q', '--silent', '--show-error', '--max-time', '12', '--max-filesize', '5242880', '--proto', '=https', '--write-out', '\n%{http_code}', url], { timeout: 15_000, maxBuffer: 6 * 1024 * 1024 }));
  } catch { throw new Error('公开查询连接失败或超时；已查到的用户名仍保留。请稍后重试。'); }
  const split = stdout.lastIndexOf('\n');
  const status = Number(stdout.slice(split + 1));
  if (status !== 200) throw new Error(status === 429 ? 'X 公开查询已限流，请稍后重试。' : 'X 公开查询暂不可用，请稍后重试。');
  const match = /<script\b[^>]*\bid="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(stdout.slice(0, split));
  if (!match) throw new Error('公开查询页面格式已变化，未保存错误数据。');
  let page;
  try { page = JSON.parse(match[1]).props?.pageProps; } catch { throw new Error('公开查询返回了无效数据。'); }
  // Match the requested ID; retweets/replies can contain other users.
  if (String(page?.userId) !== id) throw new Error('公开查询未返回匹配的账号，未保存错误数据。');
  const username = page.headerProps?.screenName;
  if (!validHandle(username)) return null;
  const entries = page.timeline?.entries ?? [];
  const user = entries.map(entry => entry.content?.tweet?.user).find(user => user?.id_str === id && user.screen_name === username);
  return { username, name: typeof user?.name === 'string' ? user.name.slice(0, 300) : username };
}

export function createProfileCache(directory, { lookup = publicProfile, now = Date.now } = {}) {
  const filename = path.join(directory, 'user-profiles.json');
  let queue = Promise.resolve();
  async function read() {
    const stat = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat) return { version: 1, users: {}, retryAt: 0 };
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('用户名缓存目录必须是普通文件夹。');
    let handle;
    try { handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (error.code === 'ENOENT') return { version: 1, users: {}, retryAt: 0 }; throw new Error('无法读取用户名缓存。'); }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error();
      const data = JSON.parse(await handle.readFile('utf8'));
      if (data.version !== 1 || !data.users || typeof data.users !== 'object' || Array.isArray(data.users)) throw new Error();
      return data;
    } catch { throw new Error('用户名缓存损坏，原文件已保留；请移走缓存文件后重试。'); }
    finally { await handle.close(); }
  }
  async function save(data) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('用户名缓存目录必须是普通文件夹。');
    const temporary = path.join(directory, `.profiles-${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(data)); } finally { await handle.close(); }
      await rename(temporary, filename);
    } finally { await unlink(temporary).catch(() => {}); }
  }
  function profile(entry) {
    return validHandle(entry?.username) ? { username: entry.username, name: typeof entry.name === 'string' ? entry.name.slice(0, 300) : entry.username, checkedAt: entry.checkedAt } : null;
  }
  return {
    async enrich(rows) {
      // Wait for an in-progress write so refresh sees all completed lookups.
      await queue;
      const data = await read();
      return rows.map(row => {
        const cached = profile(data.users[row.id]);
        return cached ? { ...row, ...cached } : row;
      });
    },
    resolve(ids, { force = false } = {}) {
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > 3 || !ids.every(validId) || typeof force !== 'boolean') throw new Error('每次只能查询 1–3 个有效账号 ID。');
      const work = queue.then(async () => {
        const data = await read();
        const profiles = {}; let queried = 0; let missing = 0; let message = '';
        for (const id of new Set(ids)) {
          const entry = data.users[id];
          const cached = profile(entry);
          if (!force && cached) { profiles[id] = cached; continue; }
          if (!force && entry?.retryAt > now()) { missing++; continue; }
          if (data.retryAt > now()) { message = '公开查询暂不可用，请五分钟后重试；本地缓存仍可使用。'; break; }
          try {
            queried++;
            const found = await lookup(id);
            if (found && !validHandle(found.username)) throw new Error('查询返回的用户名无效。');
            if (found) {
              data.users[id] = { username: found.username, name: typeof found.name === 'string' ? found.name.slice(0, 300) : found.username, checkedAt: now() };
              profiles[id] = profile(data.users[id]);
            } else {
              // Preserve an existing successful result when a forced update finds nothing.
              data.users[id] = { ...entry, checkedAt: now(), retryAt: now() + DAY };
              if (cached) profiles[id] = cached;
              missing++;
            }
          } catch (error) {
            data.retryAt = now() + 5 * 60 * 1000;
            message = error.message;
          }
          await save(data); // Persist each result, including before a later request fails.
          if (message) break;
        }
        return { profiles, queried, missing, message };
      });
      queue = work.catch(() => {});
      return work;
    }
  };
}
