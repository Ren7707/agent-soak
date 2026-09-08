# 审核计划骨架生成设计

## 目标

为已完成人工审核的模型测试计划生成独立、可加载的 Adapter/Manifest 通用骨架，
作为后续人工补全平台动作和 Skill 化部署的安全中间层。

## 约束

- 只接受 `status: approved`、`review_required: false`、`approved: true` 的计划。
- 每个契约都必须通过同样的审核条件。
- 生成过程只读输入文件，不访问目标平台，不执行测试，不写入业务数据。
- 输出目录必须位于当前工作目录内，默认拒绝覆盖已有目录。
- 生成的 Adapter 场景只抛出未实现错误，不能伪造测试通过结果。
- 生成产物不携带源码路径、证据正文、URL、邮箱或敏感字段。

## 输出

`adapters/<id>/` 包含：

- `platform.manifest.json`：从计划场景生成的合法 Manifest，所有场景默认保留原模式。
- `adapter.js`：包含契约占位和统一的未实现错误。
- `contracts.json`：脱敏后的契约快照，便于人工补全 Adapter。
- `README.md`：中文接入说明和下一步审核清单。

## CLI

```powershell
node src/cli.js scaffold --input ./approved-plan.json --output ./adapters/demo --id demo --json
```

`--force` 仅允许覆盖生成器明确创建的目标目录，不改变测试写入授权逻辑。

## 验证

CLI 测试覆盖：未审核计划拒绝、审核计划生成文件、生成 Manifest 可加载、路径越界
拒绝、默认不覆盖，以及产物不包含输入中的企业 URL/邮箱/敏感字段。
