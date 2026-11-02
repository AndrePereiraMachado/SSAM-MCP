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
// C-19: grammar, the ssam_code grammar card (8-14 KB per part, ~29 KB for every part), inline up to the packet's ceiling: as
// "other" (4 KB) the Figma runs of 27/10 got only ssam_evidence pointers and spent a call per part to read it.
export const ANSWER_BUDGETS = Object.freeze({ discoverFirst: 5120, receipt: 2048, refusal: 8192, read: 1536, other: 4096, plan: 4096, packet: PACKET_DEFAULT_BYTES, grammar: PACKET_MAX_BYTES });
// Isolated tests may lower the ceiling through the environment, never raise it.
export const MAX_ANSWER_BYTES = ANSWER_CEILING_BYTES;
export const maxAnswerBytes = (env = process.env) => {
  const n = Number(env.SSAM_MAX_ANSWER_BYTES);
  return Number.isInteger(n) && n >= 4096 ? Math.min(n, ANSWER_CEILING_BYTES) : ANSWER_CEILING_BYTES;
};
export const budgetCeiling = (maxBytes = maxAnswerBytes()) => Math.max(4096, maxBytes - BUDGET_MARGIN_BYTES);
// The client's cut (BankDash scenario, 2026-10-28): Claude Code keeps an error result of more than 10000 characters as its
// first and last 5000, so the middle of a long refusal (its problems) never reached the model.
export const CLIENT_CUT_CHARACTERS = 10000;
// The one place of the visible ceiling (answer-size.mjs fitAnswer): a refusal, and the content lists
// (messages, problems, errors, warnings) of any answer, end at most here, below the client's cut with room for its marker.
// Isolated tests and an operator may lower it through the environment, never raise it.
export const VISIBLE_ANSWER_BYTES = 9216;
export const visibleAnswerBytes = (env = process.env) => {
  const n = Number(env.SSAM_VISIBLE_ANSWER_BYTES);
  return Number.isInteger(n) && n >= 2048 ? Math.min(n, VISIBLE_ANSWER_BYTES) : VISIBLE_ANSWER_BYTES;
};
// A value this small (or any number, boolean or null) is never moved out of an answer: its pointer would cost more than it.
export const POINTER_FLOOR_BYTES = 256;
