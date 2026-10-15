chrome.action.onClicked.addListener(async source => {
  let tabId = null;
  if (source?.url?.startsWith('https://x.com/')) tabId = source.id;
  const url = chrome.runtime.getURL('dashboard.html') + (tabId == null ? '' : `?tab=${tabId}`);
  await chrome.tabs.create({ url, index: source?.index == null ? undefined : source.index + 1 });
});
