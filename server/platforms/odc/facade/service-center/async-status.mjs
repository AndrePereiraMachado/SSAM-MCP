import { ProtocolError } from './errors.mjs';
import { parseXml } from './xlsx.mjs';
import { redactText } from './bridge.mjs';

export function asyncStatusArguments(operationId, lastMessageId = -1) {
  const id = String(operationId ?? ''), cursor = String(lastMessageId);
  if (!/^[1-9][0-9]{0,9}$/.test(id) || Number(id) > 2147483647
      || !/^(?:-1|0|[1-9][0-9]{0,9})$/.test(cursor) || Number(cursor) > 2147483647)
    throw new ProtocolError('async-operation-status requires an observed positive asyncOperationId and lastMessageId >= -1, both within Int32.');
  return { asyncOperationId: id, lastMessageId: Number(cursor) };
}

// AjaxStepsGetInfo returns XML as application/octet-stream. Decode the bounded
// data contract only; never evaluate message details (the UI can contain code).
export function parseAsyncStatus(body, lastMessageId = -1) {
  const invalid = () => new ProtocolError('Invalid Service Center async status XML; no completion was inferred.');
  if (!Buffer.isBuffer(body) || body.length > 1024 * 1024) throw invalid();
  const source = body.toString('utf8');
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw invalid();
  let root;
  try { root = parseXml(source); } catch { throw invalid(); }
  if (root.name !== 'servermessage') throw invalid();
  const one = name => {
    const found = root.children.filter(n => n.name === name);
    if (found.length !== 1) throw invalid();
    return found[0];
  };
  const scalar = name => { const n = one(name); if (n.children.length) throw invalid(); return n.text ?? ''; };
  const count = scalar('errorcount'), cursor = scalar('lastmessageid'), state = scalar('state').toLowerCase();
  if (!/^(?:0|[1-9][0-9]{0,9})$/.test(count) || Number(count) > 2147483647
      || !/^(?:-1|0|[1-9][0-9]{0,9})$/.test(cursor) || Number(cursor) > 2147483647 || Number(cursor) < lastMessageId
      || !/^[a-z][a-z0-9_-]{0,39}$/.test(state)) throw invalid();
  const messagesNode = one('messagelist');
  if (messagesNode.children.some(n => n.name !== 'message')) throw invalid();
  const messages = messagesNode.children.slice(0, 200).map(message => {
    const field = name => {
      const values = message.children.filter(n => n.name === name);
      if (values.length !== 1 || values[0].children.length) throw invalid();
      return redactText(values[0].text ?? '').slice(0, 1000);
    };
    return { type: field('type'), text: field('text') };
  });
  const failed = Number(count) > 0 || state === 'error';
  return { state, errorCount: Number(count), lastMessageId: Number(cursor), terminal: state === 'done' || failed,
    completedSuccessfully: state === 'done' && !failed, messages, truncated: messagesNode.children.length > messages.length,
    messageCount: messagesNode.children.length,
    note: 'Status of the observed async operation only; completion does not prove a package was downloaded. Script/detail payloads are omitted.' };
}
