const assert = require('assert')
const { test } = require('node:test')

const {
  getAivideoToolRegistry,
} = require('./aivideoToolRegistry')

test('reports bundled FFmpeg as ready and optional tools as missing', async () => {
  const registry = await getAivideoToolRegistry({
    homeDir: '/Users/example',
    pathEnv: '/Users/example/.local/bin:/usr/bin',
    ffmpegPath: '/opt/comfystudio/bin/ffmpeg',
    pathExists: async (candidate) => candidate === '/opt/comfystudio/bin/ffmpeg',
    isExecutable: async (candidate) => candidate === '/opt/comfystudio/bin/ffmpeg',
    runCommand: async (command, args) => {
      assert.strictEqual(command, '/opt/comfystudio/bin/ffmpeg')
      assert.deepStrictEqual(args, ['-version'])
      return { ok: true, stdout: 'ffmpeg version 6.1.2 Copyright\nbuilt with clang', stderr: '', code: 0 }
    },
    probeHttp: async () => ({ ok: false, error: 'connect ECONNREFUSED' }),
  })

  const ffmpeg = registry.tools.find((tool) => tool.id === 'ffmpeg')
  const hyperframes = registry.tools.find((tool) => tool.id === 'hyperframes')

  assert.strictEqual(registry.success, true)
  assert.strictEqual(ffmpeg.status, 'ready')
  assert.strictEqual(ffmpeg.version, '6.1.2')
  assert.strictEqual(ffmpeg.executablePath, '/opt/comfystudio/bin/ffmpeg')
  assert.strictEqual(hyperframes.status, 'missing')
  assert.strictEqual(hyperframes.installDir, '/Users/example/.local/aivideo-tools/HyperFrames')
})

test('reports installed ComfyUI as misconfigured when the local service is offline', async () => {
  const registry = await getAivideoToolRegistry({
    homeDir: '/Users/example',
    pathEnv: '/Users/example/.local/bin',
    comfyRootPath: '/Users/example/.local/aivideo-tools/ComfyUI',
    comfyEndpoint: 'http://127.0.0.1:8188',
    pathExists: async (candidate) => [
      '/Users/example/.local/aivideo-tools/ComfyUI',
      '/Users/example/.local/bin/comfyui',
    ].includes(candidate),
    isExecutable: async (candidate) => candidate === '/Users/example/.local/bin/comfyui',
    runCommand: async () => ({ ok: true, stdout: 'ComfyUI CLI 0.4.0\n', stderr: '', code: 0 }),
    probeHttp: async () => ({ ok: false, endpoint: 'http://127.0.0.1:8188', error: 'connect ECONNREFUSED' }),
  })

  const comfyui = registry.tools.find((tool) => tool.id === 'comfyui')

  assert.strictEqual(comfyui.status, 'misconfigured')
  assert.strictEqual(comfyui.version, '0.4.0')
  assert.match(comfyui.message, /not responding/i)
  assert.strictEqual(comfyui.endpoint, 'http://127.0.0.1:8188')
})
