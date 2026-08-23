const DEFAULTS = { server: "http://localhost:8080", key: "", name: "Meeting Notetaker" };
const $ = (id) => document.getElementById(id);

chrome.storage.sync.get(DEFAULTS).then((config) => {
  $("server").value = config.server;
  $("key").value = config.key;
  $("name").value = config.name;
});

$("save").addEventListener("click", async () => {
  await chrome.storage.sync.set({
    server: $("server").value.trim() || DEFAULTS.server,
    key: $("key").value.trim(),
    name: $("name").value.trim() || DEFAULTS.name,
  });
  $("saved").textContent = "Saved";
  setTimeout(() => ($("saved").textContent = ""), 1500);
});
