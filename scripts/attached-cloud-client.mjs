#!/usr/bin/env node
// Observe an existing Linux bot without importing it or starting another reply loop.
import {
  mkdir,
  lstat,
  realpath,
  readFile,
  readlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { binding } from "./portable-client.mjs";
import {
  privateJson,
  validateConnection,
  runCloudClient,
  browserStatus,
} from "./cloud-client.mjs";

async function target(env) {
  if (
    !isAbsolute(env.HEYAMIGO_ROOT ?? "") ||
    !isAbsolute(env.HEYAMIGO_PACKAGE_ROOT ?? "")
  )
    throw new Error(
      "Set absolute HEYAMIGO_ROOT and HEYAMIGO_PACKAGE_ROOT paths.",
    );
  const root = await realpath(env.HEYAMIGO_ROOT);
  const packageRoot = await realpath(env.HEYAMIGO_PACKAGE_ROOT);
  const pkg = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  if (pkg.name !== "@c4t4/heyamigo")
    throw new Error("The target must be an installed HeyAmigo package.");
  for (const file of [
    join(root, "config/config.json"),
    join(packageRoot, "dist/cli/start.js"),
  ]) {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("Invalid HeyAmigo installation.");
  }
  return { root, packageRoot };
}

async function attachmentFile(env, initialize = false) {
  const directory = env.AMIGO_ATTACHMENT_DIR;
  if (!isAbsolute(directory ?? ""))
    throw new Error("Set an absolute private AMIGO_ATTACHMENT_DIR.");
  if (initialize) await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077)
    throw new Error(
      "The attachment directory must be owner-only and cannot be a symbolic link.",
    );
  return join(await realpath(directory), "attachment.json");
}

export async function configureAttachment(env, source) {
  const installed = await target(env);
  const connection = validateConnection(
    await privateJson(resolve(source)),
    { identity: binding(env) },
    env,
  );
  const file = await attachmentFile(env, true);
  const value = { version: 1, ...installed, connection };
  try {
    const previous = await privateJson(file);
    if (JSON.stringify(previous) === JSON.stringify(value)) return;
    throw new Error(
      "An attachment already exists. Revoke and stop it before replacing its private file.",
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeFile(file, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
}

export async function loadAttachment(env) {
  const installed = await target(env);
  const saved = await privateJson(await attachmentFile(env));
  if (
    Object.keys(saved).sort().join(",") !==
      "connection,packageRoot,root,version" ||
    saved.version !== 1 ||
    saved.root !== installed.root ||
    saved.packageRoot !== installed.packageRoot
  )
    throw new Error(
      "This attachment belongs to a different HeyAmigo installation.",
    );
  return {
    ...installed,
    connection: validateConnection(
      saved.connection,
      { identity: binding(env) },
      env,
    ),
  };
}

// Match cwd AND installed entry point so a stale/reused PID cannot look like a running bot.
// Only process metadata is read. No messages, cookies, channel credentials or model config.
export async function standaloneStatus(installed, procRoot = "/proc") {
  try {
    const pid = (
      await readFile(join(installed.root, "storage/heyamigo.pid"), "utf8")
    ).trim();
    if (!/^[1-9][0-9]*$/.test(pid)) return "unverified";
    async function matches(id, entry) {
      const base = join(procRoot, id);
      const [cwd, args] = await Promise.all([
        readlink(join(base, "cwd")),
        readFile(join(base, "cmdline"), "utf8"),
      ]);
      return (
        cwd === installed.root &&
        args.split("\0")[1] === join(installed.packageRoot, entry)
      );
    }
    if (!(await matches(pid, "dist/cli/supervisor.js"))) return "unverified";
    const children = (
      await readFile(join(procRoot, pid, "task", pid, "children"), "utf8")
    )
      .trim()
      .split(/\s+/);
    for (const child of children) {
      if (!/^[1-9][0-9]*$/.test(child)) continue;
      try {
        if (await matches(child, "dist/cli/start.js")) return "running";
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return "stopped";
  } catch (error) {
    return error.code === "ENOENT" ? "stopped" : "unverified";
  }
}

export async function attachedRuntimeCheck(env, signal) {
  const installed = await loadAttachment(env);
  return {
    state: "valid",
    mode: "attached",
    standalone: await standaloneStatus(installed),
    browser: await browserStatus(env, signal),
    whatsapp: "managed_by_standalone",
    telegram: "managed_by_standalone",
    externalActions: 0,
  };
}

export function runAttachedClient(env, options = {}) {
  if (process.platform !== "linux")
    throw new Error("Attaching a live installation currently requires Linux.");
  return runCloudClient(env, {
    ...options,
    loadConnection: async (values) => (await loadAttachment(values)).connection,
    checkRuntime: attachedRuntimeCheck,
    clientVersion: "attached-1",
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.umask(0o077);
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  const main = async () => {
    if (process.argv[2] === "configure" && process.argv[3]) {
      await configureAttachment(process.env, process.argv[3]);
      console.log(
        JSON.stringify({ status: "configured_not_checked", mode: "attached" }),
      );
    } else if (process.argv[2] === "start") {
      await runAttachedClient(process.env, { signal: controller.signal });
    } else throw new Error("Use configure <connection-file> or start.");
  };
  main().catch(() => {
    console.error(
      "Attached Client stopped: its connection or installation could not be validated.",
    );
    process.exitCode = 1;
  });
}
