import type { HostContext } from './types'
import { createHash } from 'node:crypto'
import { readStylesCache, stylesCachePath, writeStylesCache } from './cache'
import { compilePlugins } from './compiler'
import { BOOT_HINT, BOOT_REVEAL_DELAY_MS, BOOT_ROOT_ID, BOOT_STYLE_ID, BOOT_WORDMARK, PLUGIN_ID, POLL_INTERVAL_MS, STYLESHEET_PATH } from './constants'

export const name = PLUGIN_ID
export const inject = ['clientModules', 'webServer', 'connection']

/**
 * 首屏覆盖层，一比一复刻官方 Web boot 覆盖层（`_boot_u7vgf_3` 那套）：
 * 同样的「HARNESS 字标 + 20px 环形进度 + 12px 灰色提示」竖排卡片、同样的
 * 16px 字距 0.08em 字标、同样的 conic-gradient 旋转环，连官方那套
 * `--dsh-boot-label-*` 回退变量与 `body[data-ds-dark-theme]` 深色切换都照抄。
 * 只有三处刻意不同：类名换成插件前缀（官方的 `_boot_u7vgf_3` 是构建哈希，
 * 不可依赖）；根节点用 `position:fixed` 而不是官方的 `height:100%`——我们这段
 * head 行注入在官方样式表之前，首帧 `#root` 可能还没有高度；最后额外挂一个
 * `animation` 兜底，最坏情况晚 `BOOT_REVEAL_DELAY_MS` 毫秒自动揭晓，
 * 不可能永久白屏。
 */
function bootVeil(): string {
  const root = `#${BOOT_ROOT_ID}`
  const css = [
    `${root}{--dsh-boot-label-primary:#0f1115;--dsh-boot-label-secondary:#61666b;--dsh-boot-label-tertiary:#81858c;--dsh-boot-border:rgb(0 0 0 / 10%);--dsh-boot-brand:#0f1115;position:fixed;inset:0;z-index:2147483647;margin:0;display:grid;place-items:center;background:var(--dsw-alias-bg-base,var(--dsh-boot-bg,Canvas));animation:dsh-taiwind-boot-reveal 240ms ease ${BOOT_REVEAL_DELAY_MS}ms forwards}`,
    `body[data-ds-dark-theme] ${root}{--dsh-boot-label-primary:#f9fafb;--dsh-boot-label-secondary:#cfd3d6;--dsh-boot-label-tertiary:#adb2b8;--dsh-boot-border:rgb(255 255 255 / 12%);--dsh-boot-brand:#f9fafb}`,
    `${root} .dsh-taiwind-boot-card{display:flex;flex-direction:column;align-items:center;gap:16px}`,
    `${root} .dsh-taiwind-boot-wordmark{font-size:16px;line-height:24px;font-weight:600;letter-spacing:.08em;color:var(--dsw-alias-label-primary,var(--dsh-boot-label-primary))}`,
    `${root} .dsh-taiwind-boot-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,var(--dsh-boot-label-tertiary))}`,
    `${root} .dsh-taiwind-boot-spinner{position:relative;width:20px;height:20px;border-radius:50%;corner-shape:round;border:2px solid var(--dsw-alias-border-l2,var(--dsh-boot-border));animation:dsh-taiwind-boot-spin .8s linear infinite}`,
    `${root} .dsh-taiwind-boot-spinner:after{content:"";position:absolute;inset:-2px;border-radius:inherit;background:conic-gradient(var(--dsw-alias-brand-primary,var(--dsh-boot-brand)) var(--dsh-boot-arc,72deg),transparent 0);-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 2px),#000 0);mask:radial-gradient(farthest-side,transparent calc(100% - 2px),#000 0)}`,
    '@keyframes dsh-taiwind-boot-spin{to{transform:rotate(360deg)}}',
    '@keyframes dsh-taiwind-boot-reveal{to{opacity:0;visibility:hidden}}',
  ].join('')
  return `<style id="${BOOT_STYLE_ID}">${css}</style>`
}

/**
 * 覆盖层标记，与官方 `zZ` 渲染出来的 DOM 同构：根 > 卡片 > 字标 / 环 / 提示。
 * 文案是写死的字面量（不做 i18n），与官方一致。
 */
function bootMarkup(): string {
  return `<div id="${BOOT_ROOT_ID}" role="status" aria-live="polite"><div class="dsh-taiwind-boot-card"><div class="dsh-taiwind-boot-wordmark">${BOOT_WORDMARK}</div><div class="dsh-taiwind-boot-spinner" aria-hidden="true"></div><div class="dsh-taiwind-boot-hint">${BOOT_HINT}</div></div></div>`
}

export async function apply(ctx: HostContext): Promise<void> {
  let css = ''
  let etag = ''
  let disposed = false
  let generation = 0
  let pending: Promise<void> | undefined
  let lastError = ''
  let lastCacheError = ''
  // 上一次编译成功时所用的「插件列表 + 各自产物版本」签名。每次刷新只比对这个
  // 字符串：纯内存、零 IO，签名没变就完全不碰编译器，签名变了才走一遍完整编译。
  let appliedSignature = ''
  // 上一次编译失败时的签名。同一个签名失败后不再重复重试，避免坏配置把昂贵的编译
  // 变成常态；签名一变（插件换了）或图/产物事件到来时立刻重试。
  let failedSignature = ''

  /**
   * 当前插件图签名：每个插件一行 `id@rev`。`rev` 是客户端产物（client bundle）的
   * 不透明版本号，由 mtime/ctime/size 推出——插件重装、升级、重新构建都会换 rev，
   * 插件增删则直接改变行数，所以它同时覆盖了「插件列表」和「每个插件的版本」。
   */
  const graphSignature = (): string =>
    ctx.clientModules.graph().entries.map(({ id, rev }) => `${id}@${rev}`).sort().join('\n')

  const persist = async (signature: string, content: string): Promise<void> => {
    // 落盘失败只影响下次冷启动的首屏速度，绝不阻断本次下发。
    try {
      await writeStylesCache({ signature, css: content })
    }
    catch (error) {
      if (disposed)
        return
      const message = error instanceof Error ? error.message : String(error)
      if (message === lastCacheError)
        return
      lastCacheError = message
      ctx.logger.warn(`${PLUGIN_ID}: cannot cache stylesheet at ${stylesCachePath()}: ${message}`)
    }
  }

  const refresh = (): Promise<void> => {
    if (pending)
      return pending
    pending = (async () => {
      while (true) {
        const current = generation
        const currentSignature = graphSignature()
        const entries = ctx.clientModules.graph().entries.map(({ id }) => {
          const path = ctx.clientModules.clientPath(id)
          if (!path)
            throw new Error(`Missing client bundle: ${id}`)
          return { id, path }
        })
        const warnings: string[] = []
        let compiled: string
        try {
          compiled = await compilePlugins(entries, message => warnings.push(message))
        }
        catch (error) {
          // 记住失败时的签名：同样的插件图不必每个 tick 再烧一遍编译。
          failedSignature = currentSignature
          throw error
        }
        if (disposed)
          return
        if (generation !== current)
          continue
        css = compiled
        appliedSignature = currentSignature
        failedSignature = ''
        etag = `"${createHash('sha256').update(compiled).digest('hex')}"`
        // 落盘不阻塞下发：写失败只影响下次冷启动的首屏速度。
        void persist(etag.slice(1, -1), compiled)
        const warning = warnings.join('\n')
        if (warning && warning !== lastError)
          ctx.logger.warn(`${PLUGIN_ID}: ${warning}`)
        lastError = warning
        break
      }
    })().finally(() => { pending = undefined })
    return pending
  }

  ctx.effect(() => () => {
    disposed = true
  })

  const fail = (error: unknown): void => {
    if (disposed)
      return
    const message = error instanceof Error ? error.message : String(error)
    if (message !== lastError) {
      lastError = message
      ctx.logger.warn(`${PLUGIN_ID}: ${message}; keeping previous stylesheet`)
    }
  }

  const update = (): void => {
    void refresh().catch(fail)
  }

  const invalidate = (): void => {
    generation++
    update()
  }

  ctx.effect(() => ctx.clientModules.onGraphChanged(invalidate))
  ctx.effect(() => ctx.clientModules.onRebuilt(invalidate))

  // 轮询只是兜底：万一某次图变化没有落到事件上，2 秒后仍能自愈。
  // 每 tick 只做一次纯内存的签名比对——插件列表或某个插件的产物版本没变就直接返回，
  // 昂贵的编译只在签名真的变了（或上一轮编译失败过）时才跑。
  ctx.effect(() => {
    const timer = setInterval(() => {
      if (disposed || pending)
        return
      const current = graphSignature()
      if (current === appliedSignature || current === failedSignature)
        return
      invalidate()
    }, POLL_INTERVAL_MS)
    timer.unref()
    return () => clearInterval(timer)
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `/${STYLESHEET_PATH}`,
    handler: async (req, res) => {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection) {
        res.writeHead(rejection)
        res.end()
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' })
        res.end()
        return
      }
      res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      // 只有手里什么都没有时才等这一轮编译：已有可用样式（内存或磁盘）
      // 就直接下发，别让客户端多等一个扫描编译周期。
      if (pending && !css)
        await pending.catch(() => {})
      // 编译失败但手里还有上次的样式（内存或磁盘），照常下发：
      // 界面继续可用，等图变化/产物重建事件触发下一轮编译再生效。
      if (!css) {
        res.writeHead(503, { 'Retry-After': '2' })
        res.end()
        return
      }
      res.setHeader('ETag', etag)
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304)
        res.end()
        return
      }
      res.setHeader('Content-Type', 'text/css; charset=utf-8')
      res.writeHead(200)
      res.end(req.method === 'HEAD' ? undefined : css)
    },
  }))

  ctx.on('webserver/index-inject', (rows) => {
    // 首屏直接内联当前可用样式（本轮编译结果或磁盘缓存），第一帧就带样式：
    // 没有渲染阻塞的 <link>，也不用等客户端脚本把样式取回来。
    if (css) {
      rows.push({
        kind: 'html',
        placement: 'head',
        html: `<style data-plugin="${PLUGIN_ID}" data-plugin-css="utilities">${css.replace(/<\/style/gi, '<\\/style')}</style>`,
      })
      return
    }
    rows.push({ kind: 'html', placement: 'head', html: bootVeil() })
    rows.push({ kind: 'html', placement: 'body', html: bootMarkup() })
  })

  // 本轮编译立刻开工（首屏请求可以挂在它上面），落盘缓存优先：
  // 命中就不必让宿主启动等这一轮编译。
  const compiling = refresh().catch(fail)
  try {
    const entry = await readStylesCache()
    if (!disposed && entry && !css) {
      css = entry.css
      etag = `"${entry.signature}"`
    }
  }
  catch (error) {
    fail(error)
  }
  // 手里没有可内联的样式时才等编译：宁可启动慢一拍，
  // 也不让首屏先出无样式内容再跳一下。
  if (!css)
    await compiling
}
