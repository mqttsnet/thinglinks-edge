/**
 * ESLint 配置（T0.3）。
 *
 * 在此之前 `lint` 脚本其实就是 `tsc --noEmit` —— 名字叫 lint，做的却是类型检查，
 * 而**类型检查抓不到的那类问题恰恰是 lint 存在的理由**：漏 await 的 Promise、
 * 吞掉的异常、写了不用的变量、条件恒真。这份配置只开这几类，不做风格警察。
 *
 * 两条取舍：
 *
 *   1. **不开格式类规则**（缩进、引号、分号）。这个仓库风格已经一致，
 *      引入格式规则只会制造一次几千行的无意义 diff，还会和正在进行的改动打架。
 *      要做格式统一应该单独一笔、用 formatter 做，不混在 lint 里。
 *   2. **类型感知规则只开真正抓 bug 的那几条**。全量打开 `recommendedTypeChecked`
 *      会带来上百条以风格为主的告警，人会开始习惯性忽略 lint 输出 ——
 *      那时候 lint 就废了。宁可少而全绿，也不要多而长期挂红。
 */
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import vue from 'eslint-plugin-vue';
import vueParser from 'vue-eslint-parser';

export default tseslint.config(
  {
    // 构建产物与依赖不参与检查
    ignores: [
      '**/dist/**', '**/node_modules/**', '**/target/**',
      'apps/manager/scripts/**',      // 验证脚本是 .mjs 工装，另有约定，不套 TS 规则
    ],
  },

  js.configs.recommended,

  // ── TypeScript：只在源码上开类型感知 ──────────────────
  {
    files: ['apps/**/src/**/*.ts', 'packages/**/*.ts'],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        /*
         * 显式指定 project，而不是 `projectService: true`。
         *
         * manager 的主 tsconfig 把 `*.test.ts` / `*.fixtures.ts` 排除在外
         * （构建产物不该带测试，这是对的），于是自动发现模式下这批文件
         * 会报 "was not found by the project service" —— 而那是**静默跳过**：
         * lint 显示通过，实际一条测试都没检查过。
         * 所以另给一份 tsconfig.eslint.json，只为 lint 把测试包含进来。
         */
        project: [
          './apps/manager/tsconfig.eslint.json',
          './apps/web-console/tsconfig.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      /*
       * 漏 await 是这类代码里最贵的 bug：Promise 没被等，异常变成
       * unhandled rejection，而调用方以为已经做完了。本轮就撞到过一次
       * （定时刷盘失败没人接住）。
       */
      /*
       * `node:test` 的 test/describe/it **按设计返回 Promise 且不该被 await**
       * （await 会把并行执行变成串行）。用 allowForKnownSafeCalls 精确豁免它们，
       * 而不是在测试文件里整条关掉规则 —— 测试里照样会有真正漏 await 的异步断言，
       * 那才是这条规则最该抓的地方。
       */
      '@typescript-eslint/no-floating-promises': ['error', {
        allowForKnownSafeCalls: [
          { from: 'package', package: 'node:test', name: ['test', 'describe', 'it', 'before', 'after'] },
        ],
      }],
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',

      /*
       * `no-unnecessary-condition` **刻意关闭**。
       *
       * 本仓库在信任边界上用的是「先 `as` 强转、再运行时校验」这一套：
       * 备份文件、HTTP 入参、数据库读回的角色与档位，类型上都被断言成了
       * 字面量联合，于是 TS 认为 `role !== 'admin'` 之类恒假 —— 但**运行时不是**。
       *
       * 实测这条规则报的 24 处，全部是这种防御检查，例如：
       *   · authz.ts  `ROLE_ACTIONS[role as Role] ?? new Set()`
       *     —— 注释写着「未知角色按最小权限，数据脏了不该变成提权」，删了就是提权漏洞
       *   · backup.ts `parsed.product !== 'thinglinks-edge'` —— 校验的是用户上传的文件
       *   · user-repo / config-repo —— 校验的是 HTTP 入参
       *
       * 按规则「修」等于把这些闸门逐个拆掉。方向是反的，所以关掉它。
       * 真要开，前提是先把边界处的 `as` 换成运行时 schema 校验，那是另一件事。
       */
      '@typescript-eslint/no-unnecessary-condition': 'off',

      /*
       * `catch {}` 空吞异常 —— 本轮审查里 fsync 的错误就是这么被吞掉的，
       * 表现是「界面一切正常，数据其实没落盘」。要吞必须写明理由。
       */
      'no-empty': ['error', { allowEmptyCatch: false }],

      /* 未使用的变量交给 tsc 的 noUnusedLocals，这里只管参数的前缀豁免 */
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_', varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],

      /*
       * 这几条在本仓库是有意为之，关掉：
       *   · any —— HTTP 层的 req/reply 是 Fastify 泛型，写死会绑死框架版本
       *   · non-null 断言 —— 与 noUncheckedIndexedAccess 配套使用，是刻意的
       */
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  /*
   * Node-RED 节点集是 CommonJS —— 它要被 Node-RED 运行时 require 进去，
   * 不能是 ESM。所以单独给它 Node 全局与 commonjs sourceType，
   * 否则 require / module / process 全被 no-undef 判成未定义。
   */
  {
    files: ['packages/thinglinks-nodes/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },

  // ── Vue 单文件组件 ────────────────────────────────
  {
    files: ['apps/web-console/src/**/*.vue'],
    extends: [...vue.configs['flat/recommended']],
    languageOptions: {
      parser: vueParser,
      parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.vue'] },
      // 控制台跑在浏览器里：window / HTMLElement / ResizeObserver 都是宿主全局
      globals: { ...globals.browser },
    },
    rules: {
      // 组件名单文件即单组件，不强制多词命名
      /*
       * 模板里用了没引入的组件 —— 2026-08-31 真的踩了：`NSelect` 忘了加进
       * naive-ui 的 import，Vue 把它当未知组件渲染成一个空元素，
       * 界面上是个既无占位符也无下拉箭头的空框。
       *
       * **vue-tsc 和 vite build 都不会报错**（模板里的未知标签在运行期才解析），
       * 所以只能靠这条规则挡。忽略以 `router-` 开头的内置组件与本地注册的。
       */
      'vue/no-undef-components': ['error', {
        ignorePatterns: ['router-view', 'router-link'],
      }],
      'vue/multi-word-component-names': 'off',
      // 模板属性换行是风格，不管
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off',
      'vue/html-indent': 'off',
      'vue/html-closing-bracket-newline': 'off',
      'vue/attributes-order': 'off',
      // 以下同为格式类，交给人和 formatter，不由 lint 管
      'vue/multiline-html-element-content-newline': 'off',
      'vue/first-attribute-linebreak': 'off',
    },
  },

  /*
   * web-console 的 .ts（api / router / 纯逻辑模块）同样跑在浏览器里。
   * 上面那条 TypeScript 通用规则不带 globals，会把 fetch / localStorage 判成未定义。
   */
  {
    files: ['apps/web-console/src/**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
  },

);
