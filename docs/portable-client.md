# Portable Amigo client

Here, **client** means the Amigo's runtime, not the HeyAmigo Cloud web interface. `start` runs the standalone bot; `cloud-start` runs the authenticated Cloud Client and optional private browser. Cloud mode currently accepts runtime checks and does not start standalone model, messaging or reply loops. Cloud's server owns company records and jobs; Amigospace owns authenticated company knowledge and membership.

The client image packages the existing WhatsApp/Telegram runtime and Chromium independently of its private data. One mounted volume contains one Amigo's identity, configuration, browser profile, channel authentication, model-provider home, SQLite queue, conversations and memory. Its manifest contains stable company/Amigo IDs, not a machine hostname or checkout path.

## Build and initialize

```sh
docker build -f Dockerfile.client -t heyamigo-client:local .
```

Supply `AMIGO_WORKSPACE_ID` and `AMIGO_AGENT_ID` from the owning Cloud account through trusted deployment configuration. These labels protect against accidental volume mix-ups; they are not an authenticated Cloud grant. Select a new private volume for each Amigo.

```sh
docker run --rm --network=none \
  --env AMIGO_WORKSPACE_ID --env AMIGO_AGENT_ID \
  --mount type=volume,src=YOUR_AMIGO_VOLUME,dst=/var/lib/amigo \
  heyamigo-client:local init
```

Initialization disables connections and clears sample users and active chats. Reinitializing the same identity preserves existing configuration. A different identity or an unlabelled non-empty volume is rejected. Never initialize directly over an existing installation; migrate its chosen state deliberately after stopping it.

Run the same command with `check` to validate identity and relative storage paths. `check` reports whether Cloud configuration is present but does not claim login or connection health. No credentials are printed. Image builds use a file allowlist and exclude live configs, state, credentials, and `.git`.

## Connect the body to HeyAmigo Cloud

First initialize the private volume above. In Cloud, open **Your agents → Identity and accounts → Cloud Client** and choose **Download connection file** as the company owner. It contains the Cloud origin, verified company/Amigo binding, a private credential and its expiry. Set `AMIGO_WORKSPACE_ID`, `AMIGO_AGENT_ID` and `AMIGO_VOLUME` to this Amigo's values for the following commands. The volume's identity must match the connection file.

Keep the file owner-only and mount it read-only for import; replace `/absolute/path/connection.json` with the actual downloaded file:

```sh
chmod 600 /absolute/path/connection.json
docker compose -f compose.client.yaml run --rm client init
docker compose -f compose.client.yaml run --rm \
  --volume /absolute/path/connection.json:/run/amigo-connection.json:ro \
  client configure-cloud /run/amigo-connection.json
docker compose -f compose.cloud-client.yaml up -d
```

The equivalent commands inside an initialized Linux environment are `heyamigo-client configure-cloud <file>` and `heyamigo-client cloud-start`. Importing saves `cloud-connection.json` as an owner-only file on the private volume and reports **configured**. Starting performs authentication and reports **connected** only after Cloud verifies the credential and returns the matching identity. Normal `start` refuses a Cloud-configured volume to prevent the standalone bot from responding independently.

Use **Check Client** in Cloud to dispatch a real runtime check. The Client validates its private state, probes its own Chromium endpoint when enabled, and returns the result. Cloud displays contact and task state separately. WhatsApp/Telegram remain **not connected** in this mode; existing stored channel credentials are not activated. Brain, model tasks, account interaction and incoming messages are not part of this connection milestone.

The Client initiates HTTPS requests; no inbound Client ports are published. It polls every 10 seconds, holds a 45-second session lease, and accepts only the versioned `runtime_check` operation. Unsupported commands or identity mismatches stop the Client. Network outages cause bounded backoff without executing work. Runtime checks can be retried after a crash because they are read-only; Cloud deduplicates acknowledged results and rejects stale leases. The connection file stays with the volume when the Client moves, but the previous instance must be stopped before a replacement takes ownership.

**Pause Client work** cancels pending checks while keeping contact alive. **Revoke connection** disables the credential immediately on Cloud and makes the Client exit when it next contacts Cloud. The Cloud Compose file does not automatically restart an exited Client. Credentials expire after 90 days. To replace a lost or expired connection, revoke it in Cloud, stop the old Client, remove only its old `cloud-connection.json`, and import a newly issued file. Treat downloaded copies and backups as credentials.

For local development, loopback HTTP is allowed. A container cannot reach the host's Cloud server through its own `127.0.0.1`: use `http://host.docker.internal:4300` in a development connection file and explicitly set `AMIGO_ALLOW_LOCAL_DOCKER_CLOUD=1`. Pass `--env AMIGO_ALLOW_LOCAL_DOCKER_CLOUD=1` on the import command as well; `compose.cloud-client.yaml` forwards that variable when starting. This exception only allows `host.docker.internal`, never arbitrary HTTP destinations. Hosted connections require HTTPS.

## Run

For standalone mode, replace `init` with `start` to run the bot in the foreground; use `cloud-start` for a configured Cloud Client. The supervisor forwards shutdown signals and closes the browser cleanly before the container exits. Linux `flock` prevents two clients using the same mounted filesystem from starting simultaneously; a conflict exits with code 75. The lock releases when the owning process ends, without relying on machine-local PID files.

Configure the selected Amigo's accounts and allowed chats in its volume before enabling channels. The image includes Claude Code pinned to the verified local version, but no model credentials or operator login. Provision model access belonging to that Amigo. Other model providers need their CLI in a derived image. The client gives subprocesses a private home inside the volume and drops inherited host-specific model configuration directory overrides.

`AMIGO_BROWSER_ENABLED=1` also starts private headless Chromium on container loopback port 9222. It uses `home/.config/google-chrome-novnc` inside the volume, which matches the bot's browser profile convention. Browser sandboxing remains enabled. The hosting runtime must support Chromium's sandbox; startup must fail if it cannot. Do not fix that failure using privileged mode or `--no-sandbox`. Interactive login/viewing and hosted browser access grants remain separate integrations.

`compose.client.yaml` supplies the tested private-browser sandbox profile and resource limits. Set the company/Amigo IDs plus a distinct `AMIGO_VOLUME`, then initialize with `docker compose -f compose.client.yaml run --rm client init` and start with `docker compose -f compose.client.yaml up -d`. No browser or management ports are published. Shut down with `docker compose -f compose.client.yaml down`; retain the named volume. See `containers/README.md` for the sandbox profile's provenance.

Do not publish debugging ports, mount the Docker socket, or share an operator's home. The image runs as an unprivileged user. Use a read-only image filesystem, bounded CPU/memory/PIDs, temporary scratch storage, and a hardened sandbox appropriate to untrusted agents. The image alone is not proof of tenant isolation.

## Move to another machine

Stop and fence the original client, then mount its persistent cloud disk on the replacement or restore a consistent private backup. Run the same compatible image, IDs and storage layout on the new machine. Do not copy a live Chromium profile or a live SQLite database. Retain encryption/key-store material together with the profile. Preserve owner-only directories (0700), private configuration (0600), and the container user's ownership when restoring. The app's data paths stay relative, and `/var/lib/amigo` is the same path inside each container regardless of the host.

A Docker local volume is still stored on one Docker host. Machine-independent storage needs a cloud storage backend, or an explicit backup/restore transfer. A copied volume is a separate filesystem, so `flock` cannot fence the previous machine or prevent two independently restored clients from acting. The Cloud scheduler must perform that fencing before automatic migration is enabled. [Docker volume lifecycle and storage drivers](https://docs.docker.com/engine/storage/volumes/) explain the storage boundary.

Sessions may expire and need reconnecting. There is no promise of live process migration, uninterrupted sockets, cross-OS browser-key portability, or exactly-once messaging after recovery.

## Current boundary

The portable runtime now authenticates to HeyAmigo Cloud, reports contact, executes read-only runtime checks, returns results and honors pause/revocation. Cloud connection credentials are issued by the owning company and resolve to one Amigo; local IDs alone never authorize a server request. Remote container provisioning, hosted storage, protected backups and physical execution fencing remain required. There is no public deployment or real account migration as part of this change.

The agreed hosted architecture places HeyAmigo Brain inside HeyAmigo Cloud, with private goals, memory, feedback and learning per Amigo. Brain comes after connecting the body and remains unimplemented. The Client's browser, platform credentials, channel sessions and local execution state stay in this private volume; the future Brain agenda will stay in Cloud. Adding messaging requires routing incoming events into the Cloud workflow without re-enabling competing standalone replies.

The unit tests verify relocation, identity mismatch, path traversal, symlinks and configuration preservation. The offline container acceptance test boots the real bot and sandboxed Chromium for two synthetic companies with two Amigos each. It saves a distinct real browser cookie per Amigo, checks Chromium's seccomp and PID namespace sandbox status, stops the client cleanly, copies its volume, and starts a replacement. Cookies, private files and healthy SQLite state must survive; a simultaneous client and a wrong identity must be rejected.

Run `node scripts/test-portable-client.mjs heyamigo-client:local` after building the image. It creates and cleans up only uniquely named test containers and volumes. All test containers have external networking disabled; no real accounts, provider calls or messages are involved. The proof uses replacement containers and restored volumes on one Docker host; it does not prove cloud-host failover or real platform login portability.

The Cloud repository also has opt-in HTTP and container acceptance tests, using `TEST_CLIENT_SOURCE_ROOT` and `TEST_CLIENT_IMAGE`. They connect four synthetic Clients over real HTTP, restart Cloud, relocate one Client volume, and verify an actual Chromium container returns a runtime check after replacement and exits after revocation. These use only temporary synthetic credentials and do not sign into platforms or call a model.
