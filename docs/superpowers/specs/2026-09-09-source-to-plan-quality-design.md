# 源码到高质量测试计划设计

日期：2026-09-09

实现状态：已实现第一版计划质量门禁，后续可继续扩展源码操作、关系和生命周期证据识别。

## 目标

强化 `agent-soak` 从授权源码和结构化接口证据生成测试计划的协议质量，确保任意外部大模型读取仓库后，都能生成足够具体、可执行、可审计的测试计划。

本阶段不接入模型 API。模型仍在框架外运行；框架只负责定义输入输出协议、校验计划、计算覆盖质量、阻止不完整计划进入审批和 Adapter 骨架生成。

## 现状问题

当前计划场景主要包含 ID、模式、契约和标签，能够表达“测试什么”，但不能充分表达：

- 操作对象和业务操作；
- 前置状态；
- API、浏览器或 CLI 执行步骤；
- 请求后观察点；
- 业务断言；
- 资源登记和清理；
- 证据覆盖和风险覆盖；
- 未解决的不确定性。

源码分析也主要提供字段级证据，尚未稳定输出操作、关系、生命周期和验证器的结构化候选。

## 设计边界

### 外部模型与框架边界

外部大模型负责：

- 阅读目标仓库和本框架文档；
- 结合源码证据理解实体、操作和业务规则；
- 生成候选契约和测试计划；
- 根据质量报告补齐测试覆盖。

框架负责：

- 校验结构和证据引用；
- 计算计划覆盖质量；
- 检查执行步骤、观察点、断言和清理完整性；
- 保持草稿、审批和执行状态边界；
- 防止未经审核的猜测升级为确定规则。

框架不调用模型 API，也不把模型推断直接当作产品事实。

### 计划状态边界

- `draft`：允许不完整，但必须生成缺口、风险和覆盖提示。
- `approved`：必须通过质量门禁，未解决的关键缺口或冲突会拒绝审批。
- `scaffold`：只接受已审批且质量合格的计划。
- `run`：只执行 Adapter 已实现的动作；证据不足的语义结论只能是 `semantic_suspect` 或 `inconclusive`。

## 计划协议扩展

测试计划场景增加以下可选结构：

```json
{
  "id": "register-device",
  "mode": "write",
  "operation": "create",
  "target": "device",
  "preconditions": [],
  "steps": [
    {
      "id": "submit",
      "action": "submit",
      "transport": "api",
      "input_ref": "device-platform-cases"
    },
    {
      "id": "observe-detail",
      "action": "observe",
      "observation": "resource_detail"
    },
    {
      "id": "cleanup",
      "action": "cleanup",
      "action_ref": "delete_created_resource"
    }
  ],
  "assertions": [
    "accepted_matches_contract",
    "resource_created_matches_contract",
    "detail_matches_input",
    "cleanup_completed"
  ],
  "coverage": {
    "evidence_refs": [],
    "risk_types": ["nearby_semantic", "wrong_type", "missing", "normalization", "duplicate"]
  },
  "review": {
    "required": true,
    "reasons": []
  }
}
```

字段约束：

- `operation` 表示业务操作，例如 `create`、`read`、`update`、`delete`、`transition`、`search`、`authenticate`；
- `target` 表示实体或资源；
- `preconditions` 是可审阅的前置状态声明；
- `steps` 至少描述一个真实动作；写入场景必须包含清理步骤或明确声明不产生资源；
- `assertions` 必须描述用户可观察或资源可查询的结果；
- `coverage` 绑定证据和风险类型；
- `review.reasons` 保存不确定性和缺口，不允许静默丢弃。

步骤支持 `api`、`browser`、`cli`、`adapter` 和 `observation` 等 transport，但框架不解释平台专用动作。Adapter 负责把计划步骤实现为具体操作。

## 源码证据质量

源码分析继续保持只读和脱敏，并在已有字段证据之外增加可识别的候选元数据：

- `entity`：实体名称；
- `operation`：从路由、HTTP 方法、按钮和动作命名中识别的操作；
- `relation`：父子资源、字段关联或状态依赖；
- `lifecycle_state`：状态值和状态转换线索；
- `validation_rule`：必填、枚举、格式、唯一性和范围线索；
- `source_kind`：前端、后端校验器、OpenAPI、运行时或普通源码。

识别不到时不填充猜测值，而是保留 `confidence` 和缺口信息。

## 质量检查

新增确定性计划质量检查，输出：

- `status`: `pass`、`review_required` 或 `blocked`；
- `score`: 0 到 100；
- `issues`: 缺少步骤、观察、断言、清理、证据或风险覆盖的条目；
- `coverage`: 已覆盖和未覆盖的证据、实体、操作和风险类型；
- `blocking`: 审批或 scaffold 是否必须拒绝。

默认规则：

- 草稿计划只报告问题，不阻止 `plan` 命令输出；
- 审批计划必须通过阻断级检查；
- `approve` 和 `scaffold` 使用同一套质量计算，避免前后标准不一致；
- 只读场景不能包含写入动作；
- 写入场景必须声明清理策略，除非显式声明 `creates_resources: false`；
- 关键实体的创建、更新或删除场景必须有观察点和结果断言；
- 每个契约必须被至少一个场景引用；
- 每个场景必须有至少一个证据引用或明确标记为人工补充；
- 未解决冲突必须对应 `review.reasons`，不能只存在于报告外部。

## 兼容性

旧版计划仍可被读取和规范化，但缺少新字段的计划会：

- 在 `plan` 命令中标记为不完整；
- 不能通过审批质量门禁；
- 不能进入 `scaffold`；
- 不影响已有已审批计划的运行和历史结果读取。

## 测试与文档

本阶段增加：

- 计划 Schema 和运行时校验测试；
- 草稿质量报告测试；
- 不完整审批计划拒绝测试；
- 不完整 scaffold 拒绝测试；
- 完整 Demo 计划的正向质量回归；
- README、Adapter 模板和架构设计文档的中文说明。

验收标准：

1. 外部模型可以根据 Schema 生成包含步骤、观察、断言、清理和覆盖信息的计划。
2. 计划缺少关键内容时，框架能给出稳定、机器可读的缺口。
3. 草稿可以保存和继续修订，但不完整计划不能审批或 scaffold。
4. 任意语义契约都能追溯到源码证据或明确的人工补充标记。
5. 设备平台示例能覆盖合法值、邻近语义值、错误类型、缺失、规范化和重复风险。
6. 不接入任何模型 API，不引入企业代码、企业 URL、账号或客户数据。
