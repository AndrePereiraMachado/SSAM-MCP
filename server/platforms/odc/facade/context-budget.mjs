// One context budget for every server profile, tool listing and output family.
export const SERVER_INSTRUCTIONS_MAX_CHARS = 2000;
export const TOOL_LISTING_BUDGET_BYTES = 2560;
export const TOOL_TEXT_BUDGET_BYTES = 1024;
export const ANSWER_CEILING_BYTES = 30720;
export const BUDGET_MARGIN_BYTES = 2048;
export const PACKET_DEFAULT_BYTES = 24576;
export const PACKET_MAX_BYTES = ANSWER_CEILING_BYTES - BUDGET_MARGIN_BYTES;
export const EXPANSION_DEFAULT_BYTES = PACKET_MAX_BYTES;
export const RECOVERY_PART_BYTES = EXPANSION_DEFAULT_BYTES - BUDGET_MARGIN_BYTES;
export const ANSWER_BUDGETS = Object.freeze({ discoverFirst: 5120, receipt: 2048, refusal: 8192, read: 1536, other: 4096, plan: 4096, packet: PACKET_DEFAULT_BYTES });
// Isolated tests may lower the ceiling through the environment, never raise it.
export const MAX_ANSWER_BYTES = ANSWER_CEILING_BYTES;
export const maxAnswerBytes = (env = process.env) => {
  const n = Number(env.SSAM_MAX_ANSWER_BYTES);
  return Number.isInteger(n) && n >= 4096 ? Math.min(n, ANSWER_CEILING_BYTES) : ANSWER_CEILING_BYTES;
};
export const budgetCeiling = (maxBytes = maxAnswerBytes()) => Math.max(4096, maxBytes - BUDGET_MARGIN_BYTES);
