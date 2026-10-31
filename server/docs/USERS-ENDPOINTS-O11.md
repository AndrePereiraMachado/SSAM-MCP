# Users O11: mapa para integração oficial no SSAM

Estado: **ferramenta `o11_users` implementada e registrada; validação ao vivo em andamento**.
Data: 2026-10-30. As provas abaixo distinguem implementação, testes automatizados e execução no ambiente.

## Evidência e limites

- Ambiente solicitado: o ambiente pessoal de testes do dono.
- Módulo publicado: `Users`, versão 5407, descrição `For version 11.42.1. Backoffice to manage users, groups and roles.`
- SHA-256 da captura lida pelo SSAM: `53d480c5e7702f6f3c9926d365c322f23ad983f19795e45c44194758bcd66a05`.
- Leitura do modelo publicado, sem abrir ou modificar o módulo protegido Users.
- Navegador: o GET de `/Users/` apresentou o login. O formulário observado usa `POST /Users/Login.aspx`.
- Login administrativo concluído pelo popup privado. Consulta e detalhe foram executados tanto pelo transporte quanto pela ferramenta MCP registrada. A senha não passou pelo modelo, pelos argumentos ou pelo repositório.
- Foi criado, com autorização explícita, um usuário temporário de teste. Edição, inativação e reativação foram confirmadas por nova leitura. A senha foi definida pelo popup e validada por uma única autenticação privada da conta temporária. Nenhuma conta preexistente foi alterada.
- Uma role de dados de exemplo foi concedida e removida somente nessa conta, com confirmação após ambas as operações. A conta terminou sem roles ou grupos.
- `o11_access action=users` retornou HTTP 500 no caminho `environment_session:users-read`. Isso não comprova erro no formulário Users, nem prova que uma sessão administrativa Users existe.

## Protocolo

É uma aplicação Traditional Web ASP.NET/WebForms. Não é uma API REST de usuários.
Os caminhos de telas abaixo vêm do modelo publicado. Login, lista/detalhe/edição de usuários, grupos, aplicações e seleção de roles foram também observados no navegador autenticado.

A implementação obtém o formulário atual antes de enviar uma operação. Os nomes prefixados dos controles, `__OSVSTATE`, `__VIEWSTATE`, validação e argumentos de postback são estado transitório: não são copiados entre sessões nem fixados no catálogo.
Eventos Ajax e Submit devem seguir o método que a tela realmente publica. Os scripts retornados são dados de protocolo, nunca código confiável a executar livremente.

## Rotas e ações nativas

| Tela/caminho candidato sob `/Users/` | Entrada | Operações observadas no modelo |
| --- | --- | --- |
| `Login.aspx` | formulário de login | Log In; POST observado no navegador |
| `User_List.aspx` | pesquisa/paginação | `RefreshUserTable`, `ExportToExcel`; links para novo usuário e inativos |
| `Inactive_Users.aspx` | pesquisa/paginação | listagem de usuários inativos; corpo ainda não mapeado |
| `User_Edit.aspx` | `UserId` opcional | `Save`; criação e edição; nome, username, email, telefone e senha/confirmar quando permitidos |
| `User_Show.aspx` | `UserId` obrigatório | `EnableDisableUser(Enable)`, `ToggleSetPassword`, `Unblock(IPAddress, Username)` |
| `Group_List.aspx` | pesquisa/paginação | `RefreshGroupTable`; link para novo grupo |
| `Group_Edit.aspx` | `GroupId` opcional | `Save`, `DeleteGroup` com confirmação irreversível |
| `Group_Show.aspx` | `GroupId` obrigatório | detalhes, membros e roles por blocos incorporados |
| `Application_List.aspx` | pesquisa/paginação | `RefreshApplicationTable` |
| `Application_Show.aspx` | `ApplicationId` obrigatório | detalhes e roles da aplicação |
| `Role_Show.aspx` | `RoleId` obrigatório | usuários da role, incluindo origem herdada de grupos |

As telas administrativas principais exigem a role **UserManager**. O SSAM não deve concedê-la a si mesmo para contornar ausência de acesso.

## Operações de blocos: usam o formulário da tela hospedeira

| Bloco | Tela hospedeira | Eventos observados |
| --- | --- | --- |
| `UserGroups` | `User_Show` | `AddGroup`, `NewGroupAutocomplete`, `RemoveGroup` (Ajax), `RefreshTable` |
| `UserRoles` | `User_Show` | `AddRole`, `Autocomplete`, `RemoveRole` (Ajax), `RefreshTable` |
| `GroupUsers` | `Group_Show` | `AddUser`, `NewMemberAutocomplete`, `RemoveUser` (Ajax), `RefreshTable` |
| `GroupRoles` | `Group_Show` | `AddRole`, `Autocomplete`, `RemoveRole` (Ajax), `RefreshTable` |
| `Role_Users` | `Role_Show` | `AddUser`, `Autocomplete`, `RemoveRole` (Ajax), `RefreshTable` |
| `ChangePassword` | `User_Show` | `SaveChanges`, `Cancel`; senha atual quando exigida, nova senha e confirmação |
| `DeleteUserAction` | `User_Edit` ou usuário externo | `DeleteUser`, com confirmação |

Esses eventos não são endpoints REST separados. O alvo do evento e o formulário devem ser obtidos da instância renderizada na tela hospedeira.

## Contrato implementado no SSAM

A superfície `o11_users` é separada de `o11_access` (manifestos de roles de módulos) e de `o11_data` (dados de negócio).

- Leituras públicas: `capabilities`, `status`, `list` (ativos ou inativos), `get` (inclui grupos e roles diretas/herdadas), `receipt`.
- Autenticação e segredo: `sign-in`, `password-prompt`.
- Escritas públicas: `create`, `update`, `activate`, `deactivate`, `grant-role`, `revoke-role`, `add-group`, `remove-group`, `set-password`, `delete`.
- Exclusão de usuário: prévia com alvo exato, nova confirmação e recibo; nunca reexecutar o mesmo UUID incerto.
- Criar/excluir grupos, desbloquear login e consultar todo o catálogo de aplicações/roles ainda não são verbos públicos. O mapa dessas telas não é uma declaração de implementação.
- Senhas: somente referência a cofre ou entrada privada pelo usuário. Nunca senha/hash em argumentos MCP, logs, artefatos de teste ou saída.
- A sessão administrativa deve estar vinculada ao host e à identidade autorizada. Cookies e tokens permanecem no transporte privado. Não exportar cookies do navegador nem presumir que a sessão do Service Center autentica Users.
- Identificadores grandes permanecem texto. Busca exata deve distinguir nome de exibição de username e recusar resultados ambíguos.
- Antes de uma escrita: comprovar o alvo e as permissões da sessão, registrar intenção e operação única. Depois: ler o mesmo alvo e registrar o resultado confirmado, recusado ou incerto.
- Clonar acesso: distinguir roles diretas de herdadas. Copiar a associação de grupo, não converter silenciosamente herança em grant direto. Relações de negócio específicas, como `PMAI_Program_CS.ProgramMember`, são uma segunda superfície e não podem ser inferidas só das roles de Users.

## Uso

`ssam_discover {lane:"o11", intent:"users activate"}` encontra `o11_users`. Os campos completos estão em `ssam_reference {lane:"o11", kind:"tool", query:"o11_users"}`.

1. `status` com o host exato e `prompt:false` consulta a autenticação sem abrir janela.
2. `sign-in` com `prompt:true` abre a janela privada. O usuário salva a credencial localmente.
3. `password-prompt` com `data.username` (conta nova) ou `userId` (conta existente; o nome vem da página desse usuário, e `userId` junto de `data.username` é recusado com `USERS_USERNAME_WITH_ID`) devolve uma referência opaca. O formulário possui confirmação da senha. Nenhum verbo recebe senha em texto.
4. Uma escrita informa `userId` (exceto criação), `authorize` com as palavras do usuário e um `operationId` UUID novo. Em `create`/`update`, `data` aceita nome, username, email e telefone; em grants/associações, `targetId` é o ID exato da role ou grupo.
5. `delete` sem token só apresenta a prévia. Depois da confirmação explícita, usar o UUID e `confirmationToken` recebidos. O alvo é relido e comparado antes da exclusão.

Recibos ficam fora do repositório, em `%USERPROFILE%/.ssam-hybrid/o11/users/`. Uma resposta perdida conserva o estado incerto; consultas de recibo nunca reenviam a operação. IDs são texto, inclusive acima do limite inteiro seguro do JavaScript.

## Servidor multiusuário (linha fase4-28)

Em servidor hospedado, `o11_users` roda pelo agente da pessoa (kind `o11.users`, `platforms/odc/facade/hosted/users-agent.mjs` e `agent/lib/users.mjs` da caixa do agente, 0.3.5 e 0.4.2-native). Modelo e servidor não confirmam nada: quem confirma é uma pessoa, numa janela do agente.

- **No agente:** cofre do Windows por instalação, conta e host exato (`SSAM/Agent/<instalação>/<conta>/O11/<host>/...`), janelas, HTTP e cookies de sessão em memória. Senha e cookie nunca chegam ao servidor.
- **Host:** a primeira janela de um ambiente pede o nome de novo. Nome parecido com um aprovado não ganha janela. Nome interno, ou que resolva para endereço fora da internet, é recusado antes de qualquer janela ou requisição. Ambiente on-premises em rede privada não entra por este caminho.
- **Entrada:** o helper entra sozinho (`op login`), depois de um sim da pessoa, válido por 8 horas em memória. O servidor não vê a página de login nem escolhe campo. **Freio:** cada tentativa conta antes de sair, qualquer que seja o resultado, e só um helper que diz que não enviou nada a devolve. Com 2 tentativas sem prova, para com `USERS_LOGIN_PAUSED`, sem nada ao site, até a pessoa salvar a janela de login de novo ou fazer `sign-out`. Só a janela, ou um login que a página seguinte prova, zera a contagem; um GET com 200 não zera, e ler a página de login não conta. O agente guarda só host e contagem, em arquivo dele, e reiniciar não zera.
- **Escrita:** o servidor só diz a operação e os ids (`write {action, userId, targetId, changes, entry}`); `request` é GET; a busca é `search {inactive, text}`. O agente lê a página real, monta o POST pela tabela dele (`users-page.mjs`, `UsersPage.cs`: rotas, controle, campos) e mostra na janela o que vai enviar: host, quem está logado, a ação, o id, o username lido da página e cada valor. Nome e username vêm marcados como dados da página. Sem sim, nada é enviado e nada repete. `create` e `set-password` usam a janela de senha, ligada à ação, ao id, à referência e às mudanças exatas, e pagam só aquela operação. Fechar uma janela conta como não: 3 em 10 minutos param as janelas.
- **Falha segura:** página sem exatamente o que a tabela conhece dá `USERS_PAGE_NOT_KNOWN`: sem janela, nada enviado, sem recibo, UUID livre. `delete`, `revoke-role` e `remove-group` não existem no agente, e campo ou evento fora da tabela é recusado. Só se sabe se as páginas reais batem com a tabela ao vivo (roteiro abaixo).
- **Senha nova:** só vai aos campos de senha de `User_Edit` e `User_Show`. Sai do cofre logo depois do POST, mesmo se ele falhar; em toda recusa do servidor a `create` ou `set-password`, menos a que pede para digitar; e por um timer do agente ao fim da permissão de 5 minutos, sem precisar de outra chamada. Uma marca em disco diz que pode haver senha, e um agente que fechou antes disso apaga as novas senhas da conta ao iniciar; sem marca, iniciar não roda nada. No SSAM instalado, um timer de 15 minutos faz o mesmo. A próxima troca sempre abre janela.
- **No servidor:** leitura das páginas e recibos em `state/users` do workspace do token, só com ids e HMAC por conta, com a chave derivada de um segredo do servidor (`users-hmac.key`, ao lado de `tokens.json`, fora do workspace; quem lê o disco inteiro do servidor também lê esse segredo), apagados depois de 7 dias por uma varredura do próprio servidor. As respostas desta ferramenta nunca vão para arquivo; uma leitura grande é cortada e diz isso.
- **Saída:** `sign-out` apaga o administrador guardado, a sessão, os sins e o freio do host.
- **Agente antigo:** `USERS_AGENT_UPDATE_REQUIRED`. **Mac:** `USERS_PLATFORM_UNAVAILABLE`. Nada cai em caminho local.
- **Desligados no servidor (T2):** `delete`, `revoke-role` e `remove-group`.

## Roteiro ao vivo do hospedado (gate do dono)

Sem cofre nem HTTP real, os testes não provam o login real, o `__OSVSTATE` nem os campos das páginas. Por isso este roteiro vem antes de qualquer colega usar, num ambiente de teste, com um usuário de teste criado para isso. Em cada passo há o que se vê quando deu certo.

| # | Peça ao assistente | Na sua tela | Deu certo quando |
| --- | --- | --- | --- |
| 1 | `sign-in` do host, com `prompt:true` | Janela do SSAM pedindo o host de novo, usuário e senha | A janela fecha sem erro e `status` responde `stored:true` com o seu usuário |
| 2 | `list` com uma busca | Uma janela "sign in" com o host; aprove | Vêm as linhas certas. Se vier `USERS_LOGIN_FAILED`, pare e veja a tabela abaixo |
| 3 | `get` do usuário de teste | Nada | Nome, username, e-mail e roles batem com a aplicação Users |
| 4 | `update` do e-mail | Janela com host, seu login, id, username e o e-mail novo | A aplicação Users mostra o e-mail novo. Recuse uma vez antes: nada muda |
| 5 | `deactivate` e `activate` | Uma janela para cada, com Decline já selecionado e Approve desligado por 1,5 s | O estado muda na aplicação Users. Enter sozinho recusa |
| 6 | `grant-role` de uma role de exemplo | Janela com o nome da role lido da página | A role aparece no usuário. Tirar a role é só pela aplicação Users |
| 7 | `set-password` do usuário de teste | Janela de senha com o username real e o id | `accepted-unverified`. Entre uma vez com esse usuário para provar a senha |
| 8 | `create` de um usuário novo | Janela de senha com username, nome e e-mail | O usuário existe e consegue entrar |
| 9 | Senha errada: refaça o passo 1 com a senha errada e peça `list` | Até 2 tentativas; depois, nenhuma | `USERS_LOGIN_PAUSED`. Não tente repetir: refaça o passo 1 com a senha certa |
| 10 | `sign-out` | Nada | `status` volta a pedir login, e o Gerenciador de Credenciais do Windows não tem mais `SSAM/Agent/.../O11/<host>` |

**O que cada resposta quer dizer, e como sair sem risco:**

| Resposta | O que houve | O que fazer |
| --- | --- | --- |
| `USERS_LOGIN_LAYOUT_CHANGED` | A página de login não é a que o agente conhece (por exemplo, só SSO). A senha não saiu | Nada a desfazer. Anote a tela: a tabela do agente precisa mudar |
| `USERS_LOGIN_FAILED` | O site recusou, ou a resposta não trouxe sessão | Confira o login no navegador antes de tentar de novo. São no máximo 2 tentativas, de propósito |
| `USERS_LOGIN_PAUSED` | 2 falhas. Nada foi ao site | Confira a conta na aplicação Users e salve a janela de novo, ou faça `sign-out` |
| `USERS_PAGE_NOT_KNOWN` | A página real difere da tabela. Nada foi enviado, sem recibo | Nada a desfazer. Faça a mudança pela aplicação Users e anote a operação |
| `USERS_PASSWORD_FORM_NOT_KNOWN` | O botão Set Password saiu, e a resposta não é o formulário conhecido. A senha nova não saiu e deixou o cofre. Recibo `uncertain` | Veja o usuário. Não repita o UUID. Anote a tela |
| `USERS_RECEIPT_KEY_MISSING` | O servidor foi restaurado sem a chave dos recibos, ou com outra. Nenhuma mudança roda; leitura e `sign-out` seguem | Restaure a chave do mesmo backup. Veja "Backup" abaixo |
| `USERS_CONSENT_REQUIRED` | A janela de senha era de outra mudança, ou passou de 5 minutos | Peça a janela de novo |
| `state:"uncertain"` | O POST saiu e a volta não foi lida | Não repita o UUID. Veja o usuário com `get` ou na aplicação Users |
| Administrador sem acesso | Só se a senha errada bloquear no próprio Users | Desbloqueie pela aplicação Users, com outro administrador (a tela do usuário tem `Unblock`). O SSAM não faz isso |

Tudo o que o gate muda é desfeito pela aplicação Users. Se algo parecer errado em qualquer passo, `sign-out` tira a credencial e a sessão do agente sem falar com o site.

**O que este roteiro prova e os testes não:** o parser de login, um POST por operação em cada tela, a ação do formulário com `UserId`, os nomes dos campos, o tamanho das páginas e a redação do `__OSVSTATE`.

## Backup do servidor

| Arquivo | O que é | No backup |
| --- | --- | --- |
| `users-hmac.key`, na pasta do servidor, ao lado de `tokens.json` | Segredo de 32 bytes do qual sai uma chave por token. Essa chave acha os recibos e assina os hashes deles | Junto de `customers/`, sempre, e com a proteção de `tokens.json` |
| `customers/<token>/state/users/` | Recibos: operação, UUID, hash do pedido, estado e id do usuário, sem nome nem host. Impedem reenviar um UUID por 7 dias. `.key-check` diz qual chave escreveu a pasta e não abre nada | O mesmo backup da chave |

**Quem lê o backup, com a chave, abre por dicionário** o hash do pedido: por exemplo, descobre o e-mail de um `update` se tiver o palpite certo. Sem a chave, não abre. A varredura de 7 dias não alcança backup, então os recibos ali duram o que durar a retenção do backup.

**Ao restaurar:**

| Restaurou | O que acontece |
| --- | --- |
| Chave e `customers/` do mesmo backup | Normal. Só o que foi enviado depois desse backup não tem recibo, e esse UUID rodaria de novo, como qualquer dado perdido no restore |
| `customers/` **sem a chave** | **Nada é liberado.** Basta um recibo de qualquer conta, mesmo inativa, para travar todas: mudanças, `password-prompt` e `receipt` respondem `USERS_RECEIPT_KEY_MISSING`, sem enviar nada e sem criar chave nova. Leitura e `sign-out` seguem. Sai sozinho quando esses recibos vencem, em até 7 dias da data do arquivo, ou na hora se a chave certa voltar |
| `customers/` **com outra chave** | Só trava a conta que tem recibo. **A conta sem recibo não é recusada:** ela trabalha e grava recibos com a chave errada. Quando a chave certa volta, é ela que trava, por até 7 dias, e a outra destrava. Nenhum UUID roda duas vezes. Por isso, volte a chave certa o quanto antes |
| Chave sem `customers/` | Não há recibo a proteger nem como saber o que já saiu: vale a primeira linha, para todo o período sem recibo |

**Como o dono fica sabendo:** o log do servidor traz `users-receipt-key-missing`, em inglês e sem dado de pessoa, ao iniciar e a cada hora enquanto a chave faltar e houver recibo, e também na recusa, no máximo uma vez por hora. A chave errada não se vê pelo disco: essa linha só sai quando uma conta é recusada.

Não apague `users-hmac.key` para destravar: o bloqueio continua enquanto houver recibo. Apagar `state/users` à mão destrava, mas libera os UUIDs de até 7 dias atrás; só faça isso sabendo que nenhum cliente vai repetir uma operação.

## Validação e limites

Os testes automatizados cobrem fronteira de URL, IDs grandes, herança de roles, recusa de senha em argumentos, autorização, UUID/idempotência, exclusão após prévia, alvo alterado, proteção contra autobloqueio, referência privada e o redirecionamento `__RedirectToURL` observado ao salvar.

A criação inicial e a primeira edição tiveram efeito no servidor, mas retornaram recibos incertos porque o parser ainda não reconhecia `__RedirectToURL`. A consulta posterior confirmou o estado sem reenviar esses UUIDs. O parser foi corrigido e a edição seguinte teve confirmação completa.

A troca de senha retorna `accepted-unverified`: o produto não lê hash nem tenta entrar automaticamente como o usuário. A autenticação realizada durante o teste foi uma verificação separada e explicitamente autorizada da conta temporária.

Os 18 testes específicos de Users passaram. A suíte geral de orçamento de contexto identificou um excesso já presente nas outras ferramentas com hooks: 171.433 bytes, limite 168.401, excluindo `o11_users` (1.834 bytes). Esse limite não foi aumentado para ocultar o excesso.

Associação a grupo ainda precisa de prova ao vivo: a listagem deste ambiente estava vazia. Não criar grupo nem conceder roles administrativas silenciosamente só para aumentar cobertura. Paginação retorna `complete:false` quando a pesquisa não pode provar uma lista completa.
