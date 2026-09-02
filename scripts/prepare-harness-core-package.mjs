#!/usr/bin/env node

import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const versionArg = process.argv.find((arg) => arg.startsWith('--version='))
const version = versionArg?.slice('--version='.length)
const packageRoot = resolve(process.cwd())
const projectRoot = resolve(import.meta.dirname, '..')

if (!version) {
  throw new Error('missing required --version=<dsh-version>')
}

const packageJsonPath = join(packageRoot, 'package.json')
const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
manifest.name = 'deepseek-harness-pkg'
manifest.version = version
manifest.description = 'Standalone DeepSeek Harness runtime package'
manifest.private = true
manifest.dependencies = {
  ...manifest.dependencies,
  koffi: manifest.dependencies?.koffi ?? '3.1.4',
}
writeFileSync(packageJsonPath, JSON.stringify(manifest, null, 2) + '\n')

const npmArgs = ['install', '--omit=dev']
if (process.platform === 'win32') {
  execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd', ...npmArgs], {
    cwd: packageRoot,
    stdio: 'inherit',
  })
} else {
  execFileSync('npm', npmArgs, {
    cwd: packageRoot,
    stdio: 'inherit',
  })
}

execFileSync(process.execPath, [join(projectRoot, 'scripts/apply-dsh-web-app-patch.mjs')], {
  cwd: packageRoot,
  stdio: 'inherit',
})

const entry = join(packageRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const startup = join(packageRoot, 'node_modules/@deepseek-ai/dsh-web-app/lib/startup.js')
if (!existsSync(entry) || !existsSync(startup)) {
  throw new Error('standalone package is missing the dsh runtime entry or web app')
}

const startupSource = readFileSync(startup, 'utf8')
if (!startupSource.includes('DSH_PKG_ALLOW_LAN')) {
  throw new Error('dsh-web-app LAN safety patch was not applied')
}

const help = execFileSync(process.execPath, [entry, 'web', '--help'], {
  cwd: packageRoot,
  encoding: 'utf8',
})
if (!help.includes('Serve the DeepSeek Harness browser UI')) {
  throw new Error('dsh web help verification failed')
}

const binDir = join(packageRoot, 'node_modules/.bin')
for (const file of ['dsh', 'dsh.cmd', 'dsh.ps1']) {
  rmSync(join(binDir, file), { force: true })
}

writeFileSync(
  join(binDir, 'dsh'),
  '#!/bin/sh\nexec "$(dirname "$0")/../@deepseek-ai/dsh/lib/bin.js" "$@"\n',
)
writeFileSync(
  join(binDir, 'dsh.cmd'),
  '@echo off\r\nnode "%~dp0..\\@deepseek-ai\\dsh\\lib\\bin.js" %*\r\n',
)
writeFileSync(
  join(binDir, 'dsh.ps1'),
  'node "$PSScriptRoot/../@deepseek-ai/dsh/lib/bin.js" $args\r\n',
)
if (process.platform !== 'win32') {
  chmodSync(join(binDir, 'dsh'), 0o755)
}

console.log('prepared standalone core package: ' + packageRoot)
