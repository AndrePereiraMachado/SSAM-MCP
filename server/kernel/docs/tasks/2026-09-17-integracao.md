# Integração: uma sessão, as duas plataformas (passo 5 do INT)

Data: 2026-09-17, madrugada. Tudo abaixo foi executado a partir de **um diretório só**
(`C:\Users\andre\SSAM-Hybrid-ODC`) e por **um comando só** (`ssam`), sem trocar de pasta e sem abrir outro servidor MCP.

## 1. Os dois Studios reiniciados, o bridge reanexado

| Passo | Comando | Resultado |
|---|---|---|
| Fechar o ODC Studio | janela fechada (pid 39872) | fechou limpo; o módulo estava publicado, nada por salvar |
| Reabrir | `ODCStudio.exe` | novo pid 60580 em 25 s |
| Reanexar o bridge | `.\odc attach` | `attached=true`, bridge v28, **2 s** |
| Abrir o módulo | `.\odc studio open WrightFlood` | `versionId 9`, `assetRevision 9`, `published=true`, `openedFrom PublishedVersion`, `modified=false`, 9 s |

O `versionId 9` é a revisão que o próprio ciclo publicou minutos antes (T6 do WS2): kernel → merge nativo → publish →
servidor → Studio novo. O ciclo fecha sobre si mesmo, com prova em cada ponta.

## 2. O mesmo trabalho nas duas faixas, medido

O mesmo fragmento HTML (`tests/html/visual/alert.html`, op `html` com `parent`) vira widgets nativos nas duas
plataformas. Um comando por faixa, a partir da raiz do SSAM-Hybrid-ODC:

```powershell
.\ssam job tests\jobs\html-visual-alert.json --lane o11
.\ssam job tests\jobs-odc\html-visual-alert.json --lane odc
```

| Faixa | Tempo até o candidato | ops | objetos do módulo | Verify | Como executa |
|---|---|---|---|---|---|
| o11 | **1,4 s** | 22 | 11 354 | `isValid`, 0 mensagens | worker residente (`anvil serve`, faixa ss5) |
| odc | **3 s** | 22 | 59 667 | `isValid`, 55 mensagens pré-existentes do módulo | worker residente (`anvil-odc serve`, porta 4547) |

Meta do plano: menos de 3 minutos por faixa. Ambas passam com folga.

**Como a faixa ODC saiu de 14 s.** Na primeira medição desta noite ela levava 13 a 14 s, porque cada chamada subia um
processo, ligava as DLLs do ODC Studio, inicializava o provedor de features e só então carregava o módulo. O worker
residente (`anvil-odc serve`, o mesmo desenho do `anvil serve` da faixa O11) faz isso **uma vez por processo**:

| Caminho | Tempo do mesmo job |
|---|---|
| Processo frio (como era) | 13 a 14 s, toda vez |
| Primeiro pedido num worker novo | ~15 s (JIT e primeira carga) |
| Pedidos seguintes | **~3 s** |

Os ~2,7 s que sobram são a carga de um OML de 6,5 MB com 59 667 objetos. Não são desperdício: como na faixa O11,
**cada `apply` carrega a base do zero**, de propósito, para não haver estado de modelo entre pedidos. Quem quiser o
caminho frio tem `ANVIL_ODC_NO_WORKER=1`, e o resultado é idêntico (verificado: mesmo `ok`, mesmos ops, mesmo Verify).

## 3. O que um agente encontra hoje

- `ssam doctor` mostra as duas faixas lado a lado; `ssam job --lane o11|odc` aplica um job em qualquer uma delas.
- O MCP `ssam` está registrado no escopo de usuário do Claude Code, no escopo de projeto
  (`SSAM-Hybrid-ODC\.mcp.json`) e no Codex. As ferramentas das duas faixas ficam no mesmo servidor, mais `ssam_job`
  (`lane: o11|odc`) e `ssam_doctor`.
- Faixa ODC headless: `dotnet test tests/Anvil.Tests.Odc -c Release` → 9/9 (6 jobs + 3 fatos sobre o adaptador).
- Faixa O11: suíte completa 1111 testes, 58 falhas, todas anteriores à unificação
  (`docs/tasks/2026-09-17-int-vermelhos.md`).

## 4. O que falta, e é do dono

A sessão **fria de verdade** (uma LLM que abre sem nenhum contexto desta conversa) é a última prova, e quem a abre é
o dono. O prompt a usar, numa sessão nova aberta em `C:\Users\andre\SSAM-Hybrid-ODC`:

> Crie um bloco de alerta pelo HTML no módulo Headless_UI (faixa o11) e no WrightFlood (faixa odc), usando o `ssam`.

O que ela deve encontrar sozinha: `AGENTS.md` seção 3.5 (autoria visual), `docs/lanes.md` (as duas faixas e o CLI
`anvil-odc`), `docs/UI-HTML-VISUAL.md` (a tabela fechada da sintaxe). Se precisar sair da pasta ou abrir outro
servidor MCP, o requisito 1.1a do plano falhou.
