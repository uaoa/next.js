import { nextTestSetup } from 'e2e-utils'
import { validateGraphDump } from '../../lib/analyze-graph-schema'
import { shouldUseTurbopack } from 'next-test-utils'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

// TODO(deploy-test-completion): Re-enable this suite in deploy mode.
// It likely inspects local build artifacts that deploy tests do not expose.
// @force-gate !deploy
describe('next analyze', () => {
  if (!shouldUseTurbopack()) {
    // Test suites require at least one test
    it('skips in non-Turbopack tests', () => {})
    return
  }

  const { next } = nextTestSetup({
    files: __dirname,
    skipStart: true,
  })

  it('runs successfully without errors', async () => {
    let serveProcess: ChildProcess | undefined
    let stdoutBuffer = ''
    let resolveUrl!: (url: string) => void
    let rejectUrl!: (err: Error) => void
    const urlPromise = new Promise<string>((resolve, reject) => {
      resolveUrl = resolve
      rejectUrl = reject
    })

    const timeout = setTimeout(() => {
      rejectUrl(new Error('Server did not start within timeout'))
    }, 30000)

    const exit = next
      .runCommand(['analyze', '--port', '0'], {
        onStdout(msg) {
          stdoutBuffer += msg
          const urlMatch = stdoutBuffer.match(/http:\/\/[^\s]+/)
          if (urlMatch) {
            resolveUrl(urlMatch[0])
          }
        },
        instance(p) {
          serveProcess = p
        },
      })
      .finally(() => {
        clearTimeout(timeout)
      })

    try {
      const url = await urlPromise
      const response = await fetch(url)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain(
        '<title>Next.js Bundle Analyzer</title>'
      )
    } finally {
      serveProcess?.kill()
      await exit.catch(() => {})
    }
  })

  it('stores the snapshot name in live and historical metadata', async () => {
    const name = 'My snapshot'
    const { exitCode, stderr } = await next.runCommand([
      'analyze',
      '--output',
      '--snapshot-name',
      name,
    ])

    expect(exitCode).toBe(0)
    expect(stderr).not.toContain('Error')

    const analyzeDir = path.join(next.testDir, '.next/diagnostics/analyze')
    const metadata = JSON.parse(
      readFileSync(path.join(analyzeDir, 'data/metadata.json'), 'utf-8')
    )
    expect(metadata.snapshotName).toBe(name)
    expect(metadata).not.toHaveProperty('baselineName')

    const history = JSON.parse(
      readFileSync(path.join(analyzeDir, 'history/history.json'), 'utf-8')
    )
    expect(history.snapshots[0].snapshotName).toBe(name)
    expect(history.snapshots[0]).not.toHaveProperty('baselineName')
  })

  it('captures a named snapshot, then streams its versioned graph without building', async () => {
    const started = Date.now()
    const name = 'JSON snapshot'
    const fresh = await next.runCommand([
      'analyze',
      '--output',
      '--snapshot-name',
      name,
    ])
    expect(fresh.exitCode).toBe(0)
    expect(fresh.stdout).toContain('Analyzing a production build')
    const named = await next.runCommand(
      ['analyze', '--graph-json', '--snapshot-name', name],
      { env: { PORT: '39555' } }
    )
    // PORT from the environment must not make replay try to serve the UI.
    expect(named.exitCode).toBe(0)
    expect(named.stderr).not.toContain('Analyzing a production build')
    validateGraphDump(named.stdout)
    // Log the real fixture's output size and elapsed time without pasting its graph.
    console.log(
      `Analyzer NDJSON fixture: ${Buffer.byteLength(named.stdout)} bytes in ${Date.now() - started}ms`
    )
    const records = named.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(records[0]).toMatchObject({ type: 'meta', schema_version: 1 })
    expect(records.some((record) => record.type === 'module')).toBe(true)
    expect(records.some((record) => record.type === 'part')).toBe(true)
    expect(records.some((record) => record.type === 'output')).toBe(true)
    expect(records.some((record) => record.type === 'route')).toBe(true)

    const analyzeDir = path.join(next.testDir, '.next/diagnostics/analyze')
    const history = JSON.parse(
      readFileSync(path.join(analyzeDir, 'history/history.json'), 'utf8')
    )
    const namedSnapshot = history.snapshots.find(
      (snapshot: { snapshotName?: string }) => snapshot.snapshotName === name
    )
    if (!namedSnapshot) throw new Error('Named analyzer snapshot missing')
    const id: string = namedSnapshot.id
    expect(id).toMatch(/^\d{8}-\d{6}-(?:[a-f0-9]{7}|local)-[a-f0-9]{12}$/)
    expect(history.snapshots[0].snapshotName).toBe('JSON snapshot')
    expect(records[0].snapshot_id).toBe(id)
    expect(
      JSON.parse(
        readFileSync(
          path.join(analyzeDir, 'history', id, 'metadata.json'),
          'utf8'
        )
      ).id
    ).toBe(id)
    expect(
      existsSync(path.join(analyzeDir, 'history', id, 'graph.ndjson'))
    ).toBe(false)
    const replay = await next.runCommand([
      'analyze',
      '--graph-json',
      '--snapshot',
      id,
    ])
    expect(replay.exitCode).toBe(0)
    validateGraphDump(replay.stdout)
    expect(replay.stdout).toBe(named.stdout)
    const latest = await next.runCommand(['analyze', '--graph-json'])
    expect(latest.exitCode).toBe(0)
    expect(latest.stdout).toBe(named.stdout)
    // Replay by exact ID, without another analysis build.
    const replayAgain = await next.runCommand([
      'analyze',
      '--graph-json',
      '--snapshot',
      id,
    ])
    expect(replayAgain.exitCode).toBe(0)
    validateGraphDump(replayAgain.stdout)
    expect(replayAgain.stdout).toBe(replay.stdout)
    const alias = await next.runCommand([
      'experimental-analyze',
      '--graph-json',
      '--snapshot',
      id,
    ])
    expect(alias.exitCode).toBe(0)
    validateGraphDump(alias.stdout)
    expect(alias.stdout).toBe(replay.stdout)
    expect(replay.stderr).not.toContain('Analyzing a production build')
    const root = await next.runCommand([
      'analyze',
      '--graph-json',
      '--snapshot',
      id,
      '--route',
      '/',
    ])
    expect(root.exitCode).toBe(0)
    validateGraphDump(root.stdout)
    const rootRecords = root.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(rootRecords.filter((record) => record.type === 'module')).toEqual(
      records.filter((record) => record.type === 'module')
    )
    expect(rootRecords.filter((record) => record.type === 'route')).toEqual(
      records.filter(
        (record) => record.type === 'route' && record.route === '/'
      )
    )
    const missing = await next.runCommand([
      'analyze',
      '--graph-json',
      '--snapshot',
      id,
      '--route',
      '/does-not-exist',
    ])
    expect(missing.exitCode).not.toBe(0)
    expect(missing.stdout).toBe('')
    expect(missing.stderr).toContain('Unknown analyzer route')
    const traversal = await next.runCommand([
      'analyze',
      '--graph-json',
      '--snapshot',
      '../bad',
    ])
    expect(traversal.exitCode).not.toBe(0)
    expect(traversal.stdout).toBe('')
    for (const args of [
      ['analyze', '--output=xml'],
      ['analyze', '--route', '/'],
      ['analyze', '--snapshot', id],
    ]) {
      const invalid = await next.runCommand(args)
      expect(invalid.exitCode).not.toBe(0)
      expect(invalid.stdout).toBe('')
    }

    const missingName = await next.runCommand([
      'analyze',
      '--graph-json',
      '--snapshot-name',
      'not-a-snapshot',
    ])
    expect(missingName.exitCode).not.toBe(0)
    expect(missingName.stdout).toBe('')
    const conflictingSelectors = await next.runCommand([
      'analyze',
      '--graph-json',
      '--snapshot',
      id,
      '--snapshot-name',
      name,
    ])
    expect(conflictingSelectors.exitCode).not.toBe(0)
    expect(conflictingSelectors.stdout).toBe('')
    const conflictingModes = await next.runCommand([
      'analyze',
      '--graph-json',
      '--output',
    ])
    expect(conflictingModes.exitCode).not.toBe(0)
    expect(conflictingModes.stdout).toBe('')
    const removedJsonShortcut = await next.runCommand([
      'analyze',
      '--output=json',
    ])
    expect(removedJsonShortcut.exitCode).not.toBe(0)
    expect(removedJsonShortcut.stdout).toBe('')

    const moduleFile = path.join(analyzeDir, 'history', id, 'modules.data')
    const original = readFileSync(moduleFile)
    try {
      const unsupported = Buffer.from(original)
      const headerLength = unsupported.readUInt32BE(0)
      const header = JSON.parse(
        unsupported.toString('utf8', 4, 4 + headerLength)
      )
      const versionedHeader = Buffer.from(
        JSON.stringify({ ...header, schema_version: 999 })
      )
      writeFileSync(
        moduleFile,
        Buffer.concat([
          Buffer.from([
            (versionedHeader.length >>> 24) & 255,
            (versionedHeader.length >>> 16) & 255,
            (versionedHeader.length >>> 8) & 255,
            versionedHeader.length & 255,
          ]),
          versionedHeader,
          unsupported.subarray(4 + headerLength),
        ])
      )
      const unknownVersion = await next.runCommand([
        'analyze',
        '--graph-json',
        '--snapshot',
        id,
      ])
      expect(unknownVersion.exitCode).not.toBe(0)
      expect(unknownVersion.stdout).toBe('')
      expect(unknownVersion.stderr).toContain('Unsupported analyzer schema')

      writeFileSync(moduleFile, original.subarray(0, 3))
      const truncated = await next.runCommand([
        'analyze',
        '--graph-json',
        '--snapshot',
        id,
      ])
      expect(truncated.exitCode).not.toBe(0)
      expect(truncated.stdout).toBe('')
      expect(truncated.stderr).toContain('Truncated analyzer header')
    } finally {
      writeFileSync(moduleFile, original)
    }
  })

  it('replays a snapshot created by next build --analyze', async () => {
    const build = await next.runCommand(['build', '--analyze'])
    if (build.exitCode !== 0) {
      throw new Error(
        `next build --analyze failed: ${build.stderr}\n${build.stdout}`
      )
    }
    const analyzeDir = path.join(next.testDir, '.next/diagnostics/analyze')
    const history = JSON.parse(
      readFileSync(path.join(analyzeDir, 'history/history.json'), 'utf8')
    )
    const id = history.snapshots[0].id
    const replay = await next.runCommand([
      'analyze',
      '--graph-json',
      '--snapshot',
      id,
    ])
    expect(replay.exitCode).toBe(0)
    validateGraphDump(replay.stdout)
    expect(
      replay.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))[0]
    ).toMatchObject({
      type: 'meta',
      snapshot_id: id,
    })
    expect(replay.stderr).not.toContain('Analyzing a production build')
  })
  ;['-o', '--output'].forEach((flag) => {
    describe(`with ${flag} flag`, () => {
      it('writes output to .next/diagnostics/analyze path', async () => {
        const defaultOutputPath = path.join(
          next.testDir,
          '.next/diagnostics/analyze'
        )

        const { exitCode, stderr, stdout } = await next.runCommand([
          'analyze',
          flag,
          ...(flag === '--output' ? ['.'] : []),
        ])

        expect(exitCode).toBe(0)
        expect(stderr).not.toContain('Error')
        expect(stdout).toContain('.next/diagnostics/analyze')

        expect(existsSync(defaultOutputPath)).toBe(true)
        for (const file of [
          'index.html',
          'data/routes.json',
          'data/modules.data',
          'data/analyze.data',
        ]) {
          expect(existsSync(path.join(defaultOutputPath, file))).toBe(true)
        }

        const routesJson = readFileSync(
          path.join(defaultOutputPath, 'data', 'routes.json'),
          'utf-8'
        )
        const routes = JSON.parse(routesJson)
        expect(routes).toEqual(['/', '/_not-found'])
      })
    })
  })
})
