/**
 * Pure notification logic for dsh-desktop-toast: turns a DSH host event into a
 * toast payload, or into `null` when the event must stay silent. No Cordis, no
 * child process, no clock of its own — everything testable takes its inputs as
 * arguments.
 *
 * @module dsh-desktop-toast/notify
 */

/** Longest body line a Windows toast renders without truncating mid-word. */
export const MAX_BODY = 170
/** Longest title a Windows toast renders. */
export const MAX_TITLE = 64

/**
 * Proven-good sender identity: the Start-Menu shortcut every Windows install
 * already has. Toasts from an AUMID with no shortcut behind it are accepted by
 * the API and never shown, so this is the safe default.
 */
export const DEFAULT_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

/** Settings every call merges over; mirrors the cordis.patch.yml defaults. */
export const DEFAULT_SETTINGS = {
  enabled: true,
  notifyApproval: true,
  notifyQuestion: true,
  notifyTurnComplete: true,
  notifyTurnError: true,
  includeReason: true,
  sound: true,
  minIntervalMs: 1500,
  language: 'zh',
  appId: DEFAULT_APP_ID,
}

const COPY = {
  zh: {
    approval: '等待你确认',
    question: '需要你回答',
    completed: '回复完成',
    failure: '回合中断',
    unnamed: '未命名会话',
  },
  en: {
    approval: 'Approval required',
    question: 'Answer required',
    completed: 'Turn completed',
    failure: 'Turn interrupted',
    unnamed: 'Untitled session',
  },
}

const FAILURE_LABEL = {
  zh: {
    aborted: '已中止',
    blocked: '被阻塞',
    error: '出错',
    'max-tokens': '达到输出上限',
    interrupted: '异常中断',
  },
  en: {
    aborted: 'aborted',
    blocked: 'blocked',
    error: 'error',
    'max-tokens': 'output limit',
    interrupted: 'interrupted',
  },
}

/**
 * Flatten whitespace and cut to a length, so one long tool name or model error
 * cannot push the useful part of the toast off screen.
 * @param {unknown} value - candidate text.
 * @param {number} max - maximum kept characters.
 * @returns {string} one line, never longer than `max`.
 */
export function clip(value, max = MAX_BODY) {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/**
 * Join the non-empty parts of one toast body.
 * @param {readonly (string | undefined)[]} parts - body fragments.
 * @returns {string} the joined body.
 */
function body(parts) {
  return clip(parts.filter(part => typeof part === 'string' && part.length > 0).join(' · '))
}

/**
 * Whether a session is a delegated child whose turns must never ring.
 * Subagent children have no human answerer, so a toast about them is noise.
 * @param {{ origin?: string, delegationDepth?: number } | undefined} header - Session header.
 * @returns {boolean} true when this session is a child.
 */
export function isChildSession(header) {
  if (header === undefined || header === null) return false
  return header.origin === 'subagent' || (typeof header.delegationDepth === 'number' && header.delegationDepth > 0)
}

/**
 * Take the copy table for a configured language, defaulting to Chinese.
 * @param {string} language - 'zh' or 'en'.
 * @returns {typeof COPY.zh} the copy table.
 */
function copyFor(language) {
  return language === 'en' ? COPY.en : COPY.zh
}

/**
 * Build the toast for a pending tool approval.
 * @param {{ toolName?: string, reason?: string, label?: string }} input - approval facts.
 * @param {typeof DEFAULT_SETTINGS} settings - effective settings.
 * @returns {{ kind: string, title: string, body: string } | null} the toast, or null when silenced.
 */
export function approvalNotice(input, settings) {
  if (settings.enabled === false || settings.notifyApproval === false) return null
  const copy = copyFor(settings.language)
  const reason = settings.includeReason === false ? undefined : input.reason
  return {
    kind: 'approval',
    title: clip(`DSH · ${copy.approval}`, MAX_TITLE),
    body: body([clip(input.toolName, 60), reason, input.label]),
  }
}

/**
 * Build the toast for a pending structured question (ask_user_question, plan review).
 * @param {{ questions?: readonly { question?: string, header?: string }[], label?: string }} input - question facts.
 * @param {typeof DEFAULT_SETTINGS} settings - effective settings.
 * @returns {{ kind: string, title: string, body: string } | null} the toast, or null when silenced.
 */
export function questionNotice(input, settings) {
  if (settings.enabled === false || settings.notifyQuestion === false) return null
  const copy = copyFor(settings.language)
  const first = input.questions?.[0]
  const asked = first?.header ?? first?.question
  return {
    kind: 'question',
    title: clip(`DSH · ${copy.question}`, MAX_TITLE),
    body: body([clip(asked, 110), input.label]),
  }
}

/**
 * Build the toast for one finished turn.
 * @param {{ reasonKind?: string, errorMessage?: string, label?: string }} input - turn-end facts.
 * @param {typeof DEFAULT_SETTINGS} settings - effective settings.
 * @returns {{ kind: string, title: string, body: string } | null} the toast, or null when silenced.
 */
export function turnNotice(input, settings) {
  if (settings.enabled === false) return null
  const copy = copyFor(settings.language)
  const kind = input.reasonKind ?? 'completed'
  if (kind === 'completed') {
    if (settings.notifyTurnComplete === false) return null
    return {
      kind: 'completed',
      title: clip(`DSH · ${copy.completed}`, MAX_TITLE),
      body: body([input.label]),
    }
  }
  // `forked` is bookkeeping for fork seeds, never a turn the user watched end.
  if (kind === 'forked') return null
  if (settings.notifyTurnError === false) return null
  const failure = FAILURE_LABEL[settings.language === 'en' ? 'en' : 'zh'][kind] ?? kind
  return {
    kind: 'failure',
    title: clip(`DSH · ${copy.failure}`, MAX_TITLE),
    body: body([failure, clip(input.errorMessage, 90), input.label]),
  }
}

/**
 * Create a per-kind cooldown, so a burst of approvals or a reconnecting session
 * cannot stack a wall of toasts.
 * @param {{ minIntervalMs?: number, now?: () => number }} options - cooldown configuration.
 * @returns {(kind: string) => boolean} true when the caller may fire now.
 */
export function createCooldown(options = {}) {
  const minIntervalMs = typeof options.minIntervalMs === 'number' ? options.minIntervalMs : DEFAULT_SETTINGS.minIntervalMs
  const now = options.now ?? Date.now
  const last = new Map()
  return (kind) => {
    const at = now()
    const previous = last.get(kind)
    if (previous !== undefined && at - previous < minIntervalMs) return false
    last.set(kind, at)
    return true
  }
}

/**
 * Merge patch config over the defaults, ignoring unknown shapes.
 * @param {Record<string, unknown> | undefined} config - composition config.
 * @returns {typeof DEFAULT_SETTINGS} effective settings.
 */
export function resolveSettings(config) {
  const merged = { ...DEFAULT_SETTINGS }
  if (config === undefined || config === null) return merged
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const value = config[key]
    if (value === undefined || value === null) continue
    merged[key] = value
  }
  return merged
}
