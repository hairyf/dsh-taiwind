import type { UserConfig } from 'tsdown'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { defineConfig } from 'tsdown'
import { StaleGuardRecorder } from 'tsdown-stale-guard'

export const dshExternal = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  /^@deepseek-ai\//,
]

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { name: string }
const id = JSON.stringify(pkg.name)

function recordBuild(face: 'host' | 'client'): Pick<UserConfig, 'plugins' | 'hooks'> {
  const recorder = StaleGuardRecorder({ hashFile: `node_modules/.cache/tsdown-stale-guard/${face}.yaml` })
  return {
    plugins: [{ ...recorder, writeBundle: undefined }],
    hooks: {
      'build:done': async () => {
        if (typeof recorder.writeBundle !== 'function')
          throw new TypeError('StaleGuardRecorder must provide a writeBundle hook')
        await Reflect.apply(recorder.writeBundle, undefined, [])
      },
    },
  }
}

const common: UserConfig = {
  outDir: 'dist',
  format: 'esm',
  outExtensions: () => ({ js: '.js' }),
  publint: true,
  external: dshExternal,
}

export default defineConfig([
  {
    ...common,
    ...recordBuild('host'),
    entry: { index: 'src/index.ts' },
    dts: true,
    sourcemap: false,
    clean: true,
  },
  {
    ...common,
    ...recordBuild('client'),
    entry: { client: 'src/client/index.ts' },
    format: 'cjs',
    outExtensions: () => ({ js: '.cjs' }),
    publint: false,
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    banner: `window.__ModuleLoader__.load({id:${id},factory:(require)=>{var module={exports:{}};var exports=module.exports;`,
    footer: 'return module.exports;}});',
    dts: false,
    sourcemap: true,
    minify: true,
    clean: false,
  },
])
