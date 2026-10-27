import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_LISTING } from '../tool-listing.mjs';
import { PACKET_DEFAULT_BYTES } from '../context-budget.mjs';

test('A7 compact discover listing states packet default, maximum and MCP clamp',()=>{
  const entry=TOOL_LISTING.ssam_discover;
  assert.match(entry.description,new RegExp('packet.*default '+PACKET_DEFAULT_BYTES,'i'));
  assert.match(entry.description,/28672/);
  assert.match(entry.description,/clamp/i);
  assert.match(entry.params['/properties/budgetBytes'],new RegExp('packet default '+PACKET_DEFAULT_BYTES));
  assert.match(entry.params['/properties/budgetBytes'],/28672/);
});
