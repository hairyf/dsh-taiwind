import type { Context } from '@deepseek-ai/cordis'
import { mountStyles } from './styles'

export function apply(ctx: Context): void {
  ctx.effect(mountStyles)
}
