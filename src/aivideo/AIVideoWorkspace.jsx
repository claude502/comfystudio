import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  Boxes,
  Clock3,
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
  Timer,
  TerminalSquare,
  Workflow,
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

function normalizeFilePath(filePath) {
  return String(filePath || '').replace(/\\/g, '/')
}

function basename(filePath) {
  const normalized = normalizeFilePath(filePath)
  return normalized.split('/').filter(Boolean).pop() || normalized
}

function formatDuration(value) {
  const seconds = Math.max(0, Number(value) || 0)
  if (seconds < 60) return `${seconds.toFixed(seconds % 1 === 0 ? 0 : 1)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds - minutes * 60
  return `${minutes}:${String(Math.round(rest)).padStart(2, '0')}`
}

function assetKindTone(kind) {
  if (kind === 'video') return 'border-sf-accent/40 bg-sf-accent/10 text-sf-accent'
  if (kind === 'image') return 'border-emerald-500/35 bg-emerald-500/10 text-emerald-200'
  if (kind === 'audio') return 'border-amber-500/35 bg-amber-500/10 text-amber-200'
  return 'border-sf-dark-600 bg-sf-dark-800 text-sf-text-muted'
}

function findTraceForPath(events, filePath) {
  const target = normalizeFilePath(filePath)
  if (!target) return null
  return [...events].reverse().find((event) => (
    event?.type === 'stage-complete'
    && Array.isArray(event.artifactPaths)
    && event.artifactPaths.some((artifactPath) => normalizeFilePath(artifactPath) === target)
  )) || null
}

function buildTraceRows(bundle, events) {
  return ARTIFACT_ROWS.map(({ key, label }) => {
    const artifact = bundle?.artifacts?.[key]
    const trace = findTraceForPath(events, artifact?.path)
    return {
      key,
      label,
      path: artifact?.path || '',
      exists: Boolean(artifact?.exists),
      trace,
    }
  })
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
  const hydratedRef = useRef(false)

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

  const loadLatestBundleEvents = useCallback(async (nextBundle) => {
    if (!api || !nextBundle?.logs?.length) return
    const latestLog = nextBundle.logs[0]
    if (!latestLog?.path) return
    const result = await api.readEventLog({ eventLogPath: latestLog.path })
    if (result?.success) {
      setEvents(result.events || [])
    }
  }, [api])

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
      const loaded = await api.loadProjectBundle({ projectDir, projectFile })
      if (await applyBundle(loaded)) {
        await loadLatestBundleEvents(loaded)
      }
    }
  }, [api, applyBundle, loadLatestBundleEvents, projectDir, projectFile, refreshEvents, refreshPreview])

  useEffect(() => {
    if (!api || hydratedRef.current) return undefined
    hydratedRef.current = true

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
          const loaded = await api?.loadProjectBundle?.({ projectDir: nextProjectDir, projectFile: nextProjectFile })
          if (await applyBundle(loaded)) {
            await loadLatestBundleEvents(loaded)
          }
        }
        if (defaults?.state?.eventLogPath) await refreshEvents(defaults.state.eventLogPath)
      } catch (err) {
        setError(err?.message || String(err))
      }
    }
    hydrate()
    return undefined
  }, [api, applyBundle, loadLatestBundleEvents, refreshEvents])

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
    if (await applyBundle(result)) {
      await loadLatestBundleEvents(result)
    }
  }, [api, applyBundle, coreDir, loadLatestBundleEvents, projectDir])

  const createProject = useCallback(async () => {
    setError('')
    const result = await api?.createProject?.({
      coreDir,
      defaultPath: projectDir || coreDir,
      aspectRatio: project?.aspectRatio || '16:9',
    })
    if (await applyBundle(result)) {
      setEvents([])
    }
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
  const manifestAssets = useMemo(() => {
    const assets = bundle?.artifacts?.assetManifest?.data?.assets
    return Array.isArray(assets) ? assets : []
  }, [bundle?.artifacts?.assetManifest?.data?.assets])
  const storyboardShots = useMemo(() => {
    const shots = bundle?.artifacts?.storyboard?.data?.shots || bundle?.artifacts?.outputStoryboard?.data?.shots
    return Array.isArray(shots) ? shots : []
  }, [bundle?.artifacts?.outputStoryboard?.data?.shots, bundle?.artifacts?.storyboard?.data?.shots])
  const timelineClips = useMemo(() => {
    const clips = bundle?.artifacts?.timeline?.data?.clips
    return Array.isArray(clips) ? clips : []
  }, [bundle?.artifacts?.timeline?.data?.clips])
  const mappedAssets = useMemo(() => {
    const rows = manifestAssets.map((asset) => ({
      ...asset,
      displayName: basename(asset.path || asset.id),
      trace: findTraceForPath(events, asset.path),
    }))
    const finalArtifact = bundle?.artifacts?.finalVideo
    if (finalArtifact?.exists) {
      rows.unshift({
        id: 'final-video',
        shotId: 'output',
        kind: 'video',
        path: finalArtifact.path,
        provider: 'renderer',
        displayName: basename(finalArtifact.path),
        trace: findTraceForPath(events, finalArtifact.path),
      })
    }
    return rows
  }, [bundle?.artifacts?.finalVideo, events, manifestAssets])
  const timelineRows = useMemo(() => {
    return timelineClips.map((clip) => {
      const shot = storyboardShots.find((item) => item.id === clip.shotId)
      const clipAssets = (clip.assetIds || [])
        .map((assetId) => manifestAssets.find((asset) => asset.id === assetId))
        .filter(Boolean)
      return {
        ...clip,
        shot,
        assets: clipAssets,
      }
    })
  }, [manifestAssets, storyboardShots, timelineClips])
  const timelineDuration = Number(bundle?.artifacts?.timeline?.data?.duration) || timelineRows.reduce((max, clip) => {
    return Math.max(max, (Number(clip.start) || 0) + (Number(clip.duration) || 0))
  }, 0)
  const traceRows = useMemo(() => buildTraceRows(bundle, events), [bundle, events])

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

          <div className="h-48 flex-shrink-0 border-t border-sf-dark-700 bg-sf-dark-925">
            <div className="flex h-8 items-center gap-2 border-b border-sf-dark-700 px-3">
              <Workflow className="h-3.5 w-3.5 text-sf-text-muted" />
              <div className="text-xs font-medium text-sf-text-primary">Timeline</div>
              <div className="ml-auto flex items-center gap-1 text-[10px] text-sf-text-muted">
                <Timer className="h-3 w-3" />
                {formatDuration(timelineDuration)}
              </div>
            </div>
            <div className="h-[calc(100%-2rem)] overflow-auto p-3">
              {timelineRows.length > 0 ? (
                <div className="space-y-2">
                  {timelineRows.map((clip) => {
                    const widthPercent = timelineDuration > 0 ? Math.max(3, (Number(clip.duration) / timelineDuration) * 100) : 100
                    const startPercent = timelineDuration > 0 ? Math.max(0, (Number(clip.start) / timelineDuration) * 100) : 0
                    return (
                      <div key={clip.id} className="rounded border border-sf-dark-700 bg-sf-dark-900 p-2">
                        <div className="mb-1.5 flex items-center gap-2">
                          <div className="min-w-0 flex-1 truncate text-xs font-medium text-sf-text-primary" title={clip.shot?.visualPrompt || clip.caption || clip.id}>
                            {clip.caption || clip.shot?.caption || clip.shotId}
                          </div>
                          <div className="font-mono text-[10px] text-sf-text-muted">
                            {formatDuration(clip.start)} + {formatDuration(clip.duration)}
                          </div>
                        </div>
                        <div className="relative h-5 rounded bg-sf-dark-800">
                          <div
                            className="absolute top-1 h-3 rounded bg-sf-accent/70"
                            style={{ left: `${Math.min(97, startPercent)}%`, width: `${Math.min(100 - Math.min(97, startPercent), widthPercent)}%` }}
                          />
                        </div>
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {(clip.assets || []).length > 0 ? clip.assets.map((asset) => (
                            <span key={asset.id} className="rounded border border-sf-dark-600 px-1.5 py-0.5 text-[10px] text-sf-text-muted" title={asset.path}>
                              {asset.kind} {asset.id}
                            </span>
                          )) : (
                            <span className="text-[10px] text-sf-text-muted">No mapped asset</span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-sf-text-muted">
                  No timeline artifact.
                </div>
              )}
            </div>
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
          <div className="max-h-56 overflow-auto border-b border-sf-dark-700 p-3">
            <div className="mb-2 flex items-center gap-2">
              <Boxes className="h-4 w-4 text-sf-text-muted" />
              <div className="text-xs font-medium text-sf-text-primary">Assets</div>
              <div className="ml-auto text-[10px] text-sf-text-muted">{mappedAssets.length}</div>
            </div>
            {mappedAssets.length > 0 ? (
              <div className="space-y-1.5">
                {mappedAssets.map((asset) => (
                  <div key={asset.id} className="rounded border border-sf-dark-700 bg-sf-dark-900 px-2 py-1.5">
                    <div className="mb-1 flex items-center gap-2">
                      <div className={`rounded border px-1.5 py-0.5 text-[10px] ${assetKindTone(asset.kind)}`}>
                        {asset.kind || 'asset'}
                      </div>
                      <div className="min-w-0 flex-1 truncate text-xs text-sf-text-primary" title={asset.displayName}>
                        {asset.displayName}
                      </div>
                    </div>
                    <div className="truncate font-mono text-[10px] text-sf-text-muted" title={asset.path}>
                      {shortPath(asset.path)}
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[10px] text-sf-text-muted">
                      <span className="truncate">{asset.provider || 'unknown'}</span>
                      {asset.trace?.stageRunId && (
                        <span className="ml-auto truncate" title={asset.trace.stageRunId}>
                          {asset.trace.stage}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs text-sf-text-muted">No asset manifest yet.</div>
            )}
          </div>
          <div className="max-h-44 overflow-auto border-b border-sf-dark-700 p-3">
            <div className="mb-2 flex items-center gap-2">
              <Clock3 className="h-4 w-4 text-sf-text-muted" />
              <div className="text-xs font-medium text-sf-text-primary">Trace</div>
            </div>
            <div className="space-y-1.5">
              {traceRows.map((row) => (
                <div key={row.key} className="rounded border border-sf-dark-700 bg-sf-dark-900 px-2 py-1.5">
                  <div className="mb-1 flex items-center gap-2">
                    <div className="min-w-0 flex-1 truncate text-xs text-sf-text-primary">{row.label}</div>
                    <div className={`text-[10px] ${row.trace ? 'text-emerald-300' : 'text-sf-text-muted'}`}>
                      {row.trace ? row.trace.stage : row.exists ? 'local' : 'missing'}
                    </div>
                  </div>
                  <div className="truncate font-mono text-[10px] text-sf-text-muted" title={row.trace?.stageRunId || row.path}>
                    {row.trace?.stageRunId || shortPath(row.path)}
                  </div>
                </div>
              ))}
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
