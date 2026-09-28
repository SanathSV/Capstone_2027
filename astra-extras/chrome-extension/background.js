import { getValidSession } from "./lib/session.js";

/**
 * The service worker.
 *
 * Two jobs, both of which exist because the popup cannot do them:
 *
 *  1. **Keep the session alive.** A popup only runs while it is open, so a
 *     token that expires overnight would leave the leader signing in again
 *     every morning. An alarm refreshes it in the background instead.
 *
 *  2. **Show whether this tab is summonable.** The action badge turns green on
 *     a Meet tab, so the answer to "can I use this here?" is visible without
 *     opening the popup at all.
 *
 * MV3 service workers are killed aggressively — usually within 30 seconds of
 * going idle — so nothing is kept in memory here. Every handler reads what it
 * needs from `chrome.storage` and finishes.
 */

const REFRESH_ALARM = "astra-refresh";
/** Comfortably inside Supabase's ~1 hour access-token lifetime. */
const REFRESH_MINUTES = 30;

const MEET_URL = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i;

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(REFRESH_ALARM, { periodInMinutes: REFRESH_MINUTES });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(REFRESH_ALARM, { periodInMinutes: REFRESH_MINUTES });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== REFRESH_ALARM) return;
  // getValidSession refreshes when the token is close to expiring and clears
  // the stored session when the refresh token is spent, so there is nothing
  // else to do with the result.
  await getValidSession();
});

// --------------------------------------------------------------------------
// Badge
// --------------------------------------------------------------------------

async function paintBadge(tabId, url) {
  const onMeet = MEET_URL.test(url ?? "");
  await chrome.action.setBadgeText({ tabId, text: onMeet ? "●" : "" });
  if (onMeet) {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#3ecf8e" });
    await chrome.action.setTitle({ tabId, title: "Astra — summon the bot into this meeting" });
  } else {
    await chrome.action.setTitle({ tabId, title: "Astra — open a Google Meet to summon the bot" });
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // `status: complete` alone is not enough: Meet is a single-page app and
  // navigating between rooms changes the URL without a page load.
  if (changeInfo.url || changeInfo.status === "complete") {
    paintBadge(tabId, changeInfo.url ?? tab.url).catch(() => {});
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await paintBadge(tabId, tab.url);
  } catch {
    // The tab can be gone by the time this runs; nothing to paint.
  }
});
