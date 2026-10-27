# Migração do núcleo local do SSAM Agent

Estado em 27/10/2026: **candidato Windows integrado ao Electron; não publicado nem aprovado para produção**.
Electron continua responsável por tray, painel, login item, supervisão e atualizações.
O executável C# é Native AOT. Pacotes Windows com `nativeCore` executam esse processo
para `run`, `setup` e `doctor`, sem importar o agente JavaScript. O caminho legado
permanece para compatibilidade dos testes e dos pacotes legados. O caminho nativo
macOS está implementado como candidato, ainda sem qualificação em um Mac real.

## Código e dados

O app usa `installedPack: true`: inicia o runtime de `resources/pack`, verifica
seus hashes e passa `--runtime-root` separadamente de `--root`. Não copia a árvore de
fontes para a pasta de dados. `setup`, estado, credencial, logs, inbox, snapshots e
diários continuam na raiz de dados configurada pelo usuário.

O caminho padrão dos dados permanece `%USERPROFILE%/SSAM-Agent` ou `~/SSAM-Agent`.
Não foi necessário relaxar as restrições de LocalAppData, Library e espaços dos
caminhos entregues ao Studio. `agent:<rel>` e `hello.agent.root` continuam descrevendo
exclusivamente os dados. Caminhos de instalação não entram na API de arquivos.

Migração de uma instalação anterior:

1. Manter a raiz e a configuração existentes; não mover nem apagar arquivos.
2. Encerrar o processo antigo antes de iniciar outro; o supervisor mantém sua detecção.
3. Executar somente o runtime da instalação nova. Fontes antigas eventualmente presentes
   na raiz são ignoradas, preservadas para recuperação e nunca importadas.
4. Atualizar o pacote e o kernel servido juntos quando a versão da bridge mudar.
   Uma DLL residente continua carregada até o Studio encerrar; não substituir essa DLL.

### Bridge ODC v98

A v97 derivava `snapshots` e `journal` da localização da DLL. A separação de raízes
precisa da v98, que implementa `agent-root {"root":"<dados>/odc"}` no pipe local.
Uma bridge dentro de um pacote não aceita comandos normais nem cria snapshots antes
desse vínculo. O diretório precisa ter o layout de dados preparado pelo agente.
O vínculo é imutável depois do primeiro uso; repeti-lo com o mesmo diretório é idempotente.
O comando não pertence à allowlist que o servidor hospedado pode enviar.

O agente confirma o vínculo depois do attach e antes de comandos ODC. Recusa ou perda
da resposta não autoriza executar o comando da aplicação. Uma falha depois do attach
continua com resultado de attach incerto (`executed: null`), nunca com permissão de repetição.
Pacotes antigos são recusados pelo build do app e pelo supervisor em modo instalado.
O uso local da bridge fora de um pacote preserva o diretório de checkout.

A O11 recebe os caminhos de bridge e hook da instalação, mas mantém autoridade,
conexão e recibos nos dados. O hook de desenvolvimento ainda exige sua pequena cópia
binária ao lado da configuração por attach. O hook de release h1 já carrega em seu
lugar e usa a pasta de intercâmbio. Nenhum deles foi convertido cegamente para AOT.

## Candidato C#

`native/Ssam.Agent` usa .NET 10, `PublishAot`, trimming e avisos como erros. O código
do canal não carrega JavaScript nem assemblies do Studio. `Workspace.cs` implementa
a gramática de caminhos, confinamento, verificações de links e transformação de
campos de caminho de manifests. A suíte compara decisões com a implementação atual.

O comando `qualify` aceita apenas um servidor HTTP em `127.0.0.1`, uma credencial
artificial fixa via stdin e uma pasta de teste vazia. Não aceita credenciais reais.
Sua única operação de bridge faz `ping` numa simulação TCP local; isso não equivale
a uma integração comprovada com Service Studio.

Já estão portados `file.put`, `file.get`, `file.list` e `file.sync`, incluindo blobs em
partes, hashes por parte e do arquivo, tentativas limitadas, substituição por rename,
manifests `agent-paths`, parâmetros por blob e resultados grandes por blob. Esses
comandos são exercitados no mesmo canal de qualificação e somente nos dados temporários.

Também estão implementados `studio.processes`, `odc.pipe`, `odc.attach`, `o11.bridge`,
`o11.connect`, `o11.selected` e `net.probe`. As listas de comandos, posições de caminhos,
manifests, versões dos processos e janela de compatibilidade permanecem controladas.
Os auxiliares de attach e as bridges continuam assemblies gerenciados, carregados
onde esse formato é necessário; o núcleo não depende de Node.

`setup` valida URL/credencial e restringe `private` com ACL antes de gravar a chave.
`run` verifica hashes, mantém lock exclusivo, heartbeat, estado e log sem credenciais.
`doctor` verifica pacote, configuração, runtime de attach e inventário instalado.
O teste de integração usa o supervisor real, credencial sintética, hub local e bridge
TCP simulada; testa configuração, conexão, caminhos de retorno, parada e reinício.
Isso não equivale a publicar uma aplicação real no Studio.

Validação do desenvolvimento, dentro de `agent/`:

```text
npm run native:test:managed
npm run native:build -- win-x64
```

O primeiro comando não prova Native AOT. O segundo publica para a arquitetura nativa,
recusa um PE com cabeçalho CLR, executa as mesmas suítes no binário publicado e cria
uma pasta nova em `.local/native/` contendo apenas o executável e `qualification.json`.
Não copia PDB, sourcemap, fontes, DLL gerenciada ou runtime Node. O recibo registra
hash e tamanho, com `productionReady: false`. Builds macOS precisam ocorrer em um
Mac da arquitetura correspondente (`osx-arm64` ou `osx-x64`).

Pré-requisitos oficiais: [Native AOT deployment](https://learn.microsoft.com/en-us/dotnet/core/deploying/native-aot/).
Windows precisa das ferramentas C++ do Visual Studio; macOS precisa das Command Line
Tools do Xcode. A ausência do linker não é evidência de incompatibilidade da arquitetura.

## Pacote Windows e validações pendentes

`scripts/native-pack.mjs` produz uma árvore nova a partir de um pack verificado e um
PE x64 sem cabeçalho CLR. Copia apenas o núcleo, helpers, bridges e metadados de runtime;
recusa fontes, scripts e símbolos por meio de uma lista de extensões e raízes permitidas.
`scripts/build.mjs --platform win --pack <zip> --native <exe> --no-updates` prepara essa
árvore e gera o instalador local com `--publish never`. O ASAR contém a interface
Electron, que continua JavaScript; não é apresentado como código nativo.
`node scripts/verify-native-distribution.mjs dist/win-unpacked` confere o manifesto,
recusa arquivos extras/fontes/símbolos e verifica o executável PE x64 sem cabeçalho CLR.
Os recibos locais ficam em `.local/native/distribution-verification.json` e
`.local/native/installer-verification.json`.

O Service Studio instalado nesta máquina é 11.55.94, com .NET 10. Sua bridge fina foi
compilada com restore/build `-p:TargetFramework=net10.0` e `-p:SSDir=<instalação>`, depois
usada como prebuilt no pack. O build legado net8 tenta misturar referências BCL 8/10 e
falha nessa instalação. Isso não altera o framework dos clientes com Studios mais antigos.

Pendências para homologação:

- Exercitar operações de aplicação e publicação em um ambiente de homologação.
  Após o usuário fechar a sessão anterior, o Service Studio 11.55.94 foi reaberto e
  o attach real da bridge fina passou pelo núcleo nativo, com identidade, hash da
  bridge, `o11.selected` e `ui_alive` confirmados. O hub era sintético local, com
  credencial de teste e porta própria. Nenhuma publicação ou alteração de módulo
  foi feita. Evidência local: `.local/native/live-o11-verification.json`.
- Validar o fluxo com o hub hospedado de homologação, sem credenciais de produção.
- Testar atualização assinada e instalação sobre uma versão publicada. O build local
  não realiza publicação, assinatura de release nem atualização remota.
- Qualificar as duas arquiteturas macOS num Mac real. Testes de regras POSIX no Windows
  não provam attach, permissões, assinatura, notarização ou comportamento do Studio no Mac.

Validações executadas nesta máquina:

- 11 testes sobre o executável Native AOT: canal/reconexão, credenciais recusadas,
  blobs/arquivos, políticas de comandos/caminhos e integração do supervisor.
- Painel Electron compilado: formulário de configuração, IPC do preload em sandbox,
  estado conectado, diagnóstico nativo e parada limpa, com hub local sintético.
- Bridge ODC v98 real em processo de teste isolado: binding da raiz de dados,
  recusa de realocação e parada; um teste adicional passa pelo canal nativo e pelo
  named pipe Windows até essa DLL, verificando o diário na pasta de dados.
- 16 testes existentes da aplicação, oito testes de layout/versão e dois testes
  C# da política de raiz. Depois desses testes isolados, foi realizado o attach
  real descrito acima na nova sessão de Service Studio.

O teste visual opcional é `tests/native/electron-smoke.test.mjs` e recebe
`PLAYWRIGHT_MODULE` apontando para uma instalação de Playwright do host. Os testes
`bridge-root.test.mjs` e `odc-wire.test.mjs` recebem `SSAM_TEST_ODC_BRIDGE` e
`SSAM_TEST_STUDIO_DIR`; o segundo também recebe `SSAM_NATIVE_EXE`. Seu apphost é um
fixture isolado renomeado para exercer a identificação de processo, não um Studio real.

## Continuação macOS

`DiagnosticIpc.cs` porta o protocolo DOTNET_IPC_V1 para C#, com ProcessInfo2,
ApplyStartupHook, frames limitados e transporte por socket Unix. `MacPlatform.cs`
descobre bundles, versões, executáveis e sockets, confere identidade e início do
processo e fornece `mac-inspect`, somente de leitura. `UnixStudioPipe.cs` serializa
comandos por socket e exige uma nova identidade de inode/nascimento antes do próximo
envio; timeouts após envio não provocam repetição. Setup aplica 0700 à pasta privada
e 0600 à configuração e credencial. O caminho Mac usa diagnóstico nativo sem helper
dotnet instalado; SDK e Xcode são necessários somente para compilar este candidato.

Treze testes de protocolo, fila e raízes passaram no Windows, junto com os onze testes
do executável AOT recompilado. Isso não valida os caminhos macOS exclusivos. O
supervisor e o empacotador aceitam Mach-O da arquitetura do host; DMG/ZIP nativos
recebem somente essa arquitetura, sem misturar núcleo ARM com Electron Intel.
O hook h1 continua recusado no Mac; apenas o pack de desenvolvimento é candidato.

`scripts/mac-readiness.sh` produz um relatório somente de leitura para o Mac de teste:
arquitetura, versão do macOS, Xcode Command Line Tools, SDK .NET e Studios instalados.
Não coleta logins, módulos, ambiente de variáveis ou credenciais. Um Mac de um
colaborador do usuário foi disponibilizado para a próxima validação: Apple Silicon,
com ambos os Studios instalados. SDK/Xcode e versões exatas ainda precisam ser
confirmados. Não há acesso remoto a esse Mac nesta sessão.

`node scripts/make-mac-native-kit.mjs` cria em `.local/native/` um kit tar.gz com
fontes locais permitidas explicitamente, testes, interface e DLLs de desenvolvimento
verificadas. Exclui servidor, histórico Git, dependências instaladas, logs, módulos e
credenciais. `bash scripts/mac-native-check.sh` no kit compila `osx-arm64`, roda os
testes isolados e grava `mac-report.json` por inspeção somente de leitura. Instruções
em `BUILD-MAC.txt`. Compatibilidade das DLLs com as versões instaladas, attach real,
assinatura e notarização dependem do teste no Mac. O kit é material de compilação,
não um instalador final.

Primeira execução no Mac Apple Silicon do colaborador: SDK 10.0.300, Xcode
disponível e Node 24.16.0. A compilação Native AOT passou e dez dos onze testes do
executável passaram, incluindo o supervisor. O teste de caminhos revelou que o
destino de um link interno pode reintroduzir `/var` depois de a raiz ter sido
resolvida para `/private/var`. `Workspace.RealPath` agora também resolve os
ancestrais do destino de cada link, com limite de profundidade; o teste cobre
aliases internos permitidos e aliases para `private` recusados. A correção ainda
precisa ser executada no Mac; o script anterior parou antes de `mac-inspect`.

Na execução seguinte o relatório foi gerado, mas os Studios não foram reconhecidos.
A listagem fornecida mostrou os processos reais em
`<Studio>.app/Contents/Resources/app/<Studio>.app/Contents/MacOS/`.
O detector agora inspeciona esse bundle interno de mesmo nome, usa seu plist e
executável e mantém o bundle externo como raiz instalada. Não percorre bundles
auxiliares arbitrários. Três testes adicionais verificam as duas faixas e a recusa
de auxiliares; o script revela o relatório no Finder. Reconhecimento e diagnóstico
dos processos reais ainda dependem da próxima execução no Mac.

O relatório detalhado subsequente confirmou os dois bundles internos e suas DLLs,
mas ambos falharam ao analisar `Info.plist` como texto XML (`Data at the root level
is invalid`, linha 1). A leitura agora normaliza o plist com `plutil -convert xml1
-o -` no Mac e passa bytes ao leitor XML para respeitar BOM/codificação. Testes
incluem UTF-8, UTF-16 LE/BE e bundles com plist UTF-8 com BOM. A validação dessa
correção nos arquivos reais do Mac permanece pendente.

Confirmação recebida do Mac com o kit `Nn0JuP`: os 11 testes do executável ARM64
e os 19 testes C# passaram. Foram reconhecidos ODC `1.7.12.10367` (PID 96114)
e Service Studio `11.55.93.65333` (PID 98193), com ProcessInfo2, instante de início
e socket diagnóstico confirmados em ambos. Nenhuma bridge foi anexada por essa
inspeção. O pack ainda contém bridge O11 compilada para `11.55.94`; conferir
runtime e compatibilidade ou compilar para a versão instalada antes do teste vivo.
`macOSValidated: false` continua correto: a conexão real das bridges não foi testada.

Os runtimeconfigs recebidos confirmaram .NET 8.0.32 no O11 e 8.0.28 no ODC.
A bridge O11 do primeiro kit era net10 e não deve ser anexada a esses processos.
`scripts/mac-build-bridges.sh` compila as bridges contra as referências locais,
com alvo net8, registra as versões exatas e gera um novo pack verificado em
`.local/mac-bridges-*/runtime`. O kit inclui somente os projetos/fontes compilados
nas bridges locais e os targets de build necessários. O relatório é
`mac-bridge-build.json`, com log em `mac-bridge-build.log`; a compilação não anexa
bridges nem altera módulos. Os 37 fontes da fina, um do hook e 32 da bridge ODC
foram conferidos por avaliação dos projetos no kit; build e conexão no Mac pendentes.

Nenhum pacote foi publicado e nenhuma credencial de produção foi utilizada nesta
etapa. Hashes verificam integridade em relação ao manifesto, não autenticidade de um
manifesto alterado junto com o binário. Assinatura e atualização autenticada continuam
necessárias. Compilação nativa e ofuscação compatível dificultam inspeção; não impedem
engenharia reversa. A lógica mais valiosa continua no servidor.

### Janela de compilação do kit Mac — 27/10/2026

`scripts/studio-build-plan.mjs` fixa três releases por faixa: ODC 1.7.30,
1.7.29 e 1.7.28; O11 11.55.94, 11.55.93 e 11.55.92. A instalação local
confirma ODC 1.7.30.10980 e O11 11.55.94.65328. Os registros locais de releases
e bundles confirmam os anteriores. As páginas públicas de release notes
consultadas estavam defasadas (ODC 1.7.28 e O11 11.55.91); não são prova de
que a lista mais recente delas corresponde ao produto atualmente instalado.

O kit recompila contra as DLLs do próprio Studio, lendo seu runtimeconfig
(net8/net9/net10), com restore e rebuild explícitos. O relatório versão 2
registra cada build e uma matriz das seis releases: `not-tested` não vira
`passed` por estar na janela. Pré-validação de uma faixa não impede a outra.
Qualquer falha impede a criação do pack combinado. ODC 1.7.12 é recusado com
as três opções aceitas antes de tentar compilar.

Packs locais incluem `studioBuilds`, com build exato e framework de cada
faixa. O núcleo nativo exige o mesmo build (inclusive quarto componente)
antes de usar a bridge; atualizar Studio exige recompilação. A política de
roteamento do servidor permanece independente: sua imagem precisa atender
à versão selecionada. Nenhuma imagem de servidor foi criada ou promovida
por esta mudança, e o manifesto de deploy existente ainda tem duas versões
por faixa. Portanto, esta etapa não certifica suporte hospedado completo
às seis releases.

Validação local: builds reais das bridges ODC 1.7.30 e O11 11.55.94 passaram;
14 testes Node e 22 testes C# do núcleo passaram. O bundle reduzido O11
11.55.93 disponível localmente não contém todas as DLLs de interface exigidas
pela bridge; sua tentativa de build falhou por referências ausentes.
As seis combinações reais de Studio no Mac continuam pendentes. A compilação,
por si só, também não qualifica attach, leitura, merge ou publicação.
