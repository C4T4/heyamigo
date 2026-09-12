import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  chmod,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import {
  configureAttachment,
  loadAttachment,
  standaloneStatus,
  attachedRuntimeCheck,
} from "../scripts/attached-cloud-client.mjs";
import { runCloudClient } from "../scripts/cloud-client.mjs";

async function fixture(fn: any) {
  const directory = await mkdtemp(join(tmpdir(), "attached-client-test-"));
  const env = {
    HEYAMIGO_ROOT: join(directory, "existing"),
    HEYAMIGO_PACKAGE_ROOT: join(directory, "package"),
    AMIGO_ATTACHMENT_DIR: join(directory, "attachment"),
    AMIGO_WORKSPACE_ID: randomUUID(),
    AMIGO_AGENT_ID: randomUUID(),
  };
  await mkdir(join(env.HEYAMIGO_ROOT, "config"), { recursive: true });
  await mkdir(join(env.HEYAMIGO_ROOT, "storage"));
  await mkdir(join(env.HEYAMIGO_PACKAGE_ROOT, "dist/cli"), { recursive: true });
  env.HEYAMIGO_ROOT = await realpath(env.HEYAMIGO_ROOT);
  env.HEYAMIGO_PACKAGE_ROOT = await realpath(env.HEYAMIGO_PACKAGE_ROOT);
  await writeFile(
    join(env.HEYAMIGO_PACKAGE_ROOT, "package.json"),
    JSON.stringify({ name: "@c4t4/heyamigo" }),
  );
  await writeFile(
    join(env.HEYAMIGO_PACKAGE_ROOT, "dist/cli/start.js"),
    'throw new Error("must never start")',
  );
  const sentinel = JSON.stringify({
    credentials: "synthetic-private-sentinel",
  });
  await writeFile(join(env.HEYAMIGO_ROOT, "config/config.json"), sentinel);
  const connection = {
    protocolVersion: 1,
    cloudUrl: "http://127.0.0.1:4300",
    workspaceId: env.AMIGO_WORKSPACE_ID,
    agentId: env.AMIGO_AGENT_ID,
    token: `amigo_client_${randomBytes(32).toString("base64url")}`,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  };
  const file = join(directory, "connection.json");
  await writeFile(file, JSON.stringify(connection), { mode: 0o600 });
  try {
    await fn({ directory, env, connection, file, sentinel });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("attachment preserves existing configuration, binds the target and rejects exposed files and foreign identities", async () => {
  await fixture(async ({ env, connection, file, sentinel }: any) => {
    await configureAttachment(env, file);
    await configureAttachment(env, file);
    assert.deepEqual((await loadAttachment(env)).connection, connection);
    assert.equal(
      await readFile(join(env.HEYAMIGO_ROOT, "config/config.json"), "utf8"),
      sentinel,
    );
    await assert.rejects(
      loadAttachment({ ...env, AMIGO_AGENT_ID: randomUUID() }),
      /belong/,
    );
    await chmod(join(env.AMIGO_ATTACHMENT_DIR, "attachment.json"), 0o644);
    await assert.rejects(loadAttachment(env), /owner-only/);
  });
});

test("a reused PID or wrong process cannot masquerade as the existing bot", async () => {
  await fixture(async ({ directory, env, file }: any) => {
    await configureAttachment(env, file);
    const installed = await loadAttachment(env),
      proc = join(directory, "proc");
    await writeFile(join(env.HEYAMIGO_ROOT, "storage/heyamigo.pid"), "123");
    for (const [pid, entry] of [
      ["123", "supervisor.js"],
      ["124", "start.js"],
    ]) {
      await mkdir(join(proc, pid, "task", pid), { recursive: true });
      await symlink(env.HEYAMIGO_ROOT, join(proc, pid, "cwd"));
      await writeFile(
        join(proc, pid, "cmdline"),
        `node\0${join(env.HEYAMIGO_PACKAGE_ROOT, "dist/cli", entry)}\0`,
      );
    }
    await writeFile(join(proc, "123/task/123/children"), "124 ");
    assert.equal(await standaloneStatus(installed, proc), "running");
    await writeFile(join(proc, "124/cmdline"), "node\0/some/other/start.js\0");
    assert.equal(await standaloneStatus(installed, proc), "stopped");
    await writeFile(
      join(proc, "123/cmdline"),
      "node\0/some/other/supervisor.js\0",
    );
    assert.equal(await standaloneStatus(installed, proc), "unverified");
    await rm(join(env.HEYAMIGO_ROOT, "storage/heyamigo.pid"));
    assert.equal(await standaloneStatus(installed, proc), "stopped");
  });
});

test("Cloud dispatches a real attached check without importing the bot or leaking config into results", async () => {
  await fixture(async ({ env, connection, file, sentinel }: any) => {
    await configureAttachment(env, file);
    let polls = 0,
      result: any;
    const logs: any[] = [];
    const http = async (url: URL, init: any) => {
      const body = JSON.parse(init.body);
      if (url.pathname.endsWith("/connect")) {
        assert.equal(body.clientVersion, "attached-1");
        return Response.json({
          protocolVersion: 1,
          workspaceId: connection.workspaceId,
          agentId: connection.agentId,
          generation: 1,
        });
      }
      if (url.pathname.endsWith("/poll"))
        return ++polls === 1
          ? Response.json({
              paused: false,
              task: {
                id: randomUUID(),
                leaseId: randomUUID(),
                kind: "runtime_check",
              },
            })
          : Response.json({}, { status: 401 });
      if (url.pathname.endsWith("/results")) result = body.result;
      return Response.json({ accepted: true });
    };
    await assert.rejects(
      runCloudClient(env, {
        http,
        log: (v: any) => logs.push(v),
        clientVersion: "attached-1",
        loadConnection: async () => (await loadAttachment(env)).connection,
        checkRuntime: attachedRuntimeCheck,
      }),
      /401/,
    );
    assert.deepEqual(result, {
      state: "valid",
      mode: "attached",
      standalone: "stopped",
      browser: "disabled",
      whatsapp: "managed_by_standalone",
      telegram: "managed_by_standalone",
      externalActions: 0,
    });
    assert.doesNotMatch(
      JSON.stringify({ result, logs }),
      /synthetic-private-sentinel|amigo_client_/,
    );
    assert.equal(
      await readFile(join(env.HEYAMIGO_ROOT, "config/config.json"), "utf8"),
      sentinel,
    );
  });
});
