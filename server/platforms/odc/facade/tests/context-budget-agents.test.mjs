import './fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const root=new URL('../../../../',import.meta.url);
test('B7 root and ODC app instructions do not request tool enumeration/schema loading',()=>{
 for(const relative of ['AGENTS.md','platforms/odc/AGENTS.md']){
  const file=new URL(relative,root),text=fs.readFileSync(file,'utf8');
  assert.doesNotMatch(text,/ToolSearch|select:|ALL_TOOLS|(?:liste|carregue)\s+as\s+ferramentas|(?:list|load)\s+(?:all\s+)?the\s+tools/i,fileURLToPath(file));
 }
});
