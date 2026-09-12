#!/usr/bin/env node
// Disposable, offline container proof. Never loads a real account or host profile.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
const exec = promisify(execFile)
const image = process.argv[2] ?? 'heyamigo-client:portable-test'
const prefix = `amigo-portability-${randomUUID().slice(0, 8)}`
const volumes = [],
  containers = []
const docker = async (args) =>
  (await exec('docker', args, { maxBuffer: 200000, timeout: 60000 })).stdout.trim()
const security = [
  '--network=none',
  '--read-only',
  '--tmpfs',
  '/tmp:rw,nosuid,size=128m',
  '--cap-drop=ALL',
  '--security-opt=no-new-privileges',
  `--security-opt=seccomp=${fileURLToPath(new URL('../containers/chromium-seccomp.json', import.meta.url))}`,
  '--shm-size=256m',
  '--pids-limit=256',
  '--memory=1g',
  '--cpus=1',
]
const identityArgs = (identity) => [
  '--env',
  `AMIGO_WORKSPACE_ID=${identity.workspaceId}`,
  '--env',
  `AMIGO_AGENT_ID=${identity.agentId}`,
]
const mount = (volume) => ['--mount', `type=volume,src=${volume},dst=/var/lib/amigo`]
const run = (volume, identity, command) =>
  docker(['run', '--rm', ...security, ...identityArgs(identity), ...mount(volume), image, command])
const node = (volume, code, extra = []) =>
  docker(['run', '--rm', ...security, ...mount(volume), ...extra, '--entrypoint=node', image, '-e', code])
async function volume(suffix) {
  const name = `${prefix}-${suffix}`
  await docker(['volume', 'create', name])
  volumes.push(name)
  return name
}
async function start(volume, identity, suffix) {
  const name = `${prefix}-${suffix}`
  await docker([
    'run',
    '--detach',
    '--name',
    name,
    ...security,
    ...identityArgs(identity),
    '--env',
    'AMIGO_BROWSER_ENABLED=1',
    ...mount(volume),
    image,
    'start',
  ])
  containers.push(name)
  for (let attempt = 0; attempt < 60; attempt++) {
    if ((await docker(['inspect', '--format', '{{.State.Running}}', name])) !== 'true') {
      const logs = await exec('docker', ['logs', name])
      throw new Error(`Client stopped before readiness: ${logs.stdout}${logs.stderr}`)
    }
    try {
      const status = await docker([
        'exec',
        name,
        'node',
        '-e',
        `
        const db = require('better-sqlite3')('/var/lib/amigo/storage/heyamigo.db', {readonly:true,fileMustExist:true});
        if (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n < 10) process.exit(1);
        if (db.pragma('integrity_check', {simple:true}) !== 'ok') process.exit(1);
        db.close(); fetch('http://127.0.0.1:9222/json/version').then(r=>{if(!r.ok) process.exit(1); console.log('ready')}).catch(()=>process.exit(1));`,
      ])
      if (status === 'ready') return name
    } catch {}
    await delay(250)
  }
  throw new Error('Portable bot did not create a healthy database.')
}
async function browserState(container, identity, write) {
  return docker([
    'exec',
    container,
    'node',
    '--input-type=module',
    '-e',
    String.raw`
    import assert from 'node:assert/strict';
    import WebSocket from 'ws';
    const version = await (await fetch('http://127.0.0.1:9222/json/version')).json();
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((yes,no)=>{ws.once('open',yes);ws.once('error',no)});
    let sequence=0; const pending=new Map();
    ws.on('message',raw=>{const m=JSON.parse(raw); const p=pending.get(m.id); if(p){pending.delete(m.id);m.error?p.no(new Error(JSON.stringify(m.error))):p.yes(m.result)}});
    const cmd=(method,params={},sessionId)=>new Promise((yes,no)=>{const id=++sequence;pending.set(id,{yes,no});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}))});
    const timeout=setTimeout(()=>process.exit(1),15000);
    try {
      const cookie={name:'synthetic_portable_session',value:${JSON.stringify(identity.agentId)},domain:'127.0.0.1',path:'/',expires:Date.now()/1000+86400};
      if (${write}) await cmd('Storage.setCookies',{cookies:[cookie]});
      const cookies=(await cmd('Storage.getCookies')).cookies.filter(c=>c.name===cookie.name);
      assert.deepEqual(cookies.map(c=>c.value),[cookie.value]);
      const target=await cmd('Target.createTarget',{url:'chrome://sandbox'});
      const {sessionId}=await cmd('Target.attachToTarget',{targetId:target.targetId,flatten:true});
      let status='';
      for(let i=0;i<30;i++){
        status=(await cmd('Runtime.evaluate',{expression:'document.body.innerText',returnByValue:true},sessionId)).result.value??'';
        if(/Seccomp-BPF sandbox\s+Yes/.test(status))break;
        await new Promise(r=>setTimeout(r,100));
      }
      assert.match(status,/Seccomp-BPF sandbox\s+Yes/);
      assert.match(status,/PID namespaces\s+Yes/);
      await cmd('Target.closeTarget',{targetId:target.targetId});
      console.log('private cookie and Chromium sandbox verified');
    } finally {clearTimeout(timeout);ws.close()}
  `,
  ])
}
try {
  const companies = [randomUUID(), randomUUID()]
  for (let i = 0; i < 4; i++) {
    const identity = { workspaceId: companies[Math.floor(i / 2)], agentId: randomUUID() }
    const original = await volume(`source-${i}`)
    assert.equal(JSON.parse(await run(original, identity, 'init')).connections, 'disabled')
    const code = `const fs=require('fs'); const id=${JSON.stringify(identity.agentId)};
      for(const name of ['storage/auth/synthetic-session.json','storage/memory/private.md',
        'home/.config/google-chrome-novnc/synthetic-cookie.json','home/.config/synthetic-provider-token'])
        fs.writeFileSync('/var/lib/amigo/'+name,id,{mode:0o600});`
    await node(original, code)
    const first = await start(original, identity, `first-${i}`)
    await browserState(first, identity, true)
    await assert.rejects(run(original, identity, 'start'), (error) => error.code === 75)
    await docker(['stop', '--time=40', first])
    const replacement = await volume(`restored-${i}`)
    await node(
      replacement,
      `process.umask(0o077); require('fs').cpSync('/original', '/var/lib/amigo', {recursive:true,preserveTimestamps:true,verbatimSymlinks:true})`,
      ['--mount', `type=volume,src=${original},dst=/original,readonly`],
    )
    const checked = JSON.parse(await run(replacement, identity, 'check'))
    assert.equal(checked.agentId, identity.agentId)
    assert.equal(checked.cloudControl, 'not_connected')
    await assert.rejects(run(replacement, { ...identity, agentId: randomUUID() }, 'check'))
    await assert.rejects(run(replacement, { ...identity, workspaceId: randomUUID() }, 'check'))
    await node(
      replacement,
      `const fs=require('fs'); const assert=require('assert/strict');
      for(const name of ['storage/auth/synthetic-session.json','storage/memory/private.md',
        'home/.config/google-chrome-novnc/synthetic-cookie.json','home/.config/synthetic-provider-token'])
        assert.equal(fs.readFileSync('/var/lib/amigo/'+name,'utf8'), ${JSON.stringify(identity.agentId)});`,
    )
    const second = await start(replacement, identity, `replacement-${i}`)
    await browserState(second, identity, false)
    await docker(['stop', '--time=40', second])
    console.log(
      `Amigo ${i + 1}/4: real bot and sandboxed browser restart, retained cookie, healthy SQLite, private state restore and exclusive ownership passed.`,
    )
  }
  console.log(
    'PASS: two synthetic companies, four portable clients. No real accounts, model calls, or external network access.',
  )
} finally {
  for (const name of containers) await docker(['rm', '--force', name]).catch(() => {})
  for (const name of volumes) await docker(['volume', 'rm', name]).catch(() => {})
}
