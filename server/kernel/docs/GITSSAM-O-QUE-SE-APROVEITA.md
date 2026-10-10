# O que se aproveita do GitSSAM

O GitSSAM foi construido sobre TRACE e REFLECTION. O aviso do dono do projecto -- "tem muita coisa que pode
estar feita por caminhos tortos e piores" -- foi tomado como a pergunta central desta escavacao, e nao como
uma nota de rodape: cada coisa encontrada leva o CAMINHO por que la chegou, separado do FACTO que descobriu.
Um facto arrancado a plataforma por um contorno continua a ser um facto; copiar o contorno e que seria herdar
a divida. Oito agentes escavaram, oito atacaram com ordem de reclassificar para TORTO em caso de duvida.

**142 coisas aproveitaveis, 64 a nao repetir.**

| estado | n |
| --- | ---: |
| Funciona, por caminho nativo -- aproveita-se como esta | 55 |
| Funciona, por caminho torto -- salva-se o FACTO, deita-se fora o CAMINHO | 43 |
| So documento -- nada o impoe | 21 |
| Promessa nao cumprida -- o documento anuncia, o codigo nao tem | 14 |
| Obsoleto | 6 |
| Por apurar | 3 |

| como o conhecimento foi obtido | n |
| --- | ---: |
| `observacao-manual` | 87 |
| `trace-ou-interposicao` | 19 |
| `reflection` | 14 |
| `documentacao-da-outsystems` | 11 |
| `api-nativa-do-modelo` | 11 |

| area | achados |
| --- | ---: |
| boas-praticas | 21 |
| capabilities | 20 |
| runtime | 20 |
| migracao | 18 |
| regras | 17 |
| declarative | 17 |
| friccoes | 15 |
| mistakes | 14 |

## O que se aproveita

## Funciona, por caminho nativo -- aproveita-se como esta

### Rota `sig`: confirmada palavra por palavra. Catalogo construido das classes Python vivas por processo, sem ler SIGNATURES.md e sem subprocesso. Mas o `ficheiro` do achado esta incompleto: a CLI nao im

`capabilities` · obtido por `reflection`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam-declarative\ssam_declarative\signatures.py:1-20 (docstring), :35-43 (ParameterContract), :98-150 (_SURFACES); shim em C:\Users\andre\GitSSAM\ssam-declarative\ssam_declarative\_sig_surface.py:1-15; CLI em C:\Users\andre\GitSSAM\ssam_agent_runtime\cli.py:3321-3360 e :306-321`

**Resolve:** inspect: tamanho e filtro (87) + saber o que a plataforma permite (22).

**Como se aproveita:** Kernel do Anvil: copiar o padrao (catalogo imutavel por processo, lookup exacto/fuzzy, sem-argumento devolve o catalogo em vez de exit 2) e sobretudo o ParameterContract, que e a peca que admite que reflection nao chega. Ao copiar, NAO copiar o shim `_sig_surface`: e uma segunda porta para a mesma coisa, do mesmo genero de defeito que criou os dois SIGNATURES.md.

**Caminho nativo:** E ja o caminho certo para o que interessa: reflection do Python sobre o codigo do PROPRIO repo, nunca sobre o Studio. Nao ha divida de plataforma. O limite esta declarado no proprio ficheiro e e o que o Anvil tem de resolver.

**O que sobra se se deitar a implementacao fora:** Duas ideias transportaveis, ambas desenho e nao implementacao: (1) a porta de consulta le do OBJECTO VIVO, nunca do markdown -- drift impossivel por construcao; (2) "sem argumento lista tudo" em vez de erro de uso.

```
signatures.py:3-5 -- "The catalog is built from the live Python classes once per process.  It does not read ``SIGNATURES.md`` and does not invoke ``rg``, ``sig`` or another subprocess." | signatures.py:39-42 -- "``inspect.Signature`` proves only that Python accepts a parameter.  It cannot distinguish a real supported input from a compatibility shim that raises later or is silently ignored.  This contract closes that gap for static preflight" | cli.py:3328-3329 -- "# #11 (2026-08-27): no argument = full catalog listing instead of\n        # argparse exit 2 - discoverability is a first-class output." | cli.py:3322 -- "from ssam_declarative._sig_surface import (" | _sig_surface.py:1-4 -- "Backward-compatible import path for the public signature catalog.\n\nNew code should import from :mod:`ssam_declarative.signatures`"
```

### Rota `recipe`: confirmada palavra por palavra nas linhas citadas. Indexa journals por verbo do SDK via AST (ast.walk sobre ast.Call), so aceita ok+executed+published, e implementa mesmo a "prova encad

`capabilities` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam_agent_runtime\recipe_index.py:15-23 (guardrails), :43-68 (extract_sdk_verbs), :104-148 (_entry_from_journal), :194-217 (prova encadeada), :157-158 (runs_dir); CLI em cli.py:3227-3318`

**Resolve:** handoff/registo (60) + complexidade da saida (63).

**Como se aproveita:** Kernel do Anvil, quase intacto. Os tres invariantes verificam-se no codigo e valem por si: (a) so entra ok+executed+published; (b) prova encadeada exige que a MESMA task_id tenha publicado num run POSTERIOR (comparacao de recorded_at), e runs sem task_id nunca encadeiam; (c) rotulo proof=direct|chained fica na entrada para ranking e para o carimbo honesto.

**Caminho nativo:** Nao aplicavel -- le artefactos do proprio runner, nao toca na plataforma.

**O que sobra se se deitar a implementacao fora:** O desenho: taxonomia que EMERGE dos verbos usados em vez de categorias curadas a mao, e degradacao honesta ("sem prova viva") em vez de fingir cobertura.

```
recipe_index.py:15-19 -- "Guardrails combinados no desenho aprovado:\n- so entra journal com ok+executed+PUBLISHED (parcial/suspect nunca);\n- resposta carimba data + alvo + timing + estado do toolchain (\"provado sob o SDK atual\" vs \"SDK mudou desde a prova\");" | recipe_index.py:21-23 -- "A taxonomia emerge dos verbos — nao ha classes curadas nem templates escritos a mao; combinacoes ineditas degradam com honestidade para o checklist \"sem prova viva\" em vez de fingir cobertura." | recipe_index.py:113 -- "if not (journal.get(\"ok\") is True and journal.get(\"executed\") is True):" | recipe_index.py:214-216 -- "if latest_publish and latest_publish > entry.get(\"recorded_at\", \"\"):\n            entry[\"proof\"] = \"chained\"" | cli.py:3315-3316 -- print(f"\nSEM PROVA VIVA: {verb} — nenhum script provado o usou. Rode: python -m ssam_agent_runtime sig {verb}")
```

### Gate de CI real e a funcionar: todo verbo do SDK citado como CHAMADA no CAPABILITIES.md tem de resolver no catalogo vivo, e todo `python -m ssam_agent_runtime <cmd>` citado tem de existir no CLI (por 

`capabilities` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam_agent_runtime\tests\test_capabilities_doc_contract.py:1-42; corre em C:\Users\andre\GitSSAM\.github\workflows\ssam-agent-runtime.yml (job runtime-gates, step "Runtime tests": python -m pytest ssam_agent_runtime/tests)`

**Resolve:** portao independente (46) + erros que nao ensinam (52).

**Como se aproveita:** Kernel do Anvil, tal e qual, e alargado aos ponteiros do `how`, ao SIGNATURES.md e as duas copias divergentes. E o unico mecanismo do repo que impede o documento de mentir, e o proprio repo ja tem 3 sitios onde ele faltava.

**Caminho nativo:** Nao aplicavel. Corrijo o `comoFoiObtido` do agente ("reflection"): ler um ficheiro de teste e um YAML de workflow e observacao manual. O gate em si consulta o catalogo vivo, mas o achado nao foi obtido por reflection.

**O que sobra se se deitar a implementacao fora:** O padrao inteiro: documento executavel, allowlist DATADA com justificacao obrigatoria, e a proibicao explicita de calar o teste apagando a citacao.

```
test_capabilities_doc_contract.py:3-7 -- "A desconfianca racional dos docs (doc stale => LLM confere na fonte de 10MB) so morre com CI: todo verbo do SDK citado como chamada no CAPABILITIES.md precisa resolver no catalogo VIVO de assinaturas, e todo comando `python -m ssam_agent_runtime <cmd>` citado precisa existir no CLI." | :9-10 -- "Excecoes deliberadas vao no allowlist DATADO abaixo — nunca remova um verbo do doc so para calar o teste sem checar se o card inteiro morreu." | :24-26 -- _VERB_CALL = re.compile(r"`((?:ss|scr|sa|ca|blk|proc|api)\.[A-Za-z_][\w.]*)\(") | workflow: "- name: Runtime tests\n        run: python -m pytest ssam_agent_runtime/tests"
```

### Facto vivo que o XML nativo NAO da, e que impede a conclusao preguicosa "o XML e a verdade final": no alvo O11 (ss1) o TrueChange recusa os parametros opcionais de `Index`, tanto 5 posicionais como os

`capabilities` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam-declarative\ssam_declarative\_os_builtins.py:140-155`

**Resolve:** saber o que a plataforma permite (22) + erros que nao ensinam (52).

**Como se aproveita:** Documento, e regra no kernel: quando o modelo e o compilador divergem, o registo tem de dizer ONDE e QUANDO foi provado e qual o contorno equivalente. Este registo faz as tres coisas e por isso e o formato a copiar.

**Caminho nativo:** Nao ha, e e esse o valor: a definicao nativa esta do lado do modelo e diz o contrario do que o compilador aceita naquele ambiente. O contorno registado e bom porque e semantico e nao truque: Index(ToLower(t), ToLower(s)) equivale a ignoreCase:True.

**O que sobra se se deitar a implementacao fora:** Tudo. E conhecimento puro, com alvo, data e artefacto de prova, e sobrevive a qualquer reescrita do codigo.

```
_os_builtins.py:147-154 -- "Arity varia por ambiente: no ss1 (provado vivo 2026-09-01, GameStore_CS/SearchGames) o TrueChange RECUSA tanto 5 argumentos posicionais ('Too many arguments') quanto os opcionais nomeados ('Unexpected argument named startIndex'); Index(t, search) positional publica com errors=0. Para case-insensitive, prefira Index(ToLower(t), ToLower(s)) — equivale a ignoreCase: True."
```

### A anatomia do ButtonGroup ESTAVA no SIGNATURES.md, completa e exacta, com os tres verbos e os parametros nomeados, e existe em codigo vivo nas linhas citadas. Confirmado nas 3 linhas e nas 3 defs. A i

`capabilities` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\SIGNATURES.md:755-757; codigo vivo em C:\Users\andre\GitSSAM\ssam-declarative\ssam_declarative\builders\screen.py:17135 (button_group), :17220 (button_group_item), :26715 (button_group_style)`

**Resolve:** saber o que a plataforma permite (22): e o caso concreto da familia mais cara.

**Como se aproveita:** Documento (autopsia) + argumento de desenho: o problema nao foi ausencia de conhecimento, foi ausencia de ROTA DE BUSCA. `sig scr.button_group` responde em 1 comando; procurar num markdown de 293 KB nao responde.

**Caminho nativo:** Nao aplicavel. Corrijo o `comoFoiObtido` do agente ("reflection"): abrir um markdown e fazer grep por 3 defs e observacao manual.

**O que sobra se se deitar a implementacao fora:** O diagnostico: quando o conhecimento existe e mesmo assim se vai buscar fora, o defeito e da rota de busca, nao do corpus.

```
SIGNATURES.md:755 -- "- `scr.button_group(self, var: 'str' = '', *, style_classes: 'str' = '', on_change: 'OnClickHandler | None' = None, label: 'str' = '') -> 'WidgetContext'` — Add a ButtonGroup widget for grouped toggle buttons." | :756 -- "- `scr.button_group_item(self, text: 'str', *, value: 'str' = '', is_active: 'bool' = False, enabled: 'str' = '', is_disabled: 'bool' = False, style_classes: 'str' = '') -> 'str'` — Add a ButtonGroupItem inside a ButtonGroup." | :757 -- "- `scr.button_group_style(self, class_name: 'str', *, group_background_color: 'str' = '', group_padding: 'str' = '', group_border_radius: 'str' = '', item_background_color: 'str' = '', item_border_color: 'str' = '', item_border_width: 'str' = '2px', ..."
```

### Gerador do indice do CAPABILITIES.md: escreve, entre marcadores, 1 linha por card (id + resumo do Intent) logo apos o titulo, com o roteiro das quatro portas. Idempotente, com --check para CI. Confirm

`capabilities` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\scripts\gen_capabilities_index.py:1-57 (docstring :3-6, _HEADER :24-35, corte :54-55); resultado em C:\Users\andre\GitSSAM\CAPABILITIES.md:3-7`

**Resolve:** inspect: tamanho e filtro (87).

**Como se aproveita:** Kernel do Anvil: o padrao "indice gerado entre marcadores, no proprio ficheiro, com --check no CI" e directamente reutilizavel para qualquer corpus grande, e sao 107 linhas. Reparar que a linha de roteiro (unica mencao das quatro portas neste ficheiro) esta dentro de _HEADER, portanto mudar a rota obriga a mexer no gerador -- e uma segunda instancia do defeito "rota escondida em codigo".

**Caminho nativo:** Nao aplicavel.

**O que sobra se se deitar a implementacao fora:** O padrao do indice idempotente com --check. E o codigo mais pequeno e mais util desta area.

```
gen_capabilities_index.py:3-6 -- "2026-08-29: CAPABILITIES.md tem ~2.6k linhas — \"consultar\" virava leitura integral por sessao. Este gerador escreve, entre marcadores, um indice de 1 linha por card (id + resumo do Intent) logo apos o titulo, com o roteiro das portas rapidas. Idempotente: re-rodar substitui o bloco." | :9-10 -- "python scripts/gen_capabilities_index.py          # escreve\n    python scripts/gen_capabilities_index.py --check  # so verifica (CI)" | :54-55 -- "if len(intent) > 90:\n            intent = intent[:87].rstrip(\" ,;\") + \"...\"" | CAPABILITIES.md:7 -- "Rotas de consulta ANTES de ler cards inteiros: `python -m ssam_agent_runtime recipe <verbos>` (ultimo script PROVADO), `sig <verbo>` (assinatura exata), `builtins <Funcao>`, `how \"<intencao>\"` (intencao -> verbo). Use este indice para pular direto ao card; leitura integral e fallback, nao rotina." | medicao: 3109 linhas hoje, 142 cards
```

### VEREDICTO SOBRE O ACHADO 1 (esquema do corpus): SOBREVIVE INTEIRO. Abri ci_gates.py e contei os ficheiros e casos eu proprio. 9 JSON + README confirmado; 38 casos confirmado por parsing (aggregate 4, 

`mistakes` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam_agent_runtime\ci_gates.py:236-243; contagem propria sobre C:\Users\andre\GitSSAM\llm_mistakes\*.json`

**Resolve:** handoff/registo

**Como se aproveita:** Documento + forma, como o achado dizia, mas com a correccao: sao 6 campos em disco e 5 no portao. Ao desenhar o ledger negativo do Anvil, o numero de campos escritos e o numero de campos lidos tem de ser o MESMO numero.

**Caminho nativo:** Confirmei que a forma equivalente do Anvil existe e corre: C:\Users\andre\Anvil\tests\Anvil.Tests\NegativeJobTests.cs:17-26 varre a pasta e C:\Users\andre\Anvil\tests\jobs-odc-negative\session-variable-not-in-odc.json existe mesmo (uma das 7 entradas da pasta).

**O que sobra se se deitar a implementacao fora:** A ideia de que um erro recorrente de LLM vira entrada de forma fixa ligada a um teste. Sobrevive. Acrescento: e que a lista de campos deve ser definida num sitio so, senao o disco e o portao divergem em silencio (ja divergiram, em `diagnostic`).

```
ci_gates.py:240 -- `for key in ("case", "bad_input", "expected", "test", "must_mutate"):`. Contra a leitura real das chaves dos 9 ficheiros, identica em todos: `case,bad_input,expected,diagnostic,must_mutate,test`.
```

### VEREDICTO SOBRE O ACHADO 3 (38/38 resolvem): SOBREVIVE. Nao aceitei o numero: corri a varredura outra vez, com o mesmo algoritmo do gate (ficheiro existe + nome do teste como substring). Saiu OK=38 BA

`mistakes` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\llm_mistakes\*.json cruzado com C:\Users\andre\GitSSAM\ssam_agent_runtime\tests\test_runtime.py e C:\Users\andre\GitSSAM\ssam-declarative\tests\*.py`

**Resolve:** handoff/registo

**Como se aproveita:** Documento. O contraste com o NAO-DA aguenta-se: 38/38 de integridade de ponteiro num registo com portao, contra a taxa de sobrevivencia muito menor de um registo sem portao.

**Caminho nativo:** nao se aplica -- e medicao.

**O que sobra se se deitar a implementacao fora:** Um gate fraco impede a podridao do PONTEIRO. Nao impede a podridao do CONTEUDO -- e o proprio corpus prova isso, porque os nomes falsos em `methods` passaram os 38/38 sem tossir.

```
Varredura propria dos 38 `cases[].test`: saida final `OK=38 BAD=0`, sem uma unica linha `MISS:`.
```

### REFUTADO -- O ACHADO 7 ESTA ERRADO NO ESSENCIAL. Diz que 'literais citados e verdade no SS11 e NAO e verdade no ODC' e que o caso 'portado tal e qual estaria ERRADO na faixa ODC'. Fui ao job ODC do pr

`mistakes` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\Anvil\tests\jobs-odc\static-entity.json (ops de `set ... prop Value`); contra C:\Users\andre\GitSSAM\llm_mistakes\http_mutation.json:11-18 e C:\Users\andre\Anvil\docs\NAO-DA.md:709-728`

**Resolve:** saber o que a plataforma permite

**Como se aproveita:** Kernel do Anvil: migrar o caso `unquoted_literal_url` como job negativo nas DUAS faixas, nao so na O11. A etiqueta de faixa continua a ser boa pratica, mas o facto nao se inverte entre faixas: o literal leva aspas em ambas.

**Caminho nativo:** Confirmado no Studio decompilado que a propriedade-expressao do ODC recebe mesmo `ExpressionDefinition`: C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model\ServiceStudio.Model\WebWidgets.cs:78 e :83 declaram `UnderlyingModelExpressionProperty<IComboBoxWidget>(..., delegate(IComboBoxWidget o, ExpressionDefinition v)`. Mas isso confirma a FAIXA, nao a inversao do facto. E as linhas do Anvil estao mal citadas: `ExpressionDefinition.Parse` por reflexao esta em Verbs.cs:997-998, e `Remembered` em Verbs.cs:957-961 -- nao em 988-991 / 950-954. Essas duas linhas foram copiadas de NAO-DA.md:715, que ja esta desactualizado em relacao ao ficheiro.

**O que sobra se se deitar a implementacao fora:** Sobra o vocabulario, que e o que o achado tinha de melhor: os nomes reais dos argumentos HTTP do produto (`URL`, `Data`, `Content_Type`) e a lista do que a LLM erra (URL sem aspas, dict Python em body e headers, basic auth parcial). Isso nao depende de faixa nenhuma. E sobra uma licao nova: as aspas do OutSystems vivem DENTRO das aspas do JSON, nas duas faixas.

```
static-entity.json, op sobre `$r1/Label`: `{"op": "set", "target": "$r1/Label", "prop": "Value", "value": "\"Received\"", "_why": "$registo/<Atributo> chega ao valor daquela coluna naquele registo; o Value e expressao, por isso o texto leva as aspas do OutSystems dentro das aspas do JSON"}` -- job da faixa ODC, com `expectValid: true`. E Verbs.cs:998 (nao 988-991) -- `if (t.FullName == "OutSystems.Model.Expressions.ExpressionDefinition") return t.GetMethod("Parse", BindingFlags.Public | BindingFlags.Static, [typeof(string)])!.Invoke(null, [s]);`
```

### VEREDICTO SOBRE O ACHADO 9 (Id no seed): SOBREVIVE INTEIRO. A mensagem esta em _data.py:567-569 tal e qual, e o irmao de batch existe mesmo, em :835-838 (o achado disse :834-838, um a mais). O `caminh

`mistakes` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam-declarative\ssam_declarative\_data.py:565-570 e 834-838; C:\Users\andre\GitSSAM\llm_mistakes\seed_idempotency.json:17-24`

**Resolve:** saber o que a plataforma permite

**Como se aproveita:** Kernel do Anvil + NAO-DA como item novo, tal como o achado recomenda. Enquanto nao houver job que produza a recusa, entra como `armadilha`, nunca como `recusa-da-plataforma`.

**Caminho nativo:** por apurar -- confirmo. Procurei mensagem literal da plataforma para escrita de Id em entidade persistente e nao ha. E confirmo tambem que o item vizinho do NAO-DA e mesmo outro: NAO-DA.md:421-433 e `Client entity com Id AutoNumber`, sobre IsAutoNumber numa client entity, nao sobre semear com Id.

**O que sobra se se deitar a implementacao fora:** O par facto + verbo: semear duas vezes duplica, logo o verbo re-executavel e `seed_records_once` com `unique_by`. Esse par leva-se inteiro e nao depende do guarda.

```
_data.py:565-570 -- `if field_name.lower() == "id":` / `raise SSAMError(` / `"seed_records does not accept Id for persistent entities; "` / `"Service Studio generates it. Static entities are not "` / `"supported by seed_records."`. E NAO-DA.md:421-425 -- `### Client entity com Id AutoNumber` / `` `recusa-da-plataforma` `` / `O Verify recusa IsAutoNumber Yes numa client entity...`
```

### O ACHADO 13 TEM NUMEROS VELHOS E UM EXAGERO. Diz 'NAO-DA.md (100 itens, 1239 linhas)'. Os 100 itens confirmam-se (100 cabecalhos `###`), as 1239 linhas nao: o ficheiro tem 1962. Foi crescido por uma p

`mistakes` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\Anvil\docs\NAO-DA.md:1363-1375 (item `delete com consumidores`); contagens proprias sobre o mesmo ficheiro e sobre C:\Users\andre\GitSSAM\llm_mistakes\`

**Resolve:** handoff/registo

**Como se aproveita:** Documento. A conclusao de fundo ('sao duas especies de conhecimento negativo e devem ficar separadas com o mesmo campo `tipo`') aguenta-se e e a jogada certa. O que nao se aproveita e a frase 'sobreposicao praticamente zero': na familia do apagar ha sobreposicao real, e a propria entrada 10 do lote admite isso ao dizer que o Anvil 'sabe mais' sobre apagar. Duas entradas do mesmo lote contradizem-se.

**Caminho nativo:** nao se aplica -- e medicao. Mas a medicao tem de ser refeita por TEMA e nao por token do SSAM, senao mede vocabulario.

**O que sobra se se deitar a implementacao fora:** O par de perguntas salva-se inteiro: ledger de plataforma ('o que a plataforma recusa') e ledger de gerador ('que forma errada a LLM escreve') sao coisas diferentes e precisam de provas diferentes. Acrescento: medir sobreposicao por grep de identificadores de um dos lados so mede o vocabulario desse lado.

```
NAO-DA.md:1363-1367 -- `### delete com consumidores` / `` `recusa-da-plataforma` `` / `O delete recusa quando o alvo tem consumidores reais e a mensagem NOMEIA cada um pelo caminho; usos derivados nao contam. Quatro recusas estao fixadas como jobs negativos na faixa ODC.` Contagem propria: o ficheiro tem 1962 linhas e 100 cabecalhos `###`; `delete`=32 ocorrencias, `delete_entity`=0.
```

### VEREDICTO SOBRE O ACHADO 14 (onde os casos aterram no Anvil): NUMEROS TODOS CERTOS. 7 jobs em jobs-odc-negative (delete-block-event-in-use, delete-data-in-use, delete-logic-in-use, delete-screen-in-us

`mistakes` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\Anvil\tests\jobs-odc-negative\ (7); C:\Users\andre\Anvil\tests\jobs-odc\ (67); C:\Users\andre\Anvil\tests\jobs-negative\ (23); C:\Users\andre\Anvil\tests\Anvil.Tests.Odc\OdcJobTests.cs:27-41`

**Resolve:** portao independente

**Como se aproveita:** Kernel do Anvil. A recomendacao de migracao (~10 casos com facto de plataforma viram jobs negativos, ~19 ficam como notas `limite-do-kernel`, os 9 de routing ficam no SSAM-Hybrid-ODC) aguenta-se com duas emendas minhas: o caso do quoting HTTP vai para as DUAS faixas e nao so para a O11 (ver refutacao acima), e o `expression_passthrough` do aggregate nao e facto de plataforma -- e o contrato do nosso setter a nao coagir; o facto de plataforma por baixo (StartIndex e propriedade-expressao) e outro e ainda nao esta provado por job.

**Caminho nativo:** e ele proprio o caminho nativo -- confirmo, com a ressalva do StudioAvailable() ja registada acima.

**O que sobra se se deitar a implementacao fora:** nao se aplica -- nada a deitar fora aqui.

```
OdcJobTests.cs:28 -- `/// O espelho do NegativeJobTests da faixa O11 para a faixa ODC: jobs em tests/jobs-odc-negative com \`expectError\``; e :39 -- `if (job["expectError"] != null) yield return new object[] { Path.GetFileNameWithoutExtension(f) };`. Contagem propria das pastas: jobs-odc-negative=7, jobs-odc=67, jobs-negative=23.
```

### CONFIRMADO E REFORCADO. Hook PostToolUse sobre Bash e de facto o UNICO gate que o .claude do GitSSAM impoe. Listei a pasta inteira: ha um so settings.json (994 bytes), um so script de hook, um so slas

`regras` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\.claude\settings.json (bloco hooks, linhas 12-26; _meta 3-11) + C:\Users\andre\GitSSAM\.claude\hooks\ssam-validate.sh (PATTERN linha 42, bloco de decisao 44-48). Listagem completa de .claude: launch.json, settings.json, commands/SSAMQualityGate.md, hooks/ssam-validate.sh, preview_bridge/index.html -- mais nada.`

**Resolve:** erros que nao ensinam 52 | portao independente 46

**Como se aproveita:** Kernel do Anvil: portar como gate do kernel (nao como hook de IDE). Depois de qualquer op declarativa falhar, a proxima accao so e aceite se citar codigo de erro e candidato literal devolvidos pelo kernel. Levar o _meta com remove_if junto.

**Caminho nativo:** Ja e nativo e o ficheiro declara-o como requisito de desenho. Verifiquei que nao ha um unico import de ssam_declarative no .sh: e sed + grep -E e mais nada.

**O que sobra se se deitar a implementacao fora:** O padrao inteiro sobrevive: (a) o gate vive FORA do sistema que vigia; (b) fail-open explicito (`set +e  # never abort on internal failure`); (c) o bloqueio e um FORMULARIO, nao um NAO -- exige EXACT_ERROR_LINE / SUGGESTION_CANDIDATES / CHOSEN_CANDIDATE / CHANGE_LOCATION antes de agir; (d) o _meta regista `added`, `purpose` e `remove_if`, isto e, o criterio de morte do proprio gate.

```
settings.json: "command": "bash .claude/hooks/ssam-validate.sh" / "timeout": 10 -- e "remove_if": "Causar regressao, falsos positivos, ou se F12 estrutural (tipos no SDK) tornar redundante."
ssam-validate.sh: "# - **Fail-open** on any internal error (regex bug, sed missing, etc)." / "# - **No ssam_declarative import** -- pure shell, decoupled from SDK." / "set +e  # never abort on internal failure" / "PATTERN='SSAMValidationError|SSAMDeclarativeError|DiagnosticsBlocked|ChecklistError|ChecklistPending|PreviewPending|RequirementsNotVerified|PlanRequired|ActionNotFoundError|EntityActionError|ArgumentMismatchError|ExpressionError|DependencyError|BuildError|IdentifierAsInputError|DestructiveOperationError|EntityNamingError|CrudWrapperError'"
```

### CONFIRMADO AO NUMERO EXACTO. Contei o log linha a linha: 35.003 linhas, 34.001 PASS, 1.002 BLOCK, 0 ERROR. 1.751.202 bytes. Primeira linha 2026-04-25T19:43:24-03:00, ultima 2026-09-07T14:53:46-03:00 (

`regras` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\.claude\hooks\ssam-validate.log`

**Resolve:** portao independente 46 | handoff/registo 60

**Como se aproveita:** Kernel do Anvil: todo gate escreve uma linha PASS/BLOCK num log append-only com timestamp. Custa nada e da a taxa de disparo real, que e a unica forma de saber se o gate vale.

**Caminho nativo:** n/a -- append de uma linha por invocacao, escrito pelo proprio .sh com `>> "$LOG" 2>/dev/null`, sem dependencias.

**O que sobra se se deitar a implementacao fora:** O numero calibrado: um gate deste tipo dispara ~2,9% das vezes ao longo de 4,5 meses e 35 mil invocacoes. E o intervalo util -- alto que chegue para se pagar, baixo que chegue para nao ser ruido. Serve de baseline para qualquer gate novo do Anvil. E a forma do registo: uma linha por tool call, timestamp ISO + nome do gate + veredito + tool.

```
2026-04-25T19:43:24-03:00 ssam-validate BLOCK Bash
2026-04-25T19:43:24-03:00 ssam-validate PASS Bash
(...)
2026-09-07T14:53:46-03:00 ssam-validate PASS Bash
-- contagem: LINES=35003 PASS=34001 BLOCK=1002 ERROR=0 SIZE=1751202
```

### CONFIRMADO NA INTEGRA. Os cinco verbos da regra 2 existem e estao despachados; abri o argparse e o despacho. `fix` tem exactamente 20 sub-verbos e fix_cmd.py tem exactamente 20 funcoes run_fix_*. `log

`regras` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam_agent_runtime\cli.py -- doctor 704-721 (com --fix em 717-720), modify-context 2289, refactor 2417, triage 2452, fix 2467-2502; despacho 3178-3189; 17 ramos logic-ir de 5703 a 6159. C:\Users\andre\GitSSAM\ssam_agent_runtime\fix_cmd.py -- 20 defs run_fix_* (L189 bind ... L5339 batch).`

**Resolve:** saber o que a plataforma permite 22 | complexidade da saida 63

**Como se aproveita:** Documento + kernel: as duas listas sao a especificacao pronta das ops declarativas do Anvil. Esta parte do AGENTS.md descreve o sistema que existe -- nao esta contaminada.

**Caminho nativo:** n/a para o roteamento -- argparse puro. NOTA: a implementacao por tras de cada verbo entra em Service Studio pela bridge SSDiagnostics; isso nao foi auditado nesta area e nao deve ser assumido nativo.

**O que sobra se se deitar a implementacao fora:** A lista dos 20 sub-verbos de `fix`, que vale independentemente do codigo: bind, expr, type, assignment, argument, filter, exception-handler, node, prop, rename, from-triage, sort, maxrecords, delete, move, column, cleanup-partial, sql, batch, widget. Mais o padrao: cada um enderecado por objectKey, com precondicao (--current = o valor ERRADO actual) e DRY-RUN por defeito nos destrutivos (cleanup-partial exige --execute). Idem os 17 do logic-ir.

```
cli.py L2474-2479: "    fix_parser.add_argument(\n        \"verb\", choices=[\"bind\", \"expr\", \"type\", \"assignment\", \"argument\", \"filter\",\n                         \"exception-handler\", \"node\", \"prop\",\n                         \"rename\", \"from-triage\", \"sort\", \"maxrecords\",\n                         \"delete\", \"move\", \"column\", \"cleanup-partial\",\n                         \"sql\", \"batch\", \"widget\"],"
cli.py L717-720: "    doctor_parser.add_argument(\n        \"--fix\", action=\"store_true\",\n        help=\"Aplica o plano (lock obsoleto, circuito; restart so se a bridge estiver morta).\")"
fix_cmd.py: def run_fix_bind (L189), run_fix_expr (925), run_fix_assignment (1083), run_fix_argument (1199), run_fix_type (1315), run_fix_filter (1475), run_fix_exception_handler (1639), run_fix_node (2030), run_fix_prop (2695), run_fix_rename (2758), run_fix_from_triage (3073), run_fix_sort (3344), run_fix_maxrecords (3348), run_fix_delete (3677), run_fix_move (3778), run_fix_widget_insert (3927), run_fix_column (4073), run_fix_cleanup_partial (4237), run_fix_sql (4487), run_fix_batch (5339).
```

### CONFIRMADO. O verbo `stats` existe com as duas metas numericas no proprio help, e a armadilha do filtro por modulo esta escrita ao lado do argumento que a causa.

`regras` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam_agent_runtime\cli.py L2220-2245 (parser), L3170 (despacho `if args.command == "stats":`)`

**Resolve:** handoff/registo 60 | erros que nao ensinam 52

**Como se aproveita:** Kernel do Anvil: journal por operacao + um comando de agregacao com estas duas taxas e estas duas metas. Sem isto, qualquer afirmacao sobre 'o kernel melhorou' e opiniao.

**Caminho nativo:** n/a -- le ficheiros de journal escritos pelo proprio runner, offline.

**O que sobra se se deitar a implementacao fora:** As duas metricas e as duas metas: escape rate (<2%) = com que frequencia o agente saiu da rota sancionada; autofix rate (>=70%) = com que frequencia o sistema corrigiu sozinho o input imperfeito do agente em vez de recusar. Sao as duas metricas que faltam ao diagnostico das 7,7h. E a armadilha documentada: runs bloqueados PRE-WRITE nao tem sidecar/module e ficam FORA do filtro por modulo -- filtrar por modulo esconde precisamente as falhas mais cedo.

```
L2222-2225: "        help=(\n            \"F16: escape rate + autofix rate agregados dos journals de run \"\n            \"(fonte: run_journal_dir). Metas B2: escape <2%%, autofix >=70%%.\"\n        ),"
L2240-2244: "        help=(\n            \"Filtra journals por run_result.module (case-insensitive). Nota: \"\n            \"runs bloqueados pre-write nao tem sidecar/module e ficam FORA \"\n            \"do filtro.\"\n        ),"
```

### CONFIRMADO PALAVRA POR PALAVRA. A superficie de descoberta existe e o how_cmd.py declara mesmo que o maior custo das sessoes nao foi falta de capacidade mas nao a encontrar. Verifiquei as tres notas d

`regras` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam_agent_runtime\how_cmd.py -- docstring L1-12, dataclass Intent L24-31, CURATED a partir de L34 (objectKeys L63, Decimal (37,8) L94, navegacao L114-115); cli.py L282-361`

**Resolve:** saber o que a plataforma permite 22 | erros que nao ensinam 52 | complexidade da saida 63

**Como se aproveita:** Documento (a tabela CURATED, migrada entrada a entrada) + kernel do Anvil (os quatro verbos de descoberta, sobretudo `recipe` sobre o journal do proprio kernel).

**Caminho nativo:** n/a para o mecanismo -- tabela curada em Python + scoring por substring, deliberadamente sem embeddings. NOTA: o CONTEUDO das notas foi ganho em sessoes vivas contra o Studio, nao lido de documentacao; a tabela e memoria de campo, nao referencia.

**O que sobra se se deitar a implementacao fora:** A tabela CURATED inteira e conhecimento puro: cada entrada e keywords -> verbos -> nota -> ponteiro de receita, e as notas sao factos duramente ganhos que sobrevivem a deitar fora todo o codigo. Confirmadas literalmente: 'NAO existe ca.navigate/ca.go_to/ca.destination'; 'objectKeys sao module-scoped; templates partilham keys'; 'add_node(after=) so liga origem->novo' (por isso insert_between existe); 'connect publico recusa Assign como origem (dual Target)'; 'flow_nodes ja traz target/trueTarget/falseTarget/cycleTarget'; 'condition e escrita DEPOIS do wiring'; 'heal=True religa prev->next'. Mais a ideia do `recipe`: a melhor documentacao de um verbo e o ultimo script que passou mesmo, extraido do journal, nao um exemplo escrito a mao.

```
how_cmd.py L4-11: "Deterministic two-stage resolution, no embeddings:\n1. a curated intent table for the tasks that have cost live sessions\n   (each entry: keywords -> verbs + recipe pointer);\n2. fallback substring scoring over the public signature catalog.\n\nThe point is discoverability-as-output: the biggest cost driver of the\n2026-08-27 sessions was not missing capability but not finding it\n(flow_nodes edges, retarget, recovery.*)."
L114-115: "           \"NAO existe ca.navigate/ca.go_to/ca.destination: navegacao e a \"\n           \"Destination do Link/Button (to=<Tela>, params=); de uma client \""
L63: "           \"objectKeys sao module-scoped; templates partilham keys\"),"
L54-55: "           (\"ss.flow.retarget\",),\n           \"connect publico recusa Assign como origem (dual Target)\"),"
```

### CONFIRMADO. A seccao 9 do RUNBOOK existe tal e qual, com a tabela indexada por evidencia (5 linhas, cada uma com o comando de saida) e a leitura explicita de retry_allowed=false. O tipo FailureDisposi

`regras` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\RUNBOOK.md L626-661 (tabela L633-639, leitura L641-644, fatia L650-656) + C:\Users\andre\GitSSAM\ssam_agent_runtime\task_execution_policy.py L403-411`

**Resolve:** erros que nao ensinam 52 | handoff/registo 60 | enderecamento entre corridas 36

**Como se aproveita:** Kernel do Anvil: o objecto de falha traz sempre retry_allowed E recommended_action, e a taxonomia e por evidencia (o que se sabe ter acontecido no alvo), nao por excepcao. Os cinco estados vao para o contrato de mensagens.

**Caminho nativo:** n/a -- dataclass frozen com campos explicitos. O texto do RUNBOOK e documento, mas o tipo por tras existe em codigo, e por isso nao e 'so documento'.

**O que sobra se se deitar a implementacao fora:** Tres coisas que valem sozinhas: (1) a recuperacao indexa-se pela EVIDENCIA que se tem, nao pelo erro -- cinco estados: falha comprovadamente pre-mutation / mutacao iniciada, publish nao iniciado / publish dispatch iniciado, outcome desconhecido / publish terminal comprovado, verify falhou / artefacto parcial ou ambiguo, cada um com uma accao permitida diferente; (2) retry_allowed=false significa 'nao repitas ESTE MESMO lote sem mudar nada', nunca 'a tarefa acabou', e o recommended_action ja traz o proximo comando; (3) 'Fatia e unidade de PUBLISH, nunca ponto de parada'.

```
RUNBOOK L628-631: "**Falha NUNCA e motivo para abandonar a tarefa.** Toda linha abaixo tem uma rota de saida; o que e proibido e o retry CEGO, nao o retomar. Uma sessao real (2026-08-31) leu `retry_allowed=false` como beco sem saida e desistiu com o modulo em estado parcial -- por isso cada linha aqui agora traz o comando."
RUNBOOK L641-644: "Como ler a `failure_disposition` que o runner devolve: `retry_allowed=false` significa **\"nao repita este mesmo lote sem mudar nada\"**, e nunca \"a tarefa acabou\". O campo `recommended_action` do mesmo payload ja traz o proximo comando -- leia-o antes de concluir qualquer coisa."
RUNBOOK L650-651: "**Fatia e unidade de PUBLISH, nunca ponto de parada.** Entregar 5 de 34 Actions e estado parcial, nao entrega."
```

### CONFIRMADO. Os gates de CI existem, sao offline e verificam contabilidade de capacidades. O gatilho de push esta mesmo limitado a main/master e o checkout local segue AndreMachado, logo so PRs dispara

`regras` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\.github\workflows\ssam-agent-runtime.yml (gatilho L3-8, job runtime-gates L11-23, dual-build L25-30) + C:\Users\andre\GitSSAM\ssam_agent_runtime\ci_gates.py (run_ci_gates L42-47, checks L49-82) + C:\Users\andre\GitSSAM\.git\config ([branch "AndreMachado"])`

**Resolve:** saber o que a plataforma permite 22 | binario velho 15 | handoff/registo 60

**Como se aproveita:** Kernel do Anvil: gate de CI que falha quando existe op publica sem contrato/erro/exemplo registados. Para o SSAM-Hybrid-ODC, a licao do dual-build.

**Caminho nativo:** n/a -- GitHub Actions + analise estatica offline do proprio repositorio (analyze_method_coverage, analyze_normalizer_coverage, analyze_compatibility_ledger, analyze_logic_ir_production_coverage).

**O que sobra se se deitar a implementacao fora:** A ideia do gate de CONTABILIDADE, rara e barata: em vez de testar comportamento, o CI verifica que nao ha metodo publico de alto risco sem entrada no registo nem entrada de registo sem assinatura correspondente. E um teste que falha quando alguem ACRESCENTA superficie sem documentar -- exactamente o que faltou nos 243 achados. Os quatro nomes de check sao a especificacao: capability_accounting_has_no_real_gaps, normalizer_registry_has_no_gap_statuses, high_risk_methods_are_registered, normalizer_registry_matches_signatures. E a licao do dual-build: compilar as duas faixas (#if ODC_MODE, ~22 sites) no CI em vez de descobrir no deploy manual.

```
yml L3-8: "on:\n  pull_request:\n  push:\n    branches:\n      - main\n      - master"
yml L25-26 e L30: "  # Item 9 (auditoria 2026-07-03): a DLL SSDiagnostics tem dual-build\n  # (~22 sites `#if ODC_MODE`); um handler novo que quebra o OUTRO define" (...) "  ssdiagnostics-dual-build:"
ci_gates.py L68-77: "        GateCheck(\n            name=\"high_risk_methods_are_registered\",\n            ok=not normalizers.unregistered_high_risk_methods,\n            message=(\n                \"All inferred high-risk methods are registered.\"\n                if not normalizers.unregistered_high_risk_methods\n                else \"Unregistered high-risk methods: \"\n                + \", \".join(normalizers.unregistered_high_risk_methods[:20])\n            ),\n        ),"
.git/config: [branch "AndreMachado"] / merge = refs/heads/AndreMachado
```

### CITACOES CONFIRMADAS, `comoFoiObtido` ERRADO NO SENTIDO CONTRARIO. `IR_SCHEMA_VERSION = "ssam-ir-core-v1"` e `TARGET_PRODUCTS = ("o11", "odc")` estao em ir.py:18-19 e `stable_ir_id` em :38-39, tal e q

`declarative` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam-declarative\ssam_declarative\ir.py:1-7, :18-19, :38-44, :1250; clipboard_compiler.py:1-7; native_paste.py:1-7; offline.py:1775, :1785, :1836`

**Resolve:** complexidade da saida 63; enderecamento entre corridas 36; portao independente 46

**Como se aproveita:** Kernel do Anvil, e agora com mais confianca do que ele deu: o IR em si nao traz divida nenhuma. O que traz divida e o que esta A JANGADA DELE -- clipboard_compiler.py, que importa `_clipboard` e reconstroi XML. Separar os dois no acto de herdar: ir.py e ir_*.py sao contrato; clipboard_compiler.py e native_paste.py sao motor e ficam.

**Caminho nativo:** Ele descreve bem o lado do Anvil e confirmei: `pi.SetValue(target, converted)` esta mesmo em `C:\Users\andre\Anvil\src\Anvil.Core\Kernel\Verbs.cs:394`, e `ModelApiMetadata.cs:60-65` e mesmo o filtro de superficie publica. Nota importante que ele deixa implicita: isto quer dizer que o Anvil TAMBEM e reflection, so que restrita -- nao e "API nativa" no sentido de chamadas tipadas.

**O que sobra se se deitar a implementacao fora:** (1) `stable_ir_id(kind, name, parent)` = sha1 de kind|parent|name truncado a 10, com prefixo `ir.<kind>.<name>.` -- id deterministico entre corridas, que e exactamente o que falta ao `$alias` do Anvil (o alias so vive dentro de um job). (2) Documento unico com `target_products` para as duas faixas. (3) Round-trip from_dict/to_dict, que permite diff entre corridas.

```
"This module is intentionally patchless: no Service Studio process, no\nSSDiagnostics client, no filesystem mutation outside explicit export calls." (ir.py:3-4) e "IR_SCHEMA_VERSION = \"ssam-ir-core-v1\"\nTARGET_PRODUCTS = (\"o11\", \"odc\")" (:18-19) e "def stable_ir_id(kind: str, name: str, parent: str | None = None) -> str:\n    \"\"\"Return a deterministic, portable id for a semantic IR object.\"\"\"" (:38-39)
```

### CONFIRMADO, e e o achado mais bem sustentado do conjunto. Abri o ledger: existe em C:\Users\andre\GitSSAM\docs\compatibility-ledger.json, tem 23.393 bytes (ele disse 23393 -- exacto), `generated_on` =

`declarative` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam-declarative\ODC_INCOMPATIBILITIES.md:1-11, :17, :38-42; C:\Users\andre\GitSSAM\docs\compatibility-ledger.json (23393 bytes, generated_on 2026-07-26, 35 capacidades)`

**Resolve:** saber o que a plataforma permite 22; handoff/registo 60

**Como se aproveita:** Documento + kernel, como ele disse. Acrescento a peca que torna isto um portao a serio e nao so um registo: o proprio .md diz que a CI falha "when an active entry expires, loses its evidence/limitation, or drifts from the bridge capability manifest" (:5-7). E o mecanismo de expiry que impede o ledger de virar folclore -- e e isso, mais do que o formato, que vale copiar para o Anvil.

**Caminho nativo:** Ja e nativo: JSON declarativo derivado do manifesto da bridge, com CI a falhar por expiry e por drift face ao manifesto.

**O que sobra se se deitar a implementacao fora:** O aviso que evita o erro que ja aconteceu duas vezes nesta casa, literal na :9-10: nao inferir incompatibilidade actual de um incidente antigo. E a distincao explicita que a tabela faz na :17 entre "Explicitly unsupported" e "not inferred from route presence" -- ausencia de rota nao e prova de limitacao. E o indice de incidentes historicos (:29-36) que mostra o formato: cada nota antiga tem a sua "disposicao actual" ao lado, incluindo o CycleTarget do ForEach, que aparece la como historico resolvido.

```
"Do not infer current incompatibility from an old incident below. Historical\nnotes are retained to explain why a guard exists." (:9-10) e "Change the machine-readable ledger first. A current claim needs target-specific\nevidence and a review expiry; a historical claim needs its rationale and\nsupersession. Never delete rationale merely because the implementation changed." (:40-42) e "| Server Action test execution | Explicitly unsupported, not inferred from route presence | P0-03 |" (:17)
```

### CITACOES CONFIRMADAS, DUAS CORRECCOES. README.md:39-41 e _clipboard_snapshot.py:3 dizem mesmo o que ele citou. Correccao 1: `comoFoiObtido: reflection` esta errado -- o modulo importa `xml.etree.Eleme

`declarative` · obtido por `trace-ou-interposicao`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam-declarative\README.md:37-41; ssam_declarative\_clipboard_snapshot.py:1-6, :18-47`

**Resolve:** inspect: tamanho e filtro 87; nao destruir intencao 24; enderecamento entre corridas 36

**Como se aproveita:** Politica da bridge escrita como regra, como ele propos -- e concordo que esta e a doutrina certa para tudo o que vem de engenharia inversa. Mas o vocabulario a importar para o `find`/`dump`/`usages` do Anvil sao QUATRO estados, nao tres: nao encontrei / encontrei varios / o que encontrei envelheceu / o que encontrei ja nao corresponde ao modelo vivo. O quarto e o que apanha o caso de um localizador que devolve uma chave que entretanto mudou de dono.

**Caminho nativo:** Ja e o caminho certo. O que falta e generalizar a regra para fora do clipboard, como ele disse.

**O que sobra se se deitar a implementacao fora:** A frase-regra ("The XML is for localization only; repairs still go through live SSAM APIs") e as quatro classes de falha de localizacao. Aplicaveis sem trazer uma linha de codigo. Nota: a hierarquia completa separa ainda falhas de ambito, de captura e de parse (SnapshotScopeError, SnapshotCaptureError, SnapshotParseError) -- distincao util porque diz a quem falhou: ao pedido, ao transporte, ou ao formato.

```
"When changing existing artifacts, use native clipboard snapshots as a\nread-only index. The XML is for localization only; repairs still go through\nlive SSAM APIs." (README.md:39-41) e "This module is intentionally read-only.  It parses native clipboard XML copied\nfrom existing Service Studio artifacts" (_clipboard_snapshot.py:3-4) e "class SnapshotMismatchError(SnapshotError):\n    \"\"\"Raised when a live model key no longer matches a snapshot hit.\"\"\"" (:46-47)
```

### CONFIRMADO, citacao exacta. As cinco garantias estao em _screen_plan.py:6-12 tal e qual, incluindo o remate "Unsupported IR fails closed.  There is no incremental or clipboard fallback." (:12), e `_SU

`declarative` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam-declarative\ssam_declarative\_screen_plan.py:1-13, :31-39 (2389 linhas, 92544 bytes)`

**Resolve:** portao independente 46; complexidade da saida 63; nao destruir intencao 24

**Como se aproveita:** Kernel do Anvil: a lista de garantias como criterio de admissao de op declarativa, exactamente como ele propos. E o melhor achado "positivo" do conjunto porque e uma definicao operacional, nao uma opiniao. Acrescento que o ficheiro leva o rigor mais longe do que ele contou: tem `SCREEN_PLAN_SCHEMA_VERSION` (:31) e um `SCREEN_PLAN_ROLLBACK_PROBE_TOKEN` (:32), ou seja versiona o proprio plano e tem sonda de rollback -- duas coisas que o job do Anvil devia ter.

**Caminho nativo:** E ele proprio o caminho nativo declarado, e unica peca do repositorio que nao depende do clipboard nem do invoke. Ressalva: continua a escrever atraves da mesma bridge C# (ver o meu primeiro achado), por isso "nativo" aqui quer dizer "sem contorno proprio", nao "sem interposicao".

**O que sobra se se deitar a implementacao fora:** As 5 garantias e a regra final. Fallback silencioso e o que destroi intencao -- e a razao pela qual falhar fechado vale mais do que cobrir mais casos. O contraste de tamanho (92 KB para 3 widgets) e o argumento economico para o trabalho de UI ir para um kernel unico em vez de ser reimplementado por faixa.

```
"* the complete offline screen is validated before the first live call;\n* only a small, explicitly supported widget subset is lowered;\n* the active module is checked without opening or switching modules;\n* all writes are sent to the dedicated transactional bridge endpoint; and\n* a semantic DOM readback is required before the result is accepted.\n\nUnsupported IR fails closed.  There is no incremental or clipboard fallback." (:6-12) e "_SUPPORTED_KINDS = {\"container\", \"text\", \"expression\"}" (:34)
```

### CONFIRMADO E REFORCADO. Abri os dois jobs: static-entity.json e mesmo so verbos crus (create IStaticEntity/IEntityAttribute/IRecord, set, dump) com aliases $s/$id/$label/$order/$r1/$r2, e logic-call-o

`declarative` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\Anvil\tests\jobs\static-entity.json; tests\jobs\logic-call-order.json; tests\jobs\{aggregate-sum-calc,hire-data-model,sql-input-output,service-action,refactor-move,refactor-duplicate,html-dashboard-reactive,tickets-01-data}.json; AGENTS.md:246-248, :289-292`

**Resolve:** complexidade da saida 63; enderecamento entre corridas 36

**Como se aproveita:** Kernel do Anvil: e a vantagem estrutural a preservar, e agora com prova de que ja e pratica corrente e nao so possibilidade teorica. A razao tecnica pela qual a autoria vai para o Anvil mantem-se: no ssam-declarative a autoria e Python e o IR JSON e saida, por isso completar uma op que nao chega obriga a escrever Python; no Anvil completa-se com verbos crus no mesmo ficheiro, partilhando aliases.

**Caminho nativo:** Ja e o nativo. O que falta importar do ssam-declarative e mesmo o id estavel entre corridas (`stable_ir_id`), porque `$alias` so vive dentro de um job -- confirmei que AGENTS.md:250-254 descreve o enderecamento todo em termos de $alias, @espace, @ObjectKey e Tipo:Nome, nenhum deles portavel entre execucoes por nome semantico.

**O que sobra se se deitar a implementacao fora:** O principio das duas altitudes com enderecamento partilhado, e a lacuna simetrica: o Anvil ganha a composicao, o ssam-declarative ganhou o id deterministico. Uma citacao a corrigir: a prova que ele deu de AGENTS.md:246-248 usa reticencias que escondem dois verbos reais, `rename` e `replace` -- e `replace` e justamente o que faz "TODO consumidor de `from` passar a apontar para `to`" (AGENTS.md:297-299), que e a peca de nao-destruir-intencao mais forte do Anvil.

```
static-entity.json: "{\n   \"op\": \"create\",\n   \"parent\": \"@espace\",\n   \"type\": \"IStaticEntity\",\n   \"name\": \"Priority\",\n   \"as\": \"$s\"\n  }"; logic-call-order.json: "\"ops\":[{\"op\":\"logic\",\"data\":{\"actions\":["; AGENTS.md:297-298: "**Repontar consumidores (op `replace`).** `{\"op\":\"replace\",\"from\":\"<ref>\",\"to\":\"<ref>\"}` faz TODO consumidor de `from` passar a apontar para `to`."
```

### ATAQUE PASSOU, E O OUTRO AGENTE SUBESTIMOU. Ele disse 53 números de fricção ancorados em código-fonte; varri outra vez com regex mais larga sobre .py e .cs e são 60 distintos — os 53 dele mais #1,#2,#

`friccoes` · obtido por `observacao-manual`

**Ficheiro:** `Varrimento sobre C:\Users\andre\GitSSAM\ssam_agent_runtime, C:\Users\andre\GitSSAM\ssam-declarative\ssam_declarative, C:\Users\andre\GitSSAM\ss-patcher. Espécime verificado linha a linha: C:\Users\andre\GitSSAM\ssam_agent_runtime\logic_ir\apply.py:3229-3233 (ficheiro de 3989 linhas)`

**Resolve:** handoff/registo (60)

**Como se aproveita:** Regra no kernel do Anvil: nenhum conserto de fricção entra sem o número da fricção no comentário, no sítio exacto do conserto. Transforma "está consertado?" numa pergunta de grep. Foi assim que separei feito de prometido em minutos, e foi assim que o corte em #103 apareceu sozinho — nenhum agente teve de o declarar.

**Caminho nativo:** nao se aplica — é prática de engenharia

**O que sobra se se deitar a implementacao fora:** A âncora número-de-fricção↔linha-de-código é o mecanismo que fecha um catálogo; sem ela um doc de "fixes implementados" é indistinguível de um doc de intenções. Lição secundária do meu ataque: a âncora é tão boa que até um varrimento hostil a favor dela dá um número MAIOR do que o reclamado — é a forma rara de afirmação que só erra para o lado seguro.

```
apply.py:3229-3233, literal: "        # Bug #24 (KKR 2026-09-03): o emitter e o lowerer nomeiam o no\n        # `Authorize<Role>`; o verificador esperava o generico `AuthorizeRole`\n        # e reprovava TODA action com mode=role. O nome vem do role.\n        role = str(authorization.get(\"role\") or \"\")\n        node_name = \"Authorize\" + role"
```

### ATAQUE PASSOU E REFORCEI-O. NameResolution.cs é mesmo caminho limpo: corri um varrimento por Reflection/GetProperty/GetMethod/Invoke/SetValue/Descriptor no ficheiro inteiro (129 linhas) e deu ZERO. É 

`friccoes` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ss-patcher\SSDiagnostics\NameResolution.cs:6-15 (regras) e :52-71 (decisão); 129 linhas, 0 ocorrências de reflection`

**Resolve:** endereçamento entre corridas (36)

**Como se aproveita:** Portar as três regras directamente para o kernel do Anvil como contrato de resolução de nomes: (1) exacto case-insensitive ganha sempre; (2) sem exacto, só devolve parcial se houver UM único candidato parcial; (3) dois ou mais exactos de TIPOS diferentes = ambíguo, ninguém escolhido, candidatos listados. Mais o erro estruturado com `candidates[]` e os códigos `NAME_RESOLUTION_AMBIGUOUS`/`NAME_RESOLUTION_NOT_FOUND` (:19-20) — é a diferença entre "not found" e um erro que ensina. Ressalva honesta que o código admite em :60-62: com dois exactos do MESMO tipo a ordem do walk ainda decide; no Anvil isso também devia ser ambíguo.

**Caminho nativo:** é já o caminho limpo — decisão pura sobre os resultados da busca, sem tocar no modelo

**O que sobra se se deitar a implementacao fora:** As regras são a totalidade do valor e são independentes de OutSystems: valem para qualquer resolução por nome num modelo com famílias homónimas. O molde do erro que ensina (requested + candidates + hint) é reutilizável para a família 52 inteira.

```
NameResolution.cs:6-15 literal: "/// KKR #35/#35b: escolha de UM objeto a partir dos resultados de uma busca por\n/// nome. Antes, FindObjectByName caia em results[0] quando nao havia match\n/// exato — e o walk casa por substring nos dois sentidos, entao a Structure\n/// \"SfdcProject\" resolvia para a Entity \"SfdcProjectFixture\" (e vice-versa).\n/// Regras (puras, testaveis sem Studio):\n///   - match exato (case-insensitive) vence sempre;\n///   - sem exato: so devolve um parcial se allowPartial E existe UM unico\n///     candidato parcial; 2+ parciais = ninguem;\n///   - strictTypes: 2+ exatos de TIPOS diferentes (Entity e Structure\n///     homonimas) = ambiguo, ninguem escolhido, candidatos listados." E a ressalva, :60-62: "// Mesmo tipo (ex.: duas telas homonimas em flows distintos): ordem\n            // do walk decide, como sempre foi."
```

### ATAQUE PASSOU NAS DUAS PONTAS. A diferença-que-não-é-diferença confirma-se em código: `"not": {"kind", "value"},` está em compiler.py:64 (o `not` sempre existiu; o agente escreveu `unary`), e o conser

`friccoes` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam_agent_runtime\logic_ir\compiler.py:64 e :2997-3004 (3545 linhas); refutações em C:\Users\andre\GitSSAM\docs\tasks\2026-09-07-ondas-1-4-kkr-fixes-implementadas.md:164-175`

**Resolve:** erros que não ensinam (52)

**Como se aproveita:** Regra dura e barata no kernel do Anvil: um erro de "kind/campo desconhecido" TEM de enumerar os válidos ou apontar o vizinho mais próximo. O conserto deles é o molde exacto — mapeia os enganos plausíveis (`unary`/`negate`/`neg`) para o nome verdadeiro, e faz o mesmo para `concat`. Note-se que o vocabulário aceite JÁ ESTÁ numa tabela literal no topo do ficheiro (:60-68): enumerar não custa nada, só ninguém tinha ligado a tabela à mensagem de erro.

**Caminho nativo:** o caminho nativo já existia — a fricção era de DESCOBERTA, não de capacidade

**O que sobra se se deitar a implementacao fora:** O padrão de falha do agente: quando o vocabulário não é enumerável a partir do erro, o agente conclui AUSÊNCIA em vez de concluir DESCONHECIMENTO, e escreve isso num catálogo como facto da plataforma. Cinco fricções catalogadas morreram assim. É a mesma armadilha do ISiteProperty/Settings da memória do projecto.

```
compiler.py:64 literal: '    "not": {"kind", "value"},' — dentro da tabela de vocabulário :60-68. E :2997-3000: "        hint = \"\"\n        if kind in {\"unary\", \"negate\", \"neg\"}:\n            # #18c: nao existe `unary`; negacao booleana e kind \"not\".\n            hint = \" (negacao booleana: use kind: 'not' com `value`)\"". Doc de fixes:168-169: "- #18b/#18c: `not` existe (`kind: \"not\"`); literal Currency funciona com\n  `dataType` (o campo errado era `type`)."
```

### ATAQUE PASSOU — é o único catálogo genuinamente FECHADO e o molde é o achado mais transferível de todo o lote. Confirmei o doc (162 linhas, fecha em :162) e confirmei os consertos no código: `def pref

`friccoes` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\docs\tasks\2026-06-26-external-db-friction-analysis.md:148-162 (162 linhas). Consertos verificados por mim: C:\Users\andre\GitSSAM\ssam_agent_runtime\runner.py:69-74; C:\Users\andre\GitSSAM\ssam-declarative\ssam_declarative\_external_db.py:1764 e :2898 (5836 linhas)`

**Resolve:** saber o que a plataforma permite (22) e handoff/registo (60)

**Como se aproveita:** É O MOLDE para o Anvil e responde à pergunta "catálogo ou ferramenta". Fechar uma fricção tem TRÊS passos obrigatórios, não um: (1) consertar o mecanismo; (2) consertar o canal por onde um agente frio descobre o caminho certo; (3) provar com um agente de contexto zero. Sem o (2) o conserto existe e ninguém o encontra. O passo (2) é accionável porque eles listaram os canais que contam: SIGNATURES.md, CAPABILITIES.md, examples.py, o guia e o card JSON.

**Caminho nativo:** nao se aplica — é o ritual de fecho, não um caminho de plataforma

**O que sobra se se deitar a implementacao fora:** O teste do agente frio como critério de aceitação, e o diagnóstico que o motivou. Isto é transferível tal e qual e vale mais do que qualquer conserto individual: mede a única coisa que interessa a um kernel para agentes — se o caminho certo é o caminho encontrado.

```
Doc :150 literal: "O fix do mecanismo não bastava: uma LLM sem contexto não descobria o `connect_and_publish`. Diagnóstico: os docs canônicos (que a LLM lê) apontavam pro caminho antigo/baixo-nível. Fechado:" E :160: "**Prova empírica (teste de LLM fria):** um agente novo, **zero contexto**, recebeu a tarefa do usuário e foi instruído só a seguir o onboarding canônico do repo. Resultado: escolheu **`connect_and_publish`** citando `CAPABILITIES.md` + `SIGNATURES.md`, com **todos os params certos** ... Sem trial-and-error." Código, runner.py:69-74: "_IB_LONG_POLL_DEFAULTS = {\n    \"connect_and_publish\": 900,\n    \"publish_integration\": 600,\n    \"create_extension\": 600,\n    \"wait_for_publication\": 600,\n}"
```

### ATAQUE PASSOU. A segunda diferença-que-não-é-diferença é real e foi resolvida ao vivo: as entidades Role e User_Role não vivem no produtor `Users` (que só expõe actions) — vivem em `(System)`. A fricç

`friccoes` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\docs\tasks\2026-09-07-ondas-1-4-kkr-fixes-implementadas.md:249; fricção original em C:\Users\andre\GitSSAM\docs\tasks\2026-09-03-friccoes-ssam-kkr-time-entry.md:139`

**Resolve:** saber o que a plataforma permite (22)

**Como se aproveita:** Padrão de conserto para o Anvil: quando um pedido vai ao produtor errado, o erro recusa CEDO e NOMEIA o produtor certo — em vez de deixar o agente concluir "impossível". Reforça a regra de memória do projecto: antes de escrever "a plataforma não tem", procurar o mesmo conceito com outro DONO ou outro NOME. Aqui o dono estava errado; no ISiteProperty/Settings era o nome.

**Caminho nativo:** APURADO ao vivo pelos autores: o produtor certo é `(System)`, não `Users`. O conserto certo não foi ensinar a rota ao agente — foi RECUSAR antes do bridge, apontando o sítio certo (`add_users_dependency` recusa Role/User_Role e nomeia a rota).

**O que sobra se se deitar a implementacao fora:** O facto (Role e User_Role vivem em `(System)`; `Users` só expõe actions) e o padrão de erro (recusar cedo nomeando o sítio certo). O custo é visível e dá para citar a quem duvidar: uma funcionalidade real do produto foi cortada por causa de uma conclusão errada de cinco minutos.

```
Doc de fixes:249 literal: "- **#95 `{User_Role}`/`{Role}`**: raiz achada ao vivo — o produtor `Users` só expõe actions (MatchTree sem `Role`/`User_Role`); as entities vivem em `(System)`. `ss.add_dependency(\"(System)\", [\"Role\", \"User_Role\"])` + `refresh_dependencies()` funciona (referência `User_Role` presente após publish). Fix: `add_users_dependency` recusa `Role`/`User_Role` ANTES do bridge apontando a rota certa (+5 testes); card atualizado."
```

### CORRECCAO DE ROTULO. O runner revalida o sha256 do ficheiro no instante antes de lancar o filho e recusa correr se mudou; recusa se nao houver digest validado; revalida receipts (logic-ir, repair-line

`runtime` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam_agent_runtime\runner.py:3520-3575 (_run_subprocess; run_script definido em 2891)`

**Resolve:** portao independente (46); nao destruir intencao (24)

**Como se aproveita:** Directo para o kernel do Anvil como contrato: o que foi validado e exactamente o que corre, provado por digest no instante do lancamento. Transplantavel tal e qual porque nao toca no Studio. O rotulo errado importa porque 'api-nativa-do-modelo' num achado sobre Python cria a impressao falsa de que ha aqui uma dependencia de plataforma a preservar -- nao ha, e por isso este e dos poucos itens que se copiam sem pensar.

**Caminho nativo:** Nao aplicavel: nao ha plataforma envolvida.

**O que sobra se se deitar a implementacao fora:** O padrao TOCTOU fechado: validar, e voltar a provar a mesma materia no ultimo instante antes de agir. Confirmei que a recusa por digest ausente vem PRIMEIRO (linhas 3523-3527), antes da comparacao -- fail-closed correcto.

```
if file_sha256(script_path) != execution_sha256:
            raise RunnerTaskSessionError(
                "Script content changed after validation and before execution; "
                "refusing to run."
            )
```

### O runner resolve o alvo e injecta-o dentro do script por SSAM_TARGET/SSAM_PORT, em vez de confiar que o script escolheu a porta. O comentario com a forense dos 18 minutos esta la, palavra por palavra.

`runtime` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam_agent_runtime\runner.py:3479-3487`

**Resolve:** enderecamento entre corridas (36); handoff/registo (60)

**Como se aproveita:** Kernel do Anvil: o alvo e propriedade da INVOCACAO, nunca do artefacto invocado. Regra de uma linha, transplantavel. Detalhe que confirma a solidez: a porta e derivada de TARGET_PORTS (linha 3485), a mesma fonte unica do app_bootstrap -- nao ha segunda tabela.

**Caminho nativo:** Nao aplicavel.

**O que sobra se se deitar a implementacao fora:** O custo medido do erro oposto, registado no proprio codigo: meia sessao no alvo errado, locks fantasmas e restarts desnecessarios.

```
# SDK-14: o alvo resolvido do runner chega DENTRO do script. Antes,
    # 'run --target ss2' rodava um script cujo SS() conectava no default
    # 4510 (ss1) — meia sessao no alvo errado, locks fantasmas e restarts
    # desnecessarios (forense do rebind de 18 min, 2026-06-11).
    if resolved_target:
        env["SSAM_TARGET"] = str(resolved_target)
```

### O journal do runner. Verifiquei os cinco elementos um a um e estao todos la: task_id env-first (5276), fingerprint do toolchain (5281-5284), script_sha256 (5285-5286), copia do corpo arquivada por sha

`runtime` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam_agent_runtime\runner.py:5258-5348 (_write_journal) e 3492-3501 (sidecar estruturado)`

**Resolve:** handoff/registo (60); enderecamento entre corridas (36); binario velho (15)

**Como se aproveita:** Kernel do Anvil, quase intacto. Tres ideias separaveis, todas com o comentario forense a explicar porque existem: (1) o veredicto vem de canal estruturado -- o comentario diz literalmente que o regex sobre stdout 'silently passed broken modules when the script didn't print ss.errors()'; (2) o corpo executado e arquivado por conteudo porque o ficheiro em scripts/ pode ser editado ou apagado; (3) o journal carrega a impressao do toolchain, o que permite dizer 'provado sob o SDK actual' vs 'o SDK mudou desde a prova'. Confirmo o veredicto do achado: e o item mais reaproveitavel desta area e nao tem nada de Studio dentro.

**Caminho nativo:** Nao aplicavel.

**O que sobra se se deitar a implementacao fora:** Tudo. E um detalhe extra que vi e vale reter: os bindings parciais ou velhos nunca sao promovidos a evidencia de journal (linhas 5295-5299, 'Never turn a partial or stale ambient binding into journal evidence') -- fail-closed tambem no registo, nao so na execucao.

```
# Item 11 (auditoria 2026-07-03): arquiva o CONTEUDO do script por sha
    # (dedup) — o journal so guardava path+sha, e script editado/apagado em
    # scripts/ virava codigo executado irrecuperavel. Best-effort.
```

### CORRECCAO DE ROTULO, conteudo confirmado. O portao le a ESTRUTURA do artefacto por AST. Contei os codigos no ficheiro: sao EXACTAMENTE 10 e a lista do achado bate certo, nome por nome. O orcamento de 

`runtime` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam_agent_runtime\task_execution_policy.py:1-6 (docstring) e 9 (import ast); C:\Users\andre\GitSSAM\ssam_agent_runtime\validator.py:96-113`

**Resolve:** portao independente (46); nao destruir intencao (24); erros que nao ensinam (52)

**Como se aproveita:** Kernel do Anvil: o portao le a estrutura do que VAI correr, nao o texto do que correu. Os 10 codigos sao vocabulario de recusa ja estabilizado e devem migrar como nomes de erro do kernel. A confirmacao no validator e importante e o achado tem razao nela: o orcamento nao e privilegio do modo --session.

**Caminho nativo:** Nao aplicavel.

**O que sobra se se deitar a implementacao fora:** A taxonomia dos 10 codigos (verificada exaustiva: SESSION_DESTRUCTIVE_ERRORS_GATE_REQUIRED, SESSION_DESTRUCTIVE_MUTATION_SAME_PHASE, SESSION_DESTRUCTIVE_PHASE_ORDER, SESSION_DESTRUCTIVE_PUBLISH_REQUIRED, SESSION_EARLY_PUBLISH, SESSION_FINAL_ERRORS_GATE_MISSING, SESSION_FINAL_PUBLISH_MISSING, SESSION_NONTERMINAL_DESTRUCTIVE_PUBLISH_BLOCKED, SESSION_POLICY_PARSE_ERROR, SESSION_PUBLISH_BUDGET_EXCEEDED) e a regra de ordem das fatias destrutivas.

```
The policy is intentionally conservative: deterministic failures are never
recommended for blind retry, completed phases can be resumed by digest, and a
normal single-module task gets one final publish by default.
```

### O portao que aprendeu a nao mentir: quando a flag 'suspect' esta levantada, corre-se o mesmo teste que um humano faria (ping a bridge); se responde, limpa-se a flag, DIZ-SE em voz alta no stderr, e se

`runtime` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam_agent_runtime\target_control.py:90-118 (assert_circuit_closed) e 60-87 (probe_target_health)`

**Resolve:** portao independente (46); erros que nao ensinam (52)

**Como se aproveita:** Kernel do Anvil como principio: um portao que bloqueia por MEMORIA de uma falha tem de saber refutar-se com uma OBSERVACAO viva e barata, e tem de dizer em voz alta que se limpou sozinho. Verifiquei que a sonda e mesmo barata e fail-safe: TCP + {"method":"ping"} com timeout de 3s, 'Never raises -- a probe failure is just False'. E que o caso negativo mantem a recusa estrita com razao nomeada.

**Caminho nativo:** Nao aplicavel (o ping usa o transporte torto da entrada 1, mas a decisao nao depende disso).

**O que sobra se se deitar a implementacao fora:** O numero 217 e o principio: estado persistido de falha sem prova de renovacao vira divida que custa um ciclo falhado mais um comando manual por cada run.

```
S48/3a (2026-08-28): the suspect flag exists to protect against a hung
        Studio after a mutation timeout. Historically it also blocked 217 runs
        whose Studio was perfectly healthy, each costing a failed cycle plus a
        manual ``target-state clear``.
```

### CORRECCAO DE ROTULO + RESSALVA NOVA. O bridge_manifest existe e o sumario que proibe inferir flavor pela porta esta la verbatim. Mas comoFoiObtido=api-nativa-do-modelo esta ERRADO: o manifesto e const

`runtime` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ss-patcher\SSDiagnostics\BridgeManifestHandler.cs:7-11 (sumario) e 20-124 (BuildManifest); consumido em C:\Users\andre\GitSSAM\ssam_agent_runtime\bridge_health.py:249-318 (valida schema, versao==1, flavor esperado por alvo, actualPort e sha do assembly)`

**Resolve:** saber o que a plataforma permite (22); binario velho (15); erros que nao ensinam (52)

**Como se aproveita:** Concordo com o achado no essencial: capacidade auto-declarada pelo lado que a implementa, com estado e razao, em vez de o cliente adivinhar. O consumidor confirma-se rigoroso (bridge_health.py acumula razoes e so devolve valid quando a lista esta vazia). DUAS COISAS QUE O ACHADO NAO DISSE: (1) ha TRES estados, nao dois -- supported, degraded e unsupported, e o unsupported traz a razao mais util de todas ('The discovered Studio TestAction method is not a sanctioned sandbox execution contract'); (2) os estados sao CONSTANTES escritas a mao no codigo, nao sondas vivas, logo o manifesto pode ficar a mentir se o codigo derivar. No Anvil, o estado de uma capacidade devia ser derivado, nao declarado.

**Caminho nativo:** Nao aplicavel: e codigo proprio a descrever-se a si mesmo.

**O que sobra se se deitar a implementacao fora:** A forma {state, version, reason} por capacidade, com 'degraded' a nomear o kill switch responsavel (SSDIAG_TAXONOMY_V2, SSDIAG_READ_CANCEL, SSDIAG_UI_HEARTBEAT) e 'unsupported' a nomear a razao de principio. Mais o padrao de negociacao explicito do add_widget_properties, que documenta porque inferir pelo nome do dispatcher cria falha silenciosa.

```
/// Describes the bridge that is actually loaded in the current Studio
/// process.  This is deliberately emitted by the DLL itself: clients must not
/// infer flavor or capability support from a port number or from dispatcher
/// method names.
```

### OS VERBOS EXISTEM TODOS -- e esta e a entrada mais bem citada do conjunto. Verifiquei os catorze numeros de linha e batem TODOS ao certo: parsers sig 306, recipe 323, how 352, explore 363, doctor 704,

`runtime` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam_agent_runtime\cli.py:3075-3216 (_dispatch_command completo) e 2467-2485 (choices dos 20 verbos de fix); C:\Users\andre\GitSSAM\ssam_agent_runtime\fix_cmd.py:3348`

**Resolve:** saber o que a plataforma permite (22)

**Como se aproveita:** Documento. A pergunta 'quais sao promessa' tem resposta verificada: nenhum verbo do conjunto perguntado e promessa; todos tem parser e ramo de dispatch. As promessas nao cumpridas estao nas OPCOES de um verbo real, nao nos verbos. Este e o unico achado desta area que sobreviveu ao ataque sem uma unica correccao.

**Caminho nativo:** Nao aplicavel.

**O que sobra se se deitar a implementacao fora:** O mapa verbo->modulo, que e o indice real da area, e os 20 verbos de fix: bind, expr, type, assignment, argument, filter, exception-handler, node, prop, rename, from-triage, sort, maxrecords, delete, move, column, cleanup-partial, sql, batch, widget.

```
if args.command == "sig":
        return _cmd_sig(args, repo_root)
    if args.command == "recipe":
        return _cmd_recipe(args, repo_root)
    if args.command == "how":
        return _cmd_how(args, repo_root)
    if args.command == "explore":
        return _cmd_explore(args, repo_root)
```

### `recipe` liga verbos ao ultimo script PROVADO lido dos journals, devolve a moldura de maior cobertura, ponteiros por verbo e marca 'SEM PROVA VIVA' com o comando seguinte a executar. Citacao verbatim 

`runtime` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam_agent_runtime\cli.py:3227-3318 (_cmd_recipe); C:\Users\andre\GitSSAM\ssam_agent_runtime\recipe_index.py`

**Resolve:** handoff/registo (60); enderecamento entre corridas (36); binario velho (15)

**Como se aproveita:** Kernel do Anvil. E a resposta directa a familia handoff: a sessao seguinte nao herda prosa, herda o ultimo artefacto PROVADO com a prova anexa. A distincao 'prova directa vs prova encadeada' mais o carimbo de toolchain sao o que impede reaproveitar um exemplo que ja nao compila. Detalhe bom que vi ao ler: quando imprime o corpo do script, trunca com o numero de linhas restantes e o caminho para abrir -- o mesmo principio do explore (truncar o terminal, nunca a fonte).

**Caminho nativo:** Nao aplicavel: le journals proprios.

**O que sobra se se deitar a implementacao fora:** Tudo, e nao toca no Studio.

```
proof = (
            "publicado no proprio run"
            if entry.get("proof", "direct") == "direct"
            else "prova ENCADEADA (publish na fatia posterior da task)"
        )
```

### `doctor` (sem --target) e um catalogo de regras com origin e fix_verb. Contei: 33 ErrorRule( no ficheiro -- o numero do achado esta certo. A citacao dos dois campos e verbatim. MAS UMA AFIRMACAO NAO S

`runtime` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam_agent_runtime\error_doctor.py:26-41 (dataclass ErrorRule completo) e 44+ (RULES)`

**Resolve:** erros que nao ensinam (52)

**Como se aproveita:** Kernel do Anvil como FORMA do erro: causa, accao sugerida NOMEADA (nao prosa), origem da mensagem. E, precisamente por causa do que descobri, o 'pode repetir?' deve ser CAMPO no Anvil e nao frase -- o SSAM teve a ideia certa mas deixou-a em texto livre, onde nenhuma maquina a le. O catalogo em si e conhecimento de plataforma e vai para documento/dados, nao para codigo do kernel.

**Caminho nativo:** Nao aplicavel.

**O que sobra se se deitar a implementacao fora:** As 33 assinaturas de falha e a forma do registo: causa + fix + fix_verb + origin. O campo `origin` e o mais subtil e o mais valioso: distingue mensagem do Service Studio ('truechange') de traceback Python do runner ('runner-log') e existe explicitamente para evitar o drift entre as duas bases.

```
# F36: origem do texto que a rule casa — "truechange" (mensagens do
    # Service Studio; subconjunto que o triage consome) ou "runner-log"
    # (tracebacks/logs Python do runner). Evita o drift entre as duas bases.
    origin: str = "runner-log"
    # F36: verbo `ssam fix` que resolve a classe (quando ha um direto).
    fix_verb: str | None = None
```

### `refactor` e real e tem exactamente UM padrao (choices=['extract-to-block'] em cli.py:2425). O pipeline de 6 passos confirma-se linha a linha em refactor_cmd.py:203-275. NOTA DE CITACAO: a `prova` que

`runtime` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam_agent_runtime\cli.py:2417-2426; C:\Users\andre\GitSSAM\ssam_agent_runtime\refactor_cmd.py:203-275 (_run_unlocked) e 94-97 (a regra do match unico)`

**Resolve:** complexidade da saida (63); nao destruir intencao (24)

**Como se aproveita:** Kernel do Anvil: a FORMA do pipeline e o achado, nao o padrao. Verifiquei os seis passos e todos estao presentes e na ordem certa: recusar antes de mutar se o modulo ja tem erros (linhas 221-224, 'conserte antes do refactor'); exigir match unico e mandar desambiguar por key; verificar o efeito por leitura independente do DOM em vez de confiar no retorno da mutacao (243-246); exigir que nao sobrem widgets originais (247-249); comparar warnings antes/depois e reportar orfaos NOVOS sem os apagar (251-254 e 271-274); e publicar so se errors==0 E sem sobras (257). Isso e 'nao destruir intencao' em codigo executavel.

**Caminho nativo:** Nao aplicavel directamente; a mutacao propriamente dita desce pela bridge e herda o caminho da entrada 4.

**O que sobra se se deitar a implementacao fora:** O pipeline de 6 passos e a regra do orfao: detectar e reportar, nunca limpar na mesma fatia -- 'orfaos novos detectados — remova em slice destrutivo separado'.

```
if antes.errors:
            raise RuntimeError(
                f"modulo ja tem {antes.errors} erro(s) — conserte antes do "
                "refactor (ss.errors(group=True) agrupa por causa).")
```

### REFORCADO, nao so confirmado: a regra `bpt-process` diz Workflow desde 2026-08-09 -- mas o BINARIO do ODC diz mais e diz melhor. A ModelFeature `Process` esta declarada com estado Removed no proprio f

`migracao` · obtido por `observacao-manual`

**Ficheiro:** `Regra: C:\Users\andre\GitSSAM\o11_odc_migration_hub\knowledge\compatibility_catalog.json:97-109. Binario: C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model\ServiceStudio.ModelFeatures\ModelFeatures.cs:1550 (Process), :1472, :1484, :1486. Texto irmao: CANONICAL_GUIDE.md:79-80 e OFFICIAL_SOURCE_AUDIT.md:29`

**Resolve:** saber o que a plataforma permite (22); nao destruir intencao (24); portao independente (46)

**Como se aproveita:** Corrijo o `estado` do achado original de 'existe-mas-e-so-documento' para 'funciona-hoje-por-caminho-nativo': ha um facto medivel em disco, nao so um paragrafo. E o que aterra no kernel nao e a linha do NAO-DA, e a LISTA DAS QUATRO: e a lista, extraivel por um grep, do que o binario ODC ja declara morto sem precisar de ambiente. Tres dessas quatro (SOAP consumo, SOAP exposicao, BPT) sao exactamente regras do catalogo do hub -- o binario e a segunda opiniao que o catalogo pedia.

**Caminho nativo:** Ja e o nativo, e e mais barato do que o achado original diz: `ModelFeatureStatus.Removed` no construtor da feature e leitura estatica do dump, sem tenant e sem resx. Grep por 'ModelFeatureStatus.Removed, isExcludedFromCompiler' devolve as quatro linhas e mais nada.

**O que sobra se se deitar a implementacao fora:** Duas coisas: (a) o par de vocabulario BPT/Process (O11) = Workflow (ODC), com a nota de que a conversao nao e automatica; (b) melhor do que isso, a lista de quatro features Removed no dump ODC, que e conhecimento negativo verificavel headless e que o NAO-DA nao tem.

```
ModelFeatures.cs:1550, literal: `Process = new OutSystems.MetaModel.ModelFeatures.ModelFeature("ModelFeature_Process", "Process is Available", predatesContinuousDelivery: true, OutSystems.MetaModel.ModelFeatures.ModelFeatureStatus.Removed, isExcludedFromCompiler: false, checkEnvironmentCompatibility: true, isUsedByExtensionsOnly: false, null, null, uuid);`. Catalogo :97-109: "id": "bpt-process", "disposition": "redesign", "targetAsset": "ODC Workflow or coexistence API", ... "notes": "Do not claim automatic BPT-to-Workflow conversion."
```

### ACHADO NOVO MEU, que fecha o `por apurar` do achado sobre multi-tenancy: o binario do ODC RESPONDE. A ModelFeature MultiTenant tem estado local Stable mas DefaultODCCompilerStatus = Removed, e o catal

`migracao` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model\ServiceStudio.ModelFeatures\ModelFeatures.cs:1487-1489 e :1717; C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model\ServiceStudio.Verify\VerifyMessageId.cs:1102-1110; mapeamento em ServiceStudio.Verify\ModelFeaturesVerifyMessagesManager.cs:46-50. Regra documental: C:\Users\andre\GitSSAM\o11_odc_migration_hub\knowledge\compatibility_catalog.json:240-252`

**Resolve:** saber o que a plataforma permite (22); nao destruir intencao (24); erros que nao ensinam (52)

**Como se aproveita:** Item novo no NAO-DA (`armadilha`) MUITO mais forte do que o proposto, e um job em tests\jobs-odc-negative por superficie. O achado original listava quatro superficies de API (IESpace, IEntity, IEntitySignature, ISiteProperty) e FALHOU a quarta que importa: ITimer.cs:29 tambem expoe IsMultiTenant, e e justamente uma das quatro que o Verify nomeia. O par correcto e: API expoe a propriedade em ESpace/Entity/SiteProperty/Timer, e o Studio tem um Error a espera para cada uma dessas quatro.

**Caminho nativo:** Ja e o nativo, e custou um grep -- que e o ponto. O achado original escreveu 'por apurar se escrever IsMultiTenant=true num modulo ODC e recusado, aceite em silencio, ou gated por ModelFeature'. E gated por ModelFeature, e o binario di-lo em disco: `defaultODCCompilerStatus = ModelFeatureStatus.Removed;` na linha imediatamente antes da declaracao da feature.

**O que sobra se se deitar a implementacao fora:** Tudo, e passa de aviso a facto: doc diz nao-suportado, API oferece a propriedade em quatro sitios, binario declara a feature com default ODC = Removed e nomeia uma mensagem de Error por sitio. A regra 'superficie de API nao e prova de funcionalidade' deixa de ter um caso por apurar e passa a ter um caso medido.

```
ModelFeatures.cs:1487-1489 literal: `defaultODCCompilerStatus = OutSystems.MetaModel.ModelFeatures.ModelFeatureStatus.Removed;` ... `MultiTenant = new OutSystems.MetaModel.ModelFeatures.ModelFeature("ModelFeature_MultiTenant", "Is Multi-tenant", predatesContinuousDelivery: true, OutSystems.MetaModel.ModelFeatures.ModelFeatureStatus.Stable, isExcludedFromCompiler: false, checkEnvironmentCompatibility: true, isUsedByExtensionsOnly: false, null, defaultODCCompilerStatus, uuid);`. ModelFeaturesVerifyMessagesManager.cs:46-49 literal: `FeatureMapper.Add(VerifyMessageId.Parse("ModelFeature_MultiTenant_Removed_ESpace"), "ModelFeature_MultiTenant");` ... `_Entity` ... `_SiteProperty` ... `_Timer`. Superficie: OutSystems.Model.V1\OutSystems.Model\IESpace.cs:257 `bool IsMultiTenant { get; set; }` e OutSystems.Model.Data\ISiteProperty.cs:30 e OutSystems.Model.Processes\ITimer.cs:29 `BooleanWithInheritance IsMultiTenant { get; set; }`
```

### ACHADO NOVO MEU, gemeo do anterior e que fecha metade do `por apurar` da matriz cross-asset: a regra `cross-app-entity-write` tem contraparte no binario. A ModelFeature ReferencedEntityActions tem Def

`migracao` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model\ServiceStudio.ModelFeatures\ModelFeatures.cs:1502-1504; vizinha relevante em :1493 (DeleteRuleOnSystemReferences) com mensagem propria em ServiceStudio.Verify\VerifyMessageId.cs:1034. Regras documentais: compatibility_catalog.json:201-213 e :331-343`

**Resolve:** saber o que a plataforma permite (22); portao independente (46); erros que nao ensinam (52)

**Como se aproveita:** Familia `jobs-odc-negative` no Anvil, mas agora com alvo em vez de palpite: comeca-se pelas duas regras que o binario ja corrobora (escrita cross-app de entidade; multi-tenancy) em vez de escrever um job por cada uma das seis regras da matriz as cegas. E entra no NAO-DA a nota de que `DeleteRuleOnSystemReferences` tem VerifyMessageId proprio, o que da um terceiro alvo barato ao lado da regra `unsupported-delete-rule`.

**Caminho nativo:** Ja e o nativo. Extraccao: percorrer os 176 construtores de ModelFeature e ficar com os que recebem um `defaultODCCompilerStatus` nao-nulo -- sao 8 -- e desses, os dois cujo valor e Removed. Isto e leitura estatica, barata, sem tenant.

**O que sobra se se deitar a implementacao fora:** A lista dos 8 e sobretudo a dos 2. E conhecimento negativo verificavel sem ambiente, que e exactamente o que falta ao NAO-DA (hoje tem 0 ocorrencias de 'cross-app' e 0 de 'Delete Rule', conferido por grep).

```
ModelFeatures.cs:1502-1504 literal: `defaultODCCompilerStatus = OutSystems.MetaModel.ModelFeatures.ModelFeatureStatus.Removed;` ... `ReferencedEntityActions = new OutSystems.MetaModel.ModelFeatures.ModelFeature("ModelFeature_ReferencedEntityActions", "Referenced entity actions", predatesContinuousDelivery: true, OutSystems.MetaModel.ModelFeatures.ModelFeatureStatus.Stable, isExcludedFromCompiler: false, checkEnvironmentCompatibility: true, isUsedByExtensionsOnly: false, null, defaultODCCompilerStatus, uuid);`. Varrimento dos 8: BulkEntityActions/SitePropertiesRefactoredToSettings/AppPropertiesVisibleInUI/ClientSideCheckRole/ExtensibilitySetting/BuiltInOfflineDataSync = Stable; MultiTenant e ReferencedEntityActions = Removed.
```

### O PORTAO HEADLESS TEM MESMO UM CEGO, mas NAO e o que o achado original descreve, e o mecanismo que ele da esta errado. O gate verdadeiro e uma linha: se `platformCapabilities` for nulo, a funcao devol

`migracao` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model\ServiceStudio.ModelFeatures\ModelFeatures.cs:1029 (o gate), :838-851 (o fallback que o achado original nao viu), :1054-1065 (so Removed gera mensagem). Efeito ja registado em C:\Users\andre\Anvil\docs\NAO-DA.md:324 e :329`

**Resolve:** portao independente (46); erros que nao ensinam (52); saber o que a plataforma permite (22)

**Como se aproveita:** Kernel do Anvil: a terceira resposta `nao-verificavel-headless` continua a ser boa ideia -- mas o discriminante que o achado original propunha e inutil e nao pode ser importado. Ver o item correspondente em `naoTrazer`. O discriminante util e: uma feature e INVISIVEL a um job headless quando o seu DefaultODCCompilerStatus e nulo (168 dos 176 construtores passam `null, null`); e VISIVEL quando nao e (8 dos 176, e desses 2 com Removed). Sobre esses 2 um job headless pode e deve ficar vermelho.

**Caminho nativo:** Ja e o nativo. Duas linhas de codigo dao o contrato inteiro do portao: `if (platformCapabilities == null || feature.IsExcludedFromCompiler) return null;` decide se ha mensagem; `if (serverInfo != null) {...} return feature.DefaultODCCompilerStatus;` decide qual e o estado quando nao ha servidor.

**O que sobra se se deitar a implementacao fora:** A fronteira, que continua a ser o achado mais estrutural da area -- mas desenhada onde ela esta mesmo. O que o SSAM-Hybrid-ODC continua a ter de fazer e o caso das features sem default compilado, nao 'as features com checkEnvironmentCompatibility'.

```
ModelFeatures.cs:1029 literal: `if (platformCapabilities == null || feature.IsExcludedFromCompiler)` seguido de `{ return null; }`. ModelFeatures.cs:838-851 literal: `if (serverInfo != null) { ... }` ... `if (platformServerVersion != PlatformServerVersion.V12) { return feature.DefaultO11CompilerStatus; } return feature.DefaultODCCompilerStatus;`. ModelFeatures.cs:1060-1061 literal: `case OutSystems.MetaModel.ModelFeatures.ModelFeatureStatus.Removed: return VerifyMessageId.Parse(VerifyMessageId.ModelFeature_RemovedFeature.Id + "_" + feature.Id) ?? VerifyMessageId.ModelFeature_RemovedFeature;`
```

### live_preflight.py: confirmado linha a linha. Le so a biblioteca padrao, declara-se sem SDK e sem mutacao, e o que faz e falar com um manifesto por schema versionado

`migracao` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\o11_odc_migration_hub\live_preflight.py:1, :4, :11-19 (imports), :22, :155, :249, :278, :327, :354. Testes: tests\test_live_preflight.py`

**Resolve:** portao independente (46); handoff/registo (60)

**Como se aproveita:** Modelo para o portao do Anvil. Tem as tres coisas que a sessao de 7,7 h pedia: blockers nomeados (:249), um `_next_action` que diz o que fazer a seguir (:327) e separacao entre estado de origem (:278) e de destino. A forma -- resposta com schema versionado + lista de blockers + proxima accao -- e o contrato de mensagens que falta.

**Caminho nativo:** Ja e limpo, e verifiquei a afirmacao mais forte do achado original: os imports sao hashlib, json, socket, time, concurrent.futures, dataclasses, datetime, pathlib, typing -- nenhum do SSAM. A docstring nao esta a mentir.

**O que sobra se se deitar a implementacao fora:** A forma da resposta, nao o codigo Python. Passa a contrato de dados do kernel.

```
Linha 4 literal: "It does not import the SSAM runtime or SDK and it never invokes a mutating bridge". Linha 22 literal: `LIVE_PREFLIGHT_SCHEMA = "ssam.o11_odc_live_preflight.v1"`. Linha 354 literal: `if data.get("schema") != "ssam.bridge_manifest":`. Linha 327 literal: `def _next_action(blockers: Sequence[Mapping[str, str]], target_app: Mapping[str, Any]) -> dict[str, Any]:`
```

### CONFIRMADO NUMERO A NUMERO. Catalogo de 556 mensagens de validacao no resx do ODC. Contei eu proprio por XML: 397 Error + 156 Warning + 1 Ok + 1 DevWarn + 1 Info = 556. As categorias dos 156 Warning b

`boas-praticas` · obtido por `api-nativa-do-modelo`

**Ficheiro:** `C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model\OutSystems.Model.Verify.Generated.VerifyMessageIdResources.Generated.resx:307 (a entrada citada); ficheiro inteiro = 556 <data name=>; O11 em C:\Users\andre\ODC3\decompiled\o11\ServiceStudio.Framework\ServiceStudio.Framework.Verify.Generated.VerifyMessageIdResources.Generated.resx = 472`

**Resolve:** complexidade da saida (63) e erros que nao ensinam (52).

**Como se aproveita:** Kernel do Anvil, como ele disse: empacotar o .resx como tabela id -> severidade, categoria, texto. Mas com o aviso: essa tabela e boa porque e ESTATICA e nao depende do bridge. A leitura viva dos warnings continua a passar por reflection e isso nao deve migrar para o Anvil sem ser reescrito.

**Caminho nativo:** CORRECCAO. A metade 'o catalogo existe no ficheiro' e nativa: e um .resx lido de disco, sem reflection. Mas ele escreveu que as mensagens 'chegam ao bridge como mensagens TrueChange com MessageID ... ja provado vivo'. Isso e FALSO como caminho nativo. Fui ver como o bridge obtem o MessageID: C:\Users\andre\GitSSAM\ss-patcher\SSDiagnostics\SSModelHandler.cs:32252-32267 faz GetProperty("ExtraInfo", AllInstance) onde AllInstance = Public|NonPublic|Instance (linha 24), depois GetValue, depois GetProperty("Id", AllInstance).GetValue().ToString(). E ainda sourceId = verifyMsg.ToString() com substring-parsing de 'Object Id: ...' para arrancar o objectKey (32272-32286). Reflection sobre propriedade NonPublic + parsing de ToString(). O caminho nativo real e o que ele proprio descreveu bem: ler o .resx como tabela de dados. Nao ha caminho nativo para a leitura VIVA sem o Studio.

**O que sobra se se deitar a implementacao fora:** Tudo o que e tabela. As 556 linhas com id, severidade, categoria e texto sao um ficheiro; nao herdam divida nenhuma. E o vocabulario oficial de 'codigo mau em OutSystems'.

```
resx:307 -- Entity_SuggestPartialUpdateBehavior_Many|Warning|Scalability Suggestion|Entities with a large number of attributes should have their 'Update Behavior' set to 'Changed Attributes'.||||2037|False||None|None| (a citacao dele e um prefixo literal; a linha real repete o texto no fim) /// SSModelHandler.cs:32252-32267 -- "var extraInfoProp = msgWrapper.GetType().GetProperty(\"ExtraInfo\", AllInstance);\n var verifyMsg = extraInfoProp?.GetValue(msgWrapper);\n ... var idPropAlways = verifyMsg.GetType().GetProperty(\"Id\", AllInstance);\n messageId = idPropAlways?.GetValue(verifyMsg)?.ToString() ?? \"\";"
```

### O ACHADO QUE ELE FALHOU, e e o mais caro: o valor de MaxCssThreshold ESTA no binario, no MESMO ficheiro que ele abriu. Ele leu NRNodes.cs:19611-19613, viu o campo estatico sem valor, e escreveu 'por a

`boas-praticas` · obtido por `api-nativa-do-modelo`

**Ficheiro:** `C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model\ServiceStudio.Model\NRNodes.cs:21263-21264 (atribuicao), :20352-20354 (o predicado), :19611-19613 (os campos que ele viu e parou). Identico no O11 em NRNodes.cs:5212-5213.`

**Resolve:** saber o que a plataforma permite (22).

**Como se aproveita:** Kernel do Anvil: pode ser gate exacto, com o numero 14164. E lição de metodo para a equipa: quando um decompilado mostra `public static int X;` sem valor, o valor esta quase sempre no construtor estatico do mesmo ficheiro -- procura-se `X = ` antes de declarar 'por apurar'.

**Caminho nativo:** E o caminho nativo e esta completamente apurado. Nao ha nada de configuracao em runtime: e uma constante atribuida no static ctor. O LIMIAR e 14164 bytes de AggregatedStyleSheetLength do tema.

**O que sobra se se deitar a implementacao fora:** O numero 14164 e o predicado. E a licao de leitura de decompilado que evitou um 'por apurar' falso.

```
NRNodes.cs:21263-21264 -- "MaxCssThreshold = 14164;\n\t\t\tMaxCssThresholdForMessage = \"14KB\";" /// NRNodes.cs:20352-20354 -- "private static bool ThemeExceedsCssThreshold(ServiceStudio.Model.NewRuntime.AbstractTheme theme)\n\t\t{\n\t\t\treturn (theme?.AggregatedStyleSheetLength ?? 0) > MaxCssThreshold;"
```

### LIMIAR #1 confirmado literalmente, mas a formulacao dele omite a cadeia de guardas. O `> 8` e real (Entity.cs:2214) mas e o ULTIMO ramo de um else-if dentro de um if grande. So dispara se: nao for Ser

`boas-praticas` · obtido por `api-nativa-do-modelo`

**Ficheiro:** `C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model\ServiceStudio.Model\Entity.cs:2200-2218 (o if externo e a cadeia completa); a linha citada 2214 esta certa`

**Resolve:** complexidade da saida (63) e saber o que a plataforma permite (22).

**Como se aproveita:** Kernel do Anvil: pre-verificacao barata, mas com a cadeia inteira: (!IsServiceCenter && !IsStatic && !IsClient && UpdateBehavior==Full) e depois binarios==1 -> _generico; texto>1000 -> _Text; Count>8 -> _Many.

**Caminho nativo:** E o caminho nativo (Entity.InnerVerify). Contar base.Attributes.Count no inspect preve-o -- mas so vale se se replicarem as guardas, senao a pre-verificacao do Anvil da falsos positivos em Static/Client Entities e em entidades com BinaryData.

**O que sobra se se deitar a implementacao fora:** O numero 8, e a ordem de precedencia dos tres sinais (binario > texto grande > muitos atributos) que mostra o que a OutSystems considera mais caro primeiro.

```
Entity.cs:2200-2217 -- "if (!base.OwnerESpace.IsServiceCenter && !base.IsStaticEntity && base.UpdateBehavior == OutSystems.Model.Implementation.Enumerations.UpdateEntityBehaviorType.Full && !base.IsClientEntity)\n\t\t\t\t{\n\t\t\t\t\tif (num2 == 1)\n ... \t\t\t\t\telse if (IsTextInefficient())\n ... \t\t\t\t\telse if (base.Attributes.Count > 8)\n\t\t\t\t\t{\n\t\t\t\t\t\taddMessage(new VerifyMessage(this, AbstractEntity.UpdateBehaviorPropertyDescriptor, VerifyMessageId.Entity_SuggestPartialUpdateBehavior_Many));"
```

### LIMIAR #2 confirmado, citacao literal exacta. Texto com Length > 1000 marca a Entity como 'texto ineficiente'. Nota: basta UM atributo assim na entidade inteira (o metodo devolve true no primeiro que 

`boas-praticas` · obtido por `api-nativa-do-modelo`

**Ficheiro:** `C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model\ServiceStudio.Model\Entity.cs:2149-2163 (metodo IsTextInefficient; ele citou 2153-2159, correcto)`

**Resolve:** complexidade da saida (63).

**Como se aproveita:** Kernel do Anvil, na mesma pre-verificacao da Entity, com a nota de que Length nao-literal escapa a regra nativa.

**Caminho nativo:** E o caminho nativo. Length e propriedade literal do atributo, legivel no inspect sem reflection -- confirmado: AsIntegerLiteral() so aceita literal.

**O que sobra se se deitar a implementacao fora:** 1000 caracteres e a fronteira oficial entre texto e texto pesado no modelo de dados.

```
Entity.cs:2153-2156 -- "if (attribute.Type != null && attribute.Type.UnderlyingType == OutSystems.RuntimeCommon.TypeKind.Text)\n\t\t\t{\n\t\t\t\tint? num = attribute.Length.AsIntegerLiteral();\n\t\t\t\tif (num.HasValue && num > 1000)"
```

### LIMIAR #3 confirmado, citacao literal exacta e a leitura da formula esta certa. >= 800 linhas (contagem de TODAS as linhas do split por \n) OU media >= 500 caracteres calculada so sobre linhas com com

`boas-praticas` · obtido por `api-nativa-do-modelo`

**Ficheiro:** `C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model\ServiceStudio.Model\NRNodes.cs:2296-2307`

**Resolve:** complexidade da saida (63).

**Como se aproveita:** Kernel do Anvil: qualquer op que escreva JavaScript mede as duas grandezas antes de escrever e recusa com o numero exacto.

**Caminho nativo:** E o caminho nativo e e 100% reproduzivel fora do Studio a partir do texto do no -- nao precisa do Studio aberto. Este e dos poucos achados que o Anvil pode implementar sem bridge nenhum.

**O que sobra se se deitar a implementacao fora:** A formula de dois eixos (contagem OU densidade media) apanha tanto a biblioteca colada como o one-liner minificado. E o filtro '>5 caracteres' que ignora chavetas soltas no calculo da media.

```
NRNodes.cs:2298-2306 -- "string[] source = JavascriptSourceText.SafeSplit('\\n');\n\t\t\t\tIEnumerable<int> enumerable = from line in source\n\t\t\t\t\tselect line.Trim().Length into length\n\t\t\t\t\twhere length > 5\n\t\t\t\t\tselect length;\n\t\t\t\tdouble num = (enumerable.IsEmpty() ? 0.0 : enumerable.Average());\n\t\t\t\tif (source.Count() >= 800 || num >= 500.0)"
```

### LIMIAR #4 confirmado, citacao literal exacta, incluindo a condicao IsNewRuntime. 512000 bytes, e a mensagem formata o limite via Storage.GetFormatedBinaryLength(512000m).

`boas-praticas` · obtido por `api-nativa-do-modelo`

**Ficheiro:** `C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model\ServiceStudio.Model\Image.cs:882-892`

**Resolve:** complexidade da saida (63).

**Como se aproveita:** Kernel do Anvil: gate no upload de recursos binarios com o numero na mensagem.

**Caminho nativo:** E o caminho nativo.

**O que sobra se se deitar a implementacao fora:** 500 KB e o limite, e a guarda IsNewRuntime evita um falso aviso em Traditional. Note-se que aqui o 512000 esta HARDCODED duas vezes no proprio codigo -- ao contrario do MaxCssThreshold, que esta no static ctor.

```
Image.cs:884-886 -- "if (base.Binary != null && base.Binary.Length > 512000 && base.OwnerESpace.IsNewRuntime)\n\t\t{\n\t\t\taddMessage(new VerifyMessage(this, VerifyMessageId.ImageTooBig, Name, Storage.GetFormatedBinaryLength(512000m)));"
```

### ConsecutiveServerInteractions confirmado literalmente E confirmado vivo (3 ocorrencias no journal). MAS uma correccao de leitura: IteratedServerInteraction NAO e um 'irmao' que dispara em paralelo -- 

`boas-praticas` · obtido por `api-nativa-do-modelo`

**Ficheiro:** `C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model\ServiceStudio.Model\Nodes.cs:36202-36218; evidencia viva em C:\Users\andre\GitSSAM\.ssam\agent-runtime\runs\20260916T235622841451Z_e670bb37cf8c844cdd4f03274092a830f4d93335265c8ed44f64ce370e0b16a9.json:2773 e :2867-2869`

**Resolve:** complexidade da saida (63) e erros que nao ensinam (52).

**Como se aproveita:** Kernel do Anvil: contar alvos servidor no mesmo caminho antes de escrever uma Client Action. O predicado exacto: >=2 ExecuteAction cujo Action.IsIServerExecuteActionClientSideTarget() no caminho para tras (GetSelfAndPreviousOrNextNodes(null, forwards: false)).

**Caminho nativo:** A REGRA e nativa (InnerVerifyNode de AbstractExecuteAction) e o predicado e exacto. Mas a PROVA VIVA que ele cita nao chega por caminho nativo: passa pela mesma reflection de SSModelHandler.cs:32252-32267. Separar: o predicado e do modelo; a observacao viva e torta.

**O que sobra se se deitar a implementacao fora:** O predicado exacto, a exclusao mutua com IteratedServerInteraction, e o facto de o deck (slide 6, 'THREE CALLS' vs 'ONE CALL') e o warning serem a mesma regra.

```
Nodes.cs:36208-36217 -- "if ((from n in GetSelfAndPreviousOrNextNodes(null, forwards: false).OfType<AbstractExecuteAction>()\n\t\t\t\t\twhere n != this && n.Action.IsIServerExecuteActionClientSideTarget()\n\t\t\t\t\tselect n).Any())\n\t\t\t\t{\n\t\t\t\t\taddMessage(new VerifyMessage(this, VerifyMessageId.ConsecutiveServerInteractions, clientActionFlow.AsAbstractObject.DisplayName));\n\t\t\t\t}\n\t\t\t\telse if (clientActionFlow is Flows.AbstractFlowWithScope flow && this.IsBeingIterated(flow))\n\t\t\t\t{\n\t\t\t\t\taddMessage(new VerifyMessage(this, VerifyMessageId.IteratedServerInteraction, DisplayName));" /// journal:2867 -- "VerifyMessageId.ConsecutiveServerInteractions|Performance Warning|H85NFpDDSkeZzDkPKiG_2Q||The 'Initialize' Client Action calls several Server Actions..."
```

### O ponto cego do EntityActionInsideLoop e REAL mas o numero esta errado e o `estado` esta mal usado. O ciclo e `for (int i = 0; i <= maxSearchDepth; i++)` com maxSearchDepth=3 -- sao QUATRO rondas de e

`boas-praticas` · obtido por `api-nativa-do-modelo`

**Ficheiro:** `C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model\ServiceStudio.Model\Nodes.cs:36198 (o flag e o IsInsideCycle(3)) e C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model\ServiceStudio.Model\ModelExtensions.cs:4428-4459 (a implementacao BFS completa)`

**Resolve:** saber o que a plataforma permite (22) e portao independente (46).

**Como se aproveita:** Documento + kernel: registar que 'ausencia de EntityActionInsideLoop NAO prova ausencia de query-in-loop', por duas razoes independentes -- a profundidade limitada E o feature flag que pode estar desligado.

**Caminho nativo:** E o caminho nativo, so que incompleto por construcao. O equivalente completo -- travessia do grafo pelo inspect (Nodes + InLinks) sem limite -- e mais simples do que o BFS com contador da plataforma, e nao precisa de reflection.

**O que sobra se se deitar a implementacao fora:** O facto corrigido (4 rondas de expansao, nao 3), o feature flag, e a licao geral: um aviso nativo ausente nao e atestado de saude.

```
ModelExtensions.cs:4428-4432 -- "public static bool IsInsideCycle(this AbstractNode node, int maxSearchDepth = 0)\n\t{\n\t\tHashSet<AbstractLink> visitedLinks = new HashSet<AbstractLink>(node.InLinks);\n\t\tQueue<AbstractLink> linksToExpand = new Queue<AbstractLink>(node.InLinks);\n\t\tfor (int i = 0; i <= maxSearchDepth; i++)" /// Nodes.cs:36198 -- "if (Providers.Instance.GetFeatures().IsEnabled(\"cd43ad4e-f268-5059-a4ca-cef832e5c6aa\") && Action is AbstractEntityAction entityAction && this.IsInsideCycle(3) && entityAction.TryGetEquivalentBulkEntityAction(out var bulkEntityAction))"
```

### O mapa conselho->warning: CONFIRMADO, os SETE ids existem e as categorias batem todas. ClientActionWithModelAssignmentOnLifecycleEvent [Potential Loop at runtime], SelfRefreshingAggregate [Potential L

`boas-praticas` · obtido por `api-nativa-do-modelo`

**Ficheiro:** `C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model\OutSystems.Model.Verify.Generated.VerifyMessageIdResources.Generated.resx (os oito ids verificados um a um por extraccao XML); deck em C:\Users\andre\GitSSAM\OutSystems_Best_Practices.pptx slide 6`

**Resolve:** erros que nao ensinam (52) e complexidade da saida (63).

**Como se aproveita:** Kernel do Anvil: tabela conselho->VerifyMessageId, para a mensagem ao agente trazer o PORQUE do deck em vez da frase seca. Aviso: a citacao 'TRES CHAMADAS vs UMA CHAMADA' que ele poe entre aspas nao esta no deck citado -- o deck ingles diz THREE CALLS / ONE CALL. E traducao, nao citacao.

**Caminho nativo:** E o caminho nativo, e a conclusao dele mantem-se: o conselho do deck e o warning da plataforma sao a MESMA regra com nomes diferentes. Nao e preciso implementar nenhuma.

**O que sobra se se deitar a implementacao fora:** O mapeamento. Impede a equipa de construir um terceiro verificador redundante.

```
ServerActionInAnonymousScreen => [Warning|Security Warning] "You're exposing a Server Action for public access and without authentication. Consider removing the Anonymous Role from this Screen." /// SelfRefreshingAggregate => [Warning|Potential Loop at runtime] "Refreshing '{1}' in '{0}' triggers the on after fetch event again. To avoid an infinite loop, remove the refresh of '{1}' from '{0}'." /// slide6 -- "THREE CALLS ... ONE CALL ... less accumulated latency"
```

### MaxRecordsMismatch/ForEachMismatch: CONFIRMADO em tudo, incluindo o detalhe da pasta. ServiceStudio.Verify.Extensions tem exactamente tres ficheiros: ForEachAndMaxRecordsMismatch.cs, InputIteratedWron

`boas-praticas` · obtido por `api-nativa-do-modelo`

**Ficheiro:** `C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model\ServiceStudio.Verify.Extensions\ForEachAndMaxRecordsMismatch.cs:96-130 (VerifyMaxRecordsMismatch) e :146-151 (ForEachMismatch); textos no resx`

**Resolve:** complexidade da saida (63) e erros que nao ensinam (52).

**Como se aproveita:** Kernel do Anvil: e o modelo a imitar para qualquer aviso proprio. Nao dizer 'esta mal' -- dizer 'deve ser <expressao concreta> para casar com <origem>'. O nativo calcula a expressao sugerida, nao so o facto do desacordo.

**Caminho nativo:** E o caminho nativo e esta isolado num ficheiro proprio de extensao de verificacao.

**O que sobra se se deitar a implementacao fora:** O padrao de mensagem: <propriedade> deve ser <valor concreto calculado> para casar com <origem do valor>. E a diferenca entre um erro que ensina e um que chateia.

```
ForEachAndMaxRecordsMismatch.cs:127 -- "addMessage(new VerifyMessage(query, Nodes.AbstractQuery.MaxRecordsPropertyDescriptor, VerifyMessageId.MaxRecordsMismatch, query.DisplayName, flag ? (widget.StartIndex.GetText() + \" + \" + widget.AsAbstractWidget.Name + \".LineCount + 1\") : (widget.AsAbstractWidget.Name + \".LineCount\"), widget.AsAbstractWidget.Name));" /// resx -- "MaxRecordsMismatch|Warning|Coherence Suggestion|{0} 'Max. Records' should be set to '{1}' to match the number of records presented by {2}."
```

### Ordem de grandeza: CONFIRMADA literalmente nos dois lados. 202 Performance Warnings pre-existentes numa app ODC; CensusReact com 48 mensagens. A soma da tabela bate exactamente 48 (6+1+27+1+1+11+1). D

`boas-praticas` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\publish_infinite_scroll_fix_odc1.py:5 e C:\Users\andre\GitSSAM\docs\BSC_Census_React_Solution_Design.md:180-188`

**Resolve:** portao independente (46).

**Como se aproveita:** Documento + kernel. Prova que um portao 'zero warnings' e impraticavel e que o ratchet incremental e a unica forma viavel. Relatorio por CATEGORIA e obrigatorio a partir desta ordem de grandeza.

**Caminho nativo:** Nao aplicavel -- e medicao. Mas veio pelo mesmo canal reflectido do bridge, o que explica porque uma linha de resumo se misturou com os achados: o ratchet tem codigo especifico para a apanhar (_warning_ratchet.py:256-258, detail in {'warning found','warnings found'} and not source).

**O que sobra se se deitar a implementacao fora:** Os numeros 202 e 48 (47 + 1 resumo). Servem para argumentar contra 'poe o gate a zero'. E o aviso de que contagens vindas do painel incluem linhas de resumo.

```
publish_infinite_scroll_fix_odc1.py:5 -- "all 202 pre-existing Performance Warnings of the app counted as \"new\"." /// BSC_Census_React_Solution_Design.md:182-188 -- "| Performance Warning | 6 |\n| Invalid JavaScript | 1 |\n| Unused Element | 27 |\n| Scalability Suggestion | 1 |\n| Unused Block Event | 1 |\n| Offline Behavior | 11 |\n| Warnings found | 1 |"
```

## Funciona, por caminho torto -- salva-se o FACTO, deita-se fora o CAMINHO

### CORRECCAO IMPORTANTE ao achado "raiz esta A FRENTE, o gerado e o stale". Os dois SIGNATURES.md divergem, sim, e os hashes/linhas citados estao EXACTOS -- mas a CONCLUSAO de direccao esta errada. O esp

`capabilities` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\SIGNATURES.md (sha256 B4A719C3..., 1350 linhas, 293148 bytes) vs C:\Users\andre\GitSSAM\ssam-declarative\docs\SIGNATURES.md (sha256 92854515..., 1580 linhas, 206810 bytes); gerador C:\Users\andre\GitSSAM\ssam-declarative\scripts\gen_signatures.py:485-486; leitores C:\Users\andre\GitSSAM\ssam_agent_runtime\signatures.py:46 e :116`

**Resolve:** binario velho (15) + saber o que a plataforma permite (22).

**Como se aproveita:** Anvil: um original so, e um render. Mas NAO importar a decisao "a raiz ganha" que o achado propunha -- as medicoes mostram que a raiz perde em pelo menos 5 entradas. A fusao tem de ser por entrada, com o gerador a correr primeiro e o conteudo escrito a mao a virar input.

**Caminho nativo:** Nao e questao de plataforma -- e um original a mais. Corrijo o `comoFoiObtido` que o agente pos ("reflection"): medir dois ficheiros e ler cabecalhos e observacao manual, nao reflection. O gerador em si usa inspect sobre classes vivas, mas o ACHADO nao foi obtido assim.

**O que sobra se se deitar a implementacao fora:** A licao original salva-se e reforca-se: "auto-generated" num ficheiro que nenhum gerador escreve compra confianca que nao ha. Acrescento uma segunda: quando ha duas copias, a pergunta "qual esta a frente?" normalmente nao tem resposta -- a divergencia e bidireccional e qualquer escolha global perde dados.

```
gen_signatures.py:485-486 -- "target = REPO_ROOT / \"docs\" / \"SIGNATURES.md\"; target.write_text(md, encoding=\"utf-8\")" | SIGNATURES.md:1 -- "# SSAM API Signatures (auto-generated)" | Get-FileHash: raiz=B4A719C31B276197498B968C2BFABBCA1A5C3CDD6BEDA5DBBF749C5E8011F556, espelho=9285451514E3F9DC23E11A7AE987CFBFB710890DD14DA9894AED574D3BC53BB8 | espelho:102 -- "- `ss.get_theme_user_css(self) -> 'str'`", espelho:205 -- "- `ss.whereami(self) -> 'dict'`", espelho:555 -- "- `ss.widgets.move_into(...)`" -- TODOS ausentes da raiz (0 ocorrencias) | headings so-na-raiz: :3 "## O11 Traditional Web", :203 "### `ss.agent`", :236 "### `ss.interop.o11_odc`" | headings so-no-espelho: :444 "### `ss.rest`", :574 "### `ss.policy_profile`"
```

### CORRECCAO: "4 dos 31 verbos que o `how` recomenda nao aparecem no SIGNATURES.md" -- sao 3, nao 4. `ss.whereami`, `ss.widgets.move_into` e `ss.get_theme_user_css` faltam mesmo (0 ocorrencias). Mas `ca.

`capabilities` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\SIGNATURES.md:662 (sa.javascript) e :695 (seccao ScreenActionBuilder); C:\Users\andre\GitSSAM\ssam-declarative\ssam_declarative\builders\action.py:11440 (class ScreenActionBuilder) e :9441 (def javascript); defs vivas: ss.py:3401 (whereami), ss.py:3296 (get_theme_user_css), _widget_helpers.py:573 (move_into)`

**Resolve:** saber o que a plataforma permite (22) + inspect: tamanho e filtro (87) -- continua a ser o mecanismo real, so que com 3 casos e nao 4.

**Como se aproveita:** Anvil, com uma regra extra que este erro ensina: a verificacao de ausencia tem de ser feita pelo MESMO resolvedor que o agente usaria (o catalogo vivo, que sabe de heranca), nunca por busca de string no documento. Procurar a string "ca.javascript" num ficheiro que indexa por classe definidora produz um falso positivo garantido.

**Caminho nativo:** Nao aplicavel (nao ha plataforma envolvida). Corrijo tambem o `comoFoiObtido` que o agente pos ("reflection"): contar ausencias num markdown com Select-String e observacao manual.

**O que sobra se se deitar a implementacao fora:** A medida corrigida (3 verbos, ~10%) e o metodo de verificacao: ausencia de capacidade prova-se pelo resolvedor, nao pelo grep. A prova do agente usava `[regex]::Escape($t)` combinado com `-SimpleMatch`, o que transforma "ca.javascript" em "ca\.javascript" literal e devolve 0 SEMPRE, mesmo quando o termo existe -- reproduzi o falso zero e depois reproduzi o resultado correcto com regex normal.

```
SIGNATURES.md:662 -- "- `sa.javascript(self, name: 'str', code: 'str', *, inputs: 'dict | None' = None, outputs: 'dict | None' = None) -> 'CallResult'`" | SIGNATURES.md:695 -- "### ScreenActionBuilder (`ca = with scr.client_action()`)" seguido de apenas 3 entradas (ca.refresh, ca.message, ca.trigger_event) | action.py:11440 -- "class ScreenActionBuilder(ActionBuilder):" | contagens com regex proprio: raiz whereami=0, move_into=0, get_theme_user_css=0 (ausencias REAIS); ca\.javascript=0 na raiz E no espelho (convencao, nao ausencia)
```

### A contradicao do `Round` e REAL e e o achado mais forte da area. Confirmei os dois lados nas linhas exactas. A tabela a mao regista min_args=2/max_args=2 e `validate_builtin_arities` bloqueia fora do 

`capabilities` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam-declarative\ssam_declarative\_os_builtins.py:107-111 e :807 vs C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model.Definition\CodeGeneration.Definitions.BuiltinFunctions.xml:18-24 (Group name="Math", linha 3)`

**Resolve:** erros que nao ensinam (52): um falso positivo do gate manda o agente reescrever uma expressao correcta.

**Como se aproveita:** Anvil: manter o GATE mas DERIVAR a tabela do XML, com um teste que falha quando XML e tabela divergirem. Encontrei uma segunda divergencia em minutos, sem procurar: a tabela regista a funcao como `mod` minusculo e documenta isso como excepcao deliberada ("lowercase `mod`, unlike most OS functions"), enquanto o modelo nativo a declara `Mod` maiuscula. Duas divergencias em ~6 funcoes olhadas.

**Caminho nativo:** CONFIRMADO E REAL -- o agente abriu mesmo o Studio decompilado. O XML tem 102251 bytes e da, por funcao: name, retType, grupo, Description, Examples, e por parametro name/type/isOptional/description. Da ainda o que a tabela a mao nem tenta: isVisibleInQueries, isVisibleInClientSide, isVisibleInBusinessProcesses e gating por versao (isVisibleInClientQueriesExpression="...PlatformServerVersion.V11").

**O que sobra se se deitar a implementacao fora:** O metodo, agora com duas provas e nao uma: por a tabela a mao ao lado da definicao nativa e tratar cada divergencia como divida. Rendeu 2 achados em ~6 funcoes verificadas.

```
_os_builtins.py:107-111 -- "\"Round\": BuiltinSpec(name=\"Round\", min_args=2, max_args=2, signature=\"Round(decimal, decimals)\",)" | _os_builtins.py:807 -- "if actual < spec.min_args or actual > spec.max_args:" | nativo:20 -- <Parameter type="Integer" name="fractionalDigits" isOptional="true" description="...The default value is 0..."/> | nativo:22 -- <Examples><![CDATA[...Round(-10.89) = -11<br/>Round(-5.5) = -6<br/>Round(9.3) = 9...]]></Examples> | 2a divergencia: _os_builtins.py:134-138 "\"mod\": BuiltinSpec(name=\"mod\", ... note=\"lowercase `mod`, unlike most OS functions.\")" vs nativo:7 <Function name="Mod" retType="Decimal" ...>
```

### O card ssam.data.create_entity declara lacuna em `decimals`/`default`, mas no ModelAPI nativo do ODC `Length` e `Decimals` sao propriedades ordinarias da interface publica do atributo. Verifiquei as l

`capabilities` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\CAPABILITIES.md:398-403; nativo em C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model.Definition\CodeGeneration.ModelAPI.Interfaces.xml:58-61, :262 e :170-171`

**Resolve:** saber o que a plataforma permite (22) + nao destruir intencao (24): o card manda acabar o trabalho a mao no Service Studio.

**Como se aproveita:** Anvil/bridge: alvo pequeno e verificado. Mas com a regra explicita de que o setter tem de passar pela ModelAPI tipada (IAttribute.Decimals), NAO por ss.flow.set_property/SetPropertyValue nem por explore.invoke. O `default` do atributo fica por apurar.

**Caminho nativo:** CONFIRMADO nas linhas exactas, incluindo a ressalva honesta do agente sobre o DefaultValue. IAttribute expoe Length e Decimals; IEntityAttribute herda de Types.IAttribute; o DefaultValue que existe nesse ficheiro esta mesmo em IInputParameter (:171) e nao no atributo de entidade. AVISO QUE O ACHADO NAO DA: o mecanismo que o proprio repo usa hoje para pOr propriedades genericas e REFLECTION -- ss.flow.set_property faz-no "via ``SetPropertyValue``" e ss.explore e descrito como "object()/invoke() for runtime reflection". Fechar decimals copiando esse caminho e herdar exactamente a divida que o dono do projecto avisou.

**O que sobra se se deitar a implementacao fora:** A distincao vale como habito e confirma-se em minutos no ModelAPI: "lacuna da ponte" e "limite da plataforma" sao coisas diferentes e o card nao pode chamar limite ao que e lacuna propria. Acrescento: e tambem preciso separar "existe caminho" de "existe caminho nativo" -- aqui ha caminho, mas e reflectivo.

```
CAPABILITIES.md:400-402 -- "Keys: `type` (required), `length` (Text only), `mandatory` (bool). Scalars stay valid and can be mixed. `decimals` / `default` are NOT accepted (the bridge has no reliable setter — known gap; set them in Service Studio after publish)" | Interfaces.xml:58-61 -- "<Interface name=\"IAttribute\" inherits=\"IObject\" implementedBy=\"AbstractAttribute\">\n  <Property name=\"Length\" type=\"int?\" />\n  <Property name=\"Decimals\" type=\"int?\" />\n</Interface>" | Interfaces.xml:262 -- "<Interface name=\"IEntityAttribute\" inherits=\"Types.IAttribute\" implementedBy=\"AbstractEntityAttribute\" />" | Interfaces.xml:170-171 -- "<Interface name=\"IInputParameter\" ...>\n  <Property name=\"DefaultValue\" declaredManually=\"true\" />" | reflection no repo: SIGNATURES.md:391 -- "- `ss.flow.set_property(self, object_key, prop, value) -> 'dict'` — Set any property on a flow node via ``SetPropertyValue``." e :135 -- "- `ss.explore` *(property)* — Low-level model explorer: object()/invoke() for runtime reflection."
```

### ACHADO NOVO que o agente nao viu, e que muda a leitura da area toda: o SDK expoe reflection sobre o modelo do Studio como SUPERFICIE PUBLICA DOCUMENTADA, e a tabela curada do `how` ENSINA esse caminho

`capabilities` · obtido por `reflection`

**Ficheiro:** `C:\Users\andre\GitSSAM\SIGNATURES.md:135, :391, :483, :327-328; C:\Users\andre\GitSSAM\ssam_agent_runtime\how_cmd.py:81-83`

**Resolve:** saber o que a plataforma permite (22) + erros que nao ensinam (52): um caminho reflectivo falha por nome errado em runtime, nao por contrato em preflight.

**Como se aproveita:** Regra dura para o kernel do Anvil, e e o unico item desta area que responde directamente ao aviso do dono do projecto: inventariar todo verbo publico cuja implementacao passa por invoke/SetPropertyValue/getattr por nome, e para cada um decidir entre (a) mapear para a interface tipada do ModelAPI, ou (b) marcar explicitamente como divida com data. Nenhum destes deve ser copiado para o Anvil tal como esta. Notar que a nota do `how` sobre excecoes ensina o caminho torto a quem pergunta -- essa nota nao entra no Anvil sem revisao.

**Caminho nativo:** por apurar por verbo. O que e apuravel e barato ja hoje: C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model.Definition\CodeGeneration.ModelAPI.Interfaces.xml da interfaces tipadas por objecto (IAttribute, IEntityAttribute, IInputParameter...) com Property declaradas -- ou seja, para uma boa parte do que hoje passa por invoke/SetPropertyValue existe contrato nomeado. Nao afirmo cobertura total: afirmo que a substituicao e verificavel ficheiro a ficheiro e que ninguem a fez.

**O que sobra se se deitar a implementacao fora:** O inventario: a superficie publica do SSAM tem pelo menos 4 pontos de entrada reflectivos documentados (explore, explore.invoke, flow.set_property, inspect.get_property_value_exact). Saber que eles existem e onde estao vale mesmo deitando fora todo o codigo, porque define a fronteira do que NAO se copia para o Anvil.

```
SIGNATURES.md:135 -- "- `ss.explore` *(property)* — Low-level model explorer: object()/invoke() for runtime reflection." | SIGNATURES.md:391 -- "- `ss.flow.set_property(self, object_key: 'str', prop: 'str', value: 'str') -> 'dict'` — Set any property on a flow node via ``SetPropertyValue``." | SIGNATURES.md:483 -- "- `ss.explore.invoke(self, object_key: 'str', method_name: 'str', args: 'list | None' = None, interface: 'str | None' = None, generic_type: 'str | None' = None, use_command: 'bool' = False) -> 'dict'`" | how_cmd.py:81-83 -- Intent(("excecao", "raise", "user exception"), ("ss.user_exception", "ss.flow.set_exception_message"), "bind no node via explore.invoke set_Exception")
```

### O indice do `recipe` vive numa cache por-maquina enderecada por sha1 do caminho absoluto do repo, e nesta maquina a pasta nao existe -- logo `recipe` responderia 0 provas. Confirmado nas linhas exacta

`capabilities` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam_agent_runtime\paths.py:28-37; C:\Users\andre\GitSSAM\ssam_agent_runtime\recipe_index.py:157-158; verificado: C:\Users\andre\AppData\Local\SSAM nao existe`

**Resolve:** enderecamento entre corridas (36) + handoff/registo (60).

**Como se aproveita:** Regra dura para o kernel do Anvil: aquilo que outra corrida (ou outra pessoa) tem de conseguir citar nao pode ser enderecado por um hash do caminho local. Se a prova nao sobrevive a um clone, nao e prova, e cache. Corolario que este caso ensina: uma variavel de ambiente de escape nao conserta o defeito, so o torna invisivel em maquinas configuradas.

**Caminho nativo:** por apurar como politica, mas a direccao e barata: o registo de prova e ARTEFACTO DO PROJECTO. A chave por sha1 do caminho absoluto agrava -- mover ou reclonar o repo perde tudo. A existencia de SSAM_AGENT_RUNTIME_HOME mostra que alguem ja sentiu o problema e resolveu-o por configuracao em vez de por desenho.

**O que sobra se se deitar a implementacao fora:** O facto: um indice de provas a viver fora do repo e invisivel a quem recebe o handoff. Vale como regra de desenho mesmo deitando fora todo o codigo do recipe.

```
paths.py:29-37 -- "configured = os.getenv(\"SSAM_AGENT_RUNTIME_HOME\")\n    if configured:\n        return Path(configured).expanduser().resolve()\n\n    repo_id = hashlib.sha1(str(repo_root.resolve()).encode(\"utf-8\")).hexdigest()[:12]\n    local_app_data = os.getenv(\"LOCALAPPDATA\")\n    if local_app_data:\n        return Path(local_app_data) / \"SSAM\" / \"agent-runtime\" / repo_id" | recipe_index.py:157 -- "runs_dir = runtime_cache_dir(repo_root) / \"runs\"" | verificacao: Test-Path C:\Users\andre\AppData\Local\SSAM -> False; $env:SSAM_AGENT_RUNTIME_HOME -> vazio
```

### Rota `how`: intencao -> verbo por tabela curada a mao mais scoring por substring, deterministico, sem embeddings, e fecha o funil imprimindo o comando `recipe`. CORRECCAO de contagem: a tabela CURATED

`capabilities` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam_agent_runtime\how_cmd.py:34-139 (CURATED, 21 entradas), :142-182 (resolve); CLI em cli.py:3363-3403`

**Resolve:** saber o que a plataforma permite (22).

**Como se aproveita:** Anvil: manter a ideia (intencao -> verbo -> receita provada, com nota anti-armadilha) e mudar a fonte para os cards, com gate que verifique que cada verbo e cada ponteiro resolvem. AVISO sobre as notas: nem todas se salvam. A nota de "excecao" ensina o caminho reflectivo ("bind no node via explore.invoke set_Exception") e nao deve ser transportada sem revisao.

**Caminho nativo:** por apurar. Parte do conteudo ja existe estruturado nos Intent dos 142 cards do CAPABILITIES.md, que passam por gate de CI; manter duas listas de intencoes a mao, uma sem gate nenhum, e a divida.

**O que sobra se se deitar a implementacao fora:** As ~21 notas anti-armadilha, menos as que ensinam reflection. Sao facto destilado ("connect publico recusa Assign como origem (dual Target)", "Decimal fica (37,8)", "heal=True religa prev->next", "NAO existe ca.navigate/ca.go_to/ca.destination") e valem independentemente do mecanismo de lookup.

```
how_cmd.py:4-11 -- "Deterministic two-stage resolution, no embeddings:\n1. a curated intent table for the tasks that have cost live sessions\n   (each entry: keywords -> verbs + recipe pointer);\n2. fallback substring scoring over the public signature catalog.\n\nThe point is discoverability-as-output: the biggest cost driver of the\n2026-08-27 sessions was not missing capability but not finding it\n(flow_nodes edges, retarget, recovery.*)." | cli.py:3396 -- "# 2026-08-29: fecha o funil intencao -> verbo -> script PROVADO." | contagem literal das entradas Intent(: linhas 35, 40, 45, 49, 52, 56, 60, 64, 68, 71, 75, 78, 81, 84, 89, 96, 104, 110, 118, 124, 131 = 21
```

### Dois casos de "diferenca que nao e diferenca" no vocabulario ODC, com o nativo a resolver os dois. CORRECCAO as verificacoes de apoio: o agente diz que "'Settings' so aparece nas 2 linhas do proprio c

`capabilities` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\CAPABILITIES.md:537-545 (site_property), :1864-1868 (bpt), :69 (linha do indice do bpt), :3139 (unica ocorrencia de "Settings"); nativo em C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model.Definition\CodeGeneration.Definitions.ObjectDefinitions.xml:542 e :6250`

**Resolve:** saber o que a plataforma permite (22): e a armadilha que ja custou duas conclusoes erradas segundo a memoria do projecto.

**Como se aproveita:** Anvil: campo de sinonimos por plataforma em cada card (siteProperty=Settings, bpt=Workflow), alimentado do modelo decompilado. E notar o que este par ensina sobre o metodo de medicao: contar ocorrencias de uma palavra num markdown nao mede descobribilidade, porque o indice gerado no topo conta como rota. A medicao honesta e "a rota de busca devolve o card certo?".

**Caminho nativo:** CONFIRMADO nas linhas exactas e com a nuance certa: (a) o objecto continua a chamar-se SiteProperty NO MODELO, com displayName "Site Property" -- logo "Settings" e rotulo de portal e ao nivel do modelo nao ha renomeacao, o que torna ss.site_property provavelmente mapeavel directo; (b) processos existem em ODC sob o namespace BusinessProcesses, com o no displayName "Call Workflow" -- BPT nao desapareceu, mudou de etiqueta.

**O que sobra se se deitar a implementacao fora:** O par de sinonimos provado com citacao, e o metodo: antes de declarar que o ODC nao tem uma coisa, procurar o nome no ObjectDefinitions.xml, que traz name e displayName lado a lado.

```
CAPABILITIES.md:539-540 -- "Intent: create site property; update site property; configure module setting;\nset default value; mark site property as secret." | CAPABILITIES.md:1866 -- "Intent: create BPT process; create Business Process Technology workflow; launch" | nativo:542 -- <Variables.AbstractGlobalVariable name="SiteProperty" docName="SiteProperty" ... eSpaceTreeFolder="SiteProperties" ... displayName="Site Property" ... defaultName="Property" isSoftwareUnit="true" > | nativo:6250 -- <BusinessProcesses.AbstractProcessNode name="CallWorkflow" docName="CallWorkflow" ... displayName="Call Workflow" nameType="Calculated" nameProvider="Process" ... modelFeature="BusinessProcessReference"> | minhas contagens: "Settings" = 1 ocorrencia (linha 3139, `PlatformSettings`); "Workflow" = 8 ocorrencias, sendo :69 a linha de indice do card bpt
```

### As quatro rotas estao mal anunciadas onde o agente comeca. Confirmado: o AGENTS.md nao menciona recipe, sig, builtins nem how, nenhuma vez -- e em vez disso manda `Get-Content .\CAPABILITIES.md` e `Ge

`capabilities` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\AGENTS.md:88-100 (130 linhas no total, zero ocorrencias das quatro rotas); C:\Users\andre\GitSSAM\RUNBOOK.md:167-181; C:\Users\andre\GitSSAM\CAPABILITIES.md:7`

**Resolve:** handoff/registo (60) + saber o que a plataforma permite (22): a ferramenta de descoberta que nao e descoberta nao serve.

**Como se aproveita:** Regra para o Anvil: a rota de consulta pertence ao bootstrap, nao a uma seccao interna. E o mesmo defeito que as rotas foram criadas para corrigir, um nivel acima. Notar que o AGENTS.md se descreve como bloco GERADO e curto e delega no RUNBOOK -- logo a correccao e no gerador, nao no ficheiro.

**Caminho nativo:** Nao aplicavel.

**O que sobra se se deitar a implementacao fora:** A ordem de leitura do RUNBOOK 3.1 (rota, receita provada, indice, assinatura viva, so entao a fonte) e um bom contrato de consulta e deve ir para o bootstrap do Anvil.

```
contagem no AGENTS.md: recipe=0, \bsig\b=0, builtins=0, \bhow\b=0 | AGENTS.md:88-90 -- "This generated block is deliberately short. `RUNBOOK.md` is the operational\nsource of truth; `CAPABILITIES.md` and `SIGNATURES.md` define the public SDK.\nRead only the route relevant to the request." | AGENTS.md:92-96 -- "Core commands:\n\n```powershell\nGet-Content .\\CAPABILITIES.md\nGet-Content .\\SIGNATURES.md" | RUNBOOK.md:175-179 -- "4. a assinatura publica: `python -m ssam_agent_runtime sig <verbo>` (ex.:\n   `sig sa.assign`) — resposta viva em 1 comando; NUNCA grep por `def <verbo>`\n   no codigo-fonte. Builtin de expressao OS (CurrDateTime, ToUpper...):\n   `python -m ssam_agent_runtime builtins <Funcao>`." | RUNBOOK.md:180-181 -- "5. implementacao interna somente se a rota publica falhar ou estiver\n   contraditoria."
```

### Metade do corpus nao diz em que plataforma corre. Reproduzi a medicao e os numeros exactos do achado NAO batem, mas a manchete aguenta: contei 142 cards, e com o meu criterio deu ambos=17, so-O11=25, 

`capabilities` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\CAPABILITIES.md (142 headings '^### (ssam|o11|odc)', 3109 linhas); exemplos de rotulagem correcta em :251 e :357`

**Resolve:** saber o que a plataforma permite (22) + erros que nao ensinam (52): metade do corpus nao responde a primeira pergunta de qualquer sessao hibrida.

**Como se aproveita:** Anvil: plataforma e campo OBRIGATORIO do contrato de capacidade (o11 | odc | ambos | por-apurar), com gate que rejeita card sem ele. "por-apurar" explicito vale mais do que silencio, porque e pesquisavel. E a licao de metodo deste item: uma medicao so entra no dossier com o criterio publicado, senao nao se reproduz -- esta nao reproduziu.

**Caminho nativo:** por apurar por card. O que e apuravel hoje e barato: os cards que ESTAO rotulados fazem-no bem e no sitio certo, na linha 'Safety:'. Falta e o campo ser obrigatorio, nao inventado.

**O que sobra se se deitar a implementacao fora:** A manchete (~50% mudos) e a forma de rotulo que ja funciona (linha Safety). Ambos transportaveis sem uma linha de codigo. A contagem fina nao se transporta.

```
CAPABILITIES.md:251 -- "Safety: O11-only. The UI builder requires fresh active-module evidence\n`isWeb=True`, `isReactive=False`, `isMobile=False`. Reactive" | CAPABILITIES.md:357 -- "O11-only. On ODC, `module-open` and the legacy `ss.module` namespace operate\non top-level Applications/Libraries; they do not imply a nested Module object." | minha contagem sobre os 142 corpos (O11|OutSystems 11|Service Studio|Traditional vs \bODC\b): ambos=17, so O11=25, so ODC=29, sem mencao=71
```

### VEREDICTO SOBRE O ACHADO 2 (o gate so valida estrutura): A PARTE DO SSAM SOBREVIVE, A PARTE DO ANVIL NAO. ci_gates.py:266 e literal e a verificacao e mesmo uma substring. MAS o `caminhoNativo` vende o

`mistakes` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam_agent_runtime\ci_gates.py:256-267; C:\Users\andre\Anvil\tests\Anvil.Tests\NegativeJobTests.cs:30-40; C:\Users\andre\Anvil\tests\Anvil.Tests.Odc\OdcJobTests.cs:45-55`

**Resolve:** portao independente

**Como se aproveita:** Kernel do Anvil: nao portar o gate do SSAM, como o achado diz. Mas ao migrar, acrescentar ao CI a assercao de que o numero de jobs negativos EXECUTADOS e igual ao numero de ficheiros com `expectError`. Sem isso troca-se 'substring que sempre acha' por 'teste que sempre desiste'.

**Caminho nativo:** O caminho nativo continua a ser a auto-descoberta por pasta (NegativeJobTests.cs:19-24 e OdcJobTests.cs:34-40, ambos literais). O que falta e um gate de CI que falhe quando `StudioAvailable()` e falso numa maquina onde devia ser verdade -- senao a faixa inteira fica verde por ausencia.

**O que sobra se se deitar a implementacao fora:** O facto de que um ledger apodrece sem gate, e o corolario que o achado nao viu: um gate que pode desistir em silencio conta como nenhum gate nos dias em que desiste.

```
ci_gates.py:266 -- `if test_name and test_name not in test_path.read_text(encoding="utf-8", errors="replace"):`. E NegativeJobTests.cs:32 -- `if (!StudioAvailable()) return;`, repetido em OdcJobTests.cs:47.
```

### VEREDICTO SOBRE O ACHADO 4 (o `test:` nao e prova, corre contra fakes): SOBREVIVE INTEIRO, e e o melhor achado do lote. As tres citacoes estao la, tal e qual, e a assercao final do primeiro teste e me

`mistakes` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam-declarative\tests\test_data_helper_guards.py:367-373; C:\Users\andre\GitSSAM\ssam-declarative\tests\test_phase5.py:1041-1059; C:\Users\andre\GitSSAM\ssam-declarative\tests\test_action_diagnostics.py:1199-1216`

**Resolve:** erros que nao ensinam

**Como se aproveita:** Kernel do Anvil: exigir `Prova:`/`Visto em:` em cada caso migrado e marcar `limite-do-kernel` os que nao conseguirem produzir mensagem da plataforma. Confirmo a recomendacao sem reservas.

**Caminho nativo:** O par `Prova:`/`Visto em:` do NAO-DA e real e esta onde o achado diz. Confirmei NAO-DA.md:85 palavra por palavra, e o `Visto em:` da linha 88 aponta para um job que existe em disco.

**O que sobra se se deitar a implementacao fora:** Um teste que assere o guarda nao promove palpite a facto. Vale para o Anvil tanto como para o SSAM.

```
test_data_helper_guards.py:368,370,373 -- `client = FakeClient()` / `with pytest.raises(SSAMError, match="does not accept Id"):` / `assert client.calls == []`. E NAO-DA.md:85 -- `op #0 (create WfCovSessionState): InvalidOperationException: Session Variable objects can't be children of App objects`.
```

### O ACHADO 8 MARCOU NATIVO O QUE E TORTO. Diz do guarda de Dropdown/Table: 'sem reflexao, sem trace, sem ida ao Studio'. Duas correccoes. Primeira: o 'guarda de tipos' e `canonical(t).endswith(" List")`

`mistakes` · obtido por `reflection`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam-declarative\ssam_declarative\_type_compat.py:95-96; C:\Users\andre\GitSSAM\ssam-declarative\ssam_declarative\builders\screen.py:13278-13296 e 19860-19888; C:\Users\andre\GitSSAM\ss-patcher\SSDiagnostics\PropertyHandler.cs:84-97; C:\Users\andre\GitSSAM\ss-patcher\SSDiagnostics\ReflectionHandler.cs:6-10`

**Resolve:** saber o que a plataforma permite

**Como se aproveita:** Kernel do Anvil: migrar o FACTO ('a fonte de um dropdown/table tem de ser expressao de lista; `.Current` e escalar nao servem') como job negativo, mas NAO migrar a forma como ele e verificado. No Anvil o alvo e o `IArgument` da instancia de bloco e o tipo vem do modelo, nao de um sufixo de string. E reescrever a frase do facto: dizer 'argumento List do bloco' em vez de 'propriedade List do widget nativo', senao herda-se vocabulario de SS11 num ledger de ODC.

**Caminho nativo:** APURADO (abri o decompilado, ao contrario do achado, que escreveu 'por apurar'). No ODC nao existe tipo Dropdown no modelo: o unico `IComboBoxWidget` e de Traditional Web -- `<IComboBoxWidget inherits="IWebWidget" implementedBy="WebWidgets.ComboBox" />` em C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model.Definition\CodeGeneration.ModelAPI.Interfaces.xml:913. No ODC/Reactive um Dropdown e uma instancia de Block: `IMobileBlockInstanceWidget` (C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model.V1\OutSystems.Model.UI.Mobile.Widgets\IMobileBlockInstanceWidget.cs), com `SourceBlock` e `[Children] IEnumerable<IArgument> Arguments`. A 'propriedade List' e um ARGUMENTO de bloco, nao uma IProperty do modelo.

**O que sobra se se deitar a implementacao fora:** Sobra o facto e sobra a proveniencia, que era o melhor do achado (screen.py:13266-13268 diz de onde o conhecimento veio: o postmortem Timesheet). O que NAO sobra e a etiqueta de nativo: a verificacao e um `endswith` e a escrita e reflexao sobre o processo do Studio.

```
_type_compat.py:95-96 -- `def is_list_type(t: str) -> bool:` / `    return canonical(t).endswith(" List")`. PropertyHandler.cs:86-96 -- `// Try CLR property via reflection` / `var clrProp = control.GetType().GetProperty(propName);` / `clrProp.SetValue(control, converted);` / `["method"] = "reflection"`. ReflectionHandler.cs:6-8 -- `/// Explores the SS process internals via reflection.`
```

### AVISO QUE O LOTE INTEIRO NAO DA: o achado marcou `comoFoiObtido: observacao-manual` nas 13 entradas. Isso descreve como o AGENTE leu, nao como o CONHECIMENTO foi arrancado a plataforma. A superficie d

`mistakes` · obtido por `trace-ou-interposicao`

**Ficheiro:** `C:\Users\andre\GitSSAM\ss-patcher\ (58 ficheiros com marcadores de reflexao); C:\Users\andre\GitSSAM\ss-patcher\SSDiagnostics\ReflectionHandler.cs; C:\Users\andre\GitSSAM\ss-patcher\SSAMHook\HookPatches.cs; C:\Users\andre\GitSSAM\ss-patcher\SSDiagnostics\ModelMirror.cs`

**Resolve:** saber o que a plataforma permite

**Como se aproveita:** Regra de triagem para a migracao inteira: nenhum caso do corpus deve entrar no kernel do Anvil com `comoFoiObtido: api-nativa-do-modelo` sem que alguem tenha aberto o tipo correspondente em ODC3\decompiled. Na duvida, TORTO. Os factos migram; os mecanismos ficam.

**Caminho nativo:** O Anvil ja demonstra o contraste na pratica: fala com `OutSystems.Model.*` por interfaces tipadas (`OutSystems.Model.Types.ITypeSignature` em Verbs.cs:950-955) e so cai em reflexao em pontos nomeados e comentados (Verbs.cs:997-998). O modelo decompilado em C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model.V1 e a superficie nativa: interfaces com `[ModelInterface]`, `[Property]` e `[Children]` declarados.

**O que sobra se se deitar a implementacao fora:** O conhecimento salva-se quase todo, porque o que o corpus regista sao FORMAS ERRADAS que a LLM escreve -- e essas sao verdadeiras independentemente de como o SSAM as detecta. O que nao se salva e nenhum dos mecanismos de deteccao.

```
ReflectionHandler.cs, cabecalho literal: `/// Explores the SS process internals via reflection.` / `/// Allows discovering the internal object model, finding elements, and navigating programmatically.` Contagem propria de marcadores de reflexao em ss-patcher: 2520 ocorrencias em 58 ficheiros.
```

### VEREDICTO SOBRE O ACHADO 10 (delete_entity e limite nosso): SOBREVIVE INTEIRO, e e o segundo melhor do lote. Confirmei os quatro pes: nao ha `def delete_entity` em ss.py (so delete_records:1797, delet

`mistakes` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam_agent_runtime\error_doctor.py:282-299; C:\Users\andre\GitSSAM\ssam-declarative\ssam_declarative\ss.py:13873,13944; C:\Users\andre\GitSSAM\llm_mistakes\artifact_cleanup.json:12-19; C:\Users\andre\Anvil\tests\jobs-odc\delete-entity-whole.json:15-28`

**Resolve:** nao destruir intencao

**Como se aproveita:** Nao portar, como o achado diz. Fica nota de migracao `limite-do-kernel`. Acrescento um quarto facto que o job traz e ninguem registou: apagar a entidade deixa o Record anonimo ORFAO e o Verify nao o assinala -- lixo silencioso no modulo.

**Caminho nativo:** Confirmado e mais rico do que o achado diz. delete-entity-whole.json:23 tem mesmo `{"op": "delete", "target": "IServerEntity:WfCovProject", "force": true, ...}`, e as tres coisas extra estao escritas nos `_why`: a cadeia (indices :15-16, depois atributo :19, depois entidade :23), o `usages` a sub-reportar por causa do filho IIdentifierType (:28) e o circulo fechado que torna `force` inevitavel (:23).

**O que sobra se se deitar a implementacao fora:** O aviso de ergonomia (a LLM tenta sempre `delete_<coisa>` por analogia com `create_<coisa>`) e material de error_doctor, nao de ledger negativo. Confirmo.

```
error_doctor.py:291 -- `cause="SSAM does not expose one dedicated delete_<artifact> method per artifact type.",`. Grep por `No explicit signature` em todo o GitSSAM devolve so 3 linhas, nenhuma de producao: docs/normalizer-coverage-plan.md:503, test_runtime.py:1985 e :1995. E delete-entity-whole.json:26 -- `"no ODC o tipo Record de uma entidade apagada e lixo silencioso: quem quiser o modulo limpo tem de ir busca-lo a mao, nenhuma mensagem o vai lembrar"`.
```

### O GATE ESTA CONFIRMADO, MAS A ROTA QUE ELE OBRIGA A TOMAR E TORTA E O ACHADO NAO DISSE. O preflight AST em check.py e mesmo nativo e offline (o modulo importa ast/json/os/re/time e mais nada da plataf

`regras` · obtido por `trace-ou-interposicao`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam_agent_runtime\check.py (constantes 930-932, comentario 913-929, funcao 935-1029; chamada em 1111-1112) + C:\Users\andre\GitSSAM\ssam_agent_runtime\logic_ir\clipboard_emitter.py (docstring 1-18, constantes 30-45; 209.094 bytes) + clipboard_apply.py / clipboard_doctor.py / clipboard_keys.py`

**Resolve:** saber o que a plataforma permite 22 | nao destruir intencao 24 | complexidade da saida 63

**Como se aproveita:** Kernel do Anvil: portar o desenho do gate tal e qual (recusa por familia + escape com motivo obrigatorio + contagem de fugas como backlog). Mas com uma condicao que o achado omitiu: so vale a pena forcar a rota sancionada se a rota sancionada do Anvil for nativa. Forcar todos para um caminho torto e amplificar a divida, nao pagar.

**Caminho nativo:** Para o GATE: ja e nativo, nada a fazer (ast.walk sobre o ficheiro do proprio agente). Para a ROTA que ele forca: por apurar -- nao abri o equivalente de criacao de Action no Studio decompilado, e o proprio emitter admite que o formato foi colhido e nao derivado. O que ja se sabe e que o caminho no-a-no dentro do Studio custa ~165ms por escrita por causa de reflexao nao-cacheada, ou seja, tambem nao e nativo.

**O que sobra se se deitar a implementacao fora:** O desenho do GATE sobrevive inteiro e e o mais transferivel da area: (1) contar a EVIDENCIA REAL no AST, nao o manifesto -- a revisao adversarial provou que contar so o manifesto deixava passar o lote com expect_artifacts omisso; (2) o bloqueio nunca e beco, o escape liberta na hora; (3) o escape exige motivo com >=12 caracteres e o motivo E o produto; (4) o escape muda o codigo do diagnostico (handwritten_action_batch_escaped) para poder ser contado a parte; (5) a justificacao para endurecer esta no codigo e datada. Sobrevive tambem o numero do clipboard_emitter: ~5565ms no-a-no vs ~125ms por Action coladas, 45x -- e que batching e paralelismo foram medidos e NAO ajudam (1.0x e 0.96x).

```
check.py L930-932: "_HANDWRITTEN_BATCH_ADVISORY = 1\n_HANDWRITTEN_ESCAPE_ENV = \"SSAM_ALLOW_HANDWRITTEN_ACTIONS\"\n_HANDWRITTEN_ESCAPE_MIN_REASON = 12" -- L920-923: "# A recusa NAO e um beco: `SSAM_ALLOW_HANDWRITTEN_ACTIONS=<motivo>` libera na\n# hora. O motivo e obrigatorio e vai para a mensagem/receipt de proposito --\n# cada fuga registrada e um dado sobre o que o IR ainda nao cobre" -- L979-980: "    motivo = str(os.environ.get(_HANDWRITTEN_ESCAPE_ENV) or \"\").strip()\n    liberado = len(motivo) >= _HANDWRITTEN_ESCAPE_MIN_REASON"
MAS clipboard_emitter.py L3-7: "Motivacao medida (2026-08-31, ss1): construir uma Action no caminho no-a-no custa ~5565ms porque CADA escrita paga ~165ms fixos de reflexao nao-cacheada dentro do Service Studio" -- L14-16: "v3 (2026-08-31): o formato foi COLHIDO de especimes vivos via `native_clipboard_serialize` (scripts/bench_harness/specimen_rosetta.py -> _work/rosetta/*.xml), nao inferido." -- L30-33: "# O cabecalho do payload muda por PRODUTO e por BUILD do Studio. Capturas reais: O11 11.55.73.64880 e 11.55.71.64832 (dois builds), ODC 13.1266.1.60000. Fixar um numero e fragil" -- L40: "ACTIVATION_CODE = \"0MV.2ZK.9K6.HYE.8KL.E6Y.9ZC.WOU\""
```

### A ASSIMETRIA ESTA CONFIRMADA LITERALMENTE, MAS A CONTAGEM ESTA ERRADA. O achado diz '7 codigos de diagnostico distintos'. Contei no ficheiro: ha DEZ codigos SESSION_*. O achado nomeia oito e omite doi

`regras` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam_agent_runtime\task_execution_policy.py -- analyze_task_scripts L171-400, codigos em L189, 237, 263, 287, 305, 317, 332, 349, 369, 387; FailureDisposition L403-411. C:\Users\andre\GitSSAM\ssam_agent_runtime\validator.py L96-113.`

**Resolve:** portao independente 46 | nao destruir intencao 24 | complexidade da saida 63

**Como se aproveita:** Kernel do Anvil: os dez tornam-se validacao do plano declarativo, onde e trivial porque o plano ja e dados e dispensa AST. Corrigir a assimetria na travessia: uma politica, escopo declarado por regra.

**Caminho nativo:** A analise e nativa (ast.parse offline do script do agente, L184-185). O torto e o acoplamento, e a citacao esta certa: o caminho de script unico importa uma funcao pensada para sessoes e filtra um unico codigo por comparacao de string. O caminho nativo e uma so politica com escopo declarado por regra (por-ficheiro vs por-sessao), nao um `if code != "...": continue` no chamador.

**O que sobra se se deitar a implementacao fora:** Os invariantes, agora com a lista COMPLETA de dez: SESSION_POLICY_PARSE_ERROR; SESSION_DESTRUCTIVE_MUTATION_SAME_PHASE; SESSION_DESTRUCTIVE_PHASE_ORDER; SESSION_PUBLISH_BUDGET_EXCEEDED; SESSION_EARLY_PUBLISH; SESSION_FINAL_PUBLISH_MISSING; SESSION_NONTERMINAL_DESTRUCTIVE_PUBLISH_BLOCKED; SESSION_DESTRUCTIVE_PUBLISH_REQUIRED; SESSION_DESTRUCTIVE_ERRORS_GATE_REQUIRED; SESSION_FINAL_ERRORS_GATE_MISSING. O par EARLY_PUBLISH/FINAL_PUBLISH_MISSING so faz sentido junto -- publicar cedo e nao publicar de todo sao a mesma regra vista dos dois lados, e perder um deles parte o invariante.

```
validator.py L96-104 literal: "    # S27: the ordinary ``run`` path must enforce the same one-final-publish\n    # budget as a multi-phase ``session``.  Keep the wider session policy\n    # scoped to sessions for compatibility, but never allow repeated publish\n    # dispatches to slip through the generic preflight.\n    from .task_execution_policy import analyze_task_scripts\n\n    for policy_issue in analyze_task_scripts([script_path], probe=True).issues:\n        if policy_issue.code != \"SESSION_PUBLISH_BUDGET_EXCEEDED\":\n            continue"
task_execution_policy.py L403-411: "@dataclass(frozen=True)\nclass FailureDisposition:\n    kind: str\n    retry_allowed: bool\n    max_retries: int\n    preserve_completed_phases: bool\n    recommended_action: str\n    rule_id: str = \"\"\n    counts_toward_circuit: bool = True"
Contagem de codigos no ficheiro: 189 SESSION_POLICY_PARSE_ERROR, 237, 263, 287, 305, 317 SESSION_FINAL_PUBLISH_MISSING, 332, 349, 369, 387 -- dez, nao sete.
```

### CONFIRMADO E PIOR DO QUE O ACHADO DIZ. A regra 4 nao esta so mal descrita: SS() sem alvo nao se limita a ligar-se, pode ARRANCAR o Service Studio. Nas linhas 657-666, antes sequer de resolver o alvo, 

`regras` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam-declarative\ssam_declarative\ss.py -- auto_start L657-666, resolucao de alvo L669-684, consumo do flag em _assert_write_readiness L1402-1410; C:\Users\andre\GitSSAM\AGENTS.md L19; C:\Users\andre\GitSSAM\RUNBOOK.md L42`

**Resolve:** enderecamento entre corridas 36 | erros que nao ensinam 52

**Como se aproveita:** Kernel do Anvil: o alvo e campo obrigatorio do JSON e a ausencia e erro de schema, nunca inferencia. Corrigir AGENTS.md L19 e RUNBOOK.md L42 para dizerem o que o sistema faz mesmo -- hoje as duas linhas ensinam o contrario do codigo.

**Caminho nativo:** O que runner.py:3483-3487 ja faz, e confirmei o comentario datado ao lado. O caminho nativo seria o alvo ser parametro obrigatorio de SS() em vez de tres camadas de fallback (argumento -> env -> inferencia por porta).

**O que sobra se se deitar a implementacao fora:** O facto, mais valioso do que a regra escrita: a ausencia de alvo nao falha em aberto, degrada em SILENCIO -- liga-se a alguma coisa e desliga o portao de write-readiness (ss.py L1409-1410 devolve cedo quando _enforce_write_readiness e False). Um sistema com fallback em cascata nunca diz 'nao sei'; diz sempre algo. E o custo esta datado no proprio codigo: 'meia sessao no alvo errado, locks fantasmas e restarts desnecessarios (forense do rebind de 18 min, 2026-06-11)'.

```
ss.py L669-684: "        selected_target = str(\n            target or os.environ.get(\"SSAM_TARGET\", \"\"),\n        ).strip().lower()\n        if not selected_target:\n            selected_target = next(\n                (\n                    name\n                    for name, target_port in TARGET_PORTS.items()\n                    if target_port == port\n                ),\n                \"\",\n            )\n        self._target = selected_target\n        self._enforce_write_readiness = bool(\n            target or os.environ.get(\"SSAM_TARGET\", \"\").strip(),\n        )"
ss.py L657-658: "        elif auto_start:\n            ready = ensure_ready(port=port)"
ss.py L1409-1410: "        if not getattr(self, \"_enforce_write_readiness\", False):\n            return"
RUNBOOK.md L42: "4. **Sempre informe o alvo**. `SS()` sem target nao abre uma instancia."
AGENTS.md L19: "4. Sempre informe `--target`; `SS()` sem alvo nao seleciona instancia."
runner.py L3479-3484: "    # SDK-14: o alvo resolvido do runner chega DENTRO do script. Antes,\n    # 'run --target ss2' rodava um script cujo SS() conectava no default\n    # 4510 (ss1) - meia sessao no alvo errado, locks fantasmas e restarts\n    # desnecessarios (forense do rebind de 18 min, 2026-06-11).\n    if resolved_target:\n        env[\"SSAM_TARGET\"] = str(resolved_target)"
```

### CITACAO CONFIRMADA MAS A REGRA E MAIS ESTREITA DO QUE O ACHADO DIZ, E O caminhoNativo JA NAO E 'por apurar' NA PARTE QUE INTERESSA. A igualdade de conjuntos consumer so e exigida para ops `add_input` 

`regras` · obtido por `trace-ou-interposicao`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam_agent_runtime\logic_ir\abi_migration.py (import L12, verificacao L476-491) + C:\Users\andre\GitSSAM\ssam_agent_runtime\logic_ir\dependencies.py (_probe_action_consumers L299-337); AGENTS.md L20-21`

**Resolve:** nao destruir intencao 24 | enderecamento entre corridas 36

**Como se aproveita:** Kernel do Anvil: qualquer op que mude assinatura publica exige um mapa consumidor->valor e compara conjuntos, falhando fechado na diferenca -- mas aplicado a TODAS as ops que mudam a assinatura, nao so a add_input obrigatorio. E antes de prometer o resto da regra 5, apurar como se obtem a lista de consumers de forma nativa.

**Caminho nativo:** por apurar. Encontrei candidatos reais no Studio decompilado -- C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model\ServiceStudio.Framework.ReferencesManager\ (AbstractReferencesManager.cs, InMemoryReferencesManager.cs, IReferenceInfo.cs) e OutSystems.Model\OutSystems.Model\DependencyGraph.cs -- mas NAO abri o suficiente para provar que enumeram consumidores de uma Action cross-module. Nomeio-os como pista, nao como facto.

**O que sobra se se deitar a implementacao fora:** O invariante e bom e simples, e sobrevive a tudo: nao basta ter lista de consumers -- o pedido tem de declarar um valor POR consumidor e o conjunto declarado tem de ser EXACTAMENTE igual ao descoberto; qualquer diferenca e erro, nao aviso. Isto mata o modo de falha 'actualizei 3 de 4 consumers'. Sobrevive tambem o cuidado de identidade a volta: o probe recusa-se a continuar se a Action for ambigua (expected=1 observed=N) e se a contagem de usages nao bater com o tamanho da lista.

```
abi_migration.py L483-491: "            for op in normalized_ops:\n                if op[\"op\"] != \"add_input\" or not bool(op.get(\"isMandatory\")):\n                    continue\n                values = op.get(\"consumerValues\")\n                if not isinstance(values, Mapping) or set(values) != consumer_names:\n                    raise AbiMigrationError(\n                        \"LOGIC_ABI_CONSUMER_VALUES_INCOMPLETE\",\n                        f\"{module}.{action_request['name']}.{op.get('name')}: expected consumers={sorted(consumer_names)}\",\n                    )"
dependencies.py L312-313 e L335-337: "    ss = SS(target=target)\n    ss.open(module)" (...) "        cross = ss.inspect.find_usages_in_all_modules(object_key=action_key)\n        if str(cross.object_key or \"\") != action_key:\n            raise RuntimeError(f\"consumer map identity mismatch for {module}.{action_name}\")"
```

### ESTE E O ERRO GRAVE DO ACHADO. A citacao esta certa, mas o comoFoiObtido e o caminhoNativo estao ambos errados. O catalogo de builtins NAO foi obtido por observacao manual de um ficheiro: foi SONDADO 

`regras` · obtido por `trace-ou-interposicao`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam-declarative\ssam_declarative\_os_builtins.py (docstring 1-27, allowlist 340-380, HALLUCINATED_FUNCTIONS 382-404) + C:\Users\andre\GitSSAM\ssam-declarative\ssam_declarative\builtin_catalog_o11.json e builtin_catalog_odc.json (2437 bytes cada) -- VS o nativo em C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model.V1\OutSystems.Model.Expressions\BuiltinFunctionsInfo.cs (L9-13), IBuiltinFunctionInfo.cs (interface completa), IBuiltinFunctions.cs (L7 `IEnumerable<IBuiltinFunction> All`)`

**Resolve:** saber o que a plataforma permite 22 | erros que nao ensinam 52

**Como se aproveita:** Kernel do Anvil: a regra de calibracao e a tabela de alucinacoes migram directas e sao o molde de qualquer validador de expressoes. Mas a LISTA e as ARIDADES devem ser geradas de BuiltinFunctionsInfo.All do Studio decompilado, nao sondadas contra tenant nem mantidas a mao -- e mais completa, traz IsMandatory por parametro, traz visibilidade por contexto, nao gasta um publish por nome e nao envelhece em silencio quando a plataforma acrescenta uma funcao. E a licao de metodo: sondar o tenant para descobrir o que existe e o contorno; ler o modelo do Studio e o caminho.

**Caminho nativo:** EXISTE E ABRI-O. `OutSystems.Model.Expressions.BuiltinFunctionsInfo` expoe `public static IEnumerable<IBuiltinFunctionInfo> All` e uma propriedade por funcao. Cada `IBuiltinFunctionInfo` traz `Name`, `InputParameters`, `TypeKind` e `Description`, e cada `IInputParameterInfo` traz `Name`, `TypeKind`, `IsMandatory` e `Description` -- ou seja, a tabela de aridade E de obrigatoriedade que o GitSSAM curou a mao esta la, completa, de graca. O `IBuiltinFunction` acrescenta ainda o que a tabela curada nem tem: IsVisibleInServerAggregates, IsVisibleInClientAggregates, IsVisibleInScripts, IsVisibleInClientSide, IsVisibleInMobileEmails, IsVisibleInBusinessProcesses -- visibilidade por contexto. Existe o mesmo em o11 (ServiceStudio.Scope\\BuiltinFunctions.cs) e em odc (dois sitios).

**O que sobra se se deitar a implementacao fora:** O CONHECIMENTO salva-se quase todo, e e por isso que o achado nao e mau -- e so mal etiquetado. Sobrevivem: a lista de nomes inventados com o substituto literal (FirstDayOfMonth -> AddDays(date, -Day(date) + 1); Now -> CurrDateTime(); Len -> Length(text); Substring -> Substr(...)); as aridades-armadilha (FormatDecimal tem 4 parametros obrigatorios e nao 2; Index tem 5 e os 3 ultimos TEM de ser nomeados; Trunc so aceita 1 argumento ao contrario de Round); os factos negativos datados (Log/Exp e BuildDate/BuildTime nao existem, provado vivo 2026-07-02; GetException nao e funcao de expressao, so existe no scope do Exception Handler); e a regra de calibracao -- generoso no permitido (falso negativo e a direccao segura, WARN mole), duro so no comprovadamente inexistente (ERROR com o substituto exacto). O que NAO se salva e o metodo de obtencao.

```
builtin_catalog_o11.json (cabecalho literal): "{\n \"target\": \"o11\",\n \"probe\": \"Name(0) via add_assignment; Unknown function => NOT exists\",\n \"proven_at\": \"2026-07-02\",\n \"exists\": ["
_os_builtins.py L343-344: "    # math (F05: Log/Exp REMOVIDOS - Unknown function provado vivo em\n    # SS2+ODC1 2026-07-02; catalogo congelado em builtin_catalog_*.json)"
_os_builtins.py L334-338: "# To keep false positives near zero we OVER-INCLUDE: the allowlist is generous\n# (a missing real built-in just means we stay silent - the safe direction), and\n# the generic \"unknown\" case is a soft WARN ... Names we KNOW are invalid\n# (commonly hallucinated) are an ERROR with the exact OS replacement."
NATIVO -- IBuiltinFunctionInfo.cs literal: "public interface IBuiltinFunctionInfo\n{\n\tpublic interface IInputParameterInfo\n\t{\n\t\tstring Name { get; }\n\n\t\tTypeKind TypeKind { get; }\n\n\t\tbool IsMandatory { get; }\n\n\t\tstring Description { get; }\n\t}\n\n\tstring Name { get; }\n\n\tIEnumerable<IInputParameterInfo> InputParameters { get; }\n\n\tTypeKind TypeKind { get; }\n\n\tstring Description { get; }\n}"
BuiltinFunctionsInfo.cs L13: "\tpublic static IEnumerable<IBuiltinFunctionInfo> All => functionsByName.Value.Values;"
```

### ATAQUE AO CONJUNTO (achado novo, meu): a premissa que sustenta metade das etiquetas do outro agente esta errada. Ele trata `call_modify("comando nomeado")` como o lado limpo e `invoke()` como o lado t

`declarative` · obtido por `trace-ou-interposicao`

**Ficheiro:** `C:\Users\andre\GitSSAM\ss-patcher\SSDiagnostics\SSModelHandler.cs:24-25, :3923, :5838-5839; C:\Users\andre\GitSSAM\ss-patcher\SSAMHook\HookPatches.cs:1-16, :215`

**Resolve:** binario velho 15; portao independente 46; saber o que a plataforma permite 22

**Como se aproveita:** Corrige a decisao de autoria, nao a inverte. A bridge do SSAM-Hybrid-ODC continua a fazer sentido para o que exige Studio VIVO, mas nao se pode dizer que ela ja e "quase nativa" porque fala por comandos nomeados. E divida de interposicao a serio: Harmony sobre metodos nao publicos parte com qualquer build do Studio, em silencio, em runtime. Nada deste C# deve ser portado para o kernel do Anvil; o que se leva e o VOCABULARIO dos comandos, nunca a implementacao.

**Caminho nativo:** Anvil e o contraste medido, mas honesto: tambem e reflection, so que restrita. `Verbs.cs:24` declara `private const BindingFlags Pub = BindingFlags.Public | BindingFlags.Instance;` e `ModelApiMetadata.cs:64-65` filtra por namespace publico. Em todo o `C:\Users\andre\Anvil\src` ha 0 ocorrencias de HarmonyLib/Mono.Cecil, 30 `GetProperty(`, 11 `GetMethod(` e 16 `.SetValue(` -- contra 655/249/155 num so ficheiro do SSAM. `BindingFlags.NonPublic` no Anvil so aparece na camada de hospedagem (HeadlessRuntime.cs, PublishHandler.cs, ReferenceRefresher.cs, Studio.cs), nunca no motor de verbos.

**O que sobra se se deitar a implementacao fora:** O criterio que falta ao vocabulario todo: a divisao util nao e "nativo vs reflection" (as duas casas usam reflection), e (a) superficie -- so interfaces publicas de OutSystems.Model*/ServiceStudio.Plugin*, ou tambem membros internos; (b) integridade do processo -- carregar assemblies, ou reescrever metodos do Studio com Harmony; (c) transporte -- em processo, ou DLL injectada com socket. Escrever isto como regra de admissao evita que o proximo agente marque "nativo" o que so tem nome bonito.

```
"private const BindingFlags AllInstance = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;" (SSModelHandler.cs:24) e "_nativeClipboardHarmony = new HarmonyLib.Harmony(\"ssam.native.clipboard.override\");\n            _nativeClipboardHarmony.Patch(getOmlData, prefix: new HarmonyLib.HarmonyMethod(prefix));" (SSModelHandler.cs:5838-5839) e "/// The in-memory equivalents of the two Mono.Cecil patches SSAM used to write\n/// to disk. Each one is applied as soon as its target assembly appears in the\n/// process" (HookPatches.cs:6-8) contra "    private const BindingFlags Pub = BindingFlags.Public | BindingFlags.Instance;" (Anvil Verbs.cs:24)
```

### CITACAO CONFIRMADA, RACIOCINIO DERRUBADO. `self._c.call_modify("createEntity", name=name)` esta mesmo em _data.py:489, e o contrato do cliente TCP esta mesmo em UNIFICATION_PLAN.md:149-150, e a porta 

`declarative` · obtido por `trace-ou-interposicao`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam-declarative\ssam_declarative\_data.py:489; UNIFICATION_PLAN.md:143 e :149-150; ssam_declarative\_client.py:2, :217-218`

**Resolve:** portao independente 46; enderecamento entre corridas 36; binario velho 15

**Como se aproveita:** Bridge do SSAM-Hybrid-ODC, mas com a conclusao invertida: a diferenca face ao Anvil NAO e so de transporte. E de transporte (TCP+DLL injectada vs assemblies em processo) E de superficie (membros internos + Harmony vs interfaces publicas do Model API). O mapa de vocabulario que ele fez continua util -- `createEntity`/`addAttribute`/`addNode`/`addWidget`/`setProperty` batem com `create`/`set`/`link` -- mas serve para traduzir intencao, nao para justificar copia de implementacao.

**Caminho nativo:** Confirmei o exemplo dele linha a linha em `C:\Users\andre\Anvil\tests\jobs\static-entity.json`: os dois objectos JSON que ele citou estao la tal e qual. E confirmei os nomes de interface no Studio descompilado: `C:\Users\andre\ODC3\decompiled\v1-interfaces.txt` linha 947 = IEntityAttribute, 958 = IStaticEntity, 988 = IRecord. As tres citacoes de linha estao certas.

**O que sobra se se deitar a implementacao fora:** A dependencia de instalacao e pior do que ele descreveu e vale como diagnostico: nao e so "DLL injectada + porta 4510", e tambem patches Harmony aplicados a assemblies do Studio a medida que carregam. Um verificador de "binario velho" tem de comparar a versao do Studio ANTES de escrever, porque a falha destes patches e silenciosa.

```
"        resp = self._c.call_modify(\"createEntity\", name=name)" (_data.py:489); "SSAMClient(port=4510, timeout=30)" (UNIFICATION_PLAN.md:143); "  .call_modify(action, skip_command=True, **params) -> dict\n    # call_modify = call(\"modify_model\", action=action, skipCommand=skip_command, **params)" (:149-150); no descompilado: "Interface OutSystems.Model.Data.IStaticEntity" (v1-interfaces.txt:958)
```

### CONFIRMADO no essencial, com duas correccoes factuais. O aviso do modulo esta em _clipboard.py:7-9 e `OUTSYSTEMS_TEXT_TYPE = "%uROOBXPvQEyU76NWO+1uxQ"` em :47 -- exactos. Correccao 1: a versao do O11 

`declarative` · obtido por `trace-ou-interposicao`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam-declarative\ssam_declarative\_clipboard.py:7-9, :38-41, :47-72 (794.721 bytes); native_paste.py:28; ss-patcher\SSDiagnostics\SSModelHandler.cs:5838-5839`

**Resolve:** binario velho 15; complexidade da saida 63

**Como se aproveita:** Concordo integralmente com ele: nao aproveitar o motor. Acrescento que a divida e maior do que 794 KB de constantes -- as chaves nao param nos 12 tipos basicos; de :59 a :72 ha chaves internas para REST client, REST action, REST structure e sete NRWidgets (Button, Expression, Input, Container, AdvancedHTML, Form, Label, Link). Cada widget novo do Studio e uma chave nova a decorar a mao.

**Caminho nativo:** Confirmado no Anvil: o equivalente de `OUTSYSTEMS_TEXT_TYPE` e `{"op":"set","prop":"DataType","value":"Text"}`, e a linha AGENTS.md:260-262 que ele citou existe mesmo e lista os tipos por nome, incluindo '<Entidade> Identifier', '<Structure>' e '<X> List' com criacao automatica da lista.

**O que sobra se se deitar a implementacao fora:** O nome do formato (`avn-app-fmt:OmlFormat`, :38), as duas versoes esperadas -- ODC `13.1266.1.60000` em _clipboard.py:39 e O11 `11.55.71.64832` em native_paste.py:28 -- e o aviso dos proprios autores. Serve para um diagnostico de binario velho ANTES de escrever. O resto deita-se fora.

```
"This module is deliberately private/experimental. It is not used by the\nregular SSAM builders and must not become an LLM-driven replacement path until\nthe procedural validation rules are strong enough for broader use." (:7-9); "OUTSYSTEMS_OML_CLIPBOARD_FORMAT = \"avn-app-fmt:OmlFormat\"\nDEFAULT_CLIPBOARD_VERSION = \"13.1266.1.60000\"" (:38-39); "O11_CLIPBOARD_VERSION = \"11.55.71.64832\"" (native_paste.py:28)
```

### CITACAO CERTA, ESTADO ERRADO -- e errado para o lado perigoso. A docstring de _explore.py diz mesmo o que ele citou (linhas 12-15 e o passo 4 na :21). Mas ele marcou o ficheiro como "funciona-hoje-por

`declarative` · obtido por `reflection`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam-declarative\ssam_declarative\_explore.py:1-21 (o "via runtime reflection" esta na :6), :694`

**Resolve:** saber o que a plataforma permite 22; erros que nao ensinam 52

**Como se aproveita:** Documento + politica do kernel, como ele disse -- mas a conclusao dele de que "a reflection e minoritaria" nao se sustenta. Ela so e minoritaria se contarmos do lado do Python. Do lado do C#, para onde vao os 215 `call_modify`, ha 655 `GetProperty(` e 46 `BindingFlags.NonPublic` num so ficheiro. A regra a escrever e a dele; a metrica que a acompanha tem de ser deitada fora ou refeita do lado certo.

**Caminho nativo:** No Anvil o problema esta resolvido por construcao, e isso confirmei: `ModelApiMetadata.cs:64-65` so aceita tipos cujo namespace comeca por "OutSystems.Model" ou "ServiceStudio.Plugin", e `Verbs.cs:24` usa `BindingFlags.Public | BindingFlags.Instance`. Nao e ausencia de reflection -- e reflection com portao.

**O que sobra se se deitar a implementacao fora:** Os 4 passos do workflow (explore -> invoke getter -> mapear caminho completo -> so entao implementar como comando) e a regra de seguranca literal: leitura por invoke e segura, escrita por invoke fura o Command system e da NullReferenceException na verificacao do modelo. E o detalhe que ele nao deu e que fecha a porta: `use_command: bool = False` e o DEFAULT do invoke (_explore.py:694), ou seja a escrita insegura e a mais facil de escrever por acidente.

```
"Use these tools to discover interfaces, methods, and properties on any\nService Studio model object, and to invoke methods for live testing - all\nvia runtime reflection without needing to read C# source code or rebuild\nthe DLL." (_explore.py:4-7) e "  - invoke() is DANGEROUS FOR WRITING because it bypasses the SS Command\n    system." (:12-13) e "  4. Only then implement as a modify_model command in SSDiagnostics C#." (:21) e "        use_command: bool = False," (:694)
```

### CONFIRMADO integralmente, citacao exacta. O docstring de `_fix_type_via_invoke_with_readback` diz mesmo, em types.py:886-891, que o `SetDataType` do C# usa `FindObjectByName` e falha para structures/e

`declarative` · obtido por `trace-ou-interposicao`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam-declarative\ssam_declarative\types.py:886-891, :919-926, :943-947, :954-960, :968-975`

**Resolve:** erros que nao ensinam 52; nao destruir intencao 24

**Como se aproveita:** Kernel do Anvil como caso de teste, exactamente como ele disse. Acrescento um terceiro caso que esta no ficheiro e ele nao trouxe, e que e o mais traicoeiro: para Structures CONSUMIDAS de outro modulo, o ListType so aparece atraves de um parametro publico de bloco/action, e o Studio, sem isso, "silently falls back to Text" (:945-946). Ou seja o modo de falha silenciosa tem tres portas, nao uma.

**Caminho nativo:** Confirmei a citacao do Anvil: AGENTS.md:260-262 existe e diz o que ele disse -- os tipos aceites por nome incluem "<Entidade> Identifier", "<Entidade>", "<Structure>" e "<X> List" com "(cria a lista se preciso)". O caminho nativo e mesmo mais simples do que o contorno.

**O que sobra se se deitar a implementacao fora:** O facto e o limiar: tipo basico resolve por nome, tipo complexo TEM de resolver por chave, e a falha e silenciosa -- o campo fica Text sem erro. Logo, sem readback nao ha sucesso. Vale tambem o caso Identifier (alvo = atributo identificador) e o caso da Structure consumida (ListType so via parametro publico). Tres armadilhas, uma regra: confirmar o tipo lido, nunca aceitar o retorno da escrita.

```
"The C# ``SetDataType`` command uses ``FindObjectByName`` internally,\n    which fails for structures and entities. This function bypasses that\n    by resolving the type name to an objectKey via ``find_element``, then\n    calling ``invokeMethod(\"set_Type\", [objectKey])`` which uses\n    ``FindByObjectKey`` -- a path proven to work by Harmony trace of the\n    real Service Studio UI." (:886-891) e "Service Studio cannot rebuild that\n        # wrapper by name and silently falls back to Text." (:944-946)
```

### CONFIRMADO, e a leitura do descompilado confere. _flow.py:3527-3530 diz mesmo o que ele citou, e IForEachNode.cs do ODC declara mesmo `RecordList` como ExpressionProperty publica (:26-27) com `void Se

`declarative` · obtido por `reflection`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam-declarative\ssam_declarative\_flow.py:3520-3574; C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model.V1\OutSystems.Model.Logic.Nodes\IForEachNode.cs:23-30, :36-40`

**Resolve:** saber o que a plataforma permite 22; complexidade da saida 63

**Como se aproveita:** Kernel do Anvil: nenhuma accao, ja esta certo la. Serve como prova de que ler o descompilado paga -- concordo com ele. Acrescento a prova do lado do Anvil: `Verbs.cs:419-425` trata precisamente esta familia, com o comentario "propriedade so-leitura que devolve uma expressao (Input.Variable, Button.Enabled, Dropdown.List, Aggregate.MaxRecords...)" e escreve `expr.Text`. Ou seja o Anvil ja generalizou a familia que ele identificou.

**Caminho nativo:** `[ExpressionProperty(DisplayName = "Record List", ..., RuntimeTypeKind = TypeKind.List)] IExpression RecordList { get; }` e `void SetRecordList(ExpressionDefinition value);` -- publicos em IForEachNode. No Anvil: `set RecordList "GetX.List"` (AGENTS.md:284, verificado), servido por Verbs.cs:419-425.

**O que sobra se se deitar a implementacao fora:** A familia e real e esta declarada no descompilado: MaximumIterations (:23-24), RecordList (:26-27), StartIndex (:29-30), todas ExpressionProperty so-getter, todas com um Set*(ExpressionDefinition) ao lado (:36-40). Quem escreve um compilador trata a familia toda com uma regra -- receber texto OutSystems e escrever o Text da expressao -- e nao caso a caso. O Anvil ja o faz; o SSAM bifurcou por faixa por nao ter lido isto.

```
"**ODC**: the ``invoke`` path fails because the C# arg resolver\n        cannot convert a plain string to ``ExpressionDefinition``. Uses\n        ``set_property(\"RecordList\", expr)`` instead" (_flow.py:3527-3530); no descompilado: "[ExpressionProperty(DisplayName = \"Record List\", SupportsTypeConversion = false, SupportsRecordAndListLiterals = false, RuntimeTypeKind = TypeKind.List)]\n\tIExpression RecordList { get; }" (IForEachNode.cs:26-27); no Anvil: "if (pi != null && !pi.CanWrite && pi.GetValue(target) is IExpression expr)" (Verbs.cs:419)
```

### CONFIRMADO, citacao exacta e datada. O comentario de 2026-08-29 esta em _flow.py:4652-4654 tal e qual, e o descompilado confirma que `CycleTarget` e `[Property] IActionNode CycleTarget { get; set; }` 

`declarative` · obtido por `reflection`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam-declarative\ssam_declarative\_flow.py:4604-4606, :4637-4649, :4652-4669; C:\Users\andre\ODC3\decompiled\odc\...\IForEachNode.cs:12-16`

**Resolve:** erros que nao ensinam 52; portao independente 46; nao destruir intencao 24

**Como se aproveita:** Kernel do Anvil: importar o GUARDA, como ele disse. Acrescento o que o ficheiro mostra e ele nao: o guarda tem duas fases -- primeiro recusa vazio (:4657-4669, com `record_violation("set_cycle_target_drift")`), depois recusa alvo diferente do pedido (:4670+). E a segunda fase que e o conhecimento caro; a primeira foi a que deixou passar a regressao.

**Caminho nativo:** `[Property] IActionNode CycleTarget { get; set; }` -- propriedade gravavel, e portanto uma aresta do grafo. No Anvil: `link from $foreach connector CycleTarget to $primeiro`, e confirmei AGENTS.md:282-283, que diz literalmente que no ForEach o `CycleTarget` "entra no ciclo; o `Target` e a saida". Mais simples e sem reflection.

**O que sobra se se deitar a implementacao fora:** A regra do readback, generalizavel a todo o kernel: verificar que a escrita persistiu NAO e verificar que o campo ficou preenchido, e verificar que ficou com o valor PEDIDO. O incidente esta datado no codigo e nomeia a classe de erro. Vale tambem a distincao conceptual que ele apanhou bem: tratar uma ligacao de fluxo como propriedade de dados e a raiz do problema.

```
"        # 2026-08-29: o check antigo (so nao-vazio) deixou passar a\n        # regressao do retarget de 27/08 - o CycleTarget apontava para o\n        # End e \"nao-vazio\" era verdade. Ler o alvo REAL fecha essa classe." (_flow.py:4652-4654); no descompilado: "\t[Property]\n\tIActionNode CycleTarget { get; set; }" (IForEachNode.cs:15-16)
```

### ATAQUE PASSOU, COM UPGRADE DE PROVA. A fricção #5 (decimals/default em atributo de entidade) é mesmo REFLECTION — confirmei os dois mecanismos por nome no ficheiro: `type.GetMethod(setter, AllInstance

`friccoes` · obtido por `reflection`

**Ficheiro:** `Torto: C:\Users\andre\GitSSAM\ss-patcher\SSDiagnostics\EntityAttributeOptions.cs:33 (BindingFlags), :63-75 (GetMethod+Invoke). Nativo VERIFICADO POR MIM: C:\Users\andre\ODC3\decompiled\o11\ServiceStudio.Framework\ServiceStudio.Model\AbstractAttribute.cs:750/755/760 e :202/:204; C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model\ServiceStudio.Model\AbstractAttribute.cs:1073/1078/1083 e :208/:210; C:\Users\andre\ODC3\decompiled\o11\ServiceStudio.Framework\ServiceStudio.Model\AbstractEntityAttribute.cs:731-756 e :791-797`

**Resolve:** saber o que a plataforma permite (22)

**Como se aproveita:** Anvil: NÃO portar a escada ResolveWritePath. Portar um contrato declarativo de 5 linhas: (a) três setters públicos nomeados, com linha nas duas faixas; (b) tipo em estado final ANTES de Length/Decimals/DefaultValue, porque o reset é privado e não se desliga; (c) readback obrigatório — o comparador deles já existe e é bom (`ValueMatches` compara inteiros como número, não como texto, em EntityAttributeOptions.cs:174-179). O ganho é medível: ~150 linhas de adivinhação trocadas por 3 chamadas diretas.

**Caminho nativo:** APURADO POR MIM NO DECOMPILADO, com linha, e nas duas faixas. Os três setters string são PÚBLICOS: `public void SetLength(string value)` / `SetDecimals(string)` / `SetDefaultValue(string)` em AbstractAttribute.cs — o11:750/755/760, ODC:1073/1078/1083. Os valores do reset são constantes nomeadas, não mágicas: `internal virtual int DefaultDecimalDecimals => 8` e `internal virtual int DefaultDecimalLength => 37` (o11:202/204, ODC:208/210), e o Text é `SetLength("50")` literal. A lei de ordem existe: `OnTypeChanged` com `reason == RefreshReason.ChangedProperty` chama `SetDecimalsAndLength(resetExistingValues: true)`. ATENÇÃO — `SetDecimalsAndLength` é `private` (o11:731) e `protected` (ODC:1019): não se chama de fora, só se pode pôr o tipo FINAL antes de escrever.

**O que sobra se se deitar a implementacao fora:** Tudo sobrevive sem a implementação, e agora com endereço verificável: nomes dos três setters públicos, ficheiro e linha no o11 E no ODC, os valores do reset como constantes (37/8 para Decimal, 50 para Text) e a lei de ordem. O que se deita fora é a escada. Lição de método que vale mais do que o facto: uma citação do tipo "Framework:43773" dentro de um comentário NÃO é prova apurada — é prova herdada; só conta depois de alguém abrir o decompilado, e quem abriu ganhou de graça a faixa ODC que o comentário não tinha.

```
Torto, EntityAttributeOptions.cs:33 e :69-75: "private const BindingFlags AllInstance = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;" / "try { m = type.GetMethod(setter, AllInstance, null, new[] { arg }, null); }" ... "(target, value) => captured.Invoke(target, new[] { ConvertValue(argType, value) }));". Nativo, o11 AbstractAttribute.cs:750-760: "public void SetLength(string value)" / "public void SetDecimals(string value)" / "public void SetDefaultValue(string value)"; :202-204: "internal virtual int DefaultDecimalDecimals => 8;" e "internal virtual int DefaultDecimalLength => 37;". Lei de ordem, AbstractEntityAttribute.cs:791-796: "protected override void OnTypeChanged(RefreshReason reason)" ... "if (!IsReadOnly && reason == RefreshReason.ChangedProperty)" ... "SetDecimalsAndLength(resetExistingValues: true);"; e :731 "private void SetDecimalsAndLength(bool resetExistingValues)" com :742 "SetLength(\"50\");" e :748-752 "SetLength(DefaultDecimalLength);" / "SetDecimals(DefaultDecimalDecimals);".
```

### ATAQUE PASSOU E ENCONTREI O CAP NO CÓDIGO. O ModelMirror é mesmo reflection (o próprio cabeçalho diz "off-thread reflection walk", mais 4 ocorrências de GetProperty/GetMethod/Invoke/GetValue no fichei

`friccoes` · obtido por `reflection`

**Ficheiro:** `C:\Users\andre\GitSSAM\ss-patcher\SSDiagnostics\ModelMirror.cs:3-7 e :17-18 (419 linhas). Walk oficial localizado por mim: C:\Users\andre\GitSSAM\ss-patcher\SSDiagnostics\SSModelHandler.cs:27039, :27117 e a chamada com cap em :1440`

**Resolve:** inspect: tamanho e filtro (87)

**Como se aproveita:** Documento + contrato para o Anvil. Copia-se o CONTRATO de cache de leitura, que é bom: (a) a cache nunca decide correcção; (b) cada linha servida é re-verificada contra o vivo; (c) qualquer escrita marca stale; (d) falha de verificação = cai para o caminho lento. NÃO se copia "cópia fiel, manter em sincronia". E como o cap é parâmetro e não lei, o Anvil pode fazer o que falta: declarar quando truncou.

**Caminho nativo:** por apurar, mas MENOS vago do que estava: o walk oficial é `SearchInESpace`/`SearchInFlow` em SSModelHandler.cs:27039/:27117, e o cap de 200 é um argumento literal na chamada :1440 — logo o cap é PARÂMETRO, não limite de plataforma, e passa a ser uma escolha do kernel. O que continua por apurar é se o Studio expõe índice próprio que dispense a travessia; não o procurei no decompilado.

**O que sobra se se deitar a implementacao fora:** O contrato de quatro pontos da cache de leitura, e os números que o justificam (0,5-60 s de freeze por leitura na UI thread em apps de produção; get_active_module a ~1 ms saudável contra 76 175 ms com o dispatcher entupido). Mais o facto novo: o cap de 200 é argumento de chamada, portanto o silêncio na truncagem é uma decisão, não uma limitação.

```
ModelMirror.cs:3-7 e :17-18 literal: "// Problem: every name/key read walked the model ON the UI thread — 0.5-60s\n// freezes on production-size apps, repeated per query. The mirror builds the\n// full catalog ONCE on a background CLR thread (the off-thread reflection\n// walk doubles as its own canary: any exception disables the mirror for the\n// session) and serves find_element from memory in milliseconds." / "// The traversal below is a faithful copy of SearchInESpace/SearchInFlow\n// (SSModelHandler) with the filters removed — keep them in sync." Cap localizado por mim, SSModelHandler.cs:1440: "SearchInESpace(espace, name, elementType, parentName, rawResults, 200);"
```

### ATAQUE PASSOU: #146 continua VIVO no código de hoje, linha intacta. Abri o ficheiro (21 983 linhas) e a linha 3559 é exactamente `updated = pattern.sub(block, existing)` — conteúdo CSS do utilizador p

`friccoes` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam-declarative\ssam_declarative\ss.py:3559 (ficheiro de 21 983 linhas; contexto :3553-3563). Fricção descrita em C:\Users\andre\GitSSAM\docs\tasks\2026-09-03-friccoes-ssam-kkr-time-entry.md:239`

**Resolve:** não destruir intenção (24)

**Como se aproveita:** Conserto imediato de uma linha no SSAM-Hybrid-ODC, e regra no kernel do Anvil: conteúdo do utilizador NUNCA entra como template de substituição — nem em re.sub, nem em format, nem em interpolação de SQL. É a mesma classe da injecção. O detalhe que torna isto didáctico: o mesmo autor escapou correctamente o padrão três linhas acima; o erro não foi ignorância, foi assimetria de atenção entre os dois lados da mesma chamada.

**Caminho nativo:** trivial e mais curto do que o errado: `pattern.sub(lambda _: block, existing)` — a forma com callable não interpreta escapes. Não é problema de plataforma, é defeito de uma linha. Confirmei que o `pattern` já é compilado com `re.escape` nos delimitadores (:3553-3556), ou seja o autor já conhecia o perigo do lado do PADRÃO e falhou-o do lado da SUBSTITUIÇÃO.

**O que sobra se se deitar a implementacao fora:** A classe de defeito e o sintoma que a denuncia: um valor que "desaparece" ou muda de forma em silêncio depois de passar por uma substituição. No log, o `\\2304` virou o caractere "4" na tela e ninguém percebeu durante cerca de 1 h.

```
ss.py:3553-3559 literal: "        pattern = re.compile(\n            re.escape(start) + r\".*?\" + re.escape(end),\n            flags=re.DOTALL,\n        )\n        prev = pattern.search(existing)\n        if prev:\n            updated = pattern.sub(block, existing)". Fricção, :239: "`ss.set_theme_css_block` passa o CSS como TEMPLATE de `re.sub` (`pattern.sub(block, existing)`): qualquer `\\25CF`/`\\2304` em `content:` vira backreference → `re.PatternError: invalid group reference 25` (crash) ou, pior, o `\\2304` de 23:47 virou \"4\" na tela em silêncio."
```

### ATAQUE PASSOU — é o achado de arquitectura mais valioso do lote e todas as linhas conferem. O cliente ABANDONA ao estourar o transport timeout (120 s) mas o comando CONTINUA a correr server-side, sem 

`friccoes` · obtido por `trace-ou-interposicao`

**Ficheiro:** `C:\Users\andre\GitSSAM\docs\ODC1_FRICTION_LOG.md:19-43 (723 linhas); mitigação no código em C:\Users\andre\GitSSAM\ssam-declarative\ssam_declarative\_client.py:242-255`

**Resolve:** handoff/registo (60) e endereçamento entre corridas (36)

**Como se aproveita:** Contrato de transporte no kernel do Anvil, e é DESENHO, não conserto: um timeout de transporte SEM verbo de cancelamento é um envenenador de fila. Nunca abandonar sem cancelar, ou tornar cada operação idempotente com id de correlação. O código já tem meia-consciência disto — o comentário do watchdog fala em "abandon the in-flight bridge operation" — mas resolveu-o esticando prazos, que adia o envenenamento em vez de o impedir.

**Caminho nativo:** por apurar — não encontrei verbo de cancelamento no bridge. O que existe é mitigação por prazo: timeouts por método mais longos e isenção do watchdog (`_watchdog_deadline` devolve None para métodos com deadline próprio). O nativo seria um cancel/abort no protocolo, ou operações idempotentes com id de correlação para o retry não duplicar. Não procurei verbo de cancelamento no Studio decompilado.

**O que sobra se se deitar a implementacao fora:** O mecanismo inteiro e os números que o provam (1 ms vs 76 175 ms; bridge_ms ≈ wall_ms). E o sinal de vida correcto que eles descobriram: CPU do Studio a subir + processo do runner vivo, NÃO o "Responding" do Windows — porque é o "Não está respondendo" que leva a matar e re-tentar, que é exactamente o que estraga o dispatcher.

```
ODC1_FRICTION_LOG.md:38-43 literal: "**Mecanismo (código lido, não suposto)** —\n`ssam-declarative/ssam_declarative/_client.py:_send_and_receive`: ao estourar\n`transport_timeout` (=`TIMEOUT_TCP_CALL_ODC`, 120 s) o cliente faz\n`self.disconnect()` e levanta `SSAMTimeoutError`. O comando **não é\ncancelado**: continua a correr server-side. Toda chamada seguinte fica atrás\nde um comando em voo invisível, e cada retry enfileira mais um." Medida, :30-33: "| 21:44:49 | `get_active_module` | **76 175 ms** | a MESMA chamada custa ~1 ms saudável |" e "`bridge_ms ≈ wall_ms` em todas — **não é rede**, é tempo dentro do Studio, na\nUI thread." Mitigação, _client.py:247-249: "        # This method owns a longer, finite transport deadline.  Applying the\n        # generic 12s soft watchdog would turn healthy cold compilation into a\n        # false SSAMUIFrozenError and abandon the in-flight bridge operation."
```

### ATAQUE PASSOU — e é a conclusão que deve mandar no transporte para o Anvil. A fricção é esmagadoramente de CAMINHO TORTO, não de plataforma, e a prova é estrutural: os consertos aterraram todos em fic

`friccoes` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\docs\tasks\2026-09-07-ondas-1-4-kkr-fixes-implementadas.md:164-175 (refutações) e :36-50 (consertos, coluna "Onde" = ficheiros nossos); fricções de plataforma em C:\Users\andre\GitSSAM\docs\tasks\2026-09-03-friccoes-ssam-kkr-time-entry.md:63, :64, :195, :218`

**Resolve:** todas as nove, transversalmente

**Como se aproveita:** NÃO herdar implementações do GitSSAM por omissão. Cada receita que funciona tem de ser reaberta com a pergunta "isto é facto da plataforma ou contorno nosso?". O teste barato, que usei e recomendo: ONDE ATERROU O CONSERTO? Se coube no código do SSAM, a fricção era do SSAM e a receita que a contornava é dívida, não património. A coluna "Onde" do doc de fixes responde a isso de relance, sem ler descrições.

**Caminho nativo:** por apurar caso a caso — mas o padrão está estabelecido por três espécimes: quando se foi ao decompilado (#5) ou ao modelo real (#35, #95), o caminho nativo apareceu e era MAIS SIMPLES do que o contorno. Nas três vezes. Isso é sinal, não coincidência.

**O que sobra se se deitar a implementacao fora:** O critério de triagem em si — "onde aterrou o conserto?" — que é reutilizável, não custa nada e separa fricção de plataforma de fricção de contorno melhor do que qualquer leitura da descrição. Mais a lista curta e fiável do que É mesmo da plataforma, que vale guardar porque vai reaparecer no ODC.

```
Secção de refutações, doc de fixes:164 e :170-173: "## 6. Afirmações do log refutadas pelo código (corrigir antes de virar backlog)" ... "- #36: whitespace/caixa JÁ eram normalizados; o bug era a mensagem truncar em 90\n  caracteres (corrigido).\n- #70/#71: os checks do wrapper rodam ANTES de mutar; a sujeira era do resto\n  da fatia. O buraco real era o `validate` offline (corrigido)." Consertos em ficheiros nossos, :44 e :48: "| #24 | Verificador espera `Authorize<Role>` (era `AuthorizeRole` fixo); teste que cravava o bug corrigido | `apply.py` `_authorization_prologue` |" e "| #88 | ScreenBuilder verifica tipo da local pelo objectKey do create ... | `screen.py` `_verify_local...`". Plataforma genuína, log :63: "Ou seja: criar uma Entity e um SQL sobre ela na MESMA fatia é impossível pela rota canônica (o card manda testar SQL antes de publicar)."
```

### O TRANSPORTE: servidor TCP JSON-lines dentro do processo do Studio, 127.0.0.1, uma porta por alvo (ss1=4510, ss2=4512, odc1=4513). Uma linha JSON por pedido/resposta, sem framing e sem versao no envel

`runtime` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam_agent_runtime\bridge_health.py:349-357 (_call_bridge, citacao exacta); C:\Users\andre\GitSSAM\ssam-declarative\ssam_declarative\_client.py:1-19 (docstring do unico ponto de I/O, exacta); C:\Users\andre\GitSSAM\ssam_agent_runtime\app_bootstrap.py:13-25 (comentario da fonte unica em 13-16, mapa em 21-25 -- o achado citou 17-25)`

**Resolve:** saber o que a plataforma permite (22); enderecamento entre corridas (36)

**Como se aproveita:** Bridge do SSAM-Hybrid-ODC. O facto a guardar e o contrato de mensagem {method, params} -> {success, data, error}, que o docstring do _client.py fixa por escrito, e o mapa alvo->porta. A ausencia de versao na RESPOSTA confirma-se por omissao: o docstring so declara tres campos. O kernel do Anvil deve versionar o envelope.

**Caminho nativo:** Nao ha API nativa de rede no Studio; o transporte e escolha de arquitectura legitima. O torto e o que o carrega para dentro do processo (entrada seguinte).

**O que sobra se se deitar a implementacao fora:** O envelope de tres campos e o mapa alvo->porta. Sobrevivem a qualquer troca de transporte.

```
def _call_bridge(port: int, method: str, *, timeout: float) -> dict[str, Any]:
    with socket.create_connection(("127.0.0.1", port), timeout=timeout) as sock:
        handle = sock.makefile("rw", encoding="utf-8", newline="\n")
        handle.write(json.dumps({"method": method}, separators=(",", ":")) + "\n")
```

### CORRECCAO DE ROTULO. Patch de IL num DLL da OutSystems via Mono.Cecil. O achado marcou comoFoiObtido=reflection: ERRADO. Mono.Cecil reescreve IL em disco (AssemblyDefinition.ReadAssembly / il.InsertBe

`runtime` · obtido por `trace-ou-interposicao`

**Ficheiro:** `C:\Users\andre\GitSSAM\ss-patcher\InjectDiag\Program.cs:169-175 (citacao exacta; ha um segundo ponto identico em 152-153 para re-patch a partir do backup); C:\Users\andre\GitSSAM\ss-patcher\SETUP_GUIDE.md:28-51 (os tres ficheiros) e 258-266 (gotchas); C:\Users\andre\GitSSAM\open_odc1.ps1:299-310 (deploy elevado + ForceCloseODC, confirmado)`

**Resolve:** binario velho (15); saber o que a plataforma permite (22)

**Como se aproveita:** NAO levar para o Anvil. Serve como requisito: o canal para o Studio e substituivel e o binario carregado pode nao ser o que se pensa, logo o bridge_manifest e obrigatorio antes de trabalhar. ATENCAO A UMA CONTRADICAO INTERNA DO ACHADO: a lista dos 'tres ficheiros' inclui WebViewControl.Avalonia.dll, cujo unico proposito, segundo o proprio SETUP_GUIDE (linhas 35-37), e expor CDP em 9222 -- exactamente o caminho que o mesmo relatorio declara morto e que o grep confirma morto (2 linhas em todo o ssam_agent_runtime, ambas comentario). Para o runner actual bastam DOIS ficheiros mais o deps.json. Documentar tres e perpetuar um passo inutil.

**Caminho nativo:** por apurar -- e a citacao tem um erro de caminho. v1-interfaces.txt NAO esta em C:\Users\andre\ODC3\decompiled\v1\; esta em C:\Users\andre\ODC3\decompiled\v1-interfaces.txt. As linhas 572-588 desse ficheiro real confirmam-se palavra por palavra (IModelPlugin, IModelPluginDescriptor, ... UI.Mobile.ITheme). IExtendedModelServices.OnResolveModelPlugin confirma-se em v1\OutSystems.Model.V1.decompiled.cs:2605 (o achado disse 2602-2606) MAS o achado omitiu o essencial: a interface e `internal interface IExtendedModelServices`, nao publica. A conclusao 'por apurar' mantem-se certa: nao ha hook nativo de arranque de processo.

**O que sobra se se deitar a implementacao fora:** Os ficheiros que tem de estar coerentes (SSDiagnostics.dll + ServiceStudio.WebViewImplementation.dll patchado + deps.json; o terceiro so serve o CDP morto) e o facto de a auto-update da OutSystems reverter tudo -- dai o alvo ter de provar o binario antes de correr.

```
il.InsertBefore(firstInstruction, il.Create(OpCodes.Ldc_I4, PORT));
il.InsertBefore(firstInstruction, il.Create(OpCodes.Call, startServerRef));
```

### Reflection sobre instancias vivas no SSModelHandler.cs. TODOS os numeros do achado batem certo ao contador: 45.655 linhas, 2.175.291 bytes, GetProperty( 667, GetMethod( 249, BindingFlags 232, .Invoke(

`runtime` · obtido por `reflection`

**Ficheiro:** `C:\Users\andre\GitSSAM\ss-patcher\SSDiagnostics\SSModelHandler.cs:18-25 (sumario + BindingFlags); 55-95 (ListOpenModules navega Aggregators/SelectedTopLevelPresenter/HasOpenedActiveESpace/InstanceId por GetProperty -- confirmado linha a linha)`

**Resolve:** inspect: tamanho e filtro (87); complexidade da saida (63)

**Como se aproveita:** Para o kernel do Anvil vai o VOCABULARIO, nao o acesso: Aggregators, SelectedTopLevelPresenter, HasOpenedActiveESpace, InstanceId. Confirmei que sao esses os nomes reais usados contra o modelo vivo. Devem virar contrato de dados declarativo; a travessia por GetProperty fica na bridge e nunca e replicada.

**Caminho nativo:** Parcialmente confirmado, com uma correccao importante. IModelServices E publica: `public interface IModelServices` em v1\OutSystems.Model.V1.decompiled.cs:2892 e em o11\OutSystems.Model.V1\OutSystems.Model\IModelServices.cs:9-27 (LoadSolution/CreateApplication/LoadApplication confirmados). MAIS FORTE do que o achado disse: existe tambem odc\OutSystems.Model.V1\OutSystems.Model\IModelServices.cs, ou seja ha versao ODC e nao so O11. MAS ICommandServices NAO e publica: e `internal interface ICommandServices : IService` nos TRES sitios (v1 decompiled:1571; o11\...\ICommandServices.cs:6; odc\...\ICommandServices.cs:6). Apresenta-la como 'API versionada' disponivel e enganador -- de fora so se chega la por reflection ou InternalsVisibleTo. A ressalva honesta do achado (V1 nao cobre 'o modulo aberto no separador activo') mantem-se valida.

**O que sobra se se deitar a implementacao fora:** O dicionario de nomes do modelo e o facto de existir IModelServices publica e versionada em AMBOS os sabores -- que sozinho muda a pergunta de 'como alcanco isto por reflection?' para 'isto ja existe em V1?'. E a nota de que ICommandServices, embora exista, e internal.

```
/// Accesses the SS internal object model via reflection on live instances.
/// Provides module structure queries and programmatic navigation.
/// </summary>
internal static partial class SSModelHandler
{
    private const BindingFlags AllInstance = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;
```

### CORRECCAO DE ROTULO + CAMINHO NATIVO REFORCADO. A mutacao entra por CommandExtensions.SilentExecute (correcto), mas o CommandResult e fabricado por Activator.CreateInstance e preenchido por varrimento

`runtime` · obtido por `reflection`

**Ficheiro:** `C:\Users\andre\GitSSAM\ss-patcher\SSDiagnostics\SSModelHandler.cs:3821-3910 (bloco ODC_MODE; ModifyModel declarado em 3649, confirmado). O varrimento de propriedades vai de 3873 ate depois de 3904.`

**Resolve:** nao destruir intencao (24); erros que nao ensinam (52)

**Como se aproveita:** Regra dura para o kernel do Anvil, e esta sobrevive intacta: TODA a mutacao entra por um scope de comando do Studio, nunca por escrita directa em propriedades. E o kernel pede o resultado a fabrica do host em vez de o construir. UMA RESSALVA QUE O ACHADO NAO FEZ: o SSDiagnostics.csproj nao referencia NENHUM assembly da OutSystems (so Avalonia, Lib.Harmony e SSDiagnostics.TraditionalWeb), por isso 'chamar CommandResult.Open' nunca pode ser uma chamada compilada -- sera sempre um invoke reflexivo. O ganho real e trocar ~40 linhas de Activator + varrimento por UM invoke de fabrica, o que continua a ser o conserto certo, mas nao e 'uma linha'.

**Caminho nativo:** CONFIRMADO E MAIS FORTE do que o achado alegou. Nao verifiquei apenas um call site: abri a propria classe. C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model\OutSystems.Model.Commands\CommandResult.cs:12 declara `public class CommandResult`, com as fabricas estaticas publicas: Open(AbstractObject) linha 145, OpenNew 155, Select(IObject) 211, PutCaretAfterWidget 226, SelectNew 236, mais ~25 sobrecargas. O call site citado pelo achado tambem confere: odc\ServiceStudio.Presenter\ServiceStudio.Presenter.Commands\DataSetSmartAssistantCommands.cs:157-161 usa targetPresenter.SilentExecute(..., delegate { ...; return CommandResult.Open(...); }).

**O que sobra se se deitar a implementacao fora:** Dois factos grandes e verdadeiros: (1) a mutacao tem de correr dentro de um command scope do Studio; (2) ODC renomeou Command.Execute(PresenterContext,...) para CommandExtensions.SilentExecute(IPresenter,...) -- a 'diferenca que nao e diferenca' outra vez. Mais o terceiro que eu apurei: o tipo de retorno tem fabrica publica com nome, nao precisa de ser inventado.

```
// ODC mode — use Command.SilentExecute(IPresenter, string, string, Func<CommandResult>)
// ODC Studio replaced Command.Execute(PresenterContext,...) with SilentExecute(IPresenter,...)
...
// CommandResult is a class (not enum) — create an empty instance as return value
object? successValue = null;
try { successValue = Activator.CreateInstance(cmdResultType); } catch { }
...
// Initialize ALL collection/reference properties on CommandResult to prevent
// NullReferenceException in AggregatorPresenter.HandleCommandComplete
```

### Tracer dinamico por Harmony: patcha metodos do Studio em runtime para capturar assinatura, argumentos, retornos e duracao, com modo transpiler para hot paths. Citacao exacta. E o instrumento com que o

`runtime` · obtido por `trace-ou-interposicao`

**Ficheiro:** `C:\Users\andre\GitSSAM\ss-patcher\SSDiagnostics\TraceHandler.cs:16-20 (sumario) e 54-62 (modo transpiler); C:\Users\andre\GitSSAM\ss-patcher\SSDiagnostics\SSDiagnostics.csproj:60 (PackageReference Lib.Harmony -- o achado disse 59-61) e 64-85 (comentario + Target CopyHarmonyToOutput)`

**Resolve:** saber o que a plataforma permite (22); erros que nao ensinam (52)

**Como se aproveita:** NAO vai para o kernel como mecanismo. Vai como ferramenta de descoberta isolada e desligavel, e como documento. Confirmei o ponto que torna isto credivel: o csproj lista SO tres dependencias (Avalonia.Desktop, Lib.Harmony, SSDiagnostics.TraditionalWeb) e nenhuma e da OutSystems -- ou seja, tudo o que o SSAM sabe do Studio foi obtido em runtime, nunca por contrato compilado. Isso valida o aviso do dono na sua forma mais forte: nao ha uma unica linha deste DLL que fale com o Studio por tipo conhecido em tempo de compilacao.

**Caminho nativo:** Nao aplicavel: um tracer nao tem equivalente nativo. O ponto e que trace e fase de investigacao; o codigo tracado deve virar chamada directa assim que o nome certo e conhecido.

**O que sobra se se deitar a implementacao fora:** Tudo o que o trace produziu, e o facto operacional caro que o comentario do csproj guarda: sem 0Harmony.dll o trace falha em SILENCIO e as funcionalidades dependentes falham sem dizer porque.

```
/// Dynamic method tracer using Harmony.
/// Patches methods at runtime based on namespace/type/method patterns.
/// Captures full call info: signature, arguments (with deep SS object inspection), return values, duration.
```

### O PIOR CAMINHO, CONFIRMADO: Harmony a mentir ao Studio sobre o clipboard do Windows. Prefixo em ServiceStudio.WebViewImplementation.Clipboard.GetClipboardOmlData() que devolve bytes proprios e corta o

`runtime` · obtido por `trace-ou-interposicao`

**Ficheiro:** `C:\Users\andre\GitSSAM\ss-patcher\SSDiagnostics\SSModelHandler.cs:5809-5859 (EnsureNativeClipboardOmlDataPatch + NativeClipboardGetClipboardOmlDataPrefix)`

**Resolve:** nao destruir intencao (24)

**Como se aproveita:** Regra negativa no kernel do Anvil: nenhuma operacao pode alterar estado global da maquina do utilizador (clipboard, foco, registry) para conseguir o seu efeito. E o argumento 'nao havia outra maneira' cai: o caminho alternativo esta no MESMO ficheiro, linhas 5601-5622, onde DeserializeInto e resolvido e invocado directamente com os bytes por argumento.

**Caminho nativo:** REAL, mas a ASSINATURA QUE O ACHADO DEU ESTA ERRADA e ele atribuiu-a ao Studio decompilado sem a ter la lido. O achado escreveu 'ClipboardManager.DeserializeInto(byte[], IPasteTarget, ICommandTarget, IPresenter)' -- esse texto nao vem do decompilado, vem da mensagem de erro do proprio SSAM (SSModelHandler.cs:5615). No decompilado ha UMA sobrecarga: C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model\OutSystems.Model.CopyPaste\ClipboardManager.cs:1338 -- `public static IEnumerable<AbstractObject> DeserializeInto(byte[] bytes, IPasteTarget target, ICommandTarget originalTarget, ShouldDeserializeObjectHandler shouldDeserialize)`. O quarto parametro e um DELEGATE de decisao, nao um IPresenter. O resto confirma-se: ClipboardManager e `public sealed class` (linha 35) com `public static byte[] Serialize(...)` (linha 1144). Na V1, Serialize/DeserializeInto existem em ICommandServices.cs:16-18 tal e qual o achado citou, MAS essa interface e `internal`, o que o achado nao disse.

**O que sobra se se deitar a implementacao fora:** O facto que apaga a necessidade do patch: copiar/colar artefactos do Studio e serializacao de bytes (fragmento OML), nao interaccao de GUI. Esse facto sobrevive mesmo com a assinatura corrigida.

```
var getOmlData = clipboardType.GetMethods(AllInstance)
    .FirstOrDefault(m => m.Name == "GetClipboardOmlData"
...
_nativeClipboardHarmony = new HarmonyLib.Harmony("ssam.native.clipboard.override");
_nativeClipboardHarmony.Patch(getOmlData, prefix: new HarmonyLib.HarmonyMethod(prefix));
...
private static bool NativeClipboardGetClipboardOmlDataPrefix(ref byte[] __result)
{
    var bytes = _nativeClipboardOverrideBytes;
    if (bytes == null || bytes.Length == 0)
        return true;
    __result = bytes.ToArray();
    return false;
```

### O doctor fala por GUI quando o modelo nao chega: Ctrl+Z em ciclo ate o UndoManager sair de nested, e WM_CLOSE contra um HWND exacto. Citacao verbatim e a impressao digital de evidencia confirmada camp

`runtime` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam_agent_runtime\doctor_target.py:244-277 (_fix_undo) e 323-379 (_exact_close_request/_close_dialog); a reflection sobre o UndoManager esta em C:\Users\andre\GitSSAM\ss-patcher\SSDiagnostics\SSModelHandler.cs:17684-17705`

**Resolve:** erros que nao ensinam (52); portao independente (46)

**Como se aproveita:** O que se aproveita nao e o press_key: e a disciplina de evidencia. Verifiquei o _exact_close_request e ele exige mesmo, com raise em caso de falha: hwnd, ownerHwnd, titulo nao vazio, evidenceVersion inteiro >= 2, ownerEnabled estritamente False, candidateReason == 'owned_window_owner_disabled' e classification == CONFIRMED_MODAL; e _close_dialog recusa fechar se o HWND mudou ('dialog HWND changed before close'). Esse padrao -- agir so sobre o alvo exacto reconfirmado, nunca sobre um homonimo -- deve ser contrato geral do kernel do Anvil.

**Caminho nativo:** APURADO (o achado deixou 'por apurar'; a busca custou uma leitura). C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model\ServiceStudio.Undo\UndoManager.cs:39 declara `public static class UndoManager`, com `public static void Undo(IBaseTopLevelPresenter aggregator, int count = 1)` na linha 897, CanUndo na 1319, GetUndoCount na 1440 e GetCommandRepeatIdOfLastCommand na 1456. O equivalente O11 esta em o11\ServiceStudio.Framework\ServiceStudio.Undo\UndoManager.cs:688/999/1094/1110. O decisivo: o SSDiagnostics JA invoca reflexivamente um estatico desta mesma classe com exactamente esta forma de argumento (GetCommandRepeatIdOfLastCommand com o aggregator, SSModelHandler.cs:17689-17702). Substituir Ctrl+Z por Undo(aggregator, 1) e o MESMO invoke que ja existe no ficheiro, com outro nome de metodo. A assimetria ler-nativo/corrigir-por-teclado nao tem desculpa tecnica.

**O que sobra se se deitar a implementacao fora:** A impressao digital de 6 campos para identificar um modal verdadeiro (o owner desactivado e a prova, o titulo nao e); o facto de o UndoManager poder entrar em 'nested' e bloquear tudo a jusante; e agora a assinatura exacta do desfazer nativo.

```
def _fix_undo(port: int) -> bool:
    """Ctrl+Z ate o UndoManager sair do estado nested (padrao do
    _recovery.fix_undo_corruption, via cliente cru)."""
...
            c.call("press_key", key="z", modifiers="control")
```

### DIFERENCA-ENTRE-FAIXAS REAL E A MELHOR DESTA AREA, agora com a contraprova que faltava: numa App ODC a propriedade Public de uma Server Action e recusada; numa Library ODC e forcada a true. Fui ao dum

`migracao` · obtido por `trace-ou-interposicao`

**Ficheiro:** `Medicao viva: C:\Users\andre\GitSSAM\docs\tasks\2026-05-10-odc-signatures-compatibility.md:381-385 (entrada 67, `ss.server_action`, marcada 'Incompatible (partial)'). Binario ODC: C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model\ServiceStudio.Model\Flows.cs:26090-26097 e :26099-26110 e :12833-12844; nomes em OutSystems.Model.V1\OutSystems.Model.ModelFeatures\ModelFeatures.cs:704-706. Ausencia no O11: nenhuma ocorrencia em C:\Users\andre\ODC3\decompiled\o11`

**Resolve:** saber o que a plataforma permite (22); erros que nao ensinam (52); portao independente (46)

**Como se aproveita:** Item novo no NAO-DA (`diferenca-entre-faixas`) e correccao ao item 'Public / Shareable' (NAO-DA.md:198-219), que hoje afirma a letra que `set Public true` "continua a ser o que compila nas duas faixas". Mas o achado original subvende o estrago: contei os jobs do Anvil que fazem exactamente essa escrita sobre um IServerAction criado em @espace -- sao DOZE ficheiros verdes hoje (aggregate-full.json:29, delete-data-consumers.json:39, delete-logic-consumers.json:23, exception-lifecycle.json:19 e :37, expression-literals.json:28, logic-comment-connector.json:7, rename-data-propagation.json:22, rest-consume-call.json:34, rest-consume-lifecycle.json:34, rest-query-nested.json:44, structure-list-type.json:8, structure-nested.json:58, switch-exception-handler.json:8). Nao e um _why num job: e um varrimento.

**Caminho nativo:** PARCIALMENTE POR APURAR -- e aqui que corrijo o achado original, que dizia 'o caminho nativo e MAIS SIMPLES: le-se a flag IsLibraryEspace e a ModelFeature, sem tenant'. Nao se le. A cadeia acaba em `ModelFeaturesExtensions.CanBeUsedInTool(...)` (chamada em ServiceStudio.ModelFeatures\ModelFeatures.cs:789), que vive no assembly OutSystems.MetaModel -- e OutSystems.MetaModel NAO esta decompilado (as pastas do dump odc sao OutSystems.Model, OutSystems.Model.Definition, OutSystems.Model.V1, ServiceStudio.BuiltInBehaviors, ServiceStudio.Presenter, ServiceStudio.ServerCommunications.Phoenix). Headless nao se decide o valor a partir do dump: apura-se a ESTRUTURA do gate, nao o resultado.

**O que sobra se se deitar a implementacao fora:** O facto e o par de nomes e a assimetria, nao a corrida: numa App ODC a Server Action nao pode ser Public; numa Library e sempre Public, forcada no OnAfterInit. Deitando fora a sonda viva, o binario prova a ESTRUTURA sozinho; o VALOR so com ambiente.

```
Doc, entrada 67 literal: "The same signature path with `public=True` created UserAction key `SPQurvLaeEq9JqNA0PEr3w` but TrueChange reported `Invalid app`: `Public Property of a Server Action within an App` is not supported in this ODC version." Binario, Flows.cs:26102-26109 literal: `if (base.OwnerESpace.IsLibraryEspace) { Public = true; } else if (!ServiceStudio.ModelFeatures.ModelFeatures.ServerActionPublicPropertyApp.CanBeUsedInServerAndServiceStudio(base.OwnerESpace)) { Public = false; }`. Nomes, ModelFeatures.cs:704: `public const string ServerActionPublicPropertyApp = "Public Property of a Server Action within an App";`
```

### Block sem output param e Decision com connectors: as duas citacoes sao literais, mas a citacao CRUZADA esta errada -- NAO-DA.md:252 nao fala de block-events, fala de IEndNode e ModelFactory

`migracao` · obtido por `trace-ou-interposicao`

**Ficheiro:** `C:\Users\andre\GitSSAM\docs\tasks\2026-05-10-odc-signatures-compatibility.md:2073 (entrada 404) e :2083 (entrada 406). Jobs reais: C:\Users\andre\Anvil\tests\jobs-odc\block-events.json, block-events-nested.json, block-events-types.json, block-events-mandatory.json, block-events-two-instances.json, block-event-lifecycle.json (seis, nao cinco). Citacoes reais no NAO-DA: :254 e :1069`

**Resolve:** complexidade da saida (63); erros que nao ensinam (52)

**Como se aproveita:** O (a) ja aterrou. O (b) NAO deve ser importado como facto do ODC: a propria entrada 404 fala de 'this WebBlock model' e 'Reactive O11 blocks', ou seja e uma medicao da faixa O11 usada para descrever o ODC, e a entrada 406 diz-se a si propria travada pelo builder do SDK e nao pela plataforma. Correccao de citacao obrigatoria antes de qualquer importacao: NAO-DA.md:252 nao suporta a afirmacao; :254 cita block-events.json e :1069 cita block-events-mandatory.json.

**Caminho nativo:** (a) Ja em producao no Anvil -- os seis ficheiros existem, confirmei por listagem. (b) IDecisionNode existe mesmo no dump ODC (ServiceStudio.Model\BusinessProcesses.cs:55 e :170-191), mas com a ModelFeature Process em estado Removed isso e mais um caso de superficie-sem-funcionalidade, nao um caminho.

**O que sobra se se deitar a implementacao fora:** As duas notas, que sao raras neste ficheiro por ENSINAREM a alternativa em vez de so declararem incompatibilidade. Sao o molde do que uma mensagem de erro do kernel devia parecer.

```
Entrada 404 literal: "blk.output_param() is not supported by this WebBlock model. Reactive O11 blocks expose input parameters and block events; create a block event with output arguments instead of a block output parameter. The SDK stopped before creating any local variable so the module is unchanged." Entrada 406 literal: "proc.decision(...) is not supported by the declarative builder yet. Native BPT Decisions require explicit branch connectors created with IDecisionNode.CreateConnector(name, target), while the current proc.decision(label, condition) signature has no branch targets and creates an invalid process flow."
```

### Chamadas venenosas: confirmado a letra nas duas pontas -- o cabecalho do ficheiro manda mesmo nao voltar a sondar, e a entrada 41 regista mesmo que a sessao ficou morta ate reiniciar elevado

`migracao` · obtido por `trace-ou-interposicao`

**Ficheiro:** `C:\Users\andre\GitSSAM\docs\tasks\2026-05-10-odc-signatures-compatibility.md:5 (cabecalho) e :253 (entrada 41). Alternativa: C:\Users\andre\Anvil\tests\jobs-odc\aggregate-full.json:100. Item irmao: C:\Users\andre\Anvil\docs\NAO-DA.md:1120`

**Resolve:** portao independente (46); binario velho (15); handoff/registo (60)

**Como se aproveita:** Ponte do SSAM-Hybrid-ODC: lista negra explicita destas chamadas e redireccionamento para a op `usages` do kernel. Vale sobretudo o corolario que o achado original ja tira e que subscrevo: numa corrida sequencial de 461 entradas sobre UI viva, os resultados a JUSANTE de uma sonda venenosa ficam todos suspeitos -- e o ficheiro nao marca quais foram.

**Caminho nativo:** A op `usages` do Anvil sobre a API nativa faz o mesmo trabalho sem UI -- confirmado no ficheiro. O item NAO-DA.md:1120 chama-se mesmo 'Consumidores (Referrers) e endereco textual' e esta marcado CONFIRMADO, com IModelObject.cs:28 `IEnumerable<IModelObject> Referrers { get; }`.

**O que sobra se se deitar a implementacao fora:** O facto operacional e o padrao: automacao de UI nao tem isolamento entre testes; uma suite de jobs headless com processo por job tem.

```
Cabecalho, linha 5 literal: "NAO re-probar impact_analysis/find_usages_in_all_modules (pendura a UI)." Entrada 41, linha 253 literal: "It timed out after 30s on `find_usages_in_all_modules`; subsequent UI-thread calls such as `get_active_module` and `open_module` also timed out until ODC1 was restarted elevated." Alternativa, aggregate-full.json:100: `{"op": "usages", "target": "$WfAggOrderItem.Qty", "_why": "o atributo do lado direito e consumido pela agregacao Sum: o join nao e decoracao"}`
```

### O ratchet: as citacoes estao todas literais e confirmei que CORRE mesmo (ss.py:8893 chama evaluate_warning_ratchet). Mas o `comoFoiObtido: api-nativa-do-modelo` esta ERRADO e e o segundo caso mais gra

`boas-praticas` · obtido por `reflection`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam-declarative\ssam_declarative\_warning_ratchet.py:1-8 (docstring), :35-38 (_MESSAGE_ID_PREFIX_RE), :262-274 (warning_rule_id), :277-287 (warning_fingerprint), :457-465 (recusa de wildcard); consumidor em C:\Users\andre\GitSSAM\ssam-declarative\ssam_declarative\ss.py:8846 e :8893`

**Resolve:** portao independente (46) e binario velho (15).

**Como se aproveita:** Kernel do Anvil: adoptar o CONCEITO (baseline -> delta -> allowlist exacta, sem wildcard) e os 5 campos do fingerprint. NAO adoptar a extraccao: o id deve chegar como campo tipado, nunca por regex sobre um ToString(). Uma pequena nota a favor do ficheiro: a recusa de wildcard e deliberadamente so para selectores com menos de 4 pipes, porque um fingerprint completo pode conter '*' literal no detail -- isso esta bem pensado e documentado no proprio codigo.

**Caminho nativo:** A tabela estatica do .resx substitui a parte de classificacao (id -> severidade, categoria) sem reflection nenhuma. A parte que NAO tem caminho nativo e a leitura viva dos warnings do Studio: por apurar se existe canal sem reflection; na faixa ODC o equivalente nativo e a REST /findings + /patterns.

**O que sobra se se deitar a implementacao fora:** Duas ideias que valem sozinhas: (1) divida pre-existente nao e licenca para mais; (2) a identidade de um warning e (rule_id, type, objectKey, propertyName, detail) e suprimir por wildcard e sempre uma fuga. Ambas sobrevivem a deitar fora toda a implementacao.

```
_warning_ratchet.py:35-38 -- "_MESSAGE_ID_PREFIX_RE = re.compile(\n    r\"MessageID\\s*:\\s*([A-Za-z][\\w.]*)\",\n    re.I,\n)" /// :262-267 -- "def warning_rule_id(message: Mapping[str, Any]) -> str:\n    for key in (\"sourceId\", \"messageId\"):\n        value = _text(message, key)\n        match = _MESSAGE_ID_PREFIX_RE.search(value)\n        if match:\n            return match.group(1)" /// :461-465 -- "    if any(\n        (\"*\" in item or \"?\" in item) and item.count(\"|\") < 4\n        for item in accepted\n    ):\n        raise ValueError(\"warning allowlist entries must be exact; wildcard entries are forbidden\")"
```

## So documento -- nada o impoe

### A auditoria que apanharia a divergencia dos dois SIGNATURES.md existe, daria FAILED hoje, e nao esta em nenhum gate de CI. CORRECCAO ao achado: ele diz que e "chamada so em registry.py:291" -- e falso

`capabilities` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam_stability\surface_audit.py:106-144; chamadas em ssam_stability\registry.py:291 e ssam_stability\tests\test_surface_audit.py:43-57; gates em ssam_agent_runtime\ci_gates.py:42-113; workflow .github\workflows\ssam-agent-runtime.yml`

**Resolve:** portao independente (46): um portao que ninguem abre nao e portao.

**Como se aproveita:** Anvil: um gate so conta se estiver na lista que o CI corre, E se correr contra o artefacto real e nao contra uma fixture. Este caso ensina as duas metades: ha teste, ha codigo de auditoria, e mesmo assim a divergencia real passa. Inventariar verificacoes orfas antes de escrever verificacoes novas.

**Caminho nativo:** Nao aplicavel -- e questao de ligacao. O CI tem 3 jobs; corre ssam_agent_runtime/tests inteiro e exactamente 7 ficheiros escolhidos de ssam-declarative/tests; ssam_stability/tests nao corre de todo.

**O que sobra se se deitar a implementacao fora:** O padrao "verificacao orfa", agora com duas variantes: (a) codigo escrito e nunca ligado; (b) codigo ligado a um teste que so exercita fixtures e por isso nunca fica vermelho com dados reais. A segunda e mais perigosa porque parece cobertura.

```
surface_audit.py:126-136 -- "primary_hash = sha256_file(primary)\n    mirror_hash = sha256_file(mirror) if mirror.is_file() else None\n    return {... \"status\": \"failed\" if collisions or mirror_hash != primary_hash else \"passed\", ... \"sourcesMatch\": mirror_hash == primary_hash," | hashes reais medidos: B4A719C3... != 92854515... logo status=failed hoje | test_surface_audit.py:44-51 -- "root = tmp_path / \"repo\" ... mirror.write_text(\"different\", encoding=\"utf-8\")" (fixture, nao o repo real) | ci_gates.py:49-112: as checks sao capability_accounting_has_no_real_gaps, normalizer_registry_has_no_gap_statuses, high_risk_methods_are_registered, normalizer_registry_matches_signatures, _registry_tracking_fields_check, logic_ir_production_coverage_registry_is_current, compatibility_ledger_is_current, _experimental_surface_check, _llm_mistake_corpus_check, _logic_ir_fast_suites_check -- nenhuma de integridade da superficie
```

### VEREDICTO SOBRE OS ACHADOS 11 e 12 (routing_ambiguity e permission_matrix): SOBREVIVEM. As duas citacoes estao literais (com uma linha de desvio no segundo: a frase citada como :14 esta em :13). Os 9 

`mistakes` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\llm_mistakes\routing_ambiguity.json:45,54; C:\Users\andre\GitSSAM\llm_mistakes\permission_matrix_sources.json:13`

**Resolve:** nao destruir intencao

**Como se aproveita:** Ficam no SSAM-Hybrid-ODC. A regra transferivel que o achado destaca aguenta-se e vale a promocao: contexto citado pelo utilizador (nomes de ecra, verbos de negocio, negacoes) descreve o REQUISITO e nao autoriza a mutacao.

**Caminho nativo:** nao se aplica -- nao ha facto de plataforma por baixo de nenhum dos dois. Confirmo que o Anvil nao tem router de intencao, logo nao ha equivalente nativo a procurar.

**O que sobra se se deitar a implementacao fora:** Uma regra so, e e essa. De permission_matrix nao sobra nada de plataforma, so o residuo negativo: uma heuristica de gerador ganha estatuto de facto quando o esquema nao tem onde as separar.

```
routing_ambiguity.json:54 -- `"expected": "Route to ssam.data.structure_types; existing service actions and negated cleanup words are context, not permission to create/delete public actions"`. permission_matrix_sources.json:13 -- `"expected": "ERROR during script validation; permission matrices need feature/permission data sources and checkboxes"`.
```

### CONFIRMADO. O SSAMQualityGate e um slash-command de 88 linhas, nao um gate: so corre se alguem o invocar e o veredito e auto-avaliacao do LLM em formato de texto. A regra final existe nas linhas 86-88

`regras` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\.claude\commands\SSAMQualityGate.md (3914 bytes, 88 linhas; checklist ao vivo L60-67, formato L69-84, regra final L86-88)`

**Resolve:** erros que nao ensinam 52 | complexidade da saida 63 | handoff/registo 60

**Como se aproveita:** Documento (o vocabulario) + kernel (converter cada item verificavel num check do `ci`). Nao portar o formato de auto-avaliacao: um LLM a dar-se APROVADO nao e prova.

**Caminho nativo:** O equivalente nativo ja existe no mesmo repositorio e e o `ci` (ci_gates.py): verificar programaticamente o que o checklist pergunta em prosa. O proprio checklist pede isso -- 'existe inventario programatico de metodos publicos cobertos?' -- e a resposta e sim, chama-se coverage/normalizer-coverage.

**O que sobra se se deitar a implementacao fora:** O checklist como VOCABULARIO de qualidade e bom e portavel: building blocks reutilizaveis em vez de receitas pontuais; a regra transversal mora num contrato central; tolerancia a entradas imperfeitas de LLM quando a intencao e inequivoca e, quando nao da para corrigir, o erro diz o valor errado + o formato esperado + sugestoes LITERAIS; e o formato de resposta com campos fixos SIM/NAO + evidencia curta em vez de prosa. Os sete campos sao a propria lista: BUILDING_BLOCKS, PYTHON_IDIOMATICO, DOCSTRINGS_LLM_FRIENDLY, TOLERANCIA_E_DIAGNOSTICO, TODOS_OS_METODOS_NO_ESCOPO, TESTES_AUTOMATIZADOS, TESTE_AO_VIVO_SS.

```
L86-88 literal: "Regra final: se `TESTE_AO_VIVO_SS` for NAO, o veredito e sempre BLOQUEADO para\ntarefas que alteram comportamento do SSAM ou criam/modificam artefatos no\nService Studio."
L80-83: "TESTE_AO_VIVO_SS: SIM/NAO - modulo, script/action/tela, publish/errors\n\nVEREDITO: APROVADO/BLOQUEADO\nPROXIMA_ACAO: <se bloqueado, executar o item faltante; se aprovado, entregar>"
```

### CONFIRMADO, citacao exacta. SSAM_VISION.md diz mesmo, nas linhas 9-11, que o SSAM nao e um compilador declarativo, e nas 49-53 que os builders sao atalhos e nao abstraccoes. Os dois documentos estao m

`declarative` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam-declarative\SSAM_VISION.md:9-11 e :49-53`

**Resolve:** saber o que a plataforma permite 22; handoff/registo 60

**Como se aproveita:** Documento e decisao de autoria, tal como ele disse. Acrescento o contexto que ele nao deu: a mesma pagina, na linha 36, declara "O SSAM ja e 80% completo", e as duas pecas que a propria visao diz faltarem (preview layer e widget reference) sao as que a linha 33-34 marca com <- FALTA. Quem herdar a doutrina deve herdar tambem esta auto-avaliacao, porque ela e o que justifica arquivar o DECLARATIVE_COMPILER.md em vez de o implementar.

**Caminho nativo:** A propria visao declara o caminho: builders como atalhos sobre as mesmas operacoes do Service Studio. Confirmei que isso e o que o Anvil faz por construcao (ModelApiMetadata.cs:64-65 restringe a superficie aos namespaces do modelo).

**O que sobra se se deitar a implementacao fora:** A regra de arquitectura citada, e o criterio derivado: uma op declarativa nova so entra no kernel se puder ser reescrita como sequencia de verbos crus equivalentes. Se nao puder, e abstraccao, nao atalho.

```
"Nao e um framework com padroes pre-construidos.\nNao e um compilador declarativo.\nNao e uma camada de abstracao que esconde o OutSystems." (:9-11) e "Os builders (`ss.entity()`, `ss.screen()`, `ss.server_action()`) sao\n**atalhos de produtividade**, nao abstracoes. Por baixo eles chamam as mesmas\noperacoes que o Service Studio executa." (:49-51)
```

### CONFIRMADO, e a lista de campos que ele deu esta certa mas incompleta. LoweringContractSpec (:59-74) tem os 12 campos que ele nomeou mais tres que ele omitiu e que sao os que decidem o comportamento: 

`declarative` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam-declarative\ssam_declarative\lowering_contracts.py:1-14, :59-98, :228-260 (1080 linhas)`

**Resolve:** saber o que a plataforma permite 22; erros que nao ensinam 52

**Como se aproveita:** Kernel do Anvil: o FORMATO, exactamente como ele propos, e esta e a parte mais forte do achado dele. Quando o Anvil recusar uma op deve devolver a linha da tabela -- familia, porque nao da, o que fazer em vez disso -- em vez de "nao suportado". Acrescento o aviso do proprio ficheiro (:9-13): esta tabela e sobre IR gerado pelo compilador, NAO sobre copiar artefactos que ja existem num Studio aberto; quem herdar o formato tem de herdar tambem essa fronteira, senao promete o que a tabela nao cobre.

**Caminho nativo:** O contrato em si e reaproveitavel tal e qual -- dict de dataclasses, zero reflection, zero IO. Nao precisa de caminho nativo porque nao toca na plataforma.

**O que sobra se se deitar a implementacao fora:** O modelo de dados da capacidade, agora completo: ir_kind, family, supported_shapes, required_symbols, emitted_symbols, target_tree, native_builders, roundtrip_validator, post_paste_inspector, o11_status, odc_status, fallback_policy, compiler_policy, product_matrix (com rota origem->destino, estado, descricao e ficheiros de evidencia), evidence. E a regra de falhar alto: familia sem contrato falha ruidosamente, nunca cai em silencio para o incremental.

```
"The clipboard compiler is deliberately conservative: every artifact family\nneeds an explicit contract before it can emit a native paste payload. Families\nwithout a native-paste contract may still be represented in IR and routed to\nincremental builders, but they must fail loudly when asked for clipboard\nlowering." (:3-7) e "Important: this module describes compatibility of **compiler-generated IR\npayloads**. It is not the contract for copying artifacts that already exist in\nan open Studio." (:9-11)
```

### ATAQUE PASSOU E O NÚMERO ERA CONSERVADOR. Confirmei o catálogo: 152 números-base + 13 sub-itens (7b,9b,27b,35b,37b,42b,53b,56b,96b,107b,117b,126b,150b) = 165 entradas numeradas, contadas por regex sob

`friccoes` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\docs\tasks\2026-09-03-friccoes-ssam-kkr-time-entry.md (248 linhas confirmadas; resumo :149; última entrada numerada #152 em :246). Contra-totais: C:\Users\andre\GitSSAM\docs\tasks\2026-09-03-achados-ssam-kkr-time-entry.md:7 E :17 (os dois, no mesmo ficheiro) e C:\Users\andre\GitSSAM\docs\tasks\2026-09-07-ondas-1-4-kkr-fixes-implementadas.md:4`

**Resolve:** handoff/registo (60)

**Como se aproveita:** Documento + regra dura no kernel do Anvil: o total de um catálogo é CALCULADO do ficheiro, nunca escrito à mão, e cada entrada tem estado (aberto/fechado/refutado) que só muda com citação de código. O formato por linha (hora | categoria | o que aconteceu | evidência | custo) copia-se tal e qual — é o que torna cada entrada atacável isoladamente, e foi o que me deixou contar por regex em segundos. A auto-contradição dentro do achados.md prova o ponto melhor do que a divergência entre ficheiros: um resumo escrito à mão apodrece mesmo sem ninguém lhe mexer.

**Caminho nativo:** nao se aplica — é disciplina de catálogo, não caminho de plataforma

**O que sobra se se deitar a implementacao fora:** O formato da linha é excelente e portável. O que se deita fora é o resumo manual. Regra: um catálogo sem total calculado e sem estado por entrada é um diário, e um diário não se pode fechar.

```
Resumo, :149: "**Entradas:** 98 fricções numeradas (algumas com sub-itens: 7b, 9b, 27b, 35b, 37b, 42b, 53b, 56b, 96b) + 12 medições." Mas :246 é "| 152 | 01:36 | GAP | Apagar um WIDGET de tela é impossível pela superfície pública". Auto-contradição no achados.md — :7 "`docs/tasks/2026-09-03-friccoes-ssam-kkr-time-entry.md` (98 fricções + 12 medições)." contra :17 "| Fricções registradas | 137 — BUG 62 (+3 mistas), UX 29, GAP 20, BUROCRACIA 19, DOC 15 |". E o doc de fixes:4 "(log, 107 fricções)."
```

### ATAQUE PASSOU, CONFIRMADO POR CONTAGEM E NÃO POR LEITURA. O corte é real: varri TODAS as ocorrências de `#<número>` no doc de fixes e o MÁXIMO é 107 — zero referências acima. Cruzado com o varrimento 

`friccoes` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\docs\tasks\2026-09-03-friccoes-ssam-kkr-time-entry.md:205 (#120), :239 (#146), :241 (#148), :242-244 (#149/#150/#150b), :246 (#152); ausência provada por varrimento sobre C:\Users\andre\GitSSAM\docs\tasks\2026-09-07-ondas-1-4-kkr-fixes-implementadas.md (302 linhas, máx. `#` referenciado = 107, nenhum acima)`

**Resolve:** handoff/registo (60) e não destruir intenção (24)

**Como se aproveita:** Documento de entrada da próxima rodada, com prioridade em #120 (corrupção silenciosa) e #149/#150 (o caminho de LEITURA mente). Para o Anvil a lição é de desenho e cai na família "endereçamento entre corridas": a onda de fixes fixou-se num snapshot de 107 e o catálogo continuou a crescer por baixo até 152. Todo o catálogo precisa de MARCA DE ÁGUA (último item triado) para a rodada seguinte saber onde pegar.

**Caminho nativo:** por apurar — cada uma das 45 precisa de triagem própria

**O que sobra se se deitar a implementacao fora:** O padrão: quando o registo e o consertador correm em paralelo sem marca de água, o fim da lista fica órfão — e o fim da lista é onde estão os achados mais tardios, que vieram de uso mais profundo e são por isso os mais graves. Aqui, 45 órfãos de 152 (30%) contêm a única corrupção silenciosa de dados de todo o log.

```
:205 literal: "| 120 | 22:50 | BUG | **Perda silenciosa de dados no Logic IR:** `Sync_SalesforceProjects` (lote E) reporta `Created: 10` mas só existe 1 Project." Doc de fixes :4 e :7-8: "`docs/tasks/2026-09-03-friccoes-ssam-kkr-time-entry.md` (log, 107 fricções)." e "Este documento fecha as **ondas 1 a 4** = todos os itens A, mais o ajuste de\nsegurança do verbo de descarte para ODC."
```

### ATAQUE PASSOU, COM UMA OMISSÃO A CORRIGIR. Os números da família 87 conferem todos: 4 min 52 s de re-dump do módulo INTEIRO (33 545 elementos) antes de uma linha correr, sem flag para saltar; filtrar 

`friccoes` · obtido por `trace-ou-interposicao`

**Ficheiro:** `C:\Users\andre\GitSSAM\docs\ODC1_FRICTION_LOG.md:90-96 e :243-249 (723 linhas); código em C:\Users\andre\GitSSAM\ssam_agent_runtime\runner.py:1244 (5664 linhas)`

**Resolve:** inspect: tamanho e filtro (87)

**Como se aproveita:** Requisito de desenho do kernel do Anvil, com números para o justificar: a leitura tem de ser INCREMENTAL e ESCOPADA (só o que a operação toca), e o filtro nunca pode custar mais do que a ausência de filtro. O cap silencioso é o pior dos três — devolver exactamente o cap sem dizer "truncado" é mentir por omissão, e a mesma classe reaparece noutro lane com `ss.get_records(limit=2000)` a devolver ~100 linhas sem `truncated` e sem erro. Toda leitura capada tem de declarar que foi capada.

**Caminho nativo:** por apurar quanto à leitura incremental — não verifiquei no decompilado se o Studio a expõe. Mas uma parte deixou de estar por apurar: o cap de 200 NÃO é limite de plataforma, é argumento literal da chamada em SSModelHandler.cs:1440, portanto declarar a truncagem é uma decisão ao alcance do kernel, hoje.

**O que sobra se se deitar a implementacao fora:** Os quatro números (4m52s de dump; 200× o filtro; cap de 200 sem aviso; 33 545 elementos no módulo) e a regra que deles sai. Nada disto depende da implementação deles. Acrescento o que o ataque rendeu: o cap é parâmetro, o que transforma "a plataforma trunca" em "nós truncamos e não avisamos".

```
ODC1_FRICTION_LOG.md:243-247 literal: "**Custo 1 — 4 min 52 s de re-dump de schema, antes de UMA linha do script\ncorrer.** `runner.py:_run_check_with_snapshot_auto_refresh` faz\n`run_schema_dump` do **módulo inteiro** sempre que o snapshot está `stale`, e\nqualquer mutação anterior marca-o stale. Não há flag para saltar. Ou seja:\n**toda a mutação paga o inventário completo do módulo de 33 545 elementos**,\nmesmo para mexer num bloco." E :90-96, com a mitigação que o outro agente omitiu: "2. **Filtrar `find_element` por tipo custa ~200× mais** do que não filtrar\n   (1 204 ms vs 3,7 ms)." ... "3. `find_element(\"Creative\") devolve **200 resultados = o cap exato** — o\n   nome real fica escondido atrás de cap-starvation (já mitigado no builder\n   por fallback de schema cache, commit `562af725`, mas a superfície pública\n   continua a mentir por omissão)." Função confirmada, runner.py:1244: "def _run_check_with_snapshot_auto_refresh("
```

### ATAQUE PASSOU: as nove famílias estão todas representadas e o "Top 10 por custo" existe mesmo (linha 166 do log, itens nas linhas seguintes). Verifiquei as linhas do Top 10 e a linha do binário velho.

`friccoes` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\docs\tasks\2026-09-03-friccoes-ssam-kkr-time-entry.md:166 ("### Top 10 (por custo)") e :169-171; C:\Users\andre\GitSSAM\docs\ODC1_FRICTION_LOG.md:90-96 e :243-249; C:\Users\andre\GitSSAM\docs\tasks\2026-09-07-ondas-1-4-kkr-fixes-implementadas.md:263`

**Resolve:** todas as nove

**Como se aproveita:** As nove famílias são boa taxonomia e podem servir de CHECKLIST DE ACEITAÇÃO de cada verbo novo do Anvil. E o "Top 10 por custo" é uma priorização já feita por PREÇO, que se aproveita directamente sem refazer o trabalho. O item nº 3 é o mais barato e o mais rentável de todos: um verbo em falta que custou 46 recuperações manuais numa só noite.

**Caminho nativo:** nao se aplica

**O que sobra se se deitar a implementacao fora:** A taxonomia confirmada por material independente, e a priorização por custo. O número 46 é o argumento mais forte que este catálogo produz para a tese "ferramenta, não catálogo": 46 recuperações por falta de um verbo que o SDK já sabia fazer, só não expunha.

```
Log :169-171 literal: "3. #21/#22 — não há verbo para descartar paste não publicado; `force close + reopen` é indocumentado e foi usado 46 vezes.\n4. #35/#35b/#42/#88/#90 — resolução por NOME (tipos, entidades, aggregates, locais) por substring/cache entre telas: erros silenciosos e \"not found\" para homónimos.\n5. #24/#26/#36/#45 — verificador pós-apply com falsos negativos ... e veredictos contraditórios entre verbos." Binário velho, doc de fixes:263: "- Bridge C#: `dotnet build` 0 erros; `dotnet test` 553 verdes; DLL corrigida instalada no ss2 (não no ss1/odc1)."
```

### CONFIRMADO SEM RESSALVA: compatibility_catalog.json tem mesmo 35 regras de familia O11->ODC e official_sources.json tem mesmo 144 documentos (62 docs-product + 82 docs-odc), cada um fixado por commit+

`migracao` · obtido por `documentacao-da-outsystems`

**Ficheiro:** `C:\Users\andre\GitSSAM\o11_odc_migration_hub\knowledge\compatibility_catalog.json:5-461 (35 regras, contadas uma a uma); C:\Users\andre\GitSSAM\o11_odc_migration_hub\knowledge\official_sources.json:1-12 e bloco `repositories``

**Resolve:** saber o que a plataforma permite (22); complexidade da saida (63)

**Como se aproveita:** Documento + tabela de dados no kernel do Anvil. Uma correccao ao achado original: o `estado` 'so documento' subvende o hub -- ele traz codigo a funcionar por cima do catalogo (catalog.py 6011 bytes, planner.py 21317, cli.py 8444, activation.py 6859) e quatro ficheiros de teste (test_planner.py 16528, test_live_preflight.py 8407, test_catalog_cli.py 4518, test_activation.py 4108). O que e 'so documento' e o CONTEUDO das 35 regras, nao o hub.

**Caminho nativo:** Nao aplicavel: nao ha caminho torto a substituir. Confirmo a excepcao limpa ao aviso do dono -- este corpus nao foi feito por trace nem reflection, e o unico da area de que isso se pode dizer.

**O que sobra se se deitar a implementacao fora:** Tudo. Verificacao que fiz e o achado original nao tinha: percorri as 35 regras e resolvi cada id de `evidence` contra o manifesto -- 0 pendentes. O par (familia -> rota + blocker + fonte re-hashavel) passa como JSON de dados com `evidence` intacto.

```
Contagem por script sobre os dois ficheiros: "regras: 35" / "regras sem evidencia: 0" / "evidencias que nao resolvem no manifesto: 0"; manifesto: `"documentCount": 144`, docs-odc = 82, docs-product = 62. Regra citada, literal em :202-212: "id": "cross-app-entity-write", ... "disposition": "service-boundary", "blocking": true, "evidence": ["docs-product:src/migration-to-odc/code-patterns/arch-non-read-only-entity.md"], "notes": "Cross-app entities are read-only in ODC; the owning App must expose write operations."
```

### Regra `mutable-site-property` e o item NAO MEDIDO do NAO-DA: a citacao do binario e exacta, mas a NOVIDADE e falsa. O mecanismo que o achado diz descobrir ja estava escrito no proprio item do NAO-DA q

`migracao` · obtido por `documentacao-da-outsystems`

**Ficheiro:** `Regra: C:\Users\andre\GitSSAM\o11_odc_migration_hub\knowledge\compatibility_catalog.json:344-356. Binario: C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model\ServiceStudio.ModelFeatures\ModelFeatures.cs:1514. Item: C:\Users\andre\Anvil\docs\NAO-DA.md:316-337, com o mecanismo ja em :324`

**Resolve:** saber o que a plataforma permite (22); erros que nao ensinam (52)

**Como se aproveita:** Corrijo o `estado` de 'funciona-hoje-por-caminho-nativo' para 'existe-mas-e-so-documento': nao ha codigo nenhum a funcionar aqui, ha um paragrafo de doc oficial mais uma leitura estatica. E corrijo a utilidade: a regra do catalogo NAO fecha o item do NAO-DA, porque fala de outra camada -- o catalogo diz que Settings sao read-only EM RUNTIME, e o item do NAO-DA e sobre o gate de DESIGN-TIME do Studio. Continuam duas perguntas, e so uma tem resposta. O que se ganha e uma linha de doc oficial a juntar ao item, nao o fecho dele.

**Caminho nativo:** Ja apurado -- mas nao por esta corrida. NAO-DA.md:324 ja cita VerifyMessageId.cs:1036 e :1116, ModelFeaturesVerifyMessagesManager.cs:53, Variables.cs:37895-37901 e ModelFeatures.cs:772-789. O achado original cita ModelFeatures.cs:1514, que e um subconjunto.

**O que sobra se se deitar a implementacao fora:** Dois factos, os dois validos: (a) Settings do ODC sao read-only em runtime, por doc oficial; (b) WriteableSiteProperties passa `null, null` nos defaults de compilador, logo headless nao ha estado nenhum para ler e o Verify cala-se -- que e o caso particular do mecanismo geral do item anterior.

```
ModelFeatures.cs:1514 literal: `WriteableSiteProperties = new OutSystems.MetaModel.ModelFeatures.ModelFeature("ModelFeature_WriteableSiteProperties", "Site Property Is Writeable", predatesContinuousDelivery: true, OutSystems.MetaModel.ModelFeatures.ModelFeatureStatus.Stable, isExcludedFromCompiler: false, checkEnvironmentCompatibility: true, isUsedByExtensionsOnly: false, null, null, uuid);`. NAO-DA.md:324 literal: "O gate e mesmo dependente do ambiente: ServiceStudio.Model\Variables.cs:37895-37901 `SitePropertyScopeEntry.IsReadOnly => ... return !ModelFeatures.WriteableSiteProperties.CanBeUsedInServerAndServiceStudio(Owner.OwnerESpace);`"
```

### Matriz de reuse cross-asset do ODC: quatro regras conferidas a letra, e o grep ao NAO-DA confere -- `cross-app` e `Delete Rule` dao mesmo ZERO ocorrencias

`migracao` · obtido por `documentacao-da-outsystems`

**Ficheiro:** `C:\Users\andre\GitSSAM\o11_odc_migration_hub\knowledge\compatibility_catalog.json:201-213, :214-226, :227-239, :331-343, :422-434, :435-447. Grep: C:\Users\andre\Anvil\docs\NAO-DA.md (1239 linhas)`

**Resolve:** saber o que a plataforma permite (22); nao destruir intencao (24)

**Como se aproveita:** Documento primeiro, depois `jobs-odc-negative` -- mas por ordem de barateza, comecando pelas duas que o binario ja corrobora. Confirmo a honestidade do achado original num ponto que ia atacar: ele diz que `read-only` nao aparece 'no sentido de dados', e tem razao -- as 2 ocorrencias em NAO-DA.md sao :94 ('o kernel chegar ao seu proprio Name is read-only') e :715 ('SS11 exposes a read-only IExpression'), as duas sobre o modelo do Studio.

**Caminho nativo:** Parcialmente apurado por mim nesta corrida: pelo menos `cross-app-entity-write` tem contraparte no binario (ModelFeature ReferencedEntityActions com default ODC Removed) e `unsupported-delete-rule` tem vizinha (DeleteRuleOnSystemReferences, com VerifyMessageId proprio em VerifyMessageId.cs:1034). As outras quatro regras continuam por apurar e nao as invento.

**O que sobra se se deitar a implementacao fora:** Tudo: e conhecimento puro, sem implementacao a deitar fora.

```
Catalogo :342 literal: "notes": "Cross-app relationships support Ignore; implement integrity at the owning boundary where required."; :238: "notes": "Local Storage belongs to each App and cannot be consumed from a Library."; :433: "notes": "A Mobile Screen cannot be shared from another App or Library."; :446: "notes": "A Structure is shared only when reachable through a public signature; otherwise copy it to the target owner." Grep medido: PostgreSQL=0, multi-tenan=0, Data Fabric=0, cross-app=0, External Library=0, Delete Rule=0, multipart=0, Forge=0, SAML=0.
```

### PostgreSQL: regra conferida a letra, e o NAO-DA tem mesmo zero mencoes. O `por apurar` do achado original e honesto e mantenho-o

`migracao` · obtido por `documentacao-da-outsystems`

**Ficheiro:** `C:\Users\andre\GitSSAM\o11_odc_migration_hub\knowledge\compatibility_catalog.json:305-317`

**Resolve:** saber o que a plataforma permite (22)

**Como se aproveita:** Documento, e um _why nos jobs do Anvil que criam IAdvancedQuery no ODC (existe tests\jobs-odc\logic-sql.json). Copiar um SQL do O11 letra a letra e a mesma armadilha que copiar IAggregateAttribute letra a letra -- so que esta nao rebenta no Verify, rebenta em runtime.

**Caminho nativo:** por apurar -- nao ha ModelFeature de dialecto SQL no dump ODC e nao fui procurar mensagem de Verify por dialecto. Provavelmente cai na classe das features sem default compilado, mas nao o confirmei e nao o invento.

**O que sobra se se deitar a implementacao fora:** O facto do motor (PostgreSQL) e o aviso de que a comparacao de semantica e obrigatoria por query.

```
compatibility_catalog.json:306-316 literal: "id": "advanced-sql", "title": "Advanced SQL dialect and scope", "disposition": "adapt-and-test", ... "notes": "Internal data runs on PostgreSQL; external data follows the connection contract. Compare semantics and execute every query test."
```

### Divergencias reconciliadas e precedencia de fontes: a citacao do SAML e literal e a precedencia de quatro niveis existe -- mas a lista tem CINCO divergencias, nao quatro

`migracao` · obtido por `documentacao-da-outsystems`

**Ficheiro:** `C:\Users\andre\GitSSAM\o11_odc_migration_hub\CANONICAL_GUIDE.md:224-239 (cinco bullets); precedencia em OFFICIAL_SOURCE_AUDIT.md:53-58, aplicacoes em :60-69`

**Resolve:** saber o que a plataforma permite (22); nao destruir intencao (24)

**Como se aproveita:** Documento, e vale roubar ao hub a ESTRUTURA -- uma seccao 'divergencias reconciliadas' com precedencia explicita de fontes -- para o NAO-DA, que hoje tem os veredictos espalhados item a item. Correccao: as divergencias sao cinco (.NET 8 -> net10.0; sessao de 12h; SAML; redaccao ambigua do mapping entre apps O11; construtor de OSInterface / injeccao de ILogger). Quem importar 'quatro' perde a quinta, que e a que mais se parece com um erro de agente: gerar assinatura de SDK por memoria.

**Caminho nativo:** Nao aplicavel -- e conhecimento documental, sem implementacao.

**O que sobra se se deitar a implementacao fora:** As CINCO divergencias e, mais importante, a regra de precedencia de quatro niveis, que se cita a letra.

```
CANONICAL_GUIDE.md:231-233 literal: "- Actions antigas de `SAMLAuthentication` nao serem convertiveis nao significa que ODC nao suporta SAML. O Identity Service atual suporta SAML 2.0 e OIDC; o fluxo e os usuarios ainda precisam ser redesenhados/migrados." Precedencia, OFFICIAL_SOURCE_AUDIT.md:55-58 literal: "1. Requisitos/runtime/SDK ODC vigentes. 2. Arquitetura e reuse ODC vigentes. 3. Guia de migracao O11->ODC. 4. Exemplos/EAP, sempre marcados como tal."
```

### PISTA FALSA DE OBSOLESCENCIA: confirmo que `src/eap/` nao e marca de Early Access -- e trago prova melhor do que a contagem. O proprio manifesto declara `src/eap/...` como as ROOTS do repositorio docs

`migracao` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\o11_odc_migration_hub\knowledge\official_sources.json, bloco `repositories`; contraste com OFFICIAL_SOURCE_AUDIT.md:58 e :78`

**Resolve:** saber o que a plataforma permite (22)

**Como se aproveita:** Registar como aviso e nao como defeito, tal como o achado original propoe -- subscrevo, e corrijo-lhe o `estado` de 'funciona-hoje-por-caminho-nativo' (que e um erro de categoria: nao ha caminho nenhum a funcionar) para 'existe-mas-e-so-documento'. A contagem confirma-se: 82 de 82 documentos docs-odc sob src/eap, 0 fora. Mas quem quiser a prova em uma linha nao precisa de contar -- o manifesto lista as roots.

**Caminho nativo:** Nao aplicavel.

**O que sobra se se deitar a implementacao fora:** O aviso: `src/eap/` no docs-odc e caminho de repositorio, nao Early Access. A precedencia de :58 refere-se a conteudo marcado no texto.

```
official_sources.json, bloco repositories, literal: `"name": "docs-odc", "repository": "https://github.com/OutSystems/docs-odc", "roots": ["src/eap/app-architecture", "src/eap/building-apps/external-logic", "src/eap/building-apps/libraries", ... "src/eap/user-management"]`. E OFFICIAL_SOURCE_AUDIT.md:78 cita como fonte essencial `[Arquitetura ODC](https://github.com/OutSystems/docs-odc/blob/bbb7a2a.../src/eap/app-architecture/intro.md)`. Contagem: docs-odc = 82, sob src/eap = 82, fora = 0.
```

### REST de Code Quality do ODC: CONFIRMADO, citacao literal exacta. Contei os endpoints na tabela: sao DEZ, e ele disse dez. /analysis-status, /assets/{assetKey}/revisions/{revision}/analysis-summary, /a

`boas-praticas` · obtido por `documentacao-da-outsystems`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam-declarative\docs\platform-apis\2026-05-19-odc-public-rest-api-endpoint-inventory.md:175-186`

**Resolve:** saber o que a plataforma permite (22) e portao independente (46).

**Como se aproveita:** Ponte do SSAM-Hybrid-ODC. Chamar /patterns UMA vez e guardar o catalogo como dados, como se faz com o .resx. Da o segundo catalogo de regras, e e o candidato obvio a substituir o gate reflectido: /findings devolve achados com identidade de regra sem tocar no Studio.

**Caminho nativo:** E o caminho nativo e esta so documentado, nao chamado em codigo nenhum (procurei). Este e o unico caminho DE FACTO nativo para qualidade em ODC -- sem Studio, sem reflection, sem bridge.

**O que sobra se se deitar a implementacao fora:** A lista dos 10 endpoints com operation id e permissao. Vale como mapa mesmo sem chamada, e vale mais ainda como alternativa nativa ao ratchet reflectido.

```
linha 185 -- "| `GET` | `/patterns` | `PatternsControllerV_GetPatterns` | Retrieves a list of code patterns. | API Client needs the **AI Mentor System > View Code Quality findings** permission. |" /// linha 180 -- "| `POST` | `/code-analyses` | `CodeAnalysisControllerV_SubmitCodeAnalysisRequest` | Submits a code analysis request for an asset revision. | API Client needs the **AI Mentor System > Manage Code Quality findings** permission. |"
```

### Nomes de findings do AIMS no QA_REPORT: citacao literal confirmada. MAS uma correccao que vale: a terceira 'nota do AIMS' que ele lista -- 'exposing a server action for public access' -- NAO e do AIMS

`boas-praticas` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\equipment-loan-portal\QA_REPORT.md:137-138 (a nota atribuida ao AIMS) e :146-152 (o finding de query em ciclo); cruzado com o resx, entrada ServerActionInAnonymousScreen`

**Resolve:** erros que nao ensinam (52) e nao destruir intencao (24).

**Como se aproveita:** Documento, com a licao para o kernel que ele identificou bem: o autor registou a EXCEPCAO justificada com dono e razao. Um portao que nao aceita excepcao declarada obriga a apagar intencao correcta. Acrescentar a licao nova: antes de dar um finding como 'do AIMS', confirmar contra o catalogo VerifyMessageId -- senao conta-se a mesma regra duas vezes.

**Caminho nativo:** Para obter estes nomes sem depender deste documento: /patterns (ODC REST). Este ficheiro e amostra, nao fonte -- e, como se ve, amostra com uma atribuicao errada.

**O que sobra se se deitar a implementacao fora:** O formato de registo de excepcao (finding + porque e intencional + dono + requisito que o obriga), que e exactamente o formato de allowlist que o ratchet ja exige. E o aviso de atribuicao errada AIMS/TrueChange.

```
QA_REPORT.md:146-152 -- "- **AIMS finding — \"Aggregate/SQL query inside a cycle\" (expected):** the bulk\n  approval (`Approval_ProcessOne` per item), the sync upsert\n  (`GetExistingEquipment` per feed item) and the overdue scan each run a query\n  inside a For-Each. These are **intentional and required** — per-item row locks\n  (FR07/FR11) and per-item upsert/idempotency (INT06/FR16) cannot be hoisted out\n  of the loop without breaking correctness." /// QA_REPORT.md:137-138 -- "*(AIMS will still emit its informational \"exposing a server action for\n  public access\" note on that one screen — expected and justified by FR01.)*" vs resx -- "ServerActionInAnonymousScreen|Warning|Security Warning|You're exposing a Server Action for public access and without authentication."
```

### A formula de medicao: CONFIRMADA literal no slide, extraida por mim do XML do pptx (nao do scratchpad dele). O sinal e '×' e nao 'x', e a formula fecha um slide que lista seis anti-padroes de performa

`boas-praticas` · obtido por `documentacao-da-outsystems`

**Ficheiro:** `C:\Users\andre\GitSSAM\OutSystems_Data_for_Senior_Developers.pptx, ppt/slides/slide12.xml (extraccao directa do ZIP/XML)`

**Resolve:** complexidade da saida (63).

**Como se aproveita:** Kernel do Anvil: se algum dia se quiser um numero de 'peso de ecra', esta formula e defensavel porque e da OutSystems. Os seis pares anti-padrao->remedio sao tambem o texto certo para as mensagens de erro que ensinam.

**Caminho nativo:** Tres dos quatro factores sao legiveis do modelo sem correr nada: call count (nos ExecuteAction), rows (Max. Records) e frequency (evento de ciclo de vida). Latency so com o tenant. Confirmo a leitura dele.

**O que sobra se se deitar a implementacao fora:** A formula inteira e os seis pares anti-padrao->remedio. Sobrevivem a qualquer implementacao.

```
slide12.xml -- "Measure the generated work: call count × rows × frequency × latency." e "Query inside a loop / Batch or join once / Unlimited records / Page and cap early / Fetch then filter / Push predicates to the database"
```

### Listas de indices 6+6: CONFIRMADAS literalmente. Mas a `prova` dele esta em PORTUGUES e o primeiro ficheiro que ele cita e o deck INGLES, que diz 'composite primary key / expression or function index 

`boas-praticas` · obtido por `documentacao-da-outsystems`

**Ficheiro:** `C:\Users\andre\GitSSAM\OutSystems_para_Desenvolvedores_Seniores_v2.pptx, ppt/slides/slide22.xml (onde a citacao e literal) e C:\Users\andre\GitSSAM\OutSystems_Best_Practices.pptx, ppt/slides/slide23.xml (versao inglesa)`

**Resolve:** saber o que a plataforma permite (22).

**Como se aproveita:** Documento + kernel: tabela de capacidades pronta a virar recusa antecipada com explicacao ('PK composta nao e nativa; usa indice Unique composto como alternate key') em vez de uma tentativa que falha.

**Caminho nativo:** Confirmei a verificacao cruzada dele: o resx tem InvalidEntityIndex_LongText (Error|Invalid Entity Index, "'Text' data type attribute with length greater than {2} is not allowed in {0} index of {1}"), o que comprova que o modelador valida indices. Note-se que este limiar {2} tambem e formatado em runtime -- outro caso em que o numero nao esta no texto.

**O que sobra se se deitar a implementacao fora:** As duas listas de 6 e a alternativa que o deck da para o caso mais pedido (PK composta -> indice Unique composto, que aparece na coluna E POSSIVEL como 'alternate key com indice composto Unique').

```
Seniores_v2 slide22.xml -- "NÃO É NATIVO\nprimary key composta\nfiltered / partial index\nINCLUDE columns\nindex por expressão ou função\nescolher clustered vs. nonclustered\nindexar atributo calculado do Aggregate" /// Best_Practices slide23.xml -- "NOT NATIVE\ncomposite primary key\nfiltered / partial index\nINCLUDE columns\nexpression or function index\nchoose clustered vs. nonclustered\nindex an Aggregate calculated attribute"
```

### Logs do Service Center: CONFIRMADO literal, extraido por mim do notesSlide30 do pptx. Duas semanas na UI, ate nove semanas de retencao fora do OutSystems Cloud, Request Key a correlacionar logs do mes

`boas-praticas` · obtido por `documentacao-da-outsystems`

**Ficheiro:** `C:\Users\andre\GitSSAM\OutSystems_Best_Practices.pptx, ppt/notesSlides/notesSlide30.xml (extraccao directa do ZIP)`

**Resolve:** handoff/registo (60) e enderecamento entre corridas (36).

**Como se aproveita:** Documento + kernel: um recibo que aponta para um log do Service Center tem prazo de validade. Quem guarda 'a prova esta no Service Center' tem de guardar tambem a Request Key e, se importar, o export.

**Caminho nativo:** Por apurar do lado da API, e ele foi honesto ao dize-lo. A nota cita success.outsystems.com/documentation/11/monitoring_and_troubleshooting_apps/view_the_environment_logs_and_status/ -- confirmei o URL na propria nota. Nao verifiquei contra tenant e nao devia.

**O que sobra se se deitar a implementacao fora:** Os dois numeros (2 semanas de UI, ate 9 de retencao), o conceito de Request Key como correlacao ja existente na plataforma, e a lista das 11 areas de monitoring.

```
notesSlide30.xml -- "Service Action logs expose a Request Key that relates logs from the same top-level request. The UI displays roughly the last two weeks, while retention can be configured up to nine weeks outside OutSystems Cloud; export evidence when needed."
```

### 'Cabe em uma tela': CONFIRMADO literal, extraido por mim do slide XML. E o slide tem mais dois criterios que ele cortou e que sao tao uteis como os dois que trouxe: '03 Explica a intencao -- Nomeie ac

`boas-praticas` · obtido por `documentacao-da-outsystems`

**Ficheiro:** `C:\Users\andre\GitSSAM\Boas_Praticas_Tecnicas_OutSystems.pptx, ppt/slides/slide14.xml (extraccao directa do ZIP)`

**Resolve:** complexidade da saida (63).

**Como se aproveita:** Documento. Fecha a discussao: quem pedir 'o limite oficial da OutSystems para variaveis locais' recebe a prova de que esse limite nao esta escrito. Mas o item 04 deve sair do documento para o kernel, porque tem warning nativo.

**Caminho nativo:** Nao aplicavel para 01/02/03 -- e conselho. Para 04 ha mecanismo nativo: a familia Unused* do catalogo VerifyMessageId.

**O que sobra se se deitar a implementacao fora:** 'Cabe em uma tela' e bom criterio humano e nao e predicado automatizavel. E a separacao dos quatro itens em tres nao-automatizaveis + um automatizavel (Unused*).

```
slide14.xml -- "UM FLUXO BOM\n01\nLê de cima para baixo\nUse saídas antecipadas para reduzir níveis de decisão.\n02\nCabe em uma tela\nExtraia uma Action quando o fluxo tiver outra responsabilidade.\n03\nExplica a intenção\nNomeie ações, variáveis e outputs pelo efeito; não pelo tipo.\n04\nNão guarda lixo\nRemova código morto, comentários obsoletos e dependências sem uso."
```

## Promessa nao cumprida -- o documento anuncia, o codigo nao tem

### Tres verbos citados no card Traditional do CAPABILITIES.md nao existem em lado nenhum do SDK, e o allowlist do gate documenta-o por escrito com dono e proibicao de atalho: scr.web_block, scr.use_web_l

`capabilities` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam_agent_runtime\tests\test_capabilities_doc_contract.py:29-42`

**Resolve:** nao destruir intencao (24).

**Como se aproveita:** Documento. E o modelo de como registar uma promessa por cumprir: nomear os verbos, provar a ausencia, nomear o dono e proibir o atalho.

**Caminho nativo:** Nao aplicavel: nao ha contorno a herdar porque nao ha implementacao nenhuma. O que ha e uma decisao por tomar, registada como tal.

**O que sobra se se deitar a implementacao fora:** A forma do registo. Um allowlist datado com justificacao e dono e melhor do que um TODO, porque e verificado por CI todas as vezes.

```
test_capabilities_doc_contract.py:31-40 -- "# 2026-08-29: o card Traditional (traditional_webblock v1) cita estes\n    # tres, mas NENHUM existe na superficie viva (grep no pacote inteiro:\n    # zero defs). ss.traditional_block/traditional_screen existem; o\n    # instanciador de block em tela e o popup classico nao. Dono do card\n    # precisa decidir: implementar ou reescrever — NAO remover daqui sem\n    # essa decisao.\n    \"scr.web_block\",\n    \"scr.use_web_layout\",\n    \"scr.popup_editor\"," | verificacao independente minha: grep 'def (web_block|use_web_layout|popup_editor)\b' em todo o C:\Users\andre\GitSSAM\ssam-declarative -> "No matches found"
```

### Dois ponteiros do `how` estao partidos e nada os verifica. Confirmado: `docs/33_incremental_action_flow_edit.md` (citado por 2 Intents) nao existe nessa raiz -- o ficheiro real esta em ssam-declarativ

`capabilities` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam_agent_runtime\how_cmd.py:39, :44, :95, :103, :130, :138; cards reais em C:\Users\andre\GitSSAM\CAPABILITIES.md:373, :1899, :1945`

**Resolve:** enderecamento entre corridas (36) + inspect: tamanho e filtro (87).

**Como se aproveita:** Anvil: todo ponteiro para documento ou card e um ENDERECO e tem de ser validado no mesmo teste que valida verbos. Ponteiro como string livre sem gate degrada em silencio -- aqui 33% degradaram.

**Caminho nativo:** Nao e questao de plataforma: e falta de gate. O gate irmao ja existe e funciona (test_capabilities_doc_contract.py valida verbos e comandos citados no CAPABILITIES.md) -- so nunca foi estendido aos ponteiros do how_cmd.

**O que sobra se se deitar a implementacao fora:** A regra: ponteiro sem gate apodrece, e o gate ja existe no repo para o vizinho -- e so alarga-lo. A medida: 2 em 6.

```
how_cmd.py:35-39 -- Intent(("inserir node", ...), ("ss.flow.insert_between", "ss.flow.graph"), "liga os DOIS lados; add_node(after=) so liga origem->novo", "docs/33_incremental_action_flow_edit.md") | how_cmd.py:131-138 -- Intent(("consumir rest", ...), ..., "CAPABILITIES.md ssam.integrations.rest_wrapper") | Test-Path C:\Users\andre\GitSSAM\docs\33_incremental_action_flow_edit.md -> False; C:\Users\andre\GitSSAM\ssam-declarative\docs\33_incremental_action_flow_edit.md -> True | Select-String '^### ' do CAPABILITIES.md filtrado por 'rest' -> so :1899 "### ssam.integrations.rest_client" e :1945 "### ssam.integrations.exposed_rest_api" | ponteiros que RESOLVEM: C:\Users\andre\GitSSAM\docs\logic-ir-v1.md -> True; CAPABILITIES.md:373 "### ssam.data.create_entity" -> existe
```

### Client Variable: nao ha verbo publico de CRIACAO em lado nenhum, e a unica def chama-se OfflineScreen.client_variable, numa classe fora das superficies do catalogo -- logo `sig` nunca a resolve, e nao

`capabilities` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam-declarative\ssam_declarative\offline.py:892 (class OfflineScreen) e :928 (def client_variable); superficies em ssam-declarative\ssam_declarative\signatures.py:98-150; ausencia em SIGNATURES.md e CAPABILITIES.md; nativo em C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model.Definition\CodeGeneration.Definitions.ObjectDefinitions.xml:569-574`

**Resolve:** saber o que a plataforma permite (22): e a causa raiz da familia mais cara. Sem rota, o agente inventou um limite.

**Como se aproveita:** Tres coisas no Anvil, uma delas nova: (1) o verbo em falta e trabalho identificado, com o contrato nativo ja conhecido; (2) a rota tem de saber dizer "NAO EXISTE verbo para isto" -- o `recipe` ja tem essa forma ("SEM PROVA VIVA"), o `sig` e o `how` nao; (3) ACHADO NOVO: ha um ponto de perda silenciosa de dados. `_replay_interface_spec` percorre spec.client_variables, procura o helper por getattr no builder vivo e, se nao existir, faz `continue` -- ou seja, as client variables do spec sao DESCARTADAS sem erro nem aviso quando se replica contra um builder que nao tem o helper (e nenhum builder vivo tem: a unica def esta no OfflineScreen). Isto e a familia "erros que nao ensinam" na sua pior forma: nem erro ha.

**Caminho nativo:** CONFIRMADO na linha exacta. No modelo ODC, ClientVariable e objecto de primeira classe com displayName="Client Variable", defaultName="Variable", isSoftwareUnit="true", runtimeKind="RuntimeKind.MobileOrReactive", modelFeature="ClientVariables", e tem <PropertyPlaceholder name="DefaultValue" /> e uma Property Type. A definicao nao declara limite de quantidade nenhum -- os constrangimentos reais sao outros (so Mobile/Reactive, e feature de modelo). O limite inventado na sessao de 500 min nao tem base no modelo.

**O que sobra se se deitar a implementacao fora:** O diagnostico completo da familia de 500 min: capacidade sem verbo publico + rota que nao sabe dizer "nao existe" = invencao. A resposta certa do modelo teria sido "nao ha rota", nao um limite. Acrescento o padrao do `getattr(...)/continue`: procurar um helper por nome e seguir em silencio quando falta e uma forma de fingir cobertura.

```
grep 'def client_variable' em todo o ssam_declarative -> uma unica ocorrencia, offline.py:928 "def client_variable(\n        self,\n        name: str,\n        data_type: type | str,\n        *,\n        default: Any = None,\n        **metadata: Any,\n    ) -> str:" dentro de offline.py:892 "class OfflineScreen:" com docstring :893 "Context object for a screen captured as symbolic widget/data IR." | signatures.py:98-150 lista as superficies (sa, ca, scr, blk, ss, proc, api, exposed_api, endpoint, ss.app, ss.module, ss.inspect, ...) -- OfflineScreen nao consta | busca 'ClientVariable' e 'client variable' em CAPABILITIES.md -> 0 ocorrencias cada | nativo ObjectDefinitions.xml:569 -- <Variables.AbstractGlobalClientVariable name="ClientVariable" docName="ClientVariable" ... displayName="Client Variable" ... defaultName="Variable" isSoftwareUnit="true" ... runtimeKind="RuntimeKind.MobileOrReactive" modelFeature="ClientVariables"> e :572 <PropertyPlaceholder name="DefaultValue" /> | perda silenciosa: native_paste.py:486-490 -- "for variable in getattr(spec, \"client_variables\", []) or []:\n        helper = getattr(builder, \"client_variable\", None)\n        if helper is None:\n            continue"
```

### VEREDICTO SOBRE O ACHADO 5 (`must_mutate` e `diagnostic` mortos): SOBREVIVE, com um pormenor. Grep exaustivo por `must_mutate` em todo o GitSSAM: 40 ocorrencias nos JSON do corpus, 2 em docs/normalize

`mistakes` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam_agent_runtime\ci_gates.py:240; C:\Users\andre\GitSSAM\ssam_agent_runtime\tests\test_runtime.py:5467-5476; C:\Users\andre\GitSSAM\docs\normalizer-coverage-plan.md:154,165`

**Resolve:** portao independente

**Como se aproveita:** Kernel do Anvil: so campos que alguem le. E convem notar que o campo morto ja se propagou para a documentacao (normalizer-coverage-plan.md ensina a escreve-lo), por isso deitar fora o campo obriga a deitar fora tambem o paragrafo que o ensina.

**Caminho nativo:** por apurar continua certo, e a decisao certa e nao ter o campo. Acrescento o que o achado nao disse: test_runtime.py:5469 tambem assere `data["methods"]` apenas como nao-vazio, o que confirma a terceira parte da acusacao.

**O que sobra se se deitar a implementacao fora:** Nada de `must_mutate`. De `diagnostic` sobra a ideia de categoria de erro, que ja vive melhor no `id` das ErrorRule. Acrescento: um campo decorativo contamina a documentacao antes de ser removido, por isso o custo de o ter e maior do que parece.

```
test_runtime.py:5469 e 5476 -- `assert data["methods"]` e `assert isinstance(case["must_mutate"], bool)`. A tupla em ci_gates.py:240 nao inclui `diagnostic`. Grep global por `must_mutate` nao devolve nenhuma outra linha de codigo.
```

### VEREDICTO SOBRE O ACHADO 6 (nomes falsos em `methods`): A ACUSACAO SOBREVIVE, A PROVA ESTA ERRADA NUM PONTO. `ss.security.permission_matrix` nao existe em codigo nenhum -- confirmado, aparece so nos d

`mistakes` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\llm_mistakes\permission_matrix_sources.json:7; routing_ambiguity.json:11,13; C:\Users\andre\GitSSAM\ssam_agent_runtime\context_pack.py:68; C:\Users\andre\GitSSAM\ssam-declarative\ssam_declarative\builders\action.py:239,7792; C:\Users\andre\GitSSAM\ssam-declarative\ssam_declarative\offline.py:348,506`

**Resolve:** saber o que a plataforma permite

**Como se aproveita:** Documento + gate do Anvil: cruzar cada nome citado com a superficie real e rebentar se nao existir. Acrescento uma regra ao cruzamento: quando existirem duas definicoes com o mesmo nome (builder real e espelho offline), o ledger tem de nomear A CLASSE, senao produz um caminho nativo que aponta para o duplo.

**Caminho nativo:** O nome real do metodo SDK e `sa.sql` de `class ActionBuilder` (action.py:239, metodo em :7792) -- NAO o de `class OfflineAction`. `ss.sql` continua a nao existir: zero `def sql(` em ss.py. O id de capability real e `ssam.security.permission_matrix` (context_pack.py:68). O corpus mistura mesmo dois espacos de nomes.

**O que sobra se se deitar a implementacao fora:** A regra sobrevive: campo de nomes nao cruzado com a superficie real produz nomes falsos. Acrescento o segundo dente da regra: cruzar por `grep def <nome>` sem olhar para a classe dona da-me o primeiro resultado, nao o certo.

```
Grep por `def sql\(` em todo o GitSSAM devolve 6 linhas, e duas sao de producao: `C:\Users\andre\GitSSAM\ssam-declarative\ssam_declarative\builders\action.py:7792:    def sql(` e `C:\Users\andre\GitSSAM\ssam-declarative\ssam_declarative\offline.py:506:    def sql(`. A classe imediatamente acima de action.py:7792 e `class ActionBuilder(FuzzyUnknownAttrMixin, ListOpsMixin):` na linha 239.
```

### CONFIRMADO. O hook pre-commit do repositorio NAO esta instalado. .git/hooks tem 14 ficheiros e TODOS terminam em .sample (incluindo pre-commit.sample, 1649 bytes). .git/config nao contem a palavra hoo

`regras` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\hooks\pre-commit (linhas 4-5 = instrucao de instalacao; PATTERNS 42-46; OK_PATTERNS 49-56) vs C:\Users\andre\GitSSAM\.git\hooks\ (14 ficheiros, todos .sample) e C:\Users\andre\GitSSAM\.git\config (13 linhas uteis, sem hooksPath)`

**Resolve:** portao independente 46

**Como se aproveita:** Documento + kernel. Licao dura: um gate que depende de um passo de instalacao manual nao e um gate. Se o Anvil quiser este check, ou vive no CI, ou vive no kernel, ou nao vive.

**Caminho nativo:** O caminho nativo do git e `core.hooksPath = hooks/` -- uma linha em .git/config, que versiona os hooks e dispensa a copia. O ficheiro pede copia manual e a copia nunca foi feita. Confirmei o .git/config integral: so [core], [remote "origin"] e [branch "AndreMachado"].

**O que sobra se se deitar a implementacao fora:** A tabela PATTERNS/OK_PATTERNS continua util e e portavel em 5 minutos: distingue path absoluto hardcoded (C:\\Users\\<user>, C:/Users/<user>, /Users/<user>) de expressao dinamica ($env:USERPROFILE, $PSScriptRoot, %~dp0, os.path.expanduser, Path(__file__), <REPO_ROOT>, <SEU_USER>, Path.GetTempPath(), Environment.GetFolderPath).

```
hooks/pre-commit L4-5: "Install: copy to .git/hooks/pre-commit (or symlink)\n         chmod +x .git/hooks/pre-commit  (Linux/Mac)"
.git/config integral: [core]/repositoryformatversion/filemode/bare/logallrefupdates/symlinks/ignorecase, [remote "origin"] url+fetch, [branch "AndreMachado"] remote+merge -- nenhuma ocorrencia de hooksPath.
.git/hooks: applypatch-msg.sample, commit-msg.sample, ..., pre-commit.sample (1649), ..., update.sample -- 14 ficheiros, zero sem .sample.
```

### CONFIRMADO POR CONTAGEM. `logic-ir stats` e anunciado no help e nao existe no despacho. Contei as ocorrencias da string "stats" em todo o cli.py: duas, L2221 (o parser TOP-LEVEL) e L3170 (o despacho d

`regras` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam_agent_runtime\cli.py -- help L1289-1290, `logic_ir_parser.add_argument("spec", type=Path)` L1295, 17 ramos casefold L5703/5714/5735/5774/5828/5866/5895/5922/5953/5980/6007/6035/6063/6081/6106/6131/6159, fallback L6281-6285`

**Resolve:** erros que nao ensinam 52 | saber o que a plataforma permite 22

**Como se aproveita:** Kernel do Anvil: o conjunto de ops e fechado e validado contra schema; op desconhecida devolve 'op desconhecida' mais a lista dos validos, nunca um erro de I/O.

**Caminho nativo:** O caminho nativo do argparse e add_subparsers com choices, que rejeita verbo inexistente listando os validos. Aqui o verbo e um Path posicional, portanto argparse nao valida nada e o erro que sai e sobre um ficheiro que nao existe.

**O que sobra se se deitar a implementacao fora:** O modo de falha, que e a licao: quando o verbo e argumento livre em vez de choices, quem escreve um verbo errado recebe um erro sobre OUTRA COISA (ficheiro ilegivel), nao 'verbo desconhecido, os validos sao...'. E exactamente a familia 'erros que nao ensinam', e e reproduzivel de graca em qualquer CLI.

```
cli.py L1288-1290: "            \"frontend <business_spec> expande a spec compacta. Analise: \"\n            \"inspect [--lossless], impact, refactor, graph-diff, \"\n            \"graph-refactor, abi-migrate, changeset*, coverage, policy, \"\n            \"stats. Snapshot via `schema-dump <Mod> --target <t>` e \""
cli.py L1295: "    logic_ir_parser.add_argument(\"spec\", type=Path)"
cli.py L6281-6285: "    try:\n        payload = compile_logic_ir_file(\n            args.spec,\n            snapshot_path=args.snapshot,\n        )"
Ocorrencias da string "stats" em cli.py: L2221 e L3170, ambas do verbo top-level. Zero ramos logic-ir.
```

### CONFIRMADO com uma correccao de etiqueta. O `scr.build(spec)` do DECLARATIVE_COMPILER.md nao existe em codigo: confirmei por mim que `scr.build(` so aparece 3 vezes e so dentro do proprio .md (linhas 

`declarative` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam-declarative\DECLARATIVE_COMPILER.md:30, :1041-1054, :157-172, :707-710`

**Resolve:** complexidade da saida 63; saber o que a plataforma permite 22

**Como se aproveita:** Documento, e a parte salvavel e mesmo a que ele indicou -- fui verificar e os 4 defaults implicitos estao LA, literais, nas linhas 157/160/170/172 do _fill_defaults(). Viram defaults declarados da op `screen` do job JSON do Anvil, com o job a imprimir o que ficou implicito. A arquitectura nao se porta.

**Caminho nativo:** Nao se aplica (nunca existiu). O vivo e o job JSON do Anvil, e essa parte confirmei nos ficheiros reais: `tests/jobs/logic-call-order.json` e uma unica op `{"op":"logic","data":{...}}`.

**O que sobra se se deitar a implementacao fora:** Os 4 defaults implicitos, agora com linha: DELETE->refresh (:157), EDIT->carrega a linha (:160), POPUP->close (:170), SUBMIT->refresh (:172). E a ordem de dependencia dos resolvers (dados->css->layout->tabela->popup->accoes) da tabela :1043-1050. Nota: o outro agente escreveu "SUBMIT sempre fecha+refresh"; o ficheiro so diz refresh na :172 -- pequeno embelezamento.

```
"| 8 | ActionResolver | Alta | Todos os acima |" (:1050) e "**Total estimado:** ~800-1000 linhas de Python.\n**Pre-requisito critico:** Widget CSS Reference (para CSSResolver saber os seletores)." (:1052-1053) e "## Ponto de entrada: `scr.build(spec)`" (:30). Defaults: "# DELETE SEMPRE tem refresh implicito" (:157), "# EDIT SEMPRE carrega dados implicitamente" (:160), "popup[\"close\"] = True  # POPUP SEMPRE tem close implicito" (:170)
```

### AUSENCIA CONFIRMADA, MAS A "DIFERENCA QUE NAO E DIFERENCA" E MAIOR DO QUE ELE VIU. Confirmei: _review.py e _verify.py nao existem, e nao ha `def review` nem namespace `ss.verify` em ss.py; `def lint` 

`declarative` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam-declarative\SSAM_VISION.md:552-554, :597-598, :634-635; ssam_declarative\_requirements.py:1-23, :350; ss.py:6354 (requirements), :6533 (verify_requirements), :6760 (plan), :7215 (check), :7325, :10463 (lint); ausencia verificada de _review.py e _verify.py`

**Resolve:** portao independente 46; erros que nao ensinam 52; nao destruir intencao 24

**Como se aproveita:** Kernel do Anvil, com o alvo afinado. O que falta mesmo nao e "verificacao semantica" em geral -- e a ASSERCAO NEGATIVA por accao ("esta screen action NAO chama X"), que e a unica forma que apanha o bug do botao de fechar que apagava o registo. O que ja existe (`ss.check`) so sabe dizer se um widget mencionado no pedido aparece na arvore; nunca sabera dizer que algo a mais nao devia la estar. A lacuna e precisa e pequena, e isso torna-a facil de fechar no `deliver`.

**Caminho nativo:** No Anvil o esqueleto existe e confirmei as duas pecas que ele citou: `check-job` em AGENTS.md:58 ("nao carrega o Studio: valida sintaxe de spec/logic, nomes/aliases/ciclos e parametros sem uso") e `dataProof` em AGENTS.md:88 ("compara existencia, nomes, tipos, comprimentos, obrigatoriedade"). Falta o equivalente para logica/UI: asercoes positivas e negativas por accao.

**O que sobra se se deitar a implementacao fora:** O par de asercoes e o diagnostico, agora com linha exacta -- SSAM_VISION.md:634-635. Nota: ele citou esta frase sem numero de linha e sem os asteriscos do markdown, por isso a citacao literal nao casava; o texto real e "O SDK pode verificar **estrutura** (action existe? var existe? TrueChange ok?),\nmas NAO pode verificar **semantica** (o botao X deveria fechar o popup, nao deletar)." Vale tambem a solucao desenhada nas :642-645: o SDK le e apresenta factos, nao julga, e BLOQUEIA o publish ate o LLM ter visto o relatorio -- isso e o portao independente descrito em quatro linhas.

```
"ss.verify.screen_action_does(\"GestaoPedidos\", \"OnClickCloseNovo\",\n    not_calls=\"GP_ExcluirPedido\")  # previne o bug do close->delete" (SSAM_VISION.md:597-598); "### Prioridade 1: `ss.review()` (revisao obrigatoria pre-publish)\n\n**Esforco:** ~300 linhas Python" (:552-554); e o que ele nao viu: "4. **Enforcement** - ``enforce_against_evidence()`` checks that a WidgetNode\n       tree contains all widgets mentioned in relevant requirement bullets." (_requirements.py:13-14)
```

### PROMESSA NAO CUMPRIDA, CONFIRMADA COM AGRAVANTE. `explore` declara --reason (com choices), --missing-symbol e --failure-receipt, e o help afirma que leituras de fonte interna 'require public-contract-

`runtime` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam_agent_runtime\cli.py:388-407 (declaracao dos tres) vs 3406-3415 (a chamada, com os cinco argumentos visiveis); C:\Users\andre\GitSSAM\ssam_agent_runtime\exploration.py:73-82 (assinatura de run_exploration)`

**Resolve:** portao independente (46); handoff/registo (60)

**Como se aproveita:** Documento, e aviso ao kernel do Anvil. Uma flag com texto imperativo que nada le e PIOR do que nao ter flag: o agente cumpre-a, sente-se autorizado, e o ledger nao guarda a justificacao. No Anvil, uma opcao declarada tem de ser lida ou nao existe -- e isso e testavel em CI (toda a flag do parser aparece no corpo do handler). Confirmo o veredicto e acrescento que o --failure-receipt e do mesmo tipo: 'Canonical failed/partial receipt required for repair exploration' (linha 406), e tambem nao e lido.

**Caminho nativo:** Nao aplicavel (nao e questao de Studio). O conserto e de duas linhas: passar os tres campos a run_exploration e grava-los no ledger.

**O que sobra se se deitar a implementacao fora:** A INTENCAO, que e boa: leitura exploratoria devia exigir razao auditavel, e leitura de fonte interna devia exigir prova de que o contrato publico nao a cobre. Guarde-se o requisito; deite-se fora a implementacao, que nao existe.

```
explore_parser.add_argument(
        "--reason",
        choices=["public-contract-missing", "repair-evidence", "user-requested"],
        default=None,
        help=(
            "Auditable reason for exceptional exploration. Internal source/script "
            "reads require public-contract-missing."
        ),
    )
```

### FALSA DIFERENCA A ESCALA -- o total esta certo (17 de 43) e a conclusao esta certa, mas a lista de entradas citada esta errada e a contagem do grep esta errada por um factor de 6

`migracao` · obtido por `reflection`

**Ficheiro:** `C:\Users\andre\GitSSAM\docs\tasks\2026-05-10-odc-signatures-compatibility.md (entradas [I] da familia app/modulo: 3, 4, 18, 19, 20, 80, 81, 82, 83, 84, 85, 86, 87, 88, 90, 91, 96). Contraprova: C:\Users\andre\ODC3\decompiled\o11\ServiceStudio.Presenter\ServiceStudio.Presenter\IServerPagePresenter.cs:47 e :85, mais 10 usos em prs-viwvtsct.cs; zero em C:\Users\andre\ODC3\decompiled\odc`

**Resolve:** saber o que a plataforma permite (22); erros que nao ensinam (52); enderecamento entre corridas (36)

**Como se aproveita:** A regra aterra tal e qual: nunca amarrar um verbo ao nome de um presenter. Mas a CITACAO nao pode ser importada como esta. Duas correccoes medidas: (a) a lista escrita como '3, 4, 18, 19, 20, 82-91, 94...' inclui a entrada 89, que e `[B]` e nao `[I]`, e a 94, que e `[C]`, e esquece 80, 81 e 96 -- o total de 17 so sai por acaso; (b) o grep 'ShowApplicationModules/CreateApplicationModule = 2 ocorrencias no o11' esta errado: sao 12 (10 + 2). A conclusao (existe no o11, ZERO no odc) aguenta e fica mais forte, nao mais fraca.

**Caminho nativo:** Nao ha equivalente no Studio ODC, e essa e a resposta: no ODC apps e modulos criam-se pela API do Portal. C:\Users\andre\SSAM-Hybrid-ODC\portal\catalog\specs\asset-repository-api-v1.json (AssetRepository_CreateAssetRevision, AssetRepository_ListAssets) -- NAO ABRI este ficheiro nesta corrida, por apurar se as linhas :30 e :135 sao as citadas.

**O que sobra se se deitar a implementacao fora:** O facto de arquitectura, limpo: ODC Studio nao gere apps nem modulos. E a medida do vies, que se mantem: 17 de 43 'incompatibilidades' eram da ferramenta e nao da plataforma.

```
Contagem por script sobre o ficheiro: "[I] count: 43", "entradas numeradas: 461". Entradas desmentidas: `89. [B] \`ss.app.rename_module(...)\`` e `94. [C] \`ss.module.get_name(...)\``. Grep no dump o11: IServerPagePresenter.cs:85 `void ShowApplicationModules(ObjectKey appKey, string appName, bool isNew, bool showNativeTab = false);` e :47 `void CreateApplicationModule(ApplicationInfo applicationInfo);`, mais prs-viwvtsct.cs:353, :1920, :4585, :7048, :7157, :7304, :7312, :7453, :7488, :7523.
```

### Mutacao feita, veredicto 'a plataforma nao suporta': confirmado a letra -- mas o readback que prova a criacao existe numa entrada so, nao nas tres citadas

`migracao` · obtido por `trace-ou-interposicao`

**Ficheiro:** `C:\Users\andre\GitSSAM\docs\tasks\2026-05-10-odc-signatures-compatibility.md:136-140 (entrada 18), :458-461 (entrada 82), :463-466 (entrada 83)`

**Resolve:** handoff/registo (60); erros que nao ensinam (52); nao destruir intencao (24)

**Como se aproveita:** Regra dura no kernel do Anvil, intacta: um timeout de OBSERVACAO nunca pode virar veredicto sobre a MUTACAO. Mas a citacao tem de ser aparada: so a entrada 18 traz a prova de que o servidor criou ('showed the app exists/listed with key sQQHa6CCdUe2HbfTkdSyAg'). A 82 diz apenas 'server-side creation MAY occur' e `visibleInHome=False`; a 83 nao tem readback nenhum. Importar as tres como 'mutacao provada' repete o pecado que o achado denuncia -- afirmar mais do que se observou.

**Caminho nativo:** Resposta sincrona com chave pela API do Portal em vez de poll a UI -- por apurar nas linhas concretas do asset-repository-api-v1.json, que nao abri.

**O que sobra se se deitar a implementacao fora:** O anti-padrao, que vale mais que o item: portao de sucesso construido sobre refresh de UI. E a nota util de que a criacao no ODC e assincrona em relacao ao que o Studio mostra.

```
Entrada 18, literal: "The call failed with `SSAMError: ODC app 'SSAMODCSignature018' was created, but it did not appear in the refreshed home list within 30s.`" e "Notes: Follow-up live check after `ss.module.close()` showed the app exists/listed with key `sQQHa6CCdUe2HbfTkdSyAg`, so server creation happened but the public method did not complete its contract of opening/returning successfully." Entrada 82, literal e mais fraca: "This is the ODC home-list refresh issue: server-side creation may occur, but the public method cannot reliably complete..."
```

### SEGUNDA FALSA DIFERENCA confirmada: as 6 entradas [I] da familia aggregate estao refutadas por um job verde do Anvil que constroi o aggregate completo no ODC pela API nativa

`migracao` · obtido por `reflection`

**Ficheiro:** `Alegacao: C:\Users\andre\GitSSAM\docs\tasks\2026-05-10-odc-signatures-compatibility.md:903-930 (entradas 171 a 176). Refutacao: C:\Users\andre\Anvil\tests\jobs-odc\aggregate-full.json:47-71`

**Resolve:** saber o que a plataforma permite (22); complexidade da saida (63)

**Como se aproveita:** Deitar fora os seis veredictos. O que aterra no kernel ja la esta. Um reparo: a entrada 171 e ainda pior do que o achado diz -- as Notes dela terminam em `tried: []`, ou seja nao ha sequer uma tentativa registada, so 'raised SSAMError'. A entrada 172 e que traz a AmbiguousMatchException do .NET.

**Caminho nativo:** Ja provado e em producao: IAliasedSource, IJoin, IFilter, ISort, IGroupByAttribute, IAggregatedAttribute criados por ops declarativas em aggregate-full.json, sobre a fixture tests/fixtures/odc/wrightflood-personal-r8.oml, com `expectValid: true` e `expectedMessages: []`.

**O que sobra se se deitar a implementacao fora:** Uma licao de metodo: 'SSAMError' nao e mensagem da plataforma. E o _why de aggregate-full.json:56, que ensina o que a mensagem da reflection escondia.

```
Alegado, entrada 171 literal: "- Live evidence: python scripts/demo/odc_signature_checks/check_171_212_data_aggregate_live.py invoked ss.aggregate.add_aggregate_attr on ODC1 and raised SSAMError." / "- Notes: add_aggregate_attr(Sum(ODCAggEntity171.Score)) failed. tried: []". Refutado por aggregate-full.json:50 `{"op": "create", "parent": "$agg", "type": "IJoin", "as": "$join", ...}` e :56 `{"op": "create", "parent": "$agg", "type": "IFilter", "args": {"condition": "WfAggOrder.Total >= MinTotal"}, "as": "$flt", "_why": "... o aggregate nao le variaveis de fora, entao a plataforma cria um IImplicitParameter dentro dele"}` e :58 ISort e :62 IGroupByAttribute e :65 IAggregatedAttribute.
```

### AI Mentor O11: citacoes literais confirmadas nos dois ficheiros. quality_gate esta implementado, falha com contagem global, e o bloqueio e mesmo so de credenciais (SSAM_O11_AI_MENTOR_API_KEY e SSAM_O1

`boas-praticas` · obtido por `documentacao-da-outsystems`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam-declarative\ssam_declarative\o11_platform_api\_ai_mentor.py:84-115 e C:\Users\andre\GitSSAM\ssam-declarative\docs\platform-apis\2026-05-20-o11-live-validation-status.md:66`

**Resolve:** portao independente (46).

**Como se aproveita:** Documento, por agora. Nao migrar para o Anvil enquanto for gate cego por contagem. Se um dia correr, so acoplado a /TechnicalDebt_Category.

**Caminho nativo:** A API AI Mentor Studio v1 e o caminho nativo e o cliente esta correctamente escrito (technical_debt_application/_category/_level/_team estao todos implementados como metodos). Falta credencial, nao caminho. Confirmado.

**O que sobra se se deitar a implementacao fora:** Existe API oficial de divida tecnica com quatro cortes (application, category, level, team) e o bloqueio e puramente de credenciais.

```
_ai_mentor.py:93 e :103-106 -- "        \"\"\"Fail when the technical debt finding count exceeds a threshold.\"\"\"" ... "        result = {\n            \"passed\": finding_count <= max_findings,\n            \"findingCount\": finding_count,\n            \"maxFindings\": max_findings," /// o11-live-validation-status.md:66 -- "| Missing AI Mentor credentials: `SSAM_O11_AI_MENTOR_API_KEY` and `SSAM_O11_AI_MENTOR_ACTIVATION_CODE`. | `o11.ai_mentor.quality_gate`, ..."
```

## Obsoleto

### CITACAO CONFIRMADA, MAS O comoFoiObtido ESTA ERRADO NA PARTE QUE ELE MANDA PORTAR. O guard da regra 1 esta mesmo desligado por defeito e auto-declarado legacy (verificado nas linhas 39-41 e 156-158). 

`regras` · obtido por `reflection`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam-declarative\ssam_declarative\_agent_runtime_guard.py -- import inspect L10, MUTATING_METHODS L20-35, _is_mutating_method L142-147, gate desligado L39-41, mensagem legacy L150-159, _resolve_user_script L328-346, subprocess timeout=120 L244-266, max_age 21600 L92`

**Resolve:** portao independente 46 | enderecamento entre corridas 36

**Como se aproveita:** Kernel do Anvil: adoptar a inversao (privilegio pelo env do runner) e NAO o guard. Do guard so migra o hash-binding. Riscar a recomendacao de portar o _resolve_user_script.

**Caminho nativo:** A inversao ja existe e e mais simples: runner.py:3483-3487 injecta `env["SSAM_TARGET"] = str(resolved_target)` e a SDK so abre o portao apertado quando esse env esta presente (ss.py:682-684 `self._enforce_write_readiness = bool(target or os.environ.get("SSAM_TARGET", "").strip())`, consumido em ss.py:1409-1410). Confirmei ambos os ficheiros. Mas ATENCAO: o `_resolve_user_script` nao tem caminho nativo -- e reflection sobre a stack do proprio Python e nao ha equivalente declarativo. Se o Anvil quer saber quem chamou, o caminho nativo e o chamador DECLARAR-SE no plano JSON, nao o kernel adivinhar pela stack.

**O que sobra se se deitar a implementacao fora:** Sobra UMA ideia boa, nao duas: o SHA256 do ficheiro validado ligado ao receipt, para que "validado" nao valha para bytes diferentes (_file_sha256 L349-354, comparado em L234). A outra -- as 3 linhas do _resolve_user_script -- NAO deve ser portada: e reflection de stack para inferir uma coisa que o chamador podia simplesmente declarar.

```
L10: "import inspect" -- L145: "if method == \"press_key\" and str(params.get(\"key\", \"\")).upper() in {\"F5\", \"CTRL+S\", \"CONTROL+S\"}:" -- L330-333: "    for frame in inspect.stack()[2:]:\n        filename = frame.filename\n        if not filename or filename.startswith(\"<\"):\n            continue" -- L39-41: "    config = _load_guard_config()\n    if not config.get(\"enabled\"):\n        return" -- L156-158: "This legacy route guard is no longer part of the default workflow.\nDisable it with:\n  python -m ssam_agent_runtime guard disable"
```

### CONFIRMADO. O orcamento cumulativo de exploracao esta desactivado e os parametros ficaram como compatibilidade; budget_for devolve sempre 0.0 com sentinela de 'unlimited'. O que ficou vivo e o timeout

`regras` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam_agent_runtime\exploration.py L30-45; cli.py L363-401; AGENTS.md L28-29`

**Resolve:** inspect: tamanho e filtro 87 | handoff/registo 60

**Como se aproveita:** Kernel do Anvil: timeout duro por leitura + ledger por task-id, SEM quota cumulativa. E --reason/--missing-symbol como forma de transformar cada mergulho no codigo interno num item de backlog de documentacao.

**Caminho nativo:** O que ficou vivo e nativo e util: hard_timeout_seconds=150.0 e warning_after_seconds=30.0 por comando, mais ledger por task-id. O orcamento cumulativo foi o pedaco que nao sobreviveu.

**O que sobra se se deitar a implementacao fora:** Dois factos praticos: (1) 150s e o tecto por comando de leitura a que este projecto convergiu depois de o usar a serio, com aviso aos 30s; (2) orcamentos CUMULATIVOS de exploracao foram tentados e abandonados -- o Anvil nao precisa de repetir a experiencia. Fica timeout por comando + ledger, nao quota por sessao. Util tambem: `explore --reason` com valores fechados e `--missing-symbol`, que obrigam a nomear o simbolo publico em falta quando se vai ao codigo interno.

```
exploration.py L30-45: "@dataclass(frozen=True)\nclass ExplorationLimits:\n    \"\"\"Default exploration envelope agreed for SSAM agent tasks.\"\"\"\n\n    hard_timeout_seconds: float = 150.0\n    warning_after_seconds: float = 30.0\n    # Deprecated compatibility inputs. Cumulative exploration budgets are no\n    # longer enforced; keeping these fields avoids breaking existing callers.\n    initial_budget_seconds: float = 150.0\n    repair_budget_seconds: float = 90.0\n\n    def budget_for(self, phase: str) -> float:\n        if phase not in {\"initial\", \"repair\"}:\n            raise ValueError(\"exploration phase must be 'initial' or 'repair'.\")\n        # Zero is the backwards-compatible result sentinel for \"unlimited\".\n        return 0.0"
AGENTS.md L28-29: "- Agrupe leituras exploratorias sob um task-id estavel:\n  `python -m ssam_agent_runtime explore --task-id <id> --phase <fase> -- <comando>`."
```

### CONFIRMADO, com uma imprecisao. A sessao 8 com commit 6051980 esta em UNIFICATION_PLAN.md:21, a tabela de gotchas existe e tem exactamente 12 linhas (:764-775), e o padrao de erro esta em :620-623. Im

`declarative` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam-declarative\UNIFICATION_PLAN.md:21, :506, :542, :620-623, :758-775; C:\Users\andre\GitSSAM\ssam-knowledge-mcp\server.py:321`

**Resolve:** handoff/registo 60

**Como se aproveita:** Concordo: da parte de migracao nao continua nada. Ficam a tabela de gotchas e o padrao de qualidade. Aviso para quem herdar: a linha 765 da tabela tem um erro proprio -- diz "`set_record_list` deve usar `invoke(\"set_CycleTarget\")`", que mistura duas coisas distintas (set_record_list usa SetRecordList; o CycleTarget e outra propriedade). Copiar a tabela sem ler propaga o erro.

**Caminho nativo:** Nao se aplica: plano de refactoring interno ja executado. O `comoFoiObtido` que ele pos ("documentacao-da-outsystems") esta errado -- a propria linha 760 diz que os gotchas "foram descobertos em producao".

**O que sobra se se deitar a implementacao fora:** (a) A tabela de 12 gotchas, confirmada linha a linha: set_sql (setProperty destroi as chavetas {Entity}, :764); REST structures via IRestClient.CreateStructure (:772); ExcelToRecordList output sem `.List` (:771); SQL output structure antes do SQL (:775); coordenadas de layout minimas 800, "menor que 800 causa sobreposicao total" (:770); `find_element` com filtro de tipo devolve o elemento sem wrapper ['results'] (:773). (b) O padrao de mensagem de erro que diz o que foi encontrado contra o que era esperado (:620-623) -- literalmente o objectivo do Anvil, ja escrito.

```
"- [x] Sessao 8 - Finalizacao (`REFERENCE.md`, `CLAUDE.md`, arquivar `ssam/`) - commit 6051980" (:21); "Estes erros foram descobertos em producao e DEVEM ser documentados nos modulos relevantes:" (:760); "| Layout coords minimas: 800 | `_flow.py` | Menor que 800 causa sobreposicao total |" (:770); "raise SSAMError(\n    f\"find_element('{name}', '{element_type}') found 0 matches. \"\n    f\"Types available: {[r['type'] for r in results]}\"\n)" (:620-623)
```

### Orcamento de leitura do explore: morto mas ainda impresso. Confirmado nos tres sitios. ExplorationLimits mantem initial_budget_seconds/repair_budget_seconds como 'Deprecated compatibility inputs' e bu

`runtime` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ssam_agent_runtime\exploration.py:30-45; C:\Users\andre\GitSSAM\ssam_agent_runtime\cli.py:3434-3438; C:\Users\andre\GitSSAM\ssam_agent_runtime\README.md:56-59`

**Resolve:** complexidade da saida (63); handoff/registo (60)

**Como se aproveita:** Documento. Para o kernel fica o que ficou de pe: limite DURO por operacao (nao cumulativo), aviso a meio caminho, e saida completa sempre preservada num caminho nomeado mesmo quando o terminal e truncado (confirmei as duas linhas que o dizem ao utilizador em cli.py:3441-3443). Foi a tentativa de orcamento cumulativo que se revelou errada, e isso e um resultado util e nao uma falha.

**Caminho nativo:** Nao aplicavel.

**O que sobra se se deitar a implementacao fora:** O veredicto experimental: limites cumulativos de leitura foram tentados e abandonados; limites por comando mais retencao integral do output ficaram. E o campo morto que ainda se imprime e um exemplo pequeno e perfeito da familia 'complexidade da saida' -- tres campos de budget no ExplorationResult que nao significam nada.

```
# Deprecated compatibility inputs. Cumulative exploration budgets are no
    # longer enforced; keeping these fields avoids breaking existing callers.
    initial_budget_seconds: float = 150.0
    repair_budget_seconds: float = 90.0

    def budget_for(self, phase: str) -> float:
        ...
        # Zero is the backwards-compatible result sentinel for "unlimited".
        return 0.0
```

### Deriva documentada de porta, confirmada nos dois lados. O SETUP_GUIDE.md diz duas vezes que ODC Studio expoe SSDiagnostics em 4511 (no aviso das linhas 8-12 e na tabela 'Port Map' da linha 253); o run

`runtime` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\ss-patcher\SETUP_GUIDE.md:8-12 e 253 vs C:\Users\andre\GitSSAM\ssam_agent_runtime\app_bootstrap.py:13-25 e 402-412`

**Resolve:** binario velho (15); saber o que a plataforma permite (22)

**Como se aproveita:** Documento (correccao) e principio para o kernel: o mapa alvo->porta tem UMA fonte e o proprio codigo ja o declara. Documentos que repetem constantes ficam velhos; devem apontar para a fonte, nao copia-la. Nota de mitigacao que o achado nao deu: o runtime nao rebenta com 4511 -- aceita-o e resolve-o para odc1 (app_bootstrap.py:410, validator.py:2690-2694), ou seja o guia velho falha de forma silenciosamente compativel, que e o pior tipo de falha para diagnosticar.

**Caminho nativo:** Nao aplicavel.

**O que sobra se se deitar a implementacao fora:** Que a fonte unica ja existe e esta testada (ssam-declarative/tests/test_target_ports.py, nomeado no comentario) -- e que um guia de setup copiou o valor e apodreceu.

```
# Fonte única do mapa alvo→porta é o SDK (ssam_declarative._constants),
# consumido também por SS(target=...). Fallback local mantém o runner
# funcional sem o SDK instalado; a sincronia é testada em
# ssam-declarative/tests/test_target_ports.py.
```

### Datas e caducidade: confirmado a letra nas duas fontes. O ficheiro de assinaturas declara-se caduco a si proprio e o total de 461 entradas bate certo com a contagem

`migracao` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\GitSSAM\o11_odc_migration_hub\knowledge\compatibility_catalog.json:3; C:\Users\andre\GitSSAM\docs\tasks\2026-05-10-odc-signatures-compatibility.md:5`

**Resolve:** binario velho (15); enderecamento entre corridas (36)

**Como se aproveita:** Regra de importacao, e endureco-a com o que medi: nenhum `[C]`/`[I]`/`[B]` individual entra em lado nenhum como facto. Distribuicao verificada: 373 [C], 43 [I], 42 [B], 3 [N/A], 461 no total -- e ja mostrei que pelo menos 23 dos 43 [I] nao sao da plataforma. So entram (a) mensagens LITERAIS da plataforma reconferidas no dump e (b) factos que um job do Anvil reprove. O catalogo do hub entra inteiro mas datado, porque a fonte e citavel e re-hashavel.

**Caminho nativo:** Nao aplicavel.

**O que sobra se se deitar a implementacao fora:** A honestidade do cabecalho, que vale a pena copiar: um corpus medido que diz a data da medicao e o que ja nao se deve acreditar vale mais do que um corpus que se apresenta como verdade permanente.

```
compatibility_catalog.json:3 literal: `"snapshotDate": "2026-08-09",`. Cabecalho do ficheiro de assinaturas, linha 5 literal: "> **last_proven_at (amostral): 2026-07-04** -- re-probe via `scripts/gaps/odc_signatures_reprobe.py` (runner --probe, odc1) ... Checklist completo continua fotografia de 2026-05-10 -- re-probe por familia antes de confiar num [I]/[B] especifico." Contagem medida: 461 entradas numeradas, 373 [C] / 43 [I] / 42 [B] / 3 [N/A].
```

## Por apurar

### ATAQUE PASSOU NO ESSENCIAL, MAS A ATRIBUIÇÃO CONTINUA POR APURAR — e o outro agente teve razão em não a fechar. #149/#150/#150b: widgets adicionados a um block aparecem no `ss.inspect.dom` (mirror diz

`friccoes` · obtido por `trace-ou-interposicao`

**Ficheiro:** `C:\Users\andre\GitSSAM\docs\tasks\2026-09-03-friccoes-ssam-kkr-time-entry.md:242-244 e :248; contrato contraditório em C:\Users\andre\GitSSAM\ss-patcher\SSDiagnostics\ModelMirror.cs:9-15`

**Resolve:** inspect: tamanho e filtro (87) e não destruir intenção (24)

**Como se aproveita:** Documento de risco para o Anvil com a pergunta certa por responder (uma instância vs três), não com a conclusão errada. A lição de desenho aproveita-se JÁ e não depende da causa: quando o caminho de leitura e o artefacto final podem divergir, a prova de trabalho faz-se no ARTEFACTO FINAL, nunca na leitura. O agente publicou 4 vezes a olhar para um nome que nunca ia aparecer porque acreditou na leitura.

**Caminho nativo:** por apurar — exige reproduzir com UMA só instância de Studio antes de culpar o espelho. Enquanto isso não for feito, atribuir ao ModelMirror é adivinhar, e adivinhar mal aqui custa caro: leva a desmontar uma cache que mede 1 ms contra 76 s.

**O que sobra se se deitar a implementacao fora:** A regra — prova no artefacto de saída, nunca na cache de leitura — e o método barato que apanhou o problema: buscar o bundle `.mvc.js` com no-store e comparar com o que o `dom` afirma. Isso deve virar verbo. Sobrevive inteiro mesmo que a causa acabe por ser ambiental.

```
Log :243 literal: "Widgets ADICIONADOS a um block já existente ... aparecem no `ss.inspect.dom` (mirror) mas NÃO no bundle publicado (`AppTopShell.mvc.js` recompilado com o mesmo tamanho, 0 ocorrências de `kkr-avatar`/`kkr-user-label`) ... Suspeito: ModelMirror a aceitar mutações que o Studio real rejeita." CONTRA, :248: "Fica em aberto só o avatar + nome no canto direito da top bar (#150: edições a block não chegam ao compilado enquanto houver mais de uma instância com o módulo)." E o contrato, ModelMirror.cs:10-15: "//   - a stale mirror (any write since the build) never serves — callers fall\n//     back to today's walk while a background rebuild runs;" ... "//   - any verification failure marks the mirror stale and the caller walks."
```

### O NEGATIVO CENTRAL DELE ESTA ERRADO COMO ESTA ESCRITO, e refuta-se com os achados dele proprio. Ele diz: 'as unicas [mensagens] que contam ELEMENTOS sao More than one exception handler e More than one

`boas-praticas` · obtido por `api-nativa-do-modelo`

**Ficheiro:** `C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model\OutSystems.Model.Verify.Generated.VerifyMessageIdResources.Generated.resx (varrimento proprio, 28 acertos); textos confirmados por extraccao XML das entradas JSNodeTooLarge, ConsecutiveServerInteractions e Entity_SuggestPartialUpdateBehavior_Many`

**Resolve:** complexidade da saida (63).

**Como se aproveita:** Documento + kernel, com a formulacao CORRIGIDA: 'a OutSystems nao define quanto e demais para locais/screen actions/widgets por ecra' -- e NAO 'a OutSystems nao conta elementos', que e falso. Kernel: publicar inventario por ecra (contagem, nao julgamento). O limiar, se existir, e politica do dono e configuravel.

**Caminho nativo:** O QUE SOBREVIVE, e sobrevive bem: nao existe regra nativa que conte VARIAVEIS LOCAIS, SCREEN ACTIONS ou WIDGETS de um ecra. Procurei 'local variable|screen action|widget' nas 556 e os 22 acertos sao todos regras de tipo/validacao (NamedWidgetRequired, InvalidVariable_MultiWidget, EmailScreen_UnsupportedLocalVariableType...), nenhuma de contagem. Os 33 locais e as 54 screen actions continuam sem produzir warning. A contagem esta disponivel no inspect: q100_describe_portal.py:225 confirma as coleccoes.

**O que sobra se se deitar a implementacao fora:** O negativo estreito (locais/screen actions/widgets) e a licao de metodo que vale mais: um varrimento por TEXTO de mensagem nunca prova ausencia de limiar, porque o limiar esta no codigo e a mensagem diz 'large'/'several'. Para provar ausencia e preciso ler InnerVerify, nao o .resx.

```
JSNodeTooLarge TEXT => "'{0}' seems to include a JavaScript library, as it contains a large amount of code. To use an external JavaScript library, add it as a Script element instead." (nenhum numero, nenhuma palavra-chave de contagem) /// Entity_SuggestPartialUpdateBehavior_Many TEXT => "Entities with a large number of attributes should have their 'Update Behavior' set to 'Changed Attributes'." (conta elementos, e ele diz que nao ha nenhuma) /// q100_describe_portal.py:225 -- "    \"ClientActions\", \"DataActions\", \"DataSets\", \"LocalVariables\","
```

### O buraco do 'handler vazio': CONFIRMADO, e o negativo aguenta. Verifiquei os textos dos tres candidatos nativos e nenhum cobre o caso. WebBlock_CustomEventNotTriggered e sobre o evento nao ser dispara

`boas-praticas` · obtido por `observacao-manual`

**Ficheiro:** `C:\Users\andre\SSAM-Hybrid-ODC\docs\ONDE-FORAM-AS-8-HORAS.md:2948 (e o contexto :2942-2947), cruzado com os tres ids no resx`

**Resolve:** complexidade da saida (63) e erros que nao ensinam (52).

**Como se aproveita:** Kernel do Anvil como verificacao propria DECLARADA e marcada NAO-NATIVA, para nunca ser confundida com um warning da plataforma. E das poucas regras que vale a pena o Anvil ter de fabrico proprio, porque se prova que o nativo nao a tem.

**Caminho nativo:** Nao existe regra nativa -- confirmado por leitura dos tres textos mais proximos. O caminho para a implementar e sem reflection: inspect do handler -> children('Nodes') -> se so Start->End, esta vazio. As mesmas coleccoes ja usadas em q100_describe_portal.py:225.

**O que sobra se se deitar a implementacao fora:** O predicado exacto e a prova de que os tres avisos nativos vizinhos nao o cobrem -- o que justifica escreve-lo sem duplicar trabalho da plataforma.

```
ONDE-FORAM-AS-8-HORAS.md:2948 -- "Mas mostra o custo do desenho anterior: uma tela com 33 locais e 54 screen actions escondeu um campo que nao grava. Uma checagem generica no builder ('evento de bloco declarado e handler vazio na instancia') apanharia isto sem ninguem ir ler." /// resx -- "UnusedReferenceGlobalEvent|Warning|Unused event|'{0}' event is missing a handler action." e "EventHandlerRequiredAction|Error|Required Property Value|{0} event handler must be set."
```


## O que NAO trazer

Sessenta e quatro problemas de abordagem, catalogados para nao serem reinventados com boa fe.

### Chamar "VIVO" a uma tabela escrita a mao. O help do `builtins` anuncia "Catalogo VIVO das funcoes builtin de expressao OutSystems" e a docstring repete "Catalogo vivo" -- mas "vivo" significa apenas "

`capabilities`

E a palavra que faz o agente parar de verificar. Um catalogo anunciado como vivo nao se confronta com a fonte -- e foi assim que a contradicao do Round (min_args=2 contra isOptional="true" no modelo nativo) e a do `mod`/`Mod` sobreviveram. A palavra "vivo" deve ficar reservada para o que e lido do objecto no momento da pergunta (como o `sig` faz); para tabelas curadas o rotulo honesto e "curado, ultima verificacao <data>, fonte <ficheiro>".

```
cli.py:292-294 -- "Catalogo VIVO das funcoes builtin de expressao OutSystems: assinatura/aridade exatas e o mapa alucinado->correto (Upper->ToUpper, Now->CurrDateTime...)" e cli.py:3585-3588 -- "Catalogo vivo de builtins de expressao OS (anti-caçada, anti-stale).\n\n    Le direto os registries de ssam_declarative._os_builtins" CONTRA _os_builtins.py:20-22 -- "This module stores the known arity rules in a simple table and offers a walker that extracts top-level function calls from an OS expression string" e o registo literal _os_builtins.py:107-111
```

### Marcar "(auto-generated)" um ficheiro que nenhum gerador escreve, e deixar duas copias divergirem nos dois sentidos.

`capabilities`

Compra confianca que nao existe e desliga a desconfianca no ponto onde ela era util. E, como verifiquei, e ainda pior do que o achado dizia: nao ha um ficheiro "a frente" e outro "stale" -- cada um tem entradas que o outro nao tem, portanto qualquer regra global ("a raiz ganha", "corre o gerador") perde dados. Regra para o Anvil: a marca de proveniencia so pode ser escrita por quem gera, e um documento derivado nunca pode ser tambem editavel a mao.

```
SIGNATURES.md:1 -- "# SSAM API Signatures (auto-generated)" | gen_signatures.py:485-486 -- "target = REPO_ROOT / \"docs\" / \"SIGNATURES.md\"" (REPO_ROOT = ssam-declarative, nao a raiz) | sha256 raiz B4A719C3... != espelho 92854515... | divergencia nos dois sentidos: espelho:205 tem "- `ss.whereami(self) -> 'dict'`" que a raiz nao tem; raiz:203 tem "### `ss.agent`" que o espelho nao tem
```

### Mandar "ler o SIGNATURES.md uma vez no inicio da sessao" como rota de descoberta -- 293 KB / 1350 linhas injectados por sessao, e como "Core command" no ficheiro que o agente le primeiro.

`capabilities`

Contradiz o desenho anti-varredura do proprio repo (que criou `sig`, `recipe` e o indice justamente para nao ler ficheiros inteiros) e nao funciona: 3 dos verbos que a rota de intencao recomenda nao estao la, e a anatomia do ButtonGroup estava la e nao foi encontrada. Descoberta e comando, nao ficheiro.

```
SIGNATURES.md:26 -- "Compact reference for every public method of the SSAM SDK. Read this **once** at session start instead of vasculhando individual `.py` files." | AGENTS.md:92-96 -- "Core commands:\n\n```powershell\nGet-Content .\\CAPABILITIES.md\nGet-Content .\\SIGNATURES.md" | contra gen_capabilities_index.py:3-4 -- "\"consultar\" virava leitura integral por sessao"
```

### Ponteiros para documentos e cards como strings livres dentro de uma tabela curada em codigo, sem gate. O campo `recipe` de cada Intent do how_cmd e texto solto.

`capabilities`

Ja partiu em 2 dos 6 ponteiros: "docs/33_incremental_action_flow_edit.md" (2 Intents) aponta para uma raiz onde o ficheiro nao existe, e "CAPABILITIES.md ssam.integrations.rest_wrapper" nomeia um card inexistente. Quando o ponteiro falha o agente cai na varredura integral -- o custo que a rota existia para evitar. O gate irmao para o CAPABILITIES.md ja existe e prova que validar citacoes e barato.

```
how_cmd.py:28-29 -- "note: str = \"\"\n    recipe: str = \"\"" (campos de texto livre) | how_cmd.py:39 "docs/33_incremental_action_flow_edit.md" e :138 "CAPABILITIES.md ssam.integrations.rest_wrapper" | Test-Path da raiz -> False (real em ssam-declarative/docs); '^### .*rest' no CAPABILITIES.md -> so :1899 rest_client e :1945 exposed_rest_api
```

### Uma tabela de intencoes escrita a mao (CURATED, 21 entradas -- nao 25) como o mecanismo de intencao->verbo, mantida em codigo Python em paralelo com os Intent que ja existem nos 142 cards.

`capabilities`

Cresce a mao para sempre, nao tem gate nenhum, e ja esta dessincronizada do corpus que devia indexar. O contraste dentro do mesmo repo e a licao: o `recipe` recusou-se explicitamente a curar categorias a mao e deixou a taxonomia EMERGIR dos verbos realmente usados. A curadoria e o sitio certo para as notas anti-armadilha; e o sitio errado para o indice.

```
how_cmd.py:34 -- "CURATED: tuple[Intent, ...] = (" seguido de 21 entradas Intent( (linhas 35,40,45,49,52,56,60,64,68,71,75,78,81,84,89,96,104,110,118,124,131) ate :139 | contra recipe_index.py:21-23 -- "A taxonomia emerge dos verbos — nao ha classes curadas nem templates escritos a mao; combinacoes ineditas degradam com honestidade para o checklist \"sem prova viva\" em vez de fingir cobertura."
```

### Despejar por defeito ate 400 linhas do corpo de um script no terminal como resposta a uma consulta (`recipe --max-lines` default=400).

`capabilities`

A rota foi feita para nao ler ficheiros inteiros e por defeito devolve quase um ficheiro inteiro, mais os ponteiros por verbo e o checklist. O botao certo ja existe (0 = so apontar) mas esta do lado errado do defeito: a consulta devia dar enderecos e o corpo devia ser pedido. E a familia "complexidade da saida" (63) reintroduzida pela ferramenta que a combatia.

```
cli.py:346-349 -- "recipe_parser.add_argument(\n        \"--max-lines\", type=int, default=400,\n        help=\"cap de linhas do corpo da moldura (0 = so apontar, sem corpo)\",\n    )" | cli.py:3300-3306 -- "for line in lines[:max_lines]:\n                    print(\"  \" + line)\n                if len(lines) > max_lines:\n                    print(\n                        f\"  ... TRUNCADO ({len(lines) - max_lines} linhas\"\n                        \" restantes — abra o caminho acima)\"\n                    )"
```

### Guardar o registo de provas (journals que sustentam o `recipe`) numa cache por-maquina enderecada por sha1 do caminho absoluto do repo, com uma variavel de ambiente como unico escape.

`capabilities`

Nao sobrevive a um clone, a uma mudanca de pasta nem a um handoff: nesta maquina a pasta nem existe e a variavel esta vazia, portanto `recipe` responde 0 provas. O valor todo da rota e dizer "isto ja foi provado" -- afirmacao que so vale se o proximo agente puder cita-la. E o escape por variavel de ambiente nao conserta nada: so faz o defeito desaparecer nas maquinas de quem o configurou, que sao precisamente as que nao o reportam.

```
paths.py:29-37 -- "configured = os.getenv(\"SSAM_AGENT_RUNTIME_HOME\")\n    if configured:\n        return Path(configured).expanduser().resolve()\n\n    repo_id = hashlib.sha1(str(repo_root.resolve()).encode(\"utf-8\")).hexdigest()[:12]" | recipe_index.py:157 -- "runs_dir = runtime_cache_dir(repo_root) / \"runs\"" | verificacao: Test-Path C:\Users\andre\AppData\Local\SSAM -> False; $env:SSAM_AGENT_RUNTIME_HOME -> vazio
```

### Provar ausencia de uma capacidade por busca de string num markdown, em vez de perguntar ao resolvedor. Concretamente: `Select-String -Pattern ([regex]::Escape($termo)) -SimpleMatch`, que foi como o ac

`capabilities`

Essa combinacao e silenciosamente falsa para qualquer nome com ponto: o `[regex]::Escape` transforma "ca.javascript" em "ca\.javascript" e o `-SimpleMatch` procura a barra invertida literal, devolvendo 0 SEMPRE. Reproduzi o falso zero e depois o resultado correcto. Mas mesmo com o regex certo a conclusao seria errada, porque o gerador documenta cada metodo UMA vez na classe que o define e `ScreenActionBuilder` herda de `ActionBuilder`: a capacidade esta em `sa.javascript`. Duas fontes de erro empilhadas, e o resultado foi um verbo declarado em falta que nao falta -- exactamente a armadilha "diferenca que nao e diferenca" que ja custou duas conclusoes erradas a este projecto.

```
SIGNATURES.md:662 -- "- `sa.javascript(self, name: 'str', code: 'str', *, inputs: 'dict | None' = None, outputs: 'dict | None' = None) -> 'CallResult'`" | action.py:11440 -- "class ScreenActionBuilder(ActionBuilder):" e action.py:9441 "def javascript(" em ActionBuilder | SIGNATURES.md:695 -- "### ScreenActionBuilder (`ca = with scr.client_action()`)" com apenas 3 entradas proprias | "ca.javascript" tem 0 ocorrencias TAMBEM no ficheiro gerado, o que prova convencao e nao ausencia
```

### Copiar para o Anvil os verbos cuja implementacao passa por reflection sobre o modelo do Studio -- `ss.explore.invoke` (invocacao por nome de metodo), `ss.flow.set_property` ("via SetPropertyValue"), `

`capabilities`

E o caminho torto de que o dono do projecto avisou, e esta anunciado na superficie PUBLICA como se fosse capacidade normal, o que o torna facil de herdar sem dar por isso. Um verbo que resolve um metodo por string falha em runtime com o nome errado, nao em preflight com um contrato -- e a familia "erros que nao ensinam" pela raiz. Pior: a tabela curada do `how` responde a intencao "excecao" ensinando literalmente "bind no node via explore.invoke set_Exception", ou seja, a rota de descoberta recomenda o contorno. O ModelAPI decompilado (Interfaces.xml) da interfaces tipadas com Property declaradas para boa parte disto; a substituicao e verificavel ficheiro a ficheiro e ninguem a fez.

```
SIGNATURES.md:135 -- "- `ss.explore` *(property)* — Low-level model explorer: object()/invoke() for runtime reflection." | SIGNATURES.md:391 -- "- `ss.flow.set_property(self, object_key: 'str', prop: 'str', value: 'str') -> 'dict'` — Set any property on a flow node via ``SetPropertyValue``." | SIGNATURES.md:483 -- "- `ss.explore.invoke(self, object_key: 'str', method_name: 'str', args: 'list | None' = None, interface: 'str | None' = None, generic_type: 'str | None' = None, use_command: 'bool' = False) -> 'dict'`" | how_cmd.py:81-83 -- Intent(("excecao", "raise", "user exception"), ("ss.user_exception", "ss.flow.set_exception_message"), "bind no node via explore.invoke set_Exception") | alternativa nativa: Interfaces.xml:58-61 <Interface name="IAttribute" ...><Property name="Length" type="int?" /><Property name="Decimals" type="int?" /></Interface>
```

### Procurar um helper por nome com `getattr` e fazer `continue` quando falta, num caminho que transporta dados do utilizador.

`capabilities`

Produz perda silenciosa: `_replay_interface_spec` percorre as client variables do spec, procura `client_variable` no builder vivo e, como nenhum builder vivo tem esse metodo (a unica def esta no OfflineScreen), descarta-as todas sem erro, sem aviso e sem registo. Nao e sequer um "erro que nao ensina" -- e um erro que nao existe. Regra para o Anvil: uma capacidade em falta e um erro nomeado ("nao existe verbo para X"), nunca um ramo vazio.

```
native_paste.py:483-490 -- "def _replay_interface_spec(builder: Any, spec: Any) -> None:\n    for local in getattr(spec, \"locals\", []) or []:\n        builder.local_var(...)\n    for variable in getattr(spec, \"client_variables\", []) or []:\n        helper = getattr(builder, \"client_variable\", None)\n        if helper is None:\n            continue" | grep 'def client_variable' em todo o ssam_declarative -> unica ocorrencia offline.py:928, dentro de "class OfflineScreen:" (offline.py:892)
```

### Dar por coberta uma verificacao que so corre contra fixtures. O `audit_signature_surface` tem teste (`test_surface_audit.py:43-57`), mas o teste constroi um repo falso em `tmp_path` e escreve "differe

`capabilities`

O achado original dizia que a auditoria "nao esta ligada a nenhum gate" e que so era chamada em registry.py -- e incompleto, ha um teste. Mas verificar mostrou algo pior do que o que ele afirmava: ha teste, ha codigo de auditoria, o teste passa verde, e a divergencia REAL do repo (hashes B4A719C3... vs 92854515...) nunca e vista, porque ssam_stability/tests nao corre em CI nenhum e o teste nunca aponta para o repo real. Cobertura aparente e pior do que ausencia declarada.

```
test_surface_audit.py:44-51 -- "root = tmp_path / \"repo\"\n    mirror = root / \"ssam-declarative\" / \"docs\" / \"SIGNATURES.md\"\n    mirror.parent.mkdir(parents=True)\n    (root / \"SIGNATURES.md\").write_text(...)\n    mirror.write_text(\"different\", encoding=\"utf-8\")" | workflow ssam-agent-runtime.yml: os unicos pytest sao "python -m pytest ssam_agent_runtime/tests" e 7 ficheiros nomeados de ssam-declarative/tests -- ssam_stability nao aparece | surface_audit.py:130 -- "\"status\": \"failed\" if collisions or mirror_hash != primary_hash else \"passed\"
```

### O habito de escrever `comoFoiObtido: observacao-manual` em tudo.

`mistakes`

O campo devia dizer como o CONHECIMENTO foi arrancado a plataforma, e passou a dizer como o agente leu o ficheiro. Com isso, 13 entradas seguidas ficaram sem um unico aviso de que o repositorio inteiro de onde vem esse conhecimento fala com o Service Studio por reflexao e por hook no processo. Quem ler o lote fica a achar que herda leitura de codigo; herda um catalogo tirado por reflexao. Se este campo sair assim preenchido na migracao, a divida entra sem ninguem dar por ela -- que e exactamente o que o aviso do dono do projecto mandava evitar.

```
C:\Users\andre\GitSSAM\ss-patcher\SSDiagnostics\ReflectionHandler.cs:6-7 -- `/// Explores the SS process internals via reflection.`; C:\Users\andre\GitSSAM\ss-patcher\SSDiagnostics\PropertyHandler.cs:87-96 -- `var clrProp = control.GetType().GetProperty(propName);` ... `clrProp.SetValue(control, converted);` ... `["method"] = "reflection"`. E existe C:\Users\andre\GitSSAM\ss-patcher\SSAMHook\HookPatches.cs. 2520 marcadores de reflexao em 58 ficheiros do ss-patcher.
```

### Escrever `por apurar` sem abrir o Studio decompilado quando ele responde em dois greps.

`mistakes`

O achado do dropdown escreveu textualmente 'fica por apurar -- nao abri o decompilado nesta passagem'. Abri, e a resposta estava a dois greps: no ODC nao ha sequer tipo Dropdown no modelo, o unico IComboBoxWidget e de Traditional Web, e no ODC/Reactive um dropdown e uma instancia de Block cujo List e um IArgument. Isso nao e um detalhe: muda a frase do facto e muda o alvo do job de migracao. `por apurar` e honesto quando se tentou; usado como atalho, faz o proximo agente repetir a busca e arrisca-se a que o facto entre no ledger com vocabulario de SS11.

```
C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model.Definition\CodeGeneration.ModelAPI.Interfaces.xml:913 -- `<IComboBoxWidget inherits="IWebWidget" implementedBy="WebWidgets.ComboBox" />`. E C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model.V1\OutSystems.Model.UI.Mobile.Widgets\IMobileBlockInstanceWidget.cs -- `[ModelInterface(DisplayName = "Block", Icon = "WebBlock.ico", IsConcrete = true)]` com `new IMobileBlockSignature SourceBlock { get; set; }` e `[Children] new IEnumerable<IArgument> Arguments { get; }`.
```

### Copiar numeros de linha de um documento em vez de os ir buscar ao ficheiro.

`mistakes`

O achado cita `Verbs.cs:988-991` e `Verbs.cs:950-954`. Nenhuma das duas esta certa: o `ExpressionDefinition.Parse` por reflexao esta em 997-998 e o `Remembered` em 957-961. Os numeros errados vieram de NAO-DA.md:715, que os traz exactamente assim -- ou seja, foi copiada uma referencia ja desactualizada em vez de aberto o .cs. Isto e o mecanismo pelo qual um ledger apodrece: a referencia sobrevive a mudanca do codigo porque ninguem a volta a abrir. E no mesmo movimento produziu a refutacao mais cara do lote, porque a conclusao 'no ODC nao leva aspas' foi tirada do texto do documento e nao do job ODC que escreve as aspas.

```
C:\Users\andre\Anvil\src\Anvil.Core\Kernel\Verbs.cs:997-998 -- `// ODC: writable expression properties (static record values, defaults) hold a parsed ExpressionDefinition,` / `if (t.FullName == "OutSystems.Model.Expressions.ExpressionDefinition")`. As linhas 988-991 sao outra coisa: `if (t.IsInterface) { var o = Resolve(s); ... }`. E NAO-DA.md:715 cita `Verbs.cs:988-991` e `Verbs.cs:950-954`, que foi de onde o achado as tirou.
```

### Tratar um teste que pode desistir em silencio como se fosse um portao mais forte.

`mistakes`

O lote recomenda tres vezes 'nao portar o gate do SSAM porque o NegativeJobTests do Anvil corre contra o modelo'. Corre quando ha Studio. Sem Studio devolve verde sem executar nada, nas duas faixas. Trocar um gate que sempre corre mas so ve substrings por um gate que ve tudo mas as vezes nao corre pode ser uma boa troca -- mas tem de ser feita com os olhos abertos e com uma contagem de jobs executados no CI, senao a migracao troca uma fraqueza conhecida por uma fraqueza invisivel.

```
C:\Users\andre\Anvil\tests\Anvil.Tests\NegativeJobTests.cs:32 -- `if (!StudioAvailable()) return;`, primeira linha do corpo de `JobFailsWithTheTeachingMessage`. Identico em C:\Users\andre\Anvil\tests\Anvil.Tests.Odc\OdcJobTests.cs:47.
```

### Cruzar um nome com a superficie real por `grep def <nome>` sem olhar para a classe dona.

`mistakes`

O achado acusa (bem) o campo `methods` de nao ser cruzado com a superficie real, e depois faz ele proprio um cruzamento incompleto: afirma que 'o unico `def sql(` do pacote esta em offline.py:506, dentro de class OfflineAction'. Ha outro, e e o canonico -- `ActionBuilder.sql` em builders/action.py:7792. O caminho nativo proposto aponta assim para o espelho offline em vez do builder real. E a mesma falha que a acusacao denuncia, repetida um nivel acima: concluir a partir de um resultado de grep sem confirmar a quem pertence.

```
Grep por `def sql\(` em todo o C:\Users\andre\GitSSAM devolve, em producao, DUAS linhas: `ssam-declarative\ssam_declarative\builders\action.py:7792:    def sql(` e `ssam-declarative\ssam_declarative\offline.py:506:    def sql(`. A classe de action.py:7792 e `class ActionBuilder(FuzzyUnknownAttrMixin, ListOpsMixin):` (action.py:239); a de offline.py:506 e `class OfflineAction:` (offline.py:348).
```

### Declarar 'sobreposicao topica praticamente ZERO' a partir de uma lista de tokens de um dos dois lados.

`mistakes`

A medicao usou `dropdown`, `seed`, `delete_entity`, `StartIndex` -- identificadores do SSAM -- e concluiu que o NAO-DA nao fala dos mesmos temas. Fala: tem um item `### delete com consumidores` que e da mesma familia do artifact_cleanup.json, e 32 ocorrencias de `delete`. A conclusao de fundo (sao duas especies de ledger e devem ficar separadas) continua certa e vale a pena, mas foi sustentada por uma medicao que media vocabulario. Pior: contradiz a entrada 10 do mesmo lote, que diz que o Anvil ja sabe mais sobre apagar. Um lote que se contradiz da ao leitor a escolha de qual metade acreditar.

```
C:\Users\andre\Anvil\docs\NAO-DA.md:1363-1367 -- `### delete com consumidores` / `` `recusa-da-plataforma` `` / `O delete recusa quando o alvo tem consumidores reais e a mensagem NOMEIA cada um pelo caminho`. Contagem propria no mesmo ficheiro: `delete`=32, `delete_entity`=0. E o proprio lote, entrada 10: 'O Anvil ja tem o caminho nativo e sabe mais sobre ele.'
```

### O numero de linhas de um ficheiro vivo como facto citavel.

`mistakes`

'NAO-DA.md (100 itens, 1239 linhas)'. Os itens confirmam-se; as linhas nao -- sao 1962, porque o ficheiro esta a ser trabalhado e recebeu blocos CONFIRMADO datados de 2026-09-17, o proprio dia. Contar itens (`###`) e estavel e diz alguma coisa; contar linhas de um documento em revisao e ruido que envelhece no mesmo dia em que se escreve, e que depois serve de base a comparacoes de tamanho que ja nao valem.

```
Contagem propria de C:\Users\andre\Anvil\docs\NAO-DA.md: 1962 linhas, 100 cabecalhos `###`. E NAO-DA.md:713 -- `> **CONFIRMADO** (passagem adversarial, 2026-09-17)`, bloco que nao existia na versao de que veio o numero 1239.
```

### A ideia de que as 'cinco regras inegociaveis' sao um mecanismo. Confirmei a contagem: .claude tem UM hook (PostToolUse/Bash) que nao implementa nenhuma das cinco, e o segundo hook do repo nao esta ins

`regras`

Copiar a forma -- uma seccao 'regras inegociaveis' no topo de um AGENTS.md -- da a sensacao de governanca sem nenhuma. O que funcionou aqui nao foi a prosa: foram os tres sitios onde a regra virou codigo que corre ANTES da mutacao (preflight AST em check.py, politica de publish em task_execution_policy.py, hook PostToolUse). No Anvil a regra deve nascer como validacao do plano declarativo; se nao puder nascer assim, e um documento e deve ser chamado documento.

```
AGENTS.md L8-21 tem as cinco regras. Listagem integral de C:\Users\andre\GitSSAM\.claude: launch.json, settings.json, commands/SSAMQualityGate.md, hooks/ssam-validate.sh, preview_bridge/index.html. settings.json inteiro (994 bytes) tem um unico bloco "PostToolUse" com matcher "Bash". .git/hooks contem 14 ficheiros, todos .sample.
```

### Marcar 'api-nativa-do-modelo' ou 'caminhoNativo: n/a' sem abrir o Studio decompilado. O achado fez isso no catalogo de builtins: escreveu 'n/a -- e uma tabela de dados congelada' e 'Nao usa reflection

`regras`

E o modo de falha que o dono avisou, em estado puro: uma coisa que FUNCIONA ser etiquetada de nativa so porque o ficheiro que a contem e um dict Python offline. O ficheiro e offline; o CONHECIMENTO nele nao foi. Se o Anvil herdar a tabela com a etiqueta 'nativo', herda tambem o processo de a manter -- sondar tenant a cada versao da plataforma -- que e exactamente a divida. Regra de trabalho: 'tabela de dados em Python' nunca e resposta a pergunta 'como foi obtido'; a pergunta certa e 'quem escreveu estes valores e a partir de que fonte', e ha sempre um ficheiro (o catalogo, o comentario datado) que responde.

```
builtin_catalog_o11.json: "\"probe\": \"Name(0) via add_assignment; Unknown function => NOT exists\", \"proven_at\": \"2026-07-02\"" -- contra C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model.V1\OutSystems.Model.Expressions\IBuiltinFunctionInfo.cs: "\t\tbool IsMandatory { get; }" e BuiltinFunctionsInfo.cs L13: "\tpublic static IEnumerable<IBuiltinFunctionInfo> All => functionsByName.Value.Values;"
```

### Citar uma linha de um log de friccao como prova do estado ACTUAL do codigo. O achado afirma que SSAM_ALLOW_HANDWRITTEN_ACTIONS e SSAM_ALLOW_LOCAL_UI_QUERY sao 'duas formas incompativeis' e prova-o com

`regras`

Um log de friccao e datado por natureza: regista o que doeu num dia. Usa-lo como prova de estado presente produz um achado que era verdadeiro e ja nao e, e leva o Anvil a 'corrigir' um defeito que o GitSSAM ja corrigiu. A licao de metodo -- prova de comportamento actual vem do codigo; o log serve para saber ONDE olhar e QUANTO custou, nunca para dizer o que o sistema faz agora.

```
screen_build_contract.py L296-302: "    # KKR 2026-09-03 (#96/#96b): o escape aceita as DUAS mecanicas - constante\n    # Python no script OU variavel de ambiente (igual a\n    # SSAM_ALLOW_HANDWRITTEN_ACTIONS); a mensagem cita ambas.\n    allow_local_query = (\n        str(constants.get(\"SSAM_ALLOW_LOCAL_UI_QUERY\") or \"\").strip()\n        or str(os.environ.get(\"SSAM_ALLOW_LOCAL_UI_QUERY\") or \"\").strip()\n    )" -- e L318-324 da mensagem: "declare SSAM_ALLOW_LOCAL_UI_QUERY = '<architectural reason>' as a module-level constant in the script OR export the environment variable SSAM_ALLOW_LOCAL_UI_QUERY='<architectural reason>' (same mechanics as SSAM_ALLOW_HANDWRITTEN_ACTIONS; the reason needs >=12 chars and >=2 words)." O que SOBREVIVE e so a regra: um unico mecanismo de escape, declarado no proprio plano JSON (campo override: {reason}), nunca env vars a competir com constantes.
```

### O guard de route-pack (_agent_runtime_guard.py) inteiro, E TAMBEM as '3 linhas do _resolve_user_script' que o achado recomendava salvar. Exigir um route pack JSON com menos de 6h, recusar se estiver l

`regras`

E o caminho torto em estado puro e o proprio projecto ja o abandonou. Quatro defeitos de abordagem: (1) validade por RELOGIO (max_age 21600s) em vez de por conteudo -- um route pack de 5h59 sobre codigo ja mudado passa, um de 6h01 sobre codigo intacto falha; (2) subprocess sincrono a meio de uma mutacao, com timeout=120, dentro de um try que converte TimeoutExpired em erro de mutacao; (3) o estado de autorizacao vive em tres JSONs numa cache local (guard_config.json, latest_route.json, validated_scripts.json) que nada garante estarem em sincronia; (4) inspect.stack() para adivinhar o chamador -- reflection para inferir uma coisa que o chamador podia declarar. Substituir tudo pela inversao que o proprio repo ja adoptou: o runner injecta o env e a SDK so liga o portao apertado quando esse env existe. Do guard so migra o hash-binding do script validado.

```
_agent_runtime_guard.py L156-158: "        \"This legacy route guard is no longer part of the default workflow.\\n\"\n        \"Disable it with:\\n\"\n        \"  python -m ssam_agent_runtime guard disable\"" -- L92: "    max_age = int(config.get(\"max_age_seconds\") or 21600)" -- L248-266: subprocess.run([sys.executable, "-m", "ssam_agent_runtime", "validate", ...], timeout=120) -- L10: "import inspect" e L330: "    for frame in inspect.stack()[2:]:"
```

### A mensagem de recusa de ~900 caracteres do handwritten_action_batch_prefer_logic_ir, e o habito de responder a uma violacao com um sermao. (Confirmei que a correccao ja foi feita no codigo.)

`regras`

O proprio projecto mediu isto como ruido: o log de friccao regista que o sermao saia MESMO quando o motivo do escape ja tinha sido dado, e que o motivo dado era exactamente um buraco conhecido do proprio IR. A regra geral a levar: o comprimento da mensagem deve ser inversamente proporcional ao quanto o chamador ja provou saber o que esta a fazer -- com motivo dado, uma linha; sem motivo, a mensagem longa.

```
check.py L982-983: "        # KKR 2026-09-03 (#46): com motivo dado, o sermao de ~900 chars\n        # nao ensina nada - uma linha, registrada para o backlog de gaps." -- e docs/tasks/2026-09-03-friccoes-ssam-kkr-time-entry.md L76: "O escape `SSAM_ALLOW_HANDWRITTEN_ACTIONS` gera um WARNING de ~900 caracteres sermoneando (...) mesmo com a justificativa dada - e a justificativa e exatamente o gap #28 que o proprio IR tem."
```

### A forma do cli.py: 436.342 bytes num unico ficheiro, 94 linhas add_parser, 67 ramos `if args.command == "..."`, e um verbo (logic-ir) cujos 17 sub-verbos sao resolvidos por comparacao de string sobre 

`regras`

E o custo directo das familias 'complexidade da saida' e 'erros que nao ensinam': com o verbo como argumento livre, argparse deixa de conseguir dizer 'verbo desconhecido, os validos sao X, Y, Z', e um engano de nome sai como erro de ficheiro ilegivel. O proprio help ja diverge da realidade (anuncia `logic-ir stats`, que nao existe em nenhum dos 17 ramos). No Anvil: conjunto de ops fechado, declarado em schema, e a validacao devolve a lista dos validos.

```
cli.py L1295: "    logic_ir_parser.add_argument(\"spec\", type=Path)" -- L5703: "    if str(args.spec).casefold() == \"help\":" (...) L6159: "    if str(args.spec).casefold() == \"frontend\":" -- 17 ramos, nenhum "stats", apesar do help em L1289-1290 o anunciar. Tamanho verificado: 436342 bytes; add_parser em 94 linhas; 67 ramos if args.command ==.
```

### Tratar o gate do Logic IR como prova de que a rota sancionada e nativa. O achado citou aprovativamente a frase 'materializes the Actions through the native clipboard route' da mensagem de recusa.

`regras`

O gate e nativo (ast offline); a rota para onde ele empurra nao e. O emitter admite que o formato do clipboard foi COLHIDO de especimes vivos e nao inferido, que o cabecalho muda por produto e por build do Studio (ha numeros de build hardcoded como fallback e um ACTIVATION_CODE literal), e que esta atras de um gate SSAM_EXPERIMENTAL_NATIVE_CLIPBOARD. Portar 'forcar a rota sancionada' sem olhar para o que a rota sancionada E significa amplificar divida em vez de a pagar: o Anvil so ganha se a SUA rota sancionada for nativa. A palavra 'native' na mensagem de erro do proprio sistema nao e evidencia -- e auto-descricao.

```
clipboard_emitter.py L14-16: "v3 (2026-08-31): o formato foi COLHIDO de especimes vivos via `native_clipboard_serialize` (scripts/bench_harness/specimen_rosetta.py -> _work/rosetta/*.xml), nao inferido." -- L30-33: "# O cabecalho do payload muda por PRODUTO e por BUILD do Studio. Capturas reais: O11 11.55.73.64880 e 11.55.71.64832 (dois builds), ODC 13.1266.1.60000. Fixar um numero e fragil" -- L11-12: "quem serializa e cola sao funcoes que ja existem (`serialize_outsystems_clipboard_xml` e `native_clipboard_paste`), atras do gate SSAM_EXPERIMENTAL_NATIVE_CLIPBOARD." -- e L3-5: "CADA escrita paga ~165ms fixos de reflexao nao-cacheada dentro do Service Studio"
```

### O C# da bridge SSDiagnostics: reflection sobre membros nao publicos do Service Studio mais patching de runtime com HarmonyLib. (Acrescento meu -- o outro agente nao foi ver este lado do socket.)

`declarative`

E a divida real do repositorio, maior do que o _clipboard.py, e estava a passar despercebida por estar escondida atras de nomes de comando bonitos. Um patch Harmony sobre um metodo interno do Studio parte com qualquer build nova, em runtime, e o sintoma aparece longe da causa. O SSAMHook chega a dizer que substitui dois patches Mono.Cecil que o SSAM escrevia em disco -- ou seja o projecto ja tinha reescrito binarios da OutSystems e passou a faze-lo em memoria. Nada disto pode entrar no kernel do Anvil, e a existencia disto invalida qualquer argumento de que a bridge ja e "quase nativa".

```
"_nativeClipboardHarmony = new HarmonyLib.Harmony(\"ssam.native.clipboard.override\");\n            _nativeClipboardHarmony.Patch(getOmlData, prefix: new HarmonyLib.HarmonyMethod(prefix));" (SSModelHandler.cs:5838-5839) e "/// The in-memory equivalents of the two Mono.Cecil patches SSAM used to write\n/// to disk." (SSAMHook/HookPatches.cs:6-7). Escala medida em SSModelHandler.cs: 655 GetProperty(, 249 GetMethod(, 155 .SetValue(, 46 BindingFlags.NonPublic.
```

### A arquitectura do DECLARATIVE_COMPILER.md: resolvers a mutar um CompilerContext partilhado e accoes presas em lambdas de on_click. (Confirmo o achado do outro agente -- fui ao ficheiro.)

`declarative`

Confirmado tal como ele disse: a fase que compila as accoes esta literalmente por fazer, o corpo de `_build_action` e comentario e `pass`. Um compilador cujo estado e um saco mutavel partilhado por seis fases nao e serializavel nem diffavel entre corridas, e a intencao do autor nunca existe como dado porque vive dentro de lambdas.

```
"        # Por agora, as acoes sao compiladas no momento do\n        # on_click lambda (dentro dos resolvers de Table e Popup).\n        #\n        # No futuro com named actions (scr.action(\"Name\", ...)):\n        ...\n        pass" -- corpo inteiro de ActionResolver._build_action (DECLARATIVE_COMPILER.md:923-933)
```

### O dominio do exemplo colado dentro do motor generico: `call_args={"PedidoId": ...}` e prefixos CSS `gp-`. (Confirmo -- citacao exacta.)

`declarative`

Confirmado na linha exacta que ele deu. E um motor que so sabe compilar a tela que lhe serviu de exemplo; qualquer segundo caso obriga a editar o compilador. Sinal de codigo escrito a partir de uma sessao unica em vez do contrato do modelo. Reforca, alias, a correccao que fiz a etiqueta dele: este documento nao e "documentacao da OutSystems", e a transcricao de um caso.

```
"                self.ctx.add_action(\"ExcluirRow\",\n                    call=action_name,\n                    call_args={\"PedidoId\": f\"{P}.Id\"}," (DECLARATIVE_COMPILER.md:707-709) e, na mesma pagina, "self.scr.button(\"E\", style_classes=\"gp-btn-edit\"" (:701)
```

### Reconstruir o formato de clipboard OML por fora, com chaves internas de tipo copiadas para constantes Python. (Confirmo, e e pior do que ele disse.)

`declarative`

Confirmado nas linhas exactas. Acrescento que as chaves nao param nos 12 tipos basicos: _clipboard.py:59-72 tem chaves internas para REST client, REST action, REST structure e sete NRWidgets. Cada widget novo do Studio e uma constante nova a decorar a mao, e a deteccao da quebra so acontece na colagem. O caminho do Anvil nao precisa de conhecer chave nenhuma.

```
"OUTSYSTEMS_TEXT_TYPE = \"%uROOBXPvQEyU76NWO+1uxQ\"\nOUTSYSTEMS_INTEGER_TYPE = \"%j2Lc0phK0kuggij4gQYfAw\"" (:47-48) contra "DEFAULT_CLIPBOARD_VERSION = \"13.1266.1.60000\"" (:39), e ainda "NRWIDGET_CONTAINER_CUSTOM_OBJECT_IMPL_KEY = \"6cjGhm4AI_VtWsHoA4dyAw\"" (:68)
```

### Escrita por reflection fora do Command system (`invoke(..., use_command=False)` para mutar o modelo). (Confirmo, com um agravante que ele nao registou.)

`declarative`

Confirmado o aviso, e o agravante e que `use_command: bool = False` e o DEFAULT da assinatura de invoke (_explore.py:694). Ou seja a porta insegura e a que se abre sozinha: quem chamar invoke para escrever sem pensar no parametro fura o Command system por omissao. Fura undo/redo, provoca NullReferenceException na verificacao do modelo, e ja custou uma regressao registada (o CycleTarget a apontar para o End). O Anvil nao deve ganhar esta porta -- e se ganhar um invoke, que seja com o command ligado por defeito.

```
"  - invoke() is DANGEROUS FOR WRITING because it bypasses the SS Command\n    system. Write operations (create, set, delete) MUST use modify_model\n    commands to avoid NullReferenceExceptions during model verification.\n    Only use invoke() for writes when explicitly instructed." (_explore.py:12-15) e "        use_command: bool = False," (:694)
```

### Dois documentos de doutrina contraditorios lado a lado na raiz, sem nenhum dizer qual vence. (Confirmo: ambos existem na raiz de ssam-declarative.)

`declarative`

Confirmado: SSAM_VISION.md:10 diz "Nao e um compilador declarativo." e o ficheiro vizinho chama-se DECLARATIVE_COMPILER.md e abre com "# SSAM Declarative Compiler - Implementacao". E a raiz da familia handoff/registo: um agente novo le o primeiro que abre. Nao se resolve com mais documentacao -- resolve-se apagando ou marcando como superseded. Se o material for para o Anvil, so pode ir uma doutrina. Note-se que o repositorio JA SABE fazer isto bem noutro sitio: o ODC_INCOMPATIBILITIES.md tem regra de supersession escrita. So nao a aplicou a si proprio.

```
"Nao e um compilador declarativo." (SSAM_VISION.md:10) contra "# SSAM Declarative Compiler - Implementacao" (DECLARATIVE_COMPILER.md:1); e a regra que existe e nao foi usada: "a historical claim needs its rationale and\nsupersession" (ODC_INCOMPATIBILITIES.md:41)
```

### Ficheiros unicos de dimensao industrial. (Confirmo os dois numeros e acrescento dois piores.)

`declarative`

Confirmei por listagem: builders\screen.py = 1.377.849 bytes e ss.py = 996.073. Acrescento os que ele nao viu e que sao a mesma doenca no lado C#: SSModelHandler.cs = 2.175.291 bytes, e _clipboard.py = 794.721. Nada disto e revisivel, por humano ou por agente, e obriga qualquer leitura a ser por grep -- que e exactamente como se produzem afirmacoes que nao se sustentam. Se alguma logica migrar para o kernel, migra por contrato (que ops suporta, com que garantias), nunca por copia.

```
Listagem do disco: "builders\\screen.py 1377849", "ss.py 996073", "_clipboard.py 794721" e "C:\\Users\\andre\\GitSSAM\\ss-patcher\\SSDiagnostics\\SSModelHandler.cs 2175291"
```

### A escada de reflection para descobrir por onde escrever uma propriedade (`ResolveWritePath`): tenta Set{X}(string), depois Set{X}(int), Set{X}(long), depois setter explícito de interface, depois propr

`friccoes`

REFORÇO O CASO COM UM PERIGO CONCRETO QUE O OUTRO AGENTE NÃO VIU. Não é só adivinhação sobre um tipo já conhecido cujo membro certo já está no comentário do próprio ficheiro. É que o segundo degrau tem alvo REAL para acertar errado: a escada procura com `BindingFlags.NonPublic` incluído (linha 33) e as sobrecargas `protected void SetLength(int)` e `protected void SetDecimals(int)` EXISTEM mesmo no modelo — AbstractAttribute.cs:496/501 no o11 e :693/698 no ODC. Ou seja, a escada tem duas portas por onde entrar para a mesma propriedade, uma pública e uma protegida, e escolhe pela ORDEM em que as tenta, não por saber qual é a certa. Basta a sobrecarga string desaparecer ou mudar de assinatura numa versão para a escada passar silenciosamente a escrever pela porta protegida, sem nada falhar. Isto não é hipótese minha: a própria heurística da auto-property só existe porque a escada já escolheu um DTO em vez do modelo alguma vez. No Anvil deve ser contrato declarativo: nome do setter, ordem de escrita, readback obrigatório.

```
EntityAttributeOptions.cs:33 e :51-59: "private const BindingFlags AllInstance = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;" / "Escolha PURA (so reflexao sobre o Type) do membro por onde escrever uma\n    /// propriedade-expressao de atributo. Ordem:\n    ///  1. setter tipado no proprio objeto: Set{X}(string), Set{X}(int), Set{X}(long);\n    ///  2. setter explicito de interface com essas assinaturas ...\n    ///  4. propriedade gravavel de interface — preferindo a interface cuja\n    ///     implementacao NAO e auto-property gerada pelo compilador (uma\n    ///     auto-property explicita e um DTO: escreve num campo que o modelo". E os alvos protegidos que existem mesmo, verificados por mim em C:\Users\andre\ODC3\decompiled\o11\ServiceStudio.Framework\ServiceStudio.Model\AbstractAttribute.cs:496 e :501: "protected void SetLength(int value)" e "protected void SetDecimals(int value)" (idem ODC :693/:698).
```

### Duplicar a travessia do modelo: manter no espelho uma "cópia fiel" do walk oficial (SearchInESpace/SearchInFlow) com os filtros removidos, sincronizada à mão por comentário.

`friccoes`

Duas travessias que TÊM de concordar e cuja concordância é garantida por um comentário são um gerador de divergência. Localizei as duas pontas: o original está em SSModelHandler.cs:27039/:27117 e a cópia em ModelMirror.cs — qualquer alteração no walk oficial que não seja espelhada produz leituras que diferem do caminho lento, e o log KKR contém exactamente o sintoma de uma leitura que afirma o que o artefacto final não tem (#149/#150), mesmo que a causa final acabe por ser outra. No Anvil a travessia tem de ser UMA, parametrizada por filtro, com a cache a ser uma projecção dela e não uma segunda implementação. Nota de justiça: o CONTRATO do espelho (nunca decide correcção, re-verifica cada linha, escrita marca stale) é bom e deve ser copiado — o que não se copia é a segunda cópia do código.

```
ModelMirror.cs:17-18: "// The traversal below is a faithful copy of SearchInESpace/SearchInFlow\n// (SSModelHandler) with the filters removed — keep them in sync." Original localizado por mim em C:\Users\andre\GitSSAM\ss-patcher\SSDiagnostics\SSModelHandler.cs:27039: "private static void SearchInESpace(object espace, string name, string? elementType, string? parentName, JsonArray results, int maxResults, HashSet<string>? types = null, bool exact = false)".
```

### Passar conteúdo controlado pelo utilizador como string de substituição de `re.sub` (`pattern.sub(block, existing)`).

`friccoes`

A string de substituição do Python interpreta \\1, \\g<nome> e escapes numéricos, por isso conteúdo legítimo (um \\25CF de CSS) é lido como backreference: ou rebenta, ou — muito pior — é reescrito em silêncio e ninguém percebe. É a mesma classe de defeito da injecção de SQL aplicada a texto. A forma correcta (callable) é MAIS CURTA do que a errada. Continua VIVO no código hoje (verifiquei a linha) e nunca foi triado porque está acima do corte #107. Agravante que encontrei ao abrir o ficheiro: três linhas acima, o mesmo autor escapa correctamente os delimitadores do PADRÃO com `re.escape` — sabia-se do perigo num lado da chamada e não no outro, o que mostra que a regra tem de ser mecânica e não depender de atenção.

```
ss.py:3553-3559: "        pattern = re.compile(\n            re.escape(start) + r\".*?\" + re.escape(end),\n            flags=re.DOTALL,\n        )\n        prev = pattern.search(existing)\n        if prev:\n            updated = pattern.sub(block, existing)" — e o efeito registado em docs\tasks\2026-09-03-friccoes-ssam-kkr-time-entry.md:239: "o `\\2304` de 23:47 virou \"4\" na tela em silêncio".
```

### Escritas que reportam sucesso a partir da CHAMADA e não do MODELO: `set_property` devolve sucesso e o read-back mostra que nada foi gravado (#148 StyleClasses, #142 Visible num Text), ou o kwarg é ign

`friccoes`

É a pior classe de erro para um agente: o retorno confirma trabalho que não existe, portanto nenhuma verificação posterior é accionada e o erro só aparece no ecrã do dono, horas depois. No log, o menu lateral ficou ilegível desde as 21:00 e só foi descoberto às 23:22. Nenhum destes foi triado — estão todos acima do corte #107, que confirmei por varrimento. No Anvil, escrita sem read-back verificado não deve poder devolver sucesso, e isto não é pedir nada de novo: o próprio GitSSAM já provou que sabe fazê-lo, com um comparador que até trata inteiros como número e não como texto (`ValueMatches`, EntityAttributeOptions.cs:174-179). A capacidade existe; o que falta é ser obrigatória.

```
docs\tasks\2026-09-03-friccoes-ssam-kkr-time-entry.md:241: "| 148 | 01:05 | BUG | `ss.flow.set_property(<Expression>, \"StyleClasses\", <expr>)` devolve sucesso, mas o read-back (`dom` → `style_classes=''`) e o runtime mostram que NADA foi gravado — sem erro, ao contrário de #142 que pelo menos acusou. Terceira propriedade com semântica \"sucesso = nada\"." O comparador que já existe, EntityAttributeOptions.cs:174-179: "internal static bool ValueMatches(string requested, string? readback)" ... "if (long.TryParse(requested.Trim(), out var a) && long.TryParse(readback.Trim(), out var b))".
```

### Concluir "a plataforma não tem X" a partir de um erro de vocabulário, escrever essa conclusão no catálogo como facto da plataforma, e depois cortar funcionalidade do produto por causa dela.

`friccoes`

Cinco afirmações do catálogo morreram quando alguém foi ao código, e duas custaram funcionalidade real: o `not` existia (o agente escreveu `unary`), o literal Currency funcionava (escreveu `type` em vez de `dataType`), e a coluna "role atual" foi cortada do app porque procurou Role/User_Role no produtor errado (`Users`) quando vivem em `(System)`. É a armadilha ISiteProperty/Settings da memória do projecto, a acontecer duas vezes na mesma noite. O que torna isto imperdoável como desenho: o vocabulário aceite JÁ ESTAVA numa tabela literal no topo do compiler.py (:60-68) — enumerar não custava nada, só ninguém tinha ligado a tabela à mensagem de erro. A regra: antes de escrever "não existe", enumerar o vocabulário aceite ou procurar o mesmo conceito com outro DONO ou outro NOME.

```
docs\tasks\2026-09-07-ondas-1-4-kkr-fixes-implementadas.md:168-169: "- #18b/#18c: `not` existe (`kind: \"not\"`); literal Currency funciona com\n  `dataType` (o campo errado era `type`)." Confirmado em compiler.py:64: '    "not": {"kind", "value"},' — dentro da tabela de vocabulário que já existia em :60-68.
```

### Correr a onda de consertos contra um SNAPSHOT do catálogo enquanto o catálogo continua a crescer, sem marca de água do último item triado.

`friccoes`

O doc de fixes diz-se completo ("todos os itens A") mas foi construído sobre 107 itens de um catálogo que tem 152 — e provei a órfandade por contagem, não por leitura: varri todas as ocorrências de `#<número>` no doc de fixes e o máximo é 107, zero acima; no código-fonte o máximo é #103. As 45 fricções órfãs não são as sobras: são as mais tardias, vindas do uso mais profundo, e incluem a única corrupção silenciosa de dados de todo o log (#120: `create_or_update` sem Id explícito dentro de um `foreach` reutiliza o Id da iteração anterior; reporta "Created: 10", grava 1; nem compile, nem verify, nem a prova viva HTTP 200 detectam). Um catálogo sem marca de água garante que a próxima rodada recomeça do princípio ou não recomeça de todo.

```
docs\tasks\2026-09-07-ondas-1-4-kkr-fixes-implementadas.md:4 e :7-8: "`docs/tasks/2026-09-03-friccoes-ssam-kkr-time-entry.md` (log, 107 fricções)." e "Este documento fecha as **ondas 1 a 4** = todos os itens A, mais o ajuste de\nsegurança do verbo de descarte para ODC." Contra docs\tasks\2026-09-03-friccoes-ssam-kkr-time-entry.md:246, que é a entrada "| 152 | 01:36 | GAP |". Varrimentos meus: máximo `#` no doc de fixes = 107; máximo em código-fonte = #103.
```

### MEU, NOVO — Citar o decompilado por um offset de dump ("Framework:43773/43778/43783") em vez de ficheiro e linha, e depois tratar essa citação herdada como apuramento próprio.

`friccoes`

O comentário do EntityAttributeOptions.cs cita os setters como "Framework:43773/43778/43783". Esse endereço não abre nada: não corresponde a nenhum ficheiro do decompilado tal como está em disco, é um offset de algum dump concatenado que já não existe ou nunca foi versionado. O outro agente copiou-o e marcou o caminho nativo como "APURADO" sem abrir o decompilado — a afirmação calhou estar certa, mas a prova era emprestada, e uma prova emprestada não se distingue de uma inventada quando alguém for verificar. O custo de fazer bem é minúsculo e o retorno foi imediato: ao abrir a sério, o endereço real apareceu (AbstractAttribute.cs:750/755/760) E veio de graça a faixa ODC (:1073/1078/1083), que o comentário não tinha, E apareceu a correcção de que `SetDecimalsAndLength` é private/protected e portanto não se pode chamar. Regra para o Anvil: uma referência ao decompilado só conta se for ficheiro + linha que abram hoje; qualquer outra forma é "por apurar".

```
Citação herdada, EntityAttributeOptions.cs:15-18: "No modelo (ServiceStudio.Framework.AbstractAttribute), Length/Decimals/\n/// DefaultValue sao AbstractExpression somente leitura; a escrita real e por\n/// SetLength(string)/SetDecimals(string)/SetDefaultValue(string) — publicos\n/// (Framework:43773/43778/43783)". Endereço real, obtido por mim em C:\Users\andre\ODC3\decompiled\o11\ServiceStudio.Framework\ServiceStudio.Model\AbstractAttribute.cs:750-760: "public void SetLength(string value)" / "public void SetDecimals(string value)" / "public void SetDefaultValue(string value)" — e o equivalente ODC em OutSystems.Model\ServiceStudio.Model\AbstractAttribute.cs:1073/1078/1083, ausente do comentário original.
```

### A pasta inteira C:\Users\andre\GitSSAM\ss_agent\ -- a geracao anterior do runner, que conduzia o Studio por Chrome DevTools Protocol em 9222 (porta obtida por outro patch de IL, o PatchSS sobre WebVie

`runtime`

E a prova de que o caminho de GUI foi tentado a fundo e abandonado, e ja esta desligado. Confirmei o grep exactamente como o achado o descreveu: '9222|cdp|playwright' em todo o ssam_agent_runtime devolve DUAS linhas, ambas num comentario sobre Playwright em bound_input.py:3-4, e zero imports de ss_agent. Trazer isto para o Anvil seria ressuscitar a geracao que a propria equipa substituiu. Acrescento a consequencia que ninguem tirou: se o CDP esta morto, o terceiro DLL patchado (WebViewControl.Avalonia.dll) deixou de ter proposito e o procedimento de instalacao devia encolher de tres ficheiros para dois.

```
C:\Users\andre\GitSSAM\ss_agent\agent.py:1-8 -- "SS Agent — Plan-once, execute-all architecture.\nFlow:\n  1. Read current SS state via CDP (one-shot)" ; C:\Users\andre\GitSSAM\ss_agent\main.py:20 "from agent import run_task" (import de topo, so funciona com cwd dentro da pasta) ; contagem real: 367 ficheiros ; grep em ssam_agent_runtime -> so bound_input.py:3-4
```

### Harmony a substituir o clipboard do Windows (SSModelHandler.cs:5809-5859) e, em geral, qualquer patch de runtime que altere estado global da maquina do utilizador para conseguir um efeito no Studio.

`runtime`

Nao e so feio: corrompe estado alheio e falha em silencio. E o caminho alternativo esta no mesmo ficheiro, a 200 linhas de distancia (5601-5622), onde DeserializeInto e resolvido e invocado com os bytes por argumento. CORRECCAO A MANTER JUNTO DESTA REGRA: a assinatura que o achado publicou como sendo do Studio decompilado nao e a do Studio -- e a mensagem de erro do proprio SSAM. No decompilado ODC a sobrecarga unica e DeserializeInto(byte[] bytes, IPasteTarget target, ICommandTarget originalTarget, ShouldDeserializeObjectHandler shouldDeserialize). Quem for consertar isto a partir da assinatura errada nao encontra o metodo.

```
_nativeClipboardHarmony.Patch(getOmlData, prefix: new HarmonyLib.HarmonyMethod(prefix));  // SSModelHandler.cs:5839
--- vs o nativo REAL, lido no decompilado:
public static IEnumerable<AbstractObject> DeserializeInto(byte[] bytes, IPasteTarget target, ICommandTarget originalTarget, ShouldDeserializeObjectHandler shouldDeserialize)  // ODC3\decompiled\odc\OutSystems.Model\OutSystems.Model.CopyPaste\ClipboardManager.cs:1338 (classe: public sealed class ClipboardManager, linha 35)
```

### Fabricar objectos internos do Studio por Activator.CreateInstance e depois preencher-lhes as propriedades por reflection para nao rebentar no handler do host (o CommandResult em SSModelHandler.cs:3861

`runtime`

Acopla o Anvil ao conjunto de propriedades que AggregatorPresenter.HandleCommandComplete acontece a desreferenciar HOJE. Cada release e uma roleta. Verifiquei a alternativa na propria classe e nao apenas num call site: CommandResult e `public class` com fabricas estaticas publicas nomeadas. Regra para o Anvil: nunca construir um tipo do host; pedi-lo sempre a fabrica do host. Ressalva honesta: como o SSDiagnostics nao referencia nenhum assembly da OutSystems, a chamada continuara a ser um invoke reflexivo -- o ganho e trocar 40 linhas fragilissimas por um invoke de nome estavel, nao eliminar a reflection.

```
try { successValue = Activator.CreateInstance(cmdResultType); } catch { }
--- vs o nativo, na propria classe:
public class CommandResult                                   // CommandResult.cs:12
public static CommandResult Open(AbstractObject obj)         // :145
public static CommandResult Select(IObject obj)              // :211
public static CommandResult SelectNew(IObject obj)           // :236
// C:\Users\andre\ODC3\decompiled\odc\OutSystems.Model\OutSystems.Model.Commands\CommandResult.cs
```

### A forma do SSModelHandler.cs e do cli.py. NUMEROS VERIFICADOS: SSModelHandler.cs tem mesmo 45.655 linhas, 2.175.291 bytes, 1561 GetType(, 667 GetProperty(, 249 GetMethod(, 488 .Invoke(, 232 BindingFla

`runtime`

Nao e critica de estilo, e diagnostico das familias medidas: 'inspect: tamanho e filtro' (87) e 'complexidade da saida' (63) nascem de ficheiros onde nao ha unidade menor que se possa ler, testar ou filtrar. Um agente que precise de UMA operacao tem de carregar 2 MB. O Anvil parte de ops declarativas em JSON precisamente para nao ter este centro. E registo o erro numerico porque um numero inflacionado num relatorio de auditoria e exactamente o tipo de afirmacao que nao sobrevive ao ataque seguinte e que faz cair por associacao os 66 numeros que estavam certos.

```
$t=[IO.File]::ReadAllText(SSModelHandler.cs) -> lines 45655 ; bytes 2175291 ; GetProperty( 667 ; GetMethod( 249 ; BindingFlags 232 ; .Invoke( 488 ; GetType( 1561
cli.py -> bytes 436342 ; _dispatch_command spans 3075..3216 ; 'if args.command ==' = 67 (nao 134)
```

### O procedimento de instalacao: editar ServiceStudio.deps.json a mao, copiar DLLs para Program Files com Start-Process -Verb RunAs, e depender de ficheiros .bak ao lado do original.

`runtime`

O proprio guia admite quatro modos de falha SILENCIOSA por instalacao, e li-os um a um: o InjectDiag sobrescreve o temp se correr duas vezes antes da copia; Copy-Item com -Verb RunAs inline 'fails silently'; sem a entrada no deps.json o .NET 8 nao carrega o DLL mesmo estando presente; e qualquer auto-update da OutSystems reverte tudo. Se o Anvil precisar de presenca no processo do Studio, a instalacao tem de ser uma operacao do kernel com receipt e verificacao (o bridge_manifest ja da a verificacao), nao uma sequencia de copias manuais elevadas.

```
SETUP_GUIDE.md:258-266 (o achado citou 260-268) -- "1. **InjectDiag + Copy must be immediate**... If you run InjectDiag a second time before copying, the temp file gets overwritten.\n\n2. **`Copy-Item` with `-Verb RunAs` inline fails silently**...\n\n3. **deps.json is REQUIRED**: without registering `SSDiagnostics/1.0.0`, .NET 8 will not load `SSDiagnostics.dll` even if the file is present.\n\n4. **Patches are not persisted across SS auto-updates**"
```

### O habito de deixar o trabalho de sessao na raiz do repositorio. CONFIRMADO com os numeros corrigidos: 122 ficheiros soltos em C:\Users\andre\GitSSAM\ (recon_7423d..j.py estao la todos os sete; fix_ict

`runtime`

E a assinatura visivel das familias 'handoff/registo' (60) e 'enderecamento entre corridas' (36): sem lugar canonico para o artefacto de uma corrida, cada sessao inventa um nome novo e o sufixo b/c/v2/v2b vira o sistema de versoes. O runner ja resolveu isto internamente (journals fora do repo, em %LOCALAPPDATA%\SSAM\agent-runtime\<sha12 do repo>, com o corpo do script arquivado por sha) -- e a raiz do repo prova que a solucao existe e nao e usada por humanos nem agentes. Para o Anvil: o kernel tem de DAR o caminho de saida, senao o disco recebe-o.

```
C:\Users\andre\GitSSAM\ssam_agent_runtime\paths.py:28-37 define runtime_cache_dir fora do repo: "repo_id = hashlib.sha1(str(repo_root.resolve()).encode(\"utf-8\")).hexdigest()[:12]" / "return Path(local_app_data) / \"SSAM\" / \"agent-runtime\" / repo_id" ; listagem real da raiz: 122 ficheiros, 26 recon_*, AGENTS.md e RUNBOOK.md ao lado deles
```

### A PRATICA DE CITACAO que produziu este relatorio: atribuir ao Studio decompilado assinaturas e caminhos que nao foram la lidos. Tres casos concretos nesta area: (a) a assinatura de ClipboardManager.De

`runtime`

E a versao subtil do problema que o dono descreveu. Um caminho torto herda-se com a implementacao; uma citacao torta herda-se com a CONFIANCA, que e pior, porque a proxima pessoa nao volta a abrir o ficheiro. Nos tres casos a conclusao acabou por sobreviver, o que torna o habito ainda mais perigoso: acerta-se no veredicto e erra-se na prova, e so um ataque com o ficheiro aberto separa os dois. Regra para o Anvil e para a proxima ronda: um caminho nativo so pode ser afirmado com a linha do decompilado que o declara, colada tal e qual -- nunca com a assinatura que o codigo torto usa para o procurar, porque essa e precisamente a hipotese que se esta a testar.

```
Achado: "ClipboardManager.DeserializeInto(byte[], IPasteTarget, ICommandTarget, IPresenter)" apresentado como caminho nativo.
Origem real dessa string: C:\Users\andre\GitSSAM\ss-patcher\SSDiagnostics\SSModelHandler.cs:5615 -- 'ClipboardManager.DeserializeInto(byte[], IPasteTarget, ICommandTarget, IPresenter) not found'
Decompilado real: ClipboardManager.cs:1338 -- DeserializeInto(byte[] bytes, IPasteTarget target, ICommandTarget originalTarget, ShouldDeserializeObjectHandler shouldDeserialize)
```

### Marcar como `api-nativa-do-modelo` codigo que nao toca na plataforma. Tres das quatro entradas assim rotuladas nesta area nao tem uma unica linha de API do modelo: runner.py:3520-3575 e hashlib sobre 

`runtime`

O rotulo errado corre nos dois sentidos e ambos custam. Para baixo: chamar 'nativo' a uma coisa que e reflection faz herdar divida sem dar por ela -- e o risco que o dono nomeou. Para cima: chamar 'api-nativa-do-modelo' a Python puro cria uma dependencia de plataforma imaginaria e faz hesitar em transplantar exactamente os tres itens que se copiam sem risco nenhum. A entrada do TOCTOU chega a contradizer-se dentro de si propria -- rotulo 'api-nativa-do-modelo' e texto 'Nao ha nada de Studio aqui'. Para a proxima ronda: o rotulo decide-se pelos IMPORTS e pelas chamadas do ficheiro, nao pela impressao de qualidade que o achado deixa.

```
task_execution_policy.py:9 -- "import ast" (nenhum import de plataforma no ficheiro)
runner.py:3528 -- "if file_sha256(script_path) != execution_sha256:"
BridgeManifestHandler.cs:22-25 -- "var assembly = typeof(BridgeManifestHandler).Assembly;" / "var metadata = assembly.GetCustomAttributes<AssemblyMetadataAttribute>()"
SSDiagnostics.csproj:58-62 -- as unicas referencias sao Avalonia.Desktop, Lib.Harmony e SSDiagnostics.TraditionalWeb: NENHUM assembly da OutSystems em todo o projecto
```

### O discriminante proposto para o cego do portao headless: 'separar as ModelFeature que tem checkEnvironmentCompatibility: true'

`migracao`

E o pior tipo de regra: parece medida e nao filtra nada. Contei os 176 construtores de ModelFeature no dump ODC -- 173 tem checkEnvironmentCompatibility: true e 3 tem false. Um filtro que seleciona 98% do universo nao define classe nenhuma. Pior: o mecanismo que o justifica esta errado. O achado dizia que estas features 'so recebem estado do servidor' e que headless 'nunca dispara'; o codigo mostra um fallback explicito para um estado compilado quando nao ha servidor. E ha contraexemplo dentro do mesmo ficheiro: MultiTenant tem checkEnvironmentCompatibility: true E um default ODC de Removed, ou seja e legivel headless. Se este filtro for importado, o kernel ganha uma lista de 173 itens a chamar 'nao-verificavel' quando os verdadeiramente invisiveis sao os 168 que passam `null, null` -- e perde os 2 casos (MultiTenant, ReferencedEntityActions) sobre os quais um job headless podia e devia ficar vermelho.

```
ModelFeatures.cs:847-851, literal: `if (platformServerVersion != PlatformServerVersion.V12) { return feature.DefaultO11CompilerStatus; } return feature.DefaultODCCompilerStatus;` -- precedido de `if (serverInfo != null) { ... }`. Contagem medida no mesmo ficheiro: 176 construtores, 173 com `checkEnvironmentCompatibility: true`, 3 com false; 168 passam `null, null` nos defaults, 8 passam um defaultODCCompilerStatus.
```

### Citar entradas do ficheiro de assinaturas por NUMERO a partir de um intervalo ('entradas 82-91, 94')

`migracao`

Os numeros nao respeitam as familias nem os veredictos, e um intervalo apanha sempre entradas do estado errado. Medido: dentro de '82-91' a entrada 89 e `[B]` e nao `[I]`, e a 94, citada a seguir, e `[C]`. Ao mesmo tempo o intervalo deixa de fora 80, 81 e 96, que sao [I] da mesma familia. O total (17) so saiu certo por compensacao de erros. Se estas citacoes forem para dentro do kernel ou de um documento, ficam la a apontar para as linhas erradas e ninguem volta a conferir.

```
No ficheiro: `89. [B] \`ss.app.rename_module(self, new_name: 'str') -> 'dict[str, Any]'\` (method)` e `94. [C] \`ss.module.get_name(self) -> 'str | None'\` (method)`.
```

### O vocabulario de veredictos do ficheiro de assinaturas: `[I] Incompatible on ODC` para descrever uma falha da ferramenta

`migracao`

Colapsa tres estados distintos num so: 'a plataforma recusa', 'o SDK nao sabe fazer' e 'nao consegui observar o resultado'. Conferido nesta corrida: das 43 entradas [I], 17 sao um presenter do O11 procurado pelo nome (3, 4, 18, 19, 20, 80, 81, 82, 83, 84, 85, 86, 87, 88, 90, 91, 96) e 6 sao a familia aggregate (171-176) que o Anvil faz verde hoje -- 23 de 43 nao sao da plataforma. Um agente frio que leia este ficheiro conclui que o ODC nao sabe fazer joins.

```
Entrada 171, literal e completa: "- Live evidence: python scripts/demo/odc_signature_checks/check_171_212_data_aggregate_live.py invoked ss.aggregate.add_aggregate_attr on ODC1 and raised SSAMError." seguida de "- Notes: add_aggregate_attr(Sum(ODCAggEntity171.Score)) failed. tried: []" -- a evidencia viva e 'levantou SSAMError' e a lista de tentativas esta VAZIA.
```

### Gravar propriedade pelo nome com set_property e nao confirmar por leitura

`migracao`

E o caminho torto na sua forma mais perigosa: devolve SUCESSO e nao escreve nada. O achado original dizia 'pelo menos duas vezes (sa.javascript e ss.flow.set_js_code)' -- sao CINCO, e o que isso muda e a leitura do problema: nao sao dois metodos avariados, e um caminho generico do SDK que falha calado em qualquer propriedade. Alem de JavascriptSource (tres vezes), falha em 'Condition' e em 'Value'. O kernel do Anvil ja tem a resposta certa -- ops declarativas com `get` de readback -- e nao deve importar este atalho em circunstancia nenhuma.

```
Frase identica em cinco linhas do ficheiro (826, 861, 1678, 1883, 1943). Linha 861, literal: "set_property('Condition', '1') on _dwD2RKCtEeidRrg2W+NUQ returned success but read-back observed None. Property may be read-only or rejected by SS -- try a typed helper (set_condition, set_js_code, set_argument) or check the property name spelling." Linha 1883, literal, outra propriedade: "set_property('Value', 'MainContent') on v2YjBnywrUKdIvp4wUEIqA returned success but read-back observed None."
```

### O padrao 'tentar varias estrategias e reportar a ultima excecao' (SetRawProperty -> SetPropertyValue -> ...)

`migracao`

Quando todas falham, a mensagem que chega ao autor e o erro de cast da ULTIMA tentativa, que nao tem relacao com a causa. Em scr.image a mensagem final fala de converter String para AbstractObject, quando a causa real -- documentada em NAO-DA.md:397 e :402 -- e que IImage exige byte[] binary. E o oposto de 'erros que nomeiam e sugerem': o fallback APAGA a causa. Pior: a propria entrada regista que a tentativa deixou lixo no modulo. Nota de precisao ao importar: o item do NAO-DA que da a causa esta marcado IMPRECISO e corrigido -- nao e 'o unico construtor', sao 'as DUAS sobrecargas de CreateImage' que exigem byte[].

```
Entrada 375, linha 1928, literal: "Failed to set property 'DefaultImage' on 'VrIozGDeWkuzDc0RPMqOOA': All strategies failed for DefaultImage: SetRawProperty: Condition is false; SetPropertyValue: Unable to cast object of type 'System.String' to type 'ServiceStudio.Model.AbstractObject'. Retry script did not rerun scr.image because the first live attempt left invalid Image custom properties in the disposable app." Causa real, NAO-DA.md:402: "Assinatura: IImage CreateImage(byte[] binary, string originalPath, string name = null, IKey key = null)."
```

### Usar refresh de lista da UI (poll de 30s a home do Studio) como portao de sucesso de uma mutacao

`migracao`

Ja foi medido a produzir o pior resultado possivel: mutacao bem sucedida no servidor registada como incompatibilidade da plataforma. Contamina tres entradas de uma vez (18, 82, 83) e todas as que dependem delas. O portao tem de ler o estado do RECURSO, nunca o que a janela mostra. Ressalva de rigor para quem importar: so a entrada 18 traz o readback que prova a criacao; as 82 e 83 registam apenas o timeout.

```
Entrada 82, linha 461, literal: "it raised `SSAMError: ODC app 'SSAMODCApp082' was created, but it did not appear in the refreshed home list within 30s.` Follow-up `list_apps()` returned 8 apps and `visibleInHome=False`."
```

### Procurar metodos e presenters do Studio pelo NOME, por reflection, a partir de uma tabela escrita para a outra faixa

`migracao`

E a raiz mecanica do maior bloco de falsas diferencas desta area. Produz duas classes de erro e nenhuma ensina: quando o nome nao existe na outra faixa da 'not found in any TopLevelPresenter' (9 ocorrencias no ficheiro, 17 entradas [I] afectadas), e quando existe em sobrecarga da AmbiguousMatchException do .NET, que chega ao autor disfarcada de incompatibilidade do ODC. Verificado por grep nos dois dumps -- e corrijo o numero que o achado original deu: nao sao 2 ocorrencias no o11, sao 12 (10 de ShowApplicationModules, 2 de CreateApplicationModule), contra ZERO no odc.

```
Entrada 172, literal: "CalcAttr failed (LabelCalc/ODCAggEntity171.Label): Ambiguous match found for 'ServiceStudio.Model.CalculatedAttribute Void SetValue(ServiceStudio.Expressions.AbstractExpression, ServiceStudio.Model.SetReason)'." -- excecao do System.Reflection, nao da OutSystems. E, no setup do ficheiro: "Creating library module `SSAMODCCheckLib` via `ss.add_module(..., \"library\")` blocked: `ShowApplicationModules not found in any TopLevelPresenter`."
```

### Sondas que partem o estado do processo para as sondas seguintes (impact_analysis, find_usages_in_all_modules)

`migracao`

Nao e so lentidao: a entrada 41 regista que depois do timeout ate get_active_module e open_module deixaram de responder ate reiniciar o ODC1 com elevacao. Num corpus de 461 entradas corridas em sequencia sobre UI viva, os resultados a jusante de uma sonda venenosa nao sao de confianca -- e nao ha no ficheiro nenhuma marca a dizer quais foram. Uma suite headless com processo por job nao tem este problema; importar o modelo de sonda sequencial sobre UI viva importa-o de volta.

```
Linha 253, literal: "It timed out after 30s on `find_usages_in_all_modules`; subsequent UI-thread calls such as `get_active_module` and `open_module` also timed out until ODC1 was restarted elevated."
```

### A afirmacao de que o caminho nativo para o gate Public/App-vs-Library 'e MAIS SIMPLES: le-se a flag IsLibraryEspace e a ModelFeature, sem tenant'

`migracao`

E verdade para a ESTRUTURA e falso para o RESULTADO, e a diferenca custa horas a quem tentar. A cadeia de decisao acaba em ModelFeaturesExtensions.CanBeUsedInTool, chamada em ModelFeatures.cs:789, que vive no assembly OutSystems.MetaModel -- e esse assembly NAO esta no dump decompilado (as pastas de odc sao OutSystems.Model, OutSystems.Model.Definition, OutSystems.Model.V1, ServiceStudio.BuiltInBehaviors, ServiceStudio.Presenter, ServiceStudio.ServerCommunications.Phoenix). Quem importar a frase como escrita vai tentar prever headless o valor de Public e nao consegue; o que se apura sem tenant e a forma do gate, nao a resposta. Marcar como nativo o que so e nativo ate meio e exactamente a divida que o dono avisou.

```
ModelFeatures.cs:789, literal: `return ModelFeaturesExtensions.CanBeUsedInTool(feature, featureInTool.Status, serverModelFeatureStatus, isEnabled);` -- e grep por 'CanBeUsedInTool' em todo o C:\Users\andre\ODC3\decompiled\odc devolve esta unica linha, a chamada, sem implementacao.
```

### Derivar severidade por reflexao sobre MsgType. CONFIRMADO e PIOR do que ele descreveu. Ele so citou o lado Python. O lado C# e onde o problema mora e esta tudo documentado no proprio ficheiro: o bridg

`boas-praticas`

E o exemplo perfeito do caminho torto, e o custo esta escrito no codigo: quatro camadas de heuristica e um bug de oscilacao warning<->info pago em producao, tudo para responder a uma pergunta que o .resx responde de forma fixa com 556 linhas de id->severidade->categoria. Copiar isto para o Anvil e herdar um bug ja pago, o remendo, e a fragilidade de sondar propriedades por nome num binario que muda a cada versao. O caminho nativo e mais simples: id -> tabela.

```
SSModelHandler.cs:31864-31869 -- "// The old inline classification was fail-OPEN: MsgType is read by\n    // reflection off the View wrapper and, when the property was absent or\n    // unreadable, ReadWrapperProp returned \"\" and the message silently became\n    // \"info\" — an \"Unused Web Block\" or a \"Performance Warning\" reported as\n    // information, so `warnings` under-counted and the SDK's gate passed on a\n    // module that Service Studio itself was warning about." /// :31984-31988 -- "// REV (2026-09-03): `Kind` and `MessageKind` were REMOVED from this list.\n    // `Kind` is an extremely common Service Studio property name for an\n    // unrelated enum ... so a `Kind` that happens to read \"2\" would have\n    // turned a clean module into a wall of fabricated errors." /// _warning_ratchet.py:231-235 -- "# Bug #28 (KKR 2026-09-03): o bridge deriva `severity` so de MsgType por\n# reflexao e cai em \"info\" para valores nao reconhecidos, entao os MESMOS\n# diagnosticos TrueChange oscilam warning<->info entre reopen/publish e o\n# ratchet acusava \"baseline 0 -> N\" em codigo correto." (ele transcreveu "correcto"; o ficheiro diz "correto")
```

### Arrancar a identidade de uma regra por reflection sobre propriedade NonPublic e depois por REGEX sobre o ToString() do objecto. Este item NAO estava na lista dele -- ele classificou este caminho como 

`boas-praticas`

E a divida central do repo e estava a ser vendida como caminho nativo, que e exactamente o erro que o dono avisou. Tres fragilidades de uma vez: (1) uma propriedade NonPublic pode desaparecer numa actualizacao do Studio sem aviso de compilacao; (2) ToString() e formato de debug, nao contrato -- a OutSystems pode muda-lo a qualquer momento e o parser cala-se em vez de estoirar; (3) um objectKey extraido por LastIndexOf(':') parte-se se algum dia um nome tiver ':'. O Anvil deve receber o id como campo tipado. E na faixa ODC ha alternativa mesmo nativa e ja documentada: GET /findings e GET /patterns.

```
SSModelHandler.cs:24 -- "private const BindingFlags AllInstance = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;" /// :32252-32253 -- "var extraInfoProp = msgWrapper.GetType().GetProperty(\"ExtraInfo\", AllInstance);\n                    var verifyMsg = extraInfoProp?.GetValue(msgWrapper);" /// :32259 -- "sourceId = verifyMsg.ToString() ?? \"\";" /// :32283-32286 -- "// ObjectKey is after the last \":\"\n                            var lastColon = idPart.LastIndexOf(':');\n                            if (lastColon > 0)\n                                sourceObjectKey = idPart.Substring(lastColon + 1);"
```

### Classificar um warning farejando substrings no texto. CONFIRMADO, citacao literal exacta.

`boas-praticas`

Casar por texto e fragil (muda com a lingua e com a versao) e e desnecessario: cada mensagem tem id estavel. O proprio ficheiro faz isto bem noutro sitio, o que mostra que foi atalho e nao desenho. Acrescento uma prova nova de que o texto e mesmo mau discriminador: JSNodeTooLarge conta 800 linhas e o texto diz apenas 'a large amount of code'; ConsecutiveServerInteractions conta chamadas e o texto diz 'several Server Actions'. Quem classificar por palavras perde os dois.

```
_warning_ratchet.py:216-222 -- "blob = \" \".join((\n            warning_rule_id(message),\n            _text(message, \"type\"),\n            _text(message, \"detail\"),\n        )).lower()\n        if \"sql\" not in blob and \"injection\" not in blob:\n            continue"
```

### Um portao de qualidade que so conta. CONFIRMADO, citacao literal exacta em _ai_mentor.py:110-114.

`boas-praticas`

E a familia 'erros que nao ensinam'. Um numero que sobe nao diz o que fazer a seguir e obriga a uma segunda viagem a plataforma. Se o Anvil tiver portao, cada falha tem de nomear a regra, o objecto e o valor -- como o MaxRecordsMismatch nativo faz, que ate CALCULA a expressao sugerida ('Widget.LineCount') e a mete na mensagem.

```
_ai_mentor.py:109-114 -- "        if not result[\"passed\"]:\n            raise O11PlatformApiError(\n                \"ai_mentor.quality_gate\",\n                f\"technical debt findings {finding_count} exceeded max_findings={max_findings}\",\n                response=result,\n            )"
```

### Transformar os checklists dos decks em gates automaticos. CONFIRMADO, citacoes literais exactas no slide e na nota.

`boas-praticas`

Nenhum destes itens tem predicado ('Volume foi considerado?' nao e uma condicao). Para os automatizar era preciso inventar o numero que falta. A propria nota do slide diz que o checklist nao substitui julgamento tecnico e que serve para criar um piso comum -- e uma regua de conversa, nao um gate. O que e automatizavel ja esta implementado como VerifyMessageId.

```
Boas_Praticas_Desenvolvimento_OutSystems.pptx slide12.xml -- "Dimensão\nPergunta\nEvidência\nAção\nOK?\n... Performance\nVolume foi considerado?\nPaginação / logs\nMedir\n□" /// notesSlide12.xml -- "Ele não substitui julgamento técnico; cria um piso comum para que o julgamento seja consistente."
```

### Tratar os decks como fontes independentes. A IDEIA e boa e a deduplicacao e real, mas os NUMEROS estao errados e nao se devem propagar. Nao sao 6 decks, sao OITO ficheiros .pptx em C:\Users\andre\GitS

`boas-praticas`

Contar o mesmo facto quatro vezes da ilusao de corroboracao independente -- nisso ele tem razao e o agrupamento em tres corpos e util. Mas um numero errado numa lista de 'nao trazer' e tao contagioso como um numero errado num achado, e este ja vinha repetido duas vezes na mesma frase. Quem herdar isto deve recontar: sao 8 ficheiros, 3 corpos.

```
Contagem directa das entradas ppt/slides/slideN.xml por ZIP: OutSystems_Best_Practices slides=33; OutSystems_for_Experienced_Developers slides=32 (ele afirma 33); OutSystems_para_Desenvolvedores_Seniores slides=18; OutSystems_para_Desenvolvedores_Seniores_v2 slides=27; Boas_Praticas_Desenvolvimento slides=13; Boas_Praticas_Tecnicas slides=16; Data_for_Senior_Developers slides=17; Data_for_Senior_Developers_External_Integration slides=24. Total de ficheiros .pptx na pasta: 8.
```

### Citar como prova o scratchpad de OUTRA sessao de agente. Ele fez isto tres vezes, com caminhos do tipo C:\Users\andre\AppData\Local\Temp\claude\...\scratchpad\Boas_Praticas_Tecnicas_OutSystems.txt:262

`boas-praticas`

Um scratchpad e especifico da sessao, isolado e apagavel -- a 'prova' desaparece e ninguem a pode reabrir. Foi precisamente por isto que tive de reextrair tudo do .pptx a mao para poder confirmar. E com reticencias no caminho nem sequer e um caminho. Alem disso os numeros de caracteres que ele cita (33328 e 20308) vem dessa extraccao e nao sao reproduziveis: a extraccao directa dos slides da 11671 e 6863 -- a diferenca e provavelmente notas e outros XML, mas nao ha maneira de confirmar. Regra para o Anvil: a citacao tem de apontar para o artefacto duravel (o .pptx e a parte XML, ex. ppt/slides/slide14.xml), nunca para um ficheiro temporario de trabalho.

```
Caminhos citados por ele: "C:\\Users\\andre\\AppData\\Local\\Temp\\claude\\...\\scratchpad\\Boas_Praticas_Tecnicas_OutSystems.txt:262-279", "...\\scratchpad\\OutSystems_Data_for_Senior_Developers.txt:261", "...\\scratchpad\\OutSystems_Best_Practices.txt:766". Reextraccao directa dos ZIP confirma o CONTEUDO dos tres, mas os numeros de linha e de caracteres nao sao verificaveis.
```

### Usar o campo `estado` para descrever a qualidade da REGRA da plataforma em vez do caminho da IMPLEMENTACAO. Ele marcou EntityActionInsideLoop como 'funciona-mas-por-caminho-torto' porque a regra nativ

`boas-praticas`

Mistura dois eixos que o dono pediu explicitamente para separar. 'Caminho torto' e sobre COMO o conhecimento foi arrancado e implementado (reflection, trace, ToString parsing); uma regra nativa com alcance limitado e nativa e funciona -- so nao cobre tudo. Se o vocabulario se contamina, perde-se a capacidade de ver onde esta a divida real: neste lote, o unico 'torto' verdadeiro e o ratchet/bridge, e ele marcou-o como nativo enquanto marcava como torto uma regra do proprio Studio. Os dois erros juntos invertem exactamente o sinal que o campo existe para dar.

```
No ENCONTRADO: EntityActionInsideLoop -> "estado": "funciona-mas-por-caminho-torto" + "comoFoiObtido": "api-nativa-do-modelo"; ratchet -> "estado": "funciona-hoje-por-caminho-nativo" + "comoFoiObtido": "api-nativa-do-modelo". A realidade e o inverso: Nodes.cs:36198 e ModelExtensions.cs:4428 sao modelo nativo; _warning_ratchet.py:262-267 + SSModelHandler.cs:32252-32267 sao regex sobre ToString() de objecto obtido por reflection NonPublic.
```

