# SSAM Hybrid O11 (SSO): desenho das capacidades headless de dependências, usuários/papéis e runtime

Data: 2026-09-26. Situação: proposta para você decidir. Nenhuma ação ao vivo foi feita nesta síntese.

**Como ler as citações**
- Caminhos que começam com `kernel\`, `docs\` ou `platforms\` são relativos a `C:\Users\andre\SSAM-Hybrid-o11-sso\`.
- `op:\` é o checkout operacional `C:\Users\andre\SSAM-Hybrid\`, lido sem alteração.
- `gaps\` é `C:\Users\andre\AppData\Local\Temp\claude\C--Users-andre-SSAM-Hybrid\19ac5c4d-b36e-471c-bb21-8795f49ce769\scratchpad\gaps\`.
- `hmisjha\` é `kernel\tests\jobs-live\hmisjha\`.

Onde ficam as fontes mais citadas:

| Arquivos | Pasta |
|---|---|
| Verbs.cs, JobRunner.cs, JobSources.cs, NativeReferenceSnapshot.cs, ReferenceSignatureMerge.cs, LogicOrder.cs | `kernel\src\Anvil.Core\Kernel\` |
| HeadlessSession.cs, EnvironmentOperations.cs, ConnectedEnvironment.cs, ReferenceRefresher.cs, NativeReferenceCapture.cs, NativeDependencyReader.cs, Publisher.cs | `kernel\src\Anvil.Core\Adapters.SS11\` |
| Delivery.cs, AppSessions.cs, CSharpRuntimeDelivery.cs | `kernel\src\Anvil.Core\Delivery\` |
| EnvironmentSessionHandler.cs, MergeHandler.cs, Dispatch.cs | `kernel\src\Anvil.Bridge\` |
| Program.cs | `kernel\src\Anvil.Cli\` |
| ssam.mjs, lanes.mjs | `platforms\odc\facade\` |
| "prova SSO" | `kernel\docs\proofs\2026-09-25-o11-connected-environment.md` |

**Legenda:** **[vivo]** provado ao vivo; **[offline]** provado offline; **[inferência]** ainda não provado.

---

## 1. Resumo executivo

| # | Capacidade | Estado hoje | Recomendação | Viabilidade | Esforço | Primeiro probe |
|---|---|---|---|---|---|---|
| 1 | **Manage Dependencies**: um consumidor passa a referenciar uma extensão .NET (HMISJHA_CS → HMISPdfText.ExtractPdfText) ou um eSpace | O op `reference` importa uma extensão só a partir de um `.avsig` já pronto. Não há como capturar `.avsig` pela sessão SSO. Uma referência nova a eSpace nasce com ReferenceHash vazio. | **Opção A**: verbo só-leitura `anvil signature`, que usa a bridge SSO já instalada (sem trocar DLL), mais o op `reference`, já provado. Flag `--capture-producer` no deliver e `producers` no MCP. Para eSpace: refresh do candidato + ReferenceSignatureMerge. | Provável | 1–2 dias (verbo, testes, MCP) + ~1 dia (captura no deliver e em propose/continue) | `anvil refresh-refs --module HMISJHA_CS --all --read-only`, sem `--publish`. É leitura ao vivo e precisa do seu OK. |
| 2 | **Usuários finais e papéis** | Não existe operação sobre usuários ou papéis em runtime. Os papéis já são lidos offline. Grant/Revoke/Check são geráveis por job (probe offline válido). | **Opção A**: manifesto versionado + reconciliação idempotente por um timer "When Published", de preferência nos módulos donos dos papéis. A criação de contas continua humana até haver prova. Leitura/conferência por GET com HMAC numa 2ª fase. | Provável. O Grant dentro do timer ainda não foi provado. | 1–2 dias | Offline: gerar o job do manifesto sobre as bases atuais e rodar `check-job` e `apply` |
| 3 | **Runtime** (Run Now, action de teste, entidades, logs, evidência) | Nada headless. O gate `--stage runtime` aceita texto livre. | **Hoje**: Run Now humano (A), depois de garantir um ModelProfile ativo. **Permanente**: módulo sonda REST com token efêmero (B'), logs só agregados e verbo `ssam runtime` com recibo. D' (Preview Data pela bridge) só se você aceitar trocar a DLL do Studio. | A: provada. B': provável, mas 4 peças sem prova viva. | 1–2 dias (B') | Hoje: Run Now manual. Para B': refazer o probe offline sobre o Core atual (≥ v5546). |

**Decisões que só você pode tomar** (detalhes nas seções 2.x):
1. Autorizar as leituras ao vivo (`refresh-refs --read-only`, `download`, a futura `anvil signature`). Nenhuma delas escreve no ambiente.
2. Onde fica a lógica de acesso (módulos donos ou módulo dedicado) e quem publica: você por 1-Click, ou o verbo da bridge sob suas palavras.
3. Para a sonda de runtime: token efêmero gerado pelo CLI, ou InternalAccess configurado por você.
4. Se algum dia aceita trocar o Anvil.Core carregado num Studio para ganhar leitura de dados pelo SSO. Se sim, primeiro no SS5, nunca direto no SS4.
5. Segurança da demo: a senha comum das seis contas e o login de demo anônimo da v6.1 (seção 3, passo 0).

---

## 2. Capacidades

### 2.1 Manage Dependencies headless (HMISJHA_CS → HMISPdfText e referências a eSpace)

#### Estado atual (com evidência)

**O op `reference` tem dois caminhos** (Verbs.cs:626-677).
- **Produtor OML ou `job:`**: usa `IESpace.RefreshDependencies`, e o **ReferenceHash fica vazio**. O limite está anotado em Verbs.cs:630. [offline] Em `gaps\refs-v5541.json`, AgentOps_Model_CS e (System) aparecem com Guid.Empty.
- **Produtor `.avsig`**: `PrepareSignatureReference` chama `ReferenceRefresher.ImportSnapshot`, que cria `Reference{Kind=Extension}` com stubs identificados pela OriginalKey. Em seguida roda `RefreshReferences` com a assinatura do servidor e confere que ReferenceHash == SignatureHash (Verbs.cs:632-645; JobRunner.cs:23-29, 49-50; ReferenceRefresher.cs:120-178).
  - Os refs `.avsig` precisam ser **os primeiros ops** do job (JobRunner.cs:29; kernel\docs\NAO-DA.md:1464).
  - O snapshot aceita só FormatVersion 1, ModuleKind Extension e elementos `action` ou `entity` (NativeReferenceSnapshot.cs:46-57, 64-81).
  - O binding é sempre explícito: `--producer Nome=<caminho>` (JobSources.cs:11-38; Program.cs:618-621, 663-673; kernel\scripts\run_job.py:107, 128-135).

**Ninguém captura `.avsig` pelo SSO.**
- Não há verbo de captura (lista de verbos em Program.cs:132-180).
- O único produtor de `.avsig` é o `CSharpRuntimeDelivery`, que abre sessão por arquivo de credenciais (CSharpRuntimeDelivery.cs:27, 32). A prova SSO registra isso como lacuna (prova SSO:71).

**As peças de leitura SSO já existem no Studio SS4.**
- `ListReferenceable`, `ListExtensions`, `DownloadExtension` e `GetReferenceSignature` desviam para `Connected.Call` (HeadlessSession.cs:189, 199, 206, 294).
- `signature`, `extensions` e `extension-download` estão na lista fechada de operações (EnvironmentOperations.cs:11-17, 38).
- A bridge empresta o login do Studio e o segredo não sai do processo (EnvironmentSessionHandler.cs:10-12, 35-51).
- Os binários instalados no SS4 contêm essas operações: Anvil.Core 821359B9C858 e Anvil.Bridge 8C177AC2FC84, ambos de 16/09 (varredura de strings).
- `ReferenceInfo` atravessa o fio `ConnectedEnvironment.Wire` sem perder Key, Kind, SignatureHash e SignatureBinary [offline, `gaps\verify\wire.log`].

**O ambiente já anuncia a extensão** [vivo]. `referenceable` pelo SS4, sem arquivo de credencial, listou 383 produtores (`kernel\.local\hmisjha\integrador\inv\referenceable.json`/`.log`). Entre eles:
- HMISPdfText com Key `11B3VoXJqE2Vul+gqAKRBw`, Kind Extension e SignatureHash `861bafeb-b394-d5e8-48bd-ab2f9561106c`, sem aplicação (AppKey "other").
- No `HMISPdfText.xifgen.json`: a key da extensão está em :134, ExtractPdfText = `vITPpt51jlmh7JVc9c6KGw` (:186) e PdfPageText = `IPHvty9GWVGK3o5sV5mxGA` (:145).

**Merge na bridge.**
- O `ReferenceSignatureMerge` ignora referências novas (ReferenceSignatureMerge.cs:62-65). A referência nova é criada pelo merge nativo como objeto inteiro [inferência].
- Uma referência que já existe, com hash diferente, recebe seleção explícita do ReferenceHash (:191-197, 222-230), com conflitos explícitos (:73-101).
- MergeHandler.cs:154-215 faz o merge e a seleção num único Command.
- No decompilado, `ReferenceHash` tem `ignoreForDiff:true, ignoreForMerge:false` (`gaps\decomp\Reference.cs:4568`).

**Probes offline.**
- **P1**: `apply` de `reference` com a `.avsig` de laboratório sobre uma cópia do HMISJHA_CS v5541. Resultado: accepted, isValid, 0 mensagens, 46.658 objetos, 11,6 s. A Extension saiu com ReferenceHash = SignatureHash e as outras referências não mudaram (`gaps\probe1\apply1.log`, `refs-out.json`).
- **P3**: o SignatureBinary decodifica offline, com OriginalName e OriginalKey (`gaps\probe2\sig.log`).

**Já existe um parser de produção das ElementSignatures** em NativeDependencyReader.cs:81-121, que extrai nome e key, e :142-163, que calcula o fechamento de structures. Hoje ele só aceita bytes de OML e recusa `.avsig` (:48-50).

**Exposição incompleta.**
- `o11_job` e `ssam_job` não recebem producers (ssam.mjs:135-159).
- propose/continue monta o `DeliveryRequest` sem Producers (AppSessions.cs:166-167).
- O `deliver` já grava o sha256 de cada producer (Delivery.cs:52-55) e recusa `.avsig` de outro ambiente (Delivery.cs:90-95).

**Nenhuma base local tem a referência feita à mão.** HMISPdfText não aparece em HMISJHA_CS v5541, v5542 nem v5545 (`gaps\refs-v5541.json`, `gaps\verify\refs-v5542.json`, `refs-v5545.json`). Ou seja, a referência que você fez ainda não virou base local.

#### Opções que sobreviveram à verificação

| Opção | Mecanismo | Viabilidade | Esforço |
|---|---|---|---|
| **A (recomendada)** | Verbo só-leitura `anvil signature`. Ele lê a assinatura do servidor pela bridge SSO, resolve as OriginalKeys com o parser do NativeDependencyReader e grava uma `.avsig`. O job continua usando o op `reference` e o ImportSnapshot, já provados. | Provável | 1–2 dias |
| **A' (eSpace, dividida)** | **Referência a eSpace que já existe**: refresh do candidato com a assinatura do servidor (ReferenceRefresher.cs:56-98), entregue pelo ReferenceSignatureMerge, que já aceita eSpace (ReferenceSignatureMerge.cs:74). **Referência nova a eSpace**: caminho B (OML) e depois o mesmo refresh. Não estender a `.avsig` para eSpace. | Provável | +0,5–1 dia |
| **C (plano B)** | ReferencesManager headless (o motor do diálogo Manage Dependencies) com IReferencesService alimentado pela sessão SSO (`kernel\docs\mapa\2026-09-04-add-references-investigacao.md:186-252`; `gaps\decomp\ReferencesManager.cs:2089-2294`). É também o único caminho para **remover** dependência (uncheck → Delete). | Incerta | 3–5 dias |

**Refutadas ou descartadas:**
- **B-ext, Model API `LoadExtension(xif)` + `AddDependency(IAction)`.** A implementação vem com o SS11, mas não é registrada no host headless (`gaps\verify\xifload.log`). Mesmo registrada, `AddDependency` não grava ReferenceHash e fixa ReferenceType WebResponsive (`gaps\decomp\ESpace.cs:16514-16566`). O type mapper só cobre tipos básicos (ESpace.cs:108-140), então `Pages: PdfPageText List` ficaria sem tipo.
- **D, handler novo na bridge.** Exige recompilar e trocar a DLL do SS4 (kernel\scripts\open_studio.ps1:37-49; Dispatch.cs:12). Fica fora pelas regras atuais.
- **Atalho offline para eSpace** (hash calculado a partir do OML baixado). Não bate com o servidor em 3 de 3 módulos (`gaps\verify\sighash.log`).
- **Sintaxe `--producer X=env:X`.** Colide com o `Path.GetFullPath` de ParseBindings (JobSources.cs:17-19). É preciso uma flag própria.
- **`source: server` dentro do op.** Tira do job o determinismo offline e a auditoria por hash.
- **Correções a riscos que a investigação levantou:**
  - O fallback SOAP **tem** o segredo dentro da bridge (EnvironmentSessionHandler.cs:46-50).
  - O risco real é outro: o SOAP GetReferenceDetails pode responder "Missing" em servidores recentes (HeadlessSession.cs:283-285), ou o overload REST pode não casar com o tipo do login SSO (:301-302).
  - AppKey "other" não bloqueia: ZZHighCodePrimitives tem o mesmo AppKey e foi entregue e publicada (kernel\docs\adr\ADR-019-typed-framework-primitives.md:37-41; kernel\docs\PROVAS.md:222, 224).

#### Recomendação

Opção A, com A' dividida.

A única peça que falta é a **aquisição controlada** da assinatura. Merge, import e verificação já estão provados:
- P1, sobre o HMISJHA_CS real, offline;
- extensão entregue e publicada por `.avsig` (PROVAS.md:222-224).

O kind `structure` no snapshot só entra se o passo 5 do plano de prova mostrar que o refresh nativo não cria sozinho a ReferenceStructure `PdfPageText`. A inferência forte é que cria (ReferencesManager.cs:2193-2203, 2252-2291).

#### Contrato proposto

**Verbo novo, só leitura:**
```
anvil signature --producer HMISPdfText [--key 11B3VoXJqE2Vul+gqAKRBw] [--kind Extension]
                --elements "IServerActionSignature:ExtractPdfText" [--pin-xif]
                --out <abs>\HMISPdfText.avsig [--host personal-2qqw9srv.outsystemscloud.com] [--bridge-port 4516]
```

Passos:
1. Sessão conectada com `readOnly:true` obrigatório. Recusa `--credentials`.
2. `extensions`: registra VersionId e IsActive.
3. `signature(key, kind)`.
4. `extensions` de novo. Recusa se o VersionId mudou.
5. Resolve Tipo:Nome → OriginalKey e o fechamento de structures com o parser do NativeDependencyReader.
6. `NativeReferenceCapture.Capture` e `Write`.
7. Com `--pin-xif`: `extension-download` para a pasta da tarefa e SHA-256 do `.xif`, seguindo a ADR-019:27-30 ("hash de interface sozinho não comprova bytes").

Saída JSON:
```json
{"producer":"HMISPdfText","key":"11B3VoXJqE2Vul+gqAKRBw","kind":"Extension","environment":"personal-2qqw9srv.outsystemscloud.com",
 "versionIdBefore":"…","versionIdAfter":"…","isActive":true,"signatureHash":"861bafeb-…",
 "elements":[{"type":"IServerActionSignature","name":"ExtractPdfText","originalKey":"vITPpt51jlmh7JVc9c6KGw"}],
 "closure":[{"type":"structure","name":"PdfPageText","originalKey":"IPHvty9GWVGK3o5sV5mxGA"}],
 "avsigPath":"…","avsigSha256":"…","xifSha256":null}
```

Erros tipados: `VersionIdChanged`, `NotActive`, `ElementNotFound`, `SignatureUnavailable` (com o erro REST ou SOAP), `NotReadOnly`.

**Job (sem mudança):** `{"op":"reference","producer":"HMISPdfText","elements":["IServerActionSignature:ExtractPdfText"]}`, sempre como primeiro op.

**Deliver:**
- `--producer HMISPdfText=<abs>.avsig`: já existe.
- `--capture-producer HMISPdfText`: novo. Captura dentro da pasta da tarefa, grava o hash nas sources e reutiliza a mesma captura na retomada, no molde de FrozenFrameworkDependencies.

**MCP:**
- `o11_job`/`ssam_job` ganham `producers: {Nome: caminhoAbs}` e `captureProducers: [Nome]`.
- propose/continue ganha `dependencies: [{producer, kind, elements}]`.

**Autorização:** a captura é leitura e não pede palavras. O `deliver` e a publicação continuam com as palavras de autorização de hoje.

**Auditoria:**
- a `.avsig` traz Environment, SignatureHash e VersionId;
- o recibo do deliver guarda o sha256 da `.avsig` (e do `.xif`, se fixado);
- o journal registra uma linha por captura, com hashes e sem conteúdo.

#### Requisitos de segurança

- **O read-only do lease é declarado pelo cliente** (EnvironmentSessionHandler.cs:100). As escritas passam pelo mesmo canal e só o `RequireWrite` do lado do Studio as barra (Publisher.cs:73, 84, 204). O verbo precisa abrir o lease com `readOnly:true` e ter **teste** de que recusa escrita.
- A opção depende do **Anvil.Core instalado no SS4** (16/09; prova SSO:16-17, :85). **Nunca rodar `open_studio.ps1` sem `-NoBuild`**: ele recompila e troca as DLLs do SS4 (:37-49).
- O `.xif` baixado tem DLLs executáveis. Fica só na pasta da tarefa, com hash no recibo. Nunca vira artefato publicado nem sai da máquina.
- Recusar `.avsig` de outro ambiente (já existe: Delivery.cs:90-95) e VersionId que mudou entre a captura e o merge.
- Não estender `.avsig` para eSpace sem resolver a atestação de identidade exigida pelo kernel (NativeDependencyReader.cs:12-15, 48-50).

#### Plano de prova (ordenado)

0. **Feito, offline.** P1, P3, `wire.log`, `xifload.log` e `sighash.log` em `gaps\`.
1. **Leitura ao vivo, com seu OK.** `anvil refresh-refs --module HMISJHA_CS --out gaps\refresh-hmisjha --all --read-only --host personal-2qqw9srv.outsystemscloud.com`, sem `--publish`. O código confere: baixa, pede as assinaturas pela bridge e aplica o refresh só no arquivo local `.refreshed.oml`; publica apenas com `--publish` (Program.cs:230-240, 388-393; ReferenceRefresher.cs:101-118).
   - Aceite: log `signature HMISPdfText: N bytes hash=861bafeb…`.
   - Isso prova a G2 (op `signature` sob SSO) **e** entrega o oráculo: o OML publicado com a referência feita à mão.
   - Se HMISPdfText não aparecer, a versão publicada não tem a referência.
2. **Offline.** `anvil merge-probe --base <cópia de HMISJHA_CS v5545> --foreign gaps\probe1\out-ext-reference.oml` (o verbo existe: Program.cs:148). Aceite: Create sem conflitos.
3. **Código.** `anvil signature`, com testes offline estendendo NativeReferenceImportTests e um teste de recusa de escrita no lease.
4. **Leitura ao vivo, com seu OK.** `anvil signature --producer HMISPdfText …`. Aceite:
   - SignatureHash igual ao do servidor;
   - VersionId estável;
   - keys de ExtractPdfText e PdfPageText iguais às do xifgen.
5. **Offline.** `apply` sobre uma cópia da v5545 (sem a referência) com `reference` + um op logic mínimo que chama ExtractPdfText e atribui `Pages`.
   - Aceite: isValid e ReferenceStructure PdfPageText presente.
   - Comparar com o oráculo do passo 1: OriginalKeys, ReferenceHash e Full/CompatibilitySignatureHash.
   - Se a structure faltar, implementar o kind `structure` e repetir.
6. **Escrita, com suas palavras.** `deliver --module ZZ<teste>_CS --capture-producer HMISPdfText` num módulo de teste ZZ. Depois check e publicação conforme a política. Executar ExtractPdfText com o PDF de seed UPL-0007-01.
7. **Depois.** Republicar a extensão e provar o refresh com seleção explícita de hash (ReferenceSignatureMerge). Hoje só há o contra-exemplo em PROVAS.md:239.

#### Perguntas em aberto

- Você publicou o HMISJHA_CS depois de adicionar a dependência? Nenhuma base local a tem.
- Autoriza as leituras ao vivo dos passos 1 e 4?
- Prefere captura explícita (arquivo) ou automática no deliver (`--capture-producer`)?
- Fixar também o SHA-256 do `.xif` (ADR-019), ou basta SignatureHash + VersionId?
- A remoção de dependência entra no mesmo verbo? Hoje só a opção C daria esse caminho.

---

### 2.2 Usuários finais e papéis

#### Estado atual (com evidência)

- **O canal SSO não tem nenhuma operação de usuário, papel, timer ou dados** (EnvironmentOperations.cs:11-17). A bridge recusa o resto (EnvironmentSessionHandler.cs:35-36).
- O Studio 11 também não tem essa API. A varredura de metadados das DLLs do SS4 achou só `IDataService.Get/Insert/Update/DeleteRecords`, sem projeção de atributos, e `EspaceTenants`.
- **Papéis lidos offline** [offline] com `inspect --kind Role` (`gaps\roles-JHACS.json`, `gaps\core-roles.json`), todos Public e persistentes, com Check, Grant e Revoke:
  - AgentOps_Core_CS: AgentAdmin e AgentAuditor;
  - HMISJHA_CS: Planner, ContentReviewer, DemoAdmin e SmeReviewer.
  - O HMISJHA_CS referencia só AgentAdmin do Core (`gaps\refs-JHACS.json`).
- **Lógica de concessão gerável** [offline]. `gaps\probe-role-admin.json` → `probe-result.json`: GrantPlannerRole, GrantAgentAdminRole, RevokePlannerRole, CheckRole, aggregate de User por Username e timer com Schedule "When Published". Resultado: accepted, isValid, 0 mensagens. As chamadas resolvem por `IActionSignature:` (LogicOrder.cs:56-58).
- **Timer "When Published" dispara neste ambiente** [vivo, 2026-09-09] (kernel\docs\tasks\2026-09-09-post-reinstall-readiness.md:26). Falta provar o Grant dentro do contexto do timer.
- **Criação de usuário pela entity action do (System) + EncryptPassword já funcionou** [vivo, laboratório] (kernel\scripts\probes\highcode\csharp_runtime_lab.py:37-38, 46-57; PROVAS.md:218). Porém o laboratório embute chave e senha literais no OML (:44-56), um padrão que **não** pode ser copiado.
- **Users API** (https://success.outsystems.com/documentation/11/reference/outsystems_apis/users_api/): User_Create e User_CreateOrUpdate exigem o papel UserManager. Não há ação de concessão de papel, convite nem reset. Há User_GetIdByUsername e EncryptPassword.
- **`set-user-provider`** só troca o provedor e republica (Program.cs:440-445; Publisher.cs:108-129).
- **`o11_data` é WIP por cofre** (op:\kernel\src\Anvil.Cli\DataCommand.cs:23-26), não rastreado e ausente da release SSO. O verbo `data` está desligado para O11 (lanes.mjs:60-62, 78).
- **Login de demo da v6.1** (kernel\docs\specs\hmisjha\delta-v61.md:8-26), conferido por mim:
  - `ListDemoLoginAccounts` e `SignInDemoAccount` são anônimas e entram por `Login(UserId)` do (System);
  - `IsDemoLoginEnabled` vem com default True;
  - `DemoLoginUsernames` = as seis contas;
  - quem entra cai numa tela conforme o papel (Planner/SmeReviewer → fila JHA; AgentAdmin/AgentAuditor → Agent Operations).

#### Opções que sobreviveram

| Opção | Mecanismo | Viabilidade | Esforço |
|---|---|---|---|
| **A (recomendada)**: manifesto + reconciliação | Static `AccessManifest` (Username, RoleCode, Grant/Revoke, ManifestVersion). Entidade não-static `AccessState` com a última versão aplicada, que recusa downgrade. Ação privada `ReconcileAccess`: acha o usuário, pula inativo, faz Check e depois Grant/Revoke por Switch sobre uma allowlist fixa. Timer "When Published". `AccessAudit` sem PII. Fica **nos módulos donos** (Core para AgentAdmin/AgentAuditor, HMISJHA_CS para os quatro de UI) para não criar referências cruzadas. A alternativa é um módulo de acesso com referências pelo op `reference`. | Provável | 1–2 dias |
| **Leitura por GET com HMAC** (fase 2) | GET só-leitura no módulo de acesso que devolve `AccessSnapshot` (UserId e um booleano por papel, sem nome nem e-mail). É chamado pelo executor HTTP que já existe. O segredo fica numa site property que você define e numa entrada de cofre que você provisiona para o CLI. O agente nunca vê o segredo. | Provável | +1 dia |
| **B: Edit Data pela sessão do Studio** | Operações `data-read` e `data-write` na lista fechada, com fila `AccessCommand` e timer de polling. **Exige trocar o Anvil.Core carregado no Studio** (talvez só ele [inferência]: a allowlist e a execução vivem no Core, EnvironmentSessionHandler.cs:35, 50-51). Só em Development/Non-Production (https://success.outsystems.com/documentation/11/building_apps/data_management/data_operations/edit_data_while_developing/). | Provável, se você decidir | 2–4 dias |
| **C: REST administrativo com HMAC** | Grant e Revoke por HTTP autenticado, sem publicação a cada mudança. REST com autenticação Custom já foi provado offline e há jobs de REST exposto (kernel\tests\jobs\rest-expose.json; PROVAS.md:58, 282). | Provável | 2–3 dias |
| **D: criação de conta sem senha do agente** | Ação privada `CreateDemoUser` com `System.CreateUser` e `Password = EncryptPassword(<aleatório gerado e descartado no servidor>)`. Você define a senha real no app Users. Nunca concede UserManager. | Provável. O mecanismo foi provado; a variante com senha descartada, não. | ~0,5 dia sobre A |

**Rejeitadas:**
- LifeTime API v2: cuida de usuários de TI, não de usuários finais (https://success.outsystems.com/documentation/11/reference/outsystems_apis/lifetime_api_v2/).
- Service Center: não tem API de usuário final.
- Edit Data em `System.User`/`User_Role`: o Studio bloqueia entidade referenciada e a leitura traria o hash de senha (op:\kernel\docs\mapa\2026-09-06-edit-data-investigacao.md:39-40; EntityData.cs:43-51).
- Automação da UI do app Users: exigiria senha e teclado.

**Afirmações da investigação que foram corrigidas:**
- "Não há ponto de execução em runtime": existe execução HTTP em laboratório (csharp_runtime_lab.py:173, 201).
- "When Published não provado": está provado (readiness :26).
- "Users só expõe 5 ações": essa lista é o que o consumidor importou, não a exposição do produtor.
- "C é a única que funciona em produção": A também funciona, porque o timer roda na implantação [inferência].

#### Recomendação

1. **Agora, sem trocar DLL:** A, nos módulos donos.
   - ManifestVersion monotônica, com recusa de downgrade (protege contra rollback de versão).
   - Allowlist só de papéis persistentes das suas apps, nunca papéis do módulo Users nem UserManager.
   - Recusa de conta real listada em `DemoLoginUsernames` e aviso ao conceder papel administrativo a conta de demo.
2. **Fase 2:** conferência por GET com HMAC. B fica como alternativa em Dev, se você aceitar trocar o Core no Studio.
3. **Contas:** a criação continua humana, como você fez agora, até provar D com senha descartada no servidor.
4. **Antes de escrever lógica nova:** inspecionar só-leitura os produtores Users, UsersServices, UsersLibrary e UserPermission_CS, que o `referenceable` listou. Pode já existir gestão de papéis ali.

#### Contrato proposto

```
ssam access plan  --lane o11 --manifest <abs>.json                       (offline; sem palavras)
ssam access apply --lane o11 --manifest <abs>.json --words "<suas palavras>"
ssam access verify --lane o11 [--role HMISJHA_CS.Planner]                 (fase 2; GET HMAC; sem palavras)
MCP: o11_access {action: plan|apply|verify, manifestPath, words?}
```

Manifesto:
```json
{"environment":"personal-2qqw9srv.outsystemscloud.com","manifestVersion":1,
 "entries":[{"username":"Planner","demo":true,"role":"HMISJHA_CS.Planner","action":"grant"}]}
```

**`plan`**:
- lê os papéis dos OMLs atuais (`inspect --kind Role`);
- valida a allowlist, a versão monotônica, o módulo dono e a regra de demo;
- gera um job por módulo dono e roda `check-job` e `apply` offline;
- devolve: contagens por módulo, hashes dos usernames, avisos e o sha256 de cada job.

**`apply`**:
- deliver nos módulos donos;
- publicação só pela política que você escolher (a entrada pública `ssam publish --lane o11` hoje recusa: lanes.mjs:63-65; prova SSO:76);
- recibo com `manifestSha256`, `wordsSha256`, `operationId`, módulos, versões e contagens. **Sem nomes em claro.**

**Servidor**: `AccessAudit`, com UserId, RoleCode, Action, Outcome, ManifestVersion, AuthorizationDigest e AtUtc. Nenhum endpoint na fase 1: ações privadas e o timer como único ponto de entrada.

#### Requisitos de segurança

- O agente nunca gera, vê, guarda nem digita senha. A senha comum informada no pedido não foi usada nem gravada: não aparece em `gaps\` nem nos docs, conferido por grep.
- O `AuthorizationDigest` numa fila (opção B) é **auditoria, não autorização**: o servidor não o verifica. Isso precisa estar declarado.
- Com o login de demo ligado, qualquer papel dado às seis contas vale para qualquer visitante (delta-v61.md:11, 25-26; decisão aceita em kernel\docs\specs\hmisjha\DECISOES.md:60-76).
- O `ListDemoUsers` já entregue devolve Name e Username (hmisjha\d-u6-demo.json:1236-1266). Qualquer snapshot lido pelo SSAM deve projetar só UserId e booleanos.

#### Plano de prova

1. **Feito, offline.** Papéis e probe de Grant/Revoke/Check com o timer.
2. **Offline.** Gerar os jobs completos sobre as bases atuais (HMISJHA_CS v5545 e Core v5546; os probes usaram v5540/v5541). Rodar `check-job` e `apply`. Conferir que nenhuma ação é pública e que não há referência a UserManager.
3. **Leitura ao vivo, com OK.** Inspecionar a assinatura de Users, UsersServices, UsersLibrary e UserPermission_CS.
4. **Escrita, com palavras.** Manifesto com 1 conta e 1 papel, deliver e publicação. Você confere no app Users que o papel entrou; depois uma revogação sai. Isso prova o Grant dentro do timer.
5. **Fase 2.** GET HMAC do snapshot.
6. **D.** `CreateDemoUser` numa conta de teste. Você define a senha e faz o login. Varrer recibos e logs atrás de senha, nome ou e-mail.

#### Perguntas em aberto

- Lógica nos módulos donos ou num módulo dedicado?
- Publicar a cada mudança de papel é aceitável? Quem publica?
- O SSAM deve criar contas ou só conceder e revogar? Se criar: a conta nasce ativa ou inativa?
- Usernames de demo no manifesto publicado são aceitáveis? Para pessoas reais seria preciso B ou C.
- O propósito do ambiente é Development/Non-Production? Isso é pré-requisito de B.

---

### 2.3 Runtime sem GUI: Run Now, action de teste, entidades, logs e evidência

#### Estado atual (com evidência)

- **"O SSAM não executa actions"** (kernel\docs\specs\hmisjha\GUIA-IMPLEMENTACAO.md:258, :1195).
- **O gate runtime aceita texto livre.** Ele cruza `testId` e aceita `result` ∈ {pass, passou, ok}, sem recibo, hash nem versão; sem evidência sai com código 3 (hmisjha\padroes\o11_padroes.py:2848-2863, 2910-2914; exemplo em padroes\neg\runtime-pass.review.json:3-10).
- `publish-smoke` e `edit-smoke` só publicam (Program.cs:149-150, 358-372).
- O canal SSO não tem dados, timer nem execução (EnvironmentOperations.cs:11-17; HeadlessSession.cs:21-27; Dispatch.cs:12).
- **"Run Timer in Service Center" do Studio só abre uma URL no navegador**, sem token. Depende de feature flag e de ambiente Development/NonProduction (decompilado em `C:\Users\andre\ODC3\decompiled\o11\`: TimmerCommands.cs:16-53; ServerCommonService.cs:86-111).
- **O smoke do modelo:**
  - `RunModelSmokeTest` é privada e recusa sessão de usuário (hmisjha\k-smoke.json:15, 47-58);
  - lê o **primeiro** ModelProfile Active por Id (:80-85) e, sem perfil, **não grava nada** (:87-91);
  - o timer não tem propriedade Public (ITimer.cs:8-51), então chamar de fora exige um wrapper (https://www.outsystems.com/ideas/11616/make-wake-timer-actions-public/).
- **Pré-condições do InvokeModel**, conferidas por mim:
  - static `ModelApiRoute` com o registro OpenAI ChatCompletions e AllowedBaseUrl `https://api.openai.com/v1` (hmisjha\m-invoke.json:9-19);
  - perfil com BaseUrl idêntico a esse valor e `Site.OpenAIApiKey` não vazia (:305-308);
  - `OpenAIApiKey` é site property do **AgentOps_Model_CS**, marcada IsSecret (hmisjha\agentops-model-cs-settings.json:11; m-contract.json:7).
- **Seed do perfil existe, mas nada o carrega.** `openai-chat` com status Active e SecretRefName OpenAIApiKey (hmisjha\seed\seed-manifest.json:1659-1678). `UpsertModelProfile_Impl` existe para as telas de governança (hmisjha\k-governance.json:1650-1654).
- **Logs.** Nenhum uso de PlatformLogs no kernel. A doc exige "Add System Dependencies" (https://success.outsystems.com/documentation/11/monitoring_and_troubleshooting_apps/logging_database_and_architecture/log_data_reference/). O `referenceable` [vivo] lista PlatformLogs `UhaSFT0UQkuCV6RRm_tPnQ`, HTTPRequestHandler e AgentOps_Core_CS `qspJUQ1XJUGQjtUhmIrpQQ` (`gaps\referenceable.json`).
- **Probe offline:** wrapper Wake público + REST com Authentication=Custom sobre uma cópia do Core v5540. Resultado: 20 ops, 0 mensagens, OnAuthentication criado sozinho (`gaps\apply-result.json`).
- **Precedente HTTP 13/13** [vivo, 2026-09-09, **antes** do SSO obrigatório e com REST anônimo] (readiness :26-30).

#### Opções que sobreviveram

| Opção | Mecanismo | Viabilidade | Esforço |
|---|---|---|---|
| **A: Run Now humano** | Você roda o Run Now. O SSAM prepara a checagem e registra a runtimeEvidence. | Provada | 0 código |
| **A+: link direto do Run Now** | O SSAM monta offline a URL que o comando do Studio monta, com as chaves do módulo e do timer. Falta decodificar constantes ofuscadas (TimmerCommands.cs:42-53). | Incerta | < 0,5 dia |
| **F: navegador assistido** | O agente navega no seu Chrome já logado, pede confirmação antes de clicar Run Now e lê Monitoring > Timers/Errors como texto. Sem cookies e sem senha. Com o login de demo da v6.1 cobre também o E2E por papel sem senha [inferência: depende da v6.1 estar publicada]. | Provável | Roteiro |
| **B' (recomendada como permanente)**: sonda REST com token efêmero | No Core: ação pública `RequestModelSmokeRun`, que só chama `WakeModelSmokeTimer`. Módulo sonda ZZ numa app de testes, com REST `RuntimeProbe` Custom, onde OnAuthentication compara o SHA-256 do header com um hash gravado no deliver e aplica validade. Endpoints: `POST /smoke/run` (1/min), `GET /smoke/latest?since=`, `GET /logs/summary?since=&module=` (só contagem, id e hash). Tem kill switch e trilha ProbeCall. O SHA-256 no servidor pode seguir o padrão `HashTextSha256`, que calcula no banco (m-invoke.json:392) [inferência de reuso]. | Provável | 1–2 dias |
| **C: timer "When Published" de smoke** | Smoke pós-deploy protegido por site property com default False. | Provada (mecânica) | < 0,5 dia |
| **D': operação `query-preview` (TestQuery/Preview Data) pela bridge** | Uma operação só-leitura, restrita a aggregates, sobre um OML de sonda **não publicado**. Cobre entidades e PlatformLogs sem endpoint (WebServicesServerCommunicationsProvider.cs:1306-1318; TestQuery.cs:484-512). **Exige trocar o Anvil.Core no Studio.** Prototipar no SS5. | Provável, se você decidir | 1 dia + troca |
| **D: operação `entity-records`** | Edit Data pelo login emprestado. Precisa ajustar o EntityData, que usa `session.Login`, nulo no modo emprestado (HeadlessSession.cs:85). Mesma troca de DLL. | Provável, se você decidir | 0,5–1 dia + troca |
| **E: login SSO próprio do CLI (PKCE)** e **Test Framework/BDD** | Ficam em pesquisa. A parte online do xifpub nunca rodou (kernel\tests\jobs-live\hmisjha\ext\HMISPdfText\xifpub\README.md:189-192). O Test Framework exige baixar um componente da Forge, com sua permissão. | Incerta | — |

**Descartadas:**
- **G, TestAction:** recurso de suporte, que exige Debug Mode (CommandLineProcessor.cs:5290-5295). Só o TestQuery é de uso comum.
- **H, depurador headless, LifeTime ou PerformanceMonitoring:** exigem credencial (op:\docs\DEBUGGER-HEADLESS.md:48-50; https://success.outsystems.com/documentation/11/reference/outsystems_apis/performancemonitoring_api/).
- **B original ("janela armada sem segredo"):** na janela, qualquer pessoa na internet chama o endpoint. As palavras de autorização só são checadas no CLI. Um timer "When Published" arma a janela em **qualquer** publicação, não só na autorizada [inferência pela semântica do schedule].

**Correções:**
- "B é a única que respeita sem senha e sem trocar DLL": E e F também respeitam.
- "Quase todas as peças provadas": não. Ainda não têm prova viva o HTTP depois do SSO, o 401, o Wake por REST e a referência a PlatformLogs.
- A frase sobre client credentials da 11.23.1 fala de **consumir** REST, não de expor.

#### Recomendação

- **Hoje:** A, com a pré-condição do perfil. F é opcional para ler e registrar sem transcrição manual.
- **Permanente:** B', com três condições:
  1. token efêmero ou InternalAccess, nunca janela aberta;
  2. logs só agregados;
  3. refazer o probe sobre o Core atual e **coordenar com a sessão que prepara os deltas f-v6/f-v61 do Core** (kernel\.local\hmisjha\a2b\gen_f_v61_core.py, sobre v5543; a base local mais nova já é v5546).
- **Complemento, com troca de DLL por sua decisão:** D' antes de D.

#### Contrato proposto

```
ssam runtime smoke run    --lane o11 --module AgentOps_Core_CS --timer ModelSmokeTimer --words "<suas palavras>" [--operation-id <uuid>] [--timeout 360]
ssam runtime smoke latest --lane o11 [--since <utc>]                               (sem palavras)
ssam runtime logs         --lane o11 --since <utc> --module AgentOps_Core_CS      (agregados; sem palavras)
ssam runtime evidence     --lane o11 --test-id <id> --from-receipt <abs>          (gera runtimeEvidence)
MCP: o11_runtime {action: smoke-run|smoke-latest|logs|evidence, ...}
```

**`smoke run`**:
- operationId com recibo e lock: um operationId repetido devolve o recibo, sem reenviar;
- POST e depois polling de `/smoke/latest` até `RanOn > requestedAt` ou até o timeout (o timer tem TimeoutInMinutes=5);
- saída: `{operationId, requestedAtUtc, ranOnUtc, isSuccess, httpStatus, latencyMs, errorCategory, publishedVersion, receiptPath, receiptSha256}`.

**`evidence`**: emite `{testId, result, test, evidence:"recibo <caminho> sha256 <…>; Core v<N>; operationId <…>", date}`, que o `--stage runtime` consome. Depois, endurecer o gate para exigir hash de recibo e versão publicada.

**Token**:
- gerado pelo CLI a cada deliver da sonda;
- no OML vai só o hash;
- o valor fica apenas no recibo local da tarefa e nunca aparece no chat nem em log.

Isso depende da sua aprovação (pergunta abaixo).

#### Requisitos de segurança

- O endpoint nunca é anônimo. Throttle, kill switch em site property e trilha ProbeCall.
- Os logs saem só como contagem, id e hash. Redigir `sk-` não basta: Log_Integration pode ter cabeçalhos ou corpo de chamadas à OpenAI [inferência].
- A sonda fica em módulo ZZ ou numa app de testes que nunca vai para produção (kernel\AGENTS.md:181-182). O Core é publicado por você.
- Custo OpenAI por execução: limitado pelo throttle; o mesmo timer não roda em paralelo (https://success.outsystems.com/Documentation/11/Developing_an_Application/Use_Timers/Create_and_Run_Timers).
- D e D' ampliam a bridge local para ler qualquer entidade. Só `readOnly`, só aggregates, sem SQL livre nem DML.

#### Plano de prova

1. **Hoje:** A (seção 3).
2. **Offline:** refazer os jobs do wrapper e da sonda sobre o Core ≥ v5546, depois de coordenar com a sessão f-v61. Rodar `apply`, `check-job` e `o11_padroes` com `--work` em `gaps\`.
3. **Leitura ao vivo, com OK:** GET HTTP num endpoint de laboratório já publicado, para confirmar que o runtime HTTP não depende do SSO das ferramentas de desenvolvimento.
4. **Escrita, com palavras:** deliver e publicação **só da sonda ZZ** com `GET /smoke/latest`. Aceite: 401 sem token e 200 com token. Não precisa mudar o Core.
5. **Ao vivo:** referência a PlatformLogs (exige "Add System Dependencies") e `/logs/summary`.
6. **Core:** você publica o wrapper. Então `POST /smoke/run` e polling, comparando com Monitoring > Timers.
7. **Negativos:**
   - POST repetido em menos de 60 s é recusado;
   - operationId repetido devolve o recibo;
   - token expirado dá 401;
   - varredura de segredos nas respostas e nos recibos;
   - o gate sai com 0 usando a evidência e com 3 sem ela.

#### Perguntas em aberto

- Token efêmero gerado pelo CLI ou InternalAccess com o seu IP (configurado por você no Service Center)?
- Autoriza a mudança pública no Core (`RequestModelSmokeRun`)? A sonda vai para ZZ ou para uma app "AgentOps Tests"?
- Quais logs podem sair, mesmo agregados?
- Quer E2E por papel pelo login de demo no navegador, com você presente?

---

## 3. Caminho de HOJE para a PoC HMIS JHA (mínimo de cliques)

**Passo 0: segurança (você, cerca de 5 min; recomendado antes da demo)**
- Troque a senha comum das seis contas por senhas fortes e distintas no app Users, sem enviá-las no chat. O host é público e duas contas terão papéis administrativos (AgentAdmin, DemoAdmin).
- Se a v6.1 (login de demo) estiver publicada: com `IsDemoLoginEnabled` ligado (default True), **qualquer visitante entra como qualquer conta de demo** (delta-v61.md:11, 25-26). Deixe ligado só durante a demo e desligue no Service Center depois.
- O lado bom: com o login de demo, nem você nem o agente precisam digitar senha para a demo.

**Passo 1: papéis dos usuários de demo (você, 6 concessões, se ainda não fez)**

Os usernames coincidem com os papéis e com `DemoLoginUsernames` (delta-v61.md:11-14). O mapeamento abaixo é inferência; confirme.

| Username | Papel | Módulo dono |
|---|---|---|
| Planner | Planner | HMISJHA_CS |
| SmeReviewer | SmeReviewer | HMISJHA_CS |
| DemoAdmin | DemoAdmin | HMISJHA_CS |
| ContentReviewer | ContentReviewer | HMISJHA_CS |
| AgentAdmin | AgentAdmin | AgentOps_Core_CS |
| AgentAuditor | AgentAuditor | AgentOps_Core_CS |

No app Users (`https://personal-2qqw9srv.outsystemscloud.com/Users`), abra cada usuário e conceda o papel (procedimento em https://success.outsystems.com/documentation/11/user_management/grant_and_revoke_end_user_roles/). Para conferir: a página do usuário no app Users ou, se a v6.1 estiver publicada, os RoleLabels no seletor do login de demo.

**Passo 2: HMISPdfText (você não clica nada; o SSAM faz 1 leitura com seu OK)**
1. Confirme se publicou o HMISJHA_CS depois de adicionar a dependência. Nenhuma base local a tem (v5541/v5542/v5545).
2. Com seu OK, o SSAM roda:
   `dotnet C:\Users\andre\SSAM-Hybrid-o11-sso\kernel\.local\cli\anvil.dll refresh-refs --module HMISJHA_CS --out <gaps>\refresh-hmisjha --all --read-only --host personal-2qqw9srv.outsystemscloud.com`
   Esse comando:
   - baixa a versão publicada, que vira a **nova base** de todo job que chamar ExtractPdfText;
   - prova a op `signature` sob SSO;
   - deixa um `.refreshed.oml` só local, que **não** deve ser entregue.

**Passo 3: smoke do modelo (você, cerca de 6 cliques; 1 chamada à OpenAI)**
1. **Chave:** confirme que o `OpenAIApiKey` foi definido na site property do módulo **AgentOps_Model_CS**, que é onde o adaptador lê (m-invoke.json:224, 306).
2. **Perfil:** é preciso existir exatamente um ModelProfile Active (o timer pega o de menor Id: k-smoke.json:80-85), com os valores do seed (seed-manifest.json:1661-1668):
   - Provider OpenAI;
   - ApiStyle ChatCompletions;
   - Model gpt-6-sol;
   - BaseUrl `https://api.openai.com/v1`, **idêntico** ao da rota (m-invoke.json:18, 306);
   - Status Active;
   - SecretRefName OpenAIApiKey.

   Crie pela tela de governança do AgentOps (UpsertModelProfile_Impl), entrando como AgentAdmin, ou por View/Edit Data no SS4.
3. **Run Now:** Service Center > Factory > Modules > AgentOps_Core_CS > Timers > ModelSmokeTimer > Run Now (https://success.outsystems.com/Documentation/11/Developing_an_Application/Use_Timers/Create_and_Run_Timers). Alternativa: no SS4, botão direito no timer > "Run Timer in Service Center", se o flag estiver ativo.
4. **Leitura:** Service Center > Monitoring > Timers (https://success.outsystems.com/documentation/11/building_apps/using_timers/monitor_timers/) e o último ModelSmokeResult (View Data no SS4 ou card W05): RanOn, IsSuccess, HttpStatus, LatencyMs, ErrorCategory.

   Como interpretar:

   | Sintoma | Causa provável |
   |---|---|
   | Nenhum registro novo | Não há perfil ativo (k-smoke.json:87-91) |
   | NotConfigured "route, model, allowed base URL or API key is missing" | Perfil, rota ou chave (m-invoke.json:306-308) |
   | "Model adapter logic is not installed yet" | A parte m-invoke do AgentOps_Model_CS não foi publicada (m-contract.json:191) |
   | AuthFailed | Chave inválida (m-invoke.json:28) |

5. **Evidência:** você me passa os quatro valores, ou eu os leio no seu navegador com sua confirmação (opção F). O SSAM grava a runtimeEvidence com a versão publicada. Lembrete: hoje o gate aceita texto livre (G6).

---

## 4. Ordem de implementação e o que NÃO fazer

**Ordem sugerida**
1. Seção 3 (hoje, sem código).
2. Prova G2 com `refresh-refs --read-only` (leitura, com OK).
3. `anvil signature`: lease `readOnly` testado, guarda de VersionId, reuso do NativeDependencyReader, `--pin-xif` opcional.
4. Prova offline HMISPdfText com `Pages`/PdfPageText. Kind `structure` só se necessário.
5. `--capture-producer`, `producers` no MCP e `dependencies` em propose/continue. Entrega de teste em módulo ZZ.
6. `ssam access` (fase 1, módulos donos): offline, depois 1 concessão ao vivo com palavras.
7. `ssam runtime` B', depois de coordenar com a sessão f-v61. Provas vivas na ordem de 2.3.
8. A' para eSpace (refresh + ReferenceSignatureMerge).
9. Se você decidir: operações de dados D'/B, prototipadas no SS5.
10. Remoção de dependência pela opção C.

**O que NÃO fazer**
- Não usar, repetir nem gravar a senha comum ou qualquer senha. O agente não cria contas até D ser provada e autorizada.
- Não rodar `open_studio.ps1` sem `-NoBuild` e não trocar Anvil.Core ou Anvil.Bridge no SS4 sem decisão sua.
- Não usar `LoadExtension`/`AddDependency` (B-ext) nem o atalho de hash calculado a partir do OML.
- Não usar `--producer X=env:X` nem `source: server` dentro do op.
- Não entregar o `.refreshed.oml` do probe.
- Não fazer Edit Data em `System.User`/`User_Role` nem `GetRecords` sem projeção sobre User.
- Não expor `Log_*` crus nem endpoint "armado" sem segredo.
- Não pôr chave ou senha literal em OML: o padrão de `csharp_runtime_lab.py:44-56` não se repete.
- Não conceder UserManager nem papéis do módulo Users.
- Não publicar o Core por script: no produto, quem publica é você (kernel\AGENTS.md:181-182).
- Não usar TestAction, o depurador O11 ou as APIs LifeTime/PerformanceMonitoring.
- Não automatizar a UI do Studio nem usar teclado ou mouse. A automação de navegador (F) só com confirmação por clique irreversível.

---

## 5. Notas de método e ressalvas

- **Decompilado.** A pasta `C:\Users\andre\GitSSAM\.ssam\local\native-dll-decompile\source\` não existe. Os investigadores usaram ilspycmd em `gaps\decomp\` e `C:\Users\andre\ODC3\decompiled\o11\`.
- **Bases defasadas.** Os probes usaram Core v5540 e HMISJHA_CS v5541. As bases locais mais novas são Core v5546, HMISJHA_CS v5545 e HMISJHA v5544 (`kernel\.local\hmisjha\bases\`). Refazer sobre elas antes de implementar.
- **Escrita fora de `gaps\`.** Um `anvil inspect` sem `--work` gravou settings em `%TEMP%\sshedless-work`. Desvio declarado e de efeito pequeno. Probes futuros sempre com `--work`.
- **Superfícies de laboratório.** O ZZHighCodeLab_CS tem chave e senha literais no modelo. O ZZBoundaryComposition_CS tem um REST anônimo que provavelmente continua publicado [inferência]. Decida se despublica ou endurece.
- **Conferido diretamente nesta síntese:**
  - o caminho só-local de `refresh-refs` e o `--read-only` da sessão conectada (Program.cs:230-240, 388-393; ReferenceRefresher.cs:101-118);
  - as pré-condições do smoke (k-smoke.json:47-91; m-invoke.json:9-19, 305-308, 392; seed-manifest.json:1659-1678; agentops-model-cs-settings.json:11);
  - o login de demo (delta-v61.md:8-26);
  - a lista de bases locais.

  O restante vem das investigações e das verificações adversariais, com as correções já incorporadas.