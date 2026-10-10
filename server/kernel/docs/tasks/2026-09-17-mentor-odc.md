# Como funciona o Mentor do ODC Studio

Levantado em 2026-09-17 sobre a instalação `C:\Program Files\OutSystems\ODC Studio\ODC Studio`. As afirmações abaixo
estão ancoradas em tipos e literais que conferi nos binários; onde o Presenter guarda as strings criptografadas, digo
que não há evidência em vez de supor.

## O desenho em uma frase

**O modelo de linguagem roda no servidor; as ferramentas rodam dentro do Studio.** O Mentor não envia o módulo: envia
o que você está olhando, e o agente remoto **chama de volta** ferramentas locais que leem e escrevem o modelo pela
Model API, num clone do módulo, e o resultado entra por merge de três vias.

## As peças

| Camada | O que é | Evidência |
|---|---|---|
| Interface | web view CEF com pacote React (`ChatWithAgent.view.js`), espelhada por `ChatWithAgentViewAdapter` | `ServiceStudio.WebViewImplementation.dll`, `libcef.dll` |
| Orquestração | `ChatWithAgentPresenter` + `ConversationManager` | `ServiceStudio.Presenter.dll` |
| Transporte | WebSocket JSON-RPC 2.0. Cliente chama `converse`, `getAgentModes`, `stateChanged`; servidor chama `chatUpdate` de volta | `OutSystems.AI.AgentAdapter.dll` (literais conferidos) |
| Endereço | `wss://<tenant>/api/ai-studio-agent/v1/...`, autenticação `Bearer` do login ODC, cabeçalhos de aplicação, tipo de asset e tenant | domínio `ai-studio-agent` em `ServiceStudio.ServerCommunications.API.dll` |
| Ferramentas | 49 registradas no cliente, publicadas ao servidor por descoberta OpenRPC | `OutSystems.AI.ClientTools.dll`, `.Labs.dll` |

Os pedaços que chegam em streaming têm tipo: `message_chunk`, `reasoning_chunk`, `plan_chunk`, `tool_begin`,
`tool_end`, `wait_user_input`, `status_update`, `chat_completed`, `error`.

## O que o Mentor recebe como contexto

Por turno, apenas **identificadores do que está aberto e selecionado**: o editor em foco, a árvore do módulo, e as
mensagens de validação selecionadas. Cada área aponta elementos por chave, tipo, caminho, nome e propriedade em
edição. O módulo inteiro **não** viaja no prompt.

O modelo só é lido quando o agente chama de volta as ferramentas de leitura (`runQuery`, `getElements`,
`getValidationMessages`, `getConversationContext` e cerca de 25 leitores de laboratório). Se o modelo mudou desde o
último instantâneo, o cliente avisa com `stateChanged` antes de conversar, para invalidar cache do lado do servidor.

## Como a resposta vira alteração no modelo

1. O Studio **clona o módulo** em memória e carrega o clone marcado como `CreatedByTool.ODCStudioMentor`. Tudo o que
   o agente fizer nasce ali, isolado, com o hash do original guardado.
2. As ferramentas de escrita atuam no clone. A principal é **`applyModelApiCode`**, que recebe
   `{code, imports}` e executa **C# da Model API**.
3. Cada ferramenta roda dentro de um comando com identificador de repetição e, em caso de exceção, **desfaz o último
   comando**.
4. No fim, um **merge de três vias** (base = instantâneo original, deles = clone do agente, nosso = módulo aberto)
   aplica as mudanças. Se o agente pediu revisão, abre a tela de revisar; senão entra automático.
5. O desfazer oferecido no chat é o **merge inverso**.

## O detalhe que mais importa para nós

A execução de `applyModelApiCode` é feita por uma classe **pública** que vem na instalação:

```
OutSystems.ModelExtensions.ModelToCode.CSharpCodeExtensions   (OutSystems.ModelExtensions.ModelToCode.dll, 157 KB)

  public static Task<ExecutionResult> ExecuteRestricted(this IESpace eSpace, string modelAPICode,
        Action<ITransactionDetails> onTransactionCompleted, int timeoutInSeconds = 30,
        long? maxMemoryBytes = null, Action<ITransactionDetails> onTransactionBeingCompleted = null,
        params string[] imports)

  public record ExecutionResult(string StdOutLog, string StdErrLog, Exception Exception = null);
  public static readonly string[] DefaultImports  // 16 namespaces do Model API, prontos
```

O Mentor a chama com 500 MB e 30 segundos de teto. Junto vêm um validador de script (`CFlatScriptValidator`,
`ScriptValidationResult`, `ScriptError`, com formatação de erro) e carregamento em contexto coletável
(`CollectibleScript`), além do arranjo automático dos nós de fluxo criados e da coleta de mensagens de validação
**antes e depois** da execução, devolvidas ao modelo como retorno.

Ou seja: **a plataforma publica um executor isolado de C# da Model API**, com validador, limites e captura de saída.
É a mesma aposta que este projeto fez ao trocar a geração de JavaScript por verbos nativos, e está disponível para
ser usada, não apenas imitada.

## Permissão

Em camadas, nesta ordem: sessão ODC iniciada; uma chave de funcionalidade que pode liberar tudo; e então a permissão
`MentorUse` verificada por asset e por portfólio, ou seja, **controle de acesso do tenant, não licença de produto**.
Tipos de módulo em beta exigem ainda uma opção de laboratório. Os modos de agente (`getAgentModes`) vêm do servidor;
o cliente só repassa o modo escolhido, e o padrão por tipo de módulo é configurável remotamente.

## Acionar de fora da interface gráfica

Não há linha de comando, cano nomeado ou API documentada para disparar o Mentor: todos os pontos de entrada são menu,
barra ou atalho. Existem, porém, duas superfícies reais: um arquivo de sobrescrita de configuração em
`%LocalAppData%\OutSystems\ODC Studio\AppSettingsOverride.xml` permite trocar o endereço do servidor, o esquema e a
credencial; e o próprio cliente é um servidor JSON-RPC que publica suas 49 ferramentas por descoberta. Os nomes exatos
da seção desse arquivo estão entre as strings criptografadas do Presenter: **não há evidência** do literal.

## O que eu levaria daqui para o SSAM Hybrid

1. **Usar `ExecuteRestricted`** na faixa ODC como uma op nova: o agente escreve C# da Model API, a plataforma valida,
   isola, limita tempo e memória, e devolve saída padrão, erro e mensagens de validação. É a peça que falta entre
   "verbos fechados" e "código arbitrário".
2. **Clone mais merge**, em vez de escrever direto: clonar o módulo, deixar o agente trabalhar no clone, comparar e só
   então mesclar. Dá revisão, desfazer e isolamento quase de graça, e agora temos o `OdcDiff` para a comparação.
3. **O laço de validação** antes e depois de cada escrita, devolvido ao modelo como parte do resultado. É barato e é o
   que mais melhora acerto.
4. **Marcar a autoria no carregamento**, num ponto só, como eles fazem, em vez de carimbar objeto a objeto.
