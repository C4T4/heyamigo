# Connect an existing HeyAmigo

The attached Cloud Client runs alongside an existing Linux HeyAmigo installation. It authenticates to Cloud, receives read-only runtime checks, and reports whether the original supervisor and bot child are running and whether the configured browser responds. It never imports or starts the bot, edits its configuration, reads conversation content, or activates another messaging loop.

This is a status connection to the existing body. Cloud does not yet direct the bot's messages, browser actions, model calls or memory. Pausing or revoking the attachment affects Cloud diagnostics only; the original bot continues independently. Messaging is reported as managed by the standalone bot, with login status unverified.

## Pair

Use an owner-issued connection file from the real owning Cloud workspace, not a synthetic demo. Keep it mode 0600. Set:

```sh
export HEYAMIGO_ROOT=/root/heyamigo
export HEYAMIGO_PACKAGE_ROOT=/usr/lib/node_modules/@c4t4/heyamigo
export AMIGO_ATTACHMENT_DIR=/root/heyamigo/storage/cloud-attachment
export AMIGO_WORKSPACE_ID=YOUR_WORKSPACE_UUID
export AMIGO_AGENT_ID=YOUR_AMIGO_UUID
export AMIGO_BROWSER_ENABLED=1
node scripts/attached-cloud-client.mjs configure /private/path/connection.json
node scripts/attached-cloud-client.mjs start
```

`AMIGO_BROWSER_ENABLED=1` probes only the existing loopback Chromium endpoint on port 9222. It never opens a browser, enumerates tabs, or reads cookies. Omit it when this is not the installation's browser. The installation is checked by its package name, canonical data/package paths, supervisor PID file, process working directories and exact installed entry points. Stale/reused PIDs cannot count as healthy.

The attachment directory is private and separate from portable volumes. Do not run the portable initializer over a live installation. The attachment file holds its bound paths and Cloud credential. It survives a bridge restart and a normal HeyAmigo service restart; moving the actual installation to other paths requires deliberate reattachment. This mode does not migrate accounts or make the installation portable.

## Keep running

Run the attachment as a separate service under the installation's owner, with its own logs, an owner-only environment file, and an exclusive `flock` on its attachment directory. Use graceful SIGTERM to disconnect. Do not automatically restart on exit code 1: revoked or invalid credentials should remain stopped. The transport retries temporary network failures itself. Never expose browser debugging or Cloud's local-owner API publicly.

For a private single-owner server pilot, Cloud can run on server loopback in `AUTH_MODE=local` with `HEYAMIGO_LOCAL_MODE=client_only` and the existing installation root. This disables research integration and model scheduling. Reach its dashboard using an authenticated SSH local forward. This is not hosted company login or Amigospace membership; it must not be placed behind a public proxy. Both services can stay on the server when the laptop disconnects.

## Verify

Open the Amigo's **Identity and accounts → Check Client**. Confirm a completed result says **Existing HeyAmigo: running**, not merely **Client connected**. These are separate checks: the bridge can remain connected when the original bot is stopped. Account login health remains unverified.

To detach, revoke its connection in Cloud and stop the separate attachment service. Preserve the existing bot's sessions and storage. No bot restart or account relinking is needed for attachment or removal.
