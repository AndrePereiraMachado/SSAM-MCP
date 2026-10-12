// The observed Solution_Download response is a preparation, not a package.
// Parse its literal protocol arguments without evaluating any server script.
// Returned fields are private continuation state and must never be tool output.
import { Document, Page } from './html.mjs';
import { ProtocolError } from './errors.mjs';
import { decode, STATE } from './http.mjs';
import { asyncStatusArguments } from './async-status.mjs';

const invalid = () => new ProtocolError('Unsupported solution preparation response; retain the operation and do not repeat preparation', 'SC_DOWNLOAD_PREPARATION_INVALID');
const text = value => String(value).replace(/\s+/g, ' ').trim();
const single = list => { if (list.length !== 1) throw invalid(); return list[0]; };

export function parseSolutionPreparation(response, solution, transport) {
  const [url, kind, raw, charset] = response;
  if (!Buffer.isBuffer(raw) || raw.length > 8 * 1024 * 1024 || !/^text\/html(?:;|$)/i.test(kind)) throw invalid();
  const page = new Page(transport.url(url), new Document(decode(raw, charset)));
  const body = single(page.doc.all('body'));
  // This contract is specifically the running-version download: all publish,
  // pack and solution parameters are -1. Unknown extensions/options are refused.
  const bootstrap = /^\s*(?:javascript:\s*)?Bootstrap\(\s*'([1-9]\d*)'\s*,\s*'\.aspx'\s*,\s*(\d+)\s*,\s*'([A-Za-z0-9_]+)'\s*,\s*-1\s*,\s*-1\s*,\s*-1\s*,\s*-1\s*,\s*-1\s*\);\s*return false;\s*$/.exec(body.attr('onload', ''));
  if (!bootstrap) throw invalid();
  const { asyncOperationId } = asyncStatusArguments(bootstrap[1]);
  const steps = Number(bootstrap[2]);
  if (!Number.isSafeInteger(steps) || steps < 1 || steps > 1000) throw invalid();
  const titles = page.doc.content().all('div', 'h1', 'h2').filter(n => (n.attr('class', '').split(/\s+/).includes('heading2') || n.tag === 'h1' || n.tag === 'h2'));
  if (text(single(titles).text) !== text(`Download Running Version of Solution ${solution}`)) throw invalid();
  const zone = single(page.doc.content().all('div').filter(n => n.attr('id') === 'ButtonZoneDoneOK'));
  const clicked = single(zone.all('input', 'button').filter(n => n.attr('type', n.tag === 'button' ? 'submit' : '').toLowerCase() === 'submit'
    && text(n.attr('value') || n.text) === 'Download'));
  if (!clicked.attr('name') || clicked.has('disabled') || clicked.attr('onclick') || clicked.attr('formaction')) throw invalid();
  const form = clicked.ancestor('form');
  if (!form || form !== single(page.doc.all('form')) || form.attr('onsubmit')) throw invalid();
  if (!form.all('textarea').some(n => n.attr('id') === bootstrap[3])) throw invalid();
  const [action, fields] = transport.formPost(page, clicked);
  if (action !== transport.url('Solution_Download.aspx')) throw invalid();
  const state = fields.filter(([name]) => STATE.test(name));
  // Empty auxiliary ASP.NET state can be valid. The OutSystems page state must
  // exist; a sanitized capture with removed value attributes is never reusable.
  const stateControls = form.all('input').filter(n => STATE.test(n.attr('name', '')));
  if (!state.some(([name, value]) => name === '__OSVSTATE' && value)
      || stateControls.some(n => !n.has('value'))
      || new Set(state.map(([name]) => name)).size !== state.length) throw invalid();
  return { asyncOperationId, steps, url: action, fields };
}
