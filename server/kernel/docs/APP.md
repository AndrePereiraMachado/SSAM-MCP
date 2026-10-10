# Sessão de app no SSAM Hybrid

O fluxo atual entrega dados, roles, exceptions e actions por um contrato fixo. A linguagem cobre server/service/client,
mais screen actions e preparações em owners existentes. O catálogo fechado inclui os widgets de lógica e seus
contextos válidos. A conferência
lê assinaturas, expressões, chamadas e conexões do módulo. As políticas declaradas de autenticação, roles, parâmetros
e proprietário de registros são geradas pelo controlador. A instalação e a prontidão de cada faixa precisam ser conferidas na sessão; as provas abaixo registram estados históricos, não a configuração de uma tarefa nova.

Isso não significa cobertura total das regras de negócio. Execução no servidor/browser, transações completas, criação da UI,
integrações, timers e processos ainda têm etapas de cobertura pendentes. A matriz de widgets e os recibos do
laboratório estão no [comprovante de actions](proofs/2026-09-05-cobertura-actions.json).

## Começar: projeto de app ou perfil de CLI

Abrir SS4/SS5 ou carregar a skill não ativa o controlador. Uma sessão só está controlada quando
recebe as ferramentas `ssam_hybrid` **e** o identificador emitido pelo hook real `UserPromptSubmit`.
Não peça ao usuário `task_id`, não reutilize o de outra tarefa e não simule a captura para recuperar acesso.
Sem essas condições, informe que a integração da sessão está inativa; não afirme que o perfil controlado está ativo.

Para novas tarefas no desktop, prepare um projeto dedicado com o gerador de manutenção e um CLI validado:

```powershell
python scripts/configure_app_profile.py --workspace C:\Users\andre\SSAM-Apps --cli <cli-validado>\anvil.dll
python scripts/configure_app_profile.py --workspace C:\Users\andre\SSAM-Apps --cli <cli-validado>\anvil.dll --check
```

O gerador grava `.codex/config.toml` **nesse projeto**, com MCP e os dois hooks apontando ao mesmo workspace.
Não muda a configuração global, a base de confiança, credenciais nem as sessões de manutenção. Recusa substituir
configuração não gerenciada. `--out` permite preparar uma cópia para revisão antes da instalação.
O preflight estático distingue arquivos configurados de cliente ativo; ele não inicia Studio/worker,
não cria tarefa e não comprova a execução dos hooks. A ativação real no desktop permanece um gate de aceitação.

Abra o projeto dedicado no desktop e crie nele uma nova tarefa local. O cliente precisa confiar no projeto e
na definição exata dos hooks; gerar o arquivo não concede essa confiança. A documentação confirma `/hooks`
na CLI; use a superfície de revisão oferecida pelo cliente instalado. Não escreva na base de confiança nem use
opções que ignorem a revisão. [Configuração por projeto](https://learn.chatgpt.com/docs/config-file/config-basic),
[MCP](https://learn.chatgpt.com/docs/extend/mcp) e [hooks](https://learn.chatgpt.com/docs/hooks).

Para a CLI, o perfil opcional antigo continua disponível:

```powershell
codex --profile ssam-app -C C:\Users\andre\SSAM-Apps
```

Escolha **um** mecanismo de configuração: perfil opcional **ou** hooks locais de projeto. Não combine os mesmos
hooks nas duas camadas. Um arquivo `ssam-app.config.toml` não é selecionado automaticamente pelo desktop.
A manutenção do Anvil permanece no repositório e no perfil habitual.

Diga o pedido e a faixa SS4/SS5; podem vir em mensagens separadas. O hook captura o pedido humano e fornece o
identificador automaticamente. Só depois disso `context` confere a faixa e o ambiente. Uma Bridge respondendo
comprova conectividade com o Studio; não comprova MCP, captura ou autorização da tarefa.

### Limite separado: criar aplicação e módulos

As quatro ferramentas atuais entregam alterações em módulos existentes. Ainda não expõem a criação inicial de
aplicações/módulos. O CLI de manutenção tem `create-app`/`add-modules`, mas isso não torna essa capacidade disponível
no MCP controlado. A falta deve ser informada como capacidade ausente, sem pedir outro `task_id`, acionar shell como
recuperação ou prometer que ativar o perfil resolve esse caso.

## O que a LLM faz

1. `context`: lê o pedido registrado, o esquema disponível e as faixas compatíveis.
2. `propose`: registra a tradução completa do pedido em um contrato de módulo. Requisitos omitidos na tradução
   inicial não são descobertos por mágica; conferir a interpretação e esclarecer ambiguidades continuam necessários.
3. `continue`: o Hybrid prepara o delta, valida, faz merge e confere. Se já houve merge, retoma a prova ou reconcilia
   o resultado; uma reparação mantém o contrato e o histórico.
4. `status`: mostra o estado, as contagens e todos os diagnósticos de falha daquela tarefa. A matriz completa de
   verificações fica no recibo protegido; não é repetida na resposta de cada ferramenta.

O esquema vigente vem de `context`; veja [o contrato de módulo](CONTRATO-MODULO.md) para as políticas de acesso.
A ferramenta `propose` substitui `propose_data`; o perfil instalado já usa o nome novo. Tarefas persistidas de dados
continuam sendo retomadas pelo mesmo identificador.

A primeira tradução não pede nova autorização para cumprir um pedido claro. Mudanças de requisitos depois de fixar
o contrato precisam de uma nova mensagem do usuário e da aceitação da alteração apresentada pelo cliente.

Um erro não libera shell, edição de scripts, troca de job ou publicação. Falta de capacidade vira um bloqueio
específico. Um resultado sem mudança só é sucesso se todas as obrigações do contrato forem conferidas.

O humano continua publicando o módulo pelo Studio. A sessão de app não publica.

## Manutenção e instalação

A manutenção do Anvil continua no repositório e no perfil habitual. O perfil `ssam-app` bloqueia essas ferramentas;
não o use para corrigir C#, recompilar ou diagnosticar a infraestrutura.

O gerador `scripts/configure_app_profile.py` cria um perfil separado ou a configuração local de um projeto dedicado, sem mudar o padrão. `scripts/ssam_app.py` é o
adaptador MCP/hook; o código de entrega continua em `Anvil.Core.Delivery`. A bridge e o worker usam a mesma credencial
local do controlador. Arquivos de autoridade ficam em `%LOCALAPPDATA%\Anvil\authority`, com acesso do dono.

A prova do perfil instalado, a integração sem escrita e o estado da validação viva são registrados no plano e em
`docs/proofs`; perfil válido não deve ser anunciado como entrega viva já comprovada.

## Prova viva do controlador

No laboratório `ZZDataContract_CS`, o contrato preparado de seis tabelas foi entregue em 8,941 s no controlador,
com um merge e 365 verificações. Duas falhas injetadas após merges reais foram retomadas sem repetir a escrita.
Esses tempos não incluem a interpretação por uma LLM. A conversa real no perfil restrito ainda precisa de aceitação.
Veja [a prova](proofs/2026-09-05-fluxo-controlado-live.json).

A ampliação para actions foi provada no mesmo laboratório: três actions, 217 verificações, um merge e 6,625 s no
controlador. Foram conferidas a retomada sem repetir a escrita e a compatibilidade com a tarefa anterior de dados.
A [prova de cobertura](proofs/2026-09-05-cobertura-actions.json) distingue testes do modelo compilado de execução no
servidor; a conversa real com LLM no perfil restrito continua pendente.
