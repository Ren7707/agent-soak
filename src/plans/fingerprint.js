import { createHash } from 'node:crypto';

export function planFingerprint(plan) {
  return createHash('sha256').update(JSON.stringify(canonicalize(approvalPayload(plan))), 'utf8').digest('hex');
}

function approvalPayload(plan) {
  const { status: _status, review_required: _reviewRequired, approved: _approved, approval: _approval, ...payload } = plan;
  return {
    ...payload,
    contracts: (payload.contracts || []).map(({ status: _contractStatus, review_required: _contractReviewRequired, approved: _contractApproved, ...contract }) => contract),
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}
