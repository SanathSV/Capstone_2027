// Astra MV3 service worker. Owns extension state and all backend calls.
// No remote code, no eval — MV3 forbids both.

const DEFAULT_API_URL = "http://localhost:8000";

async function getApiUrl() {
  const { apiUrl } = await chrome.storage.sync.get("apiUrl");
  return apiUrl || DEFAULT_API_URL;
}

chrome.runtime.onInstalled.addListener(() => {
  console.log("[astra] installed");
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "ASTRA_PING") {
    getApiUrl().then((apiUrl) => sendResponse({ ok: true, apiUrl }));
    return true; // keep the channel open for the async response
  }
  return false;
});
