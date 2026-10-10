# Vários agentes em paralelo no mesmo Studio

Este guia é para o time. Ele diz como rodar várias sessões (Claude, Codex ou outro agente) ao mesmo tempo, no mesmo Service Studio ou no mesmo ODC Studio, sem uma atrapalhar a outra.
Vale também para o servidor hospedado, onde vários clientes entregam ao mesmo tempo.

## A regra curta

- Um módulo por agente.
- Cada agente entrega com `o11_deliver` ou `studio_deliver`, numa chamada só por mudança.
- Ninguém espera nada à mão. Ninguém repete uma entrega por causa de fila. O SSAM espera a vez dentro da chamada.

## O que roda junto e o que espera

Uma entrega tem duas fases.

**1. Build (roda junto).**
- O SSAM captura o módulo pela chave da aba, sem selecionar a aba.
- O kernel aplica o job nessa captura, sem o Studio (headless).
- No ODC, o builder prepara o manifesto, também sem o Studio.
- Essa fase não segura o Studio. Builds de módulos diferentes rodam ao mesmo tempo.
- Ela roda num pool de workers de build. O tamanho vem de `SSAM_BUILD_WORKERS` (padrão: o menor entre 4 e núcleos menos 1).
- Cada worker tem a sua pasta TEMP. Cada worker tem o seu processo residente do kernel (o worker 0 é o worker da faixa; o worker i usa a porta base + i × `poolStep`).
- O pool é justo entre clientes: o próximo worker livre vai para o cliente com menos builds rodando. No servidor hospedado, o cliente é `SSAM_CUSTOMER` (ou a pasta dele). Um cliente com dez builds na fila não segura o build único de outro.

**2. Apply (espera a vez).**
- Merge, verificação (TrueChange) e publish.
- Essa fase pega a trava do Studio e fica com ela até o fim da chamada.
- Applies do mesmo Studio rodam um de cada vez, na ordem de chegada (fila FIFO). Cada um leva segundos.
- No ODC, a captura também passa pela trava, por um instante: a ponte do ODC atende um comando por vez.

Por que o apply é em série: o Studio tem um modelo vivo, uma pilha de desfazer e um verificador. Dois merges ao mesmo tempo no mesmo Studio podem se misturar. O build não toca nada disso, então pode rodar junto.

## Duas entregas no mesmo módulo

- A segunda espera a primeira terminar (build e apply). Depois ela captura o módulo de novo e constrói em cima do que a primeira aplicou.
- Nada é sobrescrito em silêncio.
- Se o módulo mudou entre o build e o apply (por exemplo, alguém editou no Studio), o SSAM refaz o build sobre o módulo como ele está agora, na mesma chamada. A resposta diz `phases.rebased`.
- Se o job e a mudança nova colidem de verdade (por exemplo, o elemento que o job cria já existe), a recusa diz o elemento e a correção, como qualquer recusa do kernel.

Por isso: um módulo por agente. Dois agentes no mesmo módulo funcionam, mas um espera o outro.

## O que a resposta mostra

Uma entrega que construiu fora da trava responde `phases`:

| Campo | O que é |
|---|---|
| `buildMs` | tempo de build (captura, kernel, builder) |
| `queuedMs` | tempo esperando: o módulo, um worker de build e a vez no Studio |
| `applyMs` | tempo com o Studio (merge, verificação, publish) |
| `buildQueue` | `{position, waitedMs}` quando esperou um worker de build |
| `moduleQueue` | `{position, waitedMs}` quando esperou outra entrega do mesmo módulo |
| `rebased` | `{reason}` quando o build foi refeito sobre o módulo atual |

O recibo da entrega guarda os mesmos campos:
- O11: `phases.json` na pasta da tarefa do kernel (`<work>/deliver/<taskId>`).
- ODC: `phases` dentro de `deliver-result.json` da pasta de evidência.

`queue {position, waitedMs, holder}` continua aparecendo quando o apply esperou a vez no Studio.

## Quando a espera acaba

- O limite é `SSAM_WRITE_QUEUE_MS` (padrão 240 s) para o Studio e `SSAM_BUILD_QUEUE_MS` (padrão: o mesmo) para o pool e para o módulo.
- Só uma espera que estoura recusa. Nada daquela entrega rodou.
  - `STUDIO_WRITE_QUEUE_TIMEOUT`: a vez no Studio não chegou.
  - `BUILD_QUEUE_TIMEOUT` com `waitedFor: "module"`: outra entrega do mesmo módulo não terminou.
  - `BUILD_QUEUE_TIMEOUT` com `waitedFor: "pool"`: nenhum worker de build ficou livre.
- A recusa traz `position`, `waitedMs`, `queueMs` e a continuação. Siga a continuação; a mesma entrega pode ser repetida.

## O que continua igual

- Só constrói fora da trava a ferramenta de entrega que declara as fases no registro (`_meta` `ssam/phases`: `o11_deliver` e `studio_deliver`). Qualquer outra escrita segura o Studio na chamada inteira. Uma escrita nunca roda sem trava porque o código dela não conhece as fases.

- Leituras (`ssam_map`, `ssam_discover`, `o11_inspect`, `studio_inspect`) nunca esperam.
- `o11_data` tem a sua própria trava, por módulo. Ele roda ao lado de uma entrega.
- `close`, `until=apply` e as outras escritas pegam o Studio na chamada inteira, como antes.
- Um módulo que não está aberto numa aba (O11) entrega como antes: o build roda dentro da trava.
- Jobs com `rest`, `rest-expose` ou `soap`, `resume`, `closePrevious` e `captureProducers` também entregam como antes: eles precisam do Studio desde o começo.

## Como rodar vários agentes

1. Abra o Studio uma vez e conecte (`ssam_connect`).
2. Dê a cada agente um módulo seu. Diga isso no prompt de cada um.
3. Cada agente usa `ssam_discover` e entrega com `o11_deliver` ou `studio_deliver`.
4. Não peça para um agente esperar o outro. O SSAM faz a fila.
5. Para ver o que está rodando: `o11_studio {command:"status"}` ou `studio_status`.

## Medida offline

Teste `platforms/odc/facade/tests/pa3-wp-load.test.mjs`: 8 entregas em 4 módulos do mesmo Studio, com ponte e kernel falsos (build de 300 ms, merge de 60 ms), 4 workers.
- Uma depois da outra: cerca de 3,2 s.
- Todas juntas: cerca de 1,0 s (3 vezes mais rápido).
- Os merges nunca se sobrepõem. As duas entregas de cada módulo nunca constroem ao mesmo tempo.

## Onde está no código

- `platforms/odc/facade/studio-write-lock.mjs`: as fases, a trava do Studio, a guarda por módulo.
- `platforms/odc/facade/build-pool.mjs`: o pool de build.
- `platforms/odc/facade/o11-build-phase.mjs` e `odc-build-phase.mjs`: o build de cada faixa.
- `kernel/src/Anvil.Core/Delivery/PrebuiltCandidate.cs`: o apply do O11 reaproveita o candidato só sobre o mesmo modelo.
