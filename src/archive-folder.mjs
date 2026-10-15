import { readdir, lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { compareArchive } from '../extension/archive.mjs';
const run = promisify(execFile);
const helper = fileURLToPath(new URL('../scripts/read-archive-zip.py', import.meta.url));
const LIMIT = 100 * 1024 * 1024;
const allowed = /^(following|follower)(?:-part\d+)?\.(js|json)$/i;

export async function archiveCatalog(directory) {
  const stat = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!stat) return [];
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('archives 必须是项目内的普通文件夹，不能使用符号链接。');
  const groups = [];
  // Only inspect the drop folder, an extracted wrapper folder and its data folder.
  // Never recurse into media, credentials or arbitrary directories inside an archive.
  async function inspect(folder, depth) {
    const selected = [];
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const location = path.join(folder, entry.name);
      if (entry.isFile() && allowed.test(entry.name)) {
        const stat = await lstat(location);
        if (stat.isFile() && !stat.isSymbolicLink()) selected.push({ path: location, name: entry.name, size: stat.size, modified: stat.mtimeMs });
      } else if (depth === 0 && entry.isFile() && /\.zip$/i.test(entry.name)) {
        const stat = await lstat(location);
        if (stat.isFile() && !stat.isSymbolicLink()) groups.push({ id: path.relative(directory, location), label: entry.name, type: 'zip', path: location, modified: stat.mtimeMs, signature: `${stat.size}:${stat.mtimeMs}` });
      } else if (entry.isDirectory() && (depth === 0 || (depth === 1 && entry.name === 'data'))) await inspect(location, depth + 1);
    }
    if (selected.length) groups.push({ id: path.relative(directory, folder) || '.', label: path.relative(directory, folder) || 'archives 根目录', type: 'files', files: selected, modified: Math.max(...selected.map(file => file.modified)), signature: selected.map(file => `${file.name}:${file.size}:${file.modified}`).sort().join('|') });
  }
  await inspect(directory, 0);
  return groups.sort((a, b) => b.modified - a.modified || a.id.localeCompare(b.id));
}

export async function compareFolderArchive(directory, id) {
  const catalog = await archiveCatalog(directory);
  const group = catalog.find(group => group.id === id);
  if (!group) throw new Error('所选存档已移走或不存在，请刷新文件夹。');
  const root = await realpath(directory);
  async function assertInside(location) {
    const resolved = await realpath(location);
    if (!resolved.startsWith(root + path.sep)) throw new Error('名单路径必须在 archives 文件夹内。');
    if ((await lstat(location)).isSymbolicLink()) throw new Error('不读取符号链接文件。');
  }
  let files;
  if (group.type === 'zip') {
    await assertInside(group.path);
    let stdout;
    try { ({ stdout } = await run('python3', [helper, group.path], { timeout: 30_000, maxBuffer: 220 * 1024 * 1024 })); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error('直接读取 ZIP 需要 Python 3。也可以先解压 ZIP，再放进 archives 文件夹。');
      let message;
      try { message = JSON.parse(error.stdout).error; } catch { /* Do not expose process output or paths. */ }
      throw new Error(message ?? 'ZIP 读取失败或超时，请确认下载完成，或先解压再放入文件夹。');
    }
    files = JSON.parse(stdout).files.map(file => { const text = file.text; return { name: file.name, size: file.size, text: async () => text }; });
  } else {
    if (group.files.reduce((sum, file) => sum + file.size, 0) > LIMIT) throw new Error('两份名单文件合计不能超过 100 MB。');
    files = [];
    let total = 0;
    for (const file of group.files) {
      await assertInside(file.path);
      const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes;
      try {
        const current = await handle.stat();
        if (!current.isFile() || current.size + total > LIMIT) throw new Error('两份名单文件合计不能超过 100 MB，或文件类型无效。');
        const buffer = Buffer.alloc(Math.min(current.size + 1, LIMIT - total + 1));
        let length = 0;
        while (length < buffer.length) { const read = await handle.read(buffer, length, buffer.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
        if (length !== current.size) throw new Error('名单文件正在变化，请等待下载或解压完成后刷新。');
        bytes = buffer.subarray(0, length); total += length;
      } finally { await handle.close(); }
      files.push({ name: file.name, size: bytes.length, text: async () => bytes.toString('utf8') });
    }
  }
  const following = files.filter(file => /^following(?:-part\d+)?\./i.test(file.name));
  const followers = files.filter(file => /^follower(?:-part\d+)?\./i.test(file.name));
  return { ...await compareArchive(following, followers), source: group.label };
}
