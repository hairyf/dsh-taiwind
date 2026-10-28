import type { Config } from 'tailwindcss'
import { createHash } from 'node:crypto'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Scanner } from '@tailwindcss/oxide'
import postcss from 'postcss'
import { compile } from 'tailwindcss'

type Data = string | number | boolean | null | Data[] | { [key: string]: Data }
interface ObjectData { [key: string]: Data }

const configNamePattern = /^(?:tailwind|taiwind)\.config\.[^.]+$/
const configPattern = /^(?:tailwind|taiwind)\.config\.[cm]?js$/
const bundlePattern = /\.[cm]?js$/
const nodeRequire = createRequire(import.meta.url)
let cached: { signature: string, css: string } | undefined

async function nativeModule(configPath: string, root: string): Promise<boolean> {
  const extension = extname(configPath)
  if (extension === '.mjs')
    return true
  if (extension === '.cjs')
    return false
  return (JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { type?: string }).type === 'module'
}

// ponytail: ESM 配置自身按内容哈希热重载，它 import 的模块要重启进程；CJS 走 require 缓存清理可全量刷新。
async function loadModule(configPath: string, rawConfig: string, root: string): Promise<unknown> {
  if (await nativeModule(configPath, root)) {
    const url = pathToFileURL(configPath)
    url.search = `?v=${createHash('sha256').update(rawConfig).digest('hex').slice(0, 16)}`
    const loaded = await import(url.href) as { default?: unknown }
    return loaded.default ?? loaded
  }
  for (const key of Object.keys(nodeRequire.cache)) {
    if (key.startsWith(`${root}${sep}`))
      delete nodeRequire.cache[key]
  }
  const loaded = nodeRequire(configPath) as { default?: unknown } | null
  return loaded?.default ?? loaded
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function staticData(value: unknown, location: string): Data {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))
    return value
  if (Array.isArray(value))
    return value.map((item, index) => staticData(item, `${location}[${index}]`))
  if (isObject(value)) {
    const output: ObjectData = Object.create(null)
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key))
        throw new Error(`${location}.${key}: unsupported configuration key`)
      output[key] = staticData(item, `${location}.${key}`)
    }
    return output
  }
  throw new Error(`${location}: only static JSON-compatible configuration values are supported`)
}

function canonical(value: Data): string {
  if (Array.isArray(value))
    return `[${value.map(canonical).join(',')}]`
  if (isObject(value))
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key] as Data)}`).join(',')}}`
  return JSON.stringify(value)
}

function validateConfig(value: unknown, owner: string): ObjectData {
  if (!isObject(value))
    throw new Error(`${owner}: Tailwind config must export an object`)
  for (const key of Object.keys(value)) {
    if (!['theme', 'darkMode', 'prefix', 'important'].includes(key))
      throw new Error(`${owner}: unsupported Tailwind configuration option "${key}"; supported: theme.extend, darkMode, prefix, important`)
  }
  const config = staticData(value, owner) as ObjectData
  if ('theme' in config) {
    if (!isObject(config.theme) || Object.keys(config.theme).some(key => key !== 'extend'))
      throw new Error(`${owner}: only theme.extend is supported; direct theme replacement is not supported`)
    if ('extend' in config.theme) {
      if (!isObject(config.theme.extend))
        throw new Error(`${owner}: theme.extend must be an object`)
      for (const [section, values] of Object.entries(config.theme.extend)) {
        if (!isObject(values))
          throw new Error(`${owner}: theme.extend.${section} must be a static object`)
      }
    }
  }
  if ('darkMode' in config) {
    const mode = config.darkMode
    const validVariant = Array.isArray(mode) && mode[0] === 'variant' && (typeof mode[1] === 'string' || (Array.isArray(mode[1]) && mode[1].every(item => typeof item === 'string')))
    const validSelector = Array.isArray(mode) && ['class', 'selector'].includes(mode[0] as string) && typeof mode[1] === 'string'
    const valid = mode === false || ['media', 'class', 'selector'].includes(mode as string) || (Array.isArray(mode) && mode.length === 2 && (validVariant || validSelector))
    if (!valid)
      throw new Error(`${owner}: invalid darkMode strategy`)
  }
  if ('prefix' in config && (typeof config.prefix !== 'string' || !/^[a-z]+$/.test(config.prefix)))
    throw new Error(`${owner}: prefix must contain lowercase letters only (Tailwind v4 prefix syntax)`)
  if ('important' in config && typeof config.important !== 'boolean' && (typeof config.important !== 'string' || !config.important.trim()))
    throw new Error(`${owner}: important must be a boolean or a nonempty selector`)
  return config
}

function mergeValues(target: ObjectData, incoming: ObjectData, owner: string, owners: Map<string, string>, path = 'theme.extend'): void {
  for (const [key, value] of Object.entries(incoming)) {
    const location = `${path}.${key}`
    if (Object.hasOwn(target, key)) {
      if (isObject(target[key]) && isObject(value))
        mergeValues(target[key] as ObjectData, value as ObjectData, owner, owners, location)
      else if (canonical(target[key]) !== canonical(value))
        throw new Error(`Tailwind config conflict at ${location}: ${owners.get(location)} and ${owner}`)
    }
    else {
      target[key] = isObject(value) ? Object.create(null) : value
      owners.set(location, owner)
      if (isObject(value))
        mergeValues(target[key] as ObjectData, value as ObjectData, owner, owners, location)
    }
  }
}

function checkAliases(extend: ObjectData, owner: string, aliases: Map<string, { value: string, owner: string }>): void {
  for (const [section, values] of Object.entries(extend)) {
    const visit = (value: Data, path: string[]): void => {
      if (isObject(value)) {
        for (const [key, item] of Object.entries(value))
          visit(item as Data, key === 'DEFAULT' ? path : [...path, key])
        return
      }
      const key = `${section}.${path.join('-')}`
      const serialized = canonical(value)
      const previous = aliases.get(key)
      if (previous && previous.value !== serialized)
        throw new Error(`Tailwind theme token conflict at ${key}: ${previous.owner} and ${owner}`)
      aliases.set(key, { value: serialized, owner })
    }
    visit(values, [])
  }
}

async function packageRoot(path: string, id: string): Promise<string> {
  for (let directory = dirname(path); ;) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { name?: unknown }
      if (manifest.name === id)
        return directory
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw error
    }
    const parent = dirname(directory)
    if (parent === directory)
      throw new Error(`${id}: cannot find an owning package.json for ${path}`)
    directory = parent
  }
}

async function bundles(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (item.name === 'node_modules' || item.name === 'archive' || item.isSymbolicLink())
      continue
    const path = join(directory, item.name)
    if (item.isDirectory())
      files.push(...await bundles(path))
    else if (item.isFile() && bundlePattern.test(item.name))
      files.push(path)
  }
  return files
}

async function cssEntry(root: string, owner: string): Promise<string | undefined> {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { dsh?: { taiwind?: unknown } }
  const entry = manifest.dsh?.taiwind
  if (entry === undefined) {
    // ponytail: 只提示包根这个最常见的位置；其他旧位置静默忽略，升级文档已说明。
    const legacy = await stat(join(root, 'main.css')).then(info => info.isFile(), () => false)
    if (legacy)
      throw new Error(`${owner}: main.css is not discovered automatically anymore; declare "dsh": { "taiwind": "main.css" } in package.json`)
    return undefined
  }
  if (typeof entry !== 'string' || !entry.trim() || extname(entry) !== '.css')
    throw new Error(`${owner}: dsh.taiwind must be a relative .css path`)
  const path = resolve(root, entry)
  const regular = await stat(path).then(info => info.isFile(), () => false)
  if (!regular)
    throw new Error(`${owner}: dsh.taiwind entry not found: ${entry}`)
  return path
}

export async function compilePlugins(entries: { id: string, path: string }[]): Promise<string> {
  const hash = createHash('sha256')
  const bundleFiles: string[] = []
  const extend: ObjectData = Object.create(null)
  const merged: ObjectData = { theme: { extend } }
  const owners = new Map<string, string>()
  const aliases = new Map<string, { value: string, owner: string }>()
  const seen = new Set<string>()
  const stylesheets = new Map<string, string>()
  const cssImports: string[] = []
  const cssDefinitions = new Map<string, { value: string, owner: string }>()
  const configsSeen = new Set<string>()
  const setGlobal = (key: string, value: Data, owner: string): void => {
    if (Object.hasOwn(merged, key) && canonical(merged[key]) !== canonical(value))
      throw new Error(`Tailwind global configuration conflict at ${key}: ${owners.get(key)} and ${owner}`)
    merged[key] = value
    owners.set(key, owner)
  }
  const loadConfig = async (configPath: string, owner: string, root: string): Promise<void> => {
    configPath = await realpath(configPath)
    if (configsSeen.has(configPath))
      return
    configsSeen.add(configPath)
    const rawConfig = await readFile(configPath, 'utf8')
    let loaded: unknown
    try {
      loaded = await loadModule(configPath, rawConfig, root)
    }
    catch (error) {
      throw new Error(`${owner}: failed to load ${configPath}`, { cause: error })
    }
    const config = validateConfig(loaded, owner)
    hash.update(JSON.stringify([configPath, rawConfig, canonical(config)]))
    const configExtend = (config.theme as ObjectData | undefined)?.extend as ObjectData | undefined
    if (configExtend) {
      checkAliases(configExtend, owner, aliases)
      mergeValues(extend, configExtend, owner, owners)
    }
    for (const key of ['darkMode', 'prefix', 'important']) {
      if (Object.hasOwn(config, key))
        setGlobal(key, config[key], owner)
    }
  }
  const checkDefinition = (key: string, value: string, owner: string): void => {
    const previous = cssDefinitions.get(key)
    if (previous && previous.owner !== owner && previous.value !== value)
      throw new Error(`Tailwind CSS conflict at ${key}: ${previous.owner} and ${owner}`)
    cssDefinitions.set(key, { value, owner })
  }
  const loadCss = async (filename: string, root: string, owner: string, ancestors: string[] = []): Promise<string> => {
    const path = await realpath(filename)
    const local = relative(root, path)
    if (local === '..' || local.startsWith('../') || local.startsWith('..\\') || isAbsolute(local))
      throw new Error(`${owner}: CSS dependency is outside its package: ${filename}`)
    if (ancestors.includes(path))
      throw new Error(`${owner}: circular CSS import: ${[...ancestors, path].join(' -> ')}`)
    if (stylesheets.has(path))
      return path
    const content = await readFile(path, 'utf8')
    hash.update(JSON.stringify([path, content]))
    const ast = postcss.parse(content, { from: path })
    const directives: postcss.AtRule[] = []
    ast.walkAtRules((rule) => {
      directives.push(rule)
    })
    for (const rule of directives) {
      if (['import', 'reference', 'tailwind'].includes(rule.name) && /\bsource\((?!none\))/.test(rule.params.replace(/^(?:"[^"]*"|'[^']*')/, '')))
        throw new Error(`${owner}: source(...) directory scanning is not supported; file candidates come from client bundles`)
      if (['import', 'reference', 'config'].includes(rule.name)) {
        const match = /^(?:"([^"\\]+)"|'([^'\\]+)')(.*)$/s.exec(rule.params)
        if (!match)
          throw new Error(`${owner}: ${path}: @${rule.name} requires a quoted local path`)
        const id = match[1] ?? match[2]
        const options = match[3].trim()
        if (rule.name === 'config') {
          if (options || !id.startsWith('.'))
            throw new Error(`${owner}: @config requires a relative path without options`)
          await loadConfig(resolve(dirname(path), id), owner, root)
          rule.remove()
        }
        else if (/^tailwindcss(?:\/(?:index|theme|utilities|preflight)(?:\.css)?)?$/.test(id)) {
          const rest = options.replace(/\blayer\((?:theme|base|utilities)\)|\bsource\(none\)/g, '').trim()
          const prefix = /\bprefix\(([a-z]+)\)/.exec(rest)
          if (prefix)
            setGlobal('prefix', prefix[1], owner)
          if (/\bimportant\b/.test(rest))
            setGlobal('important', true, owner)
          if (rest.replace(/\bprefix\([a-z]+\)|\bimportant\b/g, '').trim())
            throw new Error(`${owner}: unsupported Tailwind import options: ${options}`)
          rule.remove()
        }
        else {
          if (!id.startsWith('.') || extname(id) !== '.css')
            throw new Error(`${owner}: only relative .css imports and tailwindcss imports are supported: ${id}`)
          const imported = await loadCss(resolve(dirname(path), id), root, owner, [...ancestors, path])
          rule.params = `${JSON.stringify(imported.replaceAll('\\', '/'))}${options ? ` ${options}` : ''}`
        }
      }
      else if (rule.name === 'plugin') {
        throw new Error(`${owner}: @plugin is not supported; use CSS @utility instead`)
      }
      else if (rule.name === 'source' && !/^(?:not\s+)?inline\(/.test(rule.params)) {
        throw new Error(`${owner}: only @source inline(...) is supported; file candidates come from client bundles`)
      }
      else if (rule.name === 'theme') {
        rule.each((node) => {
          if (node.type === 'decl')
            checkDefinition(node.prop, JSON.stringify([rule.params, node.value, node.important]), owner)
        })
      }
      else if (['utility', 'custom-variant'].includes(rule.name)) {
        checkDefinition(`@${rule.name} ${rule.params.split(/[\s(]/)[0]}`, rule.toString(), owner)
      }
    }
    stylesheets.set(path, ast.toString())
    return path
  }
  for (const entry of [...entries].sort((a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path))) {
    const path = await realpath(resolve(entry.path))
    const root = await packageRoot(path, entry.id)
    hash.update(JSON.stringify([entry.id, path]))
    // ponytail: 巡检只做 stat，内容没变就不读产物、不跑 Tailwind；改动时 mtime/ctime/size 必变。
    for (const file of await bundles(dirname(path))) {
      if (seen.has(file))
        continue
      seen.add(file)
      const info = await stat(file)
      hash.update(JSON.stringify([file, info.mtimeMs, info.ctimeMs, info.size]))
      bundleFiles.push(file)
    }
    const stylesheet = await cssEntry(root, entry.id)
    if (stylesheet) {
      cssImports.push(await loadCss(stylesheet, root, entry.id))
      continue
    }
    const configs = (await readdir(root, { withFileTypes: true })).filter(item => configNamePattern.test(item.name))
    if (configs.length > 1)
      throw new Error(`${entry.id}: multiple Tailwind configs found: ${configs.map(item => item.name).join(', ')}`)
    if (!configs.length)
      continue
    if (!configs[0].isFile())
      throw new Error(`${entry.id}: Tailwind config must be a regular file`)
    if (!configPattern.test(configs[0].name))
      throw new Error(`${entry.id}: unsupported Tailwind config ${configs[0].name}; use .js, .cjs or .mjs`)
    await loadConfig(join(root, configs[0].name), entry.id, root)
  }
  if (!Object.hasOwn(merged, 'darkMode'))
    merged.darkMode = 'class'
  const theme = await readFile(new URL(import.meta.resolve('tailwindcss/theme.css')), 'utf8')
  const utilities = await readFile(new URL(import.meta.resolve('tailwindcss/utilities.css')), 'utf8')
  hash.update(JSON.stringify([theme, utilities]))
  const digest = hash.digest('hex')
  if (cached?.signature === digest)
    return cached.css
  const sources: { content: string, extension: string }[] = []
  for (const file of bundleFiles)
    sources.push({ content: await readFile(file, 'utf8'), extension: extname(file).slice(1) })
  const scanner = new Scanner({})
  const candidates = scanner.scanFiles(sources)
  const imports = cssImports.map(path => `@import ${JSON.stringify(path.replaceAll('\\', '/'))};`).join('\n')
  const compiler = await compile(`@layer theme, base, components, utilities;\n@layer theme {\n${theme}\n}\n${imports}\n@layer utilities {\n${utilities}\n}\n@config "dsh-taiwind:merged";`, {
    loadModule: async (id) => {
      if (id !== 'dsh-taiwind:merged')
        throw new Error(`Unexpected Tailwind module: ${id}`)
      return { path: id, base: '', module: merged as Config }
    },
    loadStylesheet: async (id) => {
      const path = resolve(id)
      const content = stylesheets.get(path)
      if (content === undefined)
        throw new Error(`Unexpected Tailwind stylesheet: ${id}`)
      return { path, base: dirname(path), content }
    },
  })
  if (compiler.sources.length || (compiler.root !== null && compiler.root !== 'none'))
    throw new Error('Tailwind source(...) directory scanning is not supported; file candidates come from client bundles')
  const css = compiler.build(candidates)
  cached = { signature: digest, css }
  return css
}
