// Size assertions use the same exit as the MCP server. Domain assertions keep the
// raw helper result so evidence-backed metadata reduction cannot hide lost content.
import fs from 'node:fs';
import path from 'node:path';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { shapeToolResult } from '../../responses.mjs';
import { fitResult } from '../../answer-size.mjs';
import { pageAnswer, MAX_ANSWER_BYTES } from '../../ssam.mjs';

const repository = fileURLToPath(new URL('../../../../../', import.meta.url));
const base = path.join(repository, '.local');
fs.mkdirSync(base, { recursive: true });
const root = fs.mkdtempSync(path.join(base, 'answer-wire-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

export function wireBytes(value, { maxBytes = MAX_ANSWER_BYTES, ...args } = {}) {
  args = { lane: value.lane, intent: value.intent, budgetBytes: value.size?.budgetBytes,
    ...(value.expansions ? { expand: Object.keys(value.expansions).join(',') } : {}), ...args };
  const input = { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
  const shaped = shapeToolResult('ssam_discover', args, input, { lane: args.lane });
  const result = pageAnswer(fitResult('ssam_discover', args, shaped, { root }), { root, maxBytes });
  return Buffer.byteLength(JSON.stringify(result.structuredContent ?? JSON.parse(result.content[0].text)), 'utf8');
}
