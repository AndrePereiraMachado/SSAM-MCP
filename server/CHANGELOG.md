# Mudanças do servidor hospedado

- 2026-10-15, `feat/studio-build-identity` (A-M1, E1, E2 da proposta mínima de várias versões): o servidor identifica o
  Studio do licenciado pelo build de 4 números. Outra versão é recusada numa resposta só, pela direção
  (`STUDIO_UPDATE_REQUIRED` / `STUDIO_VERSION_NOT_SERVED_YET`, antes `STUDIO_VERSION_NOT_SERVED` / sem `cause`), com os
  dois builds, o que continua funcionando, "nada rodou" e o texto em pt-BR. Outro build da mesma versão segue
  `kernel.json` `studioBuildPolicy` (`warn`, o padrão, com `studioBuildDiffers` em toda resposta; ou `refuse`). As
  ferramentas só de servidor avisam `studioNotServed`. O log ganhou `studios` em `agent-connected` e os eventos
  `studio-version-unserved` e `studio-builds`. Detalhes: `docs/FASE2-AGENTE.md` 7 e `deploy/DEPLOY.md` 7.1.
