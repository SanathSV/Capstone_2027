// Content script injected into meet.google.com.
// Scaffold only: detects the meeting id and tells the service worker we are here.

function getMeetingCode() {
  const match = window.location.pathname.match(/^\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
  return match ? match[1] : null;
}

const meetingCode = getMeetingCode();
if (meetingCode) {
  chrome.runtime.sendMessage({ type: "ASTRA_PING", meetingCode });
}
