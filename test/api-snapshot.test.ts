import type { ResolvedConfig, TsdownHooks, TsdownPlugin, UserConfig } from 'tsdown'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { checkBuildState, guardStaleBuild } from 'tsdown-stale-guard'
import { extractDts, extractRuntime } from 'tsnapi'
import { beforeAll, describe, expect, it } from 'vitest'
import configs from '../tsdown.config'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { name: string, exports: Record<string, string> }

describe('build configuration', () => {
  it('records both faces through configured hooks without losing freshness checks', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-taiwindcss-recorder-'))
    try {
      const outDir = join(fixture, 'dist')
      await mkdir(outDir)
      for (const [index, config] of (configs as UserConfig[]).entries()) {
        const face = index === 0 ? 'host' : 'client'
        const source = join(fixture, `${face}.ts`)
        await writeFile(source, `export const face = '${face}'`)
        await writeFile(join(outDir, `${face}.js`), `exports.face = '${face}'`)
        const recorder = (config.plugins as TsdownPlugin[])[0]
        expect(typeof recorder).toBe('object')
        expect(recorder.writeBundle).toBeUndefined()
        await recorder.tsdownConfigResolved?.({ cwd: fixture, outDir, configDeps: new Set() } as ResolvedConfig)
        const transform = recorder.transform as { handler: (code: string, id: string) => void }
        transform.handler('', source)
      }
      for (const [index, config] of (configs as UserConfig[]).entries()) {
        const face = index === 0 ? 'host' : 'client'
        const hooks = config.hooks as Partial<TsdownHooks>
        await Reflect.apply(hooks['build:done']!, undefined, [])
        const hashFile = `node_modules/.cache/tsdown-stale-guard/${face}.yaml`
        expect((await checkBuildState({ root: fixture, hashFile })).fresh).toBe(true)
        await writeFile(join(fixture, `${face}.ts`), 'changed')
        expect((await checkBuildState({ root: fixture, hashFile })).stale).toBe(true)
        await writeFile(join(fixture, `${face}.ts`), `export const face = '${face}'`)
        await writeFile(join(outDir, `${face}.js`), 'changed output')
        expect((await checkBuildState({ root: fixture, hashFile })).changes).toContainEqual({ type: 'changed', category: 'output', file: `dist/${face}.js` })
        await writeFile(join(outDir, `${face}.js`), `exports.face = '${face}'`)
      }
    }
    finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })
})

describe('api snapshot', () => {
  beforeAll(async () => {
    for (const face of ['host', 'client'])
      await guardStaleBuild({ root, hashFile: `node_modules/.cache/tsdown-stale-guard/${face}.yaml` })
  })

  it('snapshots the actual host runtime and declarations', async () => {
    const runtimePath = join(root, pkg.exports['.'])
    const dtsPath = runtimePath.replace(/\.js$/, '.d.ts')
    const runtime = await extractRuntime(runtimePath, await readFile(runtimePath, 'utf8'))
    const dts = await extractDts(dtsPath, await readFile(dtsPath, 'utf8'))
    await expect(runtime).toMatchFileSnapshot(`__snapshots__/tsnapi/${pkg.name}/index.snapshot.js`)
    await expect(dts).toMatchFileSnapshot(`__snapshots__/tsnapi/${pkg.name}/index.snapshot.d.ts`)
  })

  it('registers the actual client factory and snapshots its runtime API', async () => {
    const registrations: { id: string, factory: (require: (id: string) => never) => Record<string, unknown> }[] = []
    const clientPath = join(root, pkg.exports['./client'])
    expect(clientPath).toMatch(/\.cjs$/)
    runInNewContext(await readFile(clientPath, 'utf8'), {
      window: { __ModuleLoader__: { load: (record: typeof registrations[number]) => registrations.push(record) } },
    }, { filename: clientPath })
    expect(registrations).toHaveLength(1)
    expect(registrations[0].id).toBe(pkg.name)
    const api = registrations[0].factory((id) => {
      throw new Error(`Unexpected client dependency: ${id}`)
    })
    expect(typeof api.apply).toBe('function')
    await expect(Object.keys(api).sort().join('\n')).toMatchFileSnapshot(`__snapshots__/tsnapi/${pkg.name}/client.snapshot.txt`)
  })
})
