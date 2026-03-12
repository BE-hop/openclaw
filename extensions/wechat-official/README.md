# WeChat Official Channel Plugin

Connect OpenClaw to a WeChat Official Account (公众号) using developer-mode webhooks.

## Features

- GET webhook verification (`echostr`)
- POST inbound message handling (XML)
- AES safe-mode decryption (`encrypt_type=aes`)
- DM access policy support: `pairing | allowlist | open | disabled`
- Asynchronous auto-reply via WeChat custom service API
- Optional DeepSeek web async bridge with command-triggered background tasks

## Install

```bash
openclaw plugins install ./extensions/wechat-official
```

## Minimal config

```json5
{
  channels: {
    "wechat-official": {
      enabled: true,
      appId: "wx...",
      appSecret: "...",
      token: "your_token",
      encodingAesKey: "43_characters_for_safe_mode",
      webhookPath: "/wechat/webhook",
      dmPolicy: "open",
    },
  },
}
```

## DeepSeek web async bridge (optional)

Use this when your Official Account must reply in 5 seconds, but DeepSeek web responses may take longer.

```json5
{
  channels: {
    "wechat-official": {
      enabled: true,
      // ...wechat required fields
      deepseekBridge: {
        enabled: true,
        commandPrefix: "ds",
        browserProfile: "chrome",
        openUrl: "https://chat.deepseek.com/",
        pollIntervalMs: 7000,
        maxWaitMs: 300000,
        thinkingReply: "已收到，DeepSeek 正在思考中。请稍后发送“dsback”获取结果。",
      },
    },
  },
}
```

Command flow:

- Any text containing `ds`: enqueue a DeepSeek task.
- `dsback [任务ID]`: fetch result quickly; if still running, returns progress status.

Behavior:

- Messages without `ds` continue through the normal OpenClaw model path.
- On `ds` trigger messages, OpenClaw returns `thinkingReply` immediately and processes the browser task in background.
- If `dsback` arrives before task completion, OpenClaw replies that the task is still running.
- Task results are stored and can be fetched later by command.
- Browser polling interval is controlled in the 5-10 second range by default to reduce risk of aggressive scraping patterns.
- The bridge reuses one DeepSeek conversation and opens a new conversation every 10 tasks.

## Environment variables (default account)

- `WECHAT_OFFICIAL_APP_ID`
- `WECHAT_OFFICIAL_APP_SECRET`
- `WECHAT_OFFICIAL_TOKEN`
- `WECHAT_OFFICIAL_ENCODING_AES_KEY`
- `WECHAT_OFFICIAL_WEBHOOK_PATH`
- `WECHAT_OFFICIAL_DM_POLICY`
- `WECHAT_OFFICIAL_ALLOW_FROM`
- `WECHAT_OFFICIAL_TEXT_CHUNK_LIMIT`

## WeChat platform setup

In the Official Account backend (developer mode), configure:

- URL: `https://<your-domain>/wechat/webhook` (or your custom `webhookPath`)
- Token: same as config `token`
- EncodingAESKey: same as config `encodingAesKey`
- Data format: `XML`
- Encryption mode: recommended `Safe Mode` (`encrypt_type=aes`)

## Notes

- The plugin returns `success` quickly, then sends reply asynchronously through custom service API.
- If you need strict sender control in production, prefer `pairing` or `allowlist` instead of `open`.
- DeepSeek bridge requires browser control availability (for example profile `chrome`) and an already logged-in DeepSeek web session.
