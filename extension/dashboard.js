import { ExistingTabScanner } from './scan.mjs';
import { compareArchive } from './archive.mjs';
const $ = id => document.getElementById(id);
const labels = { importing: '本地比较', connecting: '识别账号', profile: '确认账号', following: '读取关注', followers: '读取粉丝', checking: '核对名单', done: '检查完成', error: '扫描未完成', cancelled: '已取消' };
let tabId = Number(new URL(location.href).searchParams.get('tab'));
let scanner;
let mode = 'offline';
let busy = false;
let ready = false;
let limit = 100;
let state = { status: 'idle', results: [], following: 0, followers: 0 };

function showError(message) { $('error').textContent = message; $('error').hidden = false; }
function buttons() {
  $('start').disabled = busy || !ready;
  $('reconnect').disabled = busy;
  $('cancel').hidden = !busy || mode !== 'online';
  $('import-archive').disabled = busy || !$('following-files').files.length || !$('follower-files').files.length;
  for (const id of ['following-files', 'follower-files', 'offline-mode', 'online-mode']) $(id).disabled = busy;
}
function update(patch) {
  Object.assign(state, patch);
  $('progress').hidden = state.status === 'idle';
  $('welcome').hidden = mode === 'online' || state.status !== 'idle';
  $('results').hidden = state.status !== 'done';
  $('status-label').textContent = mode === 'offline' && state.status === 'error' ? '导入未完成' : labels[state.status] ?? '';
  $('status-label').className = 'status-label ' + (state.status === 'error' ? 'bad' : state.status === 'done' ? 'good' : '');
  $('target').textContent = state.username ? '@' + state.username : '';
  $('message').textContent = state.message ?? '';
  for (const [kind, expected] of [['following', 'expectedFollowing'], ['followers', 'expectedFollowers']]) {
    $(kind + '-count').replaceChildren(document.createTextNode((state[kind] ?? 0).toLocaleString() + ' '));
    const small = document.createElement('small');
    small.textContent = '/ ' + (state[expected] == null ? '—' : state[expected].toLocaleString());
    $(kind + '-count').append(small);
  }
  const total = (state.expectedFollowing ?? 0) + (state.expectedFollowers ?? 0);
  const percent = state.status === 'done' ? 100 : total ? Math.min(99, Math.round((state.following + state.followers) / total * 100)) : 0;
  $('progress-fill').style.width = percent + '%';
  document.querySelector('[role="progressbar"]').setAttribute('aria-valuenow', percent);
  if (patch.results) { limit = 100; $('search').value = ''; renderRows(); }
  if (patch.username) $('account').textContent = '@' + patch.username;
  buttons();
}
function renderRows() {
  const query = $('search').value.trim().toLowerCase();
  const filtered = state.results.filter(row => ((row.username ?? '') + ' ' + row.name + ' ' + row.id).toLowerCase().includes(query));
  const fragment = document.createDocumentFragment();
  for (const row of filtered.slice(0, limit)) {
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    const avatar = document.createElement('span');
    avatar.className = 'avatar'; avatar.textContent = [...row.name].slice(0, 1).join('').toUpperCase();
    const text = document.createElement('span'); text.textContent = row.name;
    name.append(avatar, text);
    const username = document.createElement('td'); username.textContent = row.username ? '@' + row.username : 'ID ' + row.id;
    const linkCell = document.createElement('td');
    const link = document.createElement('a'); link.href = row.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '查看主页 ↗';
    linkCell.append(link); tr.append(name, username, linkCell); fragment.append(tr);
  }
  $('rows').replaceChildren(fragment);
  $('result-count').textContent = state.results.length.toLocaleString();
  $('empty').hidden = filtered.length !== 0;
  $('empty').textContent = state.results.length === 0 ? (mode === 'offline' ? '所选存档中没有发现未回关账号。' : '你关注的人都回关了你。') : '没有匹配的账号。';
  $('showing').textContent = filtered.length ? `显示 ${Math.min(limit, filtered.length)} / ${filtered.length} 个账号` : '';
  $('more').hidden = filtered.length <= limit;
}
async function connect() {
  if (busy || mode !== 'online') return;
  busy = true; ready = false; buttons(); $('error').hidden = true; $('account').textContent = '正在识别…';
  state = { status: 'idle', results: [], following: 0, followers: 0 }; update({});
  try {
    if (!Number.isSafeInteger(tabId) || tabId <= 0) {
      const tabs = await chrome.tabs.query({ url: 'https://x.com/*', currentWindow: true });
      tabId = tabs[0]?.id;
    }
    if (tabId == null) throw new Error('未找到 X 标签页。请在 Chrome 打开并登录 x.com，再点击扩展图标。');
    scanner = new ExistingTabScanner(tabId, update);
    const account = await scanner.connect();
    state.username = account.username;
    $('account').textContent = '@' + account.username;
    $('connection').textContent = '已连接你现有的 X 登录，可以直接扫描。';
    ready = true;
  } catch (error) { $('account').textContent = '尚未连接'; $('connection').textContent = '请保留 X 标签页，登录后点击重新识别。'; showError(error.message); }
  finally { busy = false; buttons(); }
}
$('start').addEventListener('click', async () => {
  if (busy || !ready || mode !== 'online') return;
  busy = true; $('error').hidden = true;
  $('result-note').textContent = '两份在线名单人数均已核对。关系可能随时变化。';
  state = { status: 'connecting', username: state.username, results: [], following: 0, followers: 0 };
  scanner = new ExistingTabScanner(tabId, update); update({ message: '正在确认当前登录账号…', results: [] });
  try {
    const results = await scanner.run();
    update({ status: 'done', results, message: '两份名单人数校验通过。原 X 标签页已保留，登录状态继续有效。' });
  } catch (error) {
    const cancelled = scanner.controller.signal.aborted;
    update({ status: cancelled ? 'cancelled' : 'error', results: [], message: cancelled ? '本次扫描已取消，你的 X 登录仍然保留。' : error.message });
    if (!cancelled) ready = false;
  } finally { busy = false; buttons(); }
});
$('cancel').addEventListener('click', () => scanner?.cancel());
$('reconnect').addEventListener('click', () => { void connect(); });
$('search').addEventListener('input', () => { limit = 100; renderRows(); });
$('more').addEventListener('click', () => { limit += 100; renderRows(); });
$('export').addEventListener('click', () => {
  if (state.status !== 'done') return;
  const url = URL.createObjectURL(new Blob([globalThis.XFollowData.resultCsv(state.results, { includeId: mode === 'offline' })], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `${state.username ?? 'archive'}-not-following-back.csv`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
});
window.addEventListener('pagehide', () => scanner?.cancel());
function switchMode(next) {
  if (busy) return;
  mode = next;
  $('privacy-badge').textContent = mode === 'offline' ? '离线导入 · 本机处理' : '在线扫描 · 会访问 X';
  $('intro-copy').textContent = mode === 'offline' ? '导入 X 官方存档，无需登录、不滚动页面，比较过程不访问 X。' : '在线扫描使用现有 X 登录，会自动访问和滚动原 X 标签页；此模式存在平台限流或账号限制风险。';
  $('offline-card').hidden = mode !== 'offline';
  $('online-card').hidden = mode !== 'online';
  $('offline-mode').setAttribute('aria-selected', String(mode === 'offline'));
  $('online-mode').setAttribute('aria-selected', String(mode === 'online'));
  $('error').hidden = true;
  state = { status: 'idle', results: [], following: 0, followers: 0 };
  update({ results: [] });
  $('welcome').hidden = mode === 'online';
}
$('offline-mode').addEventListener('click', () => switchMode('offline'));
$('online-mode').addEventListener('click', () => switchMode('online'));
for (const id of ['following-files', 'follower-files']) $(id).addEventListener('change', () => {
  state = { status: 'idle', results: [], following: 0, followers: 0 };
  $('error').hidden = true;
  update({ results: [] });
  $('archive-selection').textContent = `关注：${$('following-files').files.length} 个文件；粉丝：${$('follower-files').files.length} 个文件。`;
});
$('import-archive').addEventListener('click', async () => {
  if (busy || mode !== 'offline') return;
  busy = true;
  $('error').hidden = true;
  state = { status: 'importing', results: [], following: 0, followers: 0 };
  update({ results: [], message: '正在本地读取文件并按账号 ID 比较，不访问 X…' });
  try {
    const archive = await compareArchive($('following-files').files, $('follower-files').files);
    $('result-note').textContent = '结果仅反映所选存档文件，不是实时关系。无法核实两个名单是否来自同一次导出，以及是否选全所有分片。';
    update({ ...archive, status: 'done', expectedFollowing: archive.following, expectedFollowers: archive.followers, message: '离线比较完成，文件和结果未上传。缺少用户名的账号可通过 ID 主页链接查看。' });
  } catch (error) { update({ status: 'error', results: [], message: error.message }); }
  finally { busy = false; buttons(); }
});
buttons();
