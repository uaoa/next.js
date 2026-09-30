import { execFileSync, spawnSync } from 'child_process'
import { mkdir, mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { processEnv, resetEnv, updateInitialEnv } from '@next/env'

import {
  assessUpgrade,
  getUpgradeContext,
  nudgeUpgrade,
  runUpgrade,
  shouldPromptForUpgrade,
} from 'next/dist/lib/upgrade/nudge'
import { promptUpgrade } from 'next/dist/lib/upgrade/prompt'
import Conf from 'next/dist/compiled/conf'
import { getAgentName } from 'next/dist/telemetry/agent-name'
import type { Telemetry } from 'next/dist/telemetry/storage'
import { getUpgradeAssessment } from 'next/dist/lib/upgrade/prepare-upgrade'
import { warn } from 'next/dist/build/output/log'
import { spawnNextUpgrade } from 'next/dist/cli/next-upgrade'
import { defaultConfig } from 'next/dist/server/config-shared'
import { recursiveDeleteSyncWithAsyncRetries } from 'next/dist/lib/recursive-delete'

jest.mock('next/dist/cli/next-upgrade', () => ({
  spawnNextUpgrade: jest.fn(),
}))
jest.mock(
  '../../packages/next/src/cli/next-upgrade.js',
  () => jest.requireMock('next/dist/cli/next-upgrade'),
  { virtual: true }
)

// Read source so version cases run before the package build inlines __NEXT_VERSION.
jest.mock('next/dist/lib/upgrade/nudge', () =>
  jest.requireActual('../../packages/next/src/lib/upgrade/nudge')
)
jest.mock('../../packages/next/src/telemetry/agent-name', () =>
  jest.requireMock('next/dist/telemetry/agent-name')
)
jest.mock('../../packages/next/src/lib/upgrade/prepare-upgrade', () =>
  jest.requireMock('next/dist/lib/upgrade/prepare-upgrade')
)
jest.mock('../../packages/next/src/build/output/log', () =>
  jest.requireMock('next/dist/build/output/log')
)

jest.mock('next/dist/telemetry/agent-name', () => ({
  getAgentName: jest.fn(),
}))
jest.mock('next/dist/lib/upgrade/prepare-upgrade', () => ({
  getPrereleaseChannel: jest.requireActual(
    'next/dist/lib/upgrade/prepare-upgrade'
  ).getPrereleaseChannel,
  getLatestUpgradeVersion: jest.requireActual(
    'next/dist/lib/upgrade/prepare-upgrade'
  ).getLatestUpgradeVersion,
  getUpgradeAssessment: jest.fn(),
}))
jest.mock('next/dist/build/output/log', () => ({
  warn: jest.fn(),
}))

jest.mock('../../packages/next/src/telemetry/post-telemetry-payload', () => ({
  postNextTelemetryPayload: jest.fn(),
}))

jest.mock('../../packages/next/src/server/ci-info', () => ({ isCI: false }))
jest.mock('../../packages/next/src/lib/upgrade/prompt', () =>
  jest.requireMock('next/dist/lib/upgrade/prompt')
)
jest.mock('next/dist/lib/upgrade/prompt', () => ({
  promptUpgrade: jest.fn(),
}))
let mockPreferencesDirectory: string
jest.mock('next/dist/compiled/conf', () => {
  const ActualConf = jest.requireActual('next/dist/compiled/conf')
  return class extends ActualConf {
    constructor(options: object) {
      super({ ...options, cwd: mockPreferencesDirectory })
    }
  }
})

function mockUpgrade(targetVersion = process.env.__NEXT_VERSION || '16.4.0') {
  const canary = process.env.__NEXT_VERSION?.includes('-canary.')
  jest.mocked(getUpgradeAssessment).mockResolvedValue({
    affected: canary ? null : false,
    reference: canary ? null : 'https://api.github.com/advisories?affects=next',
    upgrade: {
      status: 'ready',
      installedVersion: process.env.__NEXT_VERSION || '16.4.0',
      targetVersion,
      references: [],
      futureDefaults: [],
    },
  })
}

let directory: string
const initialNextVersion = process.env.__NEXT_VERSION
const initialRequestedUpgrade = process.env.__NEXT_AGENT_UPGRADE

const config = (
  policy: 'security' | 'latest' | 'experimental-future' | false,
  values: Record<string, unknown> = {}
) =>
  ({
    ...values,
    distDir: '.next',
    experimental: { agentUpgrade: policy },
  }) as never

it('defaults agentUpgrade to the security policy', () => {
  expect(defaultConfig.experimental.agentUpgrade).toBe('security')
  const context = getUpgradeContext(config('security'))
  expect(context.experimental.agentUpgrade).toBe('security')
})

function collectTelemetryEvents() {
  const events: Array<{
    eventName: string
    payload: Record<string, unknown>
  }> = []
  const telemetry = {
    isEnabled: true,
    record: jest.fn(async (event: (typeof events)[number]) => {
      events.push(event)
      return { isFulfilled: true, isRejected: false, value: undefined }
    }),
    flush: jest.fn(async () => []),
    flushDetached: jest.fn((_mode, _dir, _distDir, detachedEvents) => {
      events.push(...detachedEvents)
    }),
  }
  return {
    events,
    telemetry: telemetry as unknown as Telemetry & typeof telemetry,
  }
}

beforeEach(async () => {
  delete process.env.__NEXT_AGENT_UPGRADE
  process.env.__NEXT_VERSION = '16.4.0'
  directory = await mkdtemp(join(tmpdir(), 'security-upgrade-nudge-'))
  await mkdir(join(directory, 'app'))
})

afterEach(async () => {
  if (initialRequestedUpgrade === undefined) {
    delete process.env.__NEXT_AGENT_UPGRADE
  } else {
    process.env.__NEXT_AGENT_UPGRADE = initialRequestedUpgrade
  }
  if (initialNextVersion === undefined) {
    delete process.env.__NEXT_VERSION
  } else {
    process.env.__NEXT_VERSION = initialNextVersion
  }
  await rm(directory, { recursive: true, force: true })
})

// Exercise storage with real files so unrelated queued events cannot enter a nudge batch.
it('preserves isolated detached batches during build cleanup', async () => {
  const { Telemetry: ActualTelemetry } = jest.requireActual(
    '../../packages/next/src/telemetry/storage'
  )
  const originalDebug = process.env.NEXT_TELEMETRY_DEBUG
  process.env.NEXT_TELEMETRY_DEBUG = '1'
  const spawn = jest
    .spyOn(require('child_process'), 'spawnSync')
    .mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>)
  try {
    const telemetry = new ActualTelemetry({
      distDir: join(directory, '.next'),
      skipNotify: true,
    })
    const unrelated = { eventName: 'UNRELATED', payload: {} }
    const nudge = { eventName: 'NEXT_AI_UPGRADE_NUDGE_SHOWN', payload: {} }
    await telemetry.record(unrelated, true)
    telemetry.flushDetached('dev', directory, join(directory, '.next'), [nudge])
    const eventsFile = join(
      directory,
      '.next',
      'cache',
      spawn.mock.calls[0][1]![3]
    )
    await recursiveDeleteSyncWithAsyncRetries(
      join(directory, '.next'),
      new Set(['cache', 'dev', 'diagnostics', 'lock', 'trace'])
    )
    expect(JSON.parse(await readFile(eventsFile, 'utf8'))).toEqual([nudge])

    // The unrelated event remains available for the command's own shutdown flush.
    telemetry.flushDetached('dev', directory, join(directory, '.next'), null)
    const shutdownEventsFile = join(
      directory,
      '.next',
      'cache',
      spawn.mock.calls[1][1]![3]
    )
    expect(JSON.parse(await readFile(shutdownEventsFile, 'utf8'))).toEqual([
      unrelated,
    ])
    expect(JSON.parse(await readFile(eventsFile, 'utf8'))).toEqual([nudge])
  } finally {
    spawn.mockRestore()
    if (originalDebug === undefined) {
      delete process.env.NEXT_TELEMETRY_DEBUG
    } else {
      process.env.NEXT_TELEMETRY_DEBUG = originalDebug
    }
  }
})

it('bounds telemetry delivery when the transport waits for an abort', async () => {
  const { Telemetry: ActualTelemetry } = jest.requireActual(
    '../../packages/next/src/telemetry/storage'
  )
  const post = jest.requireMock(
    '../../packages/next/src/telemetry/post-telemetry-payload'
  ).postNextTelemetryPayload
  const originalDisabled = process.env.NEXT_TELEMETRY_DISABLED
  const originalDebug = process.env.NEXT_TELEMETRY_DEBUG
  const originalPreferencesDirectory = mockPreferencesDirectory
  mockPreferencesDirectory = join(directory, 'preferences')
  delete process.env.NEXT_TELEMETRY_DISABLED
  delete process.env.NEXT_TELEMETRY_DEBUG
  let signal: AbortSignal | null = null
  let transportStarted: () => void
  const started = new Promise<void>((resolve) => {
    transportStarted = resolve
  })
  post.mockImplementationOnce((_payload: unknown, inputSignal: AbortSignal) => {
    signal = inputSignal
    transportStarted()
    return new Promise<void>((_resolve, reject) => {
      inputSignal.addEventListener('abort', () => reject(new Error('Aborted')))
    })
  })
  const telemetry = new ActualTelemetry({
    distDir: join(directory, '.next'),
    skipNotify: true,
  })
  jest.useFakeTimers()
  try {
    const pending = telemetry.record({
      eventName: 'NEXT_AI_UPGRADE_RUN_STARTED',
      payload: {},
    })
    await started
    expect(signal!.aborted).toBe(false)
    await jest.advanceTimersByTimeAsync(5000)
    expect(signal!.aborted).toBe(true)
    await expect(pending).resolves.toMatchObject({ isRejected: true })
    await expect(telemetry.flush()).resolves.toEqual([])
  } finally {
    jest.useRealTimers()
    post.mockReset()
    mockPreferencesDirectory = originalPreferencesDirectory
    if (originalDisabled === undefined) {
      delete process.env.NEXT_TELEMETRY_DISABLED
    } else {
      process.env.NEXT_TELEMETRY_DISABLED = originalDisabled
    }
    if (originalDebug === undefined) {
      delete process.env.NEXT_TELEMETRY_DEBUG
    } else {
      process.env.NEXT_TELEMETRY_DEBUG = originalDebug
    }
  }
})

it('derives project identity from the requested directory across repositories', async () => {
  const { getRawProjectId } = jest.requireActual(
    '../../packages/next/src/telemetry/project-id'
  )
  const repositories = [join(directory, 'first'), join(directory, 'second')]
  for (const [index, repository] of repositories.entries()) {
    execFileSync('git', ['init', repository], { stdio: 'ignore' })
    execFileSync('git', [
      '-C',
      repository,
      'remote',
      'add',
      'origin',
      `https://example.com/project-${index}.git`,
    ])
  }
  expect(await getRawProjectId(repositories[0])).toBe(
    'https://example.com/project-0.git'
  )
  expect(await getRawProjectId(repositories[1])).toBe(
    'https://example.com/project-1.git'
  )

  // A CLI launched from the first repository must attribute both events to the second app.
  const { Telemetry: ActualTelemetry } = jest.requireActual(
    '../../packages/next/src/telemetry/storage'
  )
  const transport = jest.requireMock(
    '../../packages/next/src/telemetry/post-telemetry-payload'
  )
  const post = transport.postNextTelemetryPayload
  post.mockClear()
  post.mockResolvedValue(undefined)
  const cwd = jest.spyOn(process, 'cwd').mockReturnValue(repositories[0])
  const originalDisabled = process.env.NEXT_TELEMETRY_DISABLED
  const originalPreferencesDirectory = mockPreferencesDirectory
  mockPreferencesDirectory = join(directory, 'preferences')
  delete process.env.NEXT_TELEMETRY_DISABLED
  try {
    const nudge = new ActualTelemetry({
      distDir: join(repositories[1], '.next'),
      skipNotify: true,
    })
    nudge.projectDir = repositories[1]
    await nudge.record({
      eventName: 'NEXT_AI_UPGRADE_NUDGE_SHOWN',
      payload: {},
    })

    const run = new ActualTelemetry({
      distDir: join(repositories[1], '.next'),
      skipNotify: true,
    })
    run.projectDir = repositories[1]
    await run.record({ eventName: 'NEXT_AI_UPGRADE_RUN_STARTED', payload: {} })

    expect(post).toHaveBeenCalledTimes(2)
    const nudgeContext = post.mock.calls[0][0].context
    const runContext = post.mock.calls[1][0].context
    expect(nudgeContext.projectId).toBe(runContext.projectId)
    expect(nudgeContext.anonymousId).toBe(runContext.anonymousId)
    expect(nudgeContext.projectId).toBe(
      nudge.oneWayHash('https://example.com/project-1.git')
    )
  } finally {
    post.mockReset()
    cwd.mockRestore()
    mockPreferencesDirectory = originalPreferencesDirectory
    if (originalDisabled === undefined) {
      delete process.env.NEXT_TELEMETRY_DISABLED
    } else {
      process.env.NEXT_TELEMETRY_DISABLED = originalDisabled
    }
  }
})

describe('security upgrade nudge', () => {
  const originalNextVersion = process.env.__NEXT_VERSION

  const run = (command: 'dev' | 'build' = 'build') =>
    nudgeUpgrade(directory, config('security'), command, null, null, null)

  beforeEach(() => {
    jest.resetAllMocks()
    process.env.__NEXT_VERSION = '13.0.0'
    jest.mocked(getAgentName).mockResolvedValue('codex')
    mockUpgrade()
  })

  afterAll(() => {
    if (originalNextVersion === undefined) {
      delete process.env.__NEXT_VERSION
    } else {
      process.env.__NEXT_VERSION = originalNextVersion
    }
  })

  it('shows a security advisory and the upgrade command', async () => {
    jest.mocked(getUpgradeAssessment).mockResolvedValue({
      affected: true,
      upgrade: {
        status: 'ready',
        installedVersion: '13.0.0',
        targetVersion: '17.2.1',
        references: [],
        futureDefaults: [],
      },
      reference: 'https://api.github.com/advisories?affects=next%4013.0.0',
    })

    await expect(run()).rejects.toMatchObject({
      name: 'SecurityFatalError',
      exitCode: 1,
      message: expect.stringMatching(
        /affected by a known security vulnerability[\s\S]*\*\*We strongly recommend you upgrade Next\.js\.\*\*[\s\S]*upgrade recommendation\. Retry the same command to continue the original task\.[\s\S]*include this upgrade recommendation even if the retry succeeds\.[\s\S]*ask the user once:[\s\S]*in a separate Git worktree\?[\s\S]*Use their worktree choice and continue in this agent session[\s\S]*Run this command from this app's directory:[\s\S]*next upgrade --ai=(?:security|latest|experimental-future)/
      ),
    })
    expect(warn).not.toHaveBeenCalled()
  })

  it('shows the npm fallback reference', async () => {
    jest.mocked(getUpgradeAssessment).mockResolvedValue({
      affected: true,
      upgrade: {
        status: 'ready',
        installedVersion: '13.0.0',
        targetVersion: '17.2.1',
        references: [],
        futureDefaults: [],
      },
      reference: 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk',
    })

    await expect(run()).rejects.toMatchObject({
      name: 'SecurityFatalError',
      exitCode: 1,
      message: expect.stringMatching(
        /affected by a known security vulnerability[\s\S]*registry\.npmjs\.org/
      ),
    })
    expect(warn).not.toHaveBeenCalled()
  })

  it.each(['blocked', 'unknown'] as const)(
    'skips the security nudge when target eligibility is %s',
    async (status) => {
      jest.mocked(getUpgradeAssessment).mockResolvedValue({
        reference: 'https://api.github.com/advisories?affects=next',
        affected: true,
        upgrade: { status, reason: 'Target assessment detail.' },
      })
      await expect(run()).resolves.toBeUndefined()
      expect(warn).not.toHaveBeenCalled()
    }
  )

  it('reuses the startup assessment for the agent nudge', async () => {
    const assessment = assessUpgrade(directory, config('security'), '13.0.0')

    await expect(
      nudgeUpgrade(directory, config('security'), 'dev', null, assessment, null)
    ).resolves.toBeUndefined()

    expect(getUpgradeAssessment).toHaveBeenCalledTimes(1)
  })

  it('stays silent when the version is unaffected', async () => {
    await run()

    expect(getUpgradeAssessment).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('stays silent when canary security assessment is unsupported', async () => {
    jest.mocked(getUpgradeAssessment).mockResolvedValue({
      affected: null,
      reference: null,
      upgrade: {
        status: 'blocked',
        reason:
          'Security upgrades are not supported for canary versions of Next.js.',
      },
    })
    await expect(run()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(0)
    expect(getUpgradeAssessment).toHaveBeenCalledTimes(1)
  })

  it('stays silent when no security advisory matches', async () => {
    mockUpgrade()

    await run()

    expect(warn).not.toHaveBeenCalled()
  })

  it('does not look up advisories or warn outside an agent', async () => {
    jest.mocked(getAgentName).mockResolvedValue(null)

    await run()

    expect(getUpgradeAssessment).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns without rejecting when advisory lookup fails', async () => {
    jest
      .mocked(getUpgradeAssessment)
      .mockRejectedValue(new Error('Advisory service unavailable'))

    await expect(run()).resolves.toBeUndefined()

    expect(jest.mocked(warn).mock.calls).toMatchInlineSnapshot(`
     [
       [
         "Could not check Next.js security advisories. Continuing without an upgrade assessment.",
       ],
     ]
    `)
  })

  it('allows one matching retry with a warning', async () => {
    jest.mocked(getUpgradeAssessment).mockResolvedValue({
      affected: true,
      upgrade: {
        status: 'ready',
        installedVersion: '13.0.0',
        targetVersion: '17.2.1',
        references: [],
        futureDefaults: [],
      },
      reference: 'https://api.github.com/advisories?affects=next%4013.0.0',
    })

    await expect(run('build')).rejects.toMatchObject({
      name: 'SecurityFatalError',
    })
    await expect(run('build')).resolves.toBeUndefined()

    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /continuing after the upgrade reminder[\s\S]*Reference:/
      )
    )
  })

  it('keeps an accepted dev retry through a worker restart but not a new session', async () => {
    const reminder = Promise.resolve({
      kind: 'security' as const,
      policy: 'security' as const,
      installedVersion: '13.0.0',
      targetVersion: '17.2.1',
      reference: 'https://api.github.com/advisories?affects=next%4013.0.0',
    })
    const originalWorker = process.env.NEXT_PRIVATE_WORKER
    const originalRetries = process.env.NEXT_PRIVATE_ALLOWED_UPGRADE_RETRIES
    const originalSend = process.send
    const send = jest.fn(
      (_message: unknown, callback: (error: Error | null) => void) => {
        callback(null)
      }
    )

    try {
      process.env.NEXT_PRIVATE_WORKER = '1'
      process.send = send as unknown as typeof process.send

      await expect(
        nudgeUpgrade(directory, config('security'), 'dev', null, reminder, null)
      ).rejects.toMatchObject({ name: 'SecurityFatalError' })
      await expect(
        nudgeUpgrade(directory, config('security'), 'dev', null, reminder, null)
      ).resolves.toBeUndefined()

      const message = send.mock.calls[0]?.[0] as {
        nextUpgradeRetryAllowed: string
      }
      expect(message.nextUpgradeRetryAllowed).toMatch(/^[a-f0-9]{64}$/)

      process.env.NEXT_PRIVATE_ALLOWED_UPGRADE_RETRIES =
        message.nextUpgradeRetryAllowed
      let restartedNudge: typeof nudgeUpgrade
      jest.isolateModules(() => {
        restartedNudge = jest.requireActual<{
          nudgeUpgrade: typeof nudgeUpgrade
        }>('../../packages/next/src/lib/upgrade/nudge').nudgeUpgrade
        jest
          .mocked(
            jest.requireMock<typeof import('next/dist/telemetry/agent-name')>(
              'next/dist/telemetry/agent-name'
            ).getAgentName
          )
          .mockResolvedValue('codex')
      })
      await expect(
        restartedNudge!(
          directory,
          config('security'),
          'dev',
          null,
          reminder,
          null
        )
      ).resolves.toBeUndefined()
      expect(send).toHaveBeenCalledTimes(1)

      delete process.env.NEXT_PRIVATE_ALLOWED_UPGRADE_RETRIES
      let newSessionNudge: typeof nudgeUpgrade
      jest.isolateModules(() => {
        newSessionNudge = jest.requireActual<{
          nudgeUpgrade: typeof nudgeUpgrade
        }>('../../packages/next/src/lib/upgrade/nudge').nudgeUpgrade
        jest
          .mocked(
            jest.requireMock<typeof import('next/dist/telemetry/agent-name')>(
              'next/dist/telemetry/agent-name'
            ).getAgentName
          )
          .mockResolvedValue('codex')
      })
      await expect(
        newSessionNudge!(
          directory,
          config('security'),
          'dev',
          null,
          reminder,
          null
        )
      ).rejects.toMatchObject({ name: 'SecurityFatalError' })
    } finally {
      process.send = originalSend
      if (originalWorker === undefined) {
        delete process.env.NEXT_PRIVATE_WORKER
      } else {
        process.env.NEXT_PRIVATE_WORKER = originalWorker
      }
      if (originalRetries === undefined) {
        delete process.env.NEXT_PRIVATE_ALLOWED_UPGRADE_RETRIES
      } else {
        process.env.NEXT_PRIVATE_ALLOWED_UPGRADE_RETRIES = originalRetries
      }
    }
  })

  it('keeps dev and build retry receipts independent', async () => {
    jest.mocked(getUpgradeAssessment).mockResolvedValue({
      affected: true,
      upgrade: {
        status: 'ready',
        installedVersion: '13.0.0',
        targetVersion: '17.2.1',
        references: [],
        futureDefaults: [],
      },
      reference: 'https://api.github.com/advisories?affects=next%4013.0.0',
    })

    await expect(run('build')).rejects.toMatchObject({
      name: 'SecurityFatalError',
    })
    await expect(run('dev')).rejects.toMatchObject({
      name: 'SecurityFatalError',
    })
    await expect(run('build')).resolves.toBeUndefined()
  })
})
describe('latest nudge release selection', () => {
  const { getLatestUpgradeVersion: readLatestUpgradeVersion } =
    jest.requireActual<typeof import('next/dist/lib/upgrade/prepare-upgrade')>(
      'next/dist/lib/upgrade/prepare-upgrade'
    )

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it.each<[string, string, string | null]>([
    ['15.5.9', '16.0.0', '16.0.0'],
    ['16.0.9', '16.1.0', '16.1.0'],
    ['16.1.0', '16.1.1', null],
    ['16.1.1', '16.1.1', null],
    ['16.2.0', '16.1.1', null],
    ['16.1.0', '17.0.0-canary.1', null],
    ['16.1.0-canary.1', '16.1.0', null],
    ['16.0.0-canary.1', '16.1.0', null],
    ['17.2.0-canary.4', '17.2.0-canary.9', null],
    ['17.2.0-canary.9', '17.2.0-canary.10', null],
    ['17.2.0-canary.4', '17.2.1-canary.0', null],
    ['17.2.0-canary.4', '17.3.0-canary.0', '17.3.0-canary.0'],
    ['17.2.0-canary.4', '18.0.0-canary.0', '18.0.0-canary.0'],
    ['17.2.0-canary.4', '17.2.0-canary.4', null],
    ['17.2.0-canary.4', '17.1.0-canary.99', null],
    ['17.2.0-canary.4', '17.3.0-rc.1', null],
    ['17.2.0-rc.1', '17.3.0', '17.3.0'],
    ['17.2.0-rc.1', '17.2.0', '17.2.0'],
    ['17.2.0-rc.1', '17.2.0-rc.2', null],
    ['17.2.0-beta.1', '17.2.0', '17.2.0'],
    ['17.2.0-beta.1', '18.0.0-beta.1', null],
    ['17.2.0-preview.1', '17.2.0', '17.2.0'],
    ['17.2.0-rc.1', '17.3.0-rc.1', null],
    ['17.2.0-beta.1', '17.3.0-beta.1', null],
    ['17.2.0-preview.1', '17.3.0-preview.1', null],
    ['17.2.0-rc.1', '17.3.0-beta.1', null],
    ['16.4.0-preview-84cee7e6-20260917', '17.0.0', null],
  ])(
    'selects an eligible latest reminder for %s → %s',
    async (installed, latest, expected) => {
      expect(readLatestUpgradeVersion(installed, latest)).toBe(expected)
    }
  )
})

describe('latest upgrade nudge', () => {
  beforeEach(() => {
    jest.resetAllMocks()
    jest.mocked(getAgentName).mockResolvedValue('codex')
    mockUpgrade()
  })

  it.each(['latest', 'experimental-future'] as const)(
    'links a canary %s reminder to the selected channel',
    async (policy) => {
      process.env.__NEXT_VERSION = '17.2.0-canary.4'
      mockUpgrade('17.3.0-canary.1')
      await expect(
        nudgeUpgrade(directory, config(policy), 'build', null, null, null)
      ).rejects.toMatchObject({
        name: 'UpgradeNudgeError',
        message: expect.stringContaining(
          'Reference: https://registry.npmjs.org/next/canary'
        ),
      })
      await expect(
        nudgeUpgrade(directory, config(policy), 'build', null, null, null)
      ).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'Reference: https://registry.npmjs.org/next/canary'
        )
      )
    }
  )

  it.each(['rc', 'beta', 'preview'] as const)(
    'links a verified %s latest reminder to stable latest',
    async (channel) => {
      process.env.__NEXT_VERSION = `17.2.0-${channel}.1`
      mockUpgrade('17.2.0')
      await expect(
        nudgeUpgrade(directory, config('latest'), 'build', null, null, null)
      ).rejects.toMatchObject({
        name: 'UpgradeNudgeError',
        message: expect.stringContaining(
          'Reference: https://registry.npmjs.org/next/latest'
        ),
      })
      expect(getUpgradeAssessment).toHaveBeenCalledWith(
        `17.2.0-${channel}.1`,
        'latest',
        false
      )
    }
  )

  it('stops once and allows a matching retry with a warning', async () => {
    mockUpgrade('17.0.0')

    await expect(
      nudgeUpgrade(directory, config('latest'), 'build', null, null, null)
    ).rejects.toMatchObject({
      name: 'UpgradeNudgeError',
      exitCode: 1,
      message: expect.stringMatching(
        /Next\.js 17\.0\.0 is available\.[\s\S]*\*\*We recommend you upgrade Next\.js\.\*\*[\s\S]*upgrade recommendation\. Retry the same command to continue the original task\.[\s\S]*include this upgrade recommendation even if the retry succeeds\.[\s\S]*ask the user once:[\s\S]*in a separate Git worktree\?[\s\S]*Use their worktree choice and continue in this agent session[\s\S]*Run this command from this app's directory:[\s\S]*next upgrade --ai=(?:security|latest|experimental-future)[\s\S]*registry\.npmjs\.org/
      ),
    })
    await expect(
      nudgeUpgrade(directory, config('latest'), 'build', null, null, null)
    ).resolves.toBeUndefined()

    expect(getUpgradeAssessment).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /Next\.js 17\.0\.0 is available\.[\s\S]*continuing after the upgrade reminder[\s\S]*registry\.npmjs\.org/
      )
    )
  })

  it.each(['linux', 'win32'] as const)(
    'shows an upgrade command for %s shells',
    async (platform) => {
      mockUpgrade('17.0.0')
      const originalPlatform = Object.getOwnPropertyDescriptor(
        process,
        'platform'
      )!
      Object.defineProperty(process, 'platform', { value: platform })
      try {
        const error = await nudgeUpgrade(
          directory,
          config('latest'),
          'build',
          null,
          null,
          null
        ).catch((reason) => reason)
        expect(error).toMatchObject({ name: 'UpgradeNudgeError' })
        const message = (error as Error).message
        expect(message).not.toContain('--ai-nudge-id')
        if (platform === 'win32') {
          const powershellId = message.match(
            /\$env:__NEXT_AI_UPGRADE_NUDGE_ID = '([0-9a-f-]{36})'/
          )?.[1]
          const cmdId = message.match(
            /cmd \/C "set __NEXT_AI_UPGRADE_NUDGE_ID=([0-9a-f-]{36})&& next upgrade --ai=latest"/
          )?.[1]
          expect(message).toContain(
            '$previousNudgeId = $env:__NEXT_AI_UPGRADE_NUDGE_ID'
          )
          expect(message).toContain('} finally {')
          expect(message).toContain('if ($LASTEXITCODE -ne 0) {')
          expect(message).toContain(
            'throw "next upgrade exited with code $LASTEXITCODE"'
          )
          expect(message.indexOf('next upgrade --ai=latest')).toBeLessThan(
            message.indexOf('if ($LASTEXITCODE -ne 0) {')
          )
          expect(message.indexOf('if ($LASTEXITCODE -ne 0) {')).toBeLessThan(
            message.indexOf('} finally {')
          )
          expect(message).toContain(
            'Remove-Item Env:__NEXT_AI_UPGRADE_NUDGE_ID -ErrorAction SilentlyContinue'
          )
          expect(message).toContain(
            '$env:__NEXT_AI_UPGRADE_NUDGE_ID = $previousNudgeId'
          )
          expect(powershellId).toMatch(/^[0-9a-f-]{36}$/)
          expect(cmdId).toBe(powershellId)
        } else {
          expect(message).toMatch(
            /```\n__NEXT_AI_UPGRADE_NUDGE_ID=[0-9a-f-]{36} next upgrade --ai=latest\n```/
          )
        }
      } finally {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  )

  it('records the policy and full agent nudge but not its retry warning', async () => {
    mockUpgrade('17.0.0')
    const { events, telemetry } = collectTelemetryEvents()

    await expect(
      nudgeUpgrade(directory, config('latest'), 'build', null, null, {
        telemetry,
        onNudgeId: null,
      })
    ).rejects.toMatchObject({ name: 'UpgradeNudgeError' })
    await nudgeUpgrade(directory, config('latest'), 'build', null, null, {
      telemetry,
      onNudgeId: null,
    })

    expect(
      events.filter(
        (event) => event.eventName === 'NEXT_AI_UPGRADE_NUDGE_SHOWN'
      )
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          recipient: 'agent',
          agentProduct: 'codex',
          policy: 'latest',
          nudgeKind: 'latest',
          sourceCommand: 'build',
          nudgeId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        }),
      }),
    ])
    expect(
      events.filter(
        (event) => event.eventName === 'NEXT_AI_UPGRADE_POLICY_OBSERVED'
      )
    ).toHaveLength(2)
    expect(
      telemetry.record.mock.calls.map(([event]) => event.eventName)
    ).toEqual(['NEXT_AI_UPGRADE_POLICY_OBSERVED'])
    expect(telemetry.flushDetached).toHaveBeenCalledWith(
      'dev',
      directory,
      join(directory, '.next'),
      [
        expect.objectContaining({
          eventName: 'NEXT_AI_UPGRADE_POLICY_OBSERVED',
        }),
        expect.objectContaining({ eventName: 'NEXT_AI_UPGRADE_NUDGE_SHOWN' }),
      ]
    )
  })

  it('does not wait for telemetry delivery before stopping an agent command', async () => {
    mockUpgrade('17.0.0')
    const { telemetry } = collectTelemetryEvents()
    telemetry.record.mockImplementation(() => new Promise<never>(() => {}))

    await expect(
      nudgeUpgrade(directory, config('latest'), 'build', null, null, {
        telemetry,
        onNudgeId: null,
      })
    ).rejects.toMatchObject({ name: 'UpgradeNudgeError' })
    expect(telemetry.flushDetached).toHaveBeenCalledTimes(1)
    expect(telemetry.record).toHaveBeenCalledTimes(0)
  })

  it.each([false, true])(
    'records agent policy without a nudge when assessment fails: %s',
    async (fails) => {
      const { events, telemetry } = collectTelemetryEvents()
      const assessment = fails
        ? Promise.reject(new Error('Assessment failed'))
        : Promise.resolve(null)

      const pending = nudgeUpgrade(
        directory,
        config('security'),
        'dev',
        null,
        assessment,
        { telemetry, onNudgeId: null }
      )
      if (fails) {
        await expect(pending).rejects.toThrow('Assessment failed')
      } else {
        await expect(pending).resolves.toBeUndefined()
      }
      expect(events.map(({ eventName }) => eventName)).toEqual([
        'NEXT_AI_UPGRADE_POLICY_OBSERVED',
      ])
      expect(telemetry.flushDetached).toHaveBeenCalledTimes(0)
    }
  )

  it.each(['latest', 'experimental-future'] as const)(
    'does not offer an unsafe %s target or fall through to Future adoption',
    async (policy) => {
      jest.mocked(getUpgradeAssessment).mockResolvedValue({
        affected: false,
        reference: 'https://api.github.com/advisories',
        upgrade: { status: 'blocked', reason: 'The target is affected.' },
      })
      await expect(
        nudgeUpgrade(
          directory,
          config(policy, { cacheComponents: false }),
          'build',
          null,
          null,
          null
        )
      ).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(0)
      expect(getUpgradeAssessment).toHaveBeenCalledTimes(1)
    }
  )

  it('stays silent when there is no newer stable release', async () => {
    await nudgeUpgrade(directory, config('latest'), 'build', null, null, null)

    expect(getUpgradeAssessment).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('does not look up releases or log outside an agent', async () => {
    jest.mocked(getAgentName).mockResolvedValue(null)

    await nudgeUpgrade(directory, config('latest'), 'build', null, null, null)

    expect(getUpgradeAssessment).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('stays silent without rejecting when release lookup fails', async () => {
    jest.mocked(getUpgradeAssessment).mockResolvedValue({
      affected: false,
      reference: 'https://api.github.com/advisories',
      upgrade: { status: 'unknown', reason: 'Registry unavailable' },
    })

    await expect(
      nudgeUpgrade(directory, config('latest'), 'build', null, null, null)
    ).resolves.toBeUndefined()

    expect(warn).not.toHaveBeenCalled()
  })
})

describe('composed latest nudge', () => {
  beforeEach(() => {
    jest.resetAllMocks()
    jest.mocked(getAgentName).mockResolvedValue('codex')
    mockUpgrade('17.0.0')
  })

  it.each(['latest', 'experimental-future'] as const)(
    'preserves the %s policy when security takes priority',
    async (policy) => {
      jest.mocked(getUpgradeAssessment).mockResolvedValue({
        affected: true,
        upgrade: {
          status: 'ready',
          installedVersion: '13.0.0',
          targetVersion: '17.2.1',
          references: [],
          futureDefaults: [],
        },
        reference: 'https://api.github.com/advisories?affects=next%4015.0.0',
      })

      const nudge = nudgeUpgrade(
        directory,
        config(policy),
        'build',
        null,
        null,
        null
      )
      await expect(nudge).rejects.toMatchObject({
        name: 'SecurityFatalError',
        exitCode: 1,
        message: expect.stringContaining(`next upgrade --ai=${policy}`),
      })
      await expect(nudge).rejects.toMatchObject({
        message: expect.stringContaining(
          'This command stopped to show the upgrade recommendation.'
        ),
      })

      expect(getUpgradeAssessment).toHaveBeenCalledWith(
        expect.any(String),
        policy,
        false
      )
      expect(warn).not.toHaveBeenCalled()
      expect(getUpgradeAssessment).toHaveBeenCalledTimes(1)
    }
  )
})

describe('composed future nudge', () => {
  beforeEach(() => {
    jest.resetAllMocks()
    jest.mocked(getAgentName).mockResolvedValue('codex')
    mockUpgrade()
  })

  it('does not offer defaults before stable availability on canary', async () => {
    const version = '16.3.0-canary.1'
    await expect(
      assessUpgrade(
        directory,
        config('experimental-future', { cacheComponents: false }),
        version
      )
    ).resolves.toBeNull()
  })

  it('offers available defaults on canary without a version reminder', async () => {
    await expect(
      assessUpgrade(
        directory,
        config('experimental-future', { cacheComponents: false }),
        '16.4.0-canary.1'
      )
    ).resolves.toEqual({
      kind: 'experimental-future',
      policy: 'experimental-future',
      installedVersion: '16.4.0-canary.1',
      targetVersion: '16.4.0',
      names: ['Cache Components'],
    })
  })

  it('does not remind about defaults already adopted on canary', async () => {
    await expect(
      assessUpgrade(
        directory,
        config('experimental-future', { cacheComponents: true }),
        '16.4.0-canary.1'
      )
    ).resolves.toBeNull()
  })

  it('offers canary Future adoption when advisory assessment is skipped', async () => {
    process.env.__NEXT_VERSION = '17.2.0-canary.4'
    mockUpgrade()
    await expect(
      nudgeUpgrade(
        directory,
        config('experimental-future', { cacheComponents: false }),
        'build',
        null,
        null,
        null
      )
    ).rejects.toMatchObject({
      name: 'UpgradeNudgeError',
      message: expect.stringMatching(
        /We recommend you adopt these Future Defaults\.[\s\S]*include this upgrade recommendation even if the retry succeeds\./
      ),
    })
    expect(getUpgradeAssessment).toHaveBeenCalledTimes(1)
  })

  it('names available Future Defaults using the adapter', async () => {
    await expect(
      assessUpgrade(
        directory,
        config('experimental-future', { cacheComponents: false }),
        '16.4.0'
      )
    ).resolves.toEqual({
      kind: 'experimental-future',
      policy: 'experimental-future',
      installedVersion: '16.4.0',
      targetVersion: '16.4.0',
      names: ['Cache Components'],
    })
  })

  it('does not offer Cache Components to a Pages-only app', async () => {
    await rm(join(directory, 'app'), { recursive: true })
    await mkdir(join(directory, 'pages'))
    await expect(
      assessUpgrade(
        directory,
        config('experimental-future', { cacheComponents: false }),
        '16.4.0'
      )
    ).resolves.toBeNull()
  })

  it('stays silent when all available Future Defaults are adopted', async () => {
    await expect(
      assessUpgrade(
        directory,
        config('experimental-future', { cacheComponents: true }),
        '16.4.0'
      )
    ).resolves.toBeNull()
  })

  it('stops for a required latest upgrade before Future Defaults', async () => {
    mockUpgrade('17.0.0')

    await expect(
      nudgeUpgrade(
        directory,
        config('experimental-future', { cacheComponents: false }),
        'build',
        null,
        null,
        null
      )
    ).rejects.toMatchObject({
      name: 'UpgradeNudgeError',
      message: expect.stringMatching(
        /Next\.js 17\.0\.0 is available[\s\S]*include this upgrade recommendation even if the retry succeeds\.[\s\S]*next upgrade --ai=(?:security|latest|experimental-future)/
      ),
    })
  })
})

describe('human upgrade nudge', () => {
  const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  const terminal = process.env.TERM
  const securityAssessment = {
    affected: true,
    reference: 'https://example.com/advisory',
    upgrade: {
      status: 'ready' as const,
      installedVersion: '16.4.0',
      targetVersion: '17.0.0',
      references: [],
      futureDefaults: [],
    },
  }
  const run = (
    policy:
      | 'security'
      | 'latest'
      | 'experimental-future' = 'experimental-future',
    signal = new AbortController().signal
  ) => nudgeUpgrade(directory, config(policy), 'build', signal, null, null)

  beforeEach(() => {
    jest.resetAllMocks()
    mockPreferencesDirectory = join(directory, 'preferences')
    jest.requireMock('../../packages/next/src/server/ci-info').isCI = false
    for (const stream of [process.stdin, process.stdout]) {
      Object.defineProperty(stream, 'isTTY', {
        configurable: true,
        value: true,
      })
    }
    process.env.TERM = 'xterm'
    jest.mocked(getAgentName).mockResolvedValue(null)
    jest.mocked(getUpgradeAssessment).mockResolvedValue(securityAssessment)
    jest.mocked(promptUpgrade).mockResolvedValue('skip')
  })

  it('links a rendered human nudge to its selected action', async () => {
    const { events, telemetry } = collectTelemetryEvents()
    let selectedNudgeId: string | null = null
    jest
      .mocked(promptUpgrade)
      .mockImplementationOnce(
        async (_message, _signal, _canUpdate, onShown) => {
          onShown?.()
          return 'update'
        }
      )

    await expect(
      nudgeUpgrade(
        directory,
        config('security'),
        'build',
        new AbortController().signal,
        null,
        {
          telemetry,
          onNudgeId(id) {
            selectedNudgeId = id
          },
        }
      )
    ).resolves.toBe('update')

    expect(events.map((event) => event.eventName)).toEqual([
      'NEXT_AI_UPGRADE_POLICY_OBSERVED',
      'NEXT_AI_UPGRADE_NUDGE_SHOWN',
      'NEXT_AI_UPGRADE_NUDGE_ACTION',
    ])
    expect(events[1].payload.nudgeId).toBe(selectedNudgeId)
    expect(events[2].payload).toMatchObject({
      nudgeId: selectedNudgeId,
      action: 'update',
    })
  })

  afterEach(() => {
    jest.restoreAllMocks()
    for (const [stream, descriptor] of [
      [process.stdin, stdinTTY],
      [process.stdout, stdoutTTY],
    ] as const) {
      if (descriptor) {
        Object.defineProperty(stream, 'isTTY', descriptor)
      } else {
        delete stream.isTTY
      }
    }
    if (terminal === undefined) {
      delete process.env.TERM
    } else {
      process.env.TERM = terminal
    }
  })

  it('reuses the startup assessment for the human prompt', async () => {
    const assessment = assessUpgrade(directory, config('security'), '16.4.0')

    await expect(
      nudgeUpgrade(
        directory,
        config('security'),
        'dev',
        new AbortController().signal,
        assessment,
        null
      )
    ).resolves.toBe('skip')

    expect(getUpgradeAssessment).toHaveBeenCalledTimes(1)
    expect(promptUpgrade).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      'security',
      '17.0.0',
      '⚠ Installed Next.js version 16.4.0 is affected by a known security vulnerability.\n\nNext.js security version upgrade available: 16.4.0 -> 17.0.0',
    ],
    [
      'latest',
      '17.0.0',
      'Next.js latest version upgrade available: 16.4.0 -> 17.0.0',
    ],
    [
      'experimental-future',
      '17.0.0',
      'Next.js Future Default upgrade available: 16.4.0 -> 17.0.0\n\n- Cache Components',
    ],
    [
      'experimental-future',
      '16.4.1',
      'Next.js Future Default upgrade available: 16.4.0 -> 16.4.1\n\n- Cache Components',
    ],
    [
      'experimental-future',
      '16.4.0',
      'Next.js Future Default upgrade available:\n\n- Cache Components',
    ],
  ] as const)(
    'renders concise %s copy for target %s',
    async (policy, targetVersion, message) => {
      if (policy !== 'security') {
        mockUpgrade(targetVersion)
      }
      await expect(run(policy)).resolves.toBe('skip')
      expect(promptUpgrade).toHaveBeenCalledWith(
        message,
        expect.any(AbortSignal),
        true,
        null
      )
      jest.mocked(getAgentName).mockResolvedValue('codex')
      await expect(run(policy)).rejects.toMatchObject({
        message: expect.stringContaining(`next upgrade --ai=${policy}`),
      })
    }
  )

  it('omits already adopted defaults from a future version upgrade', async () => {
    mockUpgrade('17.0.0')
    await nudgeUpgrade(
      directory,
      config('experimental-future', { cacheComponents: true }),
      'build',
      new AbortController().signal,
      null,
      null
    )
    expect(promptUpgrade).toHaveBeenCalledWith(
      'Next.js Future Default upgrade available: 16.4.0 -> 17.0.0',
      expect.any(AbortSignal),
      true,
      null
    )
  })

  it.each(['update', 'skip', 'interrupt'] as const)(
    'returns %s without saving a dismissal',
    async (action) => {
      jest.mocked(promptUpgrade).mockResolvedValue(action)
      await expect(run()).resolves.toBe(action)
      expect(promptUpgrade).toHaveBeenCalledWith(
        '⚠ Installed Next.js version 16.4.0 is affected by a known security vulnerability.\n\nNext.js security version upgrade available: 16.4.0 -> 17.0.0',
        expect.any(AbortSignal),
        true,
        null
      )
      await expect(run()).resolves.toBe(action)
      expect(promptUpgrade).toHaveBeenCalledTimes(2)
    }
  )

  it.each(['security', 'latest', 'experimental-future'] as const)(
    'does not force a %s nudge without a valid installed version',
    async (policy) => {
      process.env.__NEXT_AGENT_UPGRADE = policy
      process.env.__NEXT_VERSION = 'not-a-version'
      processEnv([], directory)
      updateInitialEnv({ __NEXT_AGENT_UPGRADE: policy })
      for (const configured of [false, 'experimental-future'] as const) {
        const original = config(configured)
        const context = getUpgradeContext(original)
        expect(context.experimental.agentUpgrade).toBe(policy)
        await expect(
          nudgeUpgrade(
            directory,
            context,
            'dev',
            new AbortController().signal,
            null,
            null
          )
        ).resolves.toBeUndefined()
      }
      expect(promptUpgrade).not.toHaveBeenCalled()
      expect(getUpgradeAssessment).not.toHaveBeenCalled()
      jest.mocked(getAgentName).mockResolvedValue('codex')
      await expect(run(policy)).resolves.toBeUndefined()
    }
  )

  it.each(['security', 'latest', 'experimental-future'] as const)(
    'runs an explicitly requested %s upgrade',
    async (policy) => {
      process.env.__NEXT_AGENT_UPGRADE = policy
      process.env.__NEXT_VERSION = '16.4.0-preview-test'
      processEnv([], directory)
      updateInitialEnv({
        __NEXT_AGENT_UPGRADE: policy,
        __NEXT_VERSION: '16.4.0-preview-test',
      })
      jest.mocked(spawnNextUpgrade).mockImplementationOnce(async () => {
        expect(process.env.__NEXT_AGENT_UPGRADE).toBeUndefined()
        // Future upgrade preparation reloads config and resets the environment.
        resetEnv()
        expect(process.env.__NEXT_AGENT_UPGRADE).toBeUndefined()
        expect(process.env.__NEXT_VERSION).toBe('16.4.0-preview-test')
      })
      await runUpgrade(directory, policy, null)
      expect(spawnNextUpgrade).toHaveBeenCalledWith(
        directory,
        {
          revision: 'latest',
          verbose: false,
          ai: policy,
        },
        null
      )
    }
  )

  it.each(['blocked', 'unknown'] as const)(
    'does not force a nudge when the target is %s',
    async (status) => {
      process.env.__NEXT_AGENT_UPGRADE = 'security'
      jest.mocked(getUpgradeAssessment).mockResolvedValue({
        affected: true,
        reference:
          'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk',
        upgrade: { status, reason: 'No verified target.' },
      })
      await expect(run('security')).resolves.toBeUndefined()
      expect(promptUpgrade).not.toHaveBeenCalled()
      expect(warn).not.toHaveBeenCalled()
    }
  )

  it('lets an explicit request bypass a saved dismissal', async () => {
    jest.mocked(promptUpgrade).mockResolvedValue('dismiss')
    await run('security')
    jest.clearAllMocks()
    await run('security')
    expect(promptUpgrade).not.toHaveBeenCalled()
    process.env.__NEXT_AGENT_UPGRADE = 'security'
    jest.mocked(promptUpgrade).mockResolvedValue('skip')
    await expect(run('security')).resolves.toBe('skip')
    expect(promptUpgrade).toHaveBeenCalledTimes(1)
    expect(getUpgradeAssessment).toHaveBeenCalledWith(
      '16.4.0',
      'security',
      false
    )
  })

  it('uses real release data for a forced latest nudge with config disabled', async () => {
    process.env.__NEXT_AGENT_UPGRADE = 'latest'
    mockUpgrade('16.4.1')
    await nudgeUpgrade(
      directory,
      config(false),
      'dev',
      new AbortController().signal,
      null,
      null
    )
    const message = jest.mocked(promptUpgrade).mock.calls[0][0]
    expect(message).toContain(
      'Next.js latest version upgrade available: 16.4.0 -> 16.4.1'
    )
    expect(message).not.toContain('Forced preview:')
    expect(getUpgradeAssessment).toHaveBeenCalledWith('16.4.0', 'latest', false)
    jest.mocked(getAgentName).mockResolvedValue('codex')
    await expect(
      nudgeUpgrade(directory, config(false), 'dev', null, null, null)
    ).rejects.toMatchObject({
      message: expect.stringContaining('next upgrade --ai=latest'),
    })
  })

  it('ignores invalid requests and retains the configured policy', async () => {
    process.env.__NEXT_AGENT_UPGRADE = 'invalid'
    const context = getUpgradeContext(config(false))
    expect(context.experimental.agentUpgrade).toBe(false)
    await nudgeUpgrade(
      directory,
      context,
      'build',
      new AbortController().signal,
      null,
      null
    )
    expect(promptUpgrade).not.toHaveBeenCalled()
    await expect(run()).resolves.toBe('skip')
    expect(getUpgradeAssessment).toHaveBeenCalledWith(
      '16.4.0',
      'experimental-future',
      false
    )
  })

  it('does not open an explicitly requested prompt after cancellation', async () => {
    process.env.__NEXT_AGENT_UPGRADE = 'security'
    const controller = new AbortController()
    controller.abort()
    await run('security', controller.signal)
    expect(promptUpgrade).not.toHaveBeenCalled()
  })

  it('reloads a security dismissal before requesting metadata', async () => {
    jest.mocked(promptUpgrade).mockResolvedValue('dismiss')
    await expect(run()).resolves.toBe('dismiss')
    jest.clearAllMocks()
    await run()
    expect(getUpgradeAssessment).toHaveBeenCalledTimes(0)
    expect(promptUpgrade).toHaveBeenCalledTimes(0)

    process.env.__NEXT_VERSION = '16.4.1'
    jest.mocked(promptUpgrade).mockResolvedValue('skip')
    await expect(run()).resolves.toBe('skip')
    process.env.__NEXT_VERSION = '16.4.0'
    await expect(run('security')).resolves.toBe('skip')
    await expect(
      nudgeUpgrade(
        join(directory, 'app'),
        config('experimental-future'),
        'build',
        new AbortController().signal,
        null,
        null
      )
    ).resolves.toBe('skip')
  })

  it.each(['.', 'apps/web'])(
    'shares %s dismissals across worktrees without affecting other apps or repositories',
    async (appPath) => {
      const repository = join(directory, 'project.name')
      const worktree = join(directory, 'other-checkout')
      const git = (args: string[]) =>
        execFileSync(
          'git',
          ['-c', `core.hooksPath=${join(directory, 'no-hooks')}`, ...args],
          {
            cwd: directory,
            stdio: 'pipe',
          }
        )
      git(['init', repository])
      git([
        '-C',
        repository,
        '-c',
        'user.name=Next.js test',
        '-c',
        'user.email=nextjs@example.com',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--allow-empty',
        '-m',
        'Initialize test repository',
      ])
      git(['-C', repository, 'worktree', 'add', '--detach', worktree])
      const app = join(repository, appPath)
      const siblingApp = join(worktree, appPath)
      await mkdir(app, { recursive: true })
      await mkdir(siblingApp, { recursive: true })
      const offer = (path: string) =>
        nudgeUpgrade(
          path,
          config('experimental-future'),
          'build',
          new AbortController().signal,
          null,
          null
        )
      jest.mocked(promptUpgrade).mockResolvedValue('dismiss')
      await expect(offer(app)).resolves.toBe('dismiss')
      jest.clearAllMocks()
      await offer(siblingApp)
      expect(getUpgradeAssessment).toHaveBeenCalledTimes(0)
      expect(promptUpgrade).toHaveBeenCalledTimes(0)

      const preferences = new Conf({ projectName: 'nextjs' })
      const name = appPath === '.' ? 'project%2Ename' : 'web'
      const saved = preferences.get(`ai-upgrade.${name}`) as Record<
        string,
        unknown
      >
      expect(Object.keys(saved)).toHaveLength(1)
      expect(Object.keys(saved)[0]).toMatch(/^[a-f0-9]{64}$/)
      expect(Object.values(saved)).toEqual([
        { security: '16.4.0:experimental-future' },
      ])

      const otherApp = join(worktree, 'other/web')
      await mkdir(otherApp, { recursive: true })
      jest.mocked(promptUpgrade).mockResolvedValue('skip')
      await expect(offer(otherApp)).resolves.toBe('skip')
      const otherRepository = join(directory, 'unrelated/project.name')
      git(['init', otherRepository])
      const unrelatedApp = join(otherRepository, appPath)
      await mkdir(unrelatedApp, { recursive: true })
      await expect(offer(unrelatedApp)).resolves.toBe('skip')
    }
  )

  it.each([false, true])(
    'still checks security after a latest dismissal (affected: %s)',
    async (affected) => {
      mockUpgrade('17.0.0')
      jest.mocked(promptUpgrade).mockResolvedValue('dismiss')
      await run()
      jest.clearAllMocks()
      jest.mocked(getUpgradeAssessment).mockResolvedValue({
        ...securityAssessment,
        affected,
      })
      jest.mocked(promptUpgrade).mockResolvedValue('skip')
      await run()
      expect(getUpgradeAssessment).toHaveBeenCalledWith(
        '16.4.0',
        'experimental-future',
        true
      )
      expect(promptUpgrade).toHaveBeenCalledTimes(affected ? 1 : 0)
    }
  )

  it('suppresses dismissed Future Defaults but still offers a newer release', async () => {
    mockUpgrade()
    jest.mocked(promptUpgrade).mockResolvedValue('dismiss')
    await expect(run()).resolves.toBe('dismiss')
    jest.clearAllMocks()
    await run()
    expect(promptUpgrade).toHaveBeenCalledTimes(0)
    mockUpgrade('17.0.0')
    jest.mocked(promptUpgrade).mockResolvedValue('skip')
    await expect(run()).resolves.toBe('skip')
    expect(promptUpgrade).toHaveBeenCalledWith(
      expect.stringContaining(
        'Next.js Future Default upgrade available: 16.4.0 -> 17.0.0'
      ),
      expect.any(AbortSignal),
      true,
      null
    )
  })

  it.each(['blocked', 'unknown'] as const)(
    'does not prompt when security target availability is %s',
    async (status) => {
      jest.mocked(getUpgradeAssessment).mockResolvedValue({
        ...securityAssessment,
        upgrade: { status, reason: 'No eligible target.' },
      })
      await run()
      expect(promptUpgrade).not.toHaveBeenCalled()
    }
  )

  it('continues assessing when preferences cannot be read', async () => {
    jest.spyOn(Conf.prototype, 'get').mockImplementationOnce(() => {
      throw new Error('Unavailable')
    })
    await expect(run()).resolves.toBe('skip')
  })

  it('warns and continues when a dismissal cannot be saved', async () => {
    jest.spyOn(Conf.prototype, 'set').mockImplementationOnce(() => {
      throw new Error('Read-only')
    })
    jest.mocked(promptUpgrade).mockResolvedValue('dismiss')
    await expect(run()).resolves.toBe('dismiss')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Could not save'))
  })

  it.each(['CI', 'stdin', 'stdout', 'TERM'])(
    'does not request metadata or prompt with ineligible %s',
    async (reason) => {
      if (reason === 'CI') {
        jest.requireMock('../../packages/next/src/server/ci-info').isCI = true
      } else if (reason === 'TERM') {
        process.env.TERM = 'dumb'
      } else {
        Object.defineProperty(
          reason === 'stdin' ? process.stdin : process.stdout,
          'isTTY',
          {
            configurable: true,
            value: false,
          }
        )
      }
      expect(await shouldPromptForUpgrade()).toBe(false)
      await run()
      expect(getUpgradeAssessment).toHaveBeenCalledTimes(0)
      expect(promptUpgrade).toHaveBeenCalledTimes(0)
      process.env.__NEXT_AGENT_UPGRADE = 'security'
      await run()
      expect(getUpgradeAssessment).toHaveBeenCalledTimes(0)
      expect(promptUpgrade).toHaveBeenCalledTimes(0)
    }
  )

  it('excludes agents from the human startup gate', async () => {
    expect(await shouldPromptForUpgrade()).toBe(true)
    jest.mocked(getAgentName).mockResolvedValue('codex')
    expect(await shouldPromptForUpgrade()).toBe(false)
  })

  it('ignores an assessment that completes after cancellation', async () => {
    const controller = new AbortController()
    jest.mocked(getUpgradeAssessment).mockImplementation(async () => {
      controller.abort()
      return securityAssessment
    })
    await run('experimental-future', controller.signal)
    expect(promptUpgrade).toHaveBeenCalledTimes(0)
  })
})
