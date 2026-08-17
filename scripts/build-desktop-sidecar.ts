/** Build the Tauri desktop Node sidecar from the installed CLI deployment closure. */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const staging = resolve(root, 'apps/desktop/.sidecar')
const binaries = resolve(root, 'apps/desktop/src-tauri/binaries')
const pkgSpec = '@yao-pkg/pkg@6.21.0'

interface Target { tauri: string; pkg: string; extension: string }

function targetFor(triple: string): Target {
  const targets: Record<string, Target> = {
    'aarch64-apple-darwin': { tauri: triple, pkg: 'node24-macos-arm64', extension: '' },
    'x86_64-apple-darwin': { tauri: triple, pkg: 'node24-macos-x64', extension: '' },
    'x86_64-pc-windows-msvc': { tauri: triple, pkg: 'node24-win-x64', extension: '.exe' },
    'aarch64-pc-windows-msvc': { tauri: triple, pkg: 'node24-win-arm64', extension: '.exe' },
  }
  const target = targets[triple]
  if (target === undefined) throw new Error(`build-desktop-sidecar: unsupported Tauri target ${triple}`)
  return target
}

async function run(command: string, args: string[]): Promise<void> {
  console.log(`build-desktop-sidecar: ${command} ${args.join(' ')}`)
  await execFileAsync(command, args, { cwd: root, maxBuffer: 16 * 1024 * 1024 })
}

async function hostTriple(): Promise<string> {
  const { stdout } = await execFileAsync('rustc', ['-Vv'], { cwd: root })
  const triple = stdout.split('\n').find(line => line.startsWith('host: '))?.slice('host: '.length).trim()
  if (triple === undefined) throw new Error('build-desktop-sidecar: rustc did not report a host target')
  return triple
}

async function main(): Promise<void> {
  const args = parseArgs({ options: { 'skip-build': { type: 'boolean', default: false }, target: { type: 'string' } } }).values
  const triple = args.target ?? process.env['TAURI_ENV_TARGET_TRIPLE'] ?? await hostTriple()
  const target = targetFor(triple)
  if (!args['skip-build']) await run('pnpm', ['run', 'build'])

  await rm(staging, { recursive: true, force: true })
  await run('pnpm', ['deploy', '--filter', '@deepseek-ai/dsh', '--prod', '--legacy', '--ignore-scripts', '--config.node-linker=hoisted', '--config.auto-install-peers=false', '--config.link-workspace-packages=true', staging])

  const manifestPath = join(staging, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
  await writeFile(manifestPath, `${JSON.stringify({
    ...manifest,
    bin: 'lib/bin.js',
    pkg: { assets: ['config/**', 'node_modules/**/*.js', 'node_modules/**/*.cjs', 'node_modules/**/*.mjs', 'node_modules/**/*.json', 'node_modules/**/*.node', 'node_modules/**/*.wasm'] },
  }, null, 2)}\n`)

  await mkdir(binaries, { recursive: true })
  const output = join(binaries, `dsh-desktop-runtime-${target.tauri}${target.extension}`)
  await run('pnpm', ['dlx', pkgSpec, staging, '--sea', '--targets', target.pkg, '--output', output])
  if (!existsSync(output)) throw new Error(`build-desktop-sidecar: pkg did not produce ${output}`)
  console.log(`build-desktop-sidecar: created ${output}`)
}

await main()
