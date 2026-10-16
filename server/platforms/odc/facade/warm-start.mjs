import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { McpServer, fromJsonSchema, ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { z } from 'zod';

const FORMAT = 'ssam-tools-list/1';
const json = value => JSON.parse(JSON.stringify(value));
const sorted = tools => [...tools].sort((a, b) => a.name.localeCompare(b.name));

// Keep the cached transport alive so doctor and every other listed tool can explain a failed build.
function assemblyRefusal(error) {
  const value = { ok: false, code: 'MCP_ASSEMBLY_FAILED', cause: String(error?.message ?? error),
    next: 'reinicie este servidor MCP (Claude Code: /mcp e reconnect; Codex: reinicie a sess\u00e3o)' };
  return { isError: true, structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function schemaJson(schema, io = 'input') {
  if (!schema) return { type: 'object', properties: {} };
  const standard = schema['~standard'];
  let result;
  if (standard?.jsonSchema?.[io]) result = standard.jsonSchema[io]({ target: 'draft-2020-12' });
  else if (standard?.vendor === 'zod' && '_zod' in schema) result = z.toJSONSchema(schema, { target: 'draft-2020-12', io });
  else throw new Error('A listed tool must expose its Standard JSON Schema');
  return io === 'input' ? { type: 'object', ...result } : result;
}

// Match the SDK's tools/list projection, including optional schemas and metadata.
export function snapshotTool(name, config) {
  return json({ name, title: config.title, description: config.description,
    inputSchema: schemaJson(config.inputSchema), annotations: config.annotations,
    icons: config.icons, _meta: config._meta,
    ...(config.outputSchema ? { outputSchema: schemaJson(config.outputSchema, 'output') } : {}) });
}

export function toolsSnapshotKey(identity, env = process.env, args = []) {
  const release = identity?.release ?? identity;
  if (![release?.head, release?.facadeSha256, release?.catalogSha256].every(value => typeof value === 'string' && value.length)) return null;
  return createHash('sha256').update(JSON.stringify({ head: release.head, facadeSha256: release.facadeSha256,
    catalogSha256: release.catalogSha256, lanes: env.SSAM_MCP_LANES ?? '', hooks: env.SSAM_APP_HOOK_TOOLS ?? '', args })).digest('hex');
}

export function toolsSnapshotPath(root, key) {
  return key ? path.join(root, '.local', 'mcp', `tools-list-${key}.json`) : null;
}

function readSnapshot(file, key) {
  if (!file) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.format !== FORMAT || value.key !== key || typeof value.instructions !== 'string' || !Array.isArray(value.tools)) return null;
    if (value.serverInfo && (typeof value.serverInfo.name !== 'string' || typeof value.serverInfo.version !== 'string')) return null;
    const names = new Set();
    for (const tool of value.tools) {
      if (!tool || typeof tool.name !== 'string' || names.has(tool.name) || typeof tool.inputSchema !== 'object' || !tool.inputSchema || Array.isArray(tool.inputSchema)) return null;
      names.add(tool.name);
    }
    return value;
  } catch { return null; }
}

function writeSnapshot(file, value) {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try { fs.writeFileSync(temporary, JSON.stringify(value)); fs.renameSync(temporary, file); }
  finally { try { fs.unlinkSync(temporary); } catch {} }
}

// A cached surface cannot restore Standard validators from JSON: its SDK schema lists guidance only.
// Once ready, the proxy validates with the live SDK configuration, preserving transforms and refusals.
// Continuations still reach the deadline layer when an original call has required fields.
const listedSchema = schema => ({ '~standard': { version: 1, vendor: 'ssam-snapshot',
  validate: value => ({ value: value === undefined ? {} : value }),
  jsonSchema: { input: () => schema, output: () => schema } } });
const configOf = tool => ({ title: tool.title, description: tool.description,
  inputSchema: listedSchema(tool.inputSchema), annotations: tool.annotations, icons: tool.icons,
  _meta: tool._meta, ...(tool.outputSchema ? { outputSchema: fromJsonSchema(tool.outputSchema) } : {}) });

export async function createWarmServer({ root, identity, env = process.env, build, wrap = (_name, handler) => handler,
  onStale = () => {}, log = () => {}, serverInfo = { name: 'ssam', version: '0.2.0' }, startAfterConnect = false, args = [] } = {}) {
  const key = toolsSnapshotKey(typeof identity === 'function' ? identity() : identity, env, args);
  const file = env.SSAM_TOOLS_SNAPSHOT_DISABLE === '1' ? null : toolsSnapshotPath(root, key);
  const cached = readSnapshot(file, key);
  const save = real => {
    const value = { format: FORMAT, key, serverInfo, instructions: real.ssamInstructions, tools: sorted(real.ssamTools) };
    try { writeSnapshot(file, value); } catch (error) { log({ code: 'TOOL_LIST_SNAPSHOT_WRITE_FAILED', error: error.message }); }
    return value;
  };
  if (!cached) {
    const server = await build();
    save(server);
    return { server, ready: Promise.resolve(server), snapshotUsed: false, start: () => {} };
  }

  const server = new McpServer(cached.serverInfo ?? serverInfo, { instructions: cached.instructions });
  const registerSdk = server.registerTool.bind(server);
  const registrations = new Map();
  const cachedByName = new Map(cached.tools.map(tool => [tool.name, tool]));
  const liveRegistrations = new Map();
  let ready;
  let begin, rejectBegin, started = false, closing = false;
  const startGate = new Promise((resolve, reject) => { begin = resolve; rejectBegin = reject; });
  const start = () => { if (started || closing) return; started = true; begin(); };
  const handler = (name, config) => wrap(name, async (args, context) => {
    let built;
    try { built = await ready; } catch (error) { return assemblyRefusal(error); }
    const served = built.ssamHandlers.get(name);
    if (!served) throw new Error(`Tool ${name} is no longer available in the live tool list`);
    const inputSchema = built.ssamConfigs.get(name)?.inputSchema;
    if (inputSchema) {
      // Same Standard Schema validation and issue formatting as the SDK's validateToolInput.
      let parsed;
      try { parsed = await inputSchema['~standard'].validate(args ?? {}); }
      catch (error) { return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }; }
      if (parsed.issues?.length) {
        const issueText = parsed.issues.map(issue => issue.path?.length
          ? `${issue.path.map(part => String(typeof part === 'object' ? part.key : part)).join('.')}: ${issue.message}` : issue.message).join(', ');
        const error = new ProtocolError(ProtocolErrorCode.InvalidParams, `Input validation error: Invalid arguments for tool ${name}: ${issueText}`);
        return { content: [{ type: 'text', text: error.message }], isError: true };
      }
      args = parsed.value;
    } else args = undefined;
    return served(args, context);
  }, config);
  for (const tool of cached.tools) {
    const config = configOf(tool);
    registrations.set(tool.name, registerSdk(tool.name, config, handler(tool.name, config)));
  }
  // Assembly writes into this connected instance. Existing names retain their boot proxy; additions
  // become visible only after the entire live registration set is ready and can be notified once.
  const registerLive = (name, config, callback) => {
    liveRegistrations.set(name, { config, callback });
    return registrations.get(name);
  };
  // Stdio production starts only after connecting its transport and allowing an IO window.
  // Embedded callers retain the earlier immediate background startup by default.
  ready = startGate.then(() => build(server, registerLive)).then(async built => {
    if (built !== server) throw new Error('Warm assembly must populate the connected McpServer instance');
    if (!(built.ssamConfigs instanceof Map)) throw new Error('Warm assembly must retain its live SDK configurations');
    const live = save(built);
    const stale = JSON.stringify(sorted(cached.tools)) !== JSON.stringify(live.tools) || cached.instructions !== live.instructions;
    // Refresh original output validators even when the advertised JSON is unchanged. Input remains
    // pass-through here so a continuation can reach the deadline before live original validation.
    {
      // RegisteredTool.update emits notifications; batch the complete replacement into one list change.
      const notify = server.sendToolListChanged;
      server.sendToolListChanged = () => {};
      try {
        const names = new Set(live.tools.map(tool => tool.name));
        for (const [name, registered] of registrations) if (!names.has(name)) { registered.remove(); registrations.delete(name); }
        for (const tool of live.tools) {
          const original = built.ssamConfigs.get(tool.name) ?? liveRegistrations.get(tool.name)?.config;
          const config = { ...configOf(tool), ...(original?.outputSchema ? { outputSchema: original.outputSchema } : {}) };
          const registered = registrations.get(tool.name);
          if (registered) {
            if (JSON.stringify(cachedByName.get(tool.name)) === JSON.stringify(tool)) {
              // The proxy already resolves the live handler/configuration. An identical listed name
              // needs no second registration or update; restore only the original runtime validator.
              registered.outputSchema = original?.outputSchema;
              continue;
            }
            registered.update({ ...config, paramsSchema: config.inputSchema, callback: handler(tool.name, config) });
            // update treats undefined as unchanged; clear metadata removed by the live definition too.
            for (const field of ['title', 'description', 'annotations', 'icons', '_meta', 'outputSchema'])
              if (config[field] === undefined) delete registered[field];
            // The SDK also memoises the advertised output schema for result projection. Its update
            // treats undefined as unchanged, so clear both public fields when the live tool removes it.
            if (config.outputSchema === undefined) delete registered.outputSchemaJson;
          }
          else registrations.set(tool.name, registerSdk(tool.name, config, handler(tool.name, config)));
        }
      } finally { server.sendToolListChanged = notify; }
      if (stale) notify.call(server);
    }
    if (stale) {
      // The live list is ready now. Diagnostic storage can be slow and must never delay a waiting call.
      Promise.resolve().then(() => onStale({ code: 'TOOL_LIST_SNAPSHOT_STALE', file, key }))
        .catch(() => log({ code: 'TOOL_LIST_SNAPSHOT_DIAGNOSTIC_FAILED' }));
    }
    return built;
  }).catch(error => {
    // Invalidate only this identity. A subsequent start must assemble cold instead of trusting a
    // surface whose live handlers failed to mount. Complete invalidation before ready rejects.
    if (file) {
      try { fs.unlinkSync(file); }
      catch (removeError) {
        if (removeError.code !== 'ENOENT') log({ code: 'TOOL_LIST_SNAPSHOT_DELETE_FAILED', error: removeError.message });
      }
    }
    throw error;
  });
  ready.catch(error => log({ code: 'TOOL_LIST_WARM_BUILD_FAILED', error: String(error?.message ?? error) }));
  const automaticStart = startAfterConnect ? null : setImmediate(start);
  const close = server.close.bind(server);
  server.close = async () => {
    closing = true;
    if (automaticStart) clearImmediate(automaticStart);
    if (!started) rejectBegin(new Error('The transport closed before warm assembly started'));
    await close(); await ready.catch(() => null);
  };
  return { server, ready, snapshotUsed: true, start };
}
