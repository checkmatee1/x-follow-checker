import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const validId = id => typeof id === 'string' && /^[1-9]\d{0,24}$/.test(id);
const validHandle = name => typeof name === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(name);
const WEEK = 7 * 24 * 60 * 60 * 1000;
const MAX_CACHE_BYTES = 20 * 1024 * 1024;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const avatarData = value => typeof value === 'string' && value.length <= 175_000 && /^data:image\/(?:jpeg|png|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : null;

async function curlRequest(url, { avatar = false } = {}) {
  const { stdout } = await run('curl', ['-q', '--silent', '--show-error', '--max-time', avatar ? '6' : '12', '--max-filesize', avatar ? '131072' : '5242880', '--proto', '=https', '--write-out', '\n%{http_code}', url], { encoding: null, timeout: avatar ? 8000 : 15_000, maxBuffer: avatar ? 132_096 : 6 * 1024 * 1024 });
  const split = stdout.lastIndexOf(10);
  return { status: Number(stdout.subarray(split + 1).toString()), body: stdout.subarray(0, split) };
}

async function publicAvatar(value, request) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== 'pbs.twimg.com' || url.port || url.username || url.password || !url.pathname.startsWith('/profile_images/')) return null;
  try {
    // Cache raster bytes locally; page rendering never contacts the image host.
    const { status, body: stdout } = await request(url.href, { avatar: true });
    if (status !== 200) return null;
    let type;
    if (stdout.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) type = 'jpeg';
    else if (stdout.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) type = 'png';
    else if (['GIF87a', 'GIF89a'].includes(stdout.subarray(0, 6).toString('ascii'))) type = 'gif';
    else if (stdout.subarray(0, 4).toString('ascii') === 'RIFF' && stdout.subarray(8, 12).toString('ascii') === 'WEBP') type = 'webp';
    return type ? avatarData(`data:image/${type};base64,${stdout.toString('base64')}`) : null;
  } catch { return null; } // A missing avatar must not discard a usable profile.
}

// Only read embedded JSON. Never execute HTML/scripts or use browser cookies.
export async function publicProfile(id, { request = curlRequest } = {}) {
  const url = `https://syndication.twitter.com/srv/timeline-profile/user-id/${id}`;
  let response;
  try { response = await request(url); }
  catch (cause) {
    const error = new Error(cause.code === 'PROXY_CONNECTION' ? '当前代理节点连接失败或 TLS 握手失败，请稍后重试。' : '公开查询连接失败或超时；已查到的用户名仍保留。请稍后重试。');
    if (cause.code === 'PROXY_CONNECTION') error.code = cause.code;
    throw error;
  }
  if (response.status !== 200) {
    const error = new Error(response.status === 429 ? 'X 公开查询已限流，请稍后重试。' : 'X 公开查询暂不可用，请稍后重试。');
    if (response.status === 429) error.code = 'RATE_LIMIT';
    throw error;
  }
  const match = /<script\b[^>]*\bid="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(response.body.toString('utf8'));
  if (!match) throw new Error('公开查询页面格式已变化，未保存错误数据。');
  let page;
  try { page = JSON.parse(match[1]).props?.pageProps; } catch { throw new Error('公开查询返回了无效数据。'); }
  // Match the requested ID; retweets/replies can contain other users.
  if (String(page?.userId) !== id) throw new Error('公开查询未返回匹配的账号，未保存错误数据。');
  const username = page.headerProps?.screenName;
  if (!validHandle(username)) return null;
  const entries = page.timeline?.entries ?? [];
  const user = entries.map(entry => entry.content?.tweet?.user).find(user => user?.id_str === id && user.screen_name === username);
  return {
    username, name: typeof user?.name === 'string' ? user.name.slice(0, 300) : username,
    description: typeof user?.description === 'string' ? user.description.slice(0, 1600) : null,
    followersCount: count(user?.followers_count), followingCount: count(user?.friends_count),
    avatar: await publicAvatar(user?.profile_image_url_https, request)
  };
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
      if (!stat.isFile() || stat.size > MAX_CACHE_BYTES) throw new Error();
      const data = JSON.parse(await handle.readFile('utf8'));
      if (data.version !== 1 || !data.users || typeof data.users !== 'object' || Array.isArray(data.users)) throw new Error();
      return data;
    } catch { throw new Error('用户名缓存损坏，原文件已保留；请移走缓存文件后重试。'); }
    finally { await handle.close(); }
  }
  async function save(data) {
    let serialized = JSON.stringify(data);
    if (Buffer.byteLength(serialized) > MAX_CACHE_BYTES) {
      // Shed oldest image bytes before rejecting useful text/count updates.
      const avatars = Object.values(data.users).filter(entry => entry.avatar).sort((a, b) => (a.checkedAt ?? 0) - (b.checkedAt ?? 0));
      let excess = Buffer.byteLength(serialized) - MAX_CACHE_BYTES;
      for (const entry of avatars) {
        excess -= Buffer.byteLength(entry.avatar) - 4;
        entry.avatar = null;
        if (excess <= 0) break;
      }
      serialized = JSON.stringify(data);
    }
    if (Buffer.byteLength(serialized) > MAX_CACHE_BYTES) throw new Error('文字资料缓存超过 20 MB，原缓存已保留。');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('用户名缓存目录必须是普通文件夹。');
    const temporary = path.join(directory, `.profiles-${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(serialized); } finally { await handle.close(); }
      await rename(temporary, filename);
    } finally { await unlink(temporary).catch(() => {}); }
  }
  function fresh(entry) {
    return validHandle(entry?.username) && entry.profileVersion === 2 && Number.isFinite(entry.checkedAt) && entry.checkedAt <= now() && now() - entry.checkedAt < WEEK;
  }
  function profile(entry) {
    if (!validHandle(entry?.username)) return null;
    return {
      username: entry.username, name: typeof entry.name === 'string' ? entry.name.slice(0, 300) : entry.username,
      description: typeof entry.description === 'string' ? entry.description.slice(0, 1600) : null,
      followersCount: count(entry.followersCount), followingCount: count(entry.followingCount),
      avatar: avatarData(entry.avatar), checkedAt: entry.checkedAt,
      profileNeedsUpdate: !fresh(entry) && !(entry.retryAt > now()), profileExpired: !fresh(entry)
    };
  }
  return {
    async enrich(rows) {
      // Wait for an in-progress write so refresh sees all completed lookups.
      await queue;
      const data = await read();
      return rows.map(row => {
        const cached = profile(data.users[row.id]);
        return cached ? { ...row, ...cached } : { ...row, profileNeedsUpdate: !(data.users[row.id]?.retryAt > now()) };
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
          if (!force && fresh(entry)) { profiles[id] = cached; continue; }
          if (!force && entry?.retryAt > now()) { if (cached) profiles[id] = cached; missing++; continue; }
          if (data.retryAt > now()) { message = typeof data.lastError === 'string' ? data.lastError + ' 当前仍在五分钟暂停期，本地缓存可继续使用。' : '公开查询暂不可用，请五分钟后重试；本地缓存仍可使用。'; break; }
          try {
            queried++;
            const found = await lookup(id);
            if (found && !validHandle(found.username)) throw new Error('查询返回的用户名无效。');
            if (found) {
              data.users[id] = {
                username: found.username, name: typeof found.name === 'string' ? found.name.slice(0, 300) : found.username,
                description: typeof found.description === 'string' ? found.description.slice(0, 1600) : (entry?.description ?? null),
                followersCount: count(found.followersCount) ?? count(entry?.followersCount), followingCount: count(found.followingCount) ?? count(entry?.followingCount),
                avatar: avatarData(found.avatar) ?? avatarData(entry?.avatar), profileVersion: 2, checkedAt: now()
              };
              profiles[id] = profile(data.users[id]);
            } else {
              // Preserve an existing successful result when a forced update finds nothing.
              data.users[id] = { ...entry, retryAt: now() + WEEK };
              if (cached) profiles[id] = profile(data.users[id]);
              missing++;
            }
          } catch (error) {
            data.retryAt = now() + 5 * 60 * 1000;
            message = error.message;
            data.lastError = message;
          }
          await save(data); // Persist each result, including before a later request fails.
          if (profiles[id]) profiles[id] = profile(data.users[id]);
          if (message) break;
        }
        return { profiles, queried, missing, message };
      });
      queue = work.catch(() => {});
      return work;
    }
  };
}
