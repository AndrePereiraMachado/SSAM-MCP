import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_LISTING } from '../tool-listing.mjs';

test('A7 compact discover listing states packet default, maximum and MCP clamp',()=>{
  const entry=TOOL_LISTING.ssam_discover;
  assert.match(entry.description,/packet.*8192/i);
  assert.match(entry.description,/28672/);
  assert.match(entry.description,/clamp/i);
  assert.match(entry.params['/properties/budgetBytes'],/8192/);
  assert.match(entry.params['/properties/budgetBytes'],/28672/);
});
