// Same closed private IPC contract as the installed Agent; no cross-repo import.
export function parsePrivatePromptCompletion(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('Invalid private prompt completion.'); }
  const keys = ['ok', 'saved', 'remembered', 'profile', 'principal', 'privateCredential'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.ok !== true || typeof value.saved !== 'boolean' || typeof value.remembered !== 'boolean' || Object.keys(value).some(key => !keys.includes(key))) throw new Error('Invalid private prompt completion.');
  if (!value.saved) {
    if (value.privateCredential !== undefined) throw new Error('Invalid private prompt completion.');
    return { saved: false, remembered: false };
  }
  if (value.profile !== undefined && (typeof value.profile !== 'string' || !/^(?:[a-f0-9]{64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.test(value.profile))) throw new Error('Invalid private prompt completion.');
  if (value.principal !== undefined && (typeof value.principal !== 'string' || value.principal.length > 1024 || /[\u0000-\u001f\u007f]/.test(value.principal))) throw new Error('Invalid private prompt completion.');
  if (value.remembered) {
    if (value.privateCredential !== undefined) throw new Error('Invalid private prompt completion.');
  } else {
    const credential = value.privateCredential;
    if (!credential || typeof credential !== 'object' || Array.isArray(credential) || Object.keys(credential).some(key => !['username', 'password'].includes(key)) ||
      typeof credential.username !== 'string' || !credential.username.length || credential.username.length > 1024 || /[\u0000-\u001f\u007f]/.test(credential.username) ||
      typeof credential.password !== 'string' || !credential.password.length || credential.password.length > 8192 || value.principal !== undefined && value.principal !== credential.username) throw new Error('Invalid private prompt completion.');
  }
  return value;
}

// The only prompt IPC collector: bytes never touch a file or a public result.
// Exit alone is insufficient; stdout may still contain the final private bytes.
export function capturePrivatePrompt(child) {
  const record = { done: false, failed: false, value: null };
  let chunks = [], size = 0, ended = false, closed = false, exitCode = null;
  const finish = () => {
    if (!ended || !closed || record.done) return;
    record.done = true;
    if (record.failed || exitCode !== 0) { chunks = []; record.failed = true; return; }
    try { record.value = parsePrivatePromptCompletion(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { record.failed = true; }
    chunks = [];
  };
  if (!child.stdout?.on) { record.done = true; record.failed = true; return record; }
  child.stdout.on('data', bytes => {
    if (record.failed) return;
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    size += buffer.length;
    if (size > 32768) { chunks = []; record.failed = true; return; }
    chunks.push(buffer);
  });
  child.stdout.on('end', () => { ended = true; finish(); });
  child.stdout.on('error', () => { ended = true; record.failed = true; finish(); });
  child.on?.('close', code => { closed = true; exitCode = code; finish(); });
  child.on?.('error', () => { ended = true; closed = true; record.failed = true; finish(); });
  return record;
}

export function createLocalCredentialRuntime({ invalidate = () => {}, normalized = () => {} } = {}) {
  const credentials = new Map(), generations = new Map();
  const generation = host => generations.get(host) ?? 0;
  const changed = host => { generations.set(host, generation(host) + 1); invalidate(host); };
  return {
    generation,
    accept(host, completion, expected) {
      if (expected !== generation(host) || !completion.saved) return false;
      if (!credentials.has(host) && credentials.size >= 128) throw new Error('Too many private credential sessions.');
      changed(host);
      if (completion.remembered) credentials.delete(host);
      else credentials.set(host, { ...completion.privateCredential });
      return true;
    },
    async call(mode, host, extra, input, execute) {
      const credential = credentials.get(host), expected = generation(host);
      const inject = ['status', 'login', 'request', 'sign-out'].includes(mode) && credential;
      const outgoing = inject ? { ...input, privateCredential: { ...credential } } : input;
      if (mode === 'sign-out') { changed(host); credentials.delete(host); }
      const result = await execute(mode, host, extra, outgoing);
      if (mode !== 'sign-out' && expected !== generation(host)) throw Object.assign(new Error('The private account changed during the request. No automatic retry was sent.'), { code: 'CREDENTIAL_SESSION_CHANGED' });
      if (credential && typeof result.body === 'string') {
        const original = Buffer.from(result.body, 'base64').toString('utf8');
        let clean = original;
        const secret = credential.password;
        const html = secret.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
        for (const form of [secret, html, encodeURIComponent(secret), new URLSearchParams({s:secret}).toString().slice(2), JSON.stringify(secret).slice(1,-1), Buffer.from(secret).toString('base64')]) clean=clean.split(form).join('[redacted]');
        if (clean !== original) { result.body=Buffer.from(clean).toString('base64'); normalized(host); }
      }
      return result;
    },
  };
}


