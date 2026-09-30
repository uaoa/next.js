import findUp from 'find-up'
import execa from 'execa'
import globby from 'globby'
import { load } from 'js-yaml'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

/**
 * Get the full version string for the given package manager.
 *
 * First tries to parse from `npm_config_user_agent` (e.g., "pnpm/9.13.2 npm/? ..."),
 * then falls back to spawning `<packageManager> --version`.
 *
 * Returns null if unable to determine the version.
 *
 * Mirrors `packages/create-next-app/helpers/get-pkg-manager.ts`.
 */
export function getPackageManagerVersion(
  packageManager: PackageManager
): string | null {
  const userAgent = process.env.npm_config_user_agent || ''
  const userAgentMatch = userAgent.match(
    new RegExp(`${packageManager}/([\\d.]+[\\w.-]*)`)
  )
  if (userAgentMatch) {
    return userAgentMatch[1]
  }

  try {
    const version = execSync(`${packageManager} --version`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim()
    if (/^\d+\.\d+\.\d+/.test(version)) {
      return version
    }
  } catch {
    // package manager not available or failed to run
  }

  return null
}

/**
 * Get the major version of pnpm being used.
 * Returns null if unable to determine the version.
 */
export function getPnpmMajorVersion(): number | null {
  const version = getPackageManagerVersion('pnpm')
  if (!version) return null
  const major = parseInt(version.split('.')[0], 10)
  return Number.isNaN(major) ? null : major
}

export function getPkgManager(baseDir: string): PackageManager {
  try {
    const userAgent = process.env.npm_config_user_agent
    if (userAgent) {
      if (userAgent.startsWith('yarn')) {
        return 'yarn'
      } else if (userAgent.startsWith('pnpm')) {
        return 'pnpm'
      } else if (userAgent.startsWith('bun')) {
        return 'bun'
      } else if (userAgent.startsWith('npm')) {
        return 'npm'
      }
    }
    return getProjectPackageManager(baseDir)
  } catch {
    return 'npm'
  }
}

// The launcher can use a different manager from the app. Only inherit a manager
// from a workspace that includes the app, not an unrelated parent project.
export function getProjectPackageManager(baseDir: string): PackageManager {
  let packageJsonPath = findUp.sync('package.json', { cwd: baseDir })
  const appDirectory = packageJsonPath
    ? dirname(packageJsonPath)
    : resolve(baseDir)

  while (packageJsonPath) {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
    const { packageManager } = packageJson
    if (typeof packageManager === 'string') {
      const match = packageManager.match(/^(npm|pnpm|yarn|bun)@/)
      if (match) {
        const directory = dirname(packageJsonPath)
        if (directory === appDirectory) {
          return match[1] as PackageManager
        }

        // Check membership before allowing an ancestor declaration to override
        // the app's lockfile. Globby also handles excluded workspace patterns.
        let workspaces = Array.isArray(packageJson.workspaces)
          ? packageJson.workspaces
          : packageJson.workspaces?.packages
        const workspaceFile = join(directory, 'pnpm-workspace.yaml')
        if (match[1] === 'pnpm' && existsSync(workspaceFile)) {
          const workspace = load(readFileSync(workspaceFile, 'utf8')) as {
            packages: string[] | undefined
          } | null
          workspaces = workspace?.packages
        }

        if (
          Array.isArray(workspaces) &&
          globby
            .sync(workspaces, {
              cwd: directory,
              onlyDirectories: true,
              expandDirectories: false,
              absolute: true,
            })
            .some((workspace) => resolve(workspace) === appDirectory)
        ) {
          return match[1] as PackageManager
        }
      }
    }

    const directory = dirname(packageJsonPath)
    const parent = dirname(directory)
    if (parent === directory) {
      break
    }
    packageJsonPath = findUp.sync('package.json', { cwd: parent })
  }

  const lockFile = findUp.sync(
    [
      'yarn.lock',
      'pnpm-lock.yaml',
      'bun.lock',
      'bun.lockb',
      'package-lock.json',
    ],
    { cwd: baseDir }
  )
  if (lockFile) {
    switch (basename(lockFile)) {
      case 'yarn.lock':
        return 'yarn'
      case 'pnpm-lock.yaml':
        return 'pnpm'
      case 'bun.lock':
      case 'bun.lockb':
        return 'bun'
      case 'package-lock.json':
        return 'npm'
      default:
        return 'npm'
    }
  }

  // No project manager found, default to npm.
  return 'npm'
}

export function uninstallPackage(
  packageToUninstall: string,
  pkgManager?: PackageManager
) {
  pkgManager ??= getPkgManager(process.cwd())
  if (!pkgManager) throw new Error('Failed to find package manager')

  let command = 'uninstall'
  if (pkgManager === 'yarn') {
    command = 'remove'
  }

  try {
    execa.sync(pkgManager, [command, packageToUninstall], {
      stdio: 'inherit',
      shell: true,
    })
  } catch (error) {
    throw new Error(
      `Failed to uninstall "${packageToUninstall}". Please uninstall it manually.`,
      { cause: error }
    )
  }
}

const ADD_CMD_FLAG = {
  npm: 'install',
  yarn: 'add',
  pnpm: 'add',
  bun: 'add',
}

const DEV_DEP_FLAG = {
  npm: '--save-dev',
  yarn: '--dev',
  pnpm: '--save-dev',
  bun: '--dev',
}

export function installPackages(
  packageToInstall: string[],
  options: {
    packageManager?: PackageManager
    silent?: boolean
    dev?: boolean
  } = {}
) {
  if (packageToInstall.length === 0) return

  const {
    packageManager = getPkgManager(process.cwd()),
    silent = false,
    dev = false,
  } = options

  if (!packageManager) throw new Error('Failed to find package manager')

  const addCmd = ADD_CMD_FLAG[packageManager]
  const devDepFlag = dev ? DEV_DEP_FLAG[packageManager] : undefined

  const installFlags = [addCmd]
  if (devDepFlag) {
    installFlags.push(devDepFlag)
  }
  try {
    execa.sync(packageManager, [...installFlags, ...packageToInstall], {
      // Keeping stderr since it'll likely be relevant later when it fails.
      stdio: silent ? ['ignore', 'ignore', 'inherit'] : 'inherit',
      shell: true,
    })
  } catch (error) {
    throw new Error(
      `Failed to install "${packageToInstall}". Please install it manually.`,
      { cause: error }
    )
  }
}

export function runInstallation(
  packageManager: PackageManager,
  options: { cwd: string }
) {
  try {
    execa.sync(packageManager, ['install'], {
      cwd: options.cwd,
      env: {
        ...process.env,
        // In case NODE_ENV=production is set, we still want dev dependencies to
        // be installed. Otherwise we won't be able to check for peer dependencies.
        // --production=false is not implemented by every package manager.
        NODE_ENV: 'development',
      },
      stdio: 'inherit',
      shell: true,
    })
  } catch (error) {
    // getPkgManager() would reuse the launcher's npm_config_user_agent and select
    // the same manager again under npx. Detect the project's manager directly.
    // Retry only when project detection selects a different manager. A real
    // installation failure with that manager must still stop the upgrade.
    const projectPackageManager = getProjectPackageManager(options.cwd)
    if (projectPackageManager !== packageManager) {
      console.warn(
        `${packageManager} install failed. Retrying with the project's package manager: ${projectPackageManager}.`
      )
      return runInstallation(projectPackageManager, options)
    }

    throw new Error('Failed to install dependencies', { cause: error })
  }
}

export function addPackageDependency(
  packageJson: Record<string, any>,
  name: string,
  version: string,
  dev: boolean
): void {
  if (dev) {
    packageJson.devDependencies = packageJson.devDependencies || {}
  } else {
    packageJson.dependencies = packageJson.dependencies || {}
  }

  const deps = dev ? packageJson.devDependencies : packageJson.dependencies

  deps[name] = version
}
