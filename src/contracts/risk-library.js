const PROFILES = {
  operating_system_platform: {
    nearby_semantic: [
      { value: 'test computer 0001', reason: '设备名称而不是操作系统平台' },
      { value: 'office workstation', reason: '设备用途而不是操作系统平台' },
      { value: 'build server', reason: '设备角色而不是操作系统平台' },
    ],
    wrong_type: [
      { value: 20260907, reason: '日期值不属于操作系统平台' },
      { value: true, reason: '布尔值不属于操作系统平台' },
    ],
  },
  email_address: {
    nearby_semantic: [
      { value: 'alice at example dot com', reason: '自然语言邮箱表达' },
      { value: 'alice@example', reason: '缺少完整域名的标识' },
      { value: 'user_001', reason: '用户名而不是邮箱地址' },
    ],
    wrong_type: [
      { value: 123456, reason: '数字值不属于邮箱地址' },
      { value: true, reason: '布尔值不属于邮箱地址' },
    ],
  },
  lifecycle_status: {
    nearby_semantic: [
      { value: 'draft notes', reason: '描述文本而不是生命周期状态' },
      { value: 'ready for review', reason: '工作流说明而不是稳定状态值' },
      { value: '2026-09-07', reason: '日期值而不是生命周期状态' },
    ],
    wrong_type: [
      { value: 1, reason: '数字值不属于生命周期状态' },
      { value: true, reason: '布尔值不属于生命周期状态' },
    ],
  },
  software_version: {
    nearby_semantic: [
      { value: 'linux', reason: '操作系统平台而不是软件版本' },
      { value: 'release candidate', reason: '发布阶段描述而不是版本标识' },
      { value: '2026-09-07', reason: '日期值而不是软件版本' },
    ],
    wrong_type: [
      { value: true, reason: '布尔值不属于软件版本' },
      { value: { major: 1, minor: 0 }, reason: '未声明的对象结构不属于版本字符串' },
    ],
  },
  currency_amount: {
    nearby_semantic: [
      { value: 'ten dollars', reason: '自然语言金额表达' },
      { value: '50%', reason: '比例值而不是金额' },
      { value: '2026-09-07', reason: '日期值而不是金额' },
    ],
    wrong_type: [
      { value: true, reason: '布尔值不属于金额' },
      { value: { amount: 10 }, reason: '未声明的对象结构不属于金额' },
    ],
  },
  quantity: {
    nearby_semantic: [
      { value: 'ten units', reason: '自然语言数量表达' },
      { value: '50%', reason: '比例值而不是数量' },
      { value: '2026-09-07', reason: '日期值而不是数量' },
    ],
    wrong_type: [
      { value: true, reason: '布尔值不属于数量' },
      { value: { count: 10 }, reason: '未声明的对象结构不属于数量' },
    ],
  },
  time_zone: {
    nearby_semantic: [
      { value: 'Pacific office', reason: '地点描述而不是时区标识' },
      { value: 'UTC+999', reason: '超出有效范围的时区标识' },
      { value: 'America', reason: '不完整的时区标识' },
    ],
    wrong_type: [
      { value: 8, reason: '数字值不属于时区标识' },
      { value: true, reason: '布尔值不属于时区标识' },
    ],
  },
};

export const SEMANTIC_RISK_PROFILES = Object.freeze(PROFILES);

export function getRiskProfile(semanticType) {
  const profile = PROFILES[String(semanticType || '')];
  if (!profile) return undefined;
  return {
    nearby_semantic: profile.nearby_semantic.map((sample) => ({ ...sample })),
    wrong_type: profile.wrong_type.map((sample) => ({ ...sample })),
  };
}

export function generateRiskCases(field = {}) {
  const policy = field.policy || {};
  const profile = getRiskProfile(field.semantic_type);
  if (!profile || !shouldGenerate(policy)) return [];

  const expected = policy.risk_expected || { accepted: false, resourceCreated: false };
  const existing = new Set([
    ...(field.examples || []).map((value) => stableValue(value)),
    ...(field.negative_examples || []).map((value) => stableValue(value)),
  ]);
  const cases = [];
  for (const kind of ['nearby_semantic', 'wrong_type']) {
    for (const sample of profile[kind]) {
      const valueKey = stableValue(sample.value);
      if (existing.has(valueKey)) continue;
      existing.add(valueKey);
      cases.push({
        id: `${field.path}-${kind}-risk-${cases.length + 1}`,
        kind,
        input: { [field.path]: sample.value },
        expected: { ...expected },
        description: sample.reason,
      });
    }
  }
  return cases;
}

function shouldGenerate(policy) {
  return policy.generate_risk_cases === true
    || policy.reject_unclassified_value === true
    || ['known_only', 'known_or_explicit_custom'].includes(policy.allowed_values);
}

function stableValue(value) {
  if (value === undefined) return 'undefined';
  try { return JSON.stringify(value); } catch { return String(value); }
}
