# dsh-taiwindcss

把当前 DSH 客户端插件使用的 Tailwind 工具类取并集，编译成一份共享样式。例如插件 A 使用 `w-xl`，插件 B 使用 `w-full w-xl`，共享样式中的 `.w-xl`、`.w-full` 各生成一次。

基于 Tailwind CSS 4.3.3，要求 DSH `>=0.2.1-alpha.1`、Node.js `>=22.18.0`。本仓库提供源码和构建产物；尚未发布 npm，不能把 `npm install dsh-taiwindcss` 当作已经可用的安装方式。

## 工作方式

- 宿主从 `clientModules.graph()` 获取当前客户端包，通过 `clientPath(id)` 定位真实构建产物，不依赖插件源码或统一的构建工具。
- 扫描客户端入口所在目录及其子目录中的 `.js`、`.cjs`、`.mjs`；跳过 `node_modules`、`archive` 和符号链接。不扫描源码映射，也不追踪目录外的分包。
- 通过 Tailwind 官方扫描器抽取候选类，统一编译；不加载 Preflight，避免重置宿主界面。
- 初次编译完成后，把样式注入首页 `<head>`。客户端接管同一个 `<style data-plugin="dsh-taiwindcss" data-plugin-css="utilities">`，不额外创建第二份。
- 插件图变化时立即刷新；另外每两秒检查一次产物和配置。内容未变时复用成功编译结果，浏览器使用 ETag 条件请求。没有磁盘缓存。
- 删除类名、分包或卸载插件后，下次成功编译会收缩样式。首次编译失败会使插件启动失败；运行期间编译失败则记录错误、接口返回 503，已经打开的页面保留上一份有效样式，修复后自动恢复。
- 停用时移除路由、监听、定时器和客户端样式，并取消进行中的请求。

这不是 DOM 运行时扫描器。`"w-" + size` 无法保证被识别，应该使用完整类名映射，例如 `{ compact: "w-32", wide: "w-xl" }`。扫描单位是构建文件，因此同目录宿主代码、无关字符串或已注册但未实际使用的类也可能进入候选集合；不保证只包含当前可见 DOM 的类。

## CSS-first：推荐用法

在插件包中保留未编译的 `main.css`，不需要 `tailwind.config.js`，也不需要把路径传给本插件：

```css
@import "tailwindcss";

@theme {
  --color-notes-accent: #7c3aed;
  --container-notes-panel: 28rem;
}

@utility notes-compact {
  padding: 3px;
}
```

客户端使用 `bg-notes-accent w-notes-panel notes-compact` 即可。入口按以下顺序发现：包根目录的 `main.css` → 客户端入口同目录的 `main.css` → 包内其他位置唯一的 `main.css`，例如 `src/client/main.css`。最后一步找到多个入口会明确报错，不任意选择。递归扫描跳过 `node_modules`、`archive`、`.git` 和符号链接。

只扫描当前客户端图中插件所属的 npm 包，`package.json` 名称必须与客户端 ID 一致。发布时必须把原始 CSS 入口及其相对导入文件放进 npm 包；若只发布 `dist`，可把原始 `main.css` 及其依赖一起复制进 `dist`，不要用已经展开成工具类的构建 CSS 代替它。

CSS 入口存在时，**不会自动加载根目录的 JS 配置**。确实需要兼容旧配置时，在 CSS 中显式添加 `@config "./tailwind.config.js";`；路径相对于写下指令的 CSS 文件。没有 CSS 入口时才自动发现根目录的旧配置；两者都没有时，仍可使用默认 Tailwind 工具类。

支持 `@theme`（包括 `inline`、`static` 等 Tailwind 选项）、`@utility`、`@custom-variant`、`@apply`、相对 `.css` 的 `@import` / `@reference`，以及 `@source inline(...)`。相对导入的 layer、媒体条件由 Tailwind 处理。`@import "tailwindcss"` 及标准 theme/utilities 子入口统一由共享编译器提供，不重复加载；Preflight 始终不加载。`prefix(...)`、`important`、`source(none)` 支持，其中 prefix 和 important 必须在所有插件间一致。

不支持 npm CSS 包导入、路径别名、远程 CSS、`@plugin`、文件路径形式的 `@source`、自定义 `source(...)` 扫描目录和跨包 CSS 导入；遇到这些用法会报错。候选类默认来自客户端构建文件，额外完整类名可用 `@source inline(...)` 声明。普通自定义 CSS 会一起输出，但不会自动限定作用域、去重或改写其中的资源 URL，应使用插件前缀选择器和可直接访问的资源地址。

不同插件的 CSS 自定义 token、同名 `@utility` / `@custom-variant` 定义不一致会报错并指出包名；这不是完整的 CSS 语义等价判断，也不保证检测 CSS 与旧 JS 配置之间的所有冲突。CSS 与 JS 的同名主题合并遵循 Tailwind 4：同一 token 的 CSS 定义优先，不是任意同名工具类都由 CSS 覆盖；例如 `--container-panel` 不会覆盖旧配置 `theme.extend.width.panel` 生成的 `w-panel`。所有插件仍共享全局主题，并非按插件隔离。

CSS 入口、相对导入文件或类名修改后，下次检查会重新编译；删除类名、入口或插件后会收缩样式。导入循环、缺失文件、语法错误均沿用失败保留与修复后恢复机制。

## 可选的旧配置兼容

在没有 CSS 入口的插件包根目录放一份 `tailwind.config.js`、`.cjs`、`.mjs`、`.ts`、`.cts` 或 `.mts`，或者通过 CSS 的 `@config` 显式引用。兼容 `taiwind.config.*` 拼写，但自动发现时同一个包只能有一份配置。不向上误用工作区配置。

```ts
export default {
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        'notes-accent': 'var(--notes-accent)',
      },
      width: {
        'notes-panel': '28rem',
      },
    },
  },
}
```

使用 `bg-notes-accent w-notes-panel` 即可。发布插件时，需要把这份配置和它依赖的辅助模块放进 npm 包的 `files` 清单；只发布 `dist` 会使根配置丢失。配置在宿主进程中执行，和普通插件代码具有相同信任要求，不是沙箱。

第一版支持的配置范围：

- `theme.extend`：静态、可表示为 JSON 的对象、数组和值；不支持函数或直接替换 `theme.colors` 等默认主题段。
- `darkMode`、`prefix`、`important`：全局选项，所有显式设置它们的插件必须一致。未指定 `darkMode` 时默认使用 `class`。前缀遵循 Tailwind v4，例如 `prefix: 'tw'` 对应 `tw:w-full`，不是 v3 的 `tw-w-full`。
- 旧配置不支持 `content`、`safelist`、`plugins`、`presets` 或任意额外配置项；遇到它们明确报错，不静默忽略。扫描范围由共享编译器决定，与各包构建时的 Tailwind `content` 无关。

各包的 `theme.extend` 合并成一个全局主题：同路径同值共享，不同值报错并指出相关包；同主题段下，嵌套路径、连字符路径及 `DEFAULT` 展开后同名的 token 也检查冲突。不同主题段之间仍遵循 Tailwind 本身的工具类优先级，不承诺检测所有可能的同名工具类语义冲突。**独立配置文件不等于样式隔离**：配置作用于所有参与编译的插件，建议给自定义 token 加插件前缀；全局前缀、重要性和暗色策略也不是按插件单独生效。

根配置修改会重新加载，TypeScript 辅助模块修改也已覆盖刷新测试。原生 CJS/JSON 辅助模块受 Node.js 模块缓存影响，修改后需要重启宿主；本插件不会清理其他插件共享的模块缓存。

## 和已有 CSS 共存

本插件只对自己生成的样式去重，不删除宿主或其他插件已经挂载的 CSS。如果插件还在打包并加载自己的 Tailwind 样式，页面仍会存在重复规则；迁移时应停止该插件的独立 Tailwind CSS 挂载，保留确实需要的非 Tailwind 自定义样式。不同来源、不同版本 Tailwind 之间的主题及层叠优先级也不会自动统一。

服务地址为 `plugins/dsh-taiwindcss.css`，只允许经过 DSH Connection 来源和身份校验的 GET/HEAD 请求。它不是独立 CSS 构建服务，不接受用户提交配置或路径。

## 本地开发与验证

```sh
pnpm install --frozen-lockfile
pnpm run lint
pnpm run typecheck
pnpm run test -- --run
pnpm run build
```

`pnpm run dev` 监听构建。此仓库的构建和测试不会自动安装到正在运行的 DSH profile；接入真实界面仍需通过 DSH 插件管理安装该包并启用，且宿主必须提供 `clientModules`、`webServer`、`connection` 服务。客户端没有独立页面，也不能用单独的 Vite 服务替代 DSH。

测试覆盖真实 Tailwind 编译的去重、CSS-first 入口发现与优先级、相对导入和重载、CSS 指令、显式 `@config`、定义冲突、旧配置合并、分包和删除收缩；宿主/客户端测试使用受控服务和 DOM 替身覆盖条件请求、失败保留、恢复、首次编译竞态及清理，不代表已在用户运行中的 DSH 界面验收。

## 发布

普通分支 CI 成功不等于 npm 已发布。模板的 Release 工作流仅由 `v*` 标签触发，需要另行配置 npm Trusted Publisher；本次实现不创建版本标签、不发布 npm。

## License

[MIT](<LICENSE.md>) © dsh-tauri-desk，保留上游模板授权。
