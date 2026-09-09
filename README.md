# agent-soak

面向 CLI 工具和 Web Agent 的通用长测自动化框架。

本项目是独立的个人开源项目，通过 Manifest 和平台 Adapter 提供安全的
预检查、重复场景执行、运行级测试数据、清理恢复、浏览器监督和结构化报告。

## 快速开始

安装依赖并启动本地 Demo 平台：

```powershell
npm install
$env:DEMO_PLATFORM_BASE_URL = "http://127.0.0.1:4317"
node examples/demo-platform/server.js
```

另开一个终端运行测试：

```powershell
node src/cli.js inspect --json
node src/cli.js validate --mode readonly --json
node src/cli.js run --rounds 3 --mode readonly --json
$env:ALLOW_TEST_WRITES = "true"
node src/cli.js run --rounds 2 --mode write --allow-writes --json
node src/cli.js residue --json
node src/cli.js doctor --json
node src/cli.js --version --json
node src/cli.js analyze --source ./src --output ./artifacts/source-analysis.json --json
node src/cli.js conflicts --analysis ./artifacts/source-analysis.json --output ./artifacts/conflicts.json --json
node src/cli.js contract --analysis ./artifacts/source-analysis.json --output ./artifacts/contracts.json --json
node src/cli.js plan --input ./artifacts/model-plan.json --evidence ./artifacts/source-analysis.json --output ./artifacts/draft-plan.json --json
node src/cli.js approve --input ./artifacts/draft-plan.json --conflicts ./artifacts/conflicts.json --output ./artifacts/approved-plan.json --reviewer owner --reason "已完成规则审核" --json
node src/cli.js scaffold --input ./artifacts/approved-plan.json --output ./adapters/personal-demo --id personal-demo --json
```

测试报告写入 `artifacts/<run-id>/`，包括 JSON、Markdown、JUnit XML 和 HTML。

## 核心能力

- 默认只读，写入需要 CLI 参数和环境变量双重授权
- 按轮数或持续时间运行，并支持安全中止
- 场景级超时和有限重试，结果记录实际尝试次数
- Playwright Chromium 浏览器测试和可视监督模式
- 运行级测试数据前缀、资源登记、清理和失败恢复
- `cleanup-pending.json` 残留记录和本地/远程残留扫描
- 产品、脚本、环境、权限和清理问题分类
- JSON、Markdown、JUnit XML、HTML 报告
- Manifest 自动校验和 YAML 支持
- 通过 `init-adapter` 快速创建平台适配器模板
- 从已审核模型计划生成不连接目标平台的 Adapter/Manifest 安全骨架
- 支持规则版本、套件/标签筛选、场景优先级和历史运行差异比较
- 规则来源冲突和语义边界歧义审查
- 多行枚举、表单文案、校验器和接口 Schema 的来源证据识别
- 结构化 OpenAPI / Swagger / JSON Schema 的字段级证据提取（枚举、描述、必填和 Schema 路径）
- 候选契约的字段级证据摘要传递和元数据冲突审查
- 带审核人、理由和时间记录的测试计划审批流程
- 基于字段语义的邻近值、规范化、缺失和业务结果契约测试
- 运行时请求/响应、页面、资源、断言和清理证据链

## 平台接入

平台通过 `platform.manifest.json` 或 `platform.manifest.yaml` 描述自身能力，
再通过 Adapter 实现平台专用逻辑。登录方式、路由、定位器、资源状态机和
删除流程都应放在 Adapter 中，不应放入框架核心。

创建适配器模板：

```powershell
node src/cli.js init-adapter <平台ID>
```

模板会创建以下文件：

```text
adapters/<平台ID>/
  platform.manifest.yaml
  adapter.js
  .env.example
  README.md
```

适配器需要提供：

- `preflight`
- `discover`
- `scenarios`
- `deleteResource`
- 可选的 `scanResidue`
- 可选的 `observe`，用于在操作后读取权威业务状态
- 可选的 `runSequence`，用于执行重复提交、生命周期和关系场景

Adapter 的公开 TypeScript 类型位于 `types/index.d.ts`。即使适配器使用
JavaScript，也可以通过编辑器类型提示获得 Manifest、场景和资源上下文。

## 语义契约测试

普通场景只能证明“操作完成”。对于真实产品，还需要验证字段含义和操作
后的业务状态。Adapter 场景可以声明 `contract`，框架会生成合法值、
邻近语义值、大小写/空白变体和缺失值，并把每个样本通过 `testCase` 传给
场景执行函数。

```js
{
  id: 'register-device',
  contract: {
    fields: [{
      path: 'platform',
      semantic_type: 'operating_system_platform',
      examples: ['windows', 'macos', 'linux'],
      negative_examples: ['test computer 0001', 'office workstation'],
      policy: { normalize_case: true, trim_whitespace: true }
    }]
  },
  async run({ testCase }) {
    const response = await registerDevice(testCase.input);
    return {
      accepted: response.ok,
      resourceCreated: Boolean(response.body?.id),
      resource: response.body
    };
  }
}
```

场景返回的 `accepted` 和 `resourceCreated` 会与契约预期比较。若证据表明
字段是操作系统平台，但设备名称一类的值仍被接受并持久化，报告会标记为
`confirmed_bug` / `semantic_constraint_missing`，而不是只报告注册流程成功。
如果产品明确允许任意自定义平台名称，应在契约中将其建模为合法策略，避免
把合理的业务行为误报为缺陷。

契约测试也适用于邮箱、状态、版本、日期、金额、权限、资源关系、生命周期
和幂等性等问题。大模型可以从源码和页面生成候选契约，但最终结论仍由
确定性断言、运行状态和脱敏证据共同决定。

框架内置通用语义风险库。启用字段策略中的 `generate_risk_cases`、
`reject_unclassified_value` 或 `allowed_values` 后，会自动补充邻近语义值和
明显错误类型值，例如把设备名称填入平台字段、把日期填入状态字段。风险库
只生成测试样本，不替产品定义规则；`known_only` 等策略必须由适配器或人工
审核确认。源码扫描和模型生成的契约默认为 `draft`，其失败结果只标记为
`semantic_suspect`，只有审核后的契约才允许报告 `confirmed_bug`。

契约结构可使用仓库根目录的 `contract.schema.json` 进行 JSON Schema 校验。
契约还可以声明 `invariants` 业务不变量，以及 `lifecycle`、`relationship`、
`duplicate` 类型的场景案例；这些声明用于约束后续生成器和 Adapter 的执行，
不会绕过现有写入授权和清理边界。

不变量支持 `equals`、`not_equals`、`in`、`before` 和 `state_transition`。
字段路径使用点号访问 Adapter 返回的观察结果，例如 `resource.ownerId`；
不变量违规会进入确定性证据链并归类为 `state_transition_violation`。

当案例包含至少两个 `sequence` 步骤时，Runner 会优先调用 Adapter 的
`runSequence`；没有该钩子时仍回退到普通 `run`，保证旧 Adapter 兼容。

字段策略 `idempotent: true` 会生成“相同请求重复提交”的幂等案例，预期是
重复请求可接受但不得创建重复资源；`unique: true` 则预期重复请求被拒绝。
契约的 `lifecycle` 可以声明状态集合、合法转换和禁止转换，框架会自动生成
禁止转换案例交给 `runSequence` 执行。

契约场景应返回可观察结果，例如 `accepted`、`resourceCreated`、`resource`
或领域自定义状态字段。框架不会把 HTTP 2xx 自动当作业务成功；Adapter
需要把接口、页面和资源状态转换成这些可断言的观察值。

### 运行时观测

Adapter 可以使用 `observer.fetch()` 代替全局 `fetch`，框架会记录脱敏后的
请求、响应状态、响应摘要和耗时；也可以使用 `recordPage`、`recordResource`、
`recordAssertion` 等接口记录页面状态、资源状态和业务断言。实现可选的
`observe` 钩子后，Runner 会在场景动作完成后再次读取平台状态，并把钩子返回
的权威字段合并到契约断言中。这样 HTTP 2xx 或按钮操作完成不会自动等同于
业务成功。

每轮产物包含 `observations.json`，场景结果包含 `observation_refs`。报告和
复现分析可以从结论回溯到请求、响应、页面回显、资源登记和清理结果；敏感
字段、Bearer 值和过长内容会自动脱敏或截断。

参考 [适配器模板](templates/adapter.md) 和
[架构设计](docs/design/2026-09-03-universal-soak-framework.md)。

## 常用命令

```text
agent-soak inspect
agent-soak init-adapter <平台ID>
agent-soak discover
agent-soak validate --mode readonly
agent-soak run --rounds 10
agent-soak run --duration 10m
agent-soak cleanup --run-id <run-id> --dry-run
agent-soak residue --json
agent-soak analyze --source <授权源码目录> --json
agent-soak conflicts --analysis <源码分析> --output <冲突报告> --json
agent-soak plan --input <模型计划> --evidence <源码证据> --output <草稿计划> --json
agent-soak approve --input <草稿计划> --conflicts <冲突报告> --output <已审核计划> --reviewer <审核人> --reason <审核理由> --json
agent-soak scaffold --input <已审核计划> --output <适配器目录> --id <平台ID> --json
agent-soak compare --baseline <旧 run.json> --current <新 run.json> --json
```

所有命令都支持 `--json`，便于 Agent 或 CI 读取结构化结果。
失败结果包含稳定的 `code` 字段，例如 `SCENARIO_FAILED`、
`PREFLIGHT_FAILED` 和 `CLEANUP_FAILED`。

`doctor` 用于检查 Node.js、Manifest、Adapter 和基础环境变量；需要浏览器时
可增加 `--browser` 检查 Playwright 是否可加载。

analyze 是只读的源码证据扫描命令。它只扫描明确指定的目录，输出字段
引用、源码行号、观察到的枚举值和候选语义类型，供人工审阅或后续大模型
生成契约使用。候选规则不是最终产品规则，不会直接改变测试结果。`contract`
命令只接受带有效 `evidence_refs` 的分析结果，并生成需要人工审阅的草稿，
不会把模型或扫描器的猜测直接升级为确定缺陷。

`conflicts` 是只读的规则冲突审查命令。它会保留前端、后端校验器、接口契约、
运行观测和模型推断之间的差异，输出 `semantic_boundary_ambiguous` 和
`review_required`，不会静默选择某一方，也不会把冲突直接报告为确定缺陷。
规则来源优先级只用于排序和人工审查提示，不能替代产品规则确认。

源码分析会读取有限的相邻源码行来识别跨行枚举，并根据路径和上下文标记
`frontend`、`backend_validator`、`openapi`、`runtime` 或普通 `source`。对于结构化
OpenAPI / Swagger / JSON Schema 文件，分析器只提取字段级最小证据：字段、语义类型、
枚举、描述摘要、是否必填、Schema 路径和行号，不输出完整 Schema、请求示例或敏感内容。
这些标记只是证据来源分类，不代表框架已经选定产品规则；不同来源的值集合仍会进入
`conflicts` 审查。

契约合成会把来源证据中的描述、必填状态、Schema 类型、Schema 路径、文件和行号
压缩为 `evidence_summary`，供模型和审核人复核；不会把完整源码、请求示例或证据正文
复制到契约。若前端、后端校验器或 OpenAPI 对同一字段的必填状态或描述不一致，分析结果
会保留各来源观察值，并以 `semantic_metadata_conflict` 标记为待审核，不会静默覆盖。

`approve` 只接受由框架生成的草稿计划，并要求明确提供审核人和理由。存在未解决
的规则冲突时默认拒绝审批；只有显式使用 `--allow-ambiguous` 才能记录为已知的
冲突决策。若契约自身包含冲突，审批还必须提供冲突报告，并且报告必须按字段匹配
对应的待审核项，避免只凭计划内嵌标记或无关报告完成审批。审批结果会保存
`approval.reviewer`、`approval.reason`、`approval.approved_at`、冲突字段、冲突类别和
冲突覆盖标记，供后续 `scaffold` 使用。

模型生成的测试计划应符合根目录的 `test-plan.schema.json`，并可通过
`src/plans` 的 `validateModelPlan` 校验证据和契约引用。框架提供
`normalizeModelPlan` 将模型输出固定降级为 `draft`、`review_required: true`、
`approved: false`；模型不能直接确认缺陷、授权写入或跳过现有安全门。
计划 Schema 与运行时校验同步覆盖场景的 `capabilities`、`suite`、`tags`、`priority`
以及审批记录；已审批计划必须包含审核人、理由、时间、冲突字段和冲突类别，避免
产物可以被部分工具接受、却无法被后续 CI 或 Skill 校验。审批还会绑定规范化计划和
冲突报告的 SHA-256 指纹，`scaffold` 会重新计算计划指纹，发现审批后内容被篡改时拒绝生成。

`scaffold` 只接受人工审核后的计划（计划和每个契约都必须是
`status: approved`、`review_required: false`、`approved: true`），生成通用
Manifest、契约快照、中文说明和未实现的 Adapter 占位。它不会访问目标平台，
不会执行测试，也不会伪造成功结果；生成内容会移除来源证据、私有路径、URL、
邮箱和敏感字段。输出目录默认不能覆盖已有目录，且必须位于当前工作目录内。

场景可在 Manifest 中设置 `suite`、`tags` 和 `priority`，运行时使用
`--suite` 或 `--tag` 只执行匹配场景；不指定筛选条件时行为不变。顶层
`ruleset_version` 会随运行结果保存，便于确认规则变化。`compare` 只读取两个
本地 `run.json`，按场景和案例比较状态，报告新增、删除、回归和修复，不会重新
执行测试或修改产物。

## 安全边界

- 只读是默认模式
- 写场景必须同时使用 `--allow-writes` 和 Manifest 指定的环境变量
- 生产环境 Manifest 默认拒绝写入
- 只清理当前运行登记且匹配测试前缀的资源
- 清理失败会使运行失败，并生成待恢复记录
- 密钥只从环境变量读取，报告会自动脱敏
- 建议先使用 `cleanup --dry-run` 检查待清理资源

## 隐私说明

本仓库是独立的个人项目，仅包含通用框架代码、本地 Demo、虚构数据和测试。
不应提交企业源码、私有 URL、账号、Token、客户数据、内部 API 契约、截图、
Trace 或生产报告。

## 开发与验证

```powershell
npm test
npm run check
```

当前项目使用 Node.js 20 或更高版本。

CI 会在 Node.js 20、22 和 24 上执行测试。提交前建议运行：

```powershell
node src/cli.js doctor --json
npm test
```

## 许可证

MIT，详见 [LICENSE](LICENSE)。
