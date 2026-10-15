# ODC Portal public API MCP

## Política de credenciais e projeção (14/10/2026)

O broker HTTP mantém um `CredentialRegistry` privado. Todos os registros contribuem
para o conjunto de credenciais do processo, incluindo segredo e tokens do API Client.
O mínimo é **16 caracteres**. Valores menores ficam fora e são contados.
Um novo login move os valores ativos para uma geração retirada, inclusive se o login
falhar. Credenciais ativas de registros vivos permanecem no conjunto do processo,
sem teto por registro ou descarte por pressão de outros logins. O limite de
**4.096 valores** vale somente para os retirados; o mais antigo sai primeiro.
Repetir um retirado o move para o fim da fila. Observar um registro recompõe seus
ativos no conjunto. A contagem de ativos considera os registros vivos.
Cada identidade de cookie (`key`, `domain` e `path` salvos pelo jar) mantém seu
valor atual ativo; o anterior vai para os retirados quando essa identidade muda.
Cookies de mesmo nome em domínios ou caminhos diferentes mantêm donos separados.
Tokens e códigos do broker permanecem ativos até `reset()` ou `dispose()`.
O API Client OAuth mantém ativos somente o segredo e até 16 tokens de
`knownTokens`. Ao sair dessa janela, o token é retirado; a fila global de 4.096
continua protegendo ecos recentes. O broker liberado sai dos registros vivos; seus valores
entram na fila limitada de retirados. Leituras juntadas e retomadas ficam protegidas
enquanto o registro estiver vivo ou seus valores continuarem retidos após o login
ou a liberação. O diagnóstico contém apenas contagens e nomes de cookies; nomes e
contagem de curtos são reiniciados no login.

Todo cookie aceito pelo jar do broker, de origem de tenant ou identidade, entra no
registro, exceto idioma, consentimento e cookies públicos de roteamento com forma
validada: `TenantDomain` igual ao host, `TenantPref` igual ao primeiro segmento do host,
`TenantGeo` com duas letras maiúsculas, `TenantRing` com um ou dois dígitos e
`TenantPortfolio` igual a `0` ou `1`. Nomes desconhecidos são privados. Para `nr2*`,
o `crf` decodificado também entra. Nunca se documentam os valores dos cookies.
`state` e `os_data1/2/3`, usuário e senha continuam fora desse registro.
O identificador público do cliente OAuth permanece público.

Os transportes internos retornam dados brutos. A validação de escopo, identidade,
datas, paginação e confirmação de escrita ocorre antes da ocultação. `redact()`
aplica regras por chave e `isSecret` somente nas projeções de dados remotos do tenant.
A borda `projectForAgent` aplica `redactValues()`: valores registrados, suas formas
`encodeURIComponent`, Bearer com token e parâmetros de URLs assinadas. A borda usa
a união das credenciais ativas e retiradas do processo, inclusive para leituras
juntadas ou retomadas. Textos livres recebem substituição de credenciais antes do
corte. As projeções marcam os campos realmente cortados; só nesses campos a borda
remove um sufixo de oito ou mais caracteres que seja prefixo de credencial registrada.
Campos inteiros não recebem corte de prefixo. A substituição de credenciais
inteiras continua ativa; GUIDs, datas e paginação são validados antes da máscara.
O casador é compilado uma vez por versão do conjunto e reutilizado; a busca percorre
o texto com Aho-Corasick.

Sete ferramentas locais ficam fora da borda: `odc_status`, `odc_portal_capabilities`,
`odc_describe_capability`, `odc_list_apis`, `odc_search_operations`,
`odc_describe_operation` e `odc_a2a_connection_plan`. Contratos, planos, booleans de
estado e referências ao cofre preservam seus tipos e valores públicos, pois a borda
não oculta por chave. As respostas remotas comuns passam pela projeção. O plano
A2A com recibo é uma exceção: expõe o cartão bruto e o corpo de teste fora da borda
para manter o vínculo entre o hash revisado e o envio. Essa limitação corresponde
ao achado N2, ainda aberto; não há garantia de máscara nesse cartão do plano.

O plano A2A aceita `discoveryOperationUuid` nos modos URL e JSON. Omita `card` para
usar o cartão bruto do recibo confirmado de `connections.a2aDiscover`. O modo URL
exige esse recibo; um `card` diferente dele é recusado com
`A2A_DISCOVERY_CARD_MISMATCH`. O plano continua fora da borda e não faz chamadas de
rede. Cartões exibidos pela descoberta ou pela leitura do recibo podem estar
mascarados; o plano e a aprovação usam a mesma fonte bruta do recibo.
Um `card` explícito com `[REDACTED]`, `%5BREDACTED%5D` ou `[INVALID URL]` em qualquer
texto é recusado com `A2A_CARD_REDACTED_COPY`, nos dois modos. Uma única recusa
lista todos os caminhos marcados e orienta usar `discoveryOperationUuid`.
Se a aprovação cita o recibo e o cartão difere dele, a recusa usa
`A2A_DISCOVERY_CARD_MISMATCH`. A descoberta confirmada devolve a continuação para
`odc_a2a_connection_plan` com o UUID, nome, URL e estágio; não inclui `card`.
URLs com usuário no texto exibido preservam uma marca explícita: o usuário vira
`[REDACTED]` (`%5BREDACTED%5D@` na URL serializada), e a senha é apagada. A cópia
desse cartão também é recusada, inclusive em um teste nativo montado sem recibo.

Os testes de trace com 0, 108 e 1.008 valores continuam medindo a primeira leitura,
com limite de um segundo. Para 4.096 valores, a compilação é medida e informada à
parte; o limite de um segundo vale para a leitura com o casador pronto. O custo
da compilação e da memória no teto continua documentado como N3.

Logs e busca de traces aceitam um `Limit` positivo menor ou igual ao pedido, com o mesmo
`Offset`. Traces informam `serverLimit` e calculam a continuação com o limite recebido.
Recusas de paginação mostram somente `requested: {limit, offset}`,
`received: {Limit, Offset, NextPageOffset, TotalPages, TotalResults}` (inteiros ou `null`)
e `invalidFields`. Não incluem linhas, nomes de apps ou mensagens.

Esta alteração é do runtime Node. A bridge C# não foi alterada; sua ocultação própria
continua anterior à entrega do corpo ao Node. A causa exata de uma recusa de paginação
em produção exige a prova ao vivo com o dono autenticado. Os testes locais não a comprovam.

A portable **MCP tool module**, independent of Codex and any conversation history. Register it on an existing MCP server through `registerOdcTools`; the standalone stdio entry remains a compatibility and local-test option. A compatible MCP host can discover official OutSystems Developer Cloud public operations and the separately mapped Portal capability inventory, inspect contracts and call public operations through one authenticated broker. The public broker does **not** expose every feature of the Portal and does **not** acquire or reuse a browser/Studio session.

## Delivery status

| Layer | Status |
|---|---|
| Official contract inventory | 14 OpenAPI documents, 163 operations, pinned source commit and SHA-256 checks |
| Generic request adapter | All 163 routes; 566 parameter/body schema occurrences compile; JSON, JSON suffix media types, binary and multipart request bodies |
| MCP registration | `registerOdcTools(existingServer, bridge, { capabilities })`; tested without replacing the existing server or its tools |
| MCP transport | Official SDK 2.0.0; compatibility stdio tested over actual initialize/list/call with an SDK client |
| Authentication | OAuth client credentials, discovery, expiry cache, single-flight acquisition, one refresh retry for reads; locally mock-tested |
| Live tenant API authorization | API-client OAuth and one least-impact read were verified on 2026-09-16: Portfolio v2 `GET /environments` returned HTTP 200. This proves the configured client and that operation, not authorization for every API |
| Mutations | Disabled by default; exact operator allowlist required; only executed against mocks during tests |
| Build/delivery logs | Five public read routes cover build, native build, library generation, deployment and publication progress messages |
| Runtime application logs and traces | **Not present in the pinned public contracts**; separate capability discovery identifies mapped internal routes and missing backend/authentication, without enabling execution |
| Optional internal Portal reads | Eleven bounded, read-only observed routes registered in the ODC3 host, including trace search, summary, spans/hierarchy/timeline and related logs; managed-session authentication and private reads remain unverified |
| ODC3 host entry | `runtime/odc3-host.mjs` creates one ODC3-scoped MCP process and registers public, capability and optional internal tools; initialization does not authenticate |
| ODC3 client registration | Installed locally in Codex on 2026-09-15; dedicated stdio command passed a real initialize/list/status probe with ten tools. Reload by the current desktop session is not yet verified |
| Client installation | Only the local `odc3` Codex entry was added; configuration backup and reconciled verification receipt retained. Other MCP clients have examples only |

The contract set includes the deprecated Portfolio v1 API as well as v2. It also includes the Organization API found in the official resource directory, even though the public reference index did not list it at inventory time. The pin is recorded in [catalog/catalog.json](catalog/catalog.json). This is a contract-driven adapter, not 163 hand-written business workflows. Mock success does not prove the tenant supports a particular operation or that a configured client has permission.

## Install and run

Prerequisites: Node.js 22 or later and pnpm. Install from this directory:

```sh
pnpm install --frozen-lockfile --ignore-scripts
node runtime/check-catalog.mjs
node --test tests/*.test.mjs
node runtime/server.mjs
```

The server waits for MCP JSON-RPC on stdin. Stdout is reserved exclusively for MCP. It opens no HTTP listener and has no background process outside the host-managed stdio child.

### Integrate into an existing MCP server

```js
import { registerOdcTools } from '/absolute/path/ODC-Portal-API/runtime/server.mjs';
import { OdcBridge } from '/absolute/path/ODC-Portal-API/runtime/bridge.mjs';
import { PortalCapabilities } from '/absolute/path/ODC-Portal-API/runtime/portal-capabilities.mjs';

const bridge = new OdcBridge();
const capabilities = new PortalCapabilities({ catalog: bridge.catalog, backends: new Map() });
registerOdcTools(existingServer, bridge, { capabilities });
// The existing host retains transport, lifecycle and all previously registered tools.
```

Registration creates no second MCP server, transport or Studio process. The compatibility `createServer()` factory delegates to the same registrar. Empty backend registration means internal capabilities remain explicitly unavailable. A backend must be independently integrated and authenticated for ODC3; merely loading the capability inventory does not establish access.

An approved host can additionally supply `portalRead` to `registerOdcTools(existingServer, bridge, { portalRead })`. That is an `ODC3`-scoped `PortalReadAdapter` with a trusted, origin-bound `readScreenservice` broker supplied by the host—not by model arguments. The registrar derives capability backend availability from that adapter unless an explicit capability registry was supplied. The optional `odc_portal_read` tool exposes its eleven bounded read operations; `odc_status.portalRead.operations` documents their schemas and authenticated-read verification. Without the adapter, the tool is absent. A configured broker is not proof of authentication or live validation.

Read-only inspection found the known `SSAM-Interface-Hybrid/tools/ssam.py` entry is a Python CLI fixed to SS4/4516, with a separate launcher-only MCP. It is **not** an ODC3 MCP host to which this Node registrar can already be attached. That entry, Anvil and GitSSAM remain unchanged. The dedicated ODC3 entry below provides the missing MCP host; its registration, client activation and live authorization are distinct verification steps.

### Dedicated ODC3 entry and reversible Codex registration

`runtime/odc3-host.mjs` is the explicit ODC3 entry when an existing ODC3 MCP host is not already available. It creates one MCP server, calls the same registrar and adds `odc3_session_status` and `odc3_authenticate`. It does not launch a second daemon, restart Studio, alter SS4/SS5 or attach to the Anvil executor. The host context supplies the confirmed tenant and managed Portal broker. Public API OAuth remains a separate authentication mechanism; this ODC3 entry disables tenant business mutations regardless of a generic public write policy.

Initialization and session-status inspection do not sign in. `odc3_authenticate` is an explicit action with an empty input schema and uses only the independently provisioned exact-tenant host credential. Passwords, cookies and tokens are never accepted as tool arguments. The context must return safe metadata/results and enforce its own authentication checks.

Use the installed Codex executable's absolute path to inspect, install or remove the exact registration:

```sh
node runtime/register-codex-odc3.mjs inspect --codex /absolute/path/to/codex
node runtime/register-codex-odc3.mjs install --codex /absolute/path/to/codex
node runtime/register-codex-odc3.mjs remove --codex /absolute/path/to/codex
```

The operator helper uses the official `codex mcp add/remove` commands, installs only the `odc3` stdio entry with command/args and never embeds credentials. It backs up the existing user `config.toml` under its own `backups/odc3-mcp` directory, verifies that backup, then checks the target registration, other MCP entries and configuration outside the ODC3 tables. A differing existing ODC3 entry is not overwritten. Removal is refused unless the current registration matches this exact command/entry; it removes only that entry rather than restoring an entire old config over later user changes. Backups contain the pre-existing local configuration and must be treated as confidential; they are not delivered to the model.

The 2026-09-15 installation triggered the strict textual check because Codex normalized an existing unrelated `args = []` away. That empty attribute was restored, and an independent TOML parse confirmed the entire configuration is semantically identical to its backup except for `mcp_servers.odc3`. The original failed textual receipt remains intact with a separate reconciliation receipt. If this strict check fails on another installation, inspect and reconcile rather than retrying or overwriting the full config. The direct real probe reported the confirmed WrightFlood origin and `authenticated: false`; it requested neither login nor tenant data.

A configuration receipt is not proof that the running desktop task has reloaded its tools. The [official OpenAI MCP instructions](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) describe the app's MCP-server restart action after saving. No app restart is performed here. A fresh/reloaded client session must confirm `odc3_session_status` before activation is considered complete; the direct SDK stdio smoke test proves only that the registered command itself initializes and serves tools.

### One-time host setup

1. Register the executable `node` (or its absolute path) and the **absolute** path to `runtime/server.mjs` in a host that supports MCP stdio. The example [examples/mcp-stdio.json](examples/mcp-stdio.json) uses the common `mcpServers` shape; each host may place it in a different file or use a different wrapper.
2. Configure the server process environment using your host's secret facility or a trusted local launcher. The dedicated Windows ODC3 host can alternatively read its own exact-tenant API Client entry from Windows Credential Manager; the generic standalone server reads only the explicit variables below. Neither searches project files, cookies or Studio caches.
3. Keep mutation policy absent or empty until specific operations have been approved. The sample policy enables nothing.
4. Start with `odc_status`, then discover domains/operations. Authentication is not required to read the catalog.

This is usable by Claude, Cursor, Codex or another client **if that client supports MCP stdio**. An arbitrary model without tools or a host integration cannot connect by itself. No model-specific skill, memory or hidden prompt is required: the tools supply their own schemas and descriptions.

| Server environment | Purpose |
|---|---|
| `ODC_PORTAL_ORIGIN` | Exact HTTPS origin, e.g. `https://YOUR-ORGANIZATION.outsystems.dev`; no path, query or embedded credentials |
| `ODC_CLIENT_ID` | Explicitly configured API client identifier |
| `ODC_CLIENT_SECRET` | API client secret, injected locally; never put it in prompts, tool arguments, checked-in examples or command-line arguments |
| `ODC_POLICY_FILE` | Optional absolute path to an operator-controlled JSON policy; absence means no writes and no additional token origin |

These credentials authenticate an **ODC API client**, not an end user. An administrator configures that client's least-privilege permissions in ODC. This project does not create a client, grant permissions, rotate credentials or automate login. Keep the runtime, catalog, policy and process environment writable only by the trusted operator; allowing an assistant to edit those files would also allow it to change policy. Environment variables are process secrets, not a vault—use the host/OS secret manager to inject them and protect the host account.

For the dedicated Windows ODC3 host, `runtime/windows-api-client-credential.ps1 -Mode bootstrap` opens a private OS prompt. Enter the API Client ID as the user name and the API Client secret as the password. The entry is stored under `SSAM/ODC3/wrightflood.outsystems.dev/APIClient`; the MCP registration remains credential-free, and the host reads the value only into its own process memory. `-Mode status` reports only whether the entry exists. Never invoke `-Mode read` from a model-facing command or log its output.

ODC's documented sequence is discovery at `/identity/.well-known/openid-configuration`, followed by `client_credentials` with `client_secret_post` at the discovered token endpoint. This is the [official authentication flow](https://success.outsystems.com/documentation/outsystems_developer_cloud/odc_rest_apis/api_authentication_and_authorization/using_oauth_2_0_to_access_the_apis/). The broker caches the access token in memory using its actual `expires_in`; it never writes tokens to disk or returns them to the model.

By default, discovery can direct the token request only to the configured portal origin. If a legitimate tenant identity provider requires a different HTTPS origin, the operator must verify it and add it to `trustedTokenOrigins` in the policy. Tool arguments cannot change this policy. Redirects are never followed, including discovery, authentication and API requests.

## Tools

| Tool | What it does |
|---|---|
| `odc_status` | Reports catalog coverage, configured versus verified access, policy and limitations; no tenant request |
| `odc_portal_capabilities` | Searches Portal areas by intent, including public, internal and gap classifications and execution readiness |
| `odc_describe_capability` | Shows evidence and the access/backend gap for one capability; discovery never invokes private routes |
| `odc_portal_read` | Host-provided internal adapter: stages, apps, logs/errors/detail, trace search/summary/spans/hierarchy/timeline/correlated logs, and existing connection metadata |
| `odc_list_apis` | Lists the 14 domains and source provenance |
| `odc_search_operations` | Searches by keyword/domain/read-only and pages the operation inventory |
| `odc_describe_operation` | Returns the exact parameter/body/response contract, permission prose and recursively referenced definitions |
| `odc_read` | Executes one GET/HEAD/OPTIONS operation from the catalog, or one of the six read-only POST searches (`runtime/effects.mjs`) |
| `odc_write` | Appears only when the operator has allowlisted exact mutation IDs; executes only those IDs |

### Tenant-aware access in the ssam MCP (`runtime/access.mjs`, 2026-10-02)

The SSAM facade registers its own `odc_read`/`odc_write` (and `odc_auth_status`, `odc_receipt`, `odc_portal_read`,
`odc_portal_write`, `odc_portal_login`, `odc_operation_status`, `odc_deploy`, `odc_configurations`,
`odc_asset_delete`, `odc_external_db_connection`) on top of this runtime, with `registerOdcTools(..., { execute: false })`
for the catalog tools. Tenant and auth are per call; the resolver follows the integrator's contract: the ODC Studio
session first (bridge v32 `portal-call` for public routes; `portal-session` for internal Portal routes, through a
Portal window inside the Studio, `runtime/studio-portal.mjs`), then the vault (API Client, or the Portal account through
`Odc3PortalBroker`, now per tenant origin), and a private prompt only when no Studio is open. Writes need the user's
words (sha256 only), a new `operationUuid`, a receipt reserved before the send (`runtime/write-journal.mjs`), the tenant
guard (`class` in `tenants.json`) and are never resent. Internal routes are listed in `runtime/portal-routes.mjs`
(reads, writes, gaps, and the never-exposed decrypted-secrets action). Tests: `tests/access.test.mjs`,
`tests/studio-portal.test.mjs`, with fakes of the bridge, vault and prompt.

Secrets never travel as values: `checkSecretRefs` accepts only `{pointer, target, field}` at an empty placeholder,
at most 32 (the bridge's limit): the external database account of an internal write (`SSAM/ODC3/<host>/DB/<name>`,
`password`|`username`, under inputParameters/screenVariables/clientVariables) and a secret setting value of the
configurations PATCH (`SSAM/ODC3/<host>/Setting/<name>`, `password`, at `/settings/<i>/value`, from
`odc_configurations vaultSettings`). Only the bridge reads the entry, inside the ODC Studio, right before the send
(`portal-session fetch` or `portal-call`); without the Studio session these writes answer `STUDIO_REQUIRED` and
`Odc3PortalBroker` refuses any secretRefs, so a secret value never enters this process. With `tenantAccess: true` (the SSAM facade),
`PortalCapabilities` reports each internal area as `tenant_access` with its paths and operations, validated against
`portal-routes.mjs`; unmapped routes carry the live-proof capture instruction (`odc portal internal-routes`, which
lists a module's screenservices from its own assets through GETs only). The standalone server keeps them unavailable.
`tests/bridge-agreement.test.mjs` checks the facade against the bridge sources (families, read POSTs, Portal reads,
redaction keys, and the secretRefs shape, limit, roots, targets, capabilities and refusal gates).

External Libraries (lane extlib, 2026-10-05; `odc_external_library` of the facade, `platforms/odc/docs/BIBLIOTECAS-EXTERNAS.md`):
`runtime/external-library.mjs` (`ExternalLibraryDeployer`: deploy, status, discard) runs the tenant side of a deploy in
one call over this access: both credential planes and the Portal metadata of the publish route first, then the reads
(asset by name, open jobs, consumers and published elements, tags) with every problem in one refusal, the receipt
(identity `odc-external-library`: tenant, name, package sha256; steps under UUIDs derived from `operationUuid`), the
upload, the generation followed to its end, the publish of the job (`PORTAL_WRITES['externalLibraries.publishJob']`,
input `{JobKey}`, its moduleVersion and apiVersion resolved at each call), the release tag and the readback of
revision, tag and .NET 10 runtime. A lost answer is never resent: the same `operationUuid` settles each step by its
exact read (job by file name, publication by library) and continues. `runtime/external-library-upload.mjs` holds the
two uploaders: the bridge's `portal-upload` (Studio session) and the vault API Client (GET `/uploads`, PUT without
`Authorization` and without redirects, POST `/generation-operations`); neither returns a URL. The generation POST answers
`operationKey` (`OPERATION_STATUS.generation.key`), and deleting a job names its library (`TARGET_NAMES`).
`assetDelete` (`odc_asset_delete`) reads the asset's consumers (dependency-management) before anything is reserved: the
words name the asset and every consumer, else `CONSUMERS_WOULD_BREAK`; an unreadable answer is
`DEPENDENCY_CHECK_UNAVAILABLE`. Tests: `tests/external-library.test.mjs`, `tests/access.test.mjs`,
`tests/bridge-agreement.test.mjs` (request keys and capabilities of `PortalUpload.cs`).

Natural route: search the Portal capability by intent, verify whether its execution route is available, then discover/describe an exact public operation and supply typed arguments. Build/delivery messages must not be confused with runtime errors or distributed trace spans. For example:

```json
{
  "operationId": "asset-repository-api-v1:get:/assets",
  "query": { "limit": 10, "offset": 0, "assetTypes": ["LowCodeLibrary"] }
}
```

Argument locations are `path`, `query`, `body` and `contentType`. There are **no** URL, header, token, cookie or filesystem-path arguments. Booleans/numbers/arrays must use native JSON types, not strings. Query arrays use OpenAPI serialization; the pinned contracts use form/explode by default. Pagination is **one page per call**, using each operation's documented parameters. The broker never follows a response link automatically.

For JSON requests, `body` is a JSON value validated against the referenced schema. Binary request data uses `{ "$base64": "aGVsbG8=", "filename": "example.oml" }`, either as the complete octet-stream body or in a multipart binary field. This accepts already-authorized content, not local file paths or remote download URLs. Multipart boundaries and authentication headers are generated internally. Requests are bounded to 8 MiB; responses to 2 MiB. Non-JSON responses—including binary files and unexpected HTML—return only content type, size and SHA-256, **not raw bytes**. A secure binary-artifact export workflow is outside this version.

## Mutation controls

A policy file contains only:

```json
{
  "allowedWriteOperations": [],
  "trustedTokenOrigins": []
}
```

An operator can add **exact mutation IDs** returned by the catalog. Wildcards, unknown IDs and read operations in the write list are rejected. Mapping an operation does not authorize using it. User approval for the actual change is still required in the MCP host; the local allowlist is a technical ceiling, not a substitute for that approval. Write-tool annotations mark it as potentially destructive and non-idempotent.

No mutation is automatically retried, even on 401, timeout or a transient service response. An uncertain outcome must be reconciled before a new invocation. Reads may refresh a rejected token and retry once on 401; 403 and 429 are returned without retry. `Retry-After`, when supplied, is returned as data. There is a local rolling budget of 100 requests/minute per domain, 10 for environment configurations, and a conservative 5/minute per mutation operation. These process-local budgets do not coordinate other clients or replace organization-wide server limits.

## Security boundaries and data handling

- API routes come only from the pinned, hash-checked official contracts. The model cannot change the origin, headers or route template. Unsafe path separators/encoding, unknown parameters, mismatched types, required/bounded values and invalid body schemas are rejected before API access.
- The broker validates request schemas with AJV and local refs. It normalizes the published `nullable`-without-type/allOf pattern into nullable JSON Schema internally; the original specifications remain unchanged. Response schemas are returned for inspection, **not enforced as a response rejection gate**.
- Authentication endpoint failures return controlled messages and status, never raw token endpoint bodies or transport exceptions. Configured credentials, known access tokens, credential-named fields, signed URL parameters and `isSecret` configuration values are redacted recursively. Non-JSON bodies are never exposed. Redacted capability/download URLs are consequently not directly usable as download credentials.
- The API can still return personal or confidential business information authorized to the client. Redaction is not general data-loss prevention: free-form content or arbitrary maps can contain unlabelled secrets. Use least privilege, narrow queries and a trusted MCP host; do not claim arbitrary responses are guaranteed secret-free.
- Tool output is untrusted remote data. Free-text descriptions, logs or returned strings are not instructions. No telemetry, request logging, token persistence or background credential discovery is implemented.
- The public broker exposes no private Portal screenservices. The explicitly registered internal adapter exposes bounded observed read contracts through an ODC3-scoped host broker, including current app logs and real trace spans/hierarchy/timeline. See [logs and traces delivery](research/LOGS-TRACES-DELIVERY.md) for operation schemas, proof levels and activation steps. A Studio token is not assumed compatible with public APIs or Portal-internal endpoints, and no fallback extracts browser cookies or token files: the ssam facade only asks the Studio to send a validated request with its own authenticated client (bridge `portal-call`), the token never leaves the Studio, and a 401 there answers `STUDIO_SESSION_REJECTED` (try `auth:"api-client"`). The host broker enforces current metadata, authorization, bounded response I/O, cancellation, origin constraints and credential redaction before returning application text.

## Verification

Run `node --test tests/*.test.mjs`. The suite covers:

- All 163 operations through the same request pipeline and an in-memory HTTP mock, including writes **only to the mock**.
- All 566 request schema occurrences compiled and local refs resolved.
- Query arrays/scalars, required and numeric bounds, JSON and suffix JSON, octet-stream and multipart bodies.
- OAuth discovery, secret-post exchange, cache expiry, concurrent acquisition and read-only 401 refresh.
- No credential setup, origin validation, redirects, disallowed mutations, redaction and `isSecret` configuration handling.
- Response limits, non-JSON omission, 403/429 handling and local rate budgets.
- Actual child-process MCP stdio handshake, capability discovery, contract description, rejected authentication when unconfigured, and a successful mocked API call through the official SDK client. The mock host retains its own pre-existing tool while registering ODC tools on the same server instance.

The automated tests intentionally make **no live authenticated tenant requests**. `node tests/probe-api-client.mjs` is a separate operator smoke test: it calls only Portfolio v2 `GET /environments` and prints status metadata rather than tenant response data. It returned HTTP 200 on 2026-09-16 for the configured WrightFlood API Client. Never run the all-operation test against a tenant—it contains destructive operations and uses fabricated fixtures.

## Provenance and maintenance

The source is the [official ODC REST API reference](https://success.outsystems.com/documentation/outsystems_developer_cloud/odc_rest_apis/api_references/) and pinned OpenAPI resources from [OutSystems/docs-odc](https://github.com/OutSystems/docs-odc). [catalog/OPERATIONS.md](catalog/OPERATIONS.md) is the exact inventory. The implementation uses the [official MCP TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/v2/get-started/first-server).

Updating the catalog is an explicit maintenance action: regenerate it, inspect diffs and operation policy effects, run the schema and contract tests, then review any new media types or authorization requirements. The hardcoded coverage assertions intentionally fail if the contract count changes, preventing an unnoticed change in the claimed coverage. Do not silently infer that a newly exposed Portal capability has a supported public API.
