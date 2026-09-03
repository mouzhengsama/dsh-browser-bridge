# 工具面缺口评审与实施建议（Tool Surface Review）

- 日期：2026-09-02
- 状态：建议稿，待确认后实施
- 关联：ADR-0002 Web-Agent Parity Program（L1 工具面缺口）、docs/IMPLEMENTATION-ROADMAP.md

## 1. 结论摘要

当前暴露的 14 个 MCP 工具覆盖了「读 / 搜 / 补丁 / 命令」的底线，但对日常编码工作存在明确硬缺口，集中表现为：

1. 没有整文件写入工具（write_file 缺失），新建 / 整文件重写必须手写 diff；
2. 超过 512 KiB 的文件完全不可读（整文件缓冲上限，startLine/endLine 无法绕过）；
3. 没有 Git 结构化工具（git_status / git_diff 缺失），「改了什么」只能靠 shell + 手解析 porcelain；
4. 没有批量读取（read_many 缺失），读 N 个小文件消耗 N 次请求配额（120 rpm）；
5. 文件结构操作（rename / copy / mkdir）缺失，重构只能绕 shell mv；
6. 无图片内容输出（read_image 缺失，且结果恒为纯文本），UI 类任务无法看图。

对照 ADR-0002 的分层模型，以上全部属于 L1（工具面），可通过代码补齐；但须注意 L2（会话连续性）与 L3（厂商产品限制）对长任务完成率的影响更大，工具面按优先级补齐即可，不应一次性加满。

## 2. 现状核实（2026-09-02，源码级）

| 能力 | 工具 | 备注 |
| --- | --- | --- |
| 读取 | list_files / list_directory / search_text / read_file | read_file 有 512 KiB 整文件上限 |
| 写入 | apply_patch | 支持 create/update/delete；显式拒绝 rename |
| 命令 | run_command / get_command_output / send_command_input / terminate_command | 增量输出、stdin、2 MiB 输出上限 |
| LSP | get_diagnostics / lsp_query | 定义/引用/实现/hover |
| 进度 | report_progress / get_progress | — |
| 信息 | bridge_info | — |

关键源码事实（与 IMPLEMENTATION-ROADMAP F1-F9 一致）：

- `src/mcp/server.ts`：所有工具按 capability 门控注册，结果一律纯文本 JSON；
- `src/workspace/files.ts`：read_file 先做整文件大小校验再按行切片，超过 maxReadBytes 直接抛错；
- `src/config.ts`：requestBodyLimit 1mb、requestsPerMinute 120、maxConcurrentRequests 4、maxReadBytes 512 * 1024；
- 宿主为 Windows（cmd/PowerShell），命令片段需宿主感知。

## 3. 缺口与影响（8 个能力维度）

| # | 能力维度 | 状态 | 缺口 | 影响 |
| --- | --- | --- | --- | --- |
| 1 | 读取与搜索 | 部分 | 超过 512 KiB 大文件不可读 | 打包产物 / 快照 / lockfile 无法读 |
| 2 | 批量读取 | 缺口 | read_many | 小文件密集任务打满 120 rpm |
| 3 | 写入与编辑 | 部分 | write_file | 新建 / 整文件重写需手写 diff，费 token 易失败 |
| 4 | 文件结构操作 | 缺口 | rename / copy / mkdir | 重构绕 shell，破坏路径 / 版本语义 |
| 5 | Git | 缺口 | git_status / git_diff | 「改了什么」依赖 shell 手解析，易错 |
| 6 | 命令执行 | 已覆盖 | — | — |
| 7 | 语言服务 | 部分 | documentSymbol / 目录级诊断 | 大纲导航（stretch） |
| 8 | 视觉验证 | 缺口（默认关） | read_image | UI 任务无法看图；隐私默认关 |

## 4. 实施优先级与方案

### P0：write_file + read_many（纯增量、低风险、先落）

write_file

- Schema：`{ path, content, expectedVersion? }`
- 语义：文件不存在则创建；已存在仅当 expectedVersion 匹配当前版本时覆盖（读后写成为强约束）；自动创建父目录；拒绝二进制（NUL）内容。
- 返回：`{ path, version, size, operation: 'create' | 'update' }`
- 落点：WorkspaceFiles.writeFile（原子 tmp 写入 + rename，参照 patch.ts）；dsh 侧复用 createIfAbsent / replaceIfVersion。
- 注册于 capabilities.write。

read_many

- Schema：`{ paths: string[], startLine?, endLine? }` + 总字节上限
- 语义：path → `{ version, content }` 或 per-file 错误，单文件失败不拖垮整批。
- 注册于 capabilities.read。

### P1：分块大文件读取 + git_status / git_diff

分块读取（保持 read_file 名称）

- 保留 read_file(path, startLine?, endLine?)，解除整文件上限；流式扫描行偏移只返回请求切片；结果增加 fileSize。
- 前置门（F4）：确认 dsh fs seam 是否支持部分 / 流式读取；若否，回退为提升 maxReadBytes 默认值并更新 bridge_info。

git_status / git_diff（注册于 capabilities.command）

- git_status：`{}` → `{ branch, ahead, behind, staged, unstaged, untracked }`（git status --porcelain=v1 -b）
- git_diff：`{ scope?, staged?, includePatch? }` → `{ stat, files? }`（默认仅 numstat）
- 执行：execFile 参数数组、无 shell 插值、cwd 限制工作区根、超时受限、仅在存在 .git 时启用。

### P2：file_ops + LSP 大纲 + read_image（依赖 / 谨慎）

- file_ops（rename / copy / mkdir）：前置门（F2）确认 dsh fs 是否有 rename 原语；无则 rename 在 dsh 模式不可用并记录差异。
- LSP documentSymbol + 目录级诊断聚合（stretch）。
- read_image：新增 capabilities.image（默认 false），需 MCP image 内容支持；开启前先验证目标产品能渲染图片。

## 5. 落地检查清单（新增工具的规范路径）

1. src/types.ts —— 扩展 WorkspaceAdapter 接口与结果类型
2. 核心实现 —— src/workspace/files.ts（或新模块 file-ops.ts / git.ts）
3. src/workspace/adapter.ts —— LocalWorkspaceAdapter 透传
4. src/workspace/dsh-adapter.ts —— DshWorkspaceAdapter 经 dsh fs seam 映射
5. src/mcp/server.ts —— 按 capability 门控注册 + zod schema
6. tests/*.test.ts —— 紧邻现有套件的单测
7. npm run verify —— typecheck + vitest + build 保持绿

## 6. 风险与权衡

- 工具数量增长可能触碰部分厂商 connector 的隐性上限 → 保持增量最小化，分块读取合并进 read_file。
- 每个新工具都增加双适配器面与测试 → 维护成本随工具数线性增长。
- 分块读取 / 文件操作依赖 dsh adapter seam 能力（未验证）→ 先做前置门预检，不行就配置化回退。
- 图片内容以隐私换能力 → 默认关闭。

## 7. 待确认决策点

- 是否按 P0 → P1 → P2 顺序开工？P0 是否现在就做？
- dsh fs seam 是否暴露 rename 与部分 / 流式读取？（决定 file_ops / 分块读取的落地形态）
- 默认限制（120 rpm / 4 并发 / 512 KiB）是否要改为单用户可配置？
- apply_patch 是否要支持 rename，还是以独立 file_ops 为准？
