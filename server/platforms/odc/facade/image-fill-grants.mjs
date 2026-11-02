// B15 (review of W3-CSS, R2-1): the authorization to fill an EXISTING module image with new content travels outside the job.
// A field of the job's text (a _from:"file", any other) is written by hand or copied from a generated job as easily as by
// SSAM, so the kernel never reads one. Instead:
//   - the image FILES readCodeFiles (ssam-code.mjs) read itself, and only those, are granted by the write that read them
//     (writeCall): {name, sha256 of the bytes}, bound to that write's lane, module and environment (the expectedEnvironment
//     it names; none: any environment of the module) (review of W3-CSS, R3-S1), in this process, per account (a hosted
//     server keeps every customer apart: the scope is the customer's workspace; their files are the ones the gate confined
//     to that workspace), for GRANT_TTL_MS;
//   - every kernel call that applies or checks a job file (apply, check-job, deliver: imageFillArgs) passes, as
//     --image-fill <name>=<sha256>, the grants of this account, lane, module and environment that a create IImage of the job
//     matches by name AND by the sha256 of its bytes (a call that does not say its module gets none);
//   - the kernel (ImageFills.cs) fills an existing image only for such a create; anything else is NAME_COLLISION.
// A create written by hand with the same name and the very same bytes as a file just read is the same write as that file.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { hostedContext } from './executor.mjs';

export const IMAGE_FILL_ARGUMENT = '--image-fill';
export const GRANT_TTL_MS = 30 * 60 * 1000;
const MAX_GRANTS = 500;
const grants = new Map(); // scope -> Map(key -> expiresAt)
const low = value => String(value ?? '').trim().toLowerCase();
// What a grant is bound to: the lane, the module and the environment of the write that read the file (R3-S1).
const placeOf = ({ lane, module, environment } = {}) => (lane && module ? [low(lane), low(module), low(environment)].join('\n') : null);
const keyOf = (place, name, sha256) => place + '\n' + low(name) + '\n' + low(sha256);
const scopeOf = () => { const hosted = hostedContext(); return hosted ? 'hosted:' + (hosted.workspace ?? hosted.tokenId ?? hosted.id ?? '?') : 'local'; };
export const sha256Of = bytes => createHash('sha256').update(bytes).digest('hex');

// The write that read the image files (writeCall): its images, for its lane, module and environment.
export function grantImageFills(images, { lane, module, environment = null, now = Date.now(), scope = scopeOf() } = {}) {
  const place = placeOf({ lane, module, environment });
  if (!place) return;
  let held = grants.get(scope);
  if (!held) grants.set(scope, held = new Map());
  for (const [key, until] of held) if (until <= now) held.delete(key);
  for (const { name, sha256 } of images ?? []) {
    if (typeof name !== 'string' || !/^[0-9a-f]{64}$/i.test(String(sha256))) continue;
    held.delete(keyOf(place, name, sha256));
    held.set(keyOf(place, name, sha256), now + GRANT_TTL_MS);
    while (held.size > MAX_GRANTS) held.delete(held.keys().next().value);
  }
}

// The --image-fill arguments of a kernel call on the job file of a module (lane, module, environment of the call): the grants
// of this account and place its creates of module images match.
export function imageFillArgs(jobFile, { lane, module, environment = null, now = Date.now(), scope = scopeOf() } = {}) {
  const held = grants.get(scope);
  const place = placeOf({ lane, module, environment });
  if (!held?.size || !place || typeof jobFile !== 'string') return [];
  let document;
  try { document = JSON.parse(fs.readFileSync(jobFile, 'utf8').replace(/^﻿/, '')); } catch { return []; }
  const ops = Array.isArray(document) ? document : Array.isArray(document?.ops) ? document.ops : [];
  const args = [];
  for (const op of ops) {
    if (op?.op !== 'create' || op.parent !== '@espace' || !/(?:^|\.)I?Image$/.test(String(op.type ?? '')) || typeof op.name !== 'string' || typeof op.args?.binary !== 'string') continue;
    const sha256 = sha256Of(Buffer.from(op.args.binary, 'base64'));
    const until = held.get(keyOf(place, op.name, sha256));
    if (until && until > now) args.push(IMAGE_FILL_ARGUMENT, op.name + '=' + sha256);
  }
  return args;
}

// Tests: forget every grant.
export function clearImageFillGrants() { grants.clear(); }
