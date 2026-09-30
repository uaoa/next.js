import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { dumpAnalyzeGraph } from '../../packages/next/src/build/analyze/graph-dump'
import { writeAnalyzeSnapshot } from '../../packages/next/src/build/analyze/snapshot'

const id = '20260411-120000-local'

function file(
  header: Record<string, unknown>,
  sections: Record<string, number[][]>
) {
  const chunks: Buffer[] = []
  let offset = 0
  for (const [name, rows] of Object.entries(sections)) {
    const words = [rows.length]
    let end = 0
    for (const row of rows) {
      end += row.length
      words.push(end)
    }
    for (const row of rows) words.push(...row)
    const chunk = Buffer.alloc(4 * words.length)
    words.forEach((word, index) => chunk.writeUInt32BE(word, 4 * index))
    header[name] = { offset, length: chunk.length }
    offset += chunk.length
    chunks.push(chunk)
  }
  const json = Buffer.from(JSON.stringify(header))
  const length = Buffer.alloc(4)
  length.writeUInt32BE(json.length)
  return Buffer.concat([length, json, ...chunks])
}

function modules(version: number | 'legacy' = 1) {
  return file(
    {
      schema_version: version === 'legacy' ? undefined : version,
      modules: [
        { ident: 'app', path: 'app/page.tsx' },
        { ident: 'dep', path: 'dep/index.js' },
      ],
    },
    {
      module_dependencies: [[1], []],
      async_module_dependencies: [[], []],
      traced_module_dependencies: [[], []],
      module_dependents: [[], [0]],
      async_module_dependents: [[], []],
      traced_module_dependents: [[], []],
    }
  )
}

function route() {
  return file(
    {
      schema_version: 1,
      sources: [
        { parent_source_index: null, path: 'app/' },
        { parent_source_index: 0, path: 'page.tsx' },
      ],
      chunk_parts: [
        {
          source_index: 1,
          output_file_index: 0,
          size: 123,
          compressed_size: 44,
        },
      ],
      output_files: [{ filename: 'app.js' }],
      source_roots: [0],
    },
    {
      source_children: [[1], []],
      source_chunk_parts: [[], [0]],
      output_file_chunk_parts: [[0]],
    }
  )
}

describe('NDJSON analyzer graph', () => {
  let root: string
  let snapshot: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'graph-dump-'))
    snapshot = join(root, 'history', id)
    await mkdir(snapshot, { recursive: true })
    await writeFile(join(snapshot, 'routes.json'), JSON.stringify(['/', '/']))
    await writeFile(join(snapshot, 'modules.data'), modules())
    await writeFile(join(snapshot, 'analyze.data'), route())
  })
  afterEach(async () => rm(root, { recursive: true, force: true }))

  async function dump(routeKey?: string) {
    let output = ''
    const stream = new Writable({
      highWaterMark: 4,
      write(chunk, _encoding, callback) {
        output += chunk.toString()
        callback()
      },
    })
    await dumpAnalyzeGraph(root, id, routeKey, stream)
    return {
      output,
      records: output
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    }
  }

  it('streams deterministic typed records and preserves repeated route occurrences', async () => {
    const first = await dump('/')
    expect((await dump('/')).output).toBe(first.output)
    expect(first.records[0]).toMatchObject({
      type: 'meta',
      schema_version: 1,
      selected_routes: 2,
    })
    expect(
      first.records
        .filter((record) => record.type === 'route')
        .map((record) => record.route_index)
    ).toEqual([0, 1])
    expect(
      first.records.find(
        (record) => record.type === 'module' && record.ident === 'app'
      ).dependencies.sync
    ).toEqual(['dep'])
    expect(
      first.records.find((record) => record.type === 'part')
    ).toMatchObject({ source_path: 'app/page.tsx', size: 123 })
    expect(
      first.records.find((record) => record.type === 'output')
    ).toMatchObject({ modules: null, coverage: 'unknown' })
  })

  it.each([2, 'legacy'] as const)(
    'rejects unsupported or unversioned schema %s before stdout',
    async (version) => {
      await writeFile(join(snapshot, 'modules.data'), modules(version))
      let output = ''
      const stream = new Writable({
        write(chunk, _, callback) {
          output += chunk
          callback()
        },
      })
      await expect(
        dumpAnalyzeGraph(root, id, undefined, stream)
      ).rejects.toThrow('Unsupported analyzer schema')
      expect(output).toBe('')
    }
  )

  it('rejects malformed adjacency targets before stdout', async () => {
    const data = modules()
    const length = data.readUInt32BE(0)
    const header = JSON.parse(data.toString('utf8', 4, 4 + length))
    data.writeUInt32BE(
      3,
      4 + length + header.module_dependencies.offset + 4 + 4 * 2
    )
    await writeFile(join(snapshot, 'modules.data'), data)
    let output = ''
    const stream = new Writable({
      write(chunk, _, callback) {
        output += chunk
        callback()
      },
    })
    await expect(dumpAnalyzeGraph(root, id, undefined, stream)).rejects.toThrow(
      'Invalid module_dependencies index'
    )
    expect(output).toBe('')
  })

  it('replays both legacy and collision-safe snapshot IDs', async () => {
    const newer = `${id}-aabbccddeeff`
    await rename(snapshot, join(root, 'history', newer))
    let output = ''
    const stream = new Writable({
      write(chunk, _, callback) {
        output += chunk
        callback()
      },
    })
    await dumpAnalyzeGraph(root, newer, undefined, stream)
    expect(JSON.parse(output.split('\n')[0]).snapshot_id).toBe(newer)
  })

  it('rejects invalid routes and IDs before stdout', async () => {
    let output = ''
    const stream = new Writable({
      write(chunk, _, callback) {
        output += chunk
        callback()
      },
    })
    await expect(
      dumpAnalyzeGraph(root, '../bad', undefined, stream)
    ).rejects.toThrow('Invalid analyzer snapshot')
    await expect(
      dumpAnalyzeGraph(root, id, '/missing', stream)
    ).rejects.toThrow('Unknown analyzer route')
    expect(output).toBe('')
  })
})

describe('analyzer snapshot IDs', () => {
  it('keeps separate captures from the same second without replacing either', async () => {
    const root = await mkdtemp(join(tmpdir(), 'analyze-snapshot-'))
    jest.useFakeTimers().setSystemTime(new Date('2026-04-11T12:00:00Z'))
    try {
      const dataDir = join(root, 'data')
      await mkdir(dataDir)
      await writeFile(join(dataDir, 'routes.json'), '["/"]')
      const options = { projectDir: root, analyzeDir: root, routes: ['/'] }
      const first = await writeAnalyzeSnapshot(options)
      await writeFile(join(dataDir, 'routes.json'), '["/new"]')
      const second = await writeAnalyzeSnapshot(options)

      expect(first.id).toMatch(/^20260411-120000-local-[a-f0-9]{12}$/)
      expect(second.id).toMatch(/^20260411-120000-local-[a-f0-9]{12}$/)
      expect(second.id).not.toBe(first.id)
      expect(
        await readFile(join(root, 'history', first.id, 'routes.json'), 'utf8')
      ).toBe('["/"]')
      expect(
        await readFile(join(root, 'history', second.id, 'routes.json'), 'utf8')
      ).toBe('["/new"]')
    } finally {
      jest.useRealTimers()
      await rm(root, { recursive: true, force: true })
    }
  })
})
