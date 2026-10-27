// R2 (docs/PLANO-PRIMEIRA-CERTA-E-VELOCIDADE-2026-10-24.md "R2"): the schema words of the ssam_code draft, kept apart from
// code-draft.mjs so ssam-code.mjs imports them without importing the draft's engine (which imports ssam-code.mjs).
// The listing of ssam_code is a reviewed projection (tool-listing.mjs TOOL_LISTING, its sourceSha256 over the description and
// the parameter texts it names): the draft adds two verbs to the action enum and one parameter of its own, whose original text
// is the whole contract and whose served text is the one-line flow; no other reviewed text changes.

export const DRAFT_ACTIONS = Object.freeze(['draft', 'part']);
export const DRAFT_ID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
export const DRAFT_TEXT = 'draft {module}; part {draft,part,text} checks; write {draft} delivers.';   // shortened for the listing budget (integ/proto-into-product)
// The whole contract, the original text of the draft parameter (ssam_reference {kind:"tool", query:"ssam_code"} serves it);
// the listing serves DRAFT_TEXT (tool-listing.mjs TOOL_LISTING, reviewed against this text). It states no rule kind the short
// text does not carry (tool-listing-guard.mjs RULE_KINDS), so the projection loses none.
export const DRAFT_CONTRACT = 'Incremental write, in three calls. '
  + '1) action draft {module} opens a draft of that module: draft.id, valid 30 min after its last part (each part renews it), '
  + 'kept on disk across a reconnection and bound to this client. '
  + '2) action part {draft, part, text|files|ops|edits, basedOn?, element?, removes?} adds one action, screen, block, data text or list of ops '
  + '(a text with several actions or documents is one part each). It is checked at once: the composition of a write, then a check '
  + 'against the local capture together with the parts accepted so far, so it may call what another part creates. The answer: '
  + 'accepted, problems with their fix, and the summary {parts, accepted, pending}. A part sent again under the same name takes the '
  + 'place of the earlier one; element alone (a name or part id) takes a part out. '
  + '3) action write {draft}, with the options of a write (publish, until...), delivers every part in ONE delivery, in the order a '
  + 'write composes (ops, data, documents, actions, screen edits); with a part still pending it answers at once with the list and '
  + 'delivers nothing. 3 s after the last part the whole set is checked in the background and the write reuses that check. '
  + 'action draft {draft}: the parts, their pending problems and the ready write. A delivered draft is closed; after a delivery that '
  + 'did not pass it stays open for parts, or for a patch in a write without draft.';

/** Adds the draft verbs and the draft parameter to the ssam_code input schema (in place). */
export function extendDraftSchema(schema) {
  const action = schema.properties.action;
  action.enum = [...action.enum, ...DRAFT_ACTIONS.filter(a => !action.enum.includes(a))];
  // The id's form is checked by the draft itself (code-draft.mjs DRAFT_ID): no pattern in the listing.
  schema.properties.draft = { type: 'string', description: DRAFT_CONTRACT };
  return schema;
}

/** Whether a ssam_code call is the draft's: draft (open or status), part, the write of a draft (any other action with a draft is refused there). */
export const isDraftCall = input => DRAFT_ACTIONS.includes(input?.action) || input?.draft != null;
