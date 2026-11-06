import type { Context } from '@deepseek-ai/cordis'

/**
 * 客户端图同步状态的可读面：`ctx.modules.entries.state` 的结构子集。
 * 每次插件安装/卸载/启停或产物重建，页面控制器都会在同步前后各发布一次。
 */
export interface EntrySyncState {
  /** 当前是否仍在应用最新插件图；false 表示这批变化已经落到页面上。 */
  getSnapshot: () => { readonly syncing: boolean }
  /** 订阅状态变化；返回取消订阅的 disposer。 */
  subscribe: (listener: () => void) => () => void
}

/** 客户端上下文里本插件消费的模块系统服务（`dsh.client.inject` 保证存在）。 */
export type ClientContext = Context & {
  modules?: { entries?: { state?: EntrySyncState } }
}
