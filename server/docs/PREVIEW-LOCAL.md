# Preview local no MCP

`ssam_preview` consolida a abertura, o estado e o encerramento dos previews O11 e ODC. A ferramenta está no servidor `ssam` e no catálogo consumido por `ssam_discover`.

## Uso na sessão

Comece pela descoberta, por exemplo:

```json
{"intent":"abrir preview local da tela sem publicar","lane":"odc"}
```

A descoberta retorna `ssam_preview`. Suas operações são:

| action | Resultado |
| --- | --- |
| `list` | Perfis preparados, app/ambiente, telas e limites. Aceita filtro `lane`, `app`, `tenant`, `profile`. |
| `open` | Inicia ou reutiliza uma sessão do perfil. Retorna `sessionId` e `browser.url`. Aceita `screen` por nome ou chave. |
| `status` | Estado do processo, revisão/hash da captura, build e última observação de renderização. |
| `refresh` | Solicita captura ao watcher configurado; sem watcher, somente relê o feed e retorna `captureRequested:false`. |
| `stop` | Encerra somente o worker, watcher e host pertencentes à sessão. |

Abra `browser.url` **visivelmente**, mantendo a aba durante o desenvolvimento. A ferramenta não abre browser headless, não clona uma página publicada e não publica o app. O processo Node do host roda sem janela de terminal; isso não torna o navegador headless.

Para consultar ou encerrar, envie `sessionId`. Para abrir, prefira `profile` retornado por `list`. App/ambiente ambíguos e telas não preparadas são recusados. Ausência de perfil é uma limitação informada, não autorização para improvisar um renderer ou executar scripts de laboratório na sessão de app.

O preview de merge (`studio_deliver` com `until:"preview"`, entre outros) continua separado. As frases “preview ODC sem publicar”, “preview O11 sem publicar” e “design time” apontam para o preview visual; um pedido de preview do manifesto/merge continua apontando para a entrega nativa.

## Cobertura atual

- **O11:** renderer nativo com artefatos do compilador original, entradas e dependências qualificadas. O perfil atual usa captura estática: **não há watcher O11 implementado nesta entrega**. Reabrir a página ou chamar `refresh` não captura alterações do Studio.
- **ODC:** watcher do modelo, captura, compilação e ativação do release, para o perfil previamente qualificado. O renderer usa o pipeline **O11 sobre modelo ODC adaptado**; não é equivalência geral com o runtime ODC. O adaptador atual está restrito ao módulo de prova Quotes, à identidade da sessão configurada e ao contrato vazio de backend.
- Os cenários são explicitamente fictícios, sem acesso ao backend real e sem validação dos acessos reais. Não estendem automaticamente a cobertura a outros apps, telas, actions, roles ou serviços.
- A observação de renderização pertence a um navegador e um build. Processo `running`, build pronto e tela renderizada são evidências diferentes. `readiness` distingue espera pelo build/navegador, renderização e falha. O host conserva a última tela quando uma atualização falha.

## Preparação pelo integrador

O catálogo privado padrão é `<raiz>/.local/preview/catalog.json`:

```json
{
  "schema": "ssam-preview-catalog/1",
  "profiles": [{"file":"<caminho absoluto do profile.json>","sha256":"<hash>"}]
}
```

`SSAM_PREVIEW_CATALOG` permite selecionar outro catálogo explicitamente. Catálogo, perfis, fontes capturadas, runtime proprietário, cenários e builds ficam fora do Git. Uma instalação sem catálogo retorna `installationRequired:true` em vez de anunciar apps inexistentes.

A API de manutenção `platforms/odc/facade/preview/prepare.mjs` exporta:

- `prepareProfile({directory,id,lane,target,screens,limitations,hostConfig,watcherConfig?,port})`: exige diretório novo e configurações de entrada qualificadas, com caminho/hash. Gera pins do código versionado, configuração do host e do watcher e recibo de preparação; todos os arquivos mutáveis ganham caminhos próprios. **Não copia o pacote privado de dependências** nem cria um compilador para um app arbitrário.
- `registerProfile({catalogFile,profile})`: valida e acrescenta o perfil, recusando ID duplicado. Operação de manutenção serializada pelo integrador, não exposta a sessões de app.

O host deve ter endereço loopback dedicado, porta fixa e contratos consistentes com sua captura. Cookies compartilham hostname entre portas: **trocar só a porta não isola duas sessões**. Para um cenário O11 novo, prepare outra origem e seu contexto/release correspondente. Não limpe o armazenamento de uma sessão em uso para contornar a validação de contexto. O perfil ODC atual mantém o endereço exigido por seu contrato e não deve ser duplicado em outro cenário no mesmo browser.

A configuração ODC aponta para um pacote privado qualificado do compilador por hash, seu implementation lock, o perfil nativo e a raiz da bridge anexada. O watcher valida PID, módulo, ambiente, versão da bridge, hash e recibo da captura antes de promover qualquer resultado. O pacote privado deve ser instalado no destino suportado; não fixe caminhos de checkouts antigos nem reutilize manifests históricos como entrega. Os fontes versionados não contêm esses caminhos.

Para distribuir: integre esta mudança a partir da worktree, instale os pacotes privados e prepare perfis atuais na raiz de destino; depois abra uma nova sessão MCP dessa versão. Esta mudança não altera a configuração global, não injeta DLL no Studio aberto e não promove automaticamente a worktree ao SSAM ativo.

## Sessões e recuperação

Cada perfil tem uma sessão sob `.local/preview/sessions/<id>`. A abertura tem exclusão mútua, cada execução recebe `instanceId`, log próprio e recibo. O endpoint de controle usa token privado e confirma a identidade da execução. `stop` não procura nem mata processos por nome/PID externo.

Um processo inacessível é `unreachable` com resultado incerto; outra chamada a `open` não cria um substituto. O integrador reconcilia o recibo/controle e o processo antes de recuperar a sessão. Lock de abertura abandonado não é removido automaticamente. Mudança de perfil com sessão ativa exige encerrar e reconciliar a versão anterior.

O watcher registra a intenção antes de pedir snapshot. Timeout após envio exige reconciliação; não autoriza replay. Mudanças rápidas se agrupam, uma captura/compilação roda por vez e uma revisão superada não é promovida. `refresh` também respeita a reconciliação.

## Validação

Testes versionados: `preview.test.mjs` (MCP/ciclo de vida), `preview-discover.test.mjs` (ODC/O11 e desambiguação de merge), `preview-pipeline.test.mjs` e `preview-capture.test.mjs` (concorrência, revisão obsoleta, indisponibilidade e recibos incertos). `tool-routes.test.mjs` verifica o catálogo contra o servidor vivo.

A validação de integração desta mudança abriu capturas qualificadas de GameStore/O11 e Quotes/ODC em hosts separados dos originais. O11 também passou por nova montagem do release para uma origem isolada. Isso verifica integração e renderização; não constitui uma nova prova de edição/captura ao vivo no ODC, nem implementa atualização automática O11.
