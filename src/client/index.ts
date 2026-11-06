import type { ClientContext } from './types'
import { mountStyles } from './styles'

/**
 * 必需服务：客户端模块系统。由 `dsh.client.inject` 里的
 * `@deepseek-ai/dsh-client-modules` 提供，声明在这里让 cordis 等它就绪再激活，
 * 样式刷新才能挂到插件图的同步信号上。
 */
export const inject = ['modules']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => mountStyles(ctx))
}
