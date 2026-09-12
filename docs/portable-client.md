# Portable Amigo client

Here, **client** means a running Amigo, including the HeyAmigo bot runtime. The HeyAmigo Cloud web interface is a separate user interface. Cloud's server owns company records and jobs; Amigospace owns authenticated company knowledge and membership.

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

Run the same command with `check` to validate identity and relative storage paths. `check` does not claim login, connection health, or Cloud enrollment. No credentials are printed. Image builds use a file allowlist and exclude live configs, state, credentials, and `.git`.

## Run

Replace `init` with `start` to run the bot in the foreground. The supervisor forwards shutdown signals and drains the bot before the container exits. Linux `flock` prevents two clients using the same mounted filesystem from starting simultaneously; a conflict exits with code 75. The lock releases when the owning process ends, without relying on machine-local PID files.

Configure the selected Amigo's accounts and allowed chats in its volume before enabling channels. The image includes Claude Code pinned to the verified local version, but no model credentials or operator login. Provision model access belonging to that Amigo. Other model providers need their CLI in a derived image. The client gives subprocesses a private home inside the volume and drops inherited host-specific model configuration directory overrides.

`AMIGO_BROWSER_ENABLED=1` also starts private headless Chromium on container loopback port 9222. It uses `home/.config/google-chrome-novnc` inside the volume, which matches the bot's browser profile convention. Browser sandboxing remains enabled. The hosting runtime must support Chromium's sandbox; startup must fail if it cannot. Do not fix that failure using privileged mode or `--no-sandbox`. Interactive login/viewing and hosted browser access grants remain separate integrations.

`compose.client.yaml` supplies the tested private-browser sandbox profile and resource limits. Set the company/Amigo IDs plus a distinct `AMIGO_VOLUME`, then initialize with `docker compose -f compose.client.yaml run --rm client init` and start with `docker compose -f compose.client.yaml up -d`. No browser or management ports are published. Shut down with `docker compose -f compose.client.yaml down`; retain the named volume. See `containers/README.md` for the sandbox profile's provenance.

Do not publish debugging ports, mount the Docker socket, or share an operator's home. The image runs as an unprivileged user. Use a read-only image filesystem, bounded CPU/memory/PIDs, temporary scratch storage, and a hardened sandbox appropriate to untrusted agents. The image alone is not proof of tenant isolation.

## Move to another machine

Stop and fence the original client, then mount its persistent cloud disk on the replacement or restore a consistent private backup. Run the same compatible image, IDs and storage layout on the new machine. Do not copy a live Chromium profile or a live SQLite database. Retain encryption/key-store material together with the profile. Preserve owner-only directories (0700), private configuration (0600), and the container user's ownership when restoring. The app's data paths stay relative, and `/var/lib/amigo` is the same path inside each container regardless of the host.

A Docker local volume is still stored on one Docker host. Machine-independent storage needs a cloud storage backend, or an explicit backup/restore transfer. A copied volume is a separate filesystem, so `flock` cannot fence the previous machine or prevent two independently restored clients from acting. The Cloud scheduler must perform that fencing before automatic migration is enabled. [Docker volume lifecycle and storage drivers](https://docs.docker.com/engine/storage/volumes/) explain the storage boundary.

Sessions may expire and need reconnecting. There is no promise of live process migration, uninterrupted sockets, cross-OS browser-key portability, or exactly-once messaging after recovery.

## Current boundary

This is a portable runtime package. It does not yet enroll in or receive commands from HeyAmigo Cloud's server. Company-authenticated client grants, remote orchestration, hosted storage provisioning, encrypted backups and fencing remain required for the hosted platform. There is no public deployment or account migration as part of this change.

The unit tests verify relocation, identity mismatch, path traversal, symlinks and configuration preservation. The offline container acceptance test boots the real bot and sandboxed Chromium for two synthetic companies with two Amigos each. It saves a distinct real browser cookie per Amigo, checks Chromium's seccomp and PID namespace sandbox status, stops the client cleanly, copies its volume, and starts a replacement. Cookies, private files and healthy SQLite state must survive; a simultaneous client and a wrong identity must be rejected.

Run `node scripts/test-portable-client.mjs heyamigo-client:local` after building the image. It creates and cleans up only uniquely named test containers and volumes. All test containers have external networking disabled; no real accounts, provider calls or messages are involved. The proof uses replacement containers and restored volumes on one Docker host; it does not prove cloud-host failover or real platform login portability.
