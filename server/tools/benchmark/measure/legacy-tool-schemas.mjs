// Source: contexto/schemas.mjs; sha256: bb880c176aed4dac6b6d709f2c39dc65d539317b240434f886cb158891ef31d4.
// Port changes: parameterized input, pure functions, English filenames; drivers and output removed.
export function schemas(rows) {
  const names = new Set(); const schemas = {}; let instr = 0; let ts = null; let cwd = null;
  for (const o of rows) {
    cwd = cwd ?? o.cwd; const a = o.attachment; if (!a) continue;
    if (a.type === 'deferred_tools_delta') { for (const n of a.addedNames || []) if (/^mcp__ssam__/.test(n)) names.add(n); for (const n of a.removedNames || []) names.delete(n); }
    if (a.type === 'mcp_instructions_delta') (a.addedNames || []).forEach((n, i) => { if (n === 'ssam') instr = (a.addedBlocks?.[i] || '').length; });
    if (a.type === 'deferred_tools_record') for (const e of a.entries || []) if (/^mcp__ssam__/.test(e.name)) {
      const sch = JSON.stringify(e.input_schema || {});
      const schemaDescs = [...sch.matchAll(/"description":"((?:[^"\\]|\\.)*)"/g)].reduce((n, m) => n + m[1].length, 0);
      schemas[e.name] = { total: JSON.stringify(e).length, desc: (e.description || '').length, schema: sch.length, schemaDescs, props: Object.keys(e.input_schema?.properties || {}).length };
      ts = o.timestamp;
    }
  }
  const result = { cwd, deferredNames: [...names].sort(), nNames: names.size, serverInstructionsChars: instr, loaded: schemas, loadedCount: Object.keys(schemas).length, loadedChars: Object.values(schemas).reduce((n, s) => n + s.total, 0), lastLoadAt: ts };

return result; }
