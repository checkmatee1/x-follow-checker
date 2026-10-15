(() => {
  const validName = value => typeof value === 'string' && /^[a-zA-Z0-9_]{1,15}$/.test(value);
  const unwrap = result => result?.__typename === 'UserWithVisibilityResults' ? result.user : result;
  function publicUser(raw) {
    const user = unwrap(raw);
    const username = user?.core?.screen_name ?? user?.legacy?.screen_name;
    if (!validName(username) || !/^\d+$/.test(String(user?.rest_id ?? ''))) return null;
    return { id: String(user.rest_id), username, name: String(user.core?.name ?? user.legacy?.name ?? username).slice(0, 300), url: `https://x.com/${username}` };
  }
  function readProfile(payload) {
    // New profile responses use a different root and may omit legacy counts.
    const raw = unwrap(payload?.data?.user_result_by_screen_name?.result ?? payload?.data?.user?.result);
    const user = publicUser(raw);
    const following = raw?.legacy?.friends_count;
    const followers = raw?.legacy?.followers_count;
    if (!user) return null;
    const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
    return { ...user, following: count(following), followers: count(followers) };
  }
  function readTimeline(payload) {
    const root = unwrap(payload?.data?.user?.result);
    const instructions = root?.timeline?.timeline?.instructions ?? root?.timeline?.instructions;
    if (!Array.isArray(instructions)) return null;
    const users = [];
    const readEntry = entry => {
      if (!String(entry?.entryId ?? '').startsWith('user-')) return;
      const user = publicUser(entry.content?.itemContent?.user_results?.result);
      if (user) users.push(user);
    };
    for (const instruction of instructions) {
      for (const entry of instruction.entries ?? []) readEntry(entry);
      if (instruction.entry) readEntry(instruction.entry);
    }
    return users;
  }
  function compareLists(following, followers) {
    const ids = new Set(followers.map(user => user.id));
    return following.filter(user => !ids.has(user.id)).sort((a, b) => a.username.toLowerCase().localeCompare(b.username.toLowerCase(), 'en'));
  }
  function resultCsv(rows) {
    const cell = value => {
      let text = String(value);
      if (/^[\s\uFEFF]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
      return '"' + text.replaceAll('"', '""') + '"';
    };
    return '\uFEFF' + [['用户名', '名称', '主页链接'], ...rows.map(row => [row.username, row.name, row.url])].map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
  }
  globalThis.XFollowData = Object.freeze({ validName, publicUser, readProfile, readTimeline, compareLists, resultCsv });
})();
