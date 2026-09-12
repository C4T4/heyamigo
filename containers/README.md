# Chromium sandbox profile

`chromium-seccomp.json` is based on Microsoft's Playwright Docker seccomp profile, retrieved from https://raw.githubusercontent.com/microsoft/playwright/main/utils/docker/seccomp_profile.json on 2026-09-12. The upstream Apache 2.0 license is retained in `LICENSE.chromium-seccomp`.

The upstream profile adds user-namespace operations to Docker's default syscall restrictions. This copy additionally permits `chroot`: Chromium uses it inside its unprivileged user namespace, while the client container drops all host capabilities. We keep `no-new-privileges` and never pass `--no-sandbox` or privileged mode. The profile does not change host security settings.

This supports the tested local Linux container setup. A production host still requires a reviewed sandbox, network policy, storage isolation and fencing. See https://playwright.dev/docs/docker for the upstream explanation.
