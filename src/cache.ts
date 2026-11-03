import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { CACHE_DIRECTORY, CACHE_STYLESHEET_FILE } from './constants'

/** 磁盘缓存条目：`signature` 是 CSS 的 sha256，与宿主下发的 ETag 同源。 */
export interface StylesCacheEntry {
  signature: string
  css: string
}

const signaturePattern = /^\/\* dsh-taiwind stylesheet signature: ([0-9a-f]{64}) \*\/\n/

/**
 * 编译产物落盘目录，默认 `~/.dsh/taiwind`。`$DSH_HOME` 的优先级与官方
 * `dsh-home-paths` 一致（显式配置 > `$DSH_HOME` > `~/.dsh`）。
 */
export function stylesCacheDirectory(): string {
  const home = process.env.DSH_HOME?.trim()
  return join(home ? resolve(home) : join(homedir(), '.dsh'), CACHE_DIRECTORY)
}

/** 编译产物文件：`~/.dsh/taiwind/styles.css`，可直接用编辑器打开检查。 */
export function stylesCachePath(): string {
  return join(stylesCacheDirectory(), CACHE_STYLESHEET_FILE)
}

/**
 * 读取上次编译的样式，用于首屏直接内联：有缓存就不必等本次编译。
 * 签名写在首行注释里，样式与签名同进同出，不存在「样式换了、签名还是旧的」这种半写状态。
 */
export async function readStylesCache(): Promise<StylesCacheEntry | undefined> {
  try {
    const content = await readFile(stylesCachePath(), 'utf8')
    const match = signaturePattern.exec(content)
    if (!match)
      return undefined
    const css = content.slice(match[0].length)
    return css ? { signature: match[1], css } : undefined
  }
  catch {
    // 首次启动、缓存目录只读或无权限都只是未命中，不影响本次编译与下发。
    return undefined
  }
}

/** 写入编译产物：先写同目录临时文件再原子替换，读到的永远是完整文件。 */
export async function writeStylesCache(entry: StylesCacheEntry): Promise<void> {
  const path = stylesCachePath()
  await mkdir(stylesCacheDirectory(), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `/* dsh-taiwind stylesheet signature: ${entry.signature} */\n${entry.css}`)
  await rename(temporary, path)
}
