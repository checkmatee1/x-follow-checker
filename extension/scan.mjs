const wait = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new Error('扫描已取消。')); return; }
  const timer = setTimeout(done, ms);
  function done() { signal?.removeEventListener('abort', abort); resolve(); }
  function abort() { clearTimeout(timer); reject(new Error('扫描已取消。')); }
  signal?.addEventListener('abort', abort, { once: true });
});

export class ExistingTabScanner {
  constructor(tabId, update, { tick = 900, idleLimit = 45_000, navigationTimeout = 30_000 } = {}) {
    this.tabId = tabId;
    this.update = update;
    this.tick = tick;
    this.idleLimit = idleLimit;
    this.navigationTimeout = navigationTimeout;
    this.controller = new AbortController();
    this.expectedPath = null;
    this.originalUrl = null;
    this.lastNavigation = null;
  }
  check() { if (this.controller.signal.aborted) throw new Error('扫描已取消。'); }
  cancel() { this.controller.abort(); }
  async pause() { await wait(this.tick, this.controller.signal); }
  async snapshot(kind, userId) {
    this.check();
    return chrome.tabs.sendMessage(this.tabId, { type: 'snapshot', kind, userId });
  }
  async connect() {
    this.check();
    let tab;
    try { tab = await chrome.tabs.get(this.tabId); } catch { throw new Error('原来的 X 标签页已关闭，请打开 X 后重新点击扩展。'); }
    if (!tab.url?.startsWith('https://x.com/')) throw new Error('请在已登录的 x.com 标签页点击扩展。');
    let refreshed = false;
    const deadline = Date.now() + this.navigationTimeout;
    while (Date.now() < deadline) {
      this.check();
      let state;
      try { state = await this.snapshot(); }
      catch (error) {
        this.check();
        if (!refreshed) { refreshed = true; await chrome.tabs.reload(this.tabId); }
        await this.pause();
        continue;
      }
      if (state.account?.username) return state.account;
      if (/^https:\/\/x\.com\/(?:i\/flow\/login|login)/.test(state.url)) throw new Error('这个 Chrome 标签页尚未登录 X。请在原标签页登录后点击重新识别。');
      await this.pause();
    }
    throw new Error('未识别到当前登录账号。请确认 X 已登录且页面左侧能看到“个人资料”，再点击重新识别。');
  }
  assertAccount(snapshot) {
    if (snapshot.account?.username?.toLowerCase() !== this.username.toLowerCase()) throw new Error('X 登录账号已变化或登录失效，扫描已停止。请重新识别账号。');
  }
  async navigate(path, kind, userId) {
    this.check();
    const before = await this.snapshot().catch(() => null);
    this.check();
    this.lastNavigation = `https://x.com${path}`;
    await chrome.tabs.update(this.tabId, { url: this.lastNavigation });
    const deadline = Date.now() + this.navigationTimeout;
    while (Date.now() < deadline) {
      this.check();
      let state;
      try { state = await this.snapshot(kind, userId); } catch { await this.pause(); continue; }
      if (state.documentId !== before?.documentId && new URL(state.url).pathname === path) {
        if (state.account) { this.assertAccount(state); this.expectedPath = path; return state; }
      }
      if (/\/i\/flow\/login/.test(state.url)) throw new Error('X 登录已失效，请在原标签页登录后重新扫描。');
      await this.pause();
    }
    throw new Error('X 页面加载超时，或你切换了扫描标签页。请重试。');
  }
  async profile() {
    let state = await this.navigate(`/${this.username}`);
    const deadline = Date.now() + this.navigationTimeout;
    while (Date.now() < deadline) {
      this.check();
      this.assertAccount(state);
      if (new URL(state.url).pathname !== this.expectedPath) throw new Error('扫描期间页面已切换，请重新扫描。');
      if (state.profileError) throw new Error(state.profileError);
      if (state.profile?.username.toLowerCase() === this.username.toLowerCase()) return state.profile;
      await this.pause();
      state = await this.snapshot();
    }
    throw new Error('无法读取当前账号人数，X 可能限制了访问或已更改页面格式。');
  }
  async collect(kind, expected, userId) {
    const key = kind.toLowerCase();
    const label = kind === 'Following' ? '关注' : '粉丝';
    this.update({ status: key, message: `正在读取${label}，请保留原 X 标签页，暂时不要切换账号或页面。` });
    if (expected === 0) { this.update({ [key]: 0 }); return []; }
    if (expected > 100_000) throw new Error('当前版本单份名单上限为 100,000 人，无法确认该账号名单完整。');
    let state = await this.navigate(`/${this.username}/${key}`, kind, userId);
    let size = 0;
    let lastGrowth = Date.now();
    const deadline = Date.now() + 20 * 60_000;
    while (true) {
      this.check();
      this.assertAccount(state);
      if (new URL(state.url).pathname !== this.expectedPath) throw new Error('扫描期间页面已切换，请重新扫描。');
      if (state.list?.error) throw new Error(state.list.error);
      const users = state.list?.users ?? [];
      if (users.length !== size) { size = users.length; lastGrowth = Date.now(); this.update({ [key]: size }); }
      if (state.list?.received && size === expected) return users;
      if (size > expected) throw new Error(`${label}人数与账号资料不一致，请重新扫描。`);
      if (Date.now() > deadline || Date.now() - lastGrowth > this.idleLimit) throw new Error(`${label}名单未读取完整（${size}/${expected}），未生成未回关结论。X 可能限制名单展示或读取频率。`);
      const response = await chrome.tabs.sendMessage(this.tabId, { type: 'scroll', documentId: state.documentId });
      if (response?.error) throw new Error(response.error);
      await this.pause();
      state = await this.snapshot(kind, userId);
    }
  }
  async run() {
    return navigator.locks.request(`x-follow-checker-tab-${this.tabId}`, { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('这个 X 标签页已在另一个检查页面扫描，请先在那里取消或等待完成。');
      const account = await this.connect();
      this.username = account.username;
      this.originalUrl = (await chrome.tabs.get(this.tabId)).url;
      this.update({ username: this.username, status: 'profile', message: '已识别当前账号，正在读取人数…', results: [] });
      try {
        const initial = await this.profile();
        this.update({ expectedFollowing: initial.following, expectedFollowers: initial.followers });
        const following = await this.collect('Following', initial.following, initial.id);
        const followers = await this.collect('Followers', initial.followers, initial.id);
        this.update({ status: 'checking', message: '正在复核账号与人数…' });
        const final = await this.profile();
        this.check();
        if (final.id !== initial.id || final.following !== initial.following || final.followers !== initial.followers) throw new Error('扫描期间关注或粉丝人数发生变化，为避免误判，请重新扫描。');
        return globalThis.XFollowData.compareLists(following, followers);
      } finally {
        // Only restore a page we navigated to. Never close the tab or log out.
        try {
          const tab = await chrome.tabs.get(this.tabId);
          if ((tab.pendingUrl ?? tab.url) === this.lastNavigation && this.originalUrl) await chrome.tabs.update(this.tabId, { url: this.originalUrl });
        } catch { /* User may have closed/navigated the tab. */ }
      }
    });
  }
}
