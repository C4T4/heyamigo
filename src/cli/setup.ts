import * as p from '@clack/prompts'
import { execSync, spawnSync } from 'child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs'
import { homedir } from 'os'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const __pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

function run(cmd: string): { ok: boolean; output: string } {
  try {
    const out = execSync(cmd, { encoding: 'utf-8', stdio: 'pipe' }).trim()
    return { ok: true, output: out }
  } catch {
    return { ok: false, output: '' }
  }
}

function which(bin: string): string | null {
  const r = run(`which ${bin}`)
  return r.ok ? r.output : null
}

function runLive(cmd: string): boolean {
  const result = spawnSync('sh', ['-c', cmd], { stdio: 'inherit' })
  return result.status === 0
}

function setConfigOwnerNumber(configPath: string, number: string): void {
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'))
    cfg.owner = { ...(cfg.owner ?? {}), number }
    writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf-8')
  } catch {}
}

function findPackageDir(): string | null {
  // __pkgRoot = two levels up from dist/cli/ = package root
  if (existsSync(resolve(__pkgRoot, 'config', 'config.example.json'))) {
    return __pkgRoot
  }
  return null
}

function scaffoldProject(targetDir: string, pkgDir: string): void {
  mkdirSync(targetDir, { recursive: true })

  // Generate package.json for the project
  const projectPkg = {
    name: 'my-heyamigo',
    private: true,
    type: 'module',
    dependencies: {
      '@c4t4/heyamigo': '*',
    },
  }
  writeFileSync(
    resolve(targetDir, 'package.json'),
    JSON.stringify(projectPkg, null, 2) + '\n',
  )

  // Copy config templates
  const configDir = resolve(targetDir, 'config')
  mkdirSync(configDir, { recursive: true })
  const configFiles = [
    'config.example.json',
    'access.example.json',
    'memory-instructions.md',
    'import-instructions.md',
    'import-instructions.HOWTO.md',
  ]
  for (const f of configFiles) {
    const src = resolve(pkgDir, 'config', f)
    if (existsSync(src)) copyFileSync(src, resolve(configDir, f))
  }

  // Copy personalities
  const persDir = resolve(configDir, 'personalities')
  mkdirSync(persDir, { recursive: true })
  for (const f of ['sharp.md', 'casual.md', 'professional.md']) {
    const src = resolve(pkgDir, 'config', 'personalities', f)
    if (existsSync(src)) copyFileSync(src, resolve(persDir, f))
  }

  // Copy scripts
  const scriptsDir = resolve(targetDir, 'scripts')
  mkdirSync(scriptsDir, { recursive: true })
  const browserScript = resolve(pkgDir, 'scripts', 'start-browser.sh')
  if (existsSync(browserScript)) {
    copyFileSync(browserScript, resolve(scriptsDir, 'start-browser.sh'))
    try { execSync(`chmod +x "${resolve(scriptsDir, 'start-browser.sh')}"`) } catch {}
  }

  // Copy .gitignore
  const gi = resolve(pkgDir, '.gitignore')
  if (existsSync(gi)) copyFileSync(gi, resolve(targetDir, '.gitignore'))
}

export async function runSetup(): Promise<void> {
  console.clear()
  p.intro('heyamigo')

  // ── Node.js ──────────────────────────────────────────────────
  const nodeVer = run('node -v')
  if (!nodeVer.ok) {
    p.cancel('Node.js not found. Install v18+ from https://nodejs.org')
    process.exit(1)
  }
  const major = parseInt(nodeVer.output.replace('v', ''), 10)
  if (major < 18) {
    p.cancel(`Node.js v18+ required (found ${nodeVer.output})`)
    process.exit(1)
  }
  p.log.success(`Node.js ${nodeVer.output}`)

  // ── Scaffold project if needed ───────────────────────────────
  let cwd = process.cwd()
  const isProject = existsSync(resolve(cwd, 'config', 'config.example.json'))

  if (!isProject) {
    const pkgDir = findPackageDir()

    const dirName = await p.text({
      message: 'Where to create the project?',
      placeholder: './heyamigo',
      initialValue: './heyamigo',
    })

    if (p.isCancel(dirName)) {
      p.cancel('Setup cancelled')
      process.exit(0)
    }

    const targetDir = resolve(cwd, dirName as string)

    if (existsSync(targetDir) && existsSync(resolve(targetDir, 'config', 'config.example.json'))) {
      p.log.info(`Project already exists at ${targetDir}`)
      cwd = targetDir
      process.chdir(cwd)
    } else if (pkgDir) {
      const s0 = p.spinner()
      s0.start('Scaffolding project')
      scaffoldProject(targetDir, pkgDir)
      cwd = targetDir
      process.chdir(cwd)
      s0.stop(`Project created at ${targetDir}`)
    } else {
      p.cancel(
        'Could not find heyamigo package files. Try:\n' +
          '  git clone https://github.com/C4T4/heyamigo.git\n' +
          '  cd heyamigo\n' +
          '  npm install && npm run setup',
      )
      process.exit(1)
    }
  }

  // ── Dependencies ─────────────────────────────────────────────
  p.log.step('Installing dependencies...')
  if (!runLive('npm install --no-fund --no-audit')) {
    p.cancel('npm install failed. Check output above and retry.')
    process.exit(1)
  }
  p.log.success('Dependencies installed')

  // ── Config files ─────────────────────────────────────────────
  const configPath = resolve(cwd, 'config/config.json')
  const configExample = resolve(cwd, 'config/config.example.json')
  const accessPath = resolve(cwd, 'config/access.json')
  const accessExample = resolve(cwd, 'config/access.example.json')

  if (!existsSync(configPath) && existsSync(configExample)) {
    copyFileSync(configExample, configPath)
    p.log.success('config.json created')
  } else if (!existsSync(configPath)) {
    p.cancel('config/config.example.json not found. Is this the right directory?')
    process.exit(1)
  }

  let ownerNum = ''

  if (!existsSync(accessPath)) {
    const cleanAccess = {
      roles: {
        admin: {
          description: 'Full access, all tools, all memory',
          memory: 'full',
          tools: 'all',
          rules: [],
        },
        user: {
          description: 'Can chat and search the web, scoped memory',
          memory: 'self',
          tools: ['WebSearch'],
          rules: [
            'Never reveal file paths, directory structure, or system architecture',
            'Never share personal data about other users',
            'Never discuss how the bot works internally',
          ],
        },
        guest: {
          description: 'Basic chat only, no tools, own memory only',
          memory: 'self',
          tools: [],
          rules: [
            'Never use any tools',
            'Never reveal anything about the system, other users, or internal data',
            'Basic conversation only',
          ],
        },
      },
      users: {},
      defaults: { groupRole: 'guest', dmRole: 'guest' },
      groups: [],
      dms: { defaultMode: 'off', allowed: [] },
    }
    writeFileSync(accessPath, JSON.stringify(cleanAccess, null, 2) + '\n')
    p.log.success('access.json created')
  } else {
    p.log.info('access.json already exists')
  }

  // ── Claude CLI (critical — bot cannot work without this) ─────
  const claudePath = which('claude')
  if (!claudePath) {
    p.cancel(
      'Claude CLI is required but was not found.\n' +
        'Install it first, then re-run setup:\n\n' +
        '  npm install -g @anthropic-ai/claude-code\n\n' +
        'For other install methods see: https://docs.anthropic.com/en/docs/claude-code',
    )
    process.exit(1)
  }
  p.log.success('Claude CLI found')

  // Auth (critical — bot uses your Claude subscription, not API)
  const authenticated = run('claude auth status').ok
  if (!authenticated) {
    p.cancel(
      'Claude is not logged in.\n' +
        'Run claude in your terminal and follow the login instructions:\n\n' +
        '  claude\n\n' +
        'Once logged in, re-run: npx @c4t4/heyamigo setup',
    )
    process.exit(1)
  }
  p.log.success('Claude authenticated')

  {

    // Tool permissions — write .claude/settings.json in project root.
    p.log.info(
      'Claude needs tool permissions to browse the web, read files, and control the browser. ' +
        'This writes a .claude/settings.json file in the project directory.',
    )
    const grantPermissions = await p.confirm({
      message: 'Grant tool permissions? (WebFetch, WebSearch, Read, Edit, Write, browser)',
      initialValue: true,
    })

    if (p.isCancel(grantPermissions) || !grantPermissions) {
      p.log.info('Skipped. Create .claude/settings.json manually if needed.')
    } else {
    const claudeSettingsDir = resolve(cwd, '.claude')
    const claudeSettingsPath = resolve(claudeSettingsDir, 'settings.json')
    try {
      mkdirSync(claudeSettingsDir, { recursive: true })
      let settings: Record<string, unknown> = {}
      if (existsSync(claudeSettingsPath)) {
        settings = JSON.parse(readFileSync(claudeSettingsPath, 'utf-8'))
      }
      const permissions = (settings.permissions ?? {}) as Record<
        string,
        unknown
      >
      const existing = Array.isArray(permissions.allow)
        ? (permissions.allow as string[])
        : []
      const required = [
        'WebFetch',
        'WebSearch',
        'Read',
        'Edit',
        'Write',
        'mcp__playwright__*',
      ]
      const merged = [...new Set([...existing, ...required])]
      permissions.allow = merged
      settings.permissions = permissions
      writeFileSync(
        claudeSettingsPath,
        JSON.stringify(settings, null, 2) + '\n',
        'utf-8',
      )
      p.log.success('Tool permissions configured')
    } catch (err) {
      p.log.warning(
        `Could not write ${claudeSettingsPath}: ${(err as Error).message}`,
      )
      p.log.info(
        'Create .claude/settings.json manually with permissions.allow array',
      )
    }

    // Trust project directory in ~/.claude.json
    const claudeConfigPath = resolve(
      homedir(),
      '.claude.json',
    )
    try {
      if (existsSync(claudeConfigPath)) {
        const claudeCfg = JSON.parse(
          readFileSync(claudeConfigPath, 'utf-8'),
        ) as Record<string, unknown>
        const projects = (claudeCfg.projects ?? {}) as Record<
          string,
          Record<string, unknown>
        >
        if (!projects[cwd]) projects[cwd] = {}
        projects[cwd]!.hasTrustDialogAccepted = true
        claudeCfg.projects = projects
        writeFileSync(
          claudeConfigPath,
          JSON.stringify(claudeCfg, null, 2) + '\n',
          'utf-8',
        )
        p.log.success('Project directory trusted')
      }
    } catch {
      // Non-critical, trust prompt will appear on first run
    }
    } // end grant permissions
  } // end claude cli block

  // ── Shared browser (optional) ──────────────────────────────────
  p.log.info(
    'Claude can control a real Chrome browser to browse websites, ' +
      'fill forms, take screenshots, and interact with web apps. ' +
      'Everything runs on localhost only, nothing is exposed publicly. ' +
      'You can connect to watch the browser via a secure SSH tunnel.',
  )

  const wantBrowser = await p.confirm({
    message: 'Enable browser control for Claude?',
    initialValue: false,
  })

  if (!p.isCancel(wantBrowser) && wantBrowser) {
    const isLinux = process.platform === 'linux'
    if (!isLinux) {
      p.log.warning(
        'Automated browser setup is available on Linux only. ' +
          'On macOS/Windows: start Chrome with --remote-debugging-port=9222 manually, ' +
          'then run: claude mcp add playwright -- npx @playwright/mcp@latest --cdp-endpoint "http://localhost:9222"',
      )
    } else {
      // ── Check if already running ─────────────────────────────
      const cdpUrl = 'http://localhost:9222'
      const alreadyRunning = run(`curl -s '${cdpUrl}/json/version'`)
      const mcpConfigured = run('claude mcp list 2>/dev/null').output.includes('playwright')

      if (alreadyRunning.ok && alreadyRunning.output.includes('Browser') && mcpConfigured) {
        p.log.success('Chrome already running (localhost:9222)')
        p.log.success('Claude already connected to Chrome')
        p.log.info(
          'View browser (SSH tunnel):\n' +
            `  ssh -L 6090:127.0.0.1:6090 ${process.env.USER || 'root'}@<server-ip>\n` +
            '  Then open: http://localhost:6090/vnc.html',
        )
      } else {
      // ── Chrome ───────────────────────────────────────────────
      let chromeFound = false
      for (const bin of [
        'chromium',
        'chromium-browser',
        'google-chrome',
        'google-chrome-stable',
      ]) {
        if (run(`which ${bin}`).ok) {
          p.log.success(`Chrome found: ${bin}`)
          chromeFound = true
          break
        }
      }

      if (!chromeFound) {
        const installChrome = await p.confirm({
          message:
            'Chrome/Chromium not found. Install Chromium? (apt install chromium)',
          initialValue: true,
        })

        if (!p.isCancel(installChrome) && installChrome) {
          p.log.step('Installing Chromium...')
          if (runLive('apt-get update && apt-get install -y chromium')) {
            p.log.success('Chromium installed')
            chromeFound = true
          } else {
            p.log.warning('Chromium install failed. Run manually: apt install -y chromium')
          }
        }
      }

      // ── VNC (optional, for human viewing) ────────────────────
      let vncInstalled = false
      if (chromeFound) {
        p.log.info(
          'noVNC lets you watch and interact with the browser Claude is controlling. ' +
            'It runs on localhost:6090 only, accessible via SSH tunnel. Nothing public.',
        )

        const wantVnc = await p.confirm({
          message: 'Install noVNC? (lets you view the browser via SSH tunnel)',
          initialValue: true,
        })

        if (!p.isCancel(wantVnc) && wantVnc) {
          const vncDeps = ['xvfb', 'x11vnc', 'novnc']
          const missing = vncDeps.filter(
            (d) => !run(`dpkg -s ${d} 2>/dev/null`).ok,
          )

          if (missing.length > 0) {
            p.log.step(`Installing ${missing.join(', ')}...`)
            if (runLive(`apt-get install -y ${missing.join(' ')}`)) {
              p.log.success('noVNC dependencies installed')
              vncInstalled = true
            } else {
              p.log.warning(
                `Some packages failed. Run manually: apt install -y ${missing.join(' ')}`,
              )
            }
          } else {
            p.log.success('noVNC dependencies already installed')
            vncInstalled = true
          }
        }
      }

      // ── Start browser ────────────────────────────────────────
      if (chromeFound) {
        p.log.step('Starting Chrome' + (vncInstalled ? ' + noVNC' : '') + '...')
        const scriptPath = resolve(cwd, 'scripts/start-browser.sh')
        if (!runLive(`bash "${scriptPath}"`)) {
          p.log.warning(
            'You can start manually: bash scripts/start-browser.sh',
          )
        }

        // Verify CDP
        const cdpUrl = 'http://localhost:9222'
        const cdpCheck = run(`curl -s '${cdpUrl}/json/version'`)
        if (cdpCheck.ok && cdpCheck.output.includes('Browser')) {
          p.log.success('Chrome running (localhost:9222, not public)')

          // Connect Claude to Chrome via CDP
          const sc = p.spinner()
          sc.start('Connecting Claude to Chrome')
          run('claude mcp remove playwright')
          const addResult = run(
            `claude mcp add playwright -- npx @playwright/mcp@latest --cdp-endpoint "${cdpUrl}"`,
          )
          if (
            addResult.ok ||
            addResult.output.includes('already exists')
          ) {
            sc.stop('Claude connected to Chrome')
          } else {
            sc.stop('Connection failed')
            p.log.warning(
              'Run manually: claude mcp add playwright -- npx @playwright/mcp@latest --cdp-endpoint "http://localhost:9222"',
            )
          }

          if (vncInstalled) {
            p.log.info(
              'Watch the browser (localhost only, via SSH tunnel):\n' +
                `  ssh -L 6090:127.0.0.1:6090 ${process.env.USER || 'root'}@<server-ip>\n` +
                '  Then open: http://localhost:6090/vnc.html',
            )
          }
        } else {
          p.log.warning(
            'Chrome not reachable. Start manually: bash scripts/start-browser.sh',
          )
        }
      } // end else (not already running)
      }
    }
  }

  // ── Storage ──────────────────────────────────────────────────
  run('mkdir -p storage/auth storage/messages storage/queue storage/prompts storage/media storage/outbox')
  run('mkdir -p storage/memory/buckets storage/memory/persons storage/memory/chats')
  p.log.success('Storage directories ready')

  // ── Import existing knowledge ────────────────────────────────
  // ── WhatsApp pairing ──────────────────────────────────────────
  const credsPath = resolve(cwd, 'storage/auth/creds.json')

  let shouldPair = false
  if (existsSync(credsPath)) {
    const repairChoice = await p.select({
      message: 'Found existing WhatsApp auth data. What would you like to do?',
      options: [
        { value: 'skip', label: 'Use existing auth', hint: 'if the bot was working before' },
        { value: 'repaid', label: 'Fresh pairing (new QR scan)', hint: 'if auth is stale or from another machine' },
      ],
      initialValue: 'skip',
    })
    if (!p.isCancel(repairChoice) && repairChoice === 'repaid') {
      run(`rm -rf "${resolve(cwd, 'storage/auth')}"/*`)
      shouldPair = true
    } else {
      p.log.success('WhatsApp already paired')
    }
  } else {
    shouldPair = true
  }

  if (shouldPair) {
    p.log.step(
      'Time to connect your WhatsApp. A QR code and pairing code will appear. ' +
        'Use either one to link your device.',
    )

    const readyToPair = await p.confirm({
      message: 'Ready to pair WhatsApp?',
      initialValue: true,
    })

    if (!p.isCancel(readyToPair) && readyToPair) {
      mkdirSync(resolve(cwd, 'storage/auth'), { recursive: true })

      const { default: makeWASocket, useMultiFileAuthState, fetchLatestWaWebVersion, Browsers } =
        await import('baileys')
      const QRCode = await import('qrcode')
      const pino = await import('pino')
      // Silence Baileys logs during wizard — we control what the user sees
      const silentLogger = pino.default({ level: 'silent' })

      // ownerNum already set from config earlier

      const authDir = resolve(cwd, 'storage/auth')
      const { version } = await fetchLatestWaWebVersion({})
      let pairingCodeShown = false

      let pairedNumber = ''

      const pair = async (): Promise<boolean> => {
        for (let attempt = 1; attempt <= 5; attempt++) {
          const { state, saveCreds } =
            await useMultiFileAuthState(authDir)
          const sock = makeWASocket({
            auth: state,
            version,
            browser: Browsers.macOS('WhatsApp Bot'),
            logger: silentLogger as never,
          })
          sock.ev.on('creds.update', saveCreds)

          const result = await new Promise<'open' | 'retry'>(
            (done) => {
              const timeout = setTimeout(() => {
                sock.end(undefined)
                done('retry')
              }, 30000)

              sock.ev.on('connection.update', async (update) => {
                const { connection, qr } = update

                if (qr) {
                  const ascii = await QRCode.toString(qr, {
                    type: 'utf8',
                    margin: 2,
                  })
                  console.log('')
                  console.log(ascii)

                  if (!pairingCodeShown && ownerNum) {
                    pairingCodeShown = true
                    try {
                      const code =
                        await sock.requestPairingCode(ownerNum)
                      console.log(
                        `  Or enter pairing code: ${code}`,
                      )
                      console.log(
                        '  WhatsApp > Linked Devices > Link with phone number\n',
                      )
                    } catch {}
                  }
                }

                if (connection === 'open') {
                  clearTimeout(timeout)
                  // Extract number from connected account
                  const userId = sock.user?.id ?? ''
                  const num = userId.split(':')[0]?.split('@')[0]
                  if (num) pairedNumber = num
                  setTimeout(() => {
                    sock.end(undefined)
                    done('open')
                  }, 5000)
                }

                if (connection === 'close') {
                  clearTimeout(timeout)
                  sock.end(undefined)
                  done('retry')
                }
              })
            },
          )

          if (result === 'open') return true

          await new Promise((r) => setTimeout(r, 2000))
        }
        return false
      }

      let success = false
      for (let pairAttempt = 1; pairAttempt <= 3; pairAttempt++) {
        const sp = p.spinner()
        sp.start('Waiting for WhatsApp pairing...')
        success = await pair()

        if (success) {
          sp.stop('WhatsApp paired successfully')
          break
        }

        if (existsSync(credsPath)) {
          sp.stop('WhatsApp credentials saved. Connection will complete on start.')
          success = true
          break
        }

        sp.stop(`Pairing attempt ${pairAttempt}/3 failed`)

        if (pairAttempt < 3) {
          const retry = await p.confirm({
            message: 'Try pairing again?',
            initialValue: true,
          })
          if (p.isCancel(retry) || !retry) break
          pairingCodeShown = false // allow showing pairing code again
        }
      }

      if (!success && !existsSync(credsPath)) {
        p.cancel(
          'WhatsApp pairing is required. Re-run: npx @c4t4/heyamigo setup',
        )
        process.exit(1)
      }

      // Auto-set owner number from paired account
      if (pairedNumber) {
        setConfigOwnerNumber(configPath, pairedNumber)
        ownerNum = pairedNumber
        p.log.success(`Owner number set: ${pairedNumber} (from WhatsApp)`)
      }
    } else {
      p.log.info('Skipped. Pair later: npx @c4t4/heyamigo setup')
    }
  }

  // ── Name your amigo ───────────────────────────────────────────
  p.log.info(
    'Give your amigo a name. People mention this name in a message to get a reply. ' +
      'You can add multiple names separated by commas.',
  )

  const nameInput = await p.text({
    message: 'What should your amigo be called?',
    placeholder: 'amigo',
    initialValue: 'amigo',
  })

  if (!p.isCancel(nameInput)) {
    const names = (nameInput as string)
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
    if (names.length > 0) {
      // Always include "heyamigo" as a hidden alias
      const aliases = [...new Set([...names, 'heyamigo'])]
      const cfgPath = resolve(cwd, 'config/config.json')
      if (existsSync(cfgPath)) {
        let cfg = readFileSync(cfgPath, 'utf-8')
        cfg = cfg.replace(
          /"aliases":\s*\[.*?\]/,
          `"aliases": ${JSON.stringify(aliases)}`,
        )
        writeFileSync(cfgPath, cfg)
        p.log.success(`Your amigo responds to: ${names.join(', ')}`)
      }
    }
  }

  // ── Access rules onboarding ───────────────────────────────────
  p.log.info(
    'How groups work:\n\n' +
      '  1. Send a message in any WhatsApp group where the bot is.\n' +
      '     The bot auto-discovers the group and adds it to config/access.json.\n\n' +
      '  2. New groups start with mode: "off" (bot stays silent).\n' +
      '     To activate: edit config/access.json, change mode to "active".\n\n' +
      '  3. Set allowedSenders to "*" (everyone) or specific numbers.\n\n' +
      '  4. Once active, mention the bot\'s name in a message to get a reply.\n\n' +
      'DMs work the same way — add numbers to dms.allowed in access.json.',
  )

  // Auto-add owner as admin if we have the number
  if (ownerNum) {
    const accessCfgPath = resolve(cwd, 'config/access.json')
    try {
      const access = JSON.parse(readFileSync(accessCfgPath, 'utf-8'))
      const users = access.users ?? {}
      if (!users[ownerNum]) {
        users[ownerNum] = { role: 'admin', name: 'Owner' }
        access.users = users
        writeFileSync(
          accessCfgPath,
          JSON.stringify(access, null, 2) + '\n',
          'utf-8',
        )
        p.log.success(`Added ${ownerNum} as admin in access.json`)
      } else {
        p.log.info(`${ownerNum} already configured as ${users[ownerNum].role}`)
      }
    } catch {}
  }

  // ── Claude model ─────────────────────────────────────────────
  const model = await p.select({
    message: 'Choose a Claude model',
    options: [
      {
        value: 'claude-opus-4-7',
        label: 'Opus',
        hint: 'highest quality, recommended (default)',
      },
      {
        value: 'claude-sonnet-4-6',
        label: 'Sonnet',
        hint: 'faster, lower cost',
      },
    ],
    initialValue: 'claude-opus-4-7',
  })

  if (!p.isCancel(model)) {
    const configPath = resolve(cwd, 'config/config.json')
    if (existsSync(configPath)) {
      let cfg = readFileSync(configPath, 'utf-8')
      cfg = cfg.replace(
        /"model":\s*"[^"]*"/,
        `"model": "${model}"`,
      )
      writeFileSync(configPath, cfg)
      const label =
        model === 'claude-sonnet-4-6'
          ? 'Sonnet'
          : model === 'claude-opus-4-7'
            ? 'Opus'
            : 'Haiku'
      p.log.success(`Model: ${label}`)
    }
  }

  // ── Personality ──────────────────────────────────────────────
  const personalities = ['sharp', 'casual', 'professional']
  const personality = await p.select({
    message: 'Choose a personality',
    options: personalities.map((name) => ({
      value: name,
      label: name.charAt(0).toUpperCase() + name.slice(1),
      hint:
        name === 'sharp'
          ? 'direct, specific, no marketing-speak (default)'
          : name === 'casual'
            ? 'warm, relaxed, friend-over-coffee'
            : 'clear, efficient, business-appropriate',
    })),
    initialValue: 'sharp',
  })

  if (!p.isCancel(personality)) {
    const configPath = resolve(cwd, 'config/config.json')
    if (existsSync(configPath)) {
      let cfg = readFileSync(configPath, 'utf-8')
      cfg = cfg.replace(
        /"personalityFile":\s*"[^"]*"/,
        `"personalityFile": "./config/personalities/${personality}.md"`,
      )
      writeFileSync(configPath, cfg)
      p.log.success(`Personality: ${personality}`)
    }
  }

  // ── Done ─────────────────────────────────────────────────────
  p.note(
    [
      'Start the bot:',
      '  npx @c4t4/heyamigo start',
      '',
      'Check logs:',
      '  npx @c4t4/heyamigo logs',
      '',
      'Import existing knowledge:',
      '  npx @c4t4/heyamigo import /path/to/folder',
      '',
      'Update to latest version:',
      '  npx @c4t4/heyamigo update',
      '',
      'Other commands:',
      '  npx @c4t4/heyamigo stop / restart / status',
      '',
      'Configuration:',
      '  config/config.json   — triggers, model',
      '  config/access.json   — groups, DMs, roles',
    ].join('\n'),
    'Setup complete!',
  )

  p.log.warning(
    'IMPORTANT: The bot won\'t respond until you activate a group!\n\n' +
      '  Step 1 — Start the bot:\n' +
      '    npx @c4t4/heyamigo start\n\n' +
      '  Step 2 — Send a message in any WhatsApp group.\n' +
      '    The bot discovers the group and adds it to config/access.json.\n\n' +
      '  Step 3 — Open config/access.json and edit:\n' +
      '    nano config/access.json\n' +
      '    - Find the group, change mode from "off" to "active"\n' +
      '    - Set allowedSenders to "*" for everyone\n\n' +
      '  Step 4 — Restart the bot:\n' +
      '    npx @c4t4/heyamigo restart\n\n' +
      '  Step 5 — Mention the bot\'s name in the group to get a reply.\n\n' +
      '  Debugging:\n' +
      '    npx @c4t4/heyamigo logs',
  )

  p.log.info(
    'TIP: Track your bot\'s memory with git.\n' +
      'The bot updates files in storage/memory/ over time. Use git to track changes and roll back if needed.\n\n' +
      '  cd ' + cwd + '\n' +
      '  git init\n' +
      '  echo "storage/auth/" >> .gitignore\n' +
      '  echo "storage/logs/" >> .gitignore\n' +
      '  git add -A && git commit -m "initial setup"',
  )

  p.outro('Happy chatting!')
}
