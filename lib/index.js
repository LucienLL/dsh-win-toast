/**
 * dsh-desktop-toast — Windows desktop toasts for DeepSeek Harness, fired from
 * the host process rather than from the browser tab.
 *
 * It observes two interaction waterfalls without ever answering them (each
 * listener fires its toast and then delegates with `next()`), plus the durable
 * `turn/end` event, and shows one Windows toast per interesting moment:
 * a pending approval, a pending question, a finished turn, or a broken turn.
 *
 * The toast itself is one short-lived `powershell.exe` (Windows PowerShell 5.1,
 * the only PowerShell with WinRT projections) running lib/toast.ps1.
 *
 * @module dsh-desktop-toast
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_APP_ID,
  approvalNotice,
  createCooldown,
  isChildSession,
  questionNotice,
  resolveSettings,
  turnNotice,
} from './notify.js'

const LOG_PREFIX = 'dsh-desktop-toast:'
/** Absolute path of the toast script, resolved once from this module's location. */
const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'toast.ps1')

export const name = 'dsh-desktop-toast'

/** No services are injected: every fact arrives through `ctx.on`. */
export const inject = []

export const Config = z.object({
  enabled: z.boolean().default(true).description('总开关：关闭后不再弹出任何 Windows 通知'),
  notifyApproval: z.boolean().default(true).description('工具执行需要你确认时弹通知'),
  notifyQuestion: z.boolean().default(true).description('需要你回答问题或确认计划时弹通知'),
  notifyTurnComplete: z.boolean().default(true).description('一个回合正常完成时弹通知'),
  notifyTurnError: z.boolean().default(true).description('回合出错、中止、阻塞或达到输出上限时弹通知'),
  includeReason: z.boolean().default(true).description('确认类通知附带工具给出的理由文本'),
  sound: z.boolean().default(true).description('通知是否播放系统提示音'),
  minIntervalMs: z.number().default(1500).description('同类通知的最小间隔（毫秒），用于抑制突发刷屏'),
  language: z.string().default('zh').description('通知文案语言：zh 或 en'),
  appId: z.string().default(DEFAULT_APP_ID).description('通知发送方 AUMID；默认值对应 Windows 自带的 PowerShell 快捷方式，改前请确认该 AUMID 已注册，否则通知会被静默丢弃'),
})

/**
 * Report one non-fatal problem to the server log; never throws.
 * @param {string} message - what went wrong.
 */
function warn(message) {
  console.warn(`${LOG_PREFIX} ${message}`)
}

/**
 * Resolve the Windows PowerShell 5.1 executable, which is the only PowerShell
 * that still exposes the WinRT toast projections.
 * @returns {string} absolute path, or the bare command name as a last resort.
 */
function resolvePowerShell() {
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  const absolute = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(absolute) ? absolute : 'powershell.exe'
}

/**
 * Read a short human label for a session: its title when the title service is
 * mounted, otherwise the workspace folder, otherwise a fixed placeholder.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ header?: { cwd?: string } } | undefined} session - session to label.
 * @returns {string} label safe to render in a toast.
 */
function labelOf(ctx, session) {
  try {
    const title = ctx.get('sessionTitle')?.get(session)?.title
    if (typeof title === 'string' && title.length > 0) return title
  } catch {
    // The title service is optional; the fallbacks below are the normal path then.
  }
  const cwd = session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? basename(cwd) : ''
}

/**
 * Label whatever session an approval or question request belongs to.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ session?: unknown } | undefined} agent - requesting agent.
 * @returns {string} label safe to render in a toast.
 */
function labelOfAgent(ctx, agent) {
  return labelOf(ctx, agent?.session)
}

/**
 * Install the toast listeners for one composed plugin instance.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context.
 * @param {Record<string, unknown>} config - composition config from cordis.patch.yml.
 */
export function apply(ctx, config) {
  if (process.platform !== 'win32') {
    warn(`desktop toasts need Windows; this host is ${process.platform}, so nothing is registered`)
    return
  }

  const settings = resolveSettings(config)
  if (settings.enabled === false) return

  const shell = resolvePowerShell()
  const allow = createCooldown({ minIntervalMs: settings.minIntervalMs })

  /** At most one queued toast: a newer moment replaces an unstarted older one. */
  let queued = null
  let running = false

  /** Run one toast script and report its real outcome. */
  function run(notice) {
    running = true
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      SCRIPT_PATH,
      '-Title',
      notice.title,
      '-Body',
      notice.body,
      '-AppId',
      String(settings.appId),
      '-Sound',
      settings.sound === false ? 'off' : 'on',
    ]
    let child
    try {
      child = spawn(shell, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      running = false
      warn(`could not start PowerShell: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    let stdout = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < 4096) stdout += chunk
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      warn(`PowerShell stderr: ${String(chunk).trim()}`)
    })
    child.on('error', (error) => {
      warn(`toast process failed: ${error.message}`)
    })
    child.on('close', (code) => {
      running = false
      if (code !== 0) {
        warn(`toast not delivered (exit ${String(code)}): ${stdout.trim() || 'no output'}`)
      }
      const next = queued
      queued = null
      if (next !== null) run(next)
    })
  }

  /** Send one notice, honoring the per-kind cooldown and the single-flight queue. */
  function fire(notice) {
    if (notice === null || notice === undefined) return
    if (!allow(notice.kind)) return
    if (running) {
      queued = notice
      return
    }
    run(notice)
  }

  ctx.effect(() => {
    const offApproval = ctx.on('approval/request', function (request, next) {
      try {
        if (isChildSession(request?.agent?.session?.header)) return next()
        fire(approvalNotice({
          toolName: request?.toolName,
          reason: request?.reason,
          label: labelOfAgent(ctx, request?.agent),
        }, settings))
      } catch (error) {
        warn(`approval listener: ${error instanceof Error ? error.message : String(error)}`)
      }
      return next()
    }, { prepend: true })

    const offQuestion = ctx.on('user-questions/request', function (request, next) {
      try {
        if (isChildSession(request?.agent?.session?.header)) return next()
        fire(questionNotice({
          questions: request?.questions,
          label: labelOfAgent(ctx, request?.agent),
        }, settings))
      } catch (error) {
        warn(`question listener: ${error instanceof Error ? error.message : String(error)}`)
      }
      return next()
    }, { prepend: true })

    const offSession = ctx.on('session/event', (session, event) => {
      if (event?.type !== 'turn/end') return
      if (isChildSession(session?.header)) return
      try {
        const reason = event.data?.reason ?? {}
        fire(turnNotice({
          reasonKind: reason.kind,
          errorMessage: reason.error?.message,
          label: labelOf(ctx, session),
        }, settings))
      } catch (error) {
        warn(`session listener: ${error instanceof Error ? error.message : String(error)}`)
      }
    })

    return () => {
      offApproval()
      offQuestion()
      offSession()
    }
  }, 'dsh-desktop-toast: listeners')
}
