# XIF: bibliotecas de extensões publicadas

Pedido: criar uma extensão de extração de texto de PDF inteiramente pelo MCP, sem exigir que a sessão localize DLLs.

## Contrato

`o11_extension {action:"publish", host, referencesFrom:["ExtensaoFonte"], spec, words, operationId}`.

O mesmo envio lê a versão publicada de cada fonte no host escolhido, exporta seus recursos em pasta privada nova,
inclui as DLLs marcadas como referência (exceto `OutSystems.*`) e os recursos de licença/notice, verifica conflitos
de nome/conteúdo e passa pelo verificador existente de dependências transitivas antes de compilar e publicar.
Não resolve pacotes NuGet. As bibliotecas precisam existir nas extensões fonte ou nos `spec.references` explícitos.

`referenceSources` registra extensão, versão, hash do XIF e quantidade de referências no resultado e no recibo.
A reconciliação pelo mesmo operationId preserva a origem e não publica novamente.
`o11_extension read` também retorna `exported.resources` e `exported.references` para inspeção explícita.

## Provas

- `XifPackageTests`: exportação preserva bytes/hash, nomes iguais de pastas distintas, recusa diretório existente,
  traversal no pacote e nomes de dispositivo antes de escrever.
- `o11-extension.test.mjs`: pipeline inteiro com ponte simulada, inclusão de licença, origem no recibo, reconciliação
  sem segundo envio, fonte ausente e conflito de DLL antes do build/publicação.
- MCP real, 2026-10-14: `PdfTextExtractor` criada e publicada no ambiente pessoal O11 da sessão, versão 173,
  usando `referencesFrom:["HMISPdfText"]` (fonte versão 152, 12 DLLs).
  Operação: `8f534db4-8ef8-4e60-9a3e-403a00b180d6`.
  XIF SHA-256: `441358c3f06521888581b8718beefa9bda659d442a03e44eb9c7b9327afc7518`.
  Action: `ExtractPdfText(PdfContent: BinaryData) -> Text`, com PdfPig e texto em ordem de páginas, sem OCR.
  A confirmação prova compilação/publicação; não é um teste de execução da action no servidor.

## Limitação de verificação do repositório

A suíte abrangente `tool-routes.test.mjs` também encontrou quatro enums `patch` não classificados no catálogo
(`studio_deliver`, `ssam_code`, `o11_job`, `ssam_job`), fora desta alteração. Os testes da extensão passaram.
