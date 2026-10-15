export function resultCsv(rows, { includeId = false } = {}) {
  const cell = value => {
    let text = String(value);
    if (/^[\s\uFEFF]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return '\uFEFF' + [[...(includeId ? ['账号ID'] : []), '用户名', '名称', '主页链接'], ...rows.map(row => [...(includeId ? [row.id] : []), row.username ?? '', row.name, row.url])].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
