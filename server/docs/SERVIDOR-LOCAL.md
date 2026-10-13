# SSAM servido por HTTP

## O que é

- É o MESMO servidor MCP do `ssam mcp`, servido por HTTP (Streamable HTTP) em `/mcp`.
- Mesmas ferramentas, mesmos schemas, mesmas instruções. O código das ferramentas não foi copiado: cada sessão de cliente recebe um servidor do mesmo `createSsamServer` do stdio. O teste `http-server.test.mjs` prova que o `tools/list` por HTTP é igual ao do stdio.
- O acesso exige um token revogável (`Authorization: Bearer <token>`). O token é a licença e o kill switch.
- O servidor escuta só em `127.0.0.1`. Quem atende de fora é um túnel ou proxy TLS na mesma máquina ([SERVIDOR-HTTPS.md](SERVIDOR-HTTPS.md)).
- Clone separado (`C:\Users\andre\SSAM-Hybrid-servidor`), com portas de worker próprias (18517/18537/18547). O operacional não muda.

## Dois modos

| Modo | Comando | As ferramentas dirigem | Para quem |
|---|---|---|---|
| Hospedado (padrão da fase 2) | `.\ssam serve` | o Studio do CLIENTE, pelo agente que roda na máquina dele | clientes de fora, pelo túnel |
| Studios do dono (fase 1) | `.\ssam serve --local-studios` | os Studios DESTA máquina | só o dono, em loopback |

- Hospedado: o kernel, o catálogo, o discover e as receitas ficam aqui. Na máquina do cliente roda um agente fino que abre uma conexão de SAÍDA até este servidor (`/agent/v1/*`) e executa só o que precisa tocar a máquina dele: bridges dos Studios, processos, arquivos do workspace do agente e as chamadas que usam a sessão do Studio dele (Portal/tenant ODC, Service Center O11). OMLs vão servidor ↔ agente direto, nunca pelo LLM. Nenhum LLM roda aqui: o LLM é o do cliente, na conta do cliente. Desenho completo: [FASE2-AGENTE.md](FASE2-AGENTE.md). Guia do cliente: `docs/AGENTE-CLIENTE.md`.
- `--local-studios`: qualquer token dirige os Studios do dono. Por isso esse modo recusa `--public-host` e `--allow-remote` ao iniciar e responde 403 `FORWARDED_REFUSED` a todo pedido com cabeçalho de proxy (`Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `CF-Connecting-IP`, `CF-Ray`). Essa recusa é rede de segurança, não garantia: **nunca exponha um servidor `--local-studios` por túnel ou proxy**, e emita tokens para ele só para testes do próprio dono.

## Iniciar e parar

Na pasta do clone:

```powershell
.\scripts\servidor.ps1 start            # servidor hospedado na porta 7300; -Port N para outra; -RatePerMinute N para o limite
.\scripts\servidor.ps1 status
.\scripts\servidor.ps1 stop
```

- Processo `node` em segundo plano. Sem serviço do Windows, sem administrador.
- Pid, estado, log, tokens, auditoria e workspaces dos clientes ficam em `.local\server\` (fora do git).
- `start` só diz "no ar" quando o `/health` da porta responde com o pid do processo que ele iniciou. Porta já respondida por outro processo: recusa com código 1 ("porta N ocupada por outro processo (pid P)") e não deixa processo nenhum.
- O servidor grava o próprio log (`--log-file .local\server\server.log`); o script não redireciona a saída, então pode ser chamado com a saída capturada sem travar.
- Em primeiro plano, para depurar: `.\ssam serve [--port 7300] [--log-file <arquivo>]`, ou `.\ssam serve --local-studios` para os Studios do dono.
- `/health` responde `{"ok":true,"pid":<pid>}` sem token.
- Outro endereço que não seja loopback é recusado. `--allow-remote` existe só no hospedado, atrás de um proxy TLS que você controla; para o túnel ele não é necessário.

## Expor para um cliente de fora

- O servidor continua em `127.0.0.1`. Um túnel (Cloudflare Tunnel) ou proxy (Caddy, nginx) na mesma máquina publica o HTTPS.
- `--public-host <nome>` (repetível): aceita `<nome>` e `<nome>:443` no `Host` e `https://<nome>` na `Origin`. Os outros hosts continuam recusados (403).
- O proxy não pode bufferizar: o `/mcp` usa SSE e o canal do agente usa NDJSON. Sem escrita por 25 s, o servidor manda `: keepalive` numa resposta SSE (só entre eventos), para o túnel não derrubar uma chamada longa.
- Passo a passo e cuidados (conta Windows dedicada, nunca `--local-studios`): [SERVIDOR-HTTPS.md](SERVIDOR-HTTPS.md).

## Tokens e credencial do agente

```powershell
.\ssam server-token issue --customer "Cliente X" [--days 30] [--lanes odc,o11]   # mostra o token E a credencial do agente, UMA vez
.\ssam server-token agent-rotate --id tok_xxxxxxxxxxxx                          # nova credencial do agente
.\ssam server-token list                                                        # id, cliente, datas, estado, faixas, agent.issuedAt; nunca segredos
.\ssam server-token revoke --id tok_xxxxxxxxxxxx                                # derruba MCP e agente
```

- Token MCP: `ssam_` + 32 bytes aleatórios em base64url. Vai na configuração do cliente MCP.
- Credencial do agente: `ssam_agent_` + 32 bytes aleatórios em base64url. Vai no setup do agente, na máquina do cliente. Fica no MESMO registro do token.
- Uma não serve no lugar da outra: `/mcp` recusa `ssam_agent_...` (401) e `/agent/v1/*` recusa o token MCP (401).
- `tokens.json` (schema `ssam-server-tokens/1`) guarda só o SHA-256 de cada um, com `{id, customer, createdAt, expiresAt?, revokedAt?, agentSha256?, agentIssuedAt?, lanes?}`. A comparação é em tempo constante. Registros da fase 1 (sem credencial de agente) continuam válidos como token MCP; `agent-rotate` dá a eles uma credencial.
- `--lanes` (padrão `odc,o11`) limita as faixas do token. Desde a fase 3 o O11 hospedado leva para a máquina do cliente só a bridge fina (`Anvil.Bridge.dll`, sem `Anvil.Core.dll` nem outro assembly do kernel; [O11-BRIDGE-FINA.md](O11-BRIDGE-FINA.md)); a lógica do kernel roda no servidor. `--lanes odc` deixa a faixa O11 de fora.
- Sem token ou desconhecido: 401. Revogado ou vencido: 403.
- `revoke` vale já para os dois: o próximo pedido recebe 403, as sessões MCP abertas e o canal do agente daquele token são fechados em até 1 s, inclusive os streams.
- `agent-rotate` troca só a credencial do agente: a anterior passa a receber 401 e o canal aberto com ela fecha em até 1 s (`close rotated`); o agente sai e espera a nova credencial (`setup`). O token MCP não muda.
- O servidor nunca escreve `tokens.json`: só este CLI escreve. Por isso a última vez que o agente apareceu (`lastSeenAt`) fica só na memória do servidor e não sai no `list`.
- Uma sessão pertence ao token que a abriu. Outro token não a usa (404). O mesmo vale para o canal do agente e os arquivos em trânsito.
- A administração é local, pela linha de comando. Não existe rota HTTP de administração.

## Auditoria, log e limites

- Uma linha JSON por chamada de ferramenta em `.local\server\audit-AAAAMMDD.jsonl` (data UTC): `time`, `token` (id), `customer`, `tool`, `ms`, `ok` e, na falha, `error` (só um código, como `SOME_CODE`, `TOOL_ERROR` ou `RPC_32602`).
- Nunca os argumentos nem os resultados: eles carregam código do cliente.
- `--log-file <arquivo>`: o servidor grava também nesse arquivo, uma linha JSON por evento, o que vai para a saída padrão (início com modo e pid, sessões abertas e fechadas, canal do agente aberto, retomado, substituído, morto ou fechado). Nenhum segredo, argumento ou conteúdo.
- Limite por token: 240 pedidos por minuto no `/mcp` (padrão). Acima disso, 429 com `Retry-After`. No máximo 8 sessões por token: um cliente que reconecta sem fechar a sessão antiga substitui a mais antiga sem stream aberto; com todas ativas, 429. Sessão sem stream aberto e sem pedido por 1 hora é fechada.
- O canal do agente tem limite próprio (3000 pedidos por minuto por token), no máximo 32 chamadas pendentes por token, mensagens de até 1 MiB e arquivos em partes de 4 MiB com sha256.
- Cada chamada também entra na fila de fricção, como no stdio; `ssam_friction` responde igual.

## Conectar o Claude Code

1. Emita um token e guarde-o numa variável do terminal (não no repositório): `$env:SSAM_TOKEN = "ssam_..."`.
2. Use o exemplo `docs\exemplos\mcp-cliente.json` como `.mcp.json` do projeto (servidor nesta máquina):

```json
{"mcpServers":{"ssam":{"type":"http","url":"http://127.0.0.1:7300/mcp","headers":{"Authorization":"Bearer ${SSAM_TOKEN}"}}}}
```

Ou pela linha de comando: `claude mcp add --transport http ssam http://127.0.0.1:7300/mcp --header "Authorization: Bearer $env:SSAM_TOKEN"`.

Um cliente de fora usa a URL HTTPS do túnel (`https://<host>/mcp`, exemplo `docs\exemplos\mcp-cliente-hospedado.json`) e roda o agente na máquina dele (`docs/AGENTE-CLIENTE.md`). Qualquer cliente MCP que fale Streamable HTTP e mande um cabeçalho `Authorization` funciona do mesmo jeito.

## Limites conhecidos

- Um kernel por faixa no servidor, preso à versão do Studio instalado aqui (Service Studio 11.55.92 e ODC Studio 1.7.28, desde 12/10/2026). O agente informa as versões do cliente; com versão diferente, as ferramentas que tocam aquele Studio recusam com texto claro, e as que rodam só no servidor continuam funcionando.
- OML e JSON do cliente são lidos aqui pelas DLLs do Studio e pelo kernel: rode o servidor hospedado numa conta Windows dedicada, sem privilégio ([SERVIDOR-HTTPS.md](SERVIDOR-HTTPS.md)).
- O tempo de espera do kernel O11 com a bridge (120 s) inclui o envio de arquivos pelo canal do agente.
- Fora de escopo agora (instalador, assinatura, vários kernels, depurador hospedado): seção 11 de [FASE2-AGENTE.md](FASE2-AGENTE.md).

## Arquivos

- `platforms/odc/facade/http-server.mjs`: transporte HTTP, modos, bind, `--public-host`, `--log-file`, tokens, sessões, auditoria, limite, keepalive SSE.
- `platforms/odc/facade/agent-hub.mjs`: canal do agente (`/agent/v1/*`), chamadas pendentes, retomada, blobs, varredura de revogação e de troca de credencial, compatibilidade de versões.
- `platforms/odc/facade/server-tokens.mjs`: emissão, troca, revogação e verificação dos tokens e das credenciais do agente.
- `platforms/odc/facade/ssam.mjs`: verbos `serve` e `server-token`.
- `facade/launch.mjs`: roda os dois verbos no mesmo processo (um pid só para o script).
- `scripts/servidor.ps1`: start, stop, status.
- Testes: `platforms/odc/facade/tests/http-server.test.mjs` (401/403/429, revogação fecha sessão viva, loopback, `--public-host`, `--local-studios`, `FORWARDED_REFUSED`, keepalive, sessão entregue ao `createServer`, paridade do `tools/list` com o stdio), `agent-hub.test.mjs` (protocolo do agente), `server-tokens.test.mjs` (credenciais), `tests/servidor-ps1.test.mjs` (script), `hosted-e2e.test.mjs` (aceitação hospedada num processo só).
- Prova de ponta a ponta com processos separados, só com Studios falsos (fora do `node --test`): `node platforms\odc\facade\tests\hosted-e2e-processes.mjs` com `ANVIL_WORKER=0` e `ANVIL_ODC_NO_WORKER=1`. Monta o pacote do agente (`agent-pack.ps1 -NoBuild -Prebuilt`), sobe o servidor pelo `servidor.ps1` numa pasta temporária, emite tokens pelo CLI, configura dois agentes com o `setup` real em pastas de "máquinas" separadas e confere, por um cliente MCP HTTP: `tools/list`, ferramenta pelo agente, OML nos dois sentidos com sha256, recusa de caminho fora do workspace, isolamento entre clientes, recusa sem agente e revogação. Desde a fase 3 confere também o contrato da bridge O11 fina contra uma bridge falsa que só responde primitivas: `o11_deliver`, `o11_studio snapshot`/`publish-log` e `o11_environment refresh-refs` rodam o CLI real do kernel no servidor (`ANVIL_BRIDGE_FLAVOR=thin`, com o Service Studio instalado carregado sem interface, então precisa de `ANVIL_STUDIO_DIR` ou do Service Studio 11 em `Program Files`), o `reference_plan` chega no `merge_from_oml`, `find_element` nunca chega à bridge, e um `ssam_job {lane:"odc"}` sem `base` e o `ssam_discover` hospedado mostram a fixture neutra e a limpeza da evidência de terceiro ([O11-BRIDGE-FINA.md](O11-BRIDGE-FINA.md)). Imprime `{ok, checks}` e sai com 0 só se tudo passou.
