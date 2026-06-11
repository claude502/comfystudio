const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawn } = require('child_process')

const DEFAULT_TIMEOUT_MS = 4500
const DEFAULT_COMFY_ENDPOINT = 'http://127.0.0.1:8188'

const TOOL_DEFINITIONS = Object.freeze([
  {
    id: 'ffmpeg',
    displayName: 'FFmpeg',
    role: 'Local assembly and export',
    installFolder: 'FFmpeg',
    commandNames: ['ffmpeg'],
    explicitPathKey: 'ffmpegPath',
    checks: [{ args: ['-version'], versionRegex: /ffmpeg version\s+([^\s]+)/i }],
    required: true,
  },
  {
    id: 'comfyui',
    displayName: 'ComfyUI',
    role: 'Local image and video generation',
    installFolder: 'ComfyUI',
    commandNames: ['comfyui'],
    checks: [{ args: ['--version'], versionRegex: /(?:ComfyUI(?:\s+CLI)?|comfyui)\s+([^\s]+)/i }],
    service: true,
    required: false,
  },
  {
    id: 'hyperframes',
    displayName: 'HyperFrames',
    role: 'HTML/CSS motion renderer',
    installFolder: 'HyperFrames',
    commandNames: ['hyperframes'],
    checks: [
      { args: ['--version'], versionRegex: /(?:hyperframes)\s+([^\s]+)/i },
      { args: ['--help'] },
    ],
    required: false,
  },
  {
    id: 'vibeframe',
    displayName: 'VibeFrame',
    role: 'VibeFrame command adapter',
    installFolder: 'vibeframe-video',
    commandNames: ['vibeframe', 'vibe'],
    checks: [
      { args: ['--version'], versionRegex: /(?:vibeframe|vibe)\s+([^\s]+)/i },
      { args: ['doctor', '--json'], versionJsonPath: ['version'] },
    ],
    required: false,
  },
  {
    id: 'openmontage',
    displayName: 'OpenMontage',
    role: 'OpenMontage helper and command adapter',
    installFolder: 'OpenMontage',
    commandNames: ['openmontage'],
    checks: [
      { args: ['preflight'], versionRegex: /(?:OpenMontage)\s+([^\s]+)/i },
      { args: ['help'] },
    ],
    required: false,
  },
])

function expandHome(filePath, homeDir) {
  const text = String(filePath || '').trim()
  if (!text) return ''
  if (text === '~') return homeDir
  if (text.startsWith(`~${path.sep}`)) return path.join(homeDir, text.slice(2))
  return text
}

function getInstallDir(definition, options) {
  const homeDir = options.homeDir || os.homedir()
  if (definition.id === 'comfyui' && options.comfyRootPath) {
    return path.resolve(expandHome(options.comfyRootPath, homeDir))
  }
  return path.join(homeDir, '.local', 'aivideo-tools', definition.installFolder)
}

async function defaultPathExists(candidate) {
  if (!candidate) return false
  try {
    await fs.promises.stat(candidate)
    return true
  } catch (_) {
    return false
  }
}

async function defaultIsExecutable(candidate) {
  if (!candidate) return false
  try {
    await fs.promises.access(candidate, fs.constants.X_OK)
    return true
  } catch (_) {
    return false
  }
}

function unique(items) {
  return [...new Set(items.filter(Boolean))]
}

function executableName(commandName) {
  if (process.platform === 'win32' && !/\.(exe|cmd|bat)$/i.test(commandName)) {
    return `${commandName}.exe`
  }
  return commandName
}

function buildExecutableCandidates(definition, options) {
  const homeDir = options.homeDir || os.homedir()
  const pathEnv = options.pathEnv === undefined ? process.env.PATH : String(options.pathEnv || '')
  const candidates = []

  if (definition.explicitPathKey && options[definition.explicitPathKey]) {
    candidates.push(path.resolve(expandHome(options[definition.explicitPathKey], homeDir)))
  }

  for (const commandName of definition.commandNames || []) {
    candidates.push(path.join(homeDir, '.local', 'bin', executableName(commandName)))
  }

  const pathEntries = pathEnv.split(path.delimiter).filter(Boolean)
  for (const dir of pathEntries) {
    for (const commandName of definition.commandNames || []) {
      candidates.push(path.join(dir, executableName(commandName)))
    }
  }

  return unique(candidates)
}

async function findExecutable(definition, options, deps) {
  for (const candidate of buildExecutableCandidates(definition, options)) {
    if (await deps.isExecutable(candidate)) return candidate
  }
  return ''
}

function parseVersionFromText(text, regex) {
  if (!text) return ''
  if (regex) {
    const match = String(text).match(regex)
    if (match?.[1]) return match[1].trim()
  }
  const line = String(text).split(/\r?\n/).map((entry) => entry.trim()).find(Boolean) || ''
  const generic = line.match(/\b(v?\d+(?:\.\d+){0,3}(?:[-+][\w.-]+)?)\b/)
  return generic?.[1]?.replace(/^v/i, '') || ''
}

function parseVersionFromJson(text, jsonPath = []) {
  try {
    let value = JSON.parse(String(text || '{}'))
    for (const key of jsonPath) value = value?.[key]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  } catch (_) {
    return ''
  }
}

function runCommand(command, args, options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS)
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd || undefined,
      env: options.env || process.env,
      windowsHide: true,
    })
    let settled = false
    const stdout = []
    const stderr = []
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill('SIGTERM')
      } catch (_) {
        // Best effort timeout cleanup.
      }
      resolve({ ok: false, code: null, signal: 'SIGTERM', stdout: stdout.join(''), stderr: stderr.join(''), error: 'timeout' })
    }, timeoutMs)

    child.stdout.on('data', (chunk) => stdout.push(String(chunk)))
    child.stderr.on('data', (chunk) => stderr.push(String(chunk)))
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, code: null, signal: null, stdout: stdout.join(''), stderr: stderr.join(''), error: error?.message || String(error) })
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: code === 0, code, signal, stdout: stdout.join(''), stderr: stderr.join(''), error: '' })
    })
  })
}

async function probeHttp(endpoint, options = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS))
  try {
    const response = await fetch(`${String(endpoint).replace(/\/$/, '')}/system_stats`, { signal: controller.signal })
    return {
      ok: response.ok,
      endpoint,
      status: response.status,
      statusText: response.statusText,
      error: response.ok ? '' : `HTTP ${response.status}`,
    }
  } catch (error) {
    return {
      ok: false,
      endpoint,
      status: 0,
      statusText: '',
      error: error?.name === 'AbortError' ? 'timeout' : error?.message || String(error),
    }
  } finally {
    clearTimeout(timeout)
  }
}

async function runToolChecks(definition, executablePath, options, deps) {
  if (!executablePath) {
    return { ok: false, version: '', check: null, error: 'Command not found.' }
  }

  let lastResult = null
  for (const check of definition.checks || []) {
    const result = await deps.runCommand(executablePath, check.args || [], {
      timeoutMs: options.timeoutMs || definition.timeoutMs || DEFAULT_TIMEOUT_MS,
      env: options.env || process.env,
    })
    lastResult = { check, result }
    if (!result.ok) continue

    const combined = `${result.stdout || ''}\n${result.stderr || ''}`
    const version = check.versionJsonPath
      ? parseVersionFromJson(combined, check.versionJsonPath)
      : parseVersionFromText(combined, check.versionRegex)
    return {
      ok: true,
      version,
      check: { args: check.args || [], code: result.code },
      error: '',
    }
  }

  const result = lastResult?.result
  const detail = result?.error || result?.stderr?.trim() || result?.stdout?.trim() || 'Health check failed.'
  return {
    ok: false,
    version: '',
    check: lastResult ? { args: lastResult.check.args || [], code: result?.code ?? null, signal: result?.signal || null } : null,
    error: detail,
  }
}

function summarizeTools(tools) {
  return tools.reduce((summary, tool) => {
    summary[tool.status] = (summary[tool.status] || 0) + 1
    return summary
  }, { ready: 0, missing: 0, misconfigured: 0 })
}

async function inspectCommandTool(definition, options, deps) {
  const installDir = getInstallDir(definition, options)
  const installDirExists = await deps.pathExists(installDir)
  const executablePath = await findExecutable(definition, options, deps)
  const health = await runToolChecks(definition, executablePath, options, deps)

  if (!executablePath) {
    return {
      id: definition.id,
      displayName: definition.displayName,
      role: definition.role,
      required: definition.required,
      status: 'missing',
      message: `Command not found. Expected ${definition.commandNames.join(' or ')} in ~/.local/bin or PATH.`,
      installDir,
      installDirExists,
      executablePath: '',
      version: '',
      updateStatus: 'manual',
      health,
      logs: [],
    }
  }

  const status = health.ok ? 'ready' : 'misconfigured'
  return {
    id: definition.id,
    displayName: definition.displayName,
    role: definition.role,
    required: definition.required,
    status,
    message: health.ok ? 'Ready.' : `Installed but the health check failed: ${health.error}`,
    installDir,
    installDirExists,
    executablePath,
    version: health.version,
    updateStatus: 'manual',
    health,
    logs: [],
  }
}

async function inspectComfyTool(definition, options, deps) {
  const installDir = getInstallDir(definition, options)
  const installDirExists = await deps.pathExists(installDir)
  const executablePath = await findExecutable(definition, options, deps)
  const endpoint = String(options.comfyEndpoint || DEFAULT_COMFY_ENDPOINT).replace(/\/$/, '')
  const service = await deps.probeHttp(endpoint, { timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS })
  const health = executablePath
    ? await runToolChecks(definition, executablePath, options, deps)
    : { ok: false, version: '', check: null, error: 'Command not found.' }
  const installed = installDirExists || Boolean(executablePath)
  const logs = []
  const logFilePath = options.comfyLauncherState?.logFilePath || options.comfyLauncherLogPath || ''
  if (logFilePath) logs.push({ label: 'Launcher log', path: logFilePath })

  if (service.ok) {
    return {
      id: definition.id,
      displayName: definition.displayName,
      role: definition.role,
      required: definition.required,
      status: 'ready',
      message: `Service is responding at ${service.endpoint || endpoint}.`,
      installDir,
      installDirExists,
      executablePath,
      version: health.version,
      endpoint: service.endpoint || endpoint,
      updateStatus: 'manual',
      health: { ...health, service },
      logs,
    }
  }

  if (installed) {
    return {
      id: definition.id,
      displayName: definition.displayName,
      role: definition.role,
      required: definition.required,
      status: 'misconfigured',
      message: `ComfyUI is installed but the local service is not responding at ${endpoint}.`,
      installDir,
      installDirExists,
      executablePath,
      version: health.version,
      endpoint,
      updateStatus: 'manual',
      health: { ...health, service },
      logs,
    }
  }

  return {
    id: definition.id,
    displayName: definition.displayName,
    role: definition.role,
    required: definition.required,
    status: 'missing',
    message: 'ComfyUI was not found in ~/.local/aivideo-tools/ComfyUI or PATH.',
    installDir,
    installDirExists,
    executablePath,
    version: '',
    endpoint,
    updateStatus: 'manual',
    health: { ...health, service },
    logs,
  }
}

async function getAivideoToolRegistry(options = {}) {
  const deps = {
    pathExists: options.pathExists || defaultPathExists,
    isExecutable: options.isExecutable || defaultIsExecutable,
    runCommand: options.runCommand || runCommand,
    probeHttp: options.probeHttp || probeHttp,
  }

  const tools = await Promise.all(TOOL_DEFINITIONS.map((definition) => {
    if (definition.service) return inspectComfyTool(definition, options, deps)
    return inspectCommandTool(definition, options, deps)
  }))

  return {
    success: true,
    generatedAt: new Date().toISOString(),
    baseDir: path.join(options.homeDir || os.homedir(), '.local', 'aivideo-tools'),
    tools,
    summary: summarizeTools(tools),
  }
}

module.exports = {
  TOOL_DEFINITIONS,
  getAivideoToolRegistry,
  probeHttp,
  runCommand,
}
