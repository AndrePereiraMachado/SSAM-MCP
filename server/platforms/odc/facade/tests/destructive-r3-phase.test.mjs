import './fixtures/isolated-profile.mjs';
// CX15 r3, F7 (M6 of review cx15-2): the contract of destructivePhase, the one function the join with the CX12 reads to
// classify a destructive call (preview = read, execute = write, refuse = read: nothing sent; null = the CX12 table
// decides). The table is fixtures/destructive-r3-phase-cases.mjs (pure data, reusable by the join's own test of
// classifyTool / STUDIO_WRITE_TOOLS); this suite checks it against destructive-operations.mjs and that it covers the whole
// inventory (DESTRUCTIVE_TOOLS, every verb, every destructive bridge command, every .NET whitespace).
// - The contract guard (every tool but the studio_command forms below) holds on ab1376b1 too: it pins what the join relies on.
// - The studio_command forms marked r3 (arguments in the first argument, separate arguments behind a blank or empty
//   command, another case, every char.IsWhiteSpace before or after the command, an invisible start) FAIL on ab1376b1:
//   destructivePhase compared the command exactly (CT-12), and the bridge, which trims as .NET does, would run them
//   (BYPASS-1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DESTRUCTIVE_TOOLS, DESTRUCTIVE_BRIDGE_COMMANDS, destructivePhase } from '../destructive-operations.mjs';
import { PHASE_CASES, NET_WHITESPACE, CLASS_OF_PHASE, phaseOptions, caseName } from './fixtures/destructive-r3-phase-cases.mjs';

const mismatches = cases => cases.map(c => ({ c, got: destructivePhase(c.tool, structuredClone(c.args), phaseOptions(c)) }))
  .filter(({ c, got }) => got !== c.phase).map(({ c, got }) => `${caseName(c)}, got ${got}`);

test('F7 contract guard: preview without confirmationToken (any form), execute with it, null for what is not destructive, for every tool of the inventory', () => {
  const guard = PHASE_CASES.filter(c => !c.r3);
  assert.ok(guard.length >= 120, String(guard.length));
  assert.deepEqual(mismatches(guard), []);
});

test('F7 / BYPASS-1, CT-12: studio_command is read as the bridge reads its line: separate or joined arguments, any case, every .NET whitespace around the command, an invisible start; refused, never null', () => {
  const r3 = PHASE_CASES.filter(c => c.r3);
  assert.ok(r3.length >= 300, String(r3.length));
  assert.deepEqual(mismatches(r3), []);
});

test('F7 coverage: the table covers every tool and verb of DESTRUCTIVE_TOOLS (preview and execute, or refuse), every destructive bridge command and every char.IsWhiteSpace', () => {
  const problems = [];
  const phases = (tool, pick = () => true) => new Set(PHASE_CASES.filter(c => c.tool === tool && pick(c)).map(c => c.phase));
  for (const entry of DESTRUCTIVE_TOOLS) {
    if (entry.refuse) {
      for (const cmd of entry.verbs) if (!phases(entry.tool, c => c.form.includes(cmd)).has('refuse')) problems.push(`${entry.tool} ${cmd}: no refuse case`);
      continue;
    }
    const all = phases(entry.tool);
    for (const p of ['preview', 'execute']) if (!all.has(p)) problems.push(`${entry.tool}: no ${p} case`);
    if (entry.verbs && entry.field && !entry.field.includes('.')) for (const v of entry.verbs) {
      const own = phases(entry.tool, c => c.args?.[entry.field] === v);
      for (const p of ['preview', 'execute']) if (!own.has(p)) problems.push(`${entry.tool} ${entry.field}=${v}: no ${p} case`);
    }
    // a tool with verbs has a non-destructive verb case; a tool whose effect is the catalog's has the predicate's three answers
    if (entry.verbs && !all.has(null)) problems.push(`${entry.tool}: no case of a verb that is not destructive`);
    if (entry.effect && !(PHASE_CASES.some(c => c.tool === entry.tool && c.destructive === false && c.phase === null) && PHASE_CASES.some(c => c.tool === entry.tool && c.destructive === undefined && c.phase === null)))
      problems.push(`${entry.tool}: no case of a predicate that says no, or of no predicate`);
  }
  // Every tool of the table is in the inventory or is a tool outside it (null only).
  const inventory = new Set(DESTRUCTIVE_TOOLS.map(e => e.tool));
  for (const c of PHASE_CASES) if (!inventory.has(c.tool) && c.phase !== null) problems.push(`${c.tool}: outside the inventory but ${c.phase}`);
  // Every destructive bridge command, before and after every .NET whitespace.
  assert.equal(NET_WHITESPACE.length, 25);
  for (const cmd of DESTRUCTIVE_BRIDGE_COMMANDS) for (const ws of NET_WHITESPACE) for (const args of [{ command: ws + cmd }, { command: cmd + ws }, { command: ws }]) {
    const found = PHASE_CASES.some(c => c.tool === 'studio_command' && c.args.command === args.command && (args.command !== ws || c.args.args?.[0] === cmd));
    if (!found) problems.push(`studio_command ${JSON.stringify(args)} (${cmd}): no case`);
  }
  assert.deepEqual(problems, []);
  // The classification the join derives from a phase.
  assert.deepEqual(CLASS_OF_PHASE, { preview: 'read', execute: 'write', refuse: 'read' });
  for (const c of PHASE_CASES) assert.ok(c.phase === null || CLASS_OF_PHASE[c.phase], caseName(c));
});

test('F7: destructivePhase never changes its arguments and answers the same twice (the join may call it before the handler)', () => {
  for (const c of PHASE_CASES.filter((_, i) => i % 7 === 0)) {
    const args = structuredClone(c.args);
    const first = destructivePhase(c.tool, args, phaseOptions(c));
    assert.deepEqual(args, c.args, caseName(c));
    assert.equal(destructivePhase(c.tool, args, phaseOptions(c)), first, caseName(c));
  }
});
