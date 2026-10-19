// servidor/fase4-26 a8: the one switch of what a hosted server serves, hosted/tools.json, read once here and shared by the
// gate (policy.mjs hostedTools) and by every text of a hosted session that names ssam_code (the paragraph and the rules of
// ssam.mjs hostedInstructions, server-instructions.mjs, work-packet.mjs, text-routes.mjs). ssam_code is served while its
// class is anything but unavailable. Set back to unavailable, the session reads what it read before (a7 K1, B1, I and the
// review of a8, M1): the paragraph and the rules leave ssam_code out, and the gate refuses it with the entry's off state
// (its cause SSAM_CODE_HOSTED_PENDING, its reason and its ssam_map continuation). On a running image the owner sets the same
// class with SSAM_HOSTED_SSAM_CODE=off|on (read once when the server starts; CODE_SWITCH below), no new image needed.
// Reads only the catalog file (no gate, no context): server-instructions.mjs, work-packet.mjs and text-routes.mjs load it.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TOOLS_FILE = fileURLToPath(new URL('./tools.json', import.meta.url));
// Owner request (18/10): switch ssam_code off on a server without a new image. SSAM_HOSTED_SSAM_CODE, read once with the
// catalog (its first read: runServed reads it while it starts, and logs the state, codeSwitchState), sets the same class
// the image's switch is: "off" makes ssam_code unavailable, the off state the gate and every session text already read
// (as overrideCodeServed(false)); "on" serves it (its class in hosted/tools.json, or server when the image ships it off);
// absent or empty, the catalog as the image has it. Case and spaces do not matter; any other value is no switch (the
// catalog as the image has it) and the state says it was ignored.
export const CODE_SWITCH = 'SSAM_HOSTED_SSAM_CODE';
const switchOf = value => { const wanted = typeof value === 'string' ? value.trim().toLowerCase() : ''; return wanted === 'off' || wanted === 'on' ? wanted : null; };
/** The catalog with the class of ssam_code set by the switch value (off | on); the same object for no switch. */
export function withCodeSwitch(tools, value) {
  const wanted = switchOf(value);
  const entry = tools?.ssam_code;
  if (!wanted || !entry) return tools;
  const cls = wanted === 'off' ? 'unavailable' : (entry.class && entry.class !== 'unavailable' ? entry.class : 'server');
  return { ...tools, ssam_code: { ...entry, class: cls } };
}
let loaded = null, switched = null;
let override = null;
const shipped = () => {
  if (loaded) return loaded;
  const value = process.env[CODE_SWITCH];
  switched = { switch: switchOf(value), ...(switchOf(value) === null && typeof value === 'string' && value.trim() !== '' ? { ignored: true } : {}) };
  return (loaded = withCodeSwitch(JSON.parse(fs.readFileSync(TOOLS_FILE, 'utf8')).tools, value));
};
/** What this server serves of ssam_code and why: {served, switch: "off" | "on" | null, ignored?} (the start logs it). */
export function codeSwitchState() {
  shipped();
  return { served: codeServedHosted(), switch: switched.switch, ...(switched.ignored ? { ignored: true } : {}) };
}
/** The hosted catalog (hosted/tools.json, its tools), read once; the gate and the session texts read this same object. */
export const hostedCatalog = () => override ?? shipped();
/** true when the catalog (the one given, else hosted/tools.json) serves ssam_code: any class but unavailable. */
export function codeServedHosted(tools = null) {
  let entry;
  try { entry = (tools ?? hostedCatalog())?.ssam_code; } catch { return false; }
  return Boolean(entry) && entry.class !== 'unavailable';
}
// Test seam: the catalog with the class of ssam_code switched (false: unavailable; true: served, as shipped when it is),
// for the gate and every session text alike, until the returned function restores it. The server never calls it.
export function overrideCodeServed(value) {
  const previous = override;
  const base = hostedCatalog();
  override = withCodeSwitch({ ...base, ssam_code: base.ssam_code ?? {} }, value ? 'on' : 'off');
  return () => { override = previous; };
}
