import {
  cp,
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
import Ajv2020 from 'ajv/dist/2020'
import { dumpAnalyzeGraph } from '../../packages/next/src/build/analyze/graph-dump'
import { writeAnalyzeSnapshot } from '../../packages/next/src/build/analyze/snapshot'
import {
  isValidGraphRecord,
  validateGraphDump,
} from '../lib/analyze-graph-schema'

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

function route(entries?: Array<Record<string, unknown>>) {
  return file(
    {
      schema_version: 1,
      route_entries: entries,
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
    validateGraphDump(first.output)
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

  it('ships a usable schema within the skill directory', async () => {
    const skill = join(
      __dirname,
      '../../skills/next-browser-initial-load-optimizer'
    )
    const installed = join(root, 'installed-skill')
    await cp(skill, installed, { recursive: true })
    const guide = await readFile(join(installed, 'SKILL.md'), 'utf8')
    expect(guide).toContain(
      '[references/analyzer-graph-v1.schema.json](references/analyzer-graph-v1.schema.json)'
    )
    expect(guide).not.toContain('GRAPH-DUMP.md')
    const schema = JSON.parse(
      await readFile(
        join(installed, 'references/analyzer-graph-v1.schema.json'),
        'utf8'
      )
    )
    expect(schema.$id).toBe('urn:nextjs:analyze:analyzer-graph:v1')
    const validate = new Ajv2020().compile(schema)
    expect(validate((await dump('/')).records[0])).toBe(true)
  })

  it('validates typed endpoint roots and nested client references', async () => {
    await writeFile(
      join(snapshot, 'analyze.data'),
      route([
        {
          route_entry_id: 'app-client',
          module_ident: 'app',
          module_path: 'app/page.tsx',
          role: 'client',
          runtime: null,
          entry_kind: 'client_bootstrap',
          client_references: [
            {
              module_ident: 'dep',
              module_path: 'dep/index.js',
              reference_kind: 'ecmascript',
            },
          ],
        },
      ])
    )
    const { output, records } = await dump('/')
    validateGraphDump(output)
    const entry = records.find((record) => record.type === 'route').entries[0]
    expect(entry.client_references[0].module_ident).toBe('dep')
    expect(
      isValidGraphRecord({
        ...records.find((record) => record.type === 'route'),
        entries: [{ ...entry, client_references: [{ module_ident: 42 }] }],
      })
    ).toBe(false)
  })

  it('validates known fields but allows additive v1 fields', async () => {
    const { records } = await dump('/')
    const meta = records[0]
    expect(isValidGraphRecord({ ...meta, optional_future_field: true })).toBe(
      true
    )
    expect(isValidGraphRecord({ ...meta, type: 'future_record' })).toBe(false)
    expect(isValidGraphRecord({ ...meta, schema_version: 2 })).toBe(false)
    const missingCount = { ...meta }
    delete missingCount.route_count
    expect(isValidGraphRecord(missingCount)).toBe(false)
    expect(isValidGraphRecord({ ...meta, route_count: -1 })).toBe(false)
    expect(
      isValidGraphRecord({
        ...records.find((record) => record.type === 'output'),
        coverage: 'guessed',
      })
    ).toBe(false)
    expect(
      isValidGraphRecord({
        ...records.find((record) => record.type === 'part'),
        compressed_size: null,
      })
    ).toBe(false)
  })

  it('checks stream framing, meta order and route/output joins separately', async () => {
    const { output, records } = await dump('/')
    expect(() => validateGraphDump(output.slice(0, -1))).toThrow('Truncated')
    expect(() =>
      validateGraphDump(output + JSON.stringify(records[0]) + '\n')
    ).toThrow('Duplicate')
    const part = records.find((record) => record.type === 'part')
    expect(() =>
      validateGraphDump(
        output + JSON.stringify({ ...part, route_index: 99 }) + '\n'
      )
    ).toThrow('Unknown route')
    expect(() =>
      validateGraphDump(
        output + JSON.stringify({ ...part, filename: 'missing.js' }) + '\n'
      )
    ).toThrow('Unknown output')
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
