# Argumentos opcionais na fronteira C#

O autor usa a sintaxe normal de C#, como `int count = 2` ou `Row? value = null`.
Roslyn vincula as omissões em chamadas da própria fonte, preservando a ordem de
avaliação dos argumentos nomeados. O corpo da action recebe valores completos;
a distinção entre omissão e valor fornecido pertence à fronteira de chamada.

Para uma entrada de grafo com parâmetro opcional, ABI4 acrescenta apenas
`optional: true` ao descritor desse input. O parâmetro nativo é opcional e usa
um registro tipado `IsSpecified/Value`. O compilador obtém o initializer original
de Roslyn e o traduz pelo mesmo caminho usado no corpo; o SDK não interpreta
defaults nem recebe uma segunda tabela de regras de negócio.

O SDK envia `IsSpecified=true` para valores fornecidos, inclusive null explícito.
Omissão deixa a chave fora do JSON; o parâmetro nativo assume seu registro padrão,
com `IsSpecified=false`. A entrada valida o payload inativo canônico antes de
selecionar o default C#. Somente raízes fornecidas entram no grafo, preservando
as identidades do chamador. Os construtores públicos anteriores do SDK foram
mantidos; ABI2 e ABI3 continuam recusando esse novo metadado.

O patch teve 30 testes próprios e uma revisão independente com defaults
temporais, nullable decimal, referências e argumentos nomeados com efeitos.
A integração combinada passou 1.107 testes do frontend. Em 5043, seis endpoints
da fonte `BoundaryComposition.cs.txt` passaram 18/18 chamadas HTTP com SDK
congelado. Os recibos conferem chaves ausentes em Stamp, Pick, Record e NewHeader,
e wrappers fornecidos para null explícito. Os 51 arquivos do runtime ficaram
intactos; um executor separado corrigiu somente o gravador de evidência antes
da primeira requisição HTTP. Evidência: `.local/data-logic-translator/boundary-composition-progress.json`.

A prova é staged e não ativa a autoria pública automática. Defaults de structs
fonte e char têm correção adicional em cópia isolada. A política futura para char
inativo deve usar ABI5 para preservar os contratos ABI4 já publicados. Persistência,
consumo entre módulos e uso cego não são demonstrados por estes casos de omissão.
