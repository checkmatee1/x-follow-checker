chrome.action.onClicked.addListener(async source => {
  let tabId = null;
  if (source?.url?.startsWith('https://x.com/')) tabId = source.id;
  else {
    const tabs = await chrome.tabs.query({ url: 'https://x.com/*', currentWindow: true });
    tabId = tabs.find(tab => tab.active)?.id ?? tabs[0]?.id ?? null;
  }
  const url = chrome.runtime.getURL('dashboard.html') + (tabId == null ? '' : `?tab=${tabId}`);
  await chrome.tabs.create({ url, index: source?.index == null ? undefined : source.index + 1 });
});
