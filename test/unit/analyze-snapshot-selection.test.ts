import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Load implementation at runtime; the Next package typechecks its own internals.
const analyze = require('../../packages/next/src/build/analyze')
  .default as jest.Mock
const { dumpAnalyzeGraph } =
  require('../../packages/next/src/build/analyze/graph-dump') as {
    dumpAnalyzeGraph: jest.Mock
  }
const { nextAnalyze } =
  require('../../packages/next/src/cli/next-analyze') as typeof import('../../packages/next/dist/cli/next-analyze')

jest.mock('node:child_process', () => ({ spawn: jest.fn() }))
jest.mock('../../packages/next/src/build/analyze', () => ({
  __esModule: true,
  default: jest.fn(),
}))
jest.mock('../../packages/next/src/build/analyze/graph-dump', () => ({
  dumpAnalyzeGraph: jest.fn(),
}))

describe('analyze snapshot selection', () => {
  let directory: string
  let initialTermListeners: NodeJS.SignalsListener[]
  let initialIntListeners: NodeJS.SignalsListener[]
  const snapshots = [
    { id: 'latest', snapshotName: 'new-audit' },
    { id: 'older', snapshotName: 'editor-audit' },
  ]
  const options = { graphJson: true, output: false, mangling: true, port: 4000 }

  beforeEach(async () => {
    jest.clearAllMocks()
    directory = await mkdtemp(join(tmpdir(), 'next-analyze-selection-'))
    const historyDir = join(directory, '.next/diagnostics/analyze/history')
    await mkdir(historyDir, { recursive: true })
    await writeFile(
      join(historyDir, 'history.json'),
      JSON.stringify({ snapshots })
    )
    initialTermListeners = process.listeners('SIGTERM')
    initialIntListeners = process.listeners('SIGINT')
  })

  afterEach(async () => {
    for (const listener of process.listeners('SIGTERM')) {
      if (!initialTermListeners.includes(listener))
        process.off('SIGTERM', listener)
    }
    for (const listener of process.listeners('SIGINT')) {
      if (!initialIntListeners.includes(listener))
        process.off('SIGINT', listener)
    }
    await rm(directory, { recursive: true, force: true })
  })

  function expectedDump(id: string, route?: string) {
    expect(dumpAnalyzeGraph).toHaveBeenCalledWith(
      join(directory, '.next/diagnostics/analyze'),
      id,
      route,
      process.stdout
    )
    expect(analyze).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  }

  it('replays the newest saved snapshot without running a build', async () => {
    await nextAnalyze(options, directory)
    expectedDump('latest')
  })

  it('replays an exact non-newest ID and route', async () => {
    await nextAnalyze({ ...options, snapshot: 'older', route: '/' }, directory)
    expectedDump('older', '/')
  })

  it('replays a uniquely named non-newest snapshot', async () => {
    await nextAnalyze({ ...options, snapshotName: 'editor-audit' }, directory)
    expectedDump('older')
  })

  it('rejects ambiguous names without exporting or building', async () => {
    const historyDir = join(directory, '.next/diagnostics/analyze/history')
    await writeFile(
      join(historyDir, 'history.json'),
      JSON.stringify({
        snapshots: [
          ...snapshots,
          { id: 'third', snapshotName: 'editor-audit' },
        ],
      })
    )
    await expect(
      nextAnalyze({ ...options, snapshotName: 'editor-audit' }, directory)
    ).rejects.toThrow(/multiple|ambiguous/i)
    expect(dumpAnalyzeGraph).not.toHaveBeenCalled()
    expect(analyze).not.toHaveBeenCalled()
  })

  it.each([
    { selection: { snapshotName: 'missing' }, message: /not found/i },
    { selection: { snapshot: 'missing' }, message: /not found/i },
    {
      selection: { snapshot: 'older', snapshotName: 'editor-audit' },
      message: /cannot|together|both/i,
    },
    { selection: { output: true }, message: /cannot|together|both/i },
    { selection: { profile: true }, message: /cannot|together|both/i },
    {
      selection: { experimentalAppOnly: true },
      message: /cannot|together|both/i,
    },
    { selection: { serve: true }, message: /cannot|together|both/i },
    { selection: { mangling: false }, message: /cannot|together|both/i },
  ])(
    'fails closed on invalid replay $selection',
    async ({ selection, message }) => {
      await expect(
        nextAnalyze({ ...options, ...selection }, directory)
      ).rejects.toThrow(message)
      expect(dumpAnalyzeGraph).not.toHaveBeenCalled()
      expect(analyze).not.toHaveBeenCalled()
    }
  )

  it('rejects replay without any saved snapshot', async () => {
    const historyDir = join(directory, '.next/diagnostics/analyze/history')
    await writeFile(join(historyDir, 'history.json'), '{"snapshots":[]}')
    await expect(nextAnalyze(options, directory)).rejects.toThrow(/not found/i)
    expect(dumpAnalyzeGraph).not.toHaveBeenCalled()
    expect(analyze).not.toHaveBeenCalled()
  })

  it('captures with --output and keeps the user-supplied UI name', async () => {
    jest.mocked(analyze).mockResolvedValue({ id: 'captured' } as never)
    await nextAnalyze(
      {
        graphJson: false,
        output: true,
        mangling: true,
        port: 4000,
        snapshotName: 'audit',
      },
      directory
    )
    expect(analyze).toHaveBeenCalledWith(
      expect.objectContaining({
        dir: directory,
        output: true,
        snapshotName: 'audit',
      })
    )
    expect(dumpAnalyzeGraph).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it.each([{ snapshot: 'older' }, { snapshot: '' }, { route: '/' }])(
    'rejects replay-only $selection without --graph-json',
    async (selection) => {
      await expect(
        nextAnalyze({ ...options, graphJson: false, ...selection }, directory)
      ).rejects.toThrow(/require --graph-json/i)
      expect(analyze).not.toHaveBeenCalled()
    }
  )
})
