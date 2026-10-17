/** Exercise filtered Desktop native and HTML dependencies under its Electron Node runtime. */

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkPnpm } from './pnpm-smoke.mjs'

const runtime = process.argv[2]
assert.ok(runtime, 'Pass the filtered resources/dsh directory')
const root = resolve(runtime)
const descriptor = JSON.parse(readFileSync(join(root, 'desktop-runtime.json'), 'utf8'))
assert.equal(process.versions.node, descriptor.release.nodeVersion, 'Run with the Electron Node runtime version')
assert.equal(process.platform, descriptor.platform)
assert.equal(process.arch, descriptor.arch)
const resourcesRuntime = process.argv[3] ?? join(dirname(root), 'runtime')
const requireRuntime = createRequire(join(root, 'package.json'))
const scratch = mkdtempSync(join(tmpdir(), 'dsh-runtime-payload-'))

/** Spawn only a fixed Node program and await the terminal's drained exit event. */
async function checkPty() {
  const pty = requireRuntime('node-pty')
  const script = join(scratch, 'pty.cjs')
  writeFileSync(script, "process.stdout.write('runtime-payload-pty-ok\\n')\n", { flag: 'wx', mode: 0o600 })
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
    /^(?:path|systemroot|windir|comspec|ELECTRON_RUN_AS_NODE)$/iu.test(name)
  )))
  Object.assign(env, { HOME: scratch, USERPROFILE: scratch, TMP: scratch, TEMP: scratch, TMPDIR: scratch })
  env.DSH_DESKTOP_NODE_EXECUTABLE = process.execPath
  env.PATH = `${join(resourcesRuntime, 'bin')}${delimiter}${env.PATH ?? env.Path ?? ''}`
  // A Windows GUI executable needs a console-owning shell when launched inside ConPTY.
  const executable = process.platform === 'win32' ? process.env.ComSpec : process.execPath
  const args = process.platform === 'win32' ? ['/d', '/c', 'node', script] : [script]
  // Mirror the product's Windows allocation: the console host node-pty ships.
  const terminal = pty.spawn(executable, args, {
    cwd: scratch, env, cols: 80, rows: 24,
    ...(process.platform === 'win32' ? { useConptyDll: true } : {}),
  })
  let output = ''
  let exited = false
  let timedOut = false
  let exitSubscription
  const exit = new Promise(resolveExit => {
    exitSubscription = terminal.onExit(event => {
      exited = true
      resolveExit(event)
    })
  })
  const dataSubscription = terminal.onData(data => { output += data })
  let timer
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        reject(new Error('Packaged PTY did not exit within 45 seconds'))
      }, 45_000)
    })
    const result = await Promise.race([exit, deadline])
    assert.equal(timedOut, false)
    assert.ok(result.signal === undefined || result.signal === 0, 'PTY exited without a signal')
    assert.equal(result.exitCode, 0)
    assert.match(output, /runtime-payload-pty-ok/u)
  } finally {
    clearTimeout(timer)
    dataSubscription.dispose()
    try {
      // node-pty's Windows natural-exit event closes output but leaves its ConPTY worker owned by kill().
      if (!exited || process.platform === 'win32') terminal.kill()
      await exit
    } finally {
      exitSubscription.dispose()
    }
  }
}

/** Exercise grep and glob operations with the search tool's resolved native executable. */
async function checkSearch() {
  const { resolveRgPath } = await import(pathToFileURL(requireRuntime.resolve('@deepseek-ai/dsh-tool-fs-search')).href)
  const executable = await resolveRgPath()
  const name = 'ripgrep-smoke.txt'
  const marker = 'desktop-ripgrep-smoke'
  writeFileSync(join(scratch, name), `${marker}\n`, { flag: 'wx', mode: 0o600 })
  const run = args => execFileSync(executable, ['--no-config', ...args], {
    cwd: scratch, encoding: 'utf8', timeout: 45_000, windowsHide: true,
    env: Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:systemroot|windir)$/iu.test(name))),
  }).trim().replaceAll('\\', '/')
  assert.equal(run(['--no-heading', '--no-filename', '--line-number', '--fixed-strings', '--', marker, name]), `1:${marker}`)
  assert.equal(run(['--files', '--glob', name, '.']), `./${name}`)
}

/** Resolve one system function through Koffi's packaged native module. */
function checkKoffi() {
  const koffi = requireRuntime('koffi')
  const library = koffi.load(process.platform === 'win32' ? 'kernel32.dll' : null)
  try {
    const getPid = process.platform === 'win32'
      ? library.func('uint32_t __stdcall GetCurrentProcessId(void)')
      : library.func('int getpid(void)')
    assert.equal(getPid(), process.pid)
  } finally {
    library.unload()
  }
}

/** Encode and decode a pixel through the packaged libvips binary.
 *  Electron's Linux binaries leak system glib symbols into the process, which crashes libvips'
 *  bundled copy (electron/electron#46323), so Linux probes Sharp in a child process and reports
 *  the crash instead of letting it abort the whole payload; every other platform checks in-process. */
async function checkSharp() {
  const encodeAndDecode = async sharp => {
    const pixel = Buffer.from([17, 103, 231])
    const png = await sharp(pixel, { raw: { width: 1, height: 1, channels: 3 } }).png().toBuffer()
    const decoded = await sharp(png).raw().toBuffer({ resolveWithObject: true })
    assert.equal(decoded.info.width, 1)
    assert.equal(decoded.info.height, 1)
    assert.equal(decoded.info.channels, 3)
    assert.deepEqual(decoded.data, pixel)
  }
  if (process.platform !== 'linux') {
    await encodeAndDecode(requireRuntime('sharp'))
    return true
  }
  const probe = join(scratch, 'sharp-payload-probe.mjs')
  writeFileSync(probe, `
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const sharp = createRequire(process.argv[2] + '/package.json')('sharp')
const pixel = Buffer.from([17, 103, 231])
const png = await sharp(pixel, { raw: { width: 1, height: 1, channels: 3 } }).png().toBuffer()
const decoded = await sharp(png).raw().toBuffer({ resolveWithObject: true })
assert.equal(decoded.info.width, 1)
assert.equal(decoded.info.height, 1)
assert.equal(decoded.info.channels, 3)
assert.deepEqual(decoded.data, pixel)
`, { flag: 'wx', mode: 0o600 })
  const outcome = spawnSync(process.execPath, ['--expose-internals', probe, root], {
    timeout: 45_000, windowsHide: true, env: { ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? '1' },
  })
  if (outcome.error !== undefined || (outcome.status !== null && outcome.status !== 0)) {
    const stderrTail = String(outcome.stderr ?? '').split('\n').slice(-8).join('\n').trim()
    assert.fail(`sharp payload probe failed under Electron on Linux`
      + ` (${outcome.error?.message ?? `exit ${outcome.status}`})\n${stderrTail}`)
  }
  if (outcome.status !== 0) {
    process.stdout.write(`desktop payload smoke: sharp crashed under Electron on Linux`
      + ` (signal ${String(outcome.signal)}; electron/electron#46323 leaks system glib`
      + ' symbols that crash libvips); image processing needs an upstream or packaging fix outside this payload\n')
    return false
  }
  return true
}

/** Exercise Domino parsing through the HTML converter and GFM plugin used by web_fetch. */
function checkHtml() {
  const Turndown = requireRuntime('turndown')
  const { gfm } = requireRuntime('@joplin/turndown-plugin-gfm')
  const converter = new Turndown({ bulletListMarker: '-' })
  converter.use(gfm)
  const markdown = converter.turndown('<p>A &amp; B &copy;</p><ul><li>first</li><li>second</li></ul>'
    + '<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>x</td><td>7</td></tr></tbody></table>')
  assert.match(markdown, /A & B ©/u)
  assert.match(markdown, /-\s+first\n-\s+second/u)
  assert.match(markdown, /\| Name \| Value \|/u)
  assert.match(markdown, /\| x\s+\| 7\s+\|/u)
}

let sharpNative = false
try {
  const builtin = requireRuntime('node-addon-require-builtin')
  assert.equal(typeof builtin.requireBuiltin('internal/modules/esm/loader').getOrInitializeCascadedLoader, 'function')
  console.error('runtime payload: pnpm')
  await checkPnpm(resourcesRuntime)
  console.error('runtime payload: koffi')
  checkKoffi()
  console.error('runtime payload: sharp')
  sharpNative = await checkSharp()
  console.error('runtime payload: html')
  checkHtml()
  console.error('runtime payload: pty')
  await checkPty()
  console.error('runtime payload: search')
  await checkSearch()
  console.error('runtime payload: checks complete; awaiting process exit')
} finally {
  // This private tree contains only fixture files; Windows may release handles after terminal exit.
  await rm(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 })
}

// Natural event-loop drain includes node-pty's worker and console-list helper teardown.
process.once('beforeExit', () => {
  console.log(JSON.stringify({ node: process.versions.node, platform: process.platform, arch: process.arch,
    koffi: true, sharp: sharpNative, html: true, pty: true, pnpm: true, grep: true, glob: true }))
})
