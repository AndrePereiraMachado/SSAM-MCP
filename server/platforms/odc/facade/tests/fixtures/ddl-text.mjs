import { DDL_EXTRACTOR } from '../../module-ddl.mjs';

export function ddlOf({ lane = 'odc', sourceSha256, size = 'small', overrides = {} }) {
  const large = size === 'large';
  const records = Array.from({ length: large ? 400 : 3 }, (_, i) => '  R' + String(i).padStart(3, '0') + ' (Id = ' + (i + 1) + ', Label = "Value ' + i + '", Order = ' + i + ')'
    + (i < (large ? 399 : 2) ? ',' : ';') + ' -- @r' + i).join('\n');
  const status = 'create static entity Status ( -- @E2\n  Id Integer identifier auto required, -- @E2a\n  Label Text(50) required, -- @E2b\n  Order Integer -- @E2c\n)\nvalues\n' + records;
  const quote = '/// A quote.\ncreate entity Quote public ( -- @E1\n  Id Long Integer identifier auto required, -- @E1a\n  Name Text(50) required default "" -- @E1b\n);';
  const structures = Array.from({ length: large ? 60 : 1 }, (_, i) => ({ key: 'T' + i, kind: 'Structure', name: 'Line' + i, section: 'structures', elements: 3,
    text: 'type Line' + i + ' public = { -- @T' + i + '\n  Qty: Integer; -- @T' + i + 'a\n  Note: Text(' + (i + 1) + ') json "note"; -- @T' + i + 'b\n}' }));
  const blocks = [
    { key: 'E1', kind: 'ServerEntity', name: 'Quote', section: 'entities', elements: 3, text: quote },
    { key: 'E2', kind: 'StaticEntity', name: 'Status', section: 'entities', elements: 4 + (large ? 400 : 3), text: status },
    ...structures,
    { key: 'V1', kind: 'SiteProperty', name: 'MaxLines', section: 'variables', elements: 1, text: 'setting MaxLines: Integer folder Quotes = ' + (large ? 'Long("' + 'z'.repeat(20000) + '")' : '10') + ' -- @V1' },
    { key: 'M1', kind: 'Timer', name: 'Nightly', section: 'timers', elements: 1, text: 'timer Nightly action PlaceOrder schedule "When Published" -- @M1' },
  ];
  return { schema: 'ssam-ddl/1', extractor: DDL_EXTRACTOR, lane, adapter: 'kernel', sourceSha256, sourceBytes: 42, createdAt: '2026-10-11T00:00:00Z',
    module: { name: 'Quotes', key: 'R0' }, elements: blocks.reduce((n, b) => n + b.elements, 0), blocks, ...overrides };
}
