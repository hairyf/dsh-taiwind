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
  compile.mockImplementation(async (_entries, onWarning) => {
    onWarning?.('Tailwind CSS conflict at --color-brand: first and second; merging in plugin order')
    return '.w-full { width: 100%; }'
  })
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
  expect(compile).toHaveBeenCalledWith([{ id: 'first', path: '/plugins/first/dist/client.js' }], expect.any(Function))

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
  expect(warn).toHaveBeenCalledWith('dsh-taiwind: Tailwind CSS conflict at --color-brand: first and second; merging in plugin order')
  graphChanged()
  await vi.advanceTimersByTimeAsync(0)
  expect(warn).toHaveBeenCalledTimes(1)
  compile.mockRejectedValueOnce(new Error('invalid config'))
  graphChanged()
  await vi.advanceTimersByTimeAsync(0)
  expect(request().status).toBe(503)
  const stale: { html: string }[] = []
  inject(stale)
  expect(stale[0].html).toContain('<link rel="stylesheet"')
  expect(stale[0].html).toContain('id="dsh-taiwind-boot-style"')
  expect(warn).toHaveBeenCalledTimes(2)

  entries = []
  compile.mockResolvedValue('.w-xl { width: 36rem; }')
  await vi.advanceTimersByTimeAsync(2000)
  expect(compile).toHaveBeenLastCalledWith([], expect.any(Function))
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
  expect(rows).toHaveLength(2)
  expect(rows[0].html).toContain('id="dsh-taiwind-boot-style"')
  expect(rows[1].html).toContain('role="status"')
  // 首屏未编译时输出阻塞式 link，让浏览器等样式而不是先画出无样式页面。
  expect(rows[0].html).toContain('<link rel="stylesheet" data-plugin="dsh-taiwind"')
  expect(rows[0].html).toContain('plugins/taiwind.css')
  expect(rows[0].html).not.toContain('.w-full')
  expect(request().status).toBe(503)
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('multiple main.css entries found'))

  compile.mockResolvedValue('.w-full { width: 100%; }')
  await vi.advanceTimersByTimeAsync(2000)
  expect(request().status).toBe(200)
  expect(request().body).toContain('.w-full')
})

it('holds a stylesheet request during the first compile instead of failing it', async () => {
  let route: any
  let resolve!: (value: string) => void
  compile.mockReturnValueOnce(new Promise((done) => {
    resolve = done
  }))
  const ctx = {
    effect(callback: () => () => void) { disposers.push(callback()) },
    on() {},
    logger: { warn: vi.fn() },
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
  const activation = apply(ctx)

  // 首屏的阻塞式 link 在编译完成前发出：请求应等待而不是 503。
  let status = 0
  let body: string | undefined
  const response = route.handler({ method: 'GET', headers: {} }, {
    setHeader() {},
    writeHead(value: number) { status = value },
    end(value?: string) { body = value },
  }) as Promise<void>
  expect(status).toBe(0)
  resolve('.w-full { width: 100%; }')
  await activation
  await response
  expect(status).toBe(200)
  expect(body).toContain('.w-full')
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
  expect(compile).toHaveBeenLastCalledWith([], expect.any(Function))
  const rows: { html: string }[] = []
  inject(rows)
  expect(rows[0].html).not.toContain('.removed')
})

it('hands a cold-start link over to a real style only after a successful retry', async () => {
  const style = { tagName: 'STYLE', dataset: {}, textContent: '', remove: vi.fn() }
  const link = { tagName: 'LINK', dataset: {}, textContent: '', remove: vi.fn() }
  const bootStyle = { remove: vi.fn() }
  const bootStatus = { textContent: '正在加载界面样式…', remove: vi.fn() }
  const append = vi.fn()
  vi.stubGlobal('document', {
    baseURI: 'https://example.test/prefix/',
    head: {
      querySelector: (selector: string) => selector.startsWith('style') ? null : link,
      append,
    },
    getElementById: (id: string) => id === 'dsh-taiwind-boot-style' ? bootStyle : bootStatus,
    createElement: (tag: string) => {
      expect(tag).toBe('style')
      return style
    },
  })
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockImplementationOnce((_url, { signal }: RequestInit) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('timeout')), { once: true })
    }))
    .mockResolvedValueOnce(new Response('.w-full { width: 100%; }', { headers: { ETag: '"ready"' } }))
  vi.stubGlobal('fetch', fetcher)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  disposers.push(mountStyles())
  await vi.advanceTimersByTimeAsync(0)
  expect(append).toHaveBeenCalledExactlyOnceWith(style)
  expect(style.textContent).toBe('')
  expect(link.remove).not.toHaveBeenCalled()
  expect(bootStyle.remove).not.toHaveBeenCalled()
  expect(bootStatus.textContent).toContain('加载失败')
  await vi.advanceTimersByTimeAsync(17000)
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(bootStyle.remove).not.toHaveBeenCalled()
  expect(bootStatus.remove).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(2000)
  expect(style.textContent).toContain('.w-full')
  expect(link.textContent).toBe('')
  expect(link.remove).toHaveBeenCalledOnce()
  expect(bootStyle.remove).toHaveBeenCalledOnce()
  expect(bootStatus.remove).toHaveBeenCalledOnce()
  expect(fetcher.mock.calls[2][1].headers).toEqual({})
})

it('adopts the boot style, conditionally refreshes it, preserves it on failure, and aborts on disposal', async () => {
  const style = { dataset: {}, textContent: '.boot {}', remove: vi.fn() }
  const link = { remove: vi.fn() }
  const append = vi.fn()
  const createElement = vi.fn()
  vi.stubGlobal('document', {
    baseURI: 'https://example.test/prefix/',
    head: { querySelector: (selector: string) => selector === 'style[data-plugin="dsh-taiwind"][data-plugin-css="utilities"]' ? style : link, append },
    getElementById: () => null,
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
  // 首屏阻塞式 link 在 style 接管后即被移除，只留一份规则。
  expect(link.remove).toHaveBeenCalledOnce()
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
