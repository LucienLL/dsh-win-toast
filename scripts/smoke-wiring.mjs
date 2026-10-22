/**
 * Wiring smoke test for dsh-desktop-toast: runs `apply()` against a fake Cordis
 * context, drives the two interaction waterfalls and one `turn/end`, and reports
 * whether the plugin ever wrote a warning (a failed toast, a broken handler).
 *
 * Run: node scripts/smoke-wiring.mjs
 */
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const warnings = []
const originalWarn = console.warn
console.warn = (...args) => {
  warnings.push(args.join(' '))
}

const handlers = new Map()
const disposers = []
const ctx = {
  on(event, handler) {
    handlers.set(event, handler)
    return () => handlers.delete(event)
  },
  effect(factory) {
    disposers.push(factory())
  },
  get() {
    return undefined
  },
}

// DSH_TOAST_APPID lets the smoke run target a registered sender identity
// (default: the zero-setup PowerShell AUMID).
apply(ctx, {
  language: 'zh',
  minIntervalMs: 0,
  ...(process.env.DSH_TOAST_APPID ? { appId: process.env.DSH_TOAST_APPID } : {}),
})

assert.deepEqual([...handlers.keys()].sort(), ['approval/request', 'session/event', 'user-questions/request'])

const rootSession = { header: { cwd: 'E:\\Deepseek\\PluginCreating' } }
const childSession = { header: { cwd: 'E:\\Deepseek\\PluginCreating', origin: 'subagent', delegationDepth: 1 } }

// 1. An approval must toast AND still delegate to the real answerer.
const approvalOutcome = await handlers.get('approval/request').call(
  {},
  { toolName: 'pwsh', reason: 'wiring smoke', agent: { session: rootSession } },
  async () => 'allowed-once',
)
assert.equal(approvalOutcome, 'allowed-once', 'approval waterfall must be delegated unchanged')

// 2. A finished root turn must toast.
handlers.get('session/event')(rootSession, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

// 3. A delegated child turn must stay silent.
handlers.get('session/event')(childSession, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
handlers.get('session/event')(childSession, { type: 'turn/end', data: { turn: 2, reason: { kind: 'error', error: { message: 'child failed' } } } })

// 4. Teardown must be idempotent-safe and remove every listener.
for (const dispose of disposers) dispose()
assert.equal(handlers.size, 0, 'every listener must be disposed')

setTimeout(() => {
  console.warn = originalWarn
  const summary = { warnings }
  originalWarn(JSON.stringify(summary, null, 2))
  if (warnings.length > 0) process.exitCode = 1
}, 2500)
