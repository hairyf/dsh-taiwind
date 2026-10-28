import type { HostContext } from './types'
import { createHash } from 'node:crypto'
import { compilePlugins } from './compiler'
import { PLUGIN_ID, POLL_INTERVAL_MS, STYLESHEET_PATH } from './constants'

export const name = PLUGIN_ID
export const inject = ['clientModules', 'webServer', 'connection']

export async function apply(ctx: HostContext): Promise<void> {
  let css = ''
  let etag = ''
  let failed = false
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
        const compiled = await compilePlugins(entries)
        if (disposed)
          return
        if (generation !== current)
          continue
        css = compiled
        etag = `"${createHash('sha256').update(css).digest('hex')}"`
        failed = false
        lastError = ''
        break
      }
    })().finally(() => { pending = undefined })
    return pending
  }

  ctx.effect(() => () => {
    disposed = true
  })

  const update = (): void => {
    void refresh().catch((error: unknown) => {
      if (disposed)
        return
      failed = true
      const message = error instanceof Error ? error.message : String(error)
      if (message !== lastError) {
        lastError = message
        ctx.logger.warn(`${PLUGIN_ID}: ${message}; keeping previous stylesheet`)
      }
    })
  }

  ctx.effect(() => ctx.clientModules.onGraphChanged(() => {
    generation++
    update()
  }))
  await refresh()
  if (disposed)
    return

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `/${STYLESHEET_PATH}`,
    handler: (req, res) => {
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
    rows.push({
      kind: 'html',
      placement: 'head',
      html: `<style data-plugin="${PLUGIN_ID}" data-plugin-css="utilities">${css.replace(/<\/style/gi, '<\\/style')}</style>`,
    })
  })
  ctx.effect(() => {
    const timer = setInterval(update, POLL_INTERVAL_MS)
    timer.unref()
    return () => clearInterval(timer)
  })
}
