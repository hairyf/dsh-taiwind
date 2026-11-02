import type { HostContext } from './types'
import { createHash } from 'node:crypto'
import { compilePlugins } from './compiler'
import { BOOT_STATUS_ID, BOOT_STYLE_ID, PLUGIN_ID, POLL_INTERVAL_MS, STYLESHEET_PATH } from './constants'

export const name = PLUGIN_ID
export const inject = ['clientModules', 'webServer', 'connection']

export async function apply(ctx: HostContext): Promise<void> {
  let css = ''
  let etag = ''
  let failed = true
  let disposed = false
  let generation = 0
  let pending: Promise<void> | undefined
  let lastError = ''

  const refresh = (): Promise<void> => {
    if (pending)
      return pending
    pending = (async () => {
      while (true) {
        const current = generation
        const entries = ctx.clientModules.graph().entries.map(({ id }) => {
          const path = ctx.clientModules.clientPath(id)
          if (!path)
            throw new Error(`Missing client bundle: ${id}`)
          return { id, path }
        })
        const warnings: string[] = []
        const compiled = await compilePlugins(entries, message => warnings.push(message))
        if (disposed)
          return
        if (generation !== current)
          continue
        css = compiled
        etag = `"${createHash('sha256').update(css).digest('hex')}"`
        failed = false
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
    failed = true
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
      res.setHeader('Cache-Control', 'private, no-cache')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      if (pending)
        await pending.catch(() => {})
      if (failed) {
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
    const ready = !failed && !pending
    rows.push({
      kind: 'html',
      placement: 'head',
      html: ready
        ? `<style data-plugin="${PLUGIN_ID}" data-plugin-css="utilities">${css.replace(/<\/style/gi, '<\\/style')}</style>`
        : `<style id="${BOOT_STYLE_ID}">body{visibility:hidden!important}#${BOOT_STATUS_ID}{visibility:visible!important;position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;margin:0;background:var(--dsh-boot-bg,#fff);color:CanvasText;font:14px system-ui}body>*:not(#${BOOT_STATUS_ID}){display:none!important}</style><link rel="stylesheet" data-plugin="${PLUGIN_ID}" data-plugin-css="utilities" href="${STYLESHEET_PATH}">`,
    })
    if (!ready) {
      rows.push({
        kind: 'html',
        placement: 'body',
        html: `<div id="${BOOT_STATUS_ID}" role="status" aria-live="polite">正在加载界面样式…</div>`,
      })
    }
  })

  ctx.effect(() => {
    const timer = setInterval(update, POLL_INTERVAL_MS)
    timer.unref()
    return () => clearInterval(timer)
  })

  try {
    await refresh()
  }
  catch (error) {
    fail(error)
  }
}
