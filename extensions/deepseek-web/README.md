# DeepSeek Web Plugin

Control a logged-in DeepSeek web tab without API keys.

## What it does

- `/deepseek send <text>`: send a message to the page input.
- `/deepseek ask <text>`: send, wait a configurable time, then fetch latest content.
- `/deepseek poll`: fetch latest messages once.
- `/deepseek watch on|off`: enable/disable background polling.
- `/deepseek fetch [n]`: read latest captured window from local state.
- `/deepseek logs [n]`: read recent newly-detected messages.

This plugin works best with browser profile `chrome` when using OpenClaw's Chrome extension relay on an already logged-in session.

## Minimal config

Add to your OpenClaw config:

```json
{
  "plugins": {
    "entries": {
      "deepseek-web": {
        "enabled": true,
        "config": {
          "profile": "chrome",
          "urlMatch": "chat.deepseek.com",
          "openUrl": "https://chat.deepseek.com/",
          "autoWatch": true,
          "pollIntervalMs": 15000,
          "sendWaitMs": 12000,
          "inputSelector": "textarea",
          "sendButtonSelector": "button[type='submit']",
          "messageSelector": "main [class*='message'], main .markdown"
        }
      }
    }
  }
}
```

## Notes

- If selectors do not match DeepSeek page updates, adjust `inputSelector`, `sendButtonSelector`, and `messageSelector`.
- State is stored under OpenClaw state dir at `plugins/deepseek-web/state.json`.
- This path avoids model reasoning for critical browser steps and is suitable for small local models.
