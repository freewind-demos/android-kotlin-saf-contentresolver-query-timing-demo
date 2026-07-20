#!/usr/bin/env bun

import { $ } from 'bun'
import { dirname, join, resolve } from 'node:path'

const PREFIX = 'android-build'
const SETTINGS_FILE = 'settings.gradle.kts'
const BUILD_CONFIG_FILE = 'build.gradle.kts'
const APP_CONFIG_FILE = 'app/build.gradle.kts'
const APK_OUTPUT_DIR = 'build/outputs/apk'
const BUILD_TYPES = ['debug', 'release'] as const
type BuildType = (typeof BUILD_TYPES)[number]
const DEFAULT_BUILD_TYPE: BuildType = 'debug'
const DEFAULT_FLAVOR = 'dev'

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
  const settingsPath = join(projectDir, SETTINGS_FILE)
  const candidateConfigs: string[] = []

  if (await Bun.file(settingsPath).exists()) {
    if (await rgTest('project\\s*\\([^)]*\\)\\s*\\.projectDir\\s*=', settingsPath)) {
      fail('检测到 settings.gradle.kts 使用 projectDir 自定义模块目录。当前脚本不支持。请简化项目，或直接传 --config。')
    }
    for (const moduleName of [...new Set(await rgLines('":([^"]+)"', [settingsPath]))].sort()) {
      const candidate = join(projectDir, (moduleName.startsWith(':') ? moduleName.slice(1) : moduleName).replace(/:/g, '/'), 'build.gradle.kts')
      if (await Bun.file(candidate).exists()) candidateConfigs.push(candidate)
    }
  } else {
    for (const candidate of [join(projectDir, APP_CONFIG_FILE), join(projectDir, BUILD_CONFIG_FILE)]) {
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
  if (await rgTest('["\']dev["\']|\\bdev\\s*\\{', configPath)) return DEFAULT_FLAVOR
  const flavors = [...new Set(await rgLines('(?:create|register|maybeCreate)\\(["\']([A-Za-z0-9_-]+)["\']\\)', [configPath]))]
  if (flavors.length === 1) return flavors[0]
  console.error('检测到 productFlavors，但无法确定默认 flavor。请传 --flavor。候选：')
  for (const f of flavors) console.error(f)
  process.exit(1)
}

function toPascalCase(value: string) {
  if (!value) return ''
  return value.replace(/-/g, '_').split('_').map((p) => (p ? p[0].toUpperCase() + p.slice(1) : '')).join('')
}

function modulePathFromConfig(projectDir: string, configPath: string) {
  const moduleDir = dirname(configPath)
  if (moduleDir === projectDir) return ''
  return `:${moduleDir.slice(projectDir.length + 1).replace(/\//g, ':')}`
}

function buildTaskName(configPath: string, projectDir: string, flavor: string, buildType: string) {
  const suffix = flavor ? `${toPascalCase(flavor)}${toPascalCase(buildType)}` : toPascalCase(buildType)
  const modulePath = modulePathFromConfig(projectDir, configPath)
  return modulePath ? `${modulePath}:assemble${suffix}` : `assemble${suffix}`
}

async function findApk(moduleDir: string, flavor: string, buildType: string) {
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

function parseArgs(argv: string[]) {
  const opts = { config: '', flavor: '', buildType: DEFAULT_BUILD_TYPE, openDir: true }
  let i = 0
  while (i < argv.length) {
    switch (argv[i]) {
      case '--help':
      case '-h':
        console.log(`用法: android-build.mts [--config PATH] [--flavor NAME] [--build-type debug|release] [--no-open-dir] [--help]`)
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
      case '--no-open-dir':
        opts.openDir = false
        break
      default:
        fail(`未知参数：${argv[i]}`)
    }
    i += 1
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))
const projectDir = resolve(process.cwd())
const configPath = await resolveConfigPath(projectDir, opts.config)
const moduleDir = dirname(configPath)
const gradlewPath = join(projectDir, 'gradlew')
if (!(await $`test -x ${gradlewPath}`.quiet().then((r) => r.exitCode === 0))) {
  fail(`缺少 gradlew：${gradlewPath}。请先生成 Android Gradle Wrapper。`)
}

const flavor = await resolveFlavor(configPath, opts.flavor)
const taskName = buildTaskName(configPath, projectDir, flavor, opts.buildType)
const variantSlug = flavor ? `${flavor}-${opts.buildType}` : opts.buildType
const apkOutputDir = join(moduleDir, APK_OUTPUT_DIR)

log(`config: ${configPath}`)
log(`task: ${taskName}`)
log(`clean: ${apkOutputDir}`)

if ((await $`test -d ${apkOutputDir}`.quiet().nothrow()).exitCode === 0) await $`rm -rf ${apkOutputDir}`.quiet()

const build = await $`./gradlew ${taskName}`.cwd(projectDir).nothrow()
if (build.exitCode !== 0) fail(`Gradle 任务失败：${taskName}`)

const apkPath = await findApk(moduleDir, flavor, opts.buildType)

if (opts.openDir) {
  const opened = await $`open -R ${apkPath}`.quiet().nothrow()
  if (opened.exitCode !== 0) {
    const xdg = await $`xdg-open ${dirname(apkPath)}`.quiet().nothrow()
    if (xdg.exitCode !== 0) log('跳过打开目录：缺少 open/xdg-open')
  }
}

log('done')
log(`apk: ${apkPath}`)
