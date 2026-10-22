/**
 * Unit tests for the pure notification logic. Run as a main module:
 *   node test/notify.test.mjs
 * (`node --test` spawns piped children, which a confined DSH sandbox blocks.)
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_SETTINGS,
  MAX_BODY,
  approvalNotice,
  clip,
  createCooldown,
  isChildSession,
  questionNotice,
  resolveSettings,
  turnNotice,
} from '../lib/notify.js'

test('clip flattens whitespace and cuts with an ellipsis', () => {
  assert.equal(clip('  a\n\t b  '), 'a b')
  assert.equal(clip('abcdef', 4), 'abc…')
  assert.equal(clip(undefined), '')
  assert.equal(clip(null), '')
  assert.equal(clip(42), '42')
  assert.ok(clip('x'.repeat(500)).length <= MAX_BODY)
})

test('isChildSession only recognizes delegated children', () => {
  assert.equal(isChildSession(undefined), false)
  assert.equal(isChildSession({}), false)
  assert.equal(isChildSession({ delegationDepth: 0 }), false)
  assert.equal(isChildSession({ origin: 'subagent' }), true)
  assert.equal(isChildSession({ delegationDepth: 2 }), true)
})

test('approvalNotice renders the tool and its reason', () => {
  const notice = approvalNotice({ toolName: 'pwsh', reason: 'writes outside the workspace', label: 'demo' }, DEFAULT_SETTINGS)
  assert.equal(notice.kind, 'approval')
  assert.equal(notice.title, 'DSH · 等待你确认')
  assert.equal(notice.body, 'pwsh · writes outside the workspace · demo')
})

test('approvalNotice drops the reason when includeReason is off', () => {
  const settings = { ...DEFAULT_SETTINGS, includeReason: false }
  assert.equal(approvalNotice({ toolName: 'pwsh', reason: 'secret detail', label: 'demo' }, settings).body, 'pwsh · demo')
})

test('every notice honors its own switch and the master switch', () => {
  assert.equal(approvalNotice({ toolName: 'pwsh' }, { ...DEFAULT_SETTINGS, notifyApproval: false }), null)
  assert.equal(questionNotice({ questions: [{ question: 'q' }] }, { ...DEFAULT_SETTINGS, notifyQuestion: false }), null)
  assert.equal(turnNotice({ reasonKind: 'completed' }, { ...DEFAULT_SETTINGS, notifyTurnComplete: false }), null)
  assert.equal(turnNotice({ reasonKind: 'error' }, { ...DEFAULT_SETTINGS, notifyTurnError: false }), null)
  assert.equal(turnNotice({ reasonKind: 'completed' }, { ...DEFAULT_SETTINGS, enabled: false }), null)
  assert.equal(approvalNotice({ toolName: 'pwsh' }, { ...DEFAULT_SETTINGS, enabled: false }), null)
})

test('questionNotice prefers the question header and tolerates an empty batch', () => {
  assert.equal(
    questionNotice({ questions: [{ header: '部署方式', question: 'long form?' }], label: 'demo' }, DEFAULT_SETTINGS).body,
    '部署方式 · demo',
  )
  assert.equal(questionNotice({ questions: [] }, DEFAULT_SETTINGS).body, '')
  assert.equal(questionNotice({}, DEFAULT_SETTINGS).body, '')
})

test('turnNotice separates completion from every failure kind', () => {
  assert.deepEqual(turnNotice({ reasonKind: 'completed', label: 'demo' }, DEFAULT_SETTINGS), {
    kind: 'completed', title: 'DSH · 回复完成', body: 'demo',
  })
  const error = turnNotice({ reasonKind: 'error', errorMessage: 'ENOSPC', label: 'demo' }, DEFAULT_SETTINGS)
  assert.equal(error.kind, 'failure')
  assert.equal(error.body, '出错 · ENOSPC · demo')
  assert.equal(turnNotice({ reasonKind: 'aborted' }, DEFAULT_SETTINGS).body, '已中止')
  assert.equal(turnNotice({ reasonKind: 'max-tokens' }, DEFAULT_SETTINGS).body, '达到输出上限')
  assert.equal(turnNotice({ reasonKind: 'interrupted' }, DEFAULT_SETTINGS).body, '异常中断')
  // A fork seed closer is bookkeeping, never a turn the user watched end.
  assert.equal(turnNotice({ reasonKind: 'forked' }, DEFAULT_SETTINGS), null)
})

test('turnNotice localizes to English on request', () => {
  const settings = { ...DEFAULT_SETTINGS, language: 'en' }
  assert.equal(turnNotice({ reasonKind: 'completed' }, settings).title, 'DSH · Turn completed')
  assert.equal(turnNotice({ reasonKind: 'aborted' }, settings).body, 'aborted')
  assert.equal(approvalNotice({ toolName: 'pwsh' }, settings).title, 'DSH · Approval required')
})

test('createCooldown suppresses repeats of one kind only', () => {
  let now = 0
  const allow = createCooldown({ minIntervalMs: 100, now: () => now })
  assert.equal(allow('approval'), true)
  assert.equal(allow('approval'), false)
  assert.equal(allow('completed'), true)
  now = 100
  assert.equal(allow('approval'), true)
})

test('resolveSettings merges known keys and ignores unknown ones', () => {
  const merged = resolveSettings({ notifyApproval: false, minIntervalMs: 50, nonsense: 'x' })
  assert.equal(merged.notifyApproval, false)
  assert.equal(merged.minIntervalMs, 50)
  assert.equal('nonsense' in merged, false)
  assert.equal(merged.notifyQuestion, DEFAULT_SETTINGS.notifyQuestion)
  assert.deepEqual(resolveSettings(undefined), DEFAULT_SETTINGS)
})
