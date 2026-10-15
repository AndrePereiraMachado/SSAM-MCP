export const MIN_CREDENTIAL_LENGTH = 16;
// This ceiling applies only to retired values. Live owners are never evicted.
export const MAX_PROCESS_CREDENTIALS = 4096;
export const MAX_PROCESS_RETIRED_CREDENTIALS = MAX_PROCESS_CREDENTIALS;
export const MAX_RETIRED_CREDENTIALS = 128;
const registries = new Set();
const activeOwners = new Map();
const retiredValues = new Set();
const finalized = new FinalizationRegistry(({ reference, values }) => {
  for (const value of values) removeOwner(value, reference);
  registries.delete(reference);
});
let version = 0;
let snapshot = Object.freeze([]);
let snapshotVersion = -1;

const boundedAdd = (set, value, limit) => {
  set.delete(value); set.add(value);
  while (set.size > limit) set.delete(set.values().next().value);
};
function rememberRetired(value) {
  if (typeof value !== 'string' || value.length < MIN_CREDENTIAL_LENGTH) return;
  if (activeOwners.has(value)) return;
  if (!retiredValues.has(value)) version++;
  retiredValues.delete(value); retiredValues.add(value);
  while (retiredValues.size > MAX_PROCESS_RETIRED_CREDENTIALS) {
    retiredValues.delete(retiredValues.values().next().value); version++;
  }
}
function addOwner(value, reference) {
  let owners = activeOwners.get(value);
  if (!owners) {
    if (!retiredValues.delete(value)) version++;
    owners = new Set(); activeOwners.set(value, owners);
  }
  owners.add(reference);
}
function removeOwner(value, reference) {
  const owners = activeOwners.get(value);
  if (!owners?.delete(reference) || owners.size) return;
  activeOwners.delete(value);
  // Moving from active to retired preserves matcher membership.
  retiredValues.add(value);
  while (retiredValues.size > MAX_PROCESS_RETIRED_CREDENTIALS) {
    retiredValues.delete(retiredValues.values().next().value); version++;
  }
}
export const credentialStateVersion = () => version;

export function processCredentials() {
  if (snapshotVersion !== version) {
    snapshot = Object.freeze([...activeOwners.keys(), ...retiredValues]); snapshotVersion = version;
  }
  return snapshot;
}

export function processCredentialSummary() {
  for (const ref of registries) if (!ref.deref()) {
    for (const [value, owners] of activeOwners) if (owners.has(ref)) removeOwner(value, ref);
    registries.delete(ref);
  }
  return { registryCount: registries.size, activeCount: activeOwners.size,
    retiredCount: retiredValues.size, totalCount: activeOwners.size + retiredValues.size };
}

// Routing cookies are public only when their value has the expected shape.
export function publicTenantCookie(name, value, host = '') {
  switch (name) {
    case 'TenantDomain': return value === host;
    case 'TenantPref': return value === host.split('.')[0];
    case 'TenantGeo': return /^[A-Z]{2}$/.test(value);
    case 'TenantRing': return /^\d{1,2}$/.test(value);
    case 'TenantPortfolio': return value === '0' || value === '1';
    default: return /^(?:language|lang|locale|culture|consent|cookieconsent|OptanonConsent|OptanonAlertBoxClosed)$/i.test(name);
  }
}

export class CredentialRegistry {
  #values = new Set();
  #direct = new Set();
  #cookies = new Map();
  #retired = new Set();
  #cookieNames = new Set();
  #excludedShort = 0;
  #reference;
  #disposed = false;
  #version = 0;
  get version() { return this.#version; }
  constructor() {
    this.#reference = new WeakRef(this); registries.add(this.#reference);
    finalized.register(this, { reference: this.#reference, values: this.#values }, this.#reference);
  }
  reset() {
    for (const value of this.#values) {
      boundedAdd(this.#retired, value, MAX_RETIRED_CREDENTIALS);
      removeOwner(value, this.#reference);
    }
    this.#values.clear();
    this.#direct.clear(); this.#cookies.clear();
    this.#cookieNames.clear(); this.#excludedShort = 0;
    this.#version++;
  }
  dispose() {
    if (this.#disposed) return;
    this.reset(); this.#disposed = true;
    registries.delete(this.#reference); finalized.unregister(this.#reference);
  }
  add(value) {
    if (typeof value !== 'string' || value.length < MIN_CREDENTIAL_LENGTH) {
      if (typeof value === 'string' && value.length) this.#excludedShort++;
      return false;
    }
    if (this.#disposed) throw new Error('Credential registry is disposed.');
    this.#direct.add(value);
    this.#activate(value);
    return true;
  }
  #activate(value) {
    if (!this.#values.has(value)) this.#version++;
    this.#values.add(value);
    this.#retired.delete(value);
    addOwner(value, this.#reference);
  }
  retire(value) {
    if (!this.#direct.delete(value)) return false;
    return this.#retireUnowned(value);
  }
  #retireUnowned(value) {
    if (this.#direct.has(value) || [...this.#cookies.values()].some(current => current.has(value))) return false;
    if (!this.#values.delete(value)) return false;
    this.#version++;
    boundedAdd(this.#retired, value, MAX_RETIRED_CREDENTIALS);
    removeOwner(value, this.#reference);
    return true;
  }
  tokens(tokens) {
    for (const name of ['AccessToken', 'IdToken', 'RefreshToken']) this.add(tokens?.[name]);
  }
  cookie(cookie, host = '') {
    if (!cookie || typeof cookie.key !== 'string') return false;
    if (this.#disposed) throw new Error('Credential registry is disposed.');
    const values = new Set(), isPublic = publicTenantCookie(cookie.key, cookie.value, host);
    const collect = value => {
      if (typeof value === 'string' && value.length >= MIN_CREDENTIAL_LENGTH) values.add(value);
      else if (typeof value === 'string' && value.length) this.#excludedShort++;
    };
    if (!isPublic) { this.#cookieNames.add(cookie.key); collect(cookie.value); }
    if (!isPublic && /^nr2/i.test(cookie.key)) {
      try {
        const decoded = decodeURIComponent(cookie.value);
        for (const part of decoded.split(';')) {
          const match = /^\s*crf=(.*)$/.exec(part);
          if (match) collect(match[1]);
        }
      } catch { /* Invalid encoded cookies are still registered verbatim. */ }
    }
    // The saved jar cookie supplies normalized domain and path. Same-name
    // cookies at other scopes remain independent owners of their live values.
    const identity = JSON.stringify([cookie.key, cookie.domain ?? host, cookie.path ?? '/']);
    const previous = this.#cookies.get(identity) ?? new Set();
    this.#cookies.set(identity, values);
    for (const value of values) this.#activate(value);
    for (const value of previous) {
      if (!values.has(value)) this.#retireUnowned(value);
    }
    return values.has(cookie.value);
  }
  observe() {
    if (this.#disposed) return;
    for (const value of this.#values) addOwner(value, this.#reference);
  }
  *values() { yield* this.#values; yield* this.#retired; }
  activeValues() { return this.#values.values(); }
  summary() { return { registeredCount: this.#values.size, retiredCount: this.#retired.size,
    excludedShortCount: this.#excludedShort, cookieNames: [...this.#cookieNames].sort() }; }
  toJSON() { return this.summary(); }
}

export function registerCredentials(source) {
  if (source instanceof CredentialRegistry) { source.observe(); return; }
  const values = typeof source?.values === 'function' ? source.values() : Array.isArray(source) ? source : [];
  for (const value of values) rememberRetired(value);
}
