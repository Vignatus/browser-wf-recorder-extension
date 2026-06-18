# Workflow Recorder — Chrome Extension

Records and replays browser workflows using CDP and DOM event capture.

## Loading the extension

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select this folder (`browser-wf-recorder-extension`)

The extension icon will appear in the Chrome toolbar.

## Usage

Click the extension icon to open the popup. Sign in with your backend credentials (the backend must be running at `http://localhost:3000` or the URL configured in Settings).

## Reloading after code changes

After editing any file, go to `chrome://extensions` and click the reload icon on the extension card. For background service worker changes, also click the **"Service worker"** link and re-open DevTools.
