#!/usr/bin/env bun

import { $ } from 'bun'
import { mkdtemp, open, rename, unlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const PREFIX = 'android-gradle-wrapper'

const KOTLIN_VERSION = '2.0.21'
const MARKER_PATHS = [
  'settings.gradle.kts', 'settings.gradle', 'build.gradle.kts', 'build.gradle',
  'gradlew', 'gradle/wrapper/gradle-wrapper.properties',
  'app/build.gradle.kts', 'app/build.gradle',
]

const AGP_TO_GRADLE: Record<string, string> = {
  '9.2': '9.4.1', '9.1': '9.3.1', '9.0': '9.1.0',
  '8.13': '8.13', '8.12': '8.13', '8.11': '8.13', '8.10': '8.11.1', '8.9': '8.11.1',
  '8.8': '8.10.2', '8.7': '8.9', '8.6': '8.7', '8.5': '8.7', '8.4': '8.6', '8.3': '8.4',
  '8.2': '8.2', '8.1': '8.0', '8.0': '8.0',
  '7.4': '7.5', '7.3': '7.4', '7.2': '7.3.3', '7.1': '7.2', '7.0': '7.0',
  '4.2': '6.7.1', '4.1': '6.7.1', '4.0': '6.1.1',
  '3.6': '5.6.4', '3.5': '5.4.1', '3.4': '5.1.1', '3.3': '4.10.1', '3.2': '4.6', '3.1': '4.4',
}

function log(...args: unknown[]) {
  console.error(`[${PREFIX}]`, ...args)
}

function fail(message: string): never {
  console.error(`[${PREFIX}]`, message)
  process.exit(1)
}

async function rgFirst(pattern: string, files: string[]) {
  if (!files.length) return ''
  const proc = Bun.spawn(['rg', '--no-filename', '-o', '--replace', '$1', pattern, ...files], {
    stdout: 'pipe',
    stderr: 'ignore',
  })
  const text = await new Response(proc.stdout).text()
  await proc.exited
  if (proc.exitCode !== 0) return ''
  for (const line of text.split('\n')) {
    const v = line.trim()
    if (v) return v
  }
  return ''
}

async function isGradleDir(dirPath: string) {
  for (const name of ['settings.gradle.kts', 'settings.gradle', 'build.gradle.kts', 'build.gradle']) {
    if (await Bun.file(join(dirPath, name)).exists()) return true
  }
  return false
}

function latestAgpVersion() {
  let bestMajor = 0
  let bestMinor = 0
  for (const key of Object.keys(AGP_TO_GRADLE)) {
    const [major, minor] = key.split('.').map(Number)
    if (major > bestMajor || (major === bestMajor && minor > bestMinor)) {
      bestMajor = major
      bestMinor = minor
    }
  }
  return `${bestMajor}.${bestMinor}.0`
}

function packageFromDirName(dirName: string) {
  const parts = dirName.toLowerCase().replace(/[^a-z0-9-]/g, '').split('-').filter(Boolean)
  if (!parts.length) fail(`cannot infer package name from directory: ${dirName}`)
  if (parts.length <= 2) return `com.${parts.join('.')}`
  return `com.${parts[0]}.${parts[1]}.${parts.slice(2).join('')}`
}

function packagePath(packageName: string) {
  return packageName.replace(/\./g, '/')
}

async function collectGradleMarkers(baseDirs: string[]) {
  const found: string[] = []
  for (const baseDir of baseDirs) {
    for (const rel of MARKER_PATHS) {
      const abs = join(baseDir, rel)
      if (await Bun.file(abs).exists()) found.push(abs)
    }
  }
  return found
}

function candidateAndroidDirs(projectDir: string) {
  return [projectDir, join(projectDir, 'android'), join(projectDir, 'native/android')]
}

async function initMinimalAndroidProject(androidDir: string, agpVersion: string, packageName: string) {
  const projectName = basename(androidDir)
  const mainClass = `${packagePath(packageName)}/MainActivity.kt`

  log(`init minimal Android project`)
  log(`agp: ${agpVersion}`)
  log(`package: ${packageName}`)

  await Bun.write(join(androidDir, 'settings.gradle.kts'), `pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

plugins {
    id("com.android.application") version "${agpVersion}" apply false
    id("org.jetbrains.kotlin.android") version "${KOTLIN_VERSION}" apply false
}

rootProject.name = "${projectName}"
include(":app")
`)

  await Bun.write(join(androidDir, 'build.gradle.kts'), '')

  await Bun.write(join(androidDir, 'gradle.properties'), `org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8
android.useAndroidX=true
kotlin.code.style=official
`)

  await Bun.write(join(androidDir, 'app/build.gradle.kts'), `plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "${packageName}"
    compileSdk = 35

    defaultConfig {
        applicationId = "${packageName}"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}
`)

  await Bun.write(join(androidDir, 'app/src/main/AndroidManifest.xml'), `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application
        android:allowBackup="true"
        android:label="@string/app_name"
        android:supportsRtl="true"
        android:theme="@android:style/Theme.Material.Light">
        <activity
            android:name=".MainActivity"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
`)

  await Bun.write(join(androidDir, 'app/src/main/res/values/strings.xml'), `<resources>
    <string name="app_name">${projectName}</string>
</resources>
`)

  await Bun.write(join(androidDir, `app/src/main/java/${mainClass}`), `package ${packageName}

import android.app.Activity
import android.os.Bundle

class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
    }
}
`)
}

async function resolveAndroidDir(projectDir: string) {
  if (process.env.ANDROID_DIR?.trim()) {
    const explicit = resolve(process.env.ANDROID_DIR.trim())
    if (!(await isGradleDir(explicit))) fail(`ANDROID_DIR is not a Gradle project: ${explicit}`)
    return explicit
  }

  for (const candidate of candidateAndroidDirs(projectDir)) {
    if (await isGradleDir(candidate)) return candidate
  }

  const markers = await collectGradleMarkers(candidateAndroidDirs(projectDir))
  if (markers.length) {
    fail(`detected partial Gradle files; clean up manually before init:\n${markers.map((p) => `- ${p}`).join('\n')}`)
  }

  const agpVersion = latestAgpVersion()
  const packageName = packageFromDirName(basename(projectDir))
  await initMinimalAndroidProject(projectDir, agpVersion, packageName)
  return projectDir
}

async function resolveAgpVersion(androidDir: string) {
  const buildFiles: string[] = []
  for (const name of [
    'settings.gradle.kts', 'settings.gradle', 'build.gradle.kts', 'build.gradle', 'gradle/libs.versions.toml',
  ]) {
    const p = join(androidDir, name)
    if (await Bun.file(p).exists()) buildFiles.push(p)
  }
  const patterns = [
    'com\\.android\\.tools\\.build:gradle:([0-9]+\\.[0-9]+(?:\\.[0-9]+)?)',
    'id\\(["\']com\\.android\\.(?:application|library|test|dynamic-feature)["\']\\)\\s+version\\s+["\']([0-9]+\\.[0-9]+(?:\\.[0-9]+)?)["\']',
    'id\\s+["\']com\\.android\\.(?:application|library|test|dynamic-feature)["\']\\s+version\\s+["\']([0-9]+\\.[0-9]+(?:\\.[0-9]+)?)["\']',
    '^\\s*(?:agp|androidGradlePlugin)\\s*=\\s*["\']([0-9]+\\.[0-9]+(?:\\.[0-9]+)?)["\']',
  ]
  for (const pattern of patterns) {
    const matched = await rgFirst(pattern, buildFiles)
    if (matched) return matched
  }
  return ''
}

function mapGradleVersionFromAgp(agpVersion: string) {
  const parts = agpVersion.split('.')
  if (parts.length < 2) return ''
  return AGP_TO_GRADLE[`${parts[0]}.${parts[1]}`] ?? ''
}

async function resolveGradleVersion(androidDir: string) {
  if (process.env.GRADLE_VERSION?.trim()) return process.env.GRADLE_VERSION.trim()
  const agp = await resolveAgpVersion(androidDir)
  if (agp) {
    const gradle = mapGradleVersionFromAgp(agp)
    if (gradle) {
      log(`AGP ${agp} -> Gradle ${gradle}`)
      return gradle
    }
    fail(`unsupported AGP version: ${agp}; set GRADLE_VERSION manually`)
  }
  const fallback = '9.4.1'
  log(`AGP not found -> default Gradle ${fallback}`)
  return fallback
}

function requireOnPath(name: string) {
  if (!Bun.which(name)) fail(`missing command: ${name}`)
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

async function downloadFile(url: string, destPath: string) {
  log(`download ${url}`)
  const res = await fetch(url)
  if (!res.ok) fail(`download failed: ${url} (${res.status})`)

  const total = Number(res.headers.get('content-length') || 0)
  const reader = res.body?.getReader()
  if (!reader) fail(`download failed: empty body`)

  const fh = await open(destPath, 'w')
  let received = 0
  const startedAt = Date.now()
  let lastLogAt = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      await fh.write(value)
      received += value.length

      const now = Date.now()
      if (now - lastLogAt >= 500 || (total > 0 && received >= total)) {
        lastLogAt = now
        const elapsed = (now - startedAt) / 1000
        const speed = elapsed > 0 ? received / elapsed : 0
        const line = total > 0
          ? `${(received / total * 100).toFixed(1)}% ${formatBytes(received)}/${formatBytes(total)} ${formatBytes(speed)}/s`
          : `${formatBytes(received)} ${formatBytes(speed)}/s`
        process.stderr.write(`\r[${PREFIX}] ${line}`)
      }
    }
  } finally {
    await fh.close()
  }
  process.stderr.write('\n')
}

function resolveCacheDir() {
  return resolve(process.env.ANDROID_GRADLE_WRAPPER_CACHE?.trim() || join(homedir(), '.cache', 'android-gradle-wrapper'))
}

function gradleCachePaths(gradleVersion: string, cacheDir: string) {
  const zipPath = join(cacheDir, `gradle-${gradleVersion}-all.zip`)
  const distDir = join(cacheDir, `gradle-${gradleVersion}`)
  const gradleBin = join(distDir, 'bin', 'gradle')
  return { zipPath, distDir, gradleBin }
}

async function bootstrapGradle(gradleVersion: string) {
  requireOnPath('unzip')
  requireOnPath('java')

  const cacheDir = resolveCacheDir()
  await $`mkdir -p ${cacheDir}`.quiet()
  const { zipPath, distDir, gradleBin } = gradleCachePaths(gradleVersion, cacheDir)

  if (await Bun.file(gradleBin).exists()) {
    log(`cache hit ${gradleVersion}`)
    return gradleBin
  }

  const distUrl = `https://services.gradle.org/distributions/gradle-${gradleVersion}-all.zip`
  if (!(await Bun.file(zipPath).exists())) {
    const partialPath = `${zipPath}.partial`
    await downloadFile(distUrl, partialPath)
    await rename(partialPath, zipPath)
  } else {
    log(`cache hit zip ${gradleVersion}`)
  }

  const unzip = await $`unzip -q ${zipPath} -d ${cacheDir}`.nothrow()
  if (unzip.exitCode !== 0) {
    await unlink(zipPath).catch(() => {})
    await $`rm -rf ${distDir}`.quiet()
    fail(`unzip failed: ${zipPath}`)
  }
  if (!(await Bun.file(gradleBin).exists())) fail(`gradle bin missing after unzip: ${gradleBin}`)
  return gradleBin
}

async function copyWrapperFiles(sourceDir: string, targetDir: string) {
  const files = ['gradlew', 'gradlew.bat', 'gradle/wrapper/gradle-wrapper.jar', 'gradle/wrapper/gradle-wrapper.properties']
  for (const rel of files) {
    const src = join(sourceDir, rel)
    const dst = join(targetDir, rel)
    if (!(await Bun.file(src).exists())) fail(`missing generated wrapper file: ${src}`)
    await $`mkdir -p ${dirname(dst)}`.quiet()
    await Bun.write(dst, Bun.file(src))
  }
  await $`chmod +x ${join(targetDir, 'gradlew')}`.quiet()
}

async function generateWrapper(androidDir: string, gradleVersion: string, workspaceDir: string) {
  const bootstrapDir = join(workspaceDir, 'bootstrap')
  await $`mkdir -p ${bootstrapDir}`.quiet()
  await Bun.write(join(bootstrapDir, 'settings.gradle.kts'), 'rootProject.name = "wrapper-bootstrap"\n')
  await Bun.write(join(bootstrapDir, 'build.gradle.kts'), '\n')

  const gradleBin = await bootstrapGradle(gradleVersion)
  log(`generate wrapper via Gradle ${gradleVersion}`)

  const proc = Bun.spawn(
    [gradleBin, 'wrapper', '--gradle-version', gradleVersion, '--distribution-type', 'all'],
    { cwd: bootstrapDir, stdout: 'ignore', stderr: 'ignore' },
  )
  await proc.exited
  if (proc.exitCode !== 0) fail(`wrapper task failed for Gradle ${gradleVersion}`)
  await copyWrapperFiles(bootstrapDir, androidDir)
}

const projectDir = resolve(process.env.PROJECT_DIR?.trim() || process.cwd())
const androidDir = await resolveAndroidDir(projectDir)
const gradleVersion = await resolveGradleVersion(androidDir)
const workspaceDir = await mkdtemp(join(tmpdir(), 'android-gradle-wrapper.'))

try {
  await generateWrapper(androidDir, gradleVersion, workspaceDir)
} finally {
  await $`rm -rf ${workspaceDir}`.quiet()
}

log('done')
log(`android_dir: ${androidDir}`)
log(`gradle_version: ${gradleVersion}`)
log(`cache_dir: ${resolveCacheDir()}`)
log(`wrapper: ${join(androidDir, 'gradlew')}`)
