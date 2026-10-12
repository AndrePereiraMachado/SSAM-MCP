// pt-BR formatters (DESIGN.md 6.6) at every boundary. The fixed instant is 12/10/2026 23:51:08 in America/Sao_Paulo,
// which is 13/10/2026 02:51:08 UTC: the local day and the UTC day differ, so every date check also proves the time zone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pub } from './helpers.mjs';

const F = await import(pub('js/format.js'));

const NOW = Date.parse('2026-10-13T02:51:08Z');
const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;

test('numbers: thousands with a dot, decimals with a comma', () => {
  assert.equal(F.fmtInt(0), '0');
  assert.equal(F.fmtInt(1234), '1.234');
  assert.equal(F.fmtInt(1234567), '1.234.567');
  assert.equal(F.fmtInt(null), '—');
  assert.equal(F.fmtInt('x'), '—');
  assert.equal(F.fmtNum1(1.2), '1,2');
  assert.equal(F.fmtNum1(0), '0,0');
  assert.equal(F.fmtNumMax1(0), '0');
  assert.equal(F.fmtNumMax1(0.5), '0,5');
  assert.equal(F.fmtNum2(0.09), '0,09');
  assert.equal(F.plural(0, 'sessão', 'sessões'), '0 sessões');
  assert.equal(F.plural(1, 'sessão', 'sessões'), '1 sessão');
  assert.equal(F.plural(2, 'sessão', 'sessões'), '2 sessões');
  assert.equal(F.plural(1234, 'chamada', 'chamadas'), '1.234 chamadas');
});

test('percent: integer, one decimal below 1, dash when null', () => {
  assert.equal(F.fmtPct(6), '6%');
  assert.equal(F.fmtPct(6.4), '6%');
  assert.equal(F.fmtPct(6.5), '7%');
  assert.equal(F.fmtPct(12.8), '13%');
  assert.equal(F.fmtPct(0), '0%');
  assert.equal(F.fmtPct(0.5), '0,5%');
  assert.equal(F.fmtPct(0.04), '0%');
  assert.equal(F.fmtPct(0.96), '1%');
  assert.equal(F.fmtPct(1), '1%');
  assert.equal(F.fmtPct(100), '100%');
  assert.equal(F.fmtPct(null), '—');
  assert.equal(F.fmtPct(undefined), '—');
  assert.equal(F.fmtPctFine(1.2), '1,2%');
  assert.equal(F.fmtPctFine(0), '0%');
  assert.equal(F.fmtPctFine(0.5), '0,5%');
  assert.equal(F.fmtShare(1, 14), '7%');
  assert.equal(F.fmtShare(0, 0), '—');
});

test('durations: ms, s with one decimal, min s, h min, d h; truncated at each boundary', () => {
  const cases = [
    [0, '0 ms'], [850, '850 ms'], [999.9, '999 ms'],
    [1000, '1,0 s'], [1250, '1,2 s'], [2100, '2,1 s'], [59999, '59,9 s'],
    [60000, '1 min 00 s'], [185000, '3 min 05 s'], [H - 1, '59 min 59 s'],
    [H, '1 h 00 min'], [H + 2 * M, '1 h 02 min'], [5 * H + 12 * M, '5 h 12 min'], [D - 1, '23 h 59 min'],
    [D, '1 d 0 h'], [4 * D + 11 * H, '4 d 11 h'], [40 * D + 30 * M, '40 d 0 h'],
    [-5, '0 ms'],
  ];
  for (const [ms, text] of cases) assert.equal(F.fmtDuration(ms), text, `${ms} ms`);
  assert.equal(F.fmtDuration(null), '—');
  assert.equal(F.fmtDuration(NaN), '—');
});

test('relative times: agora, há N s/min/h/dias, em N (future)', () => {
  const cases = [
    [0, 'agora'], [4999, 'agora'], [5000, 'há 5 s'], [12 * S, 'há 12 s'], [M - 1, 'há 59 s'],
    [M, 'há 1 min'], [3 * M, 'há 3 min'], [H - 1, 'há 59 min'], [H, 'há 1 h'], [2 * H, 'há 2 h'], [D - 1, 'há 23 h'],
    [D, 'há 1 dia'], [3 * D, 'há 3 dias'],
    [-4999, 'agora'], [-12 * S, 'em 12 s'], [-3 * M, 'em 3 min'], [-2 * H, 'em 2 h'], [-D, 'em 1 dia'], [-5 * D, 'em 5 dias'],
  ];
  for (const [diff, text] of cases) assert.equal(F.fmtRelative(NOW - diff, NOW), text, `diff ${diff}`);
  assert.equal(F.fmtRelative(new Date(NOW - 3 * M).toISOString(), NOW), 'há 3 min');
  assert.equal(F.fmtRelative(null, NOW), '—');
});

function dateChecks() {
  const t = '2026-10-13T02:51:08Z';
  assert.equal(F.fmtDate(t), '12/10/2026');
  assert.equal(F.fmtTime(t), '23:51');
  assert.equal(F.fmtTimeSec(t), '23:51:08');
  assert.equal(F.fmtDateTime(t), '12/10/2026 23:51');
  assert.equal(F.fmtDateTimeSec(t), '12/10/2026 23:51:08');
  assert.equal(F.fmtTitle(t), '12/10/2026 23:51:08 (02:51:08 UTC)');
  assert.equal(F.fmtUtcDateTime(t), '13/10/2026 02:51 UTC');
  assert.equal(F.fmtDayMonthTime('2026-10-12T01:49:00Z'), '11/10 22:49');
  // UTC midnight: 02:59:59 UTC is still the previous local day, 03:00:00 UTC is local midnight.
  assert.equal(F.localDay('2026-10-13T02:59:59Z'), '2026-10-12');
  assert.equal(F.localDay('2026-10-13T03:00:00Z'), '2026-10-13');
  assert.equal(F.localDay('2026-10-13T00:00:00Z'), '2026-10-12');
  assert.equal(F.localDay('2027-01-01T02:00:00Z'), '2026-12-31');
  assert.equal(F.fmtDate('2027-01-01T02:00:00Z'), '31/12/2026');
  assert.equal(F.fmtTime('2026-10-13T03:00:00Z'), '00:00');
  assert.equal(F.sameLocalDay('2026-10-12T03:00:00Z', '2026-10-13T02:59:59Z'), true);
  assert.equal(F.sameLocalDay('2026-10-13T02:59:59Z', '2026-10-13T03:00:00Z'), false);
  assert.equal(F.fmtDayShort('2026-10-12'), 'seg 12/10');
  assert.equal(F.fmtDayShort('2026-10-11'), 'dom 11/10');
  assert.equal(F.fmtDayShort('2026-10-17'), 'sáb 17/10');
  assert.equal(F.fmtDayShort(t), 'seg 12/10');
  assert.equal(F.fmtCalendarDay('2026-10-06'), '06/10/2026');
  assert.equal(F.fmtCalendarDay('x'), '—');
  assert.equal(F.fmtDate(null), '—');
  assert.equal(F.fmtTitle(null), '');
}

test('dates and times in America/Sao_Paulo across the UTC midnight', () => {
  dateChecks();
});

test('dates without a time zone database fall back to UTC-03:00 with the same results', () => {
  F._useTimeZoneDatabase(false);
  try {
    dateChecks();
  } finally {
    F._useTimeZoneDatabase(true);
  }
});

test('bytes base 1024 (IEC) and rates', () => {
  const cases = [
    [0, '0 B'], [512, '512 B'], [999, '999 B'], [1000, '1,0 KiB'], [1024, '1 KiB'], [10199, '10 KiB'],
    [1153434, '1,1 MiB'], [394543104, '376 MiB'], [1063280640, '1,0 GiB'], [6442450944, '6 GiB'],
    [8320450560, '7,7 GiB'], [101000000000, '94 GiB'], [5368709120, '5 GiB'],
  ];
  for (const [b, text] of cases) assert.equal(F.fmtBytes(b), text, `${b} B`);
  assert.equal(F.fmtBytes(null), '—');
  assert.equal(F.fmtRate(1830), '1,8 KiB/s');
  assert.equal(F.fmtRate(410), '410 B/s');
  assert.equal(F.fmtRate(12 * 1024), '12 KiB/s');
  assert.equal(F.fmtRate(null), '—');
});

test('days left of a license', () => {
  assert.equal(F.fmtDaysLeft('2026-11-11T21:00:00Z', NOW), '29 dias');
  assert.equal(F.fmtDaysLeft(NOW + 1.5 * D, NOW), '1 dia');
  assert.equal(F.fmtDaysLeft('2026-10-13T02:58:00Z', NOW), 'vence hoje às 23:58');
  assert.equal(F.fmtDaysLeft(NOW + 39 * M, NOW), '1 dia'); // after the local midnight: tomorrow, not today
  assert.equal(F.fmtDaysLeft(NOW - 3 * D - H, NOW), 'venceu há 3 dias');
  assert.equal(F.fmtDaysLeft(NOW - D, NOW), 'venceu há 1 dia');
  assert.equal(F.fmtDaysLeft(NOW - 2 * H, NOW), 'venceu há 2 h');
  assert.equal(F.fmtDaysLeft(NOW - 10 * M, NOW), 'venceu agora');
  assert.equal(F.fmtDaysLeft(null, NOW), 'sem validade');
});

test('license validity cell: text and warning/critical color', () => {
  const v = (lic) => F.fmtValidity(lic, NOW);
  assert.deepEqual(v({ state: 'active', expiresAt: '2026-11-11T21:00:00Z' }), { text: 'até 11/11/2026 (29 dias)', level: '' });
  assert.deepEqual(v({ state: 'active', expiresAt: '2026-10-15T02:58:00Z' }), { text: 'até 14/10/2026 (2 dias)', level: 'warn' });
  assert.deepEqual(v({ state: 'active', expiresAt: '2026-10-14T20:00:00Z' }), { text: 'até 14/10/2026 (1 dia)', level: 'bad' });
  assert.deepEqual(v({ state: 'active', expiresAt: '2026-10-13T02:58:00Z' }), { text: 'vence hoje às 23:58', level: 'bad' });
  assert.equal(v({ state: 'active', expiresAt: new Date(NOW + 7 * D).toISOString() }).level, 'warn');
  assert.equal(v({ state: 'active', expiresAt: new Date(NOW + 7 * D + M).toISOString() }).level, '');
  assert.equal(v({ state: 'active', expiresAt: new Date(NOW + 2 * D).toISOString() }).level, 'bad');
  assert.deepEqual(v({ state: 'expired', expiresAt: '2026-10-09T15:00:00Z' }), { text: 'venceu em 09/10/2026', level: 'warn' });
  assert.deepEqual(v({ state: 'revoked', expiresAt: '2026-10-20T15:00:00Z', revokedAt: '2026-10-11T14:12:00Z' }), { text: 'revogada em 11/10/2026', level: '' });
  assert.deepEqual(v({ state: 'active', expiresAt: null }), { text: 'sem validade', level: '' });
});

test('lanes, tokens, customers, machines and file slugs', () => {
  assert.equal(F.fmtLanes(['o11', 'odc']), 'ODC, O11');
  assert.equal(F.fmtLanes(['odc']), 'ODC');
  assert.equal(F.fmtLanes(['o11']), 'O11');
  assert.equal(F.fmtLanes([]), '—');
  assert.equal(F.fmtLanes(null), '—');
  assert.equal(F.fmtLanesAnd(['odc', 'o11']), 'ODC e O11');
  assert.equal(F.fmtLanesAnd(['o11']), 'O11');
  assert.equal(F.shortToken('tok_0000000a1fa0'), 'tok_0000…');
  assert.equal(F.fmtCustomerToken('Cliente Alfa', 'tok_0000000a1fa0'), 'Cliente Alfa (tok_0000…)');
  assert.equal(F.fmtMachine({ name: 'PC-TESTE-01', user: 'teste' }), 'PC-TESTE-01 (teste)');
  assert.equal(F.fmtMachine({ name: 'PC-TESTE-01' }), 'PC-TESTE-01');
  assert.equal(F.fmtMachine(null), '—');
  assert.equal(F.slug('Cliente Ação Ltda.'), 'cliente-acao-ltda');
  assert.equal(F.slug('  Cliente   Beta  '), 'cliente-beta');
  assert.equal(F.slug('<b>x</b>'), 'bxb');
  assert.equal(F.slug(''), 'cliente');
});

test('toMs accepts numbers, ISO strings and Dates; NaN otherwise', () => {
  assert.equal(F.toMs(5), 5);
  assert.equal(F.toMs('2026-10-13T02:51:08Z'), NOW);
  assert.equal(F.toMs(new Date(NOW)), NOW);
  assert.ok(Number.isNaN(F.toMs(null)));
  assert.ok(Number.isNaN(F.toMs('ontem')));
});
