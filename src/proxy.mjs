import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomBytes, randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { publicProfile } from './profiles.mjs';
const run = promisify(execFile);
async function unusedPort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

// Called by the launcher only. Importing this module or comparing archives is offline.
export async function startPrivateProxy({ source = '/opt/homebrew/etc/mihomo/config.yaml', binary = '/opt/homebrew/bin/mihomo', python = 'python3' } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'x-follow-mihomo-'));
  const port = await unusedPort(); let controllerPort = await unusedPort();
  while (controllerPort === port) controllerPort = await unusedPort();
  const secret = randomBytes(32).toString('hex');
  const controller = `http://127.0.0.1:${controllerPort}`;
  const child = spawn(python, [fileURLToPath(new URL('../scripts/mihomo-runtime.py', import.meta.url))], { stdio: ['pipe', 'pipe', 'ignore'] });
  let exited = false; let stopping = false; let providerCount = null; let startupOutput = '';
  child.stdout.on('data', chunk => {
    startupOutput += chunk.toString();
    if (startupOutput.includes('\n')) {
      try {
        const startup = JSON.parse(startupOutput.trim());
        if (startup.started && Number.isSafeInteger(startup.providerCount)) providerCount = startup.providerCount;
      } catch { /* Only the supervisor's count is accepted, never core logs. */ }
    }
  });
  child.once('error', () => { exited = true; }); child.once('exit', () => { exited = true; });
  child.stdin.on('error', () => {});
  child.stdin.write(JSON.stringify({ directory, source, binary, port, controllerPort, secret }) + '\n');
  const abort = new AbortController();
  async function api(route, options = {}) {
    const response = await fetch(controller + route, { ...options, headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(1500)]) });
    if (!response.ok) throw new Error('临时代理控制器不可用。');
    return response.status === 204 ? null : response.json();
  }
  async function close() {
    if (stopping) return;
    stopping = true; abort.abort(); child.stdin.end();
    const deadline = Date.now() + 5000;
    while (!exited && Date.now() < deadline) await delay(50);
    if (!exited) { child.kill('SIGTERM'); await delay(500); }
    // Supervisor removes its snapshot after terminating the core; do not kill it
    // with SIGKILL and strand its child. On parent death stdin EOF does the same.
    if (exited) await rm(directory, { recursive: true, force: true });
  }
  try {
    let group; let providerNodes = []; const deadline = Date.now() + 15_000;
    while (!exited && Date.now() < deadline) {
      try {
        if (providerCount !== null) {
          const loaded = await api('/providers/proxies');
          const files = Object.entries(loaded.providers ?? {}).filter(([name]) => /^provider-\d+$/.test(name)).map(([, provider]) => provider);
          const candidate = await api('/proxies/XFC');
          if (files.length === providerCount && files.every(provider => provider.proxies?.length > 0 && provider.proxies.every(node => candidate.all?.includes(node.name))) && candidate.all?.length) { group = candidate; providerNodes = files.flatMap(provider => provider.proxies); break; }
        }
      } catch { /* Retry readiness, never display core diagnostics. */ }
      await delay(150);
    }
    if (!group?.all?.length || exited) throw new Error('无法启动临时 mihomo，请检查 Homebrew 核心、Python PyYAML 和本地节点缓存。资料查询已停用，不会直连。');
    const all = await api('/proxies');
    // The core's /proxies index excludes provider leaf nodes; merge both APIs.
    const nodeDetails = new Map([...Object.entries(all.proxies ?? {}), ...providerNodes.map(node => [node.name, node])]);
    const nodes = [...new Set(group.all)].filter(name => nodeDetails.has(name) && !['direct', 'reject', 'rejectdrop', 'pass', 'selector', 'urltest', 'fallback', 'loadbalance'].includes(String(nodeDetails.get(name).type).replace(/[-_]/g, '').toLowerCase()));
    if (!nodes.length) throw new Error('本地缓存没有可用代理节点，资料查询已停用，不会直连。');
    let index = randomInt(nodes.length); let lastQuery = 0; let switches = [];
    const unavailableUntil = new Map();
    async function selectNode(next) {
      await api('/proxies/XFC', { method: 'PUT', body: JSON.stringify({ name: nodes[next] }) });
      const selected = await api('/proxies/XFC');
      if (selected.now !== nodes[next]) throw new Error('临时代理节点切换失败，已停止查询。');
      index = next;
    }
    await selectNode(index);
    const request = async (url, { avatar = false } = {}) => {
      if (exited || stopping) throw new Error('临时代理已退出，资料查询已停止，不会直连。');
      const args = ['-q', '--silent', '--show-error', '--proxy', `http://127.0.0.1:${port}`, '--noproxy', '', '--max-time', avatar ? '6' : '12', '--max-filesize', avatar ? '131072' : '5242880', '--proto', '=https', '--write-out', '\n%{http_code}', url];
      const { stdout } = await run('curl', args, { encoding: null, timeout: avatar ? 8000 : 15_000, maxBuffer: avatar ? 132_096 : 6 * 1024 * 1024, signal: abort.signal });
      const split = stdout.lastIndexOf(10);
      return { status: Number(stdout.subarray(split + 1).toString()), body: stdout.subarray(0, split) };
    };
    return {
      status: () => ({ state: exited || stopping ? 'stopped' : 'ready', port, nodeCount: nodes.length }),
      close,
      async lookup(id) {
        for (;;) {
          if (exited || stopping) throw new Error('临时代理已退出，资料查询已停止，不会直连。');
          await delay(Math.max(0, lastQuery + 2000 - Date.now()), undefined, { signal: abort.signal });
          lastQuery = Date.now();
          try { return await publicProfile(id, { request }); }
          catch (error) {
            // All other failures keep the existing cache cooldown. Never rotate
            // indefinitely or treat an unrelated connection failure as HTTP 429.
            if (error.code !== 'RATE_LIMIT') throw error;
            unavailableUntil.set(nodes[index], Date.now() + 30 * 60_000);
            switches = switches.filter(at => Date.now() - at < 30 * 60_000);
            const next = nodes.findIndex((name, i) => i !== index && !(unavailableUntil.get(name) > Date.now()));
            if (next < 0 || switches.length >= 2) throw new Error('X 公开查询仍被限流，自动换节点次数已达上限或没有候选节点；请稍后重试。');
            await delay(15_000, undefined, { signal: abort.signal });
            await selectNode(next); switches.push(Date.now());
          }
        }
      }
    };
  } catch (error) { await close(); throw error; }
}
