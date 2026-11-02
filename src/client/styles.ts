import { BOOT_STATUS_ID, BOOT_STYLE_ID, LINK_SELECTOR, PLUGIN_ID, POLL_INTERVAL_MS, STYLE_SELECTOR, STYLESHEET_PATH } from '../constants'

export function mountStyles(): () => void {
  const existing = document.head.querySelector<HTMLStyleElement>(STYLE_SELECTOR)
  const style = existing ?? document.createElement('style')
  style.dataset.plugin = PLUGIN_ID
  style.dataset.pluginCss = 'utilities'
  if (!existing)
    document.head.append(style)
  // 首屏阻塞式 link 在样式接管后移除，避免同一份规则加载两遍。
  const preloaded = document.head.querySelector<HTMLLinkElement>(LINK_SELECTOR)
  const bootStyle = document.getElementById(BOOT_STYLE_ID)
  const bootStatus = document.getElementById(BOOT_STATUS_ID)
  const reveal = (): void => {
    bootStyle?.remove()
    bootStatus?.remove()
  }

  const controller = new AbortController()
  let etag = ''
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastError = ''

  const update = async (): Promise<void> => {
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
      if (!disposed) {
        if (bootStatus)
          bootStatus.textContent = '界面样式加载失败，正在重试…'
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
      if (!disposed)
        timer = setTimeout(() => void update(), POLL_INTERVAL_MS)
    }
  }
  void update()

  return () => {
    disposed = true
    controller.abort()
    clearTimeout(timer)
    style.remove()
    preloaded?.remove()
    reveal()
  }
}
