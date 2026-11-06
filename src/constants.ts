export const PLUGIN_ID = 'dsh-taiwind'
export const STYLESHEET_PATH = 'plugins/taiwind.css'
export const STYLE_SELECTOR = 'style[data-plugin="dsh-taiwind"][data-plugin-css="utilities"]'
export const LINK_SELECTOR = 'link[data-plugin="dsh-taiwind"][data-plugin-css="utilities"]'
export const BOOT_STYLE_ID = 'dsh-taiwind-boot-style'
export const BOOT_ROOT_ID = 'dsh-taiwind-boot'

/**
 * 引导层的字标与提示。刻意是写死的英文常量，不做 i18n 查表：
 * 官方 Web boot 覆盖层同样是写死的字面量，一比一复刻才有意义。
 */
export const BOOT_WORDMARK = 'HARNESS'
export const BOOT_HINT = 'Loading appearance…'

/** 编译产物在 `~/.dsh` 下的位置：`<home>/taiwind/styles.css`。 */
export const CACHE_DIRECTORY = 'taiwind'
export const CACHE_STYLESHEET_FILE = 'styles.css'

/**
 * 首屏覆盖层的最长等待。覆盖层只用 CSS 动画淡出，不需要脚本：
 * 编译还没就绪时，界面在被遮住的状态下先画出来，到点自动揭晓。
 */
export const BOOT_REVEAL_DELAY_MS = 4000
