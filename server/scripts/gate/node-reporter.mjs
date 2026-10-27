// Reporter do node --test para o portão: uma linha JSON por teste folha (arquivo, caminho de nomes, estado, ms, mensagem).
// Suítes (describe) não contam; a falha de uma suíte por filho falho (subtestsFailed) também não: só a do próprio filho.
// Uso: node --test --test-reporter=./scripts/gate/node-reporter.mjs --test-reporter-destination=<arquivo> ...
import path from 'node:path';

const rel = file => file ? path.relative(process.cwd(), file).split(path.sep).join('/') : '<sem arquivo>';
const message = error => {
  const cause = error?.cause ?? error;
  const text = cause?.message ?? String(cause ?? '');
  return text.split('\n').slice(0, 6).join('\n').slice(0, 600);
};

export default async function* gateReporter(source) {
  const stacks = new Map();
  for await (const { type, data } of source) {
    if (type === 'test:start') {
      const stack = stacks.get(data.file) ?? [];
      stack.length = data.nesting;
      stack[data.nesting] = data.name;
      stacks.set(data.file, stack);
      continue;
    }
    if (type !== 'test:pass' && type !== 'test:fail') continue;
    if (data.details?.type === 'suite' && !(type === 'test:fail' && data.details?.error?.failureType !== 'subtestsFailed')) continue;
    if (type === 'test:fail' && data.details?.error?.failureType === 'subtestsFailed') continue;
    const stack = stacks.get(data.file) ?? [];
    const names = [...stack.slice(0, data.nesting), data.name];
    const status = data.skip !== undefined || data.todo !== undefined ? 'skip' : type === 'test:pass' ? 'pass' : 'fail';
    const line = { event: 'test', file: rel(data.file), path: names, status, ms: Math.round(data.details?.duration_ms ?? 0) };
    if (status === 'fail') line.message = message(data.details?.error);
    yield JSON.stringify(line) + '\n';
  }
}
