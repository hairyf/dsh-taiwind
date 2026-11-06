import type { ClientContext } from './types'
import { BOOT_ROOT_ID, BOOT_STYLE_ID, LINK_SELECTOR, PLUGIN_ID, STYLE_SELECTOR, STYLESHEET_PATH } from '../constants'

/**
 * 接管首屏样式标签，之后只按插件图同步状态做条件刷新：
 * 没有定时器，也没有周期请求，闲时一个字节都不发。
 * @param ctx - 客户端上下文，`ctx.modules.entries.state` 提供图同步信号。
 * @returns 完整的 disposer：取消订阅、取消在途请求、移除样式标签与引导层。
 */
export function mountStyles(ctx: ClientContext): () => void {
  const existing = document.head.querySelector<HTMLStyleElement>(STYLE_SELECTOR)
  const style = existing ?? document.createElement('style')
  style.dataset.plugin = PLUGIN_ID
  style.dataset.pluginCss = 'utilities'
  if (!existing)
    document.head.append(style)
  const preloaded = document.head.querySelector<HTMLLinkElement>(LINK_SELECTOR)
  const bootStyle = document.getElementById(BOOT_STYLE_ID)
  // 覆盖层根节点就是官方那套「HARNESS + 环形进度 + Loading appearance…」卡片。
  const bootRoot = document.getElementById(BOOT_ROOT_ID)
  const reveal = (): void => {
    bootStyle?.remove()
    bootRoot?.remove()
  }

  const controller = new AbortController()
  let etag = ''
  let disposed = false
  let inFlight: Promise<void> | undefined
  let queued = false
  let lastError = ''

  const run = async (): Promise<void> => {
    const request = new AbortController()
    const timeout = setTimeout(() => request.abort(), 15000)
    const abort = (): void => request.abort()
    controller.signal.addEventListener('abort', abort, { once: true })
    try {
      const response = await fetch(new URL(STYLESHEET_PATH, document.baseURI), {
        credentials: 'same-origin',
        cache: 'no-cache',
        headers: etag ? { 'If-None-Match': etag } : {},
        signal: request.signal,
      })
      if (response.status !== 304) {
        if (!response.ok)
          throw new Error(`Stylesheet request failed (${response.status})`)
        const css = await response.text()
        if (!disposed) {
          if (style.textContent !== css)
            style.textContent = css
          preloaded?.remove()
          reveal()
          etag = response.headers.get('ETag') ?? ''
        }
      }
      lastError = ''
    }
    catch (error) {
      // 样式取不到就降级：保留上次的样式和界面本身。
      // 首屏覆盖层由宿主侧 CSS 动画自行淡出，这里不接管可见性。
      if (!disposed) {
        reveal()
        const message = error instanceof Error ? error.message : String(error)
        if (lastError !== message) {
          lastError = message
          console.warn(`${PLUGIN_ID}: ${message}; keeping previous stylesheet`)
        }
      }
    }
    finally {
      clearTimeout(timeout)
      controller.signal.removeEventListener('abort', abort)
    }
  }

  /** 合并同一时刻的多条图变更，只留一次在途请求；结束后补跑被合并的那次。 */
  const update = (): void => {
    if (disposed)
      return
    if (inFlight) {
      queued = true
      return
    }
    inFlight = run().finally(() => {
      inFlight = undefined
      if (queued && !disposed) {
        queued = false
        update()
      }
    })
  }

  const state = ctx.modules?.entries?.state
  // 图变化（安装/卸载/启停/产物重建）在同步收敛后通知一次；条件请求命中 304 时零成本。
  // 宿主侧保证有编译在飞时会等它完成再回包，所以这一次取到的就是新样式。
  const unsubscribe = state?.subscribe(() => {
    if (!state.getSnapshot().syncing)
      update()
  })
  if (!unsubscribe)
    console.warn(`${PLUGIN_ID}: client module system unavailable; the shared stylesheet will not follow plugin changes`)

  update()

  return () => {
    disposed = true
    queued = false
    unsubscribe?.()
    controller.abort()
    style.remove()
    preloaded?.remove()
    reveal()
  }
}
