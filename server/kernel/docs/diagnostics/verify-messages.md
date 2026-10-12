# Consultar mensagens do Verify

Use `anvil verify-message --name RequiredConnector_Out` para um ID exato ou
`anvil verify-message --find connector` para procurar em IDs, titulos, detalhes e hints.
`anvil` representa o CLI da faixa ativa (`dotnet .local/cli/anvil.dll` no SS4,
`dotnet .local/lane-ss5/cli/anvil.dll` no SS5).

Os textos e a severidade bruta sao lidos do Service Studio instalado, por campos publicos de
VerifyMessageId e ResourceManager. Placeholders como {0} pertencem ao template; o Verify de um
modulo real devolve o Detail ja preenchido e o caminho do objeto. Uma sugestao pode ter severidade
bruta Warning: o comando nao inventa uma classificacao diferente da API.

O repositorio guarda apenas o manifesto de IDs para validar expectedMessages sem carregar o Studio,
e os hints nossos em catalog/verify-hints-*.json: 112 curados e 57 orientados por quick-fix.
Os 299 textos que apenas repetiam a mensagem deixaram de ser hints. Um hint e o `fix` de um problema do Verify e de um
warning tal como esta, por isso nunca leva placeholder do template ({0}, {1}): cita "o que a mensagem cita"
(VerifyAnchorTests.NoCuratedHintCarriesAPlaceholder). Sem hint curado, o fix diz o que fazer. Comando da CLI num fix, so
os que a fachada troca pela chamada MCP (`anvil functions|api|signature`, em responses.mjs): o FUNCTION_UNKNOWN sem nome
parecido cita `anvil functions --find X`, que chega a sessao como ssam_reference {kind:"functions"} com continuation.
O runner mostra somente os hints curados dos IDs presentes (uma vez por ID, ate 20); detalhes e erros continuam com seu proprio limite.
A bridge instalada fora do repositorio pode nao ter esse arquivo: o Verify continua funcionando.

Corrija erros. Para um aviso novo intencional, declare expectedMessages com id, element e why;
o caminho deve identificar um unico elemento. Avisos antigos nao sao aceitos como justificativa
para novos avisos. Consulte o delta new/fixed/preexisting do apply e deliver.
