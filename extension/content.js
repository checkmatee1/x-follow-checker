(() => {
  const { validName, publicUser } = globalThis.XFollowData;
  const documentId = crypto.randomUUID();
  const profiles = new Map();
  const lists = new Map();
  const profileErrors = new Map();
  function identity() {
    const account = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
    if (!account) return null;
    const href = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href');
    let linkName = null;
    try {
      const path = typeof href === 'string' ? new URL(href, location.origin).pathname : '';
      const match = /^\/([a-zA-Z0-9_]{1,15})\/?$/.exec(path);
      if (match) linkName = match[1];
    } catch { /* Navigation may not be ready yet. */ }
    const candidates = [...account.querySelectorAll('span')].map(span => span.textContent.trim()).filter(text => /^@[a-zA-Z0-9_]{1,15}$/.test(text));
    const switchName = [...new Set(candidates.map(text => text.slice(1)))].at(0);
    if (linkName && switchName && linkName.toLowerCase() !== switchName.toLowerCase()) return null;
    const username = linkName ?? switchName;
    return validName(username) ? { username } : null;
  }
  // Only exact displayed counts on the identified account's own profile page.
  // Never turn abbreviations (1.2K / 1万), absent fields or verified-only counts into totals.
  function displayedCount(username, kind) {
    if (location.pathname.toLowerCase().replace(/\/$/, '') !== '/' + username.toLowerCase()) return null;
    const column = document.querySelector('[data-testid="primaryColumn"]');
    if (!column) return null;
    const suffixes = kind === 'following' ? ['following'] : ['followers', 'verified_followers'];
    const exact = value => {
      const displayed = String(value ?? '').trim();
      if (!/^(?:\d+|\d{1,3}(?:[,\s\u00a0\u202f]\d{3})+)$/.test(displayed)) return null;
      const text = displayed.replace(/[,\s\u00a0\u202f]/g, '');
      const number = Number(text);
      return Number.isSafeInteger(number) ? number : null;
    };
    for (const suffix of suffixes) {
      const counts = [];
      for (const link of column.querySelectorAll('a[href]')) {
        const url = new URL(link.getAttribute('href'), location.origin);
        if (url.origin !== location.origin || url.pathname.toLowerCase().replace(/\/$/, '') !== `/${username.toLowerCase()}/${suffix}`) continue;
        if (suffix === 'verified_followers' && /verified|认证|認證|已验证/i.test(link.textContent)) continue;
        const values = [...link.querySelectorAll('[title]')].map(element => exact(element.getAttribute('title'))).filter(value => value !== null);
        if (!values.length) values.push(...[...link.querySelectorAll('span')].map(element => exact(element.textContent)).filter(value => value !== null));
        const unique = [...new Set(values)];
        if (unique.length === 1) counts.push(unique[0]);
      }
      const unique = [...new Set(counts)];
      if (unique.length === 1) return unique[0];
      if (unique.length > 1) return null;
    }
    return null;
  }
  function completeProfile(account) {
    const profile = account ? profiles.get(account.username.toLowerCase()) : null;
    if (!profile) return null;
    const following = profile.following ?? displayedCount(profile.username, 'following');
    const followers = profile.followers ?? displayedCount(profile.username, 'followers');
    return following !== null && followers !== null ? { ...profile, following, followers } : null;
  }
  document.addEventListener('x-follow-checker-public-data-v2', event => {
    try {
      if (typeof event.detail !== 'string' || event.detail.length > 2_000_000) return;
      const data = JSON.parse(event.detail);
      if (data.path !== location.pathname) return;
      if (data.operation === 'UserByScreenName') {
        const profile = data.profile;
        const safe = publicUser({ rest_id: profile?.id, core: { screen_name: profile?.username, name: profile?.name } });
        if (safe && (profile.following === null || (Number.isSafeInteger(profile.following) && profile.following >= 0)) && (profile.followers === null || (Number.isSafeInteger(profile.followers) && profile.followers >= 0))) {
          profiles.set(safe.username.toLowerCase(), { ...safe, following: profile.following, followers: profile.followers });
          profileErrors.delete(safe.username.toLowerCase());
        } else if (data.error && validName(data.username)) profileErrors.set(data.username.toLowerCase(), String(data.error).slice(0, 250));
        return;
      }
      if (!['Following', 'Followers'].includes(data.operation) || !/^\d+$/.test(data.userId)) return;
      const key = data.operation + ':' + data.userId;
      if (!lists.has(key)) lists.set(key, { users: new Map(), error: null, received: false });
      const list = lists.get(key);
      if (data.error) list.error = String(data.error).slice(0, 250);
      if (!Array.isArray(data.users)) return;
      for (const candidate of data.users) {
        const user = publicUser({ rest_id: candidate.id, core: { screen_name: candidate.username, name: candidate.name } });
        if (!user) continue;
        if (!list.users.has(user.id) && list.users.size >= 100_000) list.error = '名单超过当前版本上限，无法确认完整性。';
        else list.users.set(user.id, user);
      }
      list.received = true;
    } catch { /* Ignore unrelated/invalid page messages. */ }
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === 'snapshot') {
      const account = identity();
      const profile = completeProfile(account);
      const list = /^\d+$/.test(message.userId ?? '') && ['Following', 'Followers'].includes(message.kind) ? lists.get(message.kind + ':' + message.userId) : null;
      respond({ documentId, url: location.href, account, profile, profileError: account ? profileErrors.get(account.username.toLowerCase()) ?? null : null, list: list ? { users: [...list.users.values()], error: list.error, received: list.received } : null });
    } else if (message?.type === 'scroll') {
      if (message.documentId !== documentId) { respond({ error: '页面已变化，扫描已停止。' }); return; }
      let element = document.querySelector('[data-testid="primaryColumn"]');
      while (element && element !== document.body) {
        if (element.scrollHeight > element.clientHeight && /auto|scroll/.test(getComputedStyle(element).overflowY)) element.scrollBy(0, 1100);
        element = element.parentElement;
      }
      window.scrollBy(0, Math.max(750, innerHeight * 0.85));
      respond({ ok: true });
    }
  });
})();
