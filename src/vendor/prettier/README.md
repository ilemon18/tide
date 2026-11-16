# 内置 Prettier（vendor）

`src/vendor/prettier/` 里的文件是从 npm 包 `prettier@3.9.10` 原样拷过来的
`standalone.mjs` 与 `plugins/*.mjs`（MIT，见同目录 LICENSE）。

为什么内置：Prettier 的 standalone 构建是纯 ESM、不依赖 Node，可以直接在
WebView 里跑 —— 这样「保存时格式化」就不用要求用户本机装 Node / prettier，
也不会因为项目里没装而失效。

- 只按需加载：`src/lib/format.ts` 里用 `import()` 动态引入，Vite 会切成独立 chunk，
  没开格式化的用户不会付这份体积。
- 只带常用 parser：babel（js/jsx/json）、typescript（ts/tsx）、postcss（css/scss/less）、
  html（html/vue）、markdown（md/mdx）、yaml（yaml/yml）、estree（AST 打印）。
- 升级方式：把新版本 `node_modules/prettier/standalone.mjs` 和 `plugins/*.mjs` 覆盖进来，
  并在 `src/lib/formatters.ts` 的注释里同步版本号。

项目自己的 Prettier 配置（`.prettierrc` / `.prettierrc.json` / `package.json` 的
`prettier` 字段）由后端 `prettier_config` 命令读出后合并进选项；YAML / JS 形态的
配置文件暂不支持（会退回 Prettier 默认值）。