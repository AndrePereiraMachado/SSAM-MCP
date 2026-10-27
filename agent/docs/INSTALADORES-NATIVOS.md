# Instaladores nativos — preparação em 27/10/2026

O cliente recebe somente o instalador e informa sua credencial na interface.
Node, SDK .NET, Xcode e fontes são dependências do build, nunca do cliente.

## Windows

`scripts/prepare-windows-runtime.mjs` recebe o pack verificado e cria uma pasta
nova com os dois auxiliares publicados como self-contained. Preserva as bridges
e os outros arquivos do manifesto; não altera a instalação dos Studios.
O núcleo escolhe o apphost somente quando há runtimeconfig self-contained e
hostfxr, hostpolicy e coreclr junto ao executável. Os packs legados continuam
com o caminho antigo. O doctor reconhece o runtime incluído.

O build do instalador usa o pack produzido, um núcleo Native AOT qualificado
e `scripts/build.mjs --platform win --pack ... --native ... --no-updates`.
O verificador de distribuição exige os runtimes incluídos e confere hashes,
ausência de fontes do núcleo e ausência de source maps.
Sem certificado Windows, o instalador é um candidato sem assinatura, sujeito
à reputação/avisos do Windows. Isso não equivale a distribuição assinada.

## Mac ARM64

`.github/workflows/agent-native-release.yml` aceita execução manual e push na
branch `codex/mac-native-installer`, sem publicação automática de releases.
Recebe tag de draft release, nome e SHA-256 do pack binário aprovado. Um pack
recebido do Finder precisa ser normalizado para tar.gz com pack.json na raiz e
verificado antes de virar entrada do build. Não publicar o ZIP bruto do kit.

O modo assinado do job macos-15 exige os secrets CSC_LINK (PKCS#12 em base64), CSC_KEY_PASSWORD,
APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD e APPLE_TEAM_ID. Não gravar valores em
fontes, docs, logs ou argumentos fornecidos pelo usuário no chat.

O núcleo é compilado e testado no runner, assinado antes de entrar no pack.
O build verifica Developer ID, equipe e hardened runtime; exclui o núcleo já
assinado de uma segunda assinatura pelo empacotador, que invalidaria seu hash.
O aplicativo é assinado e notarizado. Só depois de verificar hashes do pack,
codesign, stapler e Gatekeeper o job disponibiliza DMG e ZIP como artifacts.
O fluxo ainda precisa de execução real com certificado para ser validado.

O usuário autorizou depois o instalador sem assinatura. O input
`sign_and_notarize: false` dispensa todos os secrets Apple, produz DMG/ZIP sem
auto-update e mantém a verificação de integridade do aplicativo. Usa selo
ad-hoc local, sem identidade Apple, para preservar a validade do código ARM64.
Não executa
nem afirma sucesso em Gatekeeper. O certificado deixa de bloquear esse candidato;
as DLLs reais do Mac foram recebidas e verificadas contra o relatório de build.

Situação atual: usuário tem cadastro Apple, mas a tela enviada mostra inscrição
pendente de compra/ativação no Developer Program. CSR preparado fora do repositório;
chave privada com ACL restrita ao usuário. Nenhum certificado ou secret Apple
foi configurado. O runtime.zip recebido foi normalizado para uma entrada binária
verificada. O workflow compila o núcleo no Mac, empacota DMG/ZIP e testa também
a interface com o núcleo nativo e um servidor isolado. Não encaminhar outro kit
de compilação como instalador.

As bridges do relatório recebido foram compiladas para ODC 1.7.30.10980/net10
e O11 11.55.93.65333/net8. Não foram anexadas aos Studios. A janela de três
releases é alvo de qualificação; não há comprovação de seis combinações vivas
nem promoção de imagens correspondentes do servidor por este trabalho.

## Evidência do candidato sem certificado

O run GitHub Actions `40599309914` passou no Mac ARM64: 16 testes do app,
14 testes nativos Node, 23 testes C# e dois testes de interface (checkout e
aplicativo empacotado). O teste empacotado confirma `app.isPackaged`, usa dados
isolados, conecta ao servidor de teste, executa o doctor e encerra o núcleo.
A verificação do pack e `codesign --verify --deep --strict` passaram. Isso
valida a integridade ad-hoc, não identidade Apple nem notarização. O attach
real às duas instalações do Studio ainda requer teste no Mac do usuário.

O instalador Windows `ssam-agent-app-0.1.1-setup.exe` tem SHA-256
`d1fe3e4d5d602b88d33c222f6619e588c747aa308172d296df1d148377b9fb04`.

## Candidato 0.1.2: menos exposição na interface

Os dados passam a `%APPDATA%/SSAM-Agent/data` e `~/Library/SSAM-Agent/data`.
A pasta padrão anterior é movida inteira quando reconhecida, sem processo
ativo e sem destino existente. Pastas personalizadas, links e conflitos são
preservados; a decisão fica no log. Não há cópia ou exclusão de credenciais.
O Mac admite somente esse subdiretório específico da Library, mantendo as
recusas das demais pastas protegidas. Roaming evita a restrição já existente
do Studio sobre LocalAppData.

Foram retirados seletor de pasta, atalhos para abrir arquivos, caminhos,
versões de bridges e PIDs da tela principal e do menu. Logs ficam recolhidos
em diagnóstico; o menu padrão de desenvolvimento não aparece no pacote.
Isso reduz exposição casual, sem prometer criptografia ou impedir inspeção
dos binários pelo proprietário do computador.

O run `40601229512` passou os testes do Mac e abriu o aplicativo empacotado
com dados sob a nova Library. O mesmo teste do aplicativo empacotado passou
no Windows com dados sob Roaming; o verificador de integridade passou.
Windows SHA-256: `b39088fe3270140aabd6dae363e98c27170bc8a37b9e629b70d0b9d2fb0826bc`.
