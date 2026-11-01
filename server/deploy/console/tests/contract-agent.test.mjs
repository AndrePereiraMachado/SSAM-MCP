// F2 of REVISAO-AGENTE-R4 (box only, never skips): the ssam-quality/1 contract names the agent's verbs (ODC_COMMANDS,
// O11_METHODS) as the closed lists the customer's agent enforces, and the hub refuses a bridge that needs a command the agent does
// not run (bridge-store.mjs AGENT_NEEDS). The line's drift test looks for agent/lib/kinds.mjs at its own root, which the box does
// not have (here it is agent/agent/lib/kinds.mjs), so in the box it skipped; and a copy of the line's contract (A3) whose
// ODC_COMMANDS lacks reconcile-merge would erase it unseen. Here: both box copies of the contract (writer and console) equal the
// agent box's lists and carry every command AGENT_NEEDS names. A box without agent/ fails, it never skips.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {AGENT_NEEDS} from '../../../platforms/odc/facade/bridge-store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.resolve(here, '..', '..', '..');
const KINDS = path.join(server, '..', 'agent', 'agent', 'lib', 'kinds.mjs');
const CONTRACTS = ['platforms/odc/facade/quality-line.mjs', 'deploy/console/quality-line.mjs'];

test('the contract (writer and console) lists the agent box\'s own ODC commands and O11 methods, every command AGENT_NEEDS names among them', async () => {
  assert.ok(fs.existsSync(KINDS), 'the agent box (agent/agent/lib/kinds.mjs) is part of this box: ' + KINDS);
  const kinds = await import(pathToFileURL(KINDS).href);
  const needed = AGENT_NEEDS.flatMap(n => n.commands);
  assert.ok(needed.includes('reconcile-merge'));
  for (const rel of CONTRACTS) {
    const contract = await import(pathToFileURL(path.join(server, rel)).href);
    for (const command of needed) assert.ok(contract.ODC_COMMANDS.includes(command), rel + ' lacks ' + command + ', which AGENT_NEEDS names');
    assert.deepEqual([...contract.ODC_COMMANDS], [...kinds.ODC_COMMANDS], rel + ': ODC_COMMANDS is not the agent\'s list');
    assert.deepEqual([...contract.O11_METHODS], [...kinds.O11_METHODS], rel + ': O11_METHODS is not the agent\'s list');
  }
});
