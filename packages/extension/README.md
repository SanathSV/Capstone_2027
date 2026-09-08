# Astra Extension

Manifest V3 Chrome extension.

```bash
npm run build          # emits dist/
# chrome://extensions -> Developer mode -> Load unpacked -> select dist/
```

Copy the loaded extension's id into the backend's `CHROME_EXTENSION_IDS` so CORS accepts it.
