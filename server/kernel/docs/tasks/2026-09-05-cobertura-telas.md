# Cobertura de telas no fluxo controlado

Pedido: cobrir telas e aplicar as alteracoes em SS4 e SS5, preservando modulos abertos.

## Criterio de pronto

- Contrato fechado para screens/blocks, widgets nativos, composicao OutSystems UI, parametros, estado, dados, eventos, navegacao e roles.
- Arvore, ordem, propriedades, argumentos e destinos lidos do modelo independentemente dos ops emitidos.
- Verify, save/reload, merge nativo, idempotencia e mutacoes validas rejeitadas por componente/contexto.
- Reparacao preserva identidade de telas/inputs/actions consumidas; nenhum escape para ops arbitrarios no perfil de app.
- Prova viva em laboratorios, instalacao/worker autenticados nas duas faixas e preservacao do trabalho aberto.
- Relatorio distingue cobertura estrutural de execucao/renderizacao no browser. Nao equivale a cobertura completa de regras de negocio.

## Progresso

1. Preservados os seis modulos abertos em `.local/screen-contract-dev/preserve`, com chaves e hashes. Incidents_CS/UI pertencem ao usuario e nao sao laboratorio.
2. SS4 e SS5 receberam as alteracoes anteriores em bridge/Core/CLI. Os seis modulos foram preservados, incluindo restauracao de referencias do Incidents_UI. Comparacao nativa final sem diferencas em todos; hashes de bridge, vendor e CLI iguais entre faixas.
3. Confirmada a lacuna: ModuleSpecification aceita data/logic/roles/exceptions; ScreenExpander possui cinco arquetipos Reactive/Mobile, sem prova independente nem reconciliacao. A extensao vai integrar telas no mesmo controlador/recibo, reutilizando os verbos existentes.

4. Trabalho amplo de telas e testes interrompido a pedido do usuario apos mostrar a baixa qualidade das paginas geradas. Codigo em desenvolvimento nao instalado nem concluido.
5. Nova direcao: autoria HTML/CSS/JS. Investigacao focada concluida em `docs/tasks/2026-09-05-investigacao-autoria-html.md`; proximo marco e uma prova vertical HTML -> OML -> navegador, antes de ampliar a matriz.
