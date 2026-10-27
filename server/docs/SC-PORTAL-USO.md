# Service Center (O11) e Portal ODC: como usar as credenciais

Ferramentas: `o11_service_center_session/read/write` (O11) e `odc_read`, `odc_write`, `odc_portal_*`,
`odc_auth_status` (ODC). Nenhuma credencial passa pelo chat, por argumento de ferramenta ou por log.

## Ordem de cada chamada

1. A sessão do Studio conectado e logado no host (Service Studio para O11, ODC Studio para ODC).
2. A credencial guardada no cofre do Windows para aquele host (o perfil do host).
3. Só quando não há nada guardado para o host: a janela privada do Windows.

O SSAM nunca abre a janela de login do Studio nem um navegador.

Para preparar credenciais do Service Center mesmo com o Studio aberto, use
`o11_service_center_session {action:"sign-in", host:"<host>", session:"vault"}`.
A janela privada permite selecionar ou adicionar um perfil compatível com o usuário
autenticado no Studio. `CREDENTIAL_SELECTION_PENDING` significa que a janela está
aberta; repita a mesma chamada após salvar. `authPrompt:"never"` impede a abertura.
O retorno confirma a credencial guardada, não a autenticação no Service Center;
a leitura seguinte confirma o acesso. Nenhuma sessão do Studio é fechada ou alterada.

Algumas versões O11 devolvem a página autenticada ainda na URL `Login.aspx` após
o POST de login. Nessa resposta específica, o adaptador aceita a página somente
com controle de logout e sem formulário de senha nem layout de login. As leituras
protegidas seguintes mantêm a detecção estrita de sessão expirada.

## Primeira chamada sem credencial

- **O11:** abre a janela `windows-o11-credential.ps1 -Mode bootstrap` ("Service Center login for <host>").
  Digite ali o e-mail e a senha da conta OutSystems. A mesma chamada espera a entrada aparecer no cofre
  (`SSAM_PROMPT_WAIT_MS`, padrão 120 s; numa leitura, até uns 27 s). Se não der tempo, a resposta é
  `CREDENTIAL_PROMPT_PENDING`: a janela continua aberta, e você repete a mesma chamada depois de salvar.
  LifeTime (conta de serviço e token), login de banco e valor secreto de site property usam a mesma janela,
  cada um com a sua entrada.
- **Portal ODC:** sem Studio e sem API Client guardado, `odc_read` abre
  `windows-api-client-credential.ps1 -Mode bootstrap`: Client ID no usuário, secret na senha. A resposta é
  `CREDENTIAL_PROMPT_OPENED`; repita a chamada depois de salvar. A conta do Portal, a conta de um banco externo e
  o valor secreto de uma setting usam `windows-portal-credential.ps1 -Mode bootstrap`.

### Janela privada ODC verificada (14/10/2026)

As ferramentas ODC usam agora o gerenciador `windows-credential-prompt.ps1` para a entrada privada
de Portal, API Client, banco e setting. O processo auxiliar inicia com `Start-Process` e `-STA`,
sem `DETACHED_PROCESS`. `CREDENTIAL_PROMPT_OPENED` e `CREDENTIAL_PROMPT_PENDING` exigem confirmação
de uma janela nativa visível, com PID, instante de criação e proprietário do handle conferidos.
O estado compartilhado entre sessões contém só metadados da janela; nunca usuário ou senha.

- `odc_portal_login {action:"status", tenant}` lê o estado real da janela, sem abrir outra.
- `odc_portal_login {action:"focus", tenant}` recupera e traz à frente a janela privada do Portal;
  `window.foreground:true` comprova o foco. `action:"prompt"` também permite reabrir após cancelamento.
- Processo encerrado não deixa uma falsa pendência por tempo. Mutexes por contexto impedem duplicatas;
  um processo vivo que não confirma a janela retorna `CREDENTIAL_PROMPT_WINDOW_UNAVAILABLE`.
- `CREDENTIAL_FOCUS_DENIED` informa que o Windows não confirmou o foco; `CREDENTIAL_PROMPT_CANCELLED`
  informa cancelamento. Nenhum desses resultados deve ser descrito como login concluído.
- Guardar credenciais e autenticar são passos distintos. `PORTAL_LOGIN_PROVIDER_UNSUPPORTED`, SSO/MFA
  e rejeição da conta continuam explícitos; não se troca de usuário nem se pede senha no chat.

O login pessoal em `id.outsystems.com/community/login` é suportado pelo broker com o mesmo perfil
selecionado, preservando o PKCE e o estado do Portal. A sessão só é confirmada após uma leitura
protegida. Desafios interativos e aceitação de termos continuam a exigir ação da pessoa.
Prova: [autenticação e releases ODC](proofs/2026-10-14-odc-community-auth.md).

Essa prova de janela é da rota ODC. O prompt legado de credencial de banco O11 ainda apresentou
janela não visível nesta sessão e permanece como defeito separado.

## Reutilização

- O valor fica no Gerenciador de Credenciais (Credenciais genéricas): `SSAM/O11/<host>/ServiceCenter`,
  `.../LifeTime`, `.../DatabaseConnection/<nome>`, `.../SiteProperty/<nome>`; `SSAM/ODC3/<host>/APIClient`,
  `.../Portal`, `.../DB/<nome>`, `.../Setting/<nome>`. Só o processo que faz a chamada lê o valor.
- A entrada digitada na janela O11 vira o perfil escolhido do host, em
  `%USERPROFILE%\.ssam-hybrid\auth\profiles` (só o alvo e o usuário). As chamadas seguintes usam esse perfil,
  com ou sem Studio. Com o Studio logado, um perfil único do mesmo usuário é usado sem perguntar.
- Com mais de um perfil compatível, a resposta é `CREDENTIAL_SELECTION_REQUIRED`. Escolha um com
  `credentialTarget` (O11) ou com `odc_portal_login` e as suas palavras (Portal).
- O cofre do Windows é o mesmo para o Claude e o Codex. O estado do SSAM fica em `%USERPROFILE%\.ssam-hybrid`
  (perfis, marcadores das janelas, recibos e travas do Service Center, downloads de solução). Ele não fica no
  `%LOCALAPPDATA%`, que cada app MSIX enxerga em cópia própria.

## Revogar

- Apague a entrada no Gerenciador de Credenciais (Credenciais do Windows > Credenciais genéricas > `SSAM/...`)
  ou rode `cmdkey /delete:SSAM/O11/<host>/ServiceCenter`. Um perfil que sumiu do cofre deixa de valer, e a
  próxima chamada abre a janela de novo.
- Para apagar também a escolha, remova o arquivo do host em `%USERPROFILE%\.ssam-hybrid\auth\profiles`.
- `authPrompt:"never"` (O11) recusa em vez de abrir a janela.

## Trava do tenant corporativo

- **O11** (`kernel/scripts/service_center/hosts.json`): num host `personal`, a escrita pede as suas palavras e um
  `operationId`. Qualquer outro host, ou host não listado, conta como corporativo: toda escrita pede
  `confirmHost=<host>` e palavras que nomeiem o ambiente. Um host `read-only` recusa toda escrita. Exclusão pede
  palavras que nomeiem cada alvo.
- **ODC** (`platforms/odc/tenants.json`): `personal` é livre para testes. `corporate` (WrightFlood) pede
  `confirmTenant=<host>` e palavras com o nome do tenant. `client`/`readOnly` recusa qualquer escrita. Tenant não
  listado conta como corporativo.
- Uma escrita de resultado incerto nunca é repetida. Ela se resolve por leitura: `verify`/`discard` no O11 e
  `odc_receipt` no ODC.
