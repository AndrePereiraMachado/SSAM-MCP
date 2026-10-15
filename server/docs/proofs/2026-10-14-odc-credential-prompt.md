# Prompt privado ODC: abertura e recuperação

## Defeito e mudança

O lançador considerava `spawn(..., detached:true)` como abertura confirmada, ignorava a falha
assíncrona e mantinha `CREDENTIAL_PROMPT_PENDING` por dois minutos sem conferir a janela.
O próprio seletor de perfis já documentava que DETACHED_PROCESS pode encerrar Windows PowerShell
antes da execução. O bootstrap de Portal também usava Get-Credential, dependente do host de console.

O novo gerenciador abre um formulário WinForms privado via Start-Process Hidden e STA, sem console
interativo. Os valores vão diretamente para CredWriteW. Só metadados públicos atravessam o canal
de controle: estado, PID, instante de criação, handle e confirmação do foco. Nada de campos ou
segredos é escrito nesse estado. O processo é validado por PID + início e o handle por proprietário.
Mutexes de lançamento e janela impedem duplicação entre sessões. Pedidos de foco usam nonce,
são atendidos pela UI dona do formulário e confirmados pela janela nativa em foreground.
Falhas e cancelamento têm códigos concretos; não há espera fictícia baseada só em timestamp.

## Prova viva

Em 14/10/2026, usando somente `ssam-proto` para a interação ODC:

- `odc_portal_login open`: confirmou `window.visible:true`, sem afirmar foreground.
- `odc_portal_login focus`: confirmou o mesmo PID, `opened:false`, `foreground:true`.
- O usuário confirmou que a janela apareceu e concluiu a entrada privada.
- A primeira autenticação subsequente encontrou o perfil salvo da mesma conta do Studio, mas retornou
  `PORTAL_LOGIN_PROVIDER_UNSUPPORTED`. O provedor observado era `id.outsystems.com/community/login`.
  A correção posterior desse fluxo é descrita em [autenticação do Portal](2026-10-14-odc-community-auth.md).
- Depois dessa correção, o release de `MobileReactiveCore` foi confirmado como `1.0.0`, revisão 2.

## Testes

Testes novos cobrem confirmação real versus simples spawn/PID, projeção sem segredos, isolamento
por host/tipo, chamadas simultâneas, falha de processo/protocolo, reconciliação de janela encerrada,
cancelamento, foco recusado, status sem abertura e comandos MCP prompt/focus. A descoberta tem
um teste de recuperação de janela. Há também regressão da suíte de acesso e perfis privados.

- 165 testes de acesso, prompt e superfície MCP passaram; 10 testes de perfis privados passaram.
- Sintaxe JavaScript, parser PowerShell e `git diff --check` passaram.
- A suíte ampla de rotas ainda encontra uma falha anterior à mudança: quatro enums `patch`
  sem classificação em `nonVerbEnums` (studio_deliver, ssam_code, o11_job e ssam_job).
  Nenhum desses contratos foi alterado nesta correção.

O foco no Windows pode ser recusado pelo sistema; não é possível prometer que nenhuma falha
ocorrerá. O contrato garante que sucesso/pendência exige evidência e que uma falha não será ocultada.

## Limite observado depois da prova

O prompt legado de credenciais de banco O11 não usa este gerenciador. Em outra operação desta
sessão ele respondeu `CREDENTIAL_PROMPT_PENDING`, mas o usuário não encontrou a janela.
Esse defeito foi registrado separadamente; esta correção não deve ser anunciada como solução
para o prompt O11. O teste de banco ODC conseguiu resolver sua credencial pelo bridge, mas falhou
na validação TLS do servidor SQL, sem confirmar uma conexão salva.
