#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const fileArg = process.argv.find((arg) => arg.startsWith('--file='))
const file = fileArg
  ? fileArg.slice('--file='.length)
  : 'node_modules/@deepseek-ai/dsh-web-app/lib/startup.js'
const abs = resolve(file)

const source = readFileSync(abs, 'utf8')
if (source.includes('DSH_PKG_ALLOW_LAN')) {
  console.log('already patched: ' + abs)
  process.exit(0)
}

const guard =
  /^(\s*)if \(options\.host === "0\.0\.0\.0"\) program\.error\("error: --host 0\.0\.0\.0[^\n]*$/m
const match = source.match(guard)
if (!match) {
  console.error(
    'dsh-web-app startup.js no longer contains the 0.0.0.0 guard (' +
      abs +
      '); update scripts/apply-dsh-web-app-patch.mjs',
  )
  process.exit(1)
}

const indent = match[1]
const replacement = [
  indent + 'const allowLan = process.env.DSH_PKG_ALLOW_LAN === "1";',
  indent +
    'if (options.host === "0.0.0.0" && !allowLan) program.error("error: --host 0.0.0.0 is blocked for safety: it would expose remote code execution to the network; set DSH_PKG_ALLOW_LAN=1 to opt in");',
].join('\n')

writeFileSync(abs, source.replace(guard, replacement))
console.log('patched: ' + abs)
