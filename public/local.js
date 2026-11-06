import { resultCsv } from './csv.mjs';
const $ = id => document.getElementById(id);
let results = []; let limit = 100; let busy = false; let stopLookup = false;
function lock(value) { busy = value; $('refresh').disabled = value; $('archive-source').disabled = value; $('lookup').disabled = value || !results.length; $('update-profiles').disabled = value || !results.length; }
function clear() { results = []; $('results').hidden = true; $('rows').replaceChildren(); $('error').hidden = true; }
function fail(error) { clear(); $('error').textContent = error.message; $('error').hidden = false; $('status').textContent = '未生成结果，请检查文件后刷新。'; }
async function request(url, options) { const response = await fetch(url, options); const data = await response.json(); if (!response.ok) throw new Error(data.error ?? '无法读取本地文件。'); return data; }
function render() {
  const query = $('search').value.trim().toLowerCase();
  const filtered = results.filter(row => `${row.id} ${row.username ?? ''} ${row.name} ${row.description ?? ''}`.toLowerCase().includes(query));
  const fragment = document.createDocumentFragment();
  for (const row of filtered.slice(0, limit)) {
    const tr = document.createElement('tr');
    const account = document.createElement('td');
    const identity = document.createElement('div'); identity.className = 'account-identity';
    const fallback = document.createElement('span'); fallback.className = 'avatar'; fallback.textContent = (row.name || '?').slice(0, 1); fallback.setAttribute('aria-hidden', 'true');
    if (row.avatar) {
      const image = document.createElement('img'); image.className = 'avatar'; image.src = row.avatar; image.alt = `${row.name}的头像`; image.loading = 'lazy'; image.decoding = 'async'; image.width = 44; image.height = 44;
      image.addEventListener('error', () => { image.replaceWith(fallback); }, { once: true }); identity.append(image);
    } else identity.append(fallback);
    const name = document.createElement('a'); name.className = 'account-name'; name.href = row.url; name.target = '_blank'; name.rel = 'noopener noreferrer'; name.textContent = row.name; identity.append(name); account.append(identity);
    const id = document.createElement('td');
    const username = document.createElement('a'); username.href = row.url; username.target = '_blank'; username.rel = 'noopener noreferrer'; username.textContent = row.username ? '@' + row.username : 'ID ' + row.id; id.append(username);
    const description = document.createElement('td'); description.className = 'profile-description'; description.textContent = row.description ?? '—';
    if (row.description === '') description.textContent = '暂无简介';
    const followers = document.createElement('td'); followers.className = 'profile-count'; followers.textContent = Number.isSafeInteger(row.followersCount) && row.followersCount >= 0 ? row.followersCount.toLocaleString() : '—';
    const following = document.createElement('td'); following.className = 'profile-count'; following.textContent = Number.isSafeInteger(row.followingCount) && row.followingCount >= 0 ? row.followingCount.toLocaleString() : '—';
    const cell = document.createElement('td'); const link = document.createElement('a'); link.href = row.url; link.textContent = '查看主页 ↗'; link.target = '_blank'; link.rel = 'noopener noreferrer'; cell.append(link);
    tr.append(account, id, description, followers, following, cell); fragment.append(tr);
  }
  $('rows').replaceChildren(fragment); $('result-count').textContent = results.length.toLocaleString();
  $('showing').textContent = filtered.length ? `显示 ${Math.min(limit, filtered.length)} / ${filtered.length} 个账号` : '所选文件中没有匹配的账号。';
  $('more').hidden = filtered.length <= limit;
}
async function compare() {
  clear(); $('status').textContent = '正在本地读取名单并比较…';
  const data = await request('/api/compare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: $('archive-source').value }) });
  results = data.results; $('profile-status').textContent = `已从本地缓存补全 ${results.filter(row => row.checkedAt).length} 个账号资料；${results.filter(row => row.profileNeedsUpdate).length} 个需补全或更新。缓存有效期 7 天，点击上方“补全或更新资料”才会联网。`; limit = 100; $('search').value = ''; render();
  $('summary').textContent = `存档：${data.source}；关注 ${data.following} 人，粉丝 ${data.followers} 人。结果不是实时关系，缺少用户名时显示账号 ID。`;
  $('results').hidden = false; $('status').textContent = '比较完成。已读取本地存档和资料缓存，本次比较没有联网。';
}
async function refresh() {
  if (busy) return; lock(true); clear();
  try {
    const health = await request('/health');
    if (health.profileVersion !== 2 || health.proxyVersion !== 1) throw new Error('后台仍是旧版本。请关闭原启动终端，再双击“启动工具.command”并刷新页面。');
    const catalog = await request('/api/archives');
    const choices = catalog.archives.map(archive => { const option = document.createElement('option'); option.value = archive.id; option.textContent = archive.label + (archive.type === 'zip' ? '（ZIP）' : '（已解压）'); return option; });
    $('archive-source').replaceChildren(...choices);
    if (choices.length) $('archive-source').value = catalog.archives[0].id;
    if (!choices.length) { $('status').textContent = '还没有存档。把下载完成的 ZIP 或解压后的存档放入 archives，再点刷新文件夹。'; return; }
    await compare();
  } catch (error) { fail(error); } finally { lock(false); }
}
$('refresh').addEventListener('click', () => { void refresh(); });
$('archive-source').addEventListener('change', async () => { if (busy) return; lock(true); try { await compare(); } catch (error) { fail(error); } finally { lock(false); } });
$('search').addEventListener('input', () => { limit = 100; render(); });
$('more').addEventListener('click', () => { limit += 100; render(); });
$('export').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([resultCsv(results, { includeId: true })], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = 'archive-not-following-back.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
});
void refresh();

async function lookupProfiles(force = false) {
  if (busy) return;
  const selected = results.filter(row => force || row.profileNeedsUpdate);
  if (!selected.length) { $('profile-status').textContent = '当前资料仍在 7 天缓存期内，或暂缓重查，无需联网。'; return; }
  lock(true); stopLookup = false; $('stop-lookup').hidden = false;
  let processed = 0; let queried = 0; let missing = 0;
  try {
    for (let offset = 0; offset < selected.length && !stopLookup; offset += 3) {
      $('profile-status').textContent = `正在查询 ${processed} / ${selected.length}；通过独立代理获取头像、简介和数量；限流时会等待并有限换节点，每个账号完成后保存…`;
      const batch = selected.slice(offset, offset + 3);
      const data = await request('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: batch.map(row => row.id), force }) });
      for (const row of results) {
        const profile = data.profiles[row.id];
        if (profile) Object.assign(row, profile);
      }
      processed += batch.length; queried += data.queried; missing += data.missing;
      render();
      if (data.message) { $('profile-status').textContent = data.message + ' 已完成的查询已保存，名单仍可使用。'; return; }
    }
    $('profile-status').textContent = `${stopLookup ? '已停止' : '查询完成'}：本次联网查询 ${queried} 个，${missing} 个未取得资料或暂缓重查。结果已缓存 7 天；打开页面、刷新及重启均会复用。`;
  } catch (error) { $('profile-status').textContent = error.message + ' 已保存的缓存仍然保留。'; }
  finally { $('stop-lookup').hidden = true; lock(false); }
}
$('lookup').addEventListener('click', () => { void lookupProfiles(); });
$('update-profiles').addEventListener('click', () => { void lookupProfiles(true); });
$('stop-lookup').addEventListener('click', () => { stopLookup = true; $('profile-status').textContent = '将在当前小批查询结束后停止，已查结果会保留。'; });
