import * as z from 'zod/v4';

const name = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,120}$/)
  .refine(value => !['__proto__', 'prototype', 'constructor'].includes(value), 'Reserved attribute name');
const values = z.preprocess((value, ctx) => {
  // z.record drops __proto__ before key refinements. Refuse it in the original
  // JSON instead of silently changing the requested native owner state.
  const pending = [value]; let nodes = 0;
  while (pending.length) {
    const current = pending.pop();
    if (++nodes > 50000) { ctx.addIssue({ code: 'custom', message: 'Owner state is too large' }); return z.NEVER; }
    if (!current || typeof current !== 'object') continue;
    for (const [key, item] of Object.entries(current)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) {
        ctx.addIssue({ code: 'custom', message: 'Reserved attribute name' }); return z.NEVER;
      }
      pending.push(item);
    }
  }
  return value;
}, z.record(name, z.json()).refine(value => Object.keys(value).length <= 200, 'At most 200 attributes per owner'));
const owner = z.object({ inputs: values.optional(), variables: values.optional() }).strict();

// Model state only. Authentication, user identity, roles and lifecycle selection remain owned by the native runtime.
// Each attribute must resolve to a declared typed attribute of the published original factory before sign-in.
export const nativeScreenContextSchema = z.object({ screen: owner.optional(), block: owner.optional() }).strict();
