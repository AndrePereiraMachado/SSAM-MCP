// Continuations: the next MCP call of every known refusal and hint (plan §4.1, lane Z). A refusal of the release never
// sends the model to a shell: it carries `continuation: {tool, arguments, why}`, where tool is one of the 79 tools of
// plan §4.2 (MCP_TOOLS). The facade lanes (D, G, H, I, N, Q, Y, J) take their continuations from here, and the kernel
// mirrors the ones it needs as C# constants (lane S, kernel/src/Anvil.Core/Kernel/McpContinuations.cs).
//
// Pure data and two small functions: no I/O, no clock, no state. Nothing here is release-only, so the checkout may use
// it as it is. Texts (`why`) are pt-BR, short, for the model and the person; arguments use the tool's own names.
//
// Placeholders: an argument value written `<...>` (e.g. lane "<lane>", host "<host>", path "@<key>") is filled by
// continuationFor(code, values) with values[<argument name>]. WORDS stands for the user's own authorization words and
// is never filled: only the person gives them, quoted verbatim, after the model asks.
//
// Mirror contract for lane S (checked by platforms/odc/tests/continuations.test.mjs when the C# file exists):
//   - every code of KERNEL_CODES has `const string <Name> = "<callText(code)>";` in McpContinuations.cs, where <Name> is
//     the code in PascalCase (DIALOG_WEB -> DialogWeb, O11_SC_SECRET_NOT_FOUND -> O11ScSecretNotFound);
//   - an optional `const string <Name>Why = "<why>";` carries the reason;
//   - every constant there mirrors a code of this table (plain literals, `+` allowed; no other constant).
//
// Same tool and argument names as platforms/odc/facade/responses.mjs (front "MCP completo e velocidade") where both
// cover a case: o11_studio {command:"dismiss-dialog", args:{title}}, ssam_doctor {lane} for a missing component,
// ssam_job {lane, job}, ssam_reference {lane, kind, query}, o11_inspect {oml, path, expectedSourceSha256},
// o11_deliver {module, job, checks, authorize}, ssam_connect {lane}, studio_attach {pid}, odc_portal_routes {tenant, module}.
// formatCall writes the same notation as its formatCall.

export const WORDS = "<the user's own words>";
// A continuation that is the refused call itself, corrected (INPUT_INVALID: the same tool with `corrected`) or repeated
// (CREDENTIAL_PROMPT_PENDING: the same call once the prompt is answered). continuationFor fills the tool and the
// arguments from values {tool, arguments}; without them the markers stay.
export const SAME_TOOL = '<the same tool>';

// Plan §4.2: 66 tools of today (3 widened) plus 13 new ones, then the live tools the guides and the continuations name
// (o11_publish, ssam_grant, ssam_evidence, ssam_map's siblings). The list never changes with the license, the Studio or
// the connection (§4.1).
export const MCP_TOOLS = Object.freeze([
  // lifecycle
  'ssam_status', 'ssam_doctor', 'ssam_license', 'ssam_setup', 'ssam_update', 'ssam_credentials', 'ssam_reprove', 'ssam_task',
  'ssam_connect', 'ssam_friction', 'ssam_grant', 'ssam_evidence',
  // knowledge
  'ssam_discover', 'ssam_map', 'ssam_app_url', 'hybrid_tenants', 'ssam_reference',
  // O11 lane
  'context', 'propose', 'continue', 'status', 'o11_job', 'o11_data', 'o11_access', 'o11_dependencies', 'ssam_job',
  'o11_service_center_session', 'o11_service_center_read', 'o11_service_center_write',
  'o11_inspect', 'o11_deliver', 'o11_environment', 'o11_studio', 'o11_publish',
  // GitSSAM integrations (2026-10-05): .NET extensions without Integration Studio, ODC External Libraries
  'o11_extension', 'odc_external_library',
  // ODC lane: the 28 studio_* of platforms/odc/facade/mcp.mjs, the catalog, the tenant access and the Portal routes
  'studio_doctor', 'studio_attach', 'studio_status', 'studio_wait', 'studio_assets', 'studio_consumers', 'studio_data',
  'studio_data_insert', 'studio_data_update', 'studio_data_delete', 'studio_open', 'studio_close', 'studio_snapshot',
  'studio_reference_producers', 'studio_reference_snapshot', 'studio_latest', 'studio_refresh_references', 'studio_dismiss_dialog', 'studio_build',
  'studio_inspect', 'studio_check_base', 'studio_preview', 'studio_merge', 'studio_authorize', 'studio_publish',
  'studio_create', 'studio_create_app', 'studio_command', 'studio_manifest', 'studio_deliver',
  'odc_status', 'odc_portal_capabilities', 'odc_describe_capability', 'odc_list_apis', 'odc_search_operations',
  'odc_describe_operation',
  'odc_auth_status', 'odc_read', 'odc_write', 'odc_receipt', 'odc_portal_read', 'odc_portal_write', 'odc_portal_login',
  'odc_operation_status', 'odc_deploy', 'odc_configurations', 'odc_asset_delete', 'odc_external_db_connection',
  'odc_portal_routes',
  // debugger
  'ssam_debug',
]);

const PROMPT = 'a ferramenta abre a janela privada do Windows; a pessoa digita lá, nunca no chat; depois repita a chamada';
const NOT_IN_RELEASE = 'componente ausente do release; a sessão nunca compila: reinstale ou atualize (ssam_update)';
const ASK_PERSON = 'peça à pessoa para responder o diálogo no Studio; esta chamada espera ele fechar e então repita';
const c = (tool, args, why) => ({ tool, arguments: args, why });
const noDialogs = why => c('o11_studio', { command: 'wait', args: { condition: 'no-dialogs' } }, why);
const prompt = (kind, why = PROMPT) => c('ssam_credentials', { action: 'prompt', kind, host: '<host>' }, why);

// code -> {tool, arguments, why}. Comments name the text each code replaces (file:line of the base).
const TABLE = {
  // ---- license (LICENCA.md §7; the .NET parts answer license_<state>, the facade turns it into LICENSE_<STATE>)
  LICENSE_NOT_ACTIVATED: c('ssam_license', { action: 'activate' }, 'o SSAM ainda não foi ativado nesta máquina; a ferramenta abre a janela privada do Windows e a pessoa digita o código lá, nunca no chat'),
  ACTIVATION_PROMPT_OPENED: c('ssam_license', { action: 'status' }, 'a pessoa digita o código de ativação na janela privada, nunca no chat; depois confira o estado'),
  LICENSE_EXPIRING: c('ssam_license', { action: 'renew' }, 'renovação pendente; renove agora'),
  LICENSE_GRACE: c('ssam_license', { action: 'renew' }, 'sem contato com o servidor de licença; o SSAM para no fim da carência; renove'),
  LICENSE_EXPIRED: c('ssam_license', { action: 'renew' }, 'a licença venceu sem renovação; conecte-se à internet e renove; nenhum dado nem Studio foi alterado'),
  LICENSE_REVOKED: c('ssam_license', { action: 'status' }, 'a licença foi revogada pelo publicador; nenhum dado nem Studio foi alterado; renovar volta a valer se o publicador reativar'),
  LICENSE_CLOCK_INVALID: c('ssam_license', { action: 'renew' }, 'o relógio do Windows está atrás da última hora conhecida, ou o estado da licença foi apagado; acerte o relógio e renove online'),
  LICENSE_INSTALLATION_MISMATCH: c('ssam_license', { action: 'activate' }, 'esta licença pertence a outra instalação; ative com um código novo'),
  LICENSE_RELEASE_TOO_OLD: c('ssam_update', { action: 'install', source: { packagePath: '<packagePath>' }, authorize: WORDS }, 'esta versão do SSAM não é mais aceita; instale a versão nova (o pacote vem do publicador)'),
  RELEASE_TOO_OLD: c('ssam_update', { action: 'install', source: { packagePath: '<packagePath>' }, authorize: WORDS }, 'esta versão do SSAM não é mais aceita; instale a versão nova (o pacote vem do publicador)'),
  LICENSE_UNAVAILABLE: c('ssam_doctor', { checks: ['license'] }, 'o estado da licença não pôde ser lido; o doctor mostra a licença e a janela de ativação'),

  // ---- setup (ssam_setup, J)
  SETUP_REQUIRED: c('ssam_setup', { action: 'plan' }, 'mostra Studios, portas livres, tenants e o registro em cada cliente; aplicar pede as palavras do usuário'),
  SETUP_ENTRY_EXISTS: c('ssam_setup', { action: 'plan' }, 'já existe uma entrada com esse nome apontando para outro lugar; sobrescrever só com replace:true e as palavras do usuário'),
  PORT_IN_USE: c('ssam_setup', { action: 'plan' }, 'testa cada porta da faixa do config.json e diz qual está ocupada'),
  AUTHORITY_MISSING: c('ssam_doctor', { checks: ['authority'] }, 'confere a pasta de autoridade e a chave da bridge, sem tocar no Studio'),

  // ---- connection (ssam.mjs:52, studio-connect.mjs:116,150-151, lib.mjs:448,452, BridgeClientOdc.cs:48-49)
  STUDIO_NOT_OPEN: c('ssam_status', {}, 'abra o Studio normalmente (menu Iniciar) e entre; ssam_status mostra os Studios abertos de cada faixa'),
  STUDIO_NOT_CONNECTED: c('ssam_connect', { lane: '<lane>' }, 'conecta o Studio aberto nesta faixa, sem salvar, publicar nem reiniciar'),
  STUDIO_SESSION_CHANGED: c('ssam_connect', { lane: 'o11' }, 'o Studio selecionado não está mais conectado; conecte o Studio aberto agora'),
  STUDIO_NOT_SIGNED_IN: c('hybrid_tenants', {}, 'a pessoa entra no tenant pelo próprio ODC Studio; hybrid_tenants mostra a sessão de cada tenant'),
  SEVERAL_STUDIOS: c('ssam_connect', { lane: '<lane>', pid: '<pid>' }, 'há mais de um Studio aberto; ssam_status lista os pids; escolha um'),
  ODC_STUDIO_NOT_RUNNING: c('studio_attach', {}, 'abra o ODC Studio normalmente e entre no tenant; depois esta chamada anexa a bridge'),
  ODC_SEVERAL_STUDIOS: c('studio_attach', { pid: '<pid>' }, 'há mais de um ODC Studio aberto; ssam_status lista os pids; escolha um'),
  BRIDGE_NOT_RESPONDING: c('ssam_doctor', { lane: '<lane>', checks: ['studios', 'ports'] }, 'a bridge carregada não responde; outra DLL não é anexada por cima; o doctor junta os recibos sem tocar no Studio'),
  LEGACY_BRIDGE_LOADED: c('ssam_connect', { lane: '<lane>', coexistLegacy: true, authorize: WORDS }, 'o Studio já tem uma bridge de checkout; prefira outro Studio; seguir ao lado dela só depois do aviso de risco e com as palavras do usuário'),
  STUDIO_BUSY: c('studio_wait', { condition: 'idle' }, 'o ODC Studio estava ocupado; nada foi enviado; espere e repita'),
  O11_STUDIO_BUSY: c('o11_studio', { command: 'wait', args: { condition: 'idle' } }, 'o Service Studio estava ocupado; nada foi enviado; espere e repita'),
  STUDIO_REQUIRED: c('ssam_connect', { lane: 'odc' }, 'um segredo só passa pela janela do Portal dentro do ODC Studio, lido pela bridge; conecte o ODC Studio e repita'),

  // ---- credentials (ScSecrets.cs:134, lib.mjs:372,468, odc3-context.mjs:20, debug.mjs:9,43, portal/runtime/access.mjs)
  CREDENTIAL_MISSING: prompt('<kind>'),
  O11_SC_SECRET_NOT_FOUND: prompt('o11-service-center', PROMPT + '; nada foi enviado'),
  ODC_API_CLIENT_MISSING: prompt('odc-api-client'),
  ODC_PORTAL_CREDENTIAL_MISSING: prompt('odc-portal'),
  O11_DEBUGGER_CREDENTIAL_MISSING: prompt('o11-debugger', 'o depurador usa a sessão do Studio ou o cofre; ' + PROMPT),
  SECRET_IN_ARGUMENTS: c('ssam_credentials', { action: 'prompt', kind: '<kind>', host: '<host>' }, 'segredo nunca é argumento de ferramenta; guarde-o pela janela privada e passe só o nome da entrada'),
  CREDENTIAL_PROMPT_OPENED: c('ssam_credentials', { action: 'status', kind: '<kind>', host: '<host>' }, 'a janela privada está aberta; a pessoa digita lá, nunca no chat; confira e repita a chamada'),
  // F8 (A13, 2026-10-06): the call waits for the prompt within SSAM_PROMPT_WAIT_MS and, past it, is the continuation itself.
  CREDENTIAL_PROMPT_PENDING: c(SAME_TOOL, { '<arguments>': '<the same>' }, 'uma janela privada do Windows está aberta; a pessoa digita lá, nunca no chat; repita a mesma chamada, que retoma de onde parou'),
  AUTH_NOT_CONFIGURED: c('ssam_doctor', { checks: ['vault'] }, 'sem sessão do Studio, sem credencial guardada, e a janela privada não abriu; o doctor mostra o cofre e a janela'),
  PORTAL_VAULT_UNAVAILABLE: c('ssam_doctor', { checks: ['vault'] }, 'o cofre do Windows não pôde ser lido; o doctor mostra o motivo'),
  API_CLIENT_VAULT_UNAVAILABLE: c('ssam_doctor', { checks: ['vault'] }, 'o cofre do Windows não pôde ser lido; o doctor mostra o motivo'),
  PORTAL_AUTH_REQUIRED: c('odc_portal_login', { tenant: '<tenant>' }, 'abre a janela do Portal dentro do ODC Studio para a pessoa entrar uma vez (SSO e MFA incluídos); depois repita'),
  WEB_SIGN_IN_REQUIRED: c('odc_portal_login', { tenant: '<tenant>' }, 'a janela do Portal dentro do ODC Studio não está logada; a pessoa entra lá uma vez; depois repita'),
  O11_STUDIO_OPERATION_UNAVAILABLE: c('o11_environment', { action: 'inventory', host: '<host>' }, 'esta operação não tem caminho pela sessão do Studio conectado; o11_environment só oferece as ações que têm (inventory, download, create-app...)'),

  // ---- update (ssam_update, J)
  UPDATE_AVAILABLE: c('ssam_update', { action: 'check' }, 'há versão nova; confira antes de instalar'),
  RECONNECT_REQUIRED: c('ssam_status', {}, 'a pessoa reconecta o cliente (/mcp no Claude Code, ou reinicia o Claude Desktop); depois confira a versão'),
  UPDATE_PACKAGE_INVALID: c('ssam_doctor', { checks: ['signatures'] }, 'o pacote não confere (assinatura, hashes ou minRelease); nada foi instalado'),
  RELEASE_IN_USE: c('ssam_update', { action: 'prune', dryRun: true }, 'um processo vivo ou um registro de conexão usa esse release; o dryRun mostra o que fica'),
  RELEASE_INTEGRITY: c('ssam_doctor', { checks: ['install', 'signatures'] }, 'arquivos do release mudaram ou faltam; reinstale ou atualize'),
  SMART_APP_CONTROL_BLOCKED: c('ssam_doctor', { checks: ['signatures'] }, 'o Windows bloqueou um binário sem assinatura; o doctor mostra o estado do Smart App Control'),
  TASK_RUNNING: c('ssam_task', { id: '<taskId>' }, 'a tarefa longa segue em segundo plano; leia o estado dela, nunca a repita'),

  // ---- compat (the static check before every attach)
  INCOMPATIBLE_STUDIO: c('ssam_doctor', { lane: '<lane>', checks: ['compat'] }, 'checagem estática, sem tocar no Studio; nada foi enviado; a resposta lista membros e versões'),
  STUDIO_CHANGED: c('ssam_connect', { lane: '<lane>', dryRun: true }, 'o Studio mudou de versão; o dryRun só checa e não envia nada ao Studio'),
  CAPABILITY_UNAVAILABLE: c('ssam_doctor', { lane: '<lane>', checks: ['compat'] }, 'o selftest marcou esta capacidade como indisponível neste Studio'),
  FEATURE_NOT_IN_RELEASE: c('ssam_discover', { intent: '<intent>', lane: 'odc' }, 'esta feature do builder não vem no release; descubra a operação de job equivalente'),

  // ---- dialogs (DialogPolicy.cs:54-58, MergeHandler.cs:74; D-DONOS-4: a web dialog goes back to the person)
  DIALOG_OPEN: c('o11_studio', { command: 'dismiss-dialog', args: { title: '<dialog title>' } }, 'fecha só janela com dono, pelo título, como o X (Cancelar), se a pessoa concordar; diálogo web: peça à pessoa para responder no Studio e repita'),
  DIALOG_RECOVERY: noDialogs('diálogo de recuperação (Open | Discard): a pessoa escolhe no Studio; esta chamada espera ele fechar e então repita'),
  DIALOG_MANAGE_DEPENDENCIES: noDialogs('diálogo de referências: a pessoa escolhe no Studio (Manage Dependencies e Apply atualiza; Cancel abre sem atualizar); nunca reinicie o Studio por isso'),
  DIALOG_MERGE_EDITOR: noDialogs('um editor de merge está aberto: a pessoa termina ou cancela no Studio; nunca reinicie o Studio por isso'),
  DIALOG_WEB: noDialogs('diálogo web que a bridge não lê: ' + ASK_PERSON),
  ODC_DIALOG_OPEN: c('studio_dismiss_dialog', { caption: '<caption>', action: '<action>' }, 'só quando a pessoa já decidiu; diálogos só informativos a bridge fecha sozinha'),

  // ---- missing component (ssam.mjs:51, lib.mjs:73,122,174,444, kernel-delivery.mjs:18,41, discovery.mjs:582,
  //      BridgeClientOdc.cs:58): in a release nothing is built on the person's machine
  COMPONENT_MISSING: c('ssam_doctor', { lane: '<lane>' }, NOT_IN_RELEASE),
  ODC_BRIDGE_CLIENT_MISSING: c('ssam_doctor', { lane: 'odc' }, NOT_IN_RELEASE),
  WORKER_UNAVAILABLE: c('ssam_doctor', { lane: '<lane>', checks: ['workers'] }, 'o worker da faixa não respondeu; o doctor mostra o estado dos workers'),

  // ---- O11 by MCP instead of the CLI (ssam.mjs:142-143,264,284, discovery.mjs:80-81, module-map.mjs:292,
  //      lanes.mjs:66-69, FunctionCatalog.cs:129, ExpressionCheck.cs:66, Verbs.cs:536,549,1056, DataPreflight.cs:49,
  //      ReferenceRefresher.cs:128, NativeReferenceSnapshot.cs:104, the internal-routes verb of the ODC CLI)
  O11_INSPECT_BY_KEY: c('o11_inspect', { oml: '<capture.oml>', path: '@<key>', expectedSourceSha256: '<sha256>' }, 'lê a subárvore, as propriedades e os usos do elemento pela @key da mesma captura'),
  O11_DELIVER: c('o11_deliver', { module: '<module>', job: '<job.json>', checks: ['<check>'], authorize: WORDS }, 'entrega por merge no Service Studio; nunca publica'),
  O11_PUBLISH_BY_PERSON: c('o11_studio', { command: 'status' }, 'publicar no O11 fica com a pessoa, no Service Studio, depois do merge; o status mostra o módulo aberto'),
  RUN_JOB: c('ssam_job', { lane: '<lane>', job: '<job.json>' }, 'aplica o job a uma fixture e devolve ok/isValid e as mensagens; não entrega nada ao Studio; só quando a pessoa pede uma prova headless: para mudar o módulo, entregue direto (studio_deliver / o11_deliver valida dentro da chamada)'),
  // A module name that is no module open in the ODC Studio (studio-module.mjs resolveOpenModule): nothing was sent.
  // O11 (F4, A29): continuationFor(code, {lane:'o11'}) answers o11_environment {action:"download", module} (LANE_TABLE).
  MODULE_NOT_OPEN: c('studio_open', { module: '<module>' }, 'o módulo não está aberto no ODC Studio; abre pela organização e repita a chamada com os mesmos argumentos (no O11: o11_environment {action:"download", module})'),
  FUNCTIONS_LOOKUP: c('ssam_reference', { lane: 'o11', kind: 'functions', query: '<name>' }, 'catálogo de funções embutidas da faixa'),
  API_CONTRACT: c('ssam_reference', { lane: '<lane>', kind: 'api', query: '<Interface>' }, 'contrato da Model API e das ops do kernel da faixa'),
  O11_PRODUCER_CAPTURE: c('ssam_job', { lane: 'o11', job: '<job.json>', captureProducers: ['<Producer>'] }, 'a assinatura do produtor não é uma captura atestada do servidor O11; o runner a captura só leitura, pelo Studio logado, e a liga ao job'),
  ODC_PORTAL_ROUTES: c('odc_portal_routes', { tenant: '<tenant>', module: '<module>' }, 'rotas internas do Portal de um módulo'),

  // ---- the refusal codes of the 2026-10-06 package (docs/PACOTE-ATRITOS-2.md section 5.3). Each lane puts the code and
  //      its continuation on its own answers; this table is the catalog (and the refusals guide).
  INPUT_INVALID: c(SAME_TOOL, { '<arguments>': '<corrected>' }, 'a mesma ferramenta com os argumentos de corrected (cada violação traz path, message e accepted); nada foi executado'),
  DISCOVERY_INDEX_INVALID: c('ssam_doctor', {}, 'o índice do discover não confere com as fontes desta release; o doctor mostra a release e o índice'),
  DATA_PROOF_DIFFERS: c('ssam_evidence', { file: '<task>/result.json', pointer: '/dataProof/differences' }, 'os dados entregues diferem do job; cada diferença traz elemento, propriedade, esperado e atual'),
  PRODUCER_SIGNATURE_MISSING: c('o11_dependencies', { action: 'list', producer: '<producer>' }, 'lista os elementos públicos do produtor; cada ausente diz a causa (privado, não publicado, tema ou ausente) e o fix'),
  STUDIO_WRITE_QUEUE_TIMEOUT: c('o11_studio', { command: 'status' }, 'a escrita esperou a vez na fila do Studio além do limite; leia o estado (no ODC: studio_status) antes de repetir'),
  SYSTEM_MODULE_NOT_OPENABLE: c('ssam_map', { lane: 'o11', target: '<module>' }, 'Users, OutSystemsUI e System não abrem como módulo; o mapa lê o OML publicado sem abrir aba'),
  DOCTOR_LANE_UNUSABLE: c('ssam_connect', { lane: '<lane>' }, 'a faixa pedida não está usável; conecta o Studio já aberto dela, sem salvar, publicar nem reiniciar'),
  RELEASE_CHANGED: c('ssam_doctor', {}, 'a release mudou sob esta sessão; reinicie este servidor MCP (Claude Code: /mcp e reconnect; Codex: reinicie a sessão)'),
  WRONG_SERVER: c('ssam_doctor', {}, 'este servidor MCP não é o da pasta da sessão; o doctor mostra a raiz de cada um'),
  TOOL_CATALOG_STALE: c('ssam_doctor', {}, 'o catálogo de ferramentas mudou desde o início do servidor; reinicie o servidor MCP'),
  MODULE_RESERVED: c('ssam_task', { id: '<id>' }, 'uma entrega anterior desta raiz ainda segura o módulo; leia a tarefa para retomar ou fechar'),
  MODULE_RESERVED_FOREIGN: c('ssam_doctor', { lane: 'o11' }, 'o módulo está reservado por outra raiz do SSAM; o doctor mostra a reserva e como liberá-la com as palavras do usuário'),
  BLANK_UI_MODULE: c('o11_environment', { action: '<action>' }, 'repita a mesma chamada sem blank: blank vale só para módulos Service e Library'),

  // ---- the refusal codes of the atritos 3 package (docs/PACOTE-ATRITOS-3.md section 5.3), registered here outside
  //      KERNEL_CODES (no C# mirror); each lane puts the code and its continuation on its own answers.
  PUBLISH_BLOCKED_BY_DIALOG: c('o11_studio', { command: 'refresh-references', args: { module: '<module>' } }, 'o publish parou num diálogo do Studio; com Manage Dependencies, refresh-references atualiza as referências; com outro diálogo, o11_studio {command:"status"} mostra qual é'),
  EVIDENCE_FILTER_INVALID: c('ssam_evidence', { file: '<file>', where: '<example>' }, 'a mesma leitura com a cláusula de exemplo, montada dos campos que as linhas do arquivo têm'),
  STUDIO_WINDOWLESS: c('ssam_connect', { lane: 'o11' }, 'este Service Studio não tem janela principal: o SSAM o ignora e o Studio com janela é o da faixa; o SSAM nunca fecha nem encerra um Studio'),
  DUPLICATE_MCP_ENTRY: c('ssam_doctor', {}, 'duas entradas MCP apontam para o mesmo servidor SSAM; use uma só (uma entrada MCP por servidor)'),
  PATH_OUTSIDE_WORKSPACE: c(SAME_TOOL, { '<arguments>': '<the same, with the job inline or agent:inbox/name>' }, 'job: repita a mesma chamada com o próprio job inline (JSON compacto); outro arquivo do usuário: grave no inbox do agente com a ferramenta Write (UTF-8) e repita com agent:inbox/<nome>'),

  // ---- lane wp of the atritos 3 package (the build pool, studio-write-lock.mjs and build-pool.mjs): a delivery whose
  //      module guard or build worker did not come within the queue limit; nothing of it ran.
  BUILD_QUEUE_TIMEOUT: c('ssam_doctor', {}, 'a entrega esperou outra entrega do mesmo módulo, ou um worker de build, além do limite; nada dela rodou: o doctor mostra a faixa, e a mesma entrega pode ser repetida'),

  // ---- the O11 tab codes (o11-studio.mjs close-module, o11_publish/snapshot/refresh-references by key; lane mb2 and the
  //      16th release) and the dependencies-dialog refresh of lane mb2 (o11-studio.mjs, Delivery.ReferencesRefreshFailedCode).
  MODULE_TAB_NOT_CLOSABLE: c('o11_publish', { module: '<module>' }, 'a aba tem mudanças não salvas, ainda abre ou tem uma operação pendente; nada foi fechado: o publish salva o módulo (com as palavras do usuário), depois feche a aba'),
  MODULE_TAB_AMBIGUOUS: c('o11_studio', { command: 'status' }, 'duas abas do Studio têm esse nome; o status mostra as abas com a key de cada uma: passe moduleKey'),
  REFERENCES_REFRESH_FAILED: c('o11_studio', { command: 'refresh-references', args: { module: '<module>' } }, 'o diálogo de dependências foi respondido (Cancel), mas o refresh das referências falhou; repita o refresh do módulo e depois a mesma chamada'),
};

// The same code answered by the other lane with another call: continuationFor(code, {lane}) prefers these.
const LANE_TABLE = {
  o11: {
    // module-map.mjs / o11-studio.mjs (A29): a closed O11 module is read from its published OML, never opened.
    MODULE_NOT_OPEN: c('o11_environment', { action: 'download', module: '<module>' }, 'o módulo não está aberto no Service Studio; baixa o OML publicado sem abrir aba'),
  },
  odc: {
    STUDIO_WRITE_QUEUE_TIMEOUT: c('studio_status', {}, 'a escrita esperou a vez na fila do ODC Studio além do limite; veja o comando em curso antes de repetir'),
  },
};

function freeze(value) {
  if (value && typeof value === 'object') { for (const v of Object.values(value)) freeze(v); Object.freeze(value); }
  return value;
}
export const CONTINUATIONS = freeze(TABLE);
export const LANE_CONTINUATIONS = freeze(LANE_TABLE);
// The codes of section 5.3 of docs/PACOTE-ATRITOS-2.md (registered here, outside KERNEL_CODES: no C# mirror needed).
export const PACKAGE_CODES = Object.freeze(['INPUT_INVALID', 'DISCOVERY_INDEX_INVALID', 'DATA_PROOF_DIFFERS', 'PRODUCER_SIGNATURE_MISSING',
  'STUDIO_WRITE_QUEUE_TIMEOUT', 'SYSTEM_MODULE_NOT_OPENABLE', 'MODULE_NOT_OPEN', 'DOCTOR_LANE_UNUSABLE', 'RELEASE_CHANGED', 'WRONG_SERVER',
  'TOOL_CATALOG_STALE', 'MODULE_RESERVED', 'MODULE_RESERVED_FOREIGN', 'BLANK_UI_MODULE', 'CREDENTIAL_PROMPT_PENDING']);
// The codes of section 5.3 of docs/PACOTE-ATRITOS-3.md.
export const PACKAGE_3_CODES = Object.freeze(['PUBLISH_BLOCKED_BY_DIALOG', 'EVIDENCE_FILTER_INVALID', 'STUDIO_WINDOWLESS', 'DUPLICATE_MCP_ENTRY',
  'PATH_OUTSIDE_WORKSPACE']);
// The code of lane wp (the build pool), outside the contract's section 5.3.
export const BUILD_POOL_CODES = Object.freeze(['BUILD_QUEUE_TIMEOUT']);
// The O11 tab and dependencies-dialog codes (lane mb2 and the 16th release), outside the contract's section 5.3.
export const O11_TAB_CODES = Object.freeze(['MODULE_TAB_NOT_CLOSABLE', 'MODULE_TAB_AMBIGUOUS', 'REFERENCES_REFRESH_FAILED']);

// The codes the kernel answers itself (lane S mirrors them in McpContinuations.cs): DialogPolicy.Hint (Recovery,
// ManageDependencies, MergeEditor, WebDialog, default) and MergeHandler.cs:74 (B); ScSecrets.cs:134;
// BridgeClientOdc.cs:48,49,58; HeadlessSession.cs:27; FunctionCatalog.cs:129 and ExpressionCheck.cs:66 (FUNCTIONS_LOOKUP);
// ReferenceRefresher.cs:128 and NativeReferenceSnapshot.cs:104 (O11_PRODUCER_CAPTURE). API_CONTRACT (Verbs.cs:536,549,1056,
// DataPreflight.cs:49) stays out: its lane is open (<lane>), and S fills it with the lane of the build.
export const KERNEL_CODES = Object.freeze(['DIALOG_RECOVERY', 'DIALOG_MANAGE_DEPENDENCIES', 'DIALOG_MERGE_EDITOR', 'DIALOG_WEB',
  'DIALOG_OPEN', 'O11_SC_SECRET_NOT_FOUND', 'ODC_STUDIO_NOT_RUNNING', 'ODC_SEVERAL_STUDIOS', 'ODC_BRIDGE_CLIENT_MISSING',
  'O11_STUDIO_OPERATION_UNAVAILABLE', 'FUNCTIONS_LOOKUP', 'O11_PRODUCER_CAPTURE']);

const isPlaceholder = v => typeof v === 'string' ? /<[^<>]+>/.test(v) && v !== WORDS
  : Array.isArray(v) && v.length > 0 && v.every(isPlaceholder);
function fill(args, values) {
  const out = {};
  for (const [key, v] of Object.entries(args)) {
    if (key !== 'authorize' && Object.hasOwn(values, key) && values[key] !== undefined && isPlaceholder(v)) out[key] = values[key];
    else if (v && typeof v === 'object' && !Array.isArray(v)) out[key] = fill(v, values);
    else out[key] = Array.isArray(v) ? [...v] : v;
  }
  return out;
}

// The continuation of a code as a fresh object {tool, arguments, why}, or null for an unknown code. values fills the
// placeholders by argument name (lane, host, kind, pid, tenant, title...); fixed values and the user's words never change.
// values.lane picks the other lane's call when the code has one (LANE_CONTINUATIONS). A SAME_TOOL entry takes its tool
// and arguments from values {tool, arguments} (the user's words in them become the marker).
export function continuationFor(code, values = {}) {
  values ??= {};
  const byLane = typeof values.lane === 'string' && Object.hasOwn(LANE_CONTINUATIONS, values.lane) && Object.hasOwn(LANE_CONTINUATIONS[values.lane], code)
    ? LANE_CONTINUATIONS[values.lane][code] : null;
  const entry = byLane ?? (Object.hasOwn(CONTINUATIONS, code) ? CONTINUATIONS[code] : null);
  if (!entry) return null;
  if (entry.tool === SAME_TOOL && typeof values.tool === 'string' && values.tool && values.arguments && typeof values.arguments === 'object' && !Array.isArray(values.arguments)) {
    const args = structuredClone(values.arguments);
    for (const key of ['authorize', 'words']) if (typeof args[key] === 'string') args[key] = WORDS;
    return { tool: values.tool, arguments: args, why: entry.why };
  }
  return { tool: entry.tool, arguments: fill(entry.arguments, values), why: entry.why };
}

// `tool {key:"value", n:1}`: the notation of the tool descriptions (and of responses.mjs formatCall).
export function formatCall(tool, args = {}) {
  const value = v => (v !== null && typeof v === 'object' && !Array.isArray(v)
    ? '{' + Object.entries(v).map(([k, x]) => k + (x === true ? '' : ':' + JSON.stringify(x))).join(', ') + '}'
    : JSON.stringify(v));
  return tool + ' {' + Object.entries(args).filter(([, v]) => v !== undefined).map(([k, v]) => k + ':' + value(v)).join(', ') + '}';
}

// The continuation of a code written as a call, for a text (kernel messages, guides); null for an unknown code.
export function callText(code, values) {
  const next = continuationFor(code, values);
  return next ? formatCall(next.tool, next.arguments) : null;
}
