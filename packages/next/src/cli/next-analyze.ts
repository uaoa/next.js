#!/usr/bin/env node

import '../server/lib/cpu-profile'
import { saveCpuProfile } from '../server/lib/cpu-profile'
import { existsSync } from 'fs'
import { italic } from '../lib/picocolors'
import analyze from '../build/analyze'
import { warn } from '../build/output/log'
import { printAndExit } from '../server/lib/utils'
import { getProjectDir } from '../lib/get-project-dir'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { dumpAnalyzeGraph } from '../build/analyze/graph-dump'

export type NextAnalyzeOptions = {
  experimentalAnalyze?: boolean
  profile?: boolean
  mangling: boolean
  port: number
  output: boolean
  graphJson?: boolean
  serve?: boolean
  snapshot?: string
  route?: string
  experimentalAppOnly?: boolean
  snapshotName?: string
}

const nextAnalyze = async (options: NextAnalyzeOptions, directory?: string) => {
  process.on('SIGTERM', () => {
    saveCpuProfile()
    process.exit(143)
  })
  process.on('SIGINT', () => {
    saveCpuProfile()
    process.exit(130)
  })

  const { profile, mangling, experimentalAppOnly, output, port, snapshotName } =
    options

  if (options.graphJson) {
    if (
      output ||
      profile ||
      experimentalAppOnly ||
      !mangling ||
      options.serve
    ) {
      throw new Error(
        '--graph-json cannot be combined with build or server options'
      )
    }
    if (options.snapshot !== undefined && snapshotName !== undefined) {
      throw new Error('--snapshot and --snapshot-name cannot be used together')
    }
    const dir = getProjectDir(directory)
    if (!existsSync(dir)) {
      printAndExit(`> No such directory exists as the project root: ${dir}`)
    }
    const analyzeDir = join(dir, '.next/diagnostics/analyze')
    const index = JSON.parse(
      await readFile(join(analyzeDir, 'history/history.json'), 'utf8')
    ) as { snapshots: Array<{ id: string; snapshotName?: string }> }
    let id = options.snapshot
    if (snapshotName !== undefined) {
      const matches = index.snapshots.filter(
        (snapshot) => snapshot.snapshotName === snapshotName
      )
      if (matches.length === 0) {
        throw new Error(`Analyzer snapshot name not found: ${snapshotName}`)
      }
      if (matches.length !== 1) {
        throw new Error(
          `Multiple analyzer snapshots are named: ${snapshotName}`
        )
      }
      id = matches[0].id
    } else {
      // Bare replay is convenient but a concurrent capture can change "latest".
      id ??= index.snapshots[0]?.id
    }
    if (!id || !index.snapshots.some((snapshot) => snapshot.id === id)) {
      throw new Error(`Analyzer snapshot not found: ${id ?? '(none)'}`)
    }
    await dumpAnalyzeGraph(analyzeDir, id, options.route, process.stdout)
    return
  }
  if (options.snapshot !== undefined || options.route !== undefined) {
    throw new Error('--snapshot and --route require --graph-json')
  }

  if (!mangling) {
    warn(
      `Mangling is disabled. ${italic('Note: This may affect performance and should only be used for debugging purposes.')}`
    )
  }

  if (profile) {
    warn(
      `Profiling is enabled. ${italic('Note: This may affect performance.')}`
    )
  }

  const dir = getProjectDir(directory)

  if (!existsSync(dir)) {
    printAndExit(`> No such directory exists as the project root: ${dir}`)
  }

  await analyze({
    dir,
    reactProductionProfiling: profile,
    noMangling: !mangling,
    appDirOnly: experimentalAppOnly,
    output,
    port,
    snapshotName,
  })
}

export { nextAnalyze }
