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
```

所有命令都支持 `--json`，便于 Agent 或 CI 读取结构化结果。
失败结果包含稳定的 `code` 字段，例如 `SCENARIO_FAILED`、
`PREFLIGHT_FAILED` 和 `CLEANUP_FAILED`。

`doctor` 用于检查 Node.js、Manifest、Adapter 和基础环境变量；需要浏览器时
可增加 `--browser` 检查 Playwright 是否可加载。

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
```

当前项目使用 Node.js 20 或更高版本。

CI 会在 Node.js 20、22 和 24 上执行测试。提交前建议运行：

```powershell
node src/cli.js doctor --json
npm test
```

## 许可证

MIT，详见 [LICENSE](LICENSE)。
