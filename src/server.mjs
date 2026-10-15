// Local-only archive folder reader. No X network requests.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { archiveCatalog, compareFolderArchive } from './archive-folder.mjs';
const defaultArchiveDirectory = fileURLToPath(new URL('../archives', import.meta.url));
const extensionDirectory = fileURLToPath(new URL('../extension', import.meta.url));
const escapeHtml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export async function createApp({ port = 0, archiveDirectory = defaultArchiveDirectory } = {}) {
  let origin;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin) || ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) { res.writeHead(403); return res.end('Forbidden'); }
    const reply = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    try {
      const pathname = new URL(req.url, origin).pathname;
      if (pathname === '/api/archives' && req.method === 'GET') {
        const groups = await archiveCatalog(archiveDirectory);
        return reply(200, { directory: archiveDirectory, archives: groups.map(({ id, label, type, signature }) => ({ id, label, type, signature })) });
      }
      if (pathname === '/api/compare' && req.method === 'POST') {
        if (!req.headers['content-type']?.startsWith('application/json')) return reply(415, { error: '需要 JSON 请求。' });
        let body = ''; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 16_384) { reply(413, { error: '请求过大。' }); return; } body += chunk; }
        let input;
        try { input = JSON.parse(body); } catch { return reply(400, { error: '请求格式无效。' }); }
        if (typeof input.id !== 'string') return reply(400, { error: '请选择一份存档。' });
        return reply(200, await compareFolderArchive(archiveDirectory, input.id));
      }
      if (pathname.startsWith('/api/')) return reply(410, { error: '旧在线扫描 API 已停用，请使用本地存档比较。' });
      const assets = {
        '/': ['../public/folder.html', 'text/html'], '/install': ['../public/index.html', 'text/html'],
        '/style.css': ['../extension/style.css', 'text/css'], '/local.js': ['../public/local.js', 'text/javascript'],
        '/shared.js': ['../extension/shared.js', 'text/javascript']
      };
      if (req.method !== 'GET' || !assets[pathname]) { res.writeHead(404); return res.end('Not found'); }
      const [file, type] = assets[pathname];
      let content = await readFile(new URL(file, import.meta.url), 'utf8');
      content = content.replaceAll('__EXTENSION_DIRECTORY__', escapeHtml(extensionDirectory)).replaceAll('__ARCHIVE_DIRECTORY__', escapeHtml(archiveDirectory));
      res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' }); res.end(content);
    } catch (error) {
      reply(400, { error: error.code ? '无法读取存档文件夹，请确认文件已下载完成且位于 archives 中。' : error.message });
    }
  });
  server.requestTimeout = 15_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, close: () => new Promise(resolve => server.close(resolve)) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await createApp();
  console.log(`\n本地存档检查：${app.origin}\n存档投放目录：${defaultArchiveDirectory}\n放入 ZIP 或解压后的存档，然后打开页面。退出请按 Control+C。\n`);
  if (!process.argv.includes('--no-open')) {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    execFile(command, [app.origin], () => {});
    if (process.platform === 'darwin') execFile('open', [defaultArchiveDirectory], () => {});
  }
  const stop = async () => { await app.close(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
