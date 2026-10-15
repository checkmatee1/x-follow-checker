(() => {
  const marker = '__x_follow_checker_bridge_v2';
  if (window[marker]) return;
  window[marker] = true;
  const { readProfile, readTimeline } = globalThis.XFollowData;
  const eventName = 'x-follow-checker-public-data-v2';
  // Only read bodies of these public-data operations, never headers or cookies.
  function describe(rawUrl, body) {
    try {
      const url = new URL(rawUrl, location.href);
      if (url.origin !== 'https://x.com' || !url.pathname.includes('/graphql/')) return null;
      const operation = url.pathname.split('/').at(-1);
      if (!['UserByScreenName', 'Following', 'Followers'].includes(operation)) return null;
      const encoded = url.searchParams.get('variables');
      let variables = encoded ? JSON.parse(encoded) : (typeof body === 'string' ? JSON.parse(body).variables : {});
      if (typeof variables === 'string') variables = JSON.parse(variables);
      variables ??= {};
      return { operation, userId: String(variables.userId ?? ''), username: variables.screen_name, path: location.pathname };
    } catch { return null; }
  }
  function publish(request, status, payload) {
    if (!request || request.path !== location.pathname) return;
    const item = { operation: request.operation, userId: request.userId, username: request.username, path: request.path };
    if (status === 429) item.error = 'X 暂时限制了读取频率，请稍后再试。';
    else if (status < 200 || status >= 300 || payload?.errors?.length) item.error = 'X 未允许读取完整名单，请检查账号访问权限。';
    else if (request.operation === 'UserByScreenName') {
      item.profile = readProfile(payload);
      if (!item.profile) item.error = '无法识别 X 的账号资料格式，未生成未回关结论。';
    } else {
      item.users = readTimeline(payload);
      if (!item.users) item.error = 'X 名单格式已变化，当前版本无法确认完整性。';
    }
    document.dispatchEvent(new CustomEvent(eventName, { detail: JSON.stringify(item) }));
  }
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const rawUrl = typeof args[0] === 'string' || args[0] instanceof URL ? String(args[0]) : args[0]?.url;
    const initial = describe(rawUrl, args[1]?.body);
    // Match the operation before looking at its body. Only the variables field is used.
    let pending = Promise.resolve(initial);
    if (initial && args[1]?.body === undefined && args[0] instanceof Request && args[0].method === 'POST') {
      pending = args[0].clone().text().then(body => { const request = describe(rawUrl, body); return request ? { ...request, path: initial.path } : initial; }).catch(() => initial);
    }
    return originalFetch.apply(this, args).then(response => {
      if (initial) {
        const copy = response.ok ? response.clone() : null;
        void pending.then(async request => {
          if (!response.ok) publish(request, response.status, null);
          else {
            try { publish(request, response.status, await copy.json()); }
            catch { publish(request, 200, { errors: [{}] }); }
          }
        });
      }
      return response;
    });
  };
  const open = XMLHttpRequest.prototype.open;
  const requests = new WeakMap();
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    requests.set(this, { url, request: describe(url) });
    return open.call(this, method, url, ...rest);
  };
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    const tracked = requests.get(this);
    const request = tracked?.request ? describe(tracked.url, args[0]) : null;
    if (request) this.addEventListener('load', () => {
      try {
        const payload = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
        publish(request, this.status, payload);
      } catch { publish(request, this.status, { errors: [{}] }); }
    }, { once: true });
    return send.apply(this, args);
  };
})();
