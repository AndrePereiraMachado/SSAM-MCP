# Bibliotecas Externas ODC pelo SSAM Hybrid

Uma Biblioteca Externa (External Library) é uma biblioteca C# publicada no ODC.
Ela traz actions e estruturas que os apps chamam como qualquer server action.
O SSAM Hybrid cria, compila, envia, publica, aplica a tag e referencia a biblioteca sem abrir nada na tela.
Uma chamada faz cada mudança. Estado: declarado e testado offline; falta a prova ao vivo (fim deste documento).

## A ferramenta

`odc_external_library {action, spec, authorize, operationUuid}`, com quatro ações:

| Ação | O que faz | Escreve no tenant? |
|---|---|---|
| `build` | Gera o projeto, compila e monta o zip. Não toca o tenant. | Não |
| `deploy` | O mesmo build e, na mesma chamada: envio, geração, publicação, tag e releitura. | Sim |
| `status` | Lê a biblioteca, as revisões, o runtime, os consumidores e os jobs abertos. | Não |
| `discard` | Apaga um job aberto (gerado e não publicado). | Sim, destrutivo |

Exemplo de spec:

```json
{ "name": "SSAMTextTools",
  "actions": [ { "name": "Reverse",
                 "inputs":  [ { "name": "Text",   "type": "Text" } ],
                 "outputs": [ { "name": "Result", "type": "Text" } ],
                 "body": "Result = new string(Text.Reverse().ToArray());" } ] }
```

- Tipos: Text, Integer, Long Integer, Decimal, Boolean, Date, Date Time, Time, Currency, Email, Phone Number, Binary Data, uma estrutura declarada, ou `<T> List`.
- O corpo usa os nomes declarados dos parâmetros. Uma saída vira o retorno; várias saídas viram parâmetros `out`.
- Opcionais: `description`, `structures`, `namespace`, `packages` (NuGet com versão exata) e `usings`.

## O fluxo do deploy

1. Spec: todos os problemas de uma vez (`EXTERNAL_LIBRARY_SPEC_INVALID`), sem iniciar processo nenhum.
2. Palavras do dono nomeando a biblioteca, ou uma concessão `publish` dela (`WORDS_MUST_NAME_LIBRARY`).
3. Guarda do tenant: somente leitura (`TENANT_READ_ONLY`); corporativo pede `confirmTenant` e palavras com o tenant (`CORPORATE_TENANT_GUARD`).
4. Build no kernel: `anvil-odc external-library build`. Projeto `net10.0`, SDK `OutSystems.ExternalLibraries.SDK` 1.5.0 fixado, `dotnet publish -r linux-x64`.
5. Zip determinístico: o mesmo spec dá o mesmo sha256 em qualquer pasta. Portões: um `.deps.json`, .NET 10, até 90 MB.
6. Os dois planos de credencial (API pública e Portal) e a rota interna de publicação, antes de qualquer mudança.
7. Leituras: nome livre, job aberto, consumidores, elementos publicados e tag. Todos os problemas numa recusa só.
8. Recibo, envio do pacote e espera da geração dentro da chamada (até 600 s).
9. Publicação do job pela janela do Portal, acompanhada até o fim.
10. Tag da revisão (patch seguinte, ou 1.0.0) e releitura de revisão, tag e runtime .NET 10.
11. Uma resposta: biblioteca, revisão, tag, runtime, consumidores desatualizados e o job de referência.

## Credenciais

Nunca usuário e senha. Nunca no chat.

1. A sessão do ODC Studio no tenant: API pública pela bridge (`portal-call`, `portal-upload`) e Portal pela janela dentro do Studio (`odc_portal_login` uma vez).
2. Sem Studio aberto: o API Client e a conta do Portal guardados no cofre do Windows.
3. Sem nada guardado: o prompt privado do Windows abre. O dono digita lá e repete a chamada.

O PUT do pacote vai para a URL pré-assinada sem cabeçalho `Authorization`. As URLs nunca aparecem na resposta, no recibo ou no journal.

## Consumidores

- Remover ou mudar uma action ou estrutura com consumidores quebra esses apps.
- Isso é tratado como destrutivo: as palavras nomeiam cada consumidor (`CONSUMERS_WOULD_BREAK`, regra do SSAM).
- Concessão permanente nunca cobre essa quebra.
- Depois do deploy, cada consumidor fica desatualizado. Ele precisa de `studio_refresh_references` e de nova publicação.
- O SSAM nunca diz que um consumidor não precisa republicar.

## Referenciar a biblioteca num app

Pelo job de referência que já existe, no `studio_deliver`:

```json
{ "ops": [ { "op": "reference", "producer": "SSAMTextTools", "elements": ["IServerAction:Reverse"] } ] }
```

A entrega captura a assinatura pela sessão do consumidor e o kernel importa a dependência.
Bridge antiga recusa o produtor. A entrega responde `BRIDGE_UPGRADE_REQUIRED` antes do build: feche e abra o ODC Studio, depois `studio_attach`.

## Apagar

- Um job aberto: `odc_external_library {action:"discard", jobKey, authorize}`. As palavras nomeiam a biblioteca.
- A biblioteca: `odc_asset_delete`. As palavras nomeiam a biblioteca e cada consumidor.

## Incerteza

- Resposta perdida depois de um envio: `UNCERTAIN`. Nada é reenviado.
- A mesma chamada, com o mesmo `operationUuid`, lê o estado exato (job pelo nome do arquivo, publicação pela biblioteca, tag pela revisão) e continua.
- Dois candidatos para o mesmo passo: `AMBIGUOUS`, com a evidência.

## O que a máquina precisa

- .NET 10 SDK no PATH (`DOTNET_SDK_MISSING` sem ele).
- Acesso ao NuGet para restaurar o SDK e os pacotes (`NUGET_RESTORE_FAILED`).
- Erro de C# no corpo volta como `EXTERNAL_LIBRARY_BUILD_FAILED`, com a action e a linha do corpo.

## Limites

- Só corpo C# sobre os parâmetros declarados. Modo "source" (projeto pronto) fica fora.
- Migração de extensão O11 para biblioteca externa fica fora.
- Login Cognito com usuário e senha do Portal fica fora.

## Prova ao vivo (com o dono)

1. Token do Studio aceito na API de bibliotecas (GET `/uploads`).
2. PUT pré-assinado a partir da bridge.
3. Rota interna de publicação pela janela do Portal.
4. Tag e releitura .NET 10 (o texto do campo `runtime`).
5. Formato da assinatura de uma External Library no `reference-snapshot`.
6. Import nativo num app e chamada em runtime.
7. Delete com consumidores.
