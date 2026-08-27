# Contributing to ThingLinks Edge

Thanks for your interest. This document covers the engineering rules that are
**non-negotiable in this repository** — they exist because breaking them has
already cost us real, silent bugs.

[English](#english) · [简体中文](#简体中文)

---

## English

### Engineering discipline

| Rule | What it means |
| --- | --- |
| **Verify as you build** | A task without a runnable verification command is not done |
| **Regression only grows** | `pnpm verify` must be fully green every time; new capabilities keep adding assertions |
| **Verify against reality** | Any conclusion about third-party behaviour must be re-checked in a real container or a real browser |
| **Leave it runnable** | After every change the system must start, log in, and not regress |
| **Never weaken production constraints for tests** | e.g. instance port 1880 is never published to the host; tests use an explicit socat sidecar instead |
| **No hardcoded credentials** | A missing `MASTER_KEY` must refuse to start, never silently fall back to a default |

Two of these deserve emphasis:

**Assertions must land on the failure point.** We shipped a log endpoint that
returned Docker's multiplexed stream undecoded — control bytes in every line —
and the existing assertion stayed green the whole time, because it only checked
that a substring appeared *somewhere*. "Has content" is not "content is correct".

**A mock upstream verifies plumbing, not failure modes.** An early proxy PoC
against a fake Node-RED produced a conclusion that turned out to be plainly
wrong about the real thing. Mocks tell you the wiring is connected; they cannot
tell you how the real dependency fails.

### Local setup

```bash
pnpm install
cd apps/manager && pnpm verify   # full regression, requires a Docker daemon
```

`pnpm verify` runs unit tests, typecheck, build, and 11 real-container
verification passes. All of them must be green before you open a PR.

### Commit style

`type(scope): 中文描述` — `feat` / `fix` / `refactor` / `docs` / `build` / `chore` / `perf`.

Directory moves and renames go in their own commit using `git mv`, so git
records them as renames.

### Task granularity

One task touches at most 5 files. If the title needs the word "and", split it.

### Pull requests

1. Make sure `pnpm verify` is green
2. Add assertions covering the new behaviour — regression only grows
3. If you hit a non-obvious third-party behaviour, document it alongside the fix

---

## 简体中文

### 开发纪律

| 纪律 | 要求 |
| --- | --- |
| **写一点验一点** | 任务未附可执行的验证命令视为未完成 |
| **回归只增不减** | `pnpm verify` 每次必须全绿，新能力持续往里加断言 |
| **真实环境验证** | 涉及第三方真实行为的结论必须在真实容器/浏览器复核 |
| **每步留可用状态** | 任何改动结束时系统可启动、可登录、已有功能不退化 |
| **不为测试破坏生产约束** | 例：实例 1880 不映射宿主，测试用显式 socat 边车搭桥 |
| **无硬编码凭据** | 缺 `MASTER_KEY` 必须拒绝启动，不得静默回落默认值 |

其中两条值得单独强调：

**断言必须打在失败点上。** 日志接口曾把 Docker 多路复用流原样吐出，每行都混着控制字节，
而原有断言全程是绿的 —— 因为它只检查某个子串「出现过」。「有内容」不等于「内容对」。

**模拟上游能验证管线，不能推断失败机制。** 早期反代 PoC 用模拟 Node-RED 得出的结论，
后来被真实环境证明是错的。模拟能告诉你线接上了，不能告诉你真实依赖会怎么坏。

### 本地准备

```bash
pnpm install
cd apps/manager && pnpm verify   # 全量回归，需要 Docker 守护进程
```

`pnpm verify` 会跑单元测试、类型检查、构建，以及 11 次真容器验证。提 PR 前必须全绿。

### 提交风格

`type(scope): 中文描述` —— `feat` / `fix` / `refactor` / `docs` / `build` / `chore` / `perf`。

目录移动与改名用 `git mv` 独立成笔，保证 git 历史记录为 rename。

### 任务粒度

单任务不超过 5 个文件。标题里出现「和」字就拆开。

### 提交 PR

1. 确认 `pnpm verify` 全绿
2. 为新行为补断言 —— 回归只增不减
3. 踩到第三方的非显然行为，随修复一并记录下来
