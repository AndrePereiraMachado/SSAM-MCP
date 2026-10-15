# Portal ODC: autenticação pelo OutSystems ID da comunidade

## Correção

O Portal do tenant pessoal redireciona para `https://id.outsystems.com/community/login`.
O broker reconhecia apenas o fluxo em `id.outsystems.dev`. A nova implementação usa
`CommunityPortalIdentity`, reaproveitando a autenticação privada e a validação de tokens de
`CommunityIdentity`, mas preservando o pedido PKCE, o callback e o estado emitidos pelo Portal.

O callback deve corresponder à origem do tenant e ao caminho autorizado. A autenticação exige
uma leitura protegida posterior; a presença de cookies não basta. Desafios, consentimento e
aceitação de termos não são respondidos automaticamente. Perfis permanecem separados por host
e principal. O orçamento da chamada de login passou para 90 segundos para comportar o fluxo frio.

## Evidência viva

Em 14/10/2026, por `ssam-proto`, a sessão autenticou no tenant pessoal já conectado ao Studio.
O release de `MobileReactiveCore`, revisão 2, foi confirmado como `1.0.0` em leitura posterior.
Recibo: `f476fe38-c19b-4c75-a67b-f7a09c630db8`.

Depois, as bibliotecas externas `VideoSnapshots` e `SoapConversions` completaram upload,
geração, publicação e release `1.0.0`, com recibos confirmados:

- `92c37cad-3252-43e5-8d82-d0ead0360851` (`VideoSnapshots`).
- `3b64fe3e-59de-4cff-9858-527ee4039952` (`SoapConversions`).

Essas provas confirmam o fluxo administrativo de publicação, não a execução das actions das
bibliotecas. Os ativos são evidência histórica: alguns foram excluídos depois a pedido do usuário.

## Regressões

`portal/tests/community-portal.test.mjs` cobre callback, estado, PKCE, recusa de termos e a
confirmação por leitura protegida. `facade/tests/sc-identity-vault.test.mjs` cobre o escopo do
perfil ODC e recusa perfis de outro host ou tipos de credencial incompatíveis.

Na preparação dos commits, a seleção conjunta de regressões de XIF, Service Center,
autenticação ODC e continuações teve 339 testes Node aprovados e 1 ignorado (varredura de
pacote sem `SSAM_SCAN`). Os dois testes direcionados de descoberta também passaram.
`TimerScheduleTests` e `XifPackageTests` tiveram 33 testes C# aprovados. Não foi executada
nova suíte completa; a limitação conhecida dos enums `patch` continua descrita nas outras provas.
