import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  FileJson,
  FileText,
  FileVideo,
  FolderOpen,
  FolderPlus,
  Loader2,
  Play,
  RefreshCw,
  Save,
  Square,
  TerminalSquare,
  XCircle,
} from 'lucide-react'

const STAGES = ['plan', 'assets', 'tts', 'render', 'qa']
const STORAGE_KEY = 'comfystudio-aivideo-workbench'
const ARTIFACT_ROWS = [
  { key: 'storyboard', label: 'Storyboard', icon: FileJson },
  { key: 'assetManifest', label: 'Assets', icon: FileJson },
  { key: 'timeline', label: 'Timeline', icon: FileJson },
  { key: 'renderManifest', label: 'Render', icon: FileText },
  { key: 'qaReport', label: 'QA', icon: FileJson },
  { key: 'finalVideo', label: 'Final', icon: FileVideo },
]

function isRunningStatus(status) {
  return status === 'running' || status === 'cancelling'
}

function shortPath(filePath) {
  if (!filePath) return 'Not selected'
  const parts = String(filePath).split(/[\\/]/).filter(Boolean)
  if (parts.length <= 3) return filePath
  return `.../${parts.slice(-3).join('/')}`
}

function formatTime(value) {
  if (!value) return ''
  try {
    return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch (_) {
    return ''
  }
}

function formatBytes(value) {
  const bytes = Number(value) || 0
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let amount = bytes
  let index = 0
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024
    index += 1
  }
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`
}

function statusTone(status) {
  if (status === 'succeeded') return 'border-emerald-500/35 bg-emerald-500/10 text-emerald-200'
  if (status === 'failed' || status === 'cancelled') return 'border-red-500/35 bg-red-500/10 text-red-200'
  if (status === 'running' || status === 'cancelling') return 'border-sf-accent/40 bg-sf-accent/10 text-sf-accent'
  return 'border-sf-dark-600 bg-sf-dark-800 text-sf-text-muted'
}

function stageStatus(events, stage) {
  const stageEvents = events.filter((event) => event.stage === stage)
  if (stageEvents.some((event) => event.type === 'stage-error')) return 'failed'
  if (stageEvents.some((event) => event.type === 'stage-complete')) return 'succeeded'
  if (stageEvents.some((event) => event.type === 'stage-start')) return 'running'
  return 'idle'
}

function StageIcon({ status }) {
  if (status === 'succeeded') return <CheckCircle2 className="h-4 w-4 text-emerald-300" />
  if (status === 'failed') return <XCircle className="h-4 w-4 text-red-300" />
  if (status === 'running') return <Loader2 className="h-4 w-4 animate-spin text-sf-accent" />
  return <div className="h-2 w-2 rounded-full bg-sf-dark-500" />
}

function getQaIssueCount(bundle, runState) {
  const issues = bundle?.artifacts?.qaReport?.data?.issues
  if (Array.isArray(issues)) return issues.length
  if (typeof runState?.result?.qaIssues === 'number') return runState.result.qaIssues
  return null
}

function AIVideoWorkspace() {
  const [coreDir, setCoreDir] = useState('')
  const [projectDir, setProjectDir] = useState('')
  const [projectFile, setProjectFile] = useState('')
  const [project, setProject] = useState(null)
  const [bundle, setBundle] = useState(null)
  const [runState, setRunState] = useState({ status: 'idle', stdout: [], stderr: [] })
  const [events, setEvents] = useState([])
  const [finalVideoPath, setFinalVideoPath] = useState('')
  const [finalVideoUrl, setFinalVideoUrl] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const api = window.electronAPI?.aivideo
  const isRunning = isRunningStatus(runState?.status)

  const persistLocal = useCallback((updates) => {
    try {
      const previous = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...previous, ...updates }))
    } catch (_) {
      // Persistence is a convenience only.
    }
  }, [])

  const refreshPreview = useCallback(async (nextFinalVideoPath = finalVideoPath) => {
    if (!nextFinalVideoPath) {
      setFinalVideoUrl('')
      return
    }
    try {
      const exists = await window.electronAPI.pathExists(nextFinalVideoPath)
      if (!exists) {
        setFinalVideoUrl('')
        return
      }
      const url = await window.electronAPI.getFileUrlDirect(nextFinalVideoPath)
      setFinalVideoUrl(url)
    } catch (_) {
      setFinalVideoUrl('')
    }
  }, [finalVideoPath])

  const applyBundle = useCallback(async (result) => {
    if (!result?.success) {
      setError(result?.error || 'Could not load project.')
      return false
    }

    setError('')
    setBundle(result)
    setProject(result.project || null)
    setProjectDir(result.projectDir || '')
    setProjectFile(result.projectFile || result.paths?.projectFile || '')
    persistLocal({
      projectDir: result.projectDir || '',
      projectFile: result.projectFile || result.paths?.projectFile || '',
    })
    const nextFinalVideoPath = result.paths?.finalVideoPath || ''
    setFinalVideoPath(nextFinalVideoPath)
    await refreshPreview(nextFinalVideoPath)
    return true
  }, [persistLocal, refreshPreview])

  const loadBundle = useCallback(async (payload = {}) => {
    if (!api?.loadProjectBundle) return false
    const result = await api.loadProjectBundle({
      projectDir,
      projectFile,
      ...payload,
    })
    return applyBundle(result)
  }, [api, applyBundle, projectDir, projectFile])

  const refreshEvents = useCallback(async (eventLogPath = runState?.eventLogPath) => {
    if (!api || !eventLogPath) return
    const result = await api.readEventLog({ eventLogPath })
    if (result?.success) {
      setEvents(result.events || [])
    }
  }, [api, runState?.eventLogPath])

  const refreshState = useCallback(async () => {
    if (!api) return
    const result = await api.getRunState()
    if (result?.success && result.state) {
      setRunState(result.state)
      await refreshEvents(result.state.eventLogPath)
      await refreshPreview()
    }
    if (projectDir || projectFile) {
      await loadBundle()
    }
  }, [api, loadBundle, projectDir, projectFile, refreshEvents, refreshPreview])

  useEffect(() => {
    const hydrate = async () => {
      try {
        const local = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
        const defaults = await api?.getDefaults?.()
        const nextCoreDir = defaults?.coreDir || local.coreDir || ''
        const nextProjectDir = defaults?.projectDir || local.projectDir || ''
        const nextProjectFile = defaults?.projectFile || local.projectFile || ''
        setCoreDir(nextCoreDir)
        setProjectDir(nextProjectDir)
        setProjectFile(nextProjectFile)
        if (defaults?.state) setRunState(defaults.state)
        if (nextProjectDir || nextProjectFile) {
          await loadBundle({ projectDir: nextProjectDir, projectFile: nextProjectFile })
        }
        if (defaults?.state?.eventLogPath) await refreshEvents(defaults.state.eventLogPath)
      } catch (err) {
        setError(err?.message || String(err))
      }
    }
    hydrate()
  }, [api, loadBundle, refreshEvents])

  useEffect(() => {
    if (!api?.onRunnerEvent) return undefined
    return api.onRunnerEvent((event) => {
      if (event?.state) {
        setRunState(event.state)
        if (event.state.status === 'succeeded' || event.state.status === 'failed' || event.state.status === 'cancelled') {
          refreshPreview()
          loadBundle()
        }
      }
      if (event?.state?.eventLogPath) {
        refreshEvents(event.state.eventLogPath)
      }
    })
  }, [api, loadBundle, refreshEvents, refreshPreview])

  useEffect(() => {
    if (!isRunning || !runState?.eventLogPath) return undefined
    const timer = setInterval(() => {
      refreshEvents(runState.eventLogPath)
    }, 1000)
    return () => clearInterval(timer)
  }, [isRunning, refreshEvents, runState?.eventLogPath])

  const pickCoreDir = useCallback(async () => {
    const result = await api?.selectCoreDir?.()
    if (result?.success && result.coreDir) {
      setCoreDir(result.coreDir)
      persistLocal({ coreDir: result.coreDir })
    }
  }, [api, persistLocal])

  const pickProject = useCallback(async () => {
    const result = await api?.selectProjectDir?.({ defaultPath: projectDir || coreDir })
    await applyBundle(result)
  }, [api, applyBundle, coreDir, projectDir])

  const createProject = useCallback(async () => {
    setError('')
    const result = await api?.createProject?.({
      coreDir,
      defaultPath: projectDir || coreDir,
      aspectRatio: project?.aspectRatio || '16:9',
    })
    await applyBundle(result)
  }, [api, applyBundle, coreDir, project?.aspectRatio, projectDir])

  const saveProjectJson = useCallback(async () => {
    if (!project || !projectDir) return false
    setSaving(true)
    setError('')
    try {
      const result = await api?.saveProjectJson?.({ projectDir, projectFile, project })
      return await applyBundle(result)
    } finally {
      setSaving(false)
    }
  }, [api, applyBundle, project, projectDir, projectFile])

  const runProject = useCallback(async () => {
    setError('')
    if (project) {
      const saved = await saveProjectJson()
      if (!saved) return
    }
    const result = await api?.runProject?.({ coreDir, projectDir, projectFile })
    if (!result?.success) {
      setError(result?.error || 'Run failed to start.')
      if (result?.state) setRunState(result.state)
      return
    }
    setEvents([])
    if (result.state) setRunState(result.state)
  }, [api, coreDir, project, projectDir, projectFile, saveProjectJson])

  const cancelRun = useCallback(async () => {
    const result = await api?.cancelRun?.()
    if (result?.state) setRunState(result.state)
    if (!result?.success) setError(result?.error || 'Cancel failed.')
  }, [api])

  const openOutput = useCallback(async () => {
    if (!finalVideoPath) return
    await api?.openPath?.(finalVideoPath)
  }, [api, finalVideoPath])

  const updateProjectField = useCallback((field, value) => {
    setProject((current) => current ? { ...current, [field]: value } : current)
  }, [])

  const stageRows = useMemo(() => {
    return STAGES.map((stage) => ({
      stage,
      status: stageStatus(events, stage),
      latest: [...events].reverse().find((event) => event.stage === stage),
    }))
  }, [events])

  const logs = useMemo(() => {
    const stdout = (runState?.stdout || []).map((line) => ({ kind: 'out', line }))
    const stderr = (runState?.stderr || []).map((line) => ({ kind: 'err', line }))
    return [...stdout, ...stderr].slice(-160)
  }, [runState?.stderr, runState?.stdout])

  const selectedAdapters = project?.nodes || project?.adapters || {}
  const qaIssueCount = getQaIssueCount(bundle, runState)

  return (
    <div className="flex h-full min-h-0 flex-col bg-sf-dark-950 text-sf-text-primary">
      <div className="flex flex-wrap items-center gap-2 border-b border-sf-dark-700 bg-sf-dark-900 px-3 py-2">
        <div className={`rounded border px-2 py-1 text-[11px] font-medium ${statusTone(runState?.status)}`}>
          {runState?.status || 'idle'}
        </div>
        {runState?.startedAt && (
          <div className="text-[11px] text-sf-text-muted">
            {formatTime(runState.startedAt)}
            {runState.finishedAt ? ` - ${formatTime(runState.finishedAt)}` : ''}
          </div>
        )}
        <div className="min-w-0 flex-1" />
        <button
          type="button"
          onClick={createProject}
          disabled={!coreDir || isRunning}
          className="inline-flex h-8 items-center gap-1.5 rounded border border-sf-dark-600 bg-sf-dark-800 px-2 text-xs text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary disabled:cursor-not-allowed disabled:opacity-40"
          title="New AIVideo project"
        >
          <FolderPlus className="h-3.5 w-3.5" />
          New
        </button>
        <button
          type="button"
          onClick={pickCoreDir}
          className="inline-flex h-8 items-center gap-1.5 rounded border border-sf-dark-600 bg-sf-dark-800 px-2 text-xs text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary"
          title={coreDir || 'Select AIVideo core folder'}
        >
          <FolderOpen className="h-3.5 w-3.5" />
          <span className="max-w-[210px] truncate">{shortPath(coreDir)}</span>
        </button>
        <button
          type="button"
          onClick={pickProject}
          className="inline-flex h-8 items-center gap-1.5 rounded border border-sf-dark-600 bg-sf-dark-800 px-2 text-xs text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary"
          title={projectDir || 'Select AIVideo project folder'}
        >
          <FolderOpen className="h-3.5 w-3.5" />
          <span className="max-w-[240px] truncate">{shortPath(projectDir)}</span>
        </button>
        <button
          type="button"
          onClick={saveProjectJson}
          disabled={!project || saving || isRunning}
          className="inline-flex h-8 w-8 items-center justify-center rounded border border-sf-dark-600 bg-sf-dark-800 text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary disabled:cursor-not-allowed disabled:opacity-40"
          title="Save project.json"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          onClick={refreshState}
          className="inline-flex h-8 w-8 items-center justify-center rounded border border-sf-dark-600 bg-sf-dark-800 text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary"
          title="Refresh"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={isRunning ? cancelRun : runProject}
          disabled={!projectFile || !coreDir || runState?.status === 'cancelling' || saving}
          className={`inline-flex h-8 items-center gap-1.5 rounded px-3 text-xs font-medium transition-colors ${
            isRunning
              ? 'bg-red-600 text-white hover:bg-red-500'
              : 'bg-sf-accent text-white hover:bg-sf-accent/90 disabled:cursor-not-allowed disabled:bg-sf-dark-700 disabled:text-sf-text-muted'
          }`}
          title={isRunning ? 'Stop run' : 'Run project'}
        >
          {isRunning ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          {isRunning ? 'Stop' : 'Run'}
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 border-b border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          <AlertCircle className="h-3.5 w-3.5" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[320px_minmax(0,1fr)_380px] gap-0 overflow-hidden">
        <aside className="flex min-h-0 flex-col border-r border-sf-dark-700 bg-sf-dark-925">
          <div className="border-b border-sf-dark-700 p-3">
            <label className="mb-1 block text-[10px] font-semibold uppercase text-sf-text-muted">Title</label>
            <input
              value={project?.title || ''}
              onChange={(event) => updateProjectField('title', event.target.value)}
              disabled={!project}
              className="mb-2 h-8 w-full rounded border border-sf-dark-600 bg-sf-dark-900 px-2 text-xs text-sf-text-primary outline-none focus:border-sf-accent disabled:opacity-50"
            />
            <label className="mb-1 block text-[10px] font-semibold uppercase text-sf-text-muted">Brief</label>
            <textarea
              value={project?.brief || ''}
              onChange={(event) => updateProjectField('brief', event.target.value)}
              disabled={!project}
              rows={4}
              className="mb-2 w-full resize-none rounded border border-sf-dark-600 bg-sf-dark-900 px-2 py-1.5 text-xs leading-5 text-sf-text-primary outline-none focus:border-sf-accent disabled:opacity-50"
            />
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="mb-1 block text-[10px] font-semibold uppercase text-sf-text-muted">Aspect</label>
                <select
                  value={project?.aspectRatio || '16:9'}
                  onChange={(event) => updateProjectField('aspectRatio', event.target.value)}
                  disabled={!project}
                  className="h-8 w-full rounded border border-sf-dark-600 bg-sf-dark-900 px-2 text-xs text-sf-text-primary outline-none focus:border-sf-accent disabled:opacity-50"
                >
                  <option value="16:9">16:9</option>
                  <option value="9:16">9:16</option>
                  <option value="1:1">1:1</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-[10px] font-semibold uppercase text-sf-text-muted">ID</label>
                <div className="flex h-8 items-center truncate rounded border border-sf-dark-700 bg-sf-dark-950 px-2 text-xs text-sf-text-muted" title={project?.id || ''}>
                  {project?.id || 'No project'}
                </div>
              </div>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-3">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-sf-text-muted">Adapters</div>
            <div className="space-y-1.5">
              {Object.entries(selectedAdapters).length > 0 ? (
                Object.entries(selectedAdapters).map(([slot, adapter]) => (
                  <div key={slot} className="rounded border border-sf-dark-700 bg-sf-dark-900 px-2 py-1.5">
                    <div className="text-[10px] uppercase text-sf-text-muted">{slot}</div>
                    <div className="truncate text-xs text-sf-text-primary" title={String(adapter)}>{String(adapter)}</div>
                  </div>
                ))
              ) : (
                <div className="text-xs text-sf-text-muted">No project loaded.</div>
              )}
            </div>
          </div>
        </aside>

        <main className="flex min-h-0 flex-col bg-sf-dark-950">
          <div className="grid grid-cols-5 border-b border-sf-dark-700 bg-sf-dark-925">
            {stageRows.map(({ stage, status, latest }) => (
              <div key={stage} className="border-r border-sf-dark-700 p-3 last:border-r-0">
                <div className="mb-1 flex items-center gap-2">
                  <StageIcon status={status} />
                  <span className="text-xs font-medium capitalize text-sf-text-primary">{stage}</span>
                </div>
                <div className="truncate text-[10px] text-sf-text-muted" title={latest?.adapterId || latest?.errorMessage || ''}>
                  {latest?.adapterId || latest?.errorMessage || status}
                </div>
              </div>
            ))}
          </div>

          <div className="min-h-0 flex-1 bg-black">
            {finalVideoUrl ? (
              <video
                key={finalVideoUrl}
                className="h-full w-full bg-black object-contain"
                src={finalVideoUrl}
                controls
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-sf-text-muted">
                <FileVideo className="h-12 w-12 text-sf-dark-500" />
                <div className="text-sm">No final video</div>
                {finalVideoPath && <div className="max-w-[70%] truncate font-mono text-[11px]">{finalVideoPath}</div>}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 border-t border-sf-dark-700 bg-sf-dark-900 px-3 py-2">
            <FileVideo className="h-3.5 w-3.5 text-sf-text-muted" />
            <div className="min-w-0 flex-1 truncate font-mono text-[11px] text-sf-text-muted" title={finalVideoPath}>
              {finalVideoPath || 'No output path'}
            </div>
            {typeof qaIssueCount === 'number' && (
              <div className="rounded border border-sf-dark-600 px-2 py-1 text-[11px] text-sf-text-secondary">
                QA {qaIssueCount}
              </div>
            )}
            <button
              type="button"
              onClick={openOutput}
              disabled={!finalVideoPath}
              className="inline-flex h-7 items-center gap-1 rounded border border-sf-dark-600 px-2 text-[11px] text-sf-text-secondary hover:border-sf-dark-500 hover:text-sf-text-primary disabled:cursor-not-allowed disabled:opacity-40"
              title="Open output"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open
            </button>
          </div>
        </main>

        <aside className="flex min-h-0 flex-col border-l border-sf-dark-700 bg-sf-dark-925">
          <div className="border-b border-sf-dark-700 p-3">
            <div className="mb-2 flex items-center gap-2">
              <FileJson className="h-4 w-4 text-sf-text-muted" />
              <div className="text-xs font-medium text-sf-text-primary">Artifacts</div>
            </div>
            <div className="space-y-1.5">
              {ARTIFACT_ROWS.map(({ key, label, icon: Icon }) => {
                const artifact = bundle?.artifacts?.[key]
                const exists = artifact?.exists
                return (
                  <div key={key} className="rounded border border-sf-dark-700 bg-sf-dark-900 px-2 py-1.5">
                    <div className="mb-1 flex items-center gap-2">
                      <Icon className={`h-3.5 w-3.5 ${exists ? 'text-emerald-300' : 'text-sf-text-muted'}`} />
                      <div className="min-w-0 flex-1 truncate text-xs text-sf-text-primary">{label}</div>
                      <div className={`text-[10px] ${exists ? 'text-emerald-300' : 'text-sf-text-muted'}`}>
                        {exists ? formatBytes(artifact.size) : 'Missing'}
                      </div>
                    </div>
                    <div className="truncate font-mono text-[10px] text-sf-text-muted" title={artifact?.path || ''}>
                      {artifact?.path ? shortPath(artifact.path) : '...'}
                    </div>
                    {artifact?.error && <div className="mt-1 truncate text-[10px] text-amber-200" title={artifact.error}>{artifact.error}</div>}
                  </div>
                )
              })}
            </div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b border-sf-dark-700 px-3 py-2">
              <TerminalSquare className="h-4 w-4 text-sf-text-muted" />
              <div className="text-xs font-medium text-sf-text-primary">Run Log</div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[11px] leading-5">
              {logs.length > 0 ? (
                logs.map((entry, index) => (
                  <div
                    key={`${entry.kind}-${index}-${entry.line}`}
                    className={entry.kind === 'err' ? 'text-amber-200/90' : 'text-sf-text-secondary'}
                  >
                    <span className="mr-2 text-sf-text-muted">{entry.kind}</span>
                    {entry.line}
                  </div>
                ))
              ) : (
                <div className="text-sf-text-muted">No log lines.</div>
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}

export default AIVideoWorkspace
