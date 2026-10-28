import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { compilePlugins } from '../src/compiler'

const temporary: string[] = []

async function plugin(id: string, content: string, config?: string, filename = 'tailwind.config.mjs') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-taiwindcss-'))
  temporary.push(root)
  const dist = join(root, 'dist')
  await mkdir(dist)
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: id, type: 'module' }))
  const path = join(dist, 'client.js')
  await writeFile(path, content)
  if (config)
    await writeFile(join(root, filename), config)
  return { id, path, root, dist }
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('compilePlugins', () => {
  it('unions complete bundle candidates with variants and arbitrary values, without preflight', async () => {
    const first = await plugin('first', 'const classes = "w-xl"')
    const second = await plugin('second', 'const classes = "w-full w-xl md:w-full dark:w-xl w-[37px]"')
    const css = await compilePlugins([first, second])
    expect(css.match(/\.w-xl\s*\{/g)).toHaveLength(1)
    expect(css.match(/\.w-full\s*\{/g)).toHaveLength(1)
    expect(css).toContain('.md\\:w-full')
    expect(css).toContain('.dark\\:w-xl')
    expect(css).toContain('.dark')
    expect(css).toContain('width: 37px')
    expect(css).not.toContain('box-sizing: border-box')
    expect(await compilePlugins([second, first])).toBe(css)
  })

  it('discovers CSS-first entries without JS config and compiles one shared set of utilities', async () => {
    const first = await plugin('first', '"w-xl w-panel bg-notes compact"')
    const second = await plugin('second', '"w-xl w-full bg-notes compact"')
    const cssEntry = '@import "tailwindcss"; @theme { --color-notes: #123456; --container-panel: 28rem; } @utility compact { padding: 3px; }'
    await writeFile(join(first.root, 'main.css'), cssEntry)
    await writeFile(join(second.dist, 'main.css'), cssEntry)
    const css = await compilePlugins([first, second])
    expect(css.match(/\.w-xl\s*\{/g)).toHaveLength(1)
    expect(css.match(/\.w-full\s*\{/g)).toHaveLength(1)
    expect(css.match(/\.compact\s*\{/g)).toHaveLength(1)
    expect(css.match(/padding: 3px/g)).toHaveLength(1)
    expect(css).toContain('--color-notes: #123456')
    expect(css).toContain('width: var(--container-panel)')
    expect(css).toContain('background-color: var(--color-notes)')
    expect(css).not.toContain('box-sizing: border-box')
  })

  it('discovers a nested main.css, follows relative imports and refreshes imported changes', async () => {
    const first = await plugin('first', '"w-panel tiny h-full"')
    const directory = join(first.root, 'src', 'client')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'main.css'), '@import "tailwindcss"; @import "./theme.css"; .notes-card { @apply w-full; }')
    const theme = join(directory, 'theme.css')
    await writeFile(theme, '@theme inline { --container-panel: 31px; } @utility tiny { font-size: 9px; }')
    const css = await compilePlugins([first])
    expect(css).toContain('width: 31px')
    expect(css).toContain('font-size: 9px')
    expect(css).toMatch(/\.notes-card\s*\{\s*width: 100%/)
    await writeFile(theme, '@theme inline { --container-panel: 47px; }')
    const changed = await compilePlugins([first])
    expect(changed).toContain('width: 47px')
    expect(changed).not.toContain('font-size: 9px')
    expect(changed).not.toContain('width: 31px')
    await rm(join(directory, 'main.css'))
    const removed = await compilePlugins([first])
    expect(removed).not.toContain('.w-panel')
    expect(removed).not.toContain('.notes-card')
  })

  it('prefers root main.css over a compiled copy and ignores implicit JS config', async () => {
    const first = await plugin('first', '"w-panel w-legacy"', 'throw new Error("must not execute")')
    await writeFile(join(first.root, 'main.css'), '@import "tailwindcss"; @theme inline { --container-panel: 41px; }')
    await writeFile(join(first.dist, 'main.css'), 'invalid compiled stylesheet {')
    const css = await compilePlugins([first])
    expect(css).toContain('width: 41px')
    expect(css).not.toContain('.w-legacy')
  })

  it('loads JS config only through explicit @config when CSS exists, with CSS theme taking precedence', async () => {
    const first = await plugin('first', '"w-legacy bg-brand"', 'export default { theme: { extend: { width: { legacy: "53px" }, colors: { brand: "red" } } } }')
    await writeFile(join(first.dist, 'main.css'), '@import "tailwindcss"; @config "../tailwind.config.mjs"; @theme { --color-brand: blue; }')
    const css = await compilePlugins([first])
    expect(css).toContain('width: 53px')
    expect(css).toContain('--color-brand: blue')
    expect(css).not.toContain('background-color: red')
  })

  it('supports CSS custom variants, inline sources, reference imports and import flags', async () => {
    const first = await plugin('first', '"tw:panel:compact tw:dark:w-full"')
    await writeFile(join(first.root, 'main.css'), '@import "tailwindcss" prefix(tw) important source(none); @reference "./tokens.css"; @custom-variant panel (&:where(.notes-panel *)); @custom-variant dark (&:where(.night *)); @source inline("tw:h-full");')
    await writeFile(join(first.root, 'tokens.css'), '@utility compact { padding: 3px; } .not-emitted { color: red; }')
    const css = await compilePlugins([first])
    expect(css).toContain('.tw\\:panel\\:compact')
    expect(css).toContain('.notes-panel')
    expect(css).toContain('.tw\\:h-full')
    expect(css).toContain('.night')
    expect(css).toContain('!important')
    expect(css).not.toContain('.not-emitted')
  })

  it('reports cross-plugin CSS definition conflicts instead of silently changing another plugin', async () => {
    const first = await plugin('first', '"bg-brand compact"')
    const second = await plugin('second', '"bg-brand compact"')
    await writeFile(join(first.root, 'main.css'), '@theme { --color-brand: red; } @utility compact { padding: 3px; }')
    await writeFile(join(second.root, 'main.css'), '@theme { --color-brand: blue; }')
    await expect(compilePlugins([first, second])).rejects.toThrow(/CSS conflict.*--color-brand.*first.*second/)
    await writeFile(join(second.root, 'main.css'), '@utility compact { padding: 4px; }')
    await expect(compilePlugins([first, second])).rejects.toThrow(/CSS conflict.*@utility compact.*first.*second/)
  })

  it('rejects ambiguous CSS entries, circular imports and unsupported directives', async () => {
    const first = await plugin('first', '"w-full"')
    await mkdir(join(first.root, 'src'))
    await mkdir(join(first.root, 'other'))
    await writeFile(join(first.root, 'src', 'main.css'), '')
    await writeFile(join(first.root, 'other', 'main.css'), '')
    await expect(compilePlugins([first])).rejects.toThrow(/multiple main.css entries/)
    const main = join(first.root, 'main.css')
    await writeFile(main, '@import "./main.css";')
    await expect(compilePlugins([first])).rejects.toThrow(/first.*circular CSS import/)
    await writeFile(main, '@source "./src";')
    await expect(compilePlugins([first])).rejects.toThrow(/first.*only @source inline/)
    await writeFile(main, '@plugin "@tailwindcss/typography";')
    await expect(compilePlugins([first])).rejects.toThrow(/first.*@plugin is not supported/)
    await writeFile(main, '@import "./missing.css";')
    await expect(compilePlugins([first])).rejects.toThrow(/ENOENT/)
  })

  it('rejects custom source directories in relative imports and utilities directives', async () => {
    const first = await plugin('first', '"w-full"')
    const main = join(first.root, 'main.css')
    await writeFile(join(first.root, 'tokens.css'), '@theme { --color-notes: red; }')
    for (const directive of ['@import "./tokens.css" source("./src");', '@tailwind utilities source("./src");']) {
      await writeFile(main, directive)
      await expect(compilePlugins([first])).rejects.toThrow(/source\(\.\.\.\).*not supported/)
    }
    await writeFile(main, '@tailwind utilities source(none);')
    expect(await compilePlugins([first])).toContain('.w-full')
  })

  it('merges static theme extensions from each owning npm package', async () => {
    const first = await plugin('first', '"w-first w-shared"', 'export default { theme: { extend: { width: { first: "17px", shared: "29px" } } } }')
    const second = await plugin('second', '"w-second w-shared"', 'module.exports = { theme: { extend: { width: { second: "23px", shared: "29px" } } } }', 'taiwind.config.cts')
    const css = await compilePlugins([first, second])
    expect(css).toContain('width: 17px')
    expect(css).toContain('width: 23px')
    expect(css).toContain('width: 29px')
    expect(css.match(/\.w-shared\s*\{/g)).toHaveLength(1)
  })

  it('reports different same-path or nested/flat theme values with package names', async () => {
    const first = await plugin('first', '"bg-brand-primary"', 'export default { theme: { extend: { colors: { brand: { primary: "red" } } } } }')
    const second = await plugin('second', '"bg-brand-primary"', 'export default { theme: { extend: { colors: { "brand-primary": "blue" } } } }')
    await expect(compilePlugins([first, second])).rejects.toThrow(/conflict.*colors\.brand-primary.*first.*second/)
    await writeFile(join(second.root, 'tailwind.config.mjs'), 'export default { theme: { extend: { colors: { brand: { primary: "blue" } } } } }')
    await expect(compilePlugins([first, second])).rejects.toThrow(/conflict.*first.*second/)
  })

  it('honors shared global config and rejects disagreement', async () => {
    const first = await plugin('first', '"tw:w-full tw:dark:w-full"', 'export default { prefix: "tw", important: true, darkMode: "class" }')
    const second = await plugin('second', '"tw:w-full"', 'export default { prefix: "tw", important: true, darkMode: "class" }')
    const css = await compilePlugins([first, second])
    expect(css).toContain('.tw\\:w-full')
    expect(css).toContain('!important')
    await writeFile(join(second.root, 'tailwind.config.mjs'), 'export default { prefix: "other" }')
    await expect(compilePlugins([first, second])).rejects.toThrow(/conflict at prefix.*first.*second/)
  })

  it('shrinks after class removal, chunk removal, and plugin removal', async () => {
    const first = await plugin('first', '"w-full"')
    const second = await plugin('second', '"h-full"')
    const chunk = join(first.dist, 'lazy.cjs')
    await writeFile(chunk, 'module.exports = "min-w-full"')
    const original = await compilePlugins([first, second])
    expect(original).toContain('.w-full')
    expect(original).toContain('.h-full')
    expect(original).toContain('.min-w-full')
    await writeFile(first.path, '"w-xl"')
    await rm(chunk)
    const shrunk = await compilePlugins([first])
    expect(shrunk).toContain('.w-xl')
    expect(shrunk).not.toContain('.w-full')
    expect(shrunk).not.toContain('.h-full')
    expect(shrunk).not.toContain('.min-w-full')
  })

  it('scans nested JS chunks but excludes node_modules and symbolic directories', async () => {
    const first = await plugin('first', '"w-full"')
    await mkdir(join(first.dist, 'chunks'))
    await writeFile(join(first.dist, 'chunks', 'lazy.mjs'), 'export default "max-w-full"')
    await mkdir(join(first.dist, 'node_modules'))
    await writeFile(join(first.dist, 'node_modules', 'vendor.js'), '"hidden"')
    const outside = await mkdtemp(join(tmpdir(), 'dsh-taiwindcss-outside-'))
    temporary.push(outside)
    await writeFile(join(outside, 'outside.js'), '"inline-flex"')
    await symlink(outside, join(first.dist, 'linked'), 'junction')
    const css = await compilePlugins([first])
    expect(css).toContain('.max-w-full')
    expect(css).not.toContain('.hidden')
    expect(css).not.toContain('.inline-flex')
  })

  it('reloads imported config helpers and recovers after a failed config', async () => {
    const first = await plugin('first', '"w-helper"', 'import width from "./width.ts"; export default { theme: { extend: { width } } }', 'tailwind.config.ts')
    const helper = join(first.root, 'width.ts')
    await writeFile(helper, 'export default { helper: "31px" }')
    expect(await compilePlugins([first])).toContain('width: 31px')
    await writeFile(helper, 'export default { helper: "47px" }')
    expect(await compilePlugins([first])).toContain('width: 47px')
    await writeFile(join(first.root, 'tailwind.config.ts'), 'export default { theme: { extend: { width: () => ({ helper: "47px" }) } } }')
    await expect(compilePlugins([first])).rejects.toThrow(/first.*static/)
    await writeFile(join(first.root, 'tailwind.config.ts'), 'export default { theme: { extend: { width: { helper: "53px" } } } }')
    expect(await compilePlugins([first])).toContain('width: 53px')
  })

  it('loads CommonJS helpers and refreshes edits to the root CommonJS config', async () => {
    const first = await plugin('first', '"w-helper"', 'module.exports = { theme: { extend: { width: require("./width.cjs") } } }', 'tailwind.config.cjs')
    await writeFile(join(first.root, 'width.cjs'), 'module.exports = { helper: "61px" }')
    expect(await compilePlugins([first])).toContain('width: 61px')
    await writeFile(join(first.root, 'tailwind.config.cjs'), 'module.exports = { theme: { extend: { width: { helper: "73px" } } } }')
    expect(await compilePlugins([first])).toContain('width: 73px')
  })

  it('rejects unsupported options, direct theme replacement, duplicate configs, and a wrong owner', async () => {
    const first = await plugin('first', '"w-full"', 'export default { content: ["./src/**/*.ts"] }')
    await expect(compilePlugins([first])).rejects.toThrow(/first.*unsupported.*content/)
    await writeFile(join(first.root, 'tailwind.config.mjs'), 'export default { theme: { colors: { brand: "red" } } }')
    await expect(compilePlugins([first])).rejects.toThrow(/first.*direct theme replacement/)
    await writeFile(join(first.root, 'taiwind.config.js'), 'export default {}')
    await expect(compilePlugins([first])).rejects.toThrow(/first.*multiple Tailwind configs/)
    await expect(compilePlugins([{ id: 'wrong', path: first.path }])).rejects.toThrow(/wrong.*owning package/)
  })
})
