# dsh-win-toast

DeepSeek Harness 的 Windows 原生通知插件：**需要你确认 / 回答时**、**回合结束时**，由 DSH 宿主进程直接弹系统通知（不依赖浏览器标签页在前台）。

> 曾用名 `dsh-desktop-toast`。该 npm 名称已由其他作者先占用（同功能、`0.1.2`），本项目改名 `dsh-win-toast` 发布，代码与仓库均为独立实现。

## 为什么是宿主侧

DSH 的确认与提问是"浏览器端应答、宿主端永久等待"的模型：只要标签页不在前台，你就可能完全错过一个正在等你的弹窗。本插件不走浏览器 `Notification`，而是在宿主进程里观察事件、调用 Windows Toast API，所以标签页被切走、最小化、被浏览器冻结时依然会提醒。

能做的只有提醒本身：真正答复仍需要在 DSH 页面里点。

## 触发点

| 事件 | 默认 | 通知标题 |
| --- | --- | --- |
| `approval/request`（工具执行需要确认） | 开 | `DSH · 等待你确认` |
| `user-questions/request`（`ask_user_question`、计划确认） | 开 | `DSH · 需要你回答` |
| `turn/end` 且 `reason.kind === 'completed'` | 开 | `DSH · 回复完成` |
| `turn/end` 且为 `error` / `aborted` / `blocked` / `max-tokens` / `interrupted` | 开 | `DSH · 回合中断` |

不提醒的情况：

- 子智能体会话（`header.origin === 'subagent'` 或 `delegationDepth > 0`）——它们没有人类应答者，提醒只算噪声。
- `turn/end` 的 `forked` 原因——那是 fork 种子的记账事件，不是你看着结束的回合。
- 同类通知小于 `minIntervalMs` 的重复（默认 1.5s），防止突发刷屏。

## 安装

```powershell
# 从 npm（推荐）
dsh plugin --profile web add dsh-win-toast

# 或从本地检出
dsh plugin --profile web add <本目录路径>
```

然后重启 DSH web（插件是宿主侧插件，需要重新组合）。

同生态的替代实现（同样功能、不同作者）：`dsh-desktop-toast`、`dsh-desktop-notify`、`dsh-notify-me`。装之前建议只留一个，否则同一次确认会收到多条通知。

## 发送方身份（一次性，可选）

Windows 只认"与 AUMID 同名的开始菜单快捷方式"来决定通知的发送方名称与图标；没有快捷方式的 AUMID 会被 API 接受、然后被系统静默丢弃。所以：

- **不注册**：默认使用 `{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe`（系统自带，已实测可达），但发送方显示为"Windows PowerShell"。
- **注册**（推荐外观）：在开始菜单建一个带 AppID 的快捷方式，通知改显示为 **DeepSeek Harness** + DSH 图标。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/register-aumid.ps1 `
  -Aumid 'DeepSeek.Harness.Notify' `
  -TargetPath 'E:\Program Files\DeepSeek Harness\DeepSeek Harness.exe' `
  -IconPath 'E:\Program Files\DeepSeek Harness\DeepSeek Harness.ico'

# 撤销
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/register-aumid.ps1 `
  -Aumid 'DeepSeek.Harness.Notify' -Unregister
```

注册后把配置里的 `appId` 设成同一个 AUMID；没注册就把 `appId` 留空/改回默认的 PowerShell AUMID。

## 配置项（Settings → Plugins）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | true | 总开关 |
| `notifyApproval` | true | 工具确认提醒 |
| `notifyQuestion` | true | 提问 / 计划确认提醒 |
| `notifyTurnComplete` | true | 回合完成提醒 |
| `notifyTurnError` | true | 回合异常提醒 |
| `includeReason` | true | 确认通知里是否附带工具给出的理由 |
| `sound` | true | 是否播放系统提示音 |
| `minIntervalMs` | 1500 | 同类通知最小间隔 |
| `language` | zh | `zh` / `en` |
| `appId` | PowerShell AUMID | 通知发送方身份 |

## 实现要点

- 监听 `approval/request` 与 `user-questions/request` 时以 `{ prepend: true }` 注册，弹完通知**原样 `next()` 交还给真正的应答者**，绝不吞掉请求、绝不改变审批结果。所有回调都包在 try/catch 里：通知失败不能影响审批链路。
- 每次通知是一次短命的 `powershell.exe -File lib/toast.ps1`（约 0.3–0.6s）。必须用 Windows PowerShell 5.1——PowerShell 7 已移除 WinRT 投影，`Windows.UI.Notifications` 在 7 里不可用。
- 同一时刻只跑一个通知进程，后来的覆盖尚未启动的旧通知。
- `lib/toast.ps1` 是纯 ASCII：Windows PowerShell 5.1 会按当前 ANSI 代码页解析无 BOM 的 UTF-8 脚本，源码里的中文会把它弄坏；所有中文正文只经由参数（UTF-16 命令行）传入。

## 已知边界

- **Windows 专注助手 / 勿扰模式、以及每个 AUMID 的通知开关拥有最终否决权**，插件无法绕过。
- 通知正文只包含工具名、理由、会话标题——不含工具参数，避免把敏感内容推到锁屏界面。若不希望会话标题出现在通知里，可关闭对应开关。
- DSH 标签页完全关闭时，审批本身仍会 fail-closed 拒绝；通知只能起提醒作用。

## 验证

```powershell
node --check lib/index.js
node test/notify.test.mjs        # 纯逻辑单测（10 项）
node scripts/smoke-wiring.mjs    # 假 ctx 跑通三条监听 + 瀑布委托，并实测发通知
```

`smoke-wiring.mjs` 结束后可以用 PowerShell 查 toast 历史，确认真正送达：

```powershell
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]
([Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory('DeepSeek.Harness.Notify')).Count
```
