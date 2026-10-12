// /api/quality and /api/quality/export (DESIGN-QUALIDADE 4.4): the quality aggregates of a range of local days (today,
// the last 7 or 30 days, or one day), for all customers or one license, and their downloads: one table as CSV (UTF-8 with
// BOM, ';', CRLF, a leading apostrophe before = + - @ TAB CR, quoting) or JSON, the whole payload as JSON, or the
// retained lines of the range as JSONL (at most 7 days and 200 000 lines), each passed through the contract again.
// Everything here is built from the aggregates and the sanitized lines: only codes, counts, times, tool names, the token
// id and the customer name of the license store.
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { MAX_LINE_BYTES, sanitizeQualityLine } from './quality-line.mjs';
import { COLUMN_KEYS } from './quality.mjs';
import { pick } from './keys.mjs';
import { isDay } from './tz.mjs';
import { invalidField } from './texts.mjs';
import { tokenParam } from './views.mjs';

const gunzip = promisify(zlib.gunzip);
const RANGES = new Set(['today', '7d', '30d', 'day']);
export const MAX_EXPORT_LINES = 200_000;
export const MAX_EXPORT_DAYS = 7;
const QUALITY_FILE = /^quality-(\d{8})\.jsonl(\.gz)?$/;

// pt-BR words shared with the page (public/js/labels.js keeps the same tables for the view).
export const PHASE_WORD = Object.freeze({ __proto__: null, queue: 'Fila', capture: 'Captura', compile: 'Compilação', studio: 'Studio',
  verify: 'Verificação', publish: 'Publicação', environment: 'Ambiente', transfer: 'Transferência', rest: 'Servidor' });
export const CLIENT_WORD = Object.freeze({ __proto__: null, 'claude-code': 'Claude Code', 'claude-ai': 'claude.ai', 'claude-desktop': 'Claude Desktop',
  codex: 'Codex', cursor: 'Cursor', vscode: 'VS Code', windsurf: 'Windsurf', other: 'outro', unknown: 'sem nome' });
export const RULE_TEXT = Object.freeze({ __proto__: null,
  SORT_KEYS_SPLIT: 'ordenação escrita com vírgulas virou lista de chaves',
  LIST_ENTITY_SEGMENT_DROPPED: 'caminho com a entidade numa lista de registros foi encurtado',
  NULL_FUNCTION_REWRITTEN: 'NullDateTime() ou NullTime() trocado pelo nulo do tipo',
  PROPERTY_SET_DROPPED: 'propriedade de documentação sem escrita foi descartada, com aviso' });

// ---- CSV (4.4)
const DANGEROUS = /^[=+\-@\t\r]/;
export function csvCell(value) {
  if (value == null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? (Number.isInteger(value) ? String(value) : String(value).replace('.', ',')) : '';
  if (typeof value === 'boolean') return value ? 'sim' : 'não';
  let s = String(value);
  if (DANGEROUS.test(s)) s = "'" + s;
  if (/[;"\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}
export const csvText = (header, rows) => '﻿' + [header, ...rows].map(r => r.map(csvCell).join(';')).join('\r\n') + '\r\n';

const toolsText = list => (list ?? []).map(t => `${t.tool} (${t.count})`).join(', ');
const p = (o, k) => o?.[k] ?? null;
// The CSV columns of each table: the pt-BR titles of the view (DESIGN-QUALIDADE 4.5), ms as integers in "(ms)" columns.
const phaseColumns = COLUMN_KEYS.flatMap(c => [[`${PHASE_WORD[c]} p50 (ms)`, r => p(r[c], 'p50')], [`${PHASE_WORD[c]} p90 (ms)`, r => p(r[c], 'p90')]]);
export const TABLES = Object.freeze({
  __proto__: null,
  resumo: { key: 'totals' },
  erros: { key: 'errors', columns: [['Código', r => r.code], ['Ocorrências', r => r.count], ['% das falhas', r => r.pctOfFailures],
    ['Ferramentas', r => toolsText(r.tools)], ['Clientes', r => r.customers], ['Última vez', r => r.lastAt]] },
  problemas: { key: 'problems', columns: [['Código', r => r.code], ['Problemas', r => r.count], ['Recusas', r => r.refusals],
    ['Com correção pronta', r => r.withPatch], ['Ferramentas', r => toolsText(r.tools)], ['Clientes', r => r.customers]] },
  correcoes: { key: 'rules', columns: [['Regra', r => r.rule], ['O que o motor fez', r => pick(RULE_TEXT, r.rule) ?? ''], ['Correções', r => r.count],
    ['Chamadas', r => r.calls], ['Ferramentas', r => toolsText(r.tools)], ['Clientes', r => r.customers]] },
  fases: { key: 'phases', columns: [['Ferramenta', r => r.tool], ['Chamadas', r => r.calls], ['Chamadas em paralelo', r => r.shared],
    ['Total p50 (ms)', r => p(r.total, 'p50')], ['Total p90 (ms)', r => p(r.total, 'p90')], ...phaseColumns,
    ['Transferência média (bytes)', r => r.transferBytesAvg], ['Execuções do kernel', r => r.kernelRuns], ['Kernel frio', r => r.kernelCold]] },
  tempo: { key: 'timeShare', columns: [['Ferramenta', r => r.tool], ['Tempo total (ms)', r => r.sumMs],
    ...COLUMN_KEYS.map(c => [`${PHASE_WORD[c]} (%)`, r => r[c + 'Pct']])] },
  voltas: { key: 'rounds', columns: [['Cliente', r => r.customer], ['Token', r => r.token], ['Cadeias', r => r.chains], ['Sem entrega', r => r.open],
    ['Voltas do modelo p50', r => r.turnsP50], ['Voltas do modelo p90', r => r.turnsP90], ['Chamadas p50', r => r.callsP50], ['Chamadas p90', r => r.callsP90],
    ['Recusas antes de entregar p50', r => r.refusalsBeforeP50], ['Recusas antes de entregar máx.', r => r.refusalsBeforeMax],
    ['Tempo até entregar p50 (ms)', r => r.wallP50Ms], ['Tempo até entregar p90 (ms)', r => r.wallP90Ms],
    ['Parado entre chamadas p50 (ms)', r => r.gapP50Ms], ['Parado entre chamadas p90 (ms)', r => r.gapP90Ms], ['Parte parada (%)', r => r.idlePct]] },
  causas: { key: 'causes', columns: [['Código', r => r.code], ['Recusas', r => r.refusals], ['Cadeias', r => r.chains],
    ['Chamadas a mais (soma)', r => r.extraCallsSum], ['Chamadas a mais (p50)', r => r.extraCallsP50], ['Tempo a mais p50 (ms)', r => r.extraMsP50]] },
  clientes: { key: 'byCustomer', columns: [['Cliente', r => r.customer], ['Token', r => r.token], ['Chamadas', r => r.calls], ['Falhas', r => r.failures],
    ['Recusas', r => r.refusals], ['Entregas', r => r.delivered], ['Erro mais comum', r => r.topError], ['Problema mais comum', r => r.topProblem],
    ['Regra mais aplicada', r => r.topRule], ['Fase mais lenta', r => pick(PHASE_WORD, r.slowestPhase) ?? null]] },
  'clientes-mcp': { key: 'byClient', columns: [['Cliente MCP', r => pick(CLIENT_WORD, r.client) ?? r.client], ['Sessões', r => r.sessions], ['Cadeias', r => r.chains],
    ['Voltas do modelo (p50)', r => r.turnsP50], ['Chamadas (p50)', r => r.callsP50], ['Recusas antes de entregar (média)', r => r.refusalsBeforeAvg],
    ['Parado entre chamadas p50 (ms)', r => r.gapP50Ms]] },
  tudo: {},
  linhas: {},
});
export const TABLE_NAMES = Object.freeze(Object.keys(TABLES));
const FORMATS = { tudo: ['json'], linhas: ['jsonl'] };
const formatsOf = table => FORMATS[table] ?? ['csv', 'json'];

// totals as rows {campo, valor}; problemPhases flattened as problemPhases.<fase>
export function totalsRows(totals) {
  const rows = [];
  for (const [k, v] of Object.entries(totals ?? {})) {
    if (v && typeof v === 'object') for (const [kk, vv] of Object.entries(v)) rows.push({ campo: `${k}.${kk}`, valor: vv });
    else rows.push({ campo: k, valor: v });
  }
  return rows;
}

export function createQualityViews({ tz, now, quality, serverDir, nativeIds, nameOf, indexing, qualityFileCount, maxLines = MAX_EXPORT_LINES }) {
  function rangeOf(query) {
    const kind = query.get('range') || '7d';
    if (!RANGES.has(kind)) throw invalidField('range', 'today, 7d, 30d ou day');
    const today = tz.day(now());
    let days;
    if (kind === 'today') days = [today];
    else if (kind === '7d') days = tz.days(today, 7);
    else if (kind === '30d') days = tz.days(today, 30);
    else {
      const day = query.get('day');
      if (!isDay(day)) throw invalidField('day', 'AAAA-MM-DD');
      days = [day];
    }
    return { kind, days };
  }

  function payload(query) {
    const { kind, days } = rangeOf(query);
    const token = tokenParam(query);
    const known = quality.knownDays();
    const s = quality.summarize(days, { token, nameOf: t => nameOf(t) ?? t });
    return {
      ok: true,
      now: new Date(now()).toISOString(),
      range: { kind, from: days[0], to: days[days.length - 1], days: days.length, timeZone: tz.timeZone },
      indexing: indexing(),
      available: known.length > 0 || qualityFileCount() > 0,
      firstDay: known[0] ?? null,
      ...(token ? { token } : {}),
      ...s,
    };
  }

  // The lines of the range: the UTC files that can hold its local days, each line capped, parsed, sanitized and written
  // back in the contract's own order; a line outside the days or of another token is left out.
  async function lines(days, token) {
    const keys = new Set();
    for (const d of [...days, tz.addDays(days[days.length - 1], 1)]) keys.add(d.replaceAll('-', ''));
    let names = [];
    try { names = await fsp.readdir(serverDir); } catch { names = []; }
    const byKey = new Map();
    for (const name of names) {
      const m = QUALITY_FILE.exec(name);
      if (!m || !keys.has(m[1])) continue;
      const cur = byKey.get(m[1]);
      if (!cur || (cur.gz && !m[2])) byKey.set(m[1], { name, gz: !!m[2] });
    }
    const wanted = new Set(days);
    const out = [];
    let truncated = false;
    for (const key of [...byKey.keys()].sort()) {
      const f = byKey.get(key);
      let buf;
      try { buf = await fsp.readFile(path.join(serverDir, f.name)); if (f.gz) buf = await gunzip(buf); } catch { continue; }
      for (const raw of buf.toString('utf8').split('\n')) {
        const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if (!text || Buffer.byteLength(raw, 'utf8') + 1 > MAX_LINE_BYTES || text[0] !== '{') continue;
        let value;
        try { value = JSON.parse(text); } catch { continue; }
        const line = sanitizeQualityLine(value, { nativeIds });
        if (!line || (token && line.token !== token) || !wanted.has(tz.day(line.time))) continue;
        if (out.length >= maxLines) { truncated = true; break; }
        out.push(JSON.stringify(line));
      }
      if (truncated) break;
    }
    if (truncated) out.push(JSON.stringify({ truncated: true, lines: maxLines }));
    return out;
  }

  async function exportFile(query) {
    const table = query.get('table');
    if (!table || !Object.hasOwn(TABLES, table)) throw invalidField('table', TABLE_NAMES.join(', '));
    const allowed = formatsOf(table);
    const format = query.get('format') || allowed[0];
    if (!allowed.includes(format)) throw invalidField('format', allowed.join(' ou '));
    const { kind, days } = rangeOf(query);
    const token = tokenParam(query);
    const name = ext => `ssam-qualidade-${table}-${days[0]}-${days[days.length - 1]}${token ? '-' + token : ''}.${ext}`;
    if (table === 'linhas') {
      if (kind === '30d' || days.length > MAX_EXPORT_DAYS) throw invalidField('range', 'linhas: até 7 dias');
      const list = await lines(days, token);
      return { file: { type: 'application/x-ndjson; charset=utf-8', name: name('jsonl'), text: list.length ? list.join('\n') + '\n' : '' } };
    }
    const body = payload(query);
    if (table === 'tudo') return { file: { type: 'application/json; charset=utf-8', name: name('json'), text: JSON.stringify(body, null, 2) + '\n' } };
    const spec = TABLES[table];
    if (table === 'resumo') {
      const rows = totalsRows(body.totals);
      if (format === 'json') return { file: { type: 'application/json; charset=utf-8', name: name('json'), text: JSON.stringify(rows, null, 2) + '\n' } };
      return { file: { type: 'text/csv; charset=utf-8', name: name('csv'), text: csvText(['Campo', 'Valor'], rows.map(r => [r.campo, r.valor])) } };
    }
    const rows = body[spec.key] ?? [];
    if (format === 'json') return { file: { type: 'application/json; charset=utf-8', name: name('json'), text: JSON.stringify(rows, null, 2) + '\n' } };
    return { file: { type: 'text/csv; charset=utf-8', name: name('csv'), text: csvText(spec.columns.map(c => c[0]), rows.map(r => spec.columns.map(c => c[1](r)))) } };
  }

  return { payload, exportFile, lines };
}
