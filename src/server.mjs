// Optional installation guide. Scanning runs entirely inside the extension.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
const extensionDirectory = fileURLToPath(new URL('../extension', import.meta.url));
const escapeHtml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export async function createApp({ port = 0 } = {}) {
  let origin;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'none'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin) || ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) { res.writeHead(403); return res.end('Forbidden'); }
    const pathname = new URL(req.url, origin).pathname;
    if (pathname.startsWith('/api/')) { res.writeHead(410, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: '已改为 Chrome 扩展，请按首页指引安装。旧的重新登录扫描流程已停用。' })); }
    if (req.method !== 'GET' || !['/', '/style.css'].includes(pathname)) { res.writeHead(404); return res.end('Not found'); }
    try {
      const file = pathname === '/' ? 'index.html' : 'style.css';
      let content = await readFile(new URL(`../public/${file}`, import.meta.url), 'utf8');
      if (pathname === '/') content = content.replace('__EXTENSION_DIRECTORY__', escapeHtml(extensionDirectory));
      res.writeHead(200, { 'Content-Type': pathname === '/' ? 'text/html; charset=utf-8' : 'text/css; charset=utf-8' });
      res.end(content);
    } catch { res.writeHead(500); res.end('Unable to read installation guide.'); }
  });
  server.requestTimeout = 15_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, close: () => new Promise(resolve => server.close(resolve)) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await createApp();
  console.log(`\nChrome 扩展安装指引：${app.origin}\n扩展文件夹：${extensionDirectory}\n安装后无需此服务。退出请按 Control+C。\n`);
  if (!process.argv.includes('--no-open')) {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    execFile(command, [app.origin], () => {});
    if (process.platform === 'darwin') execFile('open', [extensionDirectory], () => {});
  }
  const stop = async () => { await app.close(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
