# Correção remota de compatibilidade — 27/10/2026

Aplicada com autorização do usuário após o erro AGENT_PACK_MISMATCH no agente 0.1.3.

- Código: 908de74, agent-hub.mjs. Hash em produção: d27b33f0d4daf8a79be00179656c00ac567e38f9f4b9f5f573cb167ece74cb7a.
- A única diferença contra o arquivo anterior da imagem é aceitar bridge O11 cuja versão corresponda ao Studio local mais novo já admitido pela política existente.
- v98 adicionada a odcBridgeAccepted nos dois kernel.json específicos de versão. v97 continua sendo a versão da imagem; não anunciar kernel novo ou três versões nativas qualificadas.
- Aplicação persistente: bind mount somente leitura /opt/ssam/hotfix-908de74/agent-hub.mjs nos dois backends, salvo nos campos docker_compose_raw e docker_compose do serviço Coolify e no compose do host.
- Backups privados: /opt/ssam/hotfix-908de74/compose.before.json e compose.file.before.yml; cada kernel.json tem cópia .before-908de74. Incorporar a correção à próxima imagem e remover o mount nessa promoção para evitar sobrepor código futuro.
- Ao recriar, a rede externa coolify que era anexada pelo gerenciador não estava explícita no compose. A conexão foi restaurada e persistida para os dois backends. Ambos voltaram a healthy e /health voltou a ok:true.
- Testes: 40 passaram, um drift test foi ignorado por layout de checkout; teste isolado com imagem real e teste no container atualizado confirmaram aceitação de 11.55.94/v98 e recusa de bridges não correspondentes.
- Após reinício foram observadas reconexões reais com O11 11.55.94.65328 e 11.55.93.65333, ambos reportando ODC 1.7.30.10980. Isso comprova reconexão do canal, não execução de operações nos Studios.

Reversão: restaurar arquivo anterior no mount e os dois kernel.json de backup, reiniciar apenas os backends. Manter a conexão externa coolify; se remover o mount, atualizar também os dois campos de compose no Coolify. Nunca imprimir o conteúdo integral do compose, que contém configuração privada.
