const status = document.getElementById("status");

chrome.runtime.sendMessage({ type: "ASTRA_PING" }, (response) => {
  status.textContent = response?.ok ? `Backend: ${response.apiUrl}` : "Backend unreachable";
});
