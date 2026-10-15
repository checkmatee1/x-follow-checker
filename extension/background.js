const PROJECT_ORIGIN = 'http://127.0.0.1:59931';
// This is the shared action handler; the optional origin enables isolated integration fixtures.
async function openProject(source, origin = PROJECT_ORIGIN) {
  let ready = false;
  try {
    const response = await fetch(origin + '/health', { signal: AbortSignal.timeout(2000), cache: 'no-store', credentials: 'omit', redirect: 'error' });
    const health = await response.json();
    ready = response.ok && health.service === 'x-follow-checker-folder' && health.protocol === 1;
  } catch { /* A stopped local service gets a helpful extension page, never an X request. */ }
  const tabId = source?.url?.startsWith('https://x.com/') ? source.id : null;
  const fallback = chrome.runtime.getURL('launch.html') + (tabId == null ? '' : `?tab=${tabId}`);
  return chrome.tabs.create({ url: ready ? origin + '/' : fallback, index: source?.index == null ? undefined : source.index + 1 });
}
chrome.action.onClicked.addListener(source => { void openProject(source); });
