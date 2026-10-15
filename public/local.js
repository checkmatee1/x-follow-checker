const $ = id => document.getElementById(id);
let results = []; let limit = 100; let busy = false;
function lock(value) { busy = value; $('refresh').disabled = value; $('archive-source').disabled = value; }
function clear() { results = []; $('results').hidden = true; $('rows').replaceChildren(); $('error').hidden = true; }
function fail(error) { clear(); $('error').textContent = error.message; $('error').hidden = false; $('status').textContent = '未生成结果，请检查文件后刷新。'; }
async function request(url, options) { const response = await fetch(url, options); const data = await response.json(); if (!response.ok) throw new Error(data.error ?? '无法读取本地文件。'); return data; }
function render() {
  const query = $('search').value.trim().toLowerCase();
  const filtered = results.filter(row => `${row.id} ${row.username ?? ''} ${row.name}`.toLowerCase().includes(query));
  const fragment = document.createDocumentFragment();
  for (const row of filtered.slice(0, limit)) {
    const tr = document.createElement('tr'); const name = document.createElement('td'); name.textContent = row.name;
    const id = document.createElement('td'); id.textContent = row.username ? '@' + row.username : 'ID ' + row.id;
    const cell = document.createElement('td'); const link = document.createElement('a'); link.href = row.url; link.textContent = '查看主页 ↗'; link.target = '_blank'; link.rel = 'noopener noreferrer'; cell.append(link); tr.append(name, id, cell); fragment.append(tr);
  }
  $('rows').replaceChildren(fragment); $('result-count').textContent = results.length.toLocaleString();
  $('showing').textContent = filtered.length ? `显示 ${Math.min(limit, filtered.length)} / ${filtered.length} 个账号` : '所选文件中没有匹配的账号。';
  $('more').hidden = filtered.length <= limit;
}
async function compare() {
  clear(); $('status').textContent = '正在本地读取名单并比较…';
  const data = await request('/api/compare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: $('archive-source').value }) });
  results = data.results; limit = 100; $('search').value = ''; render();
  $('summary').textContent = `存档：${data.source}；关注 ${data.following} 人，粉丝 ${data.followers} 人。结果不是实时关系，缺少用户名时显示账号 ID。`;
  $('results').hidden = false; $('status').textContent = '比较完成。文件和结果未上传，也没有访问 X。';
}
async function refresh() {
  if (busy) return; lock(true); clear();
  try {
    const previous = $('archive-source').value;
    const catalog = await request('/api/archives');
    const choices = catalog.archives.map(archive => { const option = document.createElement('option'); option.value = archive.id; option.textContent = archive.label + (archive.type === 'zip' ? '（ZIP）' : '（已解压）'); return option; });
    $('archive-source').replaceChildren(...choices);
    if (catalog.archives.some(archive => archive.id === previous)) $('archive-source').value = previous;
    if (!choices.length) { $('status').textContent = '还没有存档。把下载完成的 ZIP 或解压后的存档放入 archives，再点刷新文件夹。'; return; }
    await compare();
  } catch (error) { fail(error); } finally { lock(false); }
}
$('refresh').addEventListener('click', () => { void refresh(); });
$('archive-source').addEventListener('change', async () => { if (busy) return; lock(true); try { await compare(); } catch (error) { fail(error); } finally { lock(false); } });
$('search').addEventListener('input', () => { limit = 100; render(); });
$('more').addEventListener('click', () => { limit += 100; render(); });
$('export').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([globalThis.XFollowData.resultCsv(results, { includeId: true })], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = 'archive-not-following-back.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
});
void refresh();
