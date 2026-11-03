import type { HostContext } from '../src/types'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { stylesCachePath, writeStylesCache } from '../src/cache'
import { mountStyles } from '../src/client/styles'
import { compilePlugins } from '../src/compiler'
import { POLL_INTERVAL_MS } from '../src/constants'
import { apply } from '../src/index'

vi.mock('../src/compiler', () => ({ compilePlugins: vi.fn() }))

const compile = vi.mocked(compilePlugins)
const disposers: (() => void)[] = []
let dshHome = ''
const originalHome = process.env.DSH_HOME

beforeEach(async () => {
  vi.useFakeTimers()
  compile.mockReset().mockResolvedValue('.w-full { width: 100%; }')
  // 每个用例用独立的 `$DSH_HOME`，避免磁盘缓存互相污染。
  dshHome = await mkdtemp(join(tmpdir(), 'dsh-taiwind-home-'))
  process.env.DSH_HOME = dshHome
})

/**
 * 缓存落盘是「不阻塞下发」的异步写：用例结束时那次写可能还在飞，
 * 直接 rm 会撞上 ENOTEMPTY，所以带退避重试地清理。
 */
async function removeHome(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      await rm(directory, { recursive: true, force: true })
      return
    }
    catch {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
}

afterEach(async () => {
  disposers.splice(0).reverse().forEach(dispose => dispose())
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  if (originalHome === undefined)
    delete process.env.DSH_HOME
  else
    process.env.DSH_HOME = originalHome
  await removeHome(dshHome)
})

it('serves one authenticated stylesheet, updates its ETag, and keeps serving cached CSS after a failed rebuild', async () => {
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

  const request = async (method = 'GET', tag?: string) => {
    const headers: Record<string, string> = {}
    let status = 0
    let body: string | undefined
    await route.handler({ method, headers: { 'if-none-match': tag } }, {
      setHeader(key: string, value: string) { headers[key] = value },
      writeHead(value: number, extra?: Record<string, string>) {
        status = value
        Object.assign(headers, extra)
      },
      end(value?: string) { body = value },
    })
    return { status, headers, body }
  }
  const first = await request()
  expect(first.status).toBe(200)
  expect(first.body).toContain('.w-full')
  expect(first.headers['Content-Type']).toBe('text/css; charset=utf-8')
  expect(first.headers['Cache-Control']).toBe('private, max-age=0, must-revalidate')
  expect((await request('GET', first.headers.ETag)).status).toBe(304)
  expect((await request('HEAD')).body).toBeUndefined()
  expect((await request('POST')).status).toBe(405)
  rejection.mockReturnValueOnce(403)
  expect((await request()).status).toBe(403)

  const rows: { html: string }[] = []
  inject(rows)
  expect(rows).toHaveLength(1)
  expect(rows[0].html).toContain('<style data-plugin="dsh-taiwind"')
  expect(rows[0].html).toContain('.w-full')
  expect(warn).toHaveBeenCalledWith('dsh-taiwind: Tailwind CSS conflict at --color-brand: first and second; merging in plugin order')

  // 编译结果落盘到 `$DSH_HOME/taiwind/styles.css`，签名写在首行注释里。
  await vi.waitFor(async () => {
    const cached = await readFile(stylesCachePath(), 'utf8')
    expect(cached).toContain('dsh-taiwind stylesheet signature:')
    expect(cached).toContain('.w-full')
  })

  graphChanged()
  await vi.advanceTimersByTimeAsync(0)
  expect(warn).toHaveBeenCalledTimes(1)
  // 重新编译失败：不再 503 永久白屏，而是继续下发上一次的样式。
  compile.mockRejectedValueOnce(new Error('invalid config'))
  graphChanged()
  await vi.advanceTimersByTimeAsync(0)
  const degraded = await request()
  expect(degraded.status).toBe(200)
  expect(degraded.body).toContain('.w-full')
  const stale: { html: string }[] = []
  inject(stale)
  expect(stale).toHaveLength(1)
  expect(stale[0].html).toContain('<style data-plugin="dsh-taiwind"')
  expect(stale[0].html).toContain('.w-full')
  expect(stale[0].html).not.toContain('dsh-taiwind-boot-style')
  expect(warn).toHaveBeenCalledTimes(2)

  // 轮询是兜底，且每 tick 只比对插件图签名：这里图变化已经由事件触发过，
  // 签名与已应用的一致，所以再走 2 秒的 tick 也不会多编译一次。
  entries = []
  compile.mockResolvedValue('.w-xl { width: 36rem; }')
  graphChanged()
  await vi.advanceTimersByTimeAsync(0)
  expect(compile).toHaveBeenLastCalledWith([], expect.any(Function))
  const updated = await request()
  expect(updated.status).toBe(200)
  expect(updated.body).toContain('.w-xl')
  expect(updated.headers.ETag).not.toBe(first.headers.ETag)
  disposers.splice(0).reverse().forEach(dispose => dispose())
  expect(unregister).toHaveBeenCalledOnce()
  expect(unsubscribe).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('shows a non-blocking CSS veil when the first compilation fails with no cache', async () => {
  let route: any
  let inject: any
  let graphChanged = (): void => {}
  const warn = vi.fn()
  compile.mockRejectedValueOnce(new Error('multiple main.css entries found'))
  const ctx = {
    effect(callback: () => () => void) { disposers.push(callback()) },
    on(_event: string, callback: unknown) { inject = callback },
    logger: { warn },
    clientModules: {
      graph: () => ({ entries: [{ id: 'first' }] }),
      clientPath: (id: string) => `/plugins/${id}/dist/client.js`,
      onGraphChanged(callback: () => void) {
        graphChanged = callback
        return () => {}
      },
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

  const request = async () => {
    let status = 0
    let body: string | undefined
    await route.handler({ method: 'GET', headers: {} }, {
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
  expect(rows[0].html).toContain('@keyframes')
  // 覆盖层一比一复刻官方 Web boot 界面：HARNESS 字标 + 20px 环形进度 + 写死的英文提示。
  expect(rows[1].html).toContain('id="dsh-taiwind-boot"')
  expect(rows[1].html).toContain('role="status"')
  expect(rows[1].html).toContain('>HARNESS<')
  expect(rows[1].html).toContain('Loading appearance…')
  expect(rows[0].html).toContain('corner-shape:round')
  expect(rows[0].html).toContain('body[data-ds-dark-theme] #dsh-taiwind-boot')
  // 没有缓存兜底时才 503；且首屏不再有阻塞式 <link>，样式就绪前也没有东西能永久挡住界面。
  expect(rows[0].html).not.toContain('<link')
  expect((await request()).status).toBe(503)
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('multiple main.css entries found'))

  // 下一次重编译由图变化事件触发（轮询兜底只在签名变了时才动手）。
  compile.mockResolvedValue('.w-full { width: 100%; }')
  graphChanged()
  await vi.advanceTimersByTimeAsync(0)
  expect((await request()).status).toBe(200)
  expect((await request()).body).toContain('.w-full')
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

  const body = async (): Promise<string | undefined> => {
    let text: string | undefined
    await route.handler({ method: 'GET', headers: {} }, {
      setHeader() {},
      writeHead() {},
      end(value?: string) { text = value },
    })
    return text
  }
  expect(await body()).toContain('.boot')

  compile.mockResolvedValue('.rebuilt { color: blue; }')
  rebuilt?.('first', 'rev-2')
  await vi.advanceTimersByTimeAsync(0)
  expect(await body()).toContain('.rebuilt')
})

it('polls cheaply and recompiles only when the plugin graph signature changes', async () => {
  let route: any
  let entries = [{ id: 'first', rev: 'rev-1' }]
  compile.mockResolvedValue('.w-full { width: 100%; }')
  const ctx = {
    effect(callback: () => () => void) { disposers.push(callback()) },
    on() {},
    logger: { warn: vi.fn() },
    clientModules: {
      graph: () => ({ entries }),
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
  expect(compile).toHaveBeenCalledTimes(1)

  // 插件图和版本都没变：每个 tick 只做一次内存比对，不碰编译器。
  await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
  expect(compile).toHaveBeenCalledTimes(1)

  // 某个插件的产物版本变了：下一 tick 自愈，不需要任何事件。
  compile.mockResolvedValue('.w-xl { width: 36rem; }')
  entries = [{ id: 'first', rev: 'rev-2' }]
  await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
  expect(compile).toHaveBeenCalledTimes(2)
  let text: string | undefined
  await route.handler({ method: 'GET', headers: {} }, {
    setHeader() {},
    writeHead() {},
    end(value?: string) { text = value },
  })
  expect(text).toContain('.w-xl')

  // 插件列表变了（新增一个插件）：同样能在下一 tick 自愈。
  compile.mockResolvedValue('.w-grid { display: grid; }')
  entries = [{ id: 'first', rev: 'rev-2' }, { id: 'second', rev: 'rev-1' }]
  await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
  expect(compile).toHaveBeenCalledTimes(3)
  expect(compile).toHaveBeenLastCalledWith(
    [
      { id: 'first', path: '/plugins/first/dist/client.js' },
      { id: 'second', path: '/plugins/second/dist/client.js' },
    ],
    expect.any(Function),
  )

  // 同一个签名反复失败时不再每 tick 重烧编译，只在签名变化后重试。
  compile.mockRejectedValue(new Error('invalid config'))
  entries = [{ id: 'first', rev: 'rev-3' }]
  await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
  expect(compile).toHaveBeenCalledTimes(4)
  await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3)
  expect(compile).toHaveBeenCalledTimes(4)
  compile.mockResolvedValue('.w-sr { position: absolute; }')
  entries = [{ id: 'first', rev: 'rev-4' }]
  await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
  expect(compile).toHaveBeenCalledTimes(5)
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

it('serves the on-disk cache on a cold start even when compilation fails', async () => {
  await writeStylesCache({ signature: 'a'.repeat(64), css: '.cached { color: red; }' })
  let route: any
  let inject: any
  compile.mockRejectedValue(new Error('boom'))
  const ctx = {
    effect(callback: () => () => void) { disposers.push(callback()) },
    on(_event: string, callback: unknown) { inject = callback },
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
  await apply(ctx)

  const rows: { html: string }[] = []
  inject(rows)
  expect(rows).toHaveLength(1)
  expect(rows[0].html).toContain('<style data-plugin="dsh-taiwind"')
  expect(rows[0].html).toContain('.cached')

  let status = 0
  let body: string | undefined
  const headers: Record<string, string> = {}
  await route.handler({ method: 'GET', headers: {} }, {
    setHeader(key: string, value: string) { headers[key] = value },
    writeHead(value: number) { status = value },
    end(value?: string) { body = value },
  })
  expect(status).toBe(200)
  expect(body).toContain('.cached')
  expect(headers.ETag).toBe(`"${'a'.repeat(64)}"`)
})

it('hands a cold-start veil over to a real style on the first successful fetch', async () => {
  const style = { tagName: 'STYLE', dataset: {}, textContent: '', remove: vi.fn() }
  const link = { tagName: 'LINK', dataset: {}, textContent: '', remove: vi.fn() }
  const bootStyle = { remove: vi.fn() }
  const bootRoot = { remove: vi.fn() }
  const append = vi.fn()
  vi.stubGlobal('document', {
    baseURI: 'https://example.test/prefix/',
    head: {
      querySelector: (selector: string) => selector.startsWith('style') ? null : link,
      append,
    },
    getElementById: (id: string) => id === 'dsh-taiwind-boot-style' ? bootStyle : bootRoot,
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
  // 取样式失败也立刻揭晓引导层：界面照常显示，只是样式可能还是上次的。
  expect(bootStyle.remove).toHaveBeenCalledOnce()
  expect(bootRoot.remove).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(17000)
  expect(fetcher).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(2000)
  expect(style.textContent).toContain('.w-full')
  expect(link.textContent).toBe('')
  expect(link.remove).toHaveBeenCalledOnce()
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
