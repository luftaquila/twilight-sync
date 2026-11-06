# Twilight Sync

Real-time sync for [Zen Browser](https://zen-browser.app), inspired by Arc's tab sync.

Spaces, essentials, pinned and open tabs, folders, split views, containers and keyboard shortcuts stay the same on every device.

> [!IMPORTANT]
> Requires Zen 1.24b or later, [Twilight](https://zen-browser.app/download?twilight) included. The extension runs privileged code and isn't signed by Mozilla, so add-on signature checks must be turned off.

## Server

Twilight Sync needs a server that all your devices can reach.

[Tailscale](https://tailscale.com) is recommended: run the server on a machine in your tailnet and let `tailscale serve` provide HTTPS.

```bash
docker run -d --name twilight-sync -p 127.0.0.1:9223:9223 -v twilight-sync-data:/data \
  -e SYNC_TOKEN="$(openssl rand -hex 32)" \
  -e PUBLIC_URL=wss://<machine>.<tailnet>.ts.net \
  ghcr.io/luftaquila/twilight-sync:latest
tailscale serve --bg 9223
docker exec twilight-sync node server.js --invite   # prints the invite
```

## Extension

1. In `about:config`, set `xpinstall.signatures.required` to `false` and `extensions.experiments.enabled` to `true`.
2. Install the `.xpi` from [Releases](https://github.com/luftaquila/twilight-sync/releases/latest).
3. Paste the invite into the toolbar popup and click **Connect**.
