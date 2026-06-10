const fs = require('fs').promises
const fsSync = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const MAX_LOG_LINES = 800

function createDefaultCoreDir() {
  return process.env.AIVIDEO_CORE_DIR || path.join(os.homedir(), 'Desktop', 'aivdeio')
}

function nowIso() {
  return new Date().toISOString()
}

function isAbsolutePath(filePath) {
  return path.isAbsolute(filePath) || /^[A-Za-z]:[\\/]/.test(String(filePath || ''))
}

function normalizeRequiredPath(value, label) {
  const text = String(value || '').trim()
  if (!text) {
    throw new Error(`${label} is required.`)
  }
  return text
}

function resolveNodeCommand(explicitNodePath) {
  const candidates = [
    explicitNodePath,
    process.env.AIVIDEO_NODE_PATH,
    path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'node.exe' : 'node'),
    'node',
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (candidate === 'node' || fsSync.existsSync(candidate)) {
      return candidate
    }
  }

  return 'node'
}

function buildEnv() {
  const localBin = path.join(os.homedir(), '.local', 'bin')
  const currentPath = process.env.PATH || ''
  const pathEntries = currentPath.split(path.delimiter).filter(Boolean)
  if (!pathEntries.includes(localBin)) {
    pathEntries.unshift(localBin)
  }

  return {
    ...process.env,
    PATH: pathEntries.join(path.delimiter),
  }
}

function appendLines(target, chunk) {
  const lines = String(chunk || '')
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
  target.push(...lines)
  if (target.length > MAX_LOG_LINES) {
    target.splice(0, target.length - MAX_LOG_LINES)
  }
  return lines
}

function parseCliResult(stdoutLines) {
  const text = stdoutLines.join('\n')
  const start = text.lastIndexOf('\n{')
  const candidate = (start >= 0 ? text.slice(start + 1) : text).trim()
  if (!candidate.startsWith('{')) return null
  try {
    const parsed = JSON.parse(candidate)
    if (typeof parsed?.output === 'string') {
      return parsed
    }
  } catch (_) {
    return null
  }
  return null
}

async function defaultEventLogPath(projectFile) {
  const projectDir = path.dirname(projectFile)
  const logsDir = path.join(projectDir, 'logs')
  await fs.mkdir(logsDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return path.join(logsDir, `aivideo-${stamp}.jsonl`)
}

async function readJsonl(filePath) {
  const text = await fs.readFile(filePath, 'utf8')
  const lines = text.split(/\r?\n/)
  const events = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line) continue
    try {
      events.push(JSON.parse(line))
    } catch (error) {
      const isLastNonEmpty = lines.slice(index + 1).every((nextLine) => nextLine.trim() === '')
      if (isLastNonEmpty) break
      throw error
    }
  }
  return events
}

class AIVideoRunner {
  constructor({ onEvent } = {}) {
    this.onEvent = typeof onEvent === 'function' ? onEvent : () => {}
    this.child = null
    this.cancelRequested = false
    this.state = this.createIdleState()
  }

  createIdleState(overrides = {}) {
    return {
      status: 'idle',
      coreDir: createDefaultCoreDir(),
      projectFile: '',
      eventLogPath: '',
      commandLine: '',
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      signal: null,
      error: null,
      result: null,
      stdout: [],
      stderr: [],
      lastEventAt: null,
      ...overrides,
    }
  }

  getState() {
    return {
      ...this.state,
      stdout: [...this.state.stdout],
      stderr: [...this.state.stderr],
      result: this.state.result ? { ...this.state.result } : null,
    }
  }

  emit(type, extra = {}) {
    this.state.lastEventAt = nowIso()
    this.onEvent({
      type,
      ...extra,
      state: this.getState(),
    })
  }

  async start(payload = {}) {
    if (this.child) {
      return { success: false, error: 'AIVideo is already running.', state: this.getState() }
    }

    let coreDir
    let projectFile
    try {
      coreDir = normalizeRequiredPath(payload.coreDir || createDefaultCoreDir(), 'AIVideo core directory')
      projectFile = normalizeRequiredPath(payload.projectFile, 'AIVideo project file')
    } catch (error) {
      return { success: false, error: error.message, state: this.getState() }
    }

    const scriptPath = path.join(coreDir, 'dist', 'cli.js')
    if (!fsSync.existsSync(scriptPath)) {
      return {
        success: false,
        error: `Missing built CLI at ${scriptPath}. Run npm run build in the AIVideo core first.`,
        state: this.getState(),
      }
    }

    if (!fsSync.existsSync(projectFile)) {
      return { success: false, error: `Project file does not exist: ${projectFile}`, state: this.getState() }
    }

    const eventLogPath = payload.eventLogPath
      ? (isAbsolutePath(payload.eventLogPath) ? payload.eventLogPath : path.join(path.dirname(projectFile), payload.eventLogPath))
      : await defaultEventLogPath(projectFile)
    await fs.mkdir(path.dirname(eventLogPath), { recursive: true })

    const nodeCommand = resolveNodeCommand(payload.nodePath)
    const args = [scriptPath, 'run', projectFile, '--event-log', eventLogPath]
    const commandLine = `${nodeCommand} ${args.map((arg) => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(' ')}`

    this.cancelRequested = false
    this.state = this.createIdleState({
      status: 'running',
      coreDir,
      projectFile,
      eventLogPath,
      commandLine,
      startedAt: nowIso(),
    })
    this.emit('state')

    try {
      this.child = spawn(nodeCommand, args, {
        cwd: coreDir,
        env: buildEnv(),
        windowsHide: true,
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      this.child = null
      this.state.status = 'failed'
      this.state.error = error.message
      this.state.finishedAt = nowIso()
      this.emit('error', { error: error.message })
      return { success: false, error: error.message, state: this.getState() }
    }

    this.child.stdout.on('data', (chunk) => {
      const lines = appendLines(this.state.stdout, chunk)
      this.state.result = parseCliResult(this.state.stdout) || this.state.result
      this.emit('stdout', { lines })
    })

    this.child.stderr.on('data', (chunk) => {
      const lines = appendLines(this.state.stderr, chunk)
      this.emit('stderr', { lines })
    })

    this.child.on('error', (error) => {
      this.state.error = error.message
      this.emit('error', { error: error.message })
    })

    this.child.on('close', (code, signal) => {
      this.child = null
      this.state.exitCode = code
      this.state.signal = signal
      this.state.finishedAt = nowIso()
      this.state.result = parseCliResult(this.state.stdout) || this.state.result
      if (this.cancelRequested) {
        this.state.status = 'cancelled'
      } else if (code === 0) {
        this.state.status = 'succeeded'
      } else {
        this.state.status = 'failed'
        this.state.error = this.state.error || `AIVideo exited with code ${code ?? 'unknown'}.`
      }
      this.emit('close', { code, signal })
    })

    return { success: true, state: this.getState() }
  }

  cancel() {
    if (!this.child) {
      return { success: true, state: this.getState() }
    }

    this.cancelRequested = true
    this.state.status = 'cancelling'
    this.emit('state')

    try {
      if (process.platform !== 'win32' && this.child.pid) {
        process.kill(-this.child.pid, 'SIGTERM')
      } else {
        this.child.kill('SIGTERM')
      }
      setTimeout(() => {
        if (!this.child) return
        try {
          if (process.platform !== 'win32' && this.child.pid) {
            process.kill(-this.child.pid, 'SIGKILL')
          } else {
            this.child.kill('SIGKILL')
          }
        } catch (_) {
          // Process may have exited between checks.
        }
      }, 2500)
      return { success: true, state: this.getState() }
    } catch (error) {
      this.state.error = error.message
      this.emit('error', { error: error.message })
      return { success: false, error: error.message, state: this.getState() }
    }
  }

  async readEventLog(eventLogPath = this.state.eventLogPath) {
    const target = String(eventLogPath || '').trim()
    if (!target) {
      return { success: true, events: [] }
    }
    try {
      const events = await readJsonl(target)
      return { success: true, events, eventLogPath: target }
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return { success: true, events: [], eventLogPath: target }
      }
      return { success: false, error: error.message, events: [], eventLogPath: target }
    }
  }
}

module.exports = {
  AIVideoRunner,
  createDefaultCoreDir,
  resolveNodeCommand,
}
