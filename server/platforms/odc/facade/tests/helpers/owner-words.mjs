// The owner's reply in the tests (CX13 review 5, W1/U1): words given AFTER the preview, so the injected clock moves past
// the minimum age of a confirmation, and stating the exact number of rows of that preview.
export const afterPreview = (options = {}, ms = 6000) => ({ ...options, now: () => (options.now ? options.now() : Date.now()) + ms });
// Review 6: the words go through the CX15 rule, whose store of words seen on the host spans every test of a file: the
// owner's reply is a new sentence each time (a letter tag, never a number: the only number is the count).
let replies = 0;
const tag = () => { let n = replies++, s = ''; do { s = String.fromCharCode(97 + n % 26) + s; n = Math.floor(n / 26) - 1; } while (n >= 0); return s; };
export const ownerClose = preview => `pode fechar, ${(preview.closePreview ?? preview).count} linhas, resposta ${tag()}`;
export const ownerUpdates = answer => `pode atualizar ${(answer.updatePreview ?? answer).count} linhas, resposta ${tag()}`;
// An owner who reads every update preview and answers it (U1): runs the call and, while it stops with
// DATA_LOAD_UPDATE_CONFIRMATION_REQUIRED, calls again with confirmUpdates and counted words after the preview.
// stops: every update preview seen, so a test can check what was asked before anything was overwritten.
export async function withOwnerConsent(run, input, channel, options = {}, { rounds = 3, stops = [] } = {}) {
  let out = await run(input, channel, options), shift = 0;
  for (let i = 0; i < rounds && out?.code === 'DATA_LOAD_UPDATE_CONFIRMATION_REQUIRED' && out.updatePreview; i++) {
    stops.push(out); shift += 6000;
    out = await run({ ...input, confirmUpdates: { previewSha256: out.updatePreview.sha256, authorize: ownerUpdates(out) } }, channel, afterPreview(options, shift));
  }
  return out;
}
// The arguments a call carries without the owner's words (a preview continuation never has them).
export const withoutWords = args => Object.fromEntries(Object.entries(args).filter(([name]) => !['authorization', 'authorize'].includes(name)));
