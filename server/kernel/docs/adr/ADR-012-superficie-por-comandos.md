# ADR-012: Superficie por comandos

Data: 2026-09-05. Estado: aceito (decisao do dono no plano, implementada).

## Decisao

O produto separa o conhecimento e os compiladores do trabalho com OML. Specs, esquemas, convencoes,
checagens e ponteiros para receitas podem ser servidos por nossa conta; o cliente envia specs, nunca OML.
Load, Verify, snapshot, apply e merge continuam locais. Desligar a conta interrompe o acesso ao servico.
Este passo entrega as projecoes no CLI local com entradas explicitas; nao implementa servidor, licenciamento
ou transporte de specs. A futura exposicao em servico usa o mesmo contrato, sem enviar modulos.

`api --op logic|spec|screen` projeta as listas usadas pelos compiladores; `spec` agora recusa chaves
ignoradas antes. Records de static aceitam tambem atributos declarados pela entidade. Nenhum explain
reempacota prosa. `recipe --find` aponta apenas para jobs da suite mencionados na tabela AGENTS, com
linha, descricao e numero de ops (compostos expandidos). `--ops` exige --max positivo, limite global.

`verify-message` recebe definicoes extraidas localmente: campos public static VerifyMessageId e textos
embebidos via ResourceManager. ResourcesBaseName nao e publico no build instalado; o adaptador descobre
o nome pelo manifesto publico da assembly. Valida o formato observado de 13 campos e falha explicitamente
se mudar. A severidade e a bruta do recurso, sem heuristica de Suggestion. Os 468 IDs coincidem com o
manifesto; os textos antigos foram comparados localmente antes de sair do repo. Nao se copia codigo
nem binario do fornecedor. Ficam 169 hints curados, sem os 299 que repetiam o Detail.

O arquivo verify-messages-11.55.69.json fica como manifesto SOMENTE de IDs: mantem a validacao de
expectedMessages offline e a compatibilidade do worker da outra faixa ainda carregado. A fonte dos
textos passa a ser sempre a DLL. O teste exige paridade de IDs em ambos os sentidos e que cada hint tenha
um ID conhecido; nao exige hint para todo ID, porque 299 nao precisam de uma segunda explicacao.
Hints inline sao opcionais na bridge instalada fora do repo; sua ausencia nao impede o Verify.

`where-can` usa provas dos quatro fixtures, conta de Creatables e SHA256 do catalogo com finais de linha normalizados para LF (checkout Windows/git). Recusa mapa
parcial ou velho mesmo com o mesmo nome de arquivo. Retorna pais possiveis do catalogo e evidencia
por runtime. no-parent e alcance limitado da sonda (profundidade 4), nao proibicao da plataforma;
Library fica explicitamente sem prova. A geracao libera o ESpace no finally e guarda nomes completos
para distinguir interfaces homonimas.

## Fronteiras e verificacao

CommandSurface projeta dados; VerifyCatalog e o adaptador da instalacao. O CLI so encaminha argumentos.
SurfaceTests cobrem manifestos/hints, recusa de mapa desatualizado, limites de receitas compostas,
chaves fechadas, atributos dinamicos de static e diferencas entre os quatro runtimes. Os exemplos de
ouro e a suite continuam sendo julgados pelo Verify real. Evidencias e limites ficam em PROVAS.md e
no plano; uma avaliacao fria pendente nunca e contada como concluida.
