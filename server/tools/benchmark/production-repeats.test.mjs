import '../../platforms/odc/facade/tests/fixtures/isolated-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeFiles } from './analyze.mjs';

const at = second => `2026-01-01T00:00:${String(second).padStart(2, '0')}Z`;
const query = (id, second, { sessionId = 'S-new', agentId, isSidechain = false } = {}) => [
  { type: 'assistant', sessionId, agentId, isSidechain, timestamp: at(second), message: { id: 'message-' + id, content: [{ type: 'tool_use', id, name: 'mcp__ssam__ssam_reference', input: { kind: 'rules', query: 'all' } }] } },
  { type: 'user', sessionId, agentId, isSidechain, timestamp: at(second + 1), message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(1000) }] } },
];
for (const scenario of ['post-resume main and child', 'history repeated by child', 'inline child copy']) {
  test(`analyzeFiles Claude resume: ${scenario}`, t => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'benchmark-production-resume-'));
    try {
      const file = path.join(temporary, 'S-new.jsonl');
      const childFile = path.join(temporary, 'S-new', 'subagents', 'agent-a1.jsonl');
      const child = query('child-call', 6, { agentId: 'a1', isSidechain: true });
      const rows = [
        { type: 'user', sessionId: 'S-old', timestamp: at(0), message: { content: 'Synthetic historical request' } },
        ...(scenario === 'history repeated by child' ? query('main-call', 1, { sessionId: 'S-old' }) : []),
        { type: 'user', sessionId: 'S-new', timestamp: at(3), message: { content: 'Synthetic resumed request' } },
        ...(scenario !== 'history repeated by child' ? query('main-call', 4) : []),
        ...(scenario === 'inline child copy' ? child : []),
        { type: 'assistant', sessionId: 'S-new', timestamp: at(9), message: { id: 'done', content: [{ type: 'text', text: 'Completed synthetic request' }] } },
      ];
      fs.mkdirSync(path.dirname(childFile), { recursive: true });
      fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n');
      fs.writeFileSync(childFile, child.map(JSON.stringify).join('\n') + '\n');
      const [result] = analyzeFiles({ claude: [file], windows: [{ name: 'resume', start: at(3), end: at(9) }] });
      t.diagnostic(JSON.stringify({ contractQueries: result.repeats.contractQueries, contractRequeries: result.repeats.contractRequeries, answerChars: result.repeats.answerChars }));
      assert.deepEqual(result.repeats.contractRequeries, { sameContext: 0, sameThread: 1 });
      assert.equal(result.repeats.contractQueries, scenario === 'history repeated by child' ? 1 : 2);
      assert.equal(result.repeats.answerChars, scenario === 'history repeated by child' ? 1000 : 2000);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  });
}
