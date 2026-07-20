#!/usr/bin/env bun

import { $ } from 'bun'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const PREFIX = 'android-adb'
const DEFAULT_SDK_ROOT = join(homedir(), 'Library/Android/sdk')
const BUILD_TYPES = ['debug', 'release'] as const
type BuildType = (typeof BUILD_TYPES)[number]
const DEFAULT_BUILD_TYPE: BuildType = 'debug'
const BUILD_SCRIPT = join(import.meta.dir, 'android-build.mts')

function parseBuildType(value: string): BuildType {
  const normalized = value.toLowerCase()
  if (normalized === 'debug' || normalized === 'release') return normalized
  fail(`--build-type 只支持 debug 或 release，收到：${value}`)
}

function log(...args: unknown[]) {
  console.error(`[${PREFIX}]`, ...args)
}

function fail(message: string): never {
  console.error(`[${PREFIX}]`, message)
  process.exit(1)
}

function pathExists(path: string) {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

async function rgTest(pattern: string, file: string) {
  const proc = Bun.spawn(['rg', '-q', pattern, file], { stdout: 'ignore', stderr: 'ignore' })
  await proc.exited
  return proc.exitCode === 0
}

async function rgLines(pattern: string, files: string[], replace = '$1') {
  if (!files.length) return [] as string[]
  const proc = Bun.spawn(['rg', '--no-filename', '-o', '--replace', replace, pattern, ...files], {
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const text = await new Response(proc.stdout).text()
  await proc.exited
  if (proc.exitCode !== 0) return []
  return text.split('\n').map((s) => s.trim()).filter(Boolean)
}

async function classifyConfig(configPath: string) {
  if (await rgTest('com\\.android\\.application', configPath)) return 'app'
  if (await rgTest('com\\.android\\.library', configPath)) return 'library'
  return 'other'
}

async function selectConfigFromCandidates(projectDir: string) {
  const settingsFile = join(projectDir, 'settings.gradle.kts')
  const candidateConfigs: string[] = []

  if (await Bun.file(settingsFile).exists()) {
    if (await rgTest('project\\s*\\([^)]*\\)\\s*\\.projectDir\\s*=', settingsFile)) {
      fail('检测到 settings.gradle.kts 使用 projectDir 自定义模块目录。当前脚本不支持。请简化项目，或直接传 --config。')
    }
    for (const moduleName of [...new Set(await rgLines('":([^"]+)"', [settingsFile]))].sort()) {
      const candidate = join(projectDir, (moduleName.startsWith(':') ? moduleName.slice(1) : moduleName).replace(/:/g, '/'), 'build.gradle.kts')
      if (await Bun.file(candidate).exists()) candidateConfigs.push(candidate)
    }
  } else {
    for (const candidate of [join(projectDir, 'app/build.gradle.kts'), join(projectDir, 'build.gradle.kts')]) {
      if (await Bun.file(candidate).exists()) candidateConfigs.push(candidate)
    }
  }

  const appConfigs: string[] = []
  const libraryConfigs: string[] = []
  for (const candidate of candidateConfigs) {
    const kind = await classifyConfig(candidate)
    if (kind === 'app') appConfigs.push(candidate)
    if (kind === 'library') libraryConfigs.push(candidate)
  }

  if (appConfigs.length === 1) return appConfigs[0]
  if (appConfigs.length > 1) {
    console.error('发现多个 Android App 配置文件，请传 --config 指定其一：')
    for (const c of appConfigs) console.error(c)
    process.exit(1)
  }
  if (libraryConfigs.length > 0) fail('当前项目只发现 Android Library 配置：检测到 com.android.library。该脚本只支持 Android App。')
  fail('缺少 Android App 配置文件：未找到包含 com.android.application 的 build.gradle.kts。')
}

async function resolveConfigPath(projectDir: string, explicitConfig: string) {
  if (explicitConfig) {
    let configPath = explicitConfig.startsWith('/') ? explicitConfig : join(projectDir, explicitConfig)
    configPath = resolve(configPath)
    if (!(await Bun.file(configPath).exists())) fail(`指定的配置文件不存在：${configPath}`)
    const kind = await classifyConfig(configPath)
    if (kind === 'app') return configPath
    if (kind === 'library') fail('当前配置是 Android Library：检测到 com.android.library。该脚本只支持 Android App。')
    fail(`指定的配置文件不是 Android App 配置：${configPath}`)
  }
  return selectConfigFromCandidates(projectDir)
}

async function resolveFlavor(configPath: string, explicitFlavor: string) {
  if (explicitFlavor) return explicitFlavor
  if (!(await rgTest('productFlavors', configPath))) return ''
  if (await rgTest('["\']dev["\']|\\bdev\\s*\\{', configPath)) return 'dev'
  const flavors = [...new Set(await rgLines('(?:create|register|maybeCreate)\\(["\']([A-Za-z0-9_-]+)["\']\\)', [configPath]))]
  if (flavors.length === 1) return flavors[0]
  console.error('检测到 productFlavors，但无法确定默认 flavor。请传 --flavor。候选：')
  for (const f of flavors) console.error(f)
  process.exit(1)
}

async function resolveAppId(configPath: string) {
  for (const pattern of ['applicationId\\s*=\\s*"([^"]+)"', 'applicationId\\s+"([^"]+)"']) {
    const lines = await rgLines(pattern, [configPath])
    if (lines[0]) return lines[0]
  }
  fail(`无法从配置文件解析 applicationId：${configPath}`)
}

function resolveSdkRoot() {
  return process.env.ANDROID_SDK_ROOT?.trim() || process.env.ANDROID_HOME?.trim() || DEFAULT_SDK_ROOT
}

async function requireTool(bin: string, label: string) {
  const proc = Bun.spawn([bin, label === 'adb' ? 'version' : '-help'], { stdout: 'ignore', stderr: 'ignore' })
  await proc.exited
  if (proc.exitCode !== 0) fail(`缺少 ${label}：${bin}`)
}

async function listOnlineDevices(adbBin: string) {
  const proc = Bun.spawn([adbBin, 'devices'], { stdout: 'pipe', stderr: 'ignore' })
  const text = await new Response(proc.stdout).text()
  await proc.exited
  const devices: string[] = []
  for (const line of text.split('\n')) {
    const cols = line.split('\t')
    if (cols.length >= 2 && cols[1].trim() === 'device') devices.push(cols[0].trim())
  }
  return devices
}

async function waitForDeviceReady(adbBin: string, serial: string) {
  const wait = Bun.spawn([adbBin, '-s', serial, 'wait-for-device'], { stdout: 'ignore', stderr: 'ignore' })
  await wait.exited
  if (wait.exitCode !== 0) fail(`adb wait-for-device 失败：${serial}`)

  for (let i = 0; i < 120; i += 1) {
    const proc = Bun.spawn([adbBin, '-s', serial, 'shell', 'getprop', 'sys.boot_completed'], {
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const booted = (await new Response(proc.stdout).text()).trim()
    await proc.exited
    if (booted === '1') {
      await $`${adbBin} -s ${serial} shell input keyevent 82`.quiet().nothrow()
      return
    }
    await Bun.sleep(2000)
  }
  fail(`设备启动超时：${serial}`)
}

async function pickAvdName(emulatorBin: string, explicitAvd: string) {
  if (explicitAvd) return explicitAvd
  const proc = Bun.spawn([emulatorBin, '-list-avds'], { stdout: 'pipe', stderr: 'ignore' })
  const text = await new Response(proc.stdout).text()
  await proc.exited
  for (const line of text.split('\n')) {
    const v = line.trim()
    if (v) return v
  }
  fail('未发现可用 AVD。请先创建模拟器，或传 --avd。')
}

async function ensureEmulator(adbBin: string, emulatorBin: string, explicitSerial: string, explicitAvd: string, logPath: string) {
  if (explicitSerial) {
    await waitForDeviceReady(adbBin, explicitSerial)
    return explicitSerial
  }

  const running = (await listOnlineDevices(adbBin)).filter((s) => s.startsWith('emulator-'))
  if (running.length >= 1) {
    await waitForDeviceReady(adbBin, running[0])
    return running[0]
  }

  const avdName = await pickAvdName(emulatorBin, explicitAvd)
  log(`start emulator: ${avdName}`)
  Bun.spawn([emulatorBin, '-avd', avdName], {
    stdout: Bun.file(logPath),
    stderr: Bun.file(logPath),
    stdin: 'ignore',
  }).unref()

  for (let i = 0; i < 120; i += 1) {
    const emulators = (await listOnlineDevices(adbBin)).filter((s) => s.startsWith('emulator-'))
    if (emulators.length >= 1) {
      await waitForDeviceReady(adbBin, emulators[0])
      return emulators[0]
    }
    await Bun.sleep(2000)
  }
  fail(`模拟器启动超时：${avdName}`)
}

async function pickTargetDevice(adbBin: string, sdkRoot: string, explicitSerial: string, explicitAvd: string, logPath: string) {
  if (explicitSerial) {
    if (explicitSerial.startsWith('emulator-')) {
      const emulatorBin = join(sdkRoot, 'emulator/emulator')
      await requireTool(emulatorBin, 'emulator')
      return ensureEmulator(adbBin, emulatorBin, explicitSerial, explicitAvd, logPath)
    }
    await waitForDeviceReady(adbBin, explicitSerial)
    return explicitSerial
  }

  const realDevices = (await listOnlineDevices(adbBin)).filter((s) => !s.startsWith('emulator-'))
  if (realDevices.length === 1) {
    await waitForDeviceReady(adbBin, realDevices[0])
    return realDevices[0]
  }
  if (realDevices.length > 1) {
    console.error('发现多个真机，请传 --serial 指定：')
    for (const s of realDevices) console.error(s)
    process.exit(1)
  }

  const emulatorBin = join(sdkRoot, 'emulator/emulator')
  await requireTool(emulatorBin, 'emulator')
  return ensureEmulator(adbBin, emulatorBin, '', explicitAvd, logPath)
}

async function buildOnce(projectDir: string, config: string, flavor: string, buildType: string) {
  const args = [BUILD_SCRIPT, '--no-open-dir', '--build-type', buildType]
  if (config) args.push('--config', config)
  if (flavor) args.push('--flavor', flavor)
  const proc = Bun.spawn(['bun', ...args], { cwd: projectDir, stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' })
  await proc.exited
  return proc.exitCode === 0
}

async function findBuiltApk(projectDir: string, configPath: string, flavor: string, buildType: string) {
  const moduleDir = dirname(configPath)
  const apkRoot = join(moduleDir, APK_OUTPUT_DIR)
  if ((await $`test -d ${apkRoot}`.quiet().nothrow()).exitCode !== 0) fail(`缺少 APK 输出目录：${apkRoot}`)

  const glob = new Bun.Glob('**/*.apk')
  const all: string[] = []
  for await (const p of glob.scan({ cwd: apkRoot, absolute: true, onlyFiles: true })) all.push(p)

  const flavorLower = flavor.toLowerCase()
  const buildTypeLower = buildType.toLowerCase()
  const matched = all.filter((candidate) => {
    const lower = candidate.toLowerCase()
    if (lower.includes('unaligned')) return false
    if (flavorLower && !lower.includes(flavorLower)) return false
    return lower.includes(buildTypeLower)
  })

  if (matched.length === 1) return matched[0]
  if (matched.length > 1) {
    console.error('发现多个 APK 输出文件，请简化产物，或调整脚本规则：')
    for (const p of matched) console.error(p)
    process.exit(1)
  }
  if (all.length === 1) return all[0]
  fail('未找到匹配当前 variant 的 APK。')
}

async function installAndLaunch(adbBin: string, serial: string, appId: string, apkPath: string) {
  if (!(await Bun.file(apkPath).exists())) fail(`缺少 APK：${apkPath}`)
  log(`install apk -> ${serial}`)
  const install = await $`${adbBin} -s ${serial} install -r ${apkPath}`.nothrow()
  if (install.exitCode !== 0) fail(`安装失败：${apkPath}`)
  log(`launch app -> ${appId}`)
  await $`${adbBin} -s ${serial} shell am force-stop ${appId}`.quiet().nothrow()
  const launch = await $`${adbBin} -s ${serial} shell monkey -p ${appId} -c android.intent.category.LAUNCHER 1`.quiet().nothrow()
  if (launch.exitCode !== 0) fail(`启动失败：${appId}`)
}

async function runOnce(
  adbBin: string,
  sdkRoot: string,
  projectDir: string,
  config: string,
  flavor: string,
  buildType: string,
  serial: string,
  avd: string,
  emulatorLogPath: string,
) {
  const resolvedSerial = await pickTargetDevice(adbBin, sdkRoot, serial, avd, emulatorLogPath)
  if (!(await buildOnce(projectDir, config, flavor, buildType))) return false
  const appId = await resolveAppId(config)
  const apkPath = await findBuiltApk(projectDir, config, flavor, buildType)
  await installAndLaunch(adbBin, resolvedSerial, appId, apkPath)
  log('done')
  log(`serial: ${resolvedSerial}`)
  log(`apk: ${apkPath}`)
  log(`app_id: ${appId}`)
  return true
}

function parseArgs(argv: string[]) {
  const opts = { config: '', flavor: '', buildType: DEFAULT_BUILD_TYPE, serial: '', avd: '', watch: false }
  let i = 0
  while (i < argv.length) {
    switch (argv[i]) {
      case '--help':
      case '-h':
        console.log(`用法: android-adb.mts [--config PATH] [--flavor NAME] [--build-type debug|release] [--serial ID] [--avd NAME] [--watch] [--help]`)
        process.exit(0)
      case '--config':
        if (i + 1 >= argv.length) fail('--config 缺少路径')
        opts.config = argv[++i]
        break
      case '--flavor':
        if (i + 1 >= argv.length) fail('--flavor 缺少值')
        opts.flavor = argv[++i]
        break
      case '--build-type':
        if (i + 1 >= argv.length) fail('--build-type 缺少值')
        opts.buildType = parseBuildType(argv[++i])
        break
      case '--serial':
        if (i + 1 >= argv.length) fail('--serial 缺少值')
        opts.serial = argv[++i]
        break
      case '--avd':
        if (i + 1 >= argv.length) fail('--avd 缺少值')
        opts.avd = argv[++i]
        break
      case '--watch':
        opts.watch = true
        break
      default:
        fail(`未知参数：${argv[i]}`)
    }
    i += 1
  }
  return opts
}

if (!(await Bun.file(BUILD_SCRIPT).exists())) fail(`缺少 build 脚本：${BUILD_SCRIPT}`)

const opts = parseArgs(process.argv.slice(2))
const projectDir = resolve(process.cwd())
const configPath = await resolveConfigPath(projectDir, opts.config)
const flavor = await resolveFlavor(configPath, opts.flavor)
const sdkRoot = resolveSdkRoot()
const adbBin = join(sdkRoot, 'platform-tools/adb')
await requireTool(adbBin, 'adb')
const emulatorLogPath = `/tmp/${basename(projectDir)}-android-emulator.log`

if (opts.watch) {
  if (!Bun.which('fswatch')) fail('缺少 fswatch。请先安装，或去掉 --watch。')
  log('watch start')
  await runOnce(adbBin, sdkRoot, projectDir, configPath, flavor, opts.buildType, opts.serial, opts.avd, emulatorLogPath)

  const watchCandidates = [
    projectDir,
    join(projectDir, 'app'),
    join(projectDir, 'src'),
    join(projectDir, 'gradle.properties'),
    join(projectDir, 'build.gradle.kts'),
    join(projectDir, 'settings.gradle.kts'),
  ]
  const paths: string[] = []
  for (const p of watchCandidates) {
    if (p === projectDir || pathExists(p)) paths.push(p)
  }

  const child = Bun.spawn(
    ['fswatch', '-0', '-r', '--exclude', '/\\.git/', '--exclude', '/\\.gradle/', '--exclude', '/build/', '--exclude', '/dist/', '--exclude', '/node_modules/', ...paths],
    { stdout: 'pipe', stderr: 'inherit' },
  )

  let buf = Buffer.alloc(0)
  child.stdout.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk])
    let idx: number
    while ((idx = buf.indexOf(0)) !== -1) {
      buf = buf.subarray(idx + 1)
      log('change detected')
      runOnce(adbBin, sdkRoot, projectDir, configPath, flavor, opts.buildType, opts.serial, opts.avd, emulatorLogPath).then((ok) => {
        if (!ok) log('build failed, wait next change')
      })
    }
  })
  await new Promise<void>((resolve) => child.on('close', () => resolve()))
} else {
  if (!(await runOnce(adbBin, sdkRoot, projectDir, configPath, flavor, opts.buildType, opts.serial, opts.avd, emulatorLogPath))) {
    process.exit(1)
  }
}
