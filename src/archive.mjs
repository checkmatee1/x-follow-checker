const MAX_BYTES = 100 * 1024 * 1024;
const MAX_ROWS = 1_000_000;
const validId = value => typeof value === 'string' && /^[1-9]\d{0,24}$/.test(value);
const validName = value => typeof value === 'string' && /^[a-zA-Z0-9_]{1,15}$/.test(value);

// Treat archive .js files as text containing JSON. Never evaluate their JavaScript.
function parsePart(text, kind) {
  let source = text.replace(/^\uFEFF/, '').trim();
  let part = null;
  const assignment = /^window\.YTD\.(following|follower)\.part(\d+)\s*=\s*([\s\S]*)$/.exec(source);
  if (assignment) {
    if (assignment[1] !== kind) throw new Error('关注和粉丝文件选反了，请按文件名重新选择。');
    part = Number(assignment[2]);
    if (!Number.isSafeInteger(part)) throw new Error('存档分片编号无效。');
    source = assignment[3].replace(/;\s*$/, '').trim();
  }
  let rows;
  try { rows = JSON.parse(source); } catch { throw new Error('文件不是有效的 X 名单存档，请选择 follower.js / following.js，文件不会作为脚本执行。'); }
  if (!Array.isArray(rows)) throw new Error('存档内的关注和粉丝名单内容必须是数组，请使用原始名单文件。');
  if (rows.length > MAX_ROWS) throw new Error('单份名单超过 1,000,000 条，请减少文件规模。');
  const users = rows.map(row => {
    const account = row?.[kind];
    if (!validId(account?.accountId)) throw new Error('名单含有缺失或无效的账号 ID，未生成结果。请使用原始存档文件。');
    const id = account.accountId;
    const username = validName(account.screenName) ? account.screenName : null;
    return { id, username, name: typeof account.name === 'string' ? account.name.slice(0, 300) : (username ?? `账号 ID ${id}`), url: `https://x.com/i/user/${id}` };
  });
  return { part, users };
}

async function readList(files, kind) {
  if (!files.length) throw new Error('存档缺少关注或粉丝名单，空名单也需要对应文件。请放入完整存档。');
  const parts = new Map();
  const users = new Map();
  let rawRows = 0;
  for (const file of files) {
    const { part, users: rows } = parsePart(await file.text(), kind);
    if (part === null && files.length !== 1) throw new Error('多个文件必须含有 X 存档的分片编号，请选择原始 .js 分片文件。');
    const index = part ?? 0;
    if (parts.has(index)) throw new Error('重复选择了同一名单分片，请每个分片只选一次。');
    parts.set(index, true);
    rawRows += rows.length;
    if (rawRows > MAX_ROWS) throw new Error('单份名单超过 1,000,000 条，请减少文件规模。');
    for (const row of rows) {
      const previous = users.get(row.id);
      // Preserve available handles when duplicate IDs appear across pages.
      if (!previous || (!previous.username && row.username)) users.set(row.id, row);
    }
  }
  const indexes = [...parts.keys()].sort((a, b) => a - b);
  if (indexes.some((index, position) => index !== position)) throw new Error('名单分片不连续或缺少 part0，请放入同一存档的全部名单分片。');
  return [...users.values()];
}

export async function compareArchive(followingFiles, followerFiles) {
  const following = Array.from(followingFiles);
  const followers = Array.from(followerFiles);
  if ([...following, ...followers].reduce((total, file) => total + file.size, 0) > MAX_BYTES) throw new Error('两份名单文件合计不能超过 100 MB。');
  const followingUsers = await readList(following, 'following');
  const followerUsers = await readList(followers, 'follower');
  const ids = new Set(followerUsers.map(user => user.id));
  const results = followingUsers.filter(user => !ids.has(user.id)).sort((a, b) => (a.username ?? a.id).toLowerCase().localeCompare((b.username ?? b.id).toLowerCase(), 'en'));
  return { results, following: followingUsers.length, followers: followerUsers.length };
}
