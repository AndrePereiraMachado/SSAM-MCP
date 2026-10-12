# SSAM Hybrid — fluxo O11

Leia este guia ao operar um app O11. As regras comuns estão no [AGENTS.md da raiz](../AGENTS.md).
A implementação O11 fica no kernel compartilhado; este guia não cria uma nova raiz de execução.
Use `.\ssam ... --lane o11` e o MCP principal da raiz. A faixa SS4/SS5 vem de `.ssam-workspace.json`
ou da seleção explícita da sessão; não troque a faixa por iniciativa própria.

## Sessão e leitura

1. Confira `.\ssam doctor --lane o11`. Conecte ao Service Studio já aberto por
   `.\ssam connect --lane o11 [--pid <PID>]` / `ssam_connect`; nunca salvar, publicar ou reiniciar para anexar.
2. Preserve módulo, ambiente e alterações locais. Conexão e identidade: [CONEXAO-STUDIO.md](CONEXAO-STUDIO.md).
3. Obtenha uma captura atual pelo fluxo da sessão. Comece por `.\ssam map --lane o11 <captura.oml>` / `ssam_map`.
4. Leia as chaves necessárias com `.\ssam inspect --lane o11 --oml <captura.oml> --path @<chave> --expectedSourceSha256 <hash>`.
   Prefira as continuações do mapa; use a mesma captura entre páginas.

## Autoria e entrega

- Tarefa controlada ativa usa `context`, `propose`, `continue` e `status`, conservando `task_id`, contrato e perfil.
  Falta de capacidade é um bloqueio específico; não recorrer a CLI, arquivos de infraestrutura ou publicação para contorná-lo.
- No perfil habitual de manutenção/compatibilidade, consulte `ssam_discover` antes de expressar o pedido.
  O contrato contextual O11 compartilha a estrutura, mas sua validação documentada é ODC; confira limites e provas O11.
- Entregue pelo controlador existente: candidato headless, Verify, base/hash, preview/merge nativo e recibos.
  O `deliver` já aplica e verifica o job; não reaplicar preventivamente o mesmo job em fixture e depois para entregar.
- Confira resultado e provas declaradas. Verify não substitui testes das regras de negócio no servidor.
  Publicação depende da capacidade e do fluxo autorizados da sessão; não assumir paridade com `studio_publish` do ODC.
- Para contratos de app, autoria HTML e checks específicos, leia apenas a seção pertinente de
  [kernel/AGENTS.md](../kernel/AGENTS.md). Manutenção do compilador/bridge/worker exige pedido próprio.

## Ambiente e dados publicados

- `ssam inventory|download|create-app|add-modules --lane o11` sem `--credentials` usa o Studio da faixa já logado,
  inclusive com SSO. Não peça arquivo de credenciais quando esse caminho atende.
  Operações cobertas e lacunas: [prova do ambiente conectado](../kernel/docs/proofs/2026-09-25-o11-connected-environment.md).
- `ssam data --lane o11` / `o11_data` usa o cliente nativo Edit Data; não criar actions/timers para registros
  quando essa entrada atende. Autenticação, FKs, paginação e recibos: [O11-DADOS-HEADLESS.md](O11-DADOS-HEADLESS.md).
- Chaves do modelo são convertidas para DatabaseValue pelo fluxo. Escritas exigem autorização registrada;
  resposta perdida não autoriza repetição.

Para packages de leitura, debugger ou falhas, consulte [OPERACAO-SSAM.md](OPERACAO-SSAM.md).
