import type { HostContext } from '../src/types'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mountStyles } from '../src/client/styles'
import { compilePlugins } from '../src/compiler'
import { apply } from '../src/index'

vi.mock('../src/compiler', () => ({ compilePlugins: vi.fn() }))

const compile = vi.mocked(compilePlugins)
const disposers: (() => void)[] = []

beforeEach(() => {
  vi.useFakeTimers()
  compile.mockReset().mockResolvedValue('.w-full { width: 100%; }')
})

afterEach(() => {
  disposers.splice(0).reverse().forEach(dispose => dispose())
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('serves one authenticated stylesheet, updates its ETag, and recovers without losing previous CSS', async () => {
  let route: any
  let graphChanged = (): void => {}
  let inject: any
  let entries = [{ id: 'first' }]
  const unregister = vi.fn()
  const unsubscribe = vi.fn()
  const warn = vi.fn()
  const rejection = vi.fn((): number | undefined => undefined)
  const ctx = {
    effect(callback: () => () => void) { disposers.push(callback()) },
    on(_event: string, callback: unknown) { inject = callback },
    logger: { warn },
    clientModules: {
      graph: () => ({ entries }),
      clientPath: (id: string) => `/plugins/${id}/dist/client.js`,
      onGraphChanged(callback: () => void) {
        graphChanged = callback
        return unsubscribe
      },
      onRebuilt: () => () => {},
    },
    connection: { requestRejection: rejection },
    webServer: {
      register(value: unknown) {
        route = value
        return unregister
      },
    },
  } as unknown as HostContext
  await apply(ctx)
  expect(compile).toHaveBeenCalledWith([{ id: 'first', path: '/plugins/first/dist/client.js' }])

  const request = (method = 'GET', tag?: string) => {
    const headers: Record<string, string> = {}
    let status = 0
    let body: string | undefined
    route.handler({ method, headers: { 'if-none-match': tag } }, {
      setHeader(key: string, value: string) { headers[key] = value },
      writeHead(value: number, extra?: Record<string, string>) {
        status = value
        Object.assign(headers, extra)
      },
      end(value?: string) { body = value },
    })
    return { status, headers, body }
  }
  const first = request()
  expect(first.status).toBe(200)
  expect(first.body).toContain('.w-full')
  expect(first.headers['Content-Type']).toBe('text/css; charset=utf-8')
  expect(request('GET', first.headers.ETag).status).toBe(304)
  expect(request('HEAD').body).toBeUndefined()
  expect(request('POST').status).toBe(405)
  rejection.mockReturnValueOnce(403)
  expect(request().status).toBe(403)

  const rows: { html: string }[] = []
  inject(rows)
  expect(rows).toHaveLength(1)
  expect(rows[0].html).toContain('<style data-plugin="dsh-taiwind"')
  expect(rows[0].html).toContain('.w-full')
  compile.mockRejectedValueOnce(new Error('invalid config'))
  graphChanged()
  await vi.advanceTimersByTimeAsync(0)
  expect(request().status).toBe(503)
  const stale: { html: string }[] = []
  inject(stale)
  expect(stale[0].html).toContain('.w-full')
  expect(warn).toHaveBeenCalledTimes(1)

  entries = []
  compile.mockResolvedValue('.w-xl { width: 36rem; }')
  await vi.advanceTimersByTimeAsync(2000)
  expect(compile).toHaveBeenLastCalledWith([])
  const updated = request()
  expect(updated.status).toBe(200)
  expect(updated.body).toContain('.w-xl')
  expect(updated.headers.ETag).not.toBe(first.headers.ETag)
  disposers.splice(0).reverse().forEach(dispose => dispose())
  expect(unregister).toHaveBeenCalledOnce()
  expect(unsubscribe).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps the route alive and recovers when the first compilation fails', async () => {
  let route: any
  let inject: any
  const warn = vi.fn()
  compile.mockRejectedValueOnce(new Error('multiple main.css entries found'))
  const ctx = {
    effect(callback: () => () => void) { disposers.push(callback()) },
    on(_event: string, callback: unknown) { inject = callback },
    logger: { warn },
    clientModules: {
      graph: () => ({ entries: [{ id: 'first' }] }),
      clientPath: (id: string) => `/plugins/${id}/dist/client.js`,
      onGraphChanged: () => () => {},
      onRebuilt: () => () => {},
    },
    connection: { requestRejection: (): undefined => undefined },
    webServer: {
      register(value: unknown) {
        route = value
        return () => {}
      },
    },
  } as unknown as HostContext
  await apply(ctx)

  const request = () => {
    let status = 0
    let body: string | undefined
    route.handler({ method: 'GET', headers: {} }, {
      setHeader() {},
      writeHead(value: number) { status = value },
      end(value?: string) { body = value },
    })
    return { status, body }
  }
  const rows: { html: string }[] = []
  inject(rows)
  expect(rows).toHaveLength(1)
  expect(rows[0].html).toContain('<style data-plugin="dsh-taiwind"')
  expect(rows[0].html).not.toContain('.w-full')
  expect(request().status).toBe(503)
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('multiple main.css entries found'))

  compile.mockResolvedValue('.w-full { width: 100%; }')
  await vi.advanceTimersByTimeAsync(2000)
  expect(request().status).toBe(200)
  expect(request().body).toContain('.w-full')
})

it('recompiles as soon as a client bundle is rebuilt', async () => {
  let route: any
  let rebuilt: ((id: string, rev: string) => void) | undefined
  compile.mockResolvedValueOnce('.boot { color: red; }')
  const ctx = {
    effect(callback: () => () => void) { disposers.push(callback()) },
    on() {},
    logger: { warn: vi.fn() },
    clientModules: {
      graph: () => ({ entries: [{ id: 'first' }] }),
      clientPath: (id: string) => `/plugins/${id}/dist/client.js`,
      onGraphChanged: () => () => {},
      onRebuilt(callback: (id: string, rev: string) => void) {
        rebuilt = callback
        return () => {}
      },
    },
    connection: { requestRejection: (): undefined => undefined },
    webServer: {
      register(value: unknown) {
        route = value
        return () => {}
      },
    },
  } as unknown as HostContext
  await apply(ctx)

  const body = (): string | undefined => {
    let text: string | undefined
    route.handler({ method: 'GET', headers: {} }, {
      setHeader() {},
      writeHead() {},
      end(value?: string) { text = value },
    })
    return text
  }
  expect(body()).toContain('.boot')

  compile.mockResolvedValue('.rebuilt { color: blue; }')
  rebuilt?.('first', 'rev-2')
  await vi.advanceTimersByTimeAsync(0)
  expect(body()).toContain('.rebuilt')
})

it('discards stale compilation when the graph changes during activation', async () => {
  let resolve!: (value: string) => void
  compile.mockReturnValueOnce(new Promise((done) => {
    resolve = done
  }))
  let changed = (): void => {}
  let entries = [{ id: 'removed' }]
  let inject: any
  const ctx = {
    effect(callback: () => () => void) { disposers.push(callback()) },
    on(_event: string, callback: unknown) { inject = callback },
    logger: { warn: vi.fn() },
    clientModules: {
      graph: () => ({ entries }),
      clientPath: (id: string) => `/plugins/${id}/client.js`,
      onGraphChanged(callback: () => void) {
        changed = callback
        return () => {}
      },
      onRebuilt: () => () => {},
    },
    webServer: { register: () => () => {} },
  } as unknown as HostContext
  const activation = apply(ctx)
  entries = []
  changed()
  resolve('.removed {}')
  await activation
  expect(compile).toHaveBeenCalledTimes(2)
  expect(compile).toHaveBeenLastCalledWith([])
  const rows: { html: string }[] = []
  inject(rows)
  expect(rows[0].html).not.toContain('.removed')
})

it('adopts the boot style, conditionally refreshes it, preserves it on failure, and aborts on disposal', async () => {
  const style = { dataset: {}, textContent: '.boot {}', remove: vi.fn() }
  const append = vi.fn()
  const createElement = vi.fn()
  vi.stubGlobal('document', {
    baseURI: 'https://example.test/prefix/',
    head: { querySelector: () => style, append },
    createElement,
  })
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response('.w-full {}', { headers: { ETag: '"one"' } }))
    .mockResolvedValueOnce(new Response(null, { status: 304 }))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
  vi.stubGlobal('fetch', fetcher)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const dispose = mountStyles()
  disposers.push(dispose)
  await vi.advanceTimersByTimeAsync(0)
  expect(createElement).not.toHaveBeenCalled()
  expect(append).not.toHaveBeenCalled()
  expect(String(fetcher.mock.calls[0][0])).toBe('https://example.test/prefix/plugins/taiwind.css')
  expect(style.textContent).toBe('.w-full {}')
  await vi.advanceTimersByTimeAsync(4000)
  expect(fetcher.mock.calls[1][1].headers).toEqual({ 'If-None-Match': '"one"' })
  expect(style.textContent).toBe('.w-full {}')
  expect(console.warn).toHaveBeenCalledOnce()

  let finish!: (response: Response) => void
  fetcher.mockImplementationOnce(() => new Promise((done) => {
    finish = done
  }))
  await vi.advanceTimersByTimeAsync(2000)
  const signal = fetcher.mock.calls[3][1].signal as AbortSignal
  disposers.splice(0).forEach(cleanup => cleanup())
  expect(signal.aborted).toBe(true)
  expect(style.remove).toHaveBeenCalledOnce()
  finish(new Response('.late {}'))
  await vi.advanceTimersByTimeAsync(0)
  expect(style.textContent).toBe('.w-full {}')
  expect(vi.getTimerCount()).toBe(0)
})
