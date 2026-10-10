# Conectar ao ODC Studio aberto com runtime assinado

## Atualizacao: conexao confirmada em 29/09/2026, 19:34 BRT

Na nova verificacao, `VerifiedAndReputablePolicyState` estava em 0; esta tarefa nao alterou a
politica. Nao havia ODC Studio aberto. A instalacao oficial foi iniciada normalmente e o comando
`odc attach --pid 49484` anexou a bridge v30 com sucesso. O status vivo respondeu `ok: true`,
`bridge: v30`, `busy: null`, sem modulos abertos. Uma consulta separada `status bridge` confirmou v30.
O processo foi iniciado em `2026-09-29T22:33:55.0671061Z`.

Assim, neste estado do Windows o certificado nao foi necessario para conectar. O fluxo de assinatura
abaixo permanece disponivel para maquinas que exigem codigo assinado; nao e um requisito universal
do SSAM ou do ODC. Nao houve mudanca da instalacao, do modelo ou publicacao. Esta prova confirma
attach e status, nao autoria, merge ou publicacao. Evidencias em `.local/odc-connections/` na raiz.

O ODC ja usa `DiagnosticsClient.ApplyStartupHookAsync` para carregar a bridge em um processo
aberto da instalacao oficial. Nao exige copia da instalacao, reinicio, salvar ou publicar o modulo.
O cliente e a bridge continuam sendo necessarios, mas ficam fora da instalacao do Studio.

## Diagnostico de 29/09/2026

O processo observado era ODCStudio PID 12016, versao 1.7.26.10800. A tentativa de attach foi
recusada antes da execucao do cliente `ODC3.Bridge.Client.dll`: HRESULT `0x800711C7`.
O evento 3077 de CodeIntegrity identificou a politica `VerifiedAndReputableDesktop`, com status
`0xc0e90002`. O Smart App Control estava ativo (`VerifiedAndReputablePolicyState = 1`).
O cliente e a bridge v30 nao tinham assinatura Authenticode. Nao havia certificado de assinatura
de codigo nos repositorios pessoais CurrentUser/My e LocalMachine/My consultados.
Isso comprova o bloqueio do cliente; nao comprova a compatibilidade da bridge com a atualizacao do Studio.

As leituras realizadas nao encerraram o Studio nem salvaram, publicaram ou alteraram seus modelos.
O pacote headless selecionado tambem reportou dependencia ODC alterada. Esse pacote tem sua propria
qualificacao e nao e alterado por este fluxo de assinatura.

## Preparar e assinar

Na raiz operacional:

```powershell
.\scripts\odc-runtime-signing.ps1 -Mode Prepare
```

O comando copia o runtime compilado para `platforms/odc/.local/signed-runtime/<id>/` e registra
os hashes originais. Nenhum arquivo e carregado. O conteudo funcional da bridge permanece v30;
apenas uma assinatura sera adicionada a uma copia. Uma mudanca no codigo da bridge continua
exigindo uma versao nova. A pasta sob `platforms/odc` permite que a bridge encontre a raiz correta.

Para certificado de assinatura de codigo ja provisionado no armazenamento privado do Windows:

```powershell
.\scripts\odc-runtime-signing.ps1 -Mode Sign -BundleId <id> -CertificateThumbprint <thumbprint> -TimestampServer <URL-HTTP-do-provedor>
```

O script assina somente o cliente e a bridge SSAM e preserva as assinaturas Microsoft das dependencias.
Nao recebe senha/PFX, exporta chave privada ou cria certificados/raizes de confianca. O provedor pode
solicitar seu PIN em uma interface privada. Para servicos remotos, use a integracao oficial do seu
provedor nesses mesmos dois arquivos e prossiga com Verify; nao envie credenciais para o chat.
Assinatura ou timestamp incompletos nao selecionam o pacote. Preserve a tentativa para diagnostico.

Smart App Control requer um emissor publicamente confiavel. Um certificado autoassinado ou de PKI
privada nao resolve esse requisito. A verificacao Authenticode local nao equivale a uma garantia de
aceitacao pelo Smart App Control: a politica do Windows continua avaliando o carregamento real.

## Verificar, selecionar e conectar

```powershell
.\scripts\odc-runtime-signing.ps1 -Mode Verify -BundleId <id>
.\scripts\odc-runtime-signing.ps1 -Mode Activate -BundleId <id>
.\odc attach --pid <PID-atual-do-ODCStudio>
.\odc studio status bridge --pid <PID-atual-do-ODCStudio>
```

Verify exige assinatura valida em todas as DLLs e configuracao identica a copia preparada.
Activate verifica novamente e registra a selecao, preservando a anterior. Nao anexa ao Studio.
CLI/MCP passam a usar o cliente e bridge selecionados; hashes divergentes, arquivos extras ou
protocolo alterado produzem erro, sem fallback para binarios nao verificados. Nao substitui DLLs
carregadas nem muda a instalacao. Sessoes que estao executando uma operacao devem termina-la antes
de selecionar outra versao. Um MCP aberto antes desta mudanca precisa ser reconectado para ler o novo codigo.

Se o attach tiver resultado incerto, consulte o processo, status e evidencias antes de repetir.
Uma assinatura aceita libera o teste de conexao; so o status vivo confirma a bridge operacional.
Este fluxo cobre o attach. Builder, worker e pacotes headless continuam com sua verificacao propria.

## Provedor de assinatura

Nao ha compra ou criacao automatica de conta neste fluxo. E necessario um certificado publico
de code signing ou um servico com identidade validada. A escolha depende da elegibilidade do titular.
Na documentacao consultada em 29/09/2026, Microsoft Artifact Signing Public Trust para individuos
aceita EUA/Canada; a lista de paises de organizacoes nao inclui Brasil. A existencia da regiao Azure
Brazil South nao equivale a elegibilidade para Public Trust. Nao criar recurso pago antes de verificar.

- [Microsoft: assinatura para Smart App Control](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/code-signing-for-smart-app-control)
- [Microsoft: elegibilidade do Artifact Signing](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart#prerequisites)
- [Microsoft: Set-AuthenticodeSignature](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/set-authenticodesignature)

Nenhuma politica de seguranca e desativada ou alterada pelo script.

## Validacao desta implementacao

Em 29/09/2026: 10 testes de selecao/integridade passaram e o teste MCP existente passou.
Prepare gerou o bundle `a91d9475ea3948c0b2580ced34907833`. Verify recusou a DLL real sem
assinatura e confirmou ausencia de `verified.json` e de `selected.json`: nenhum runtime foi ativado.
Assinatura, timestamp e attach com assinatura ainda nao foram testados, pois falta certificado/servico.
Durante a verificacao final, o PID 12016 ja nao existia; nenhum comando desta tarefa o encerrou.
Identifique o PID atual antes de uma futura conexao.
