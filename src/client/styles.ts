import { PLUGIN_ID, POLL_INTERVAL_MS, STYLE_SELECTOR, STYLESHEET_PATH } from '../constants'

export function mountStyles(): () => void {
  const existing = document.head.querySelector<HTMLStyleElement>(STYLE_SELECTOR)
  const style = existing ?? document.createElement('style')
  style.dataset.plugin = PLUGIN_ID
  style.dataset.pluginCss = 'utilities'
  if (!existing)
    document.head.append(style)

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
          etag = response.headers.get('ETag') ?? ''
        }
      }
      lastError = ''
    }
    catch (error) {
      if (!disposed) {
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
  }
}
