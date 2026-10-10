# Testar o produto com outra LLM (fora do Claude)

O produto foi desenhado para qualquer LLM sem contexto: o unico ponto de entrada e `AGENTS.md`, a unidade de trabalho e um
job JSON de verbos, e o juiz e o runner (`scripts/run_job.py`), nao a LLM. Por isso testar com outra LLM e so mudar quem
escreve o job. Ha tres maneiras, da mais fiel a mais simples.

## 0. Pre-requisitos na maquina (iguais para todas)

- Repositorio `C:\Users\andre\Anvil` com o CLI construido: `dotnet build src/Anvil.Cli -c Release -o .local/cli`.
- Service Studio 11 "Anvil 4516" instalado (o runtime headless usa as DLLs dele; a janela nao precisa de estar aberta para
  provar headless; so para entregar por merge).
- Python 3. Opcional: worker residente (`python scripts/anvil_worker.py start`) para cada execucao demorar 0,3 s em vez de 4 s.
- NAO dar a outra LLM: arquivos de credenciais, o verbo `login`, `--publish`. Para a medida de atrito basta o headless.

## 1. Ferramenta agentica no repositorio (a mais fiel)

Qualquer agente que leia arquivos e execute comandos serve: OpenAI Codex CLI, Cursor (agent), GitHub Copilot (agent mode),
Gemini CLI, Cline, Windsurf, Aider. Abrir a ferramenta na pasta do repositorio e dar EXATAMENTE a instrucao das sessoes frias:

    Leia AGENTS.md por inteiro e faca esta tarefa: <tarefa>. Entregue o job em tests/jobs-cold/<nome>.json, execute
    `python scripts/run_job.py tests/jobs-cold/<nome>.json` ate dar isValid=True, e no fim escreva um log de atrito:
    arquivos lidos alem do guia, execucoes ate passar, duvidas, o que faltou no guia.

Quem encontra o guia sozinho: Codex e Cursor leem `AGENTS.md` por convencao; Claude Code le `CLAUDE.md`; Gemini CLI le
`GEMINI.md`; Copilot le `.github/copilot-instructions.md`; Cline `.clinerules`; Windsurf `.windsurfrules`; Cursor tambem
`.cursor/rules/`. Todos esses arquivos existem na raiz e sao so um ponteiro para `AGENTS.md`, para nao haver duas verdades.

Permissoes: a ferramenta tem de poder correr `dotnet` e `python` na pasta (algumas pedem confirmacao por comando).

## 2. LLM so de chat, sem ferramentas (ChatGPT web, Gemini web, etc.)

Funciona porque o job e JSON puro e a verificacao e nossa:

1. Colar o `AGENTS.md` inteiro na conversa (cabe: ~180 linhas) e, se a tarefa pedir, o job de exemplo que a tabela da
   secao 1 manda copiar (`tests/jobs/<exemplo>.json`).
2. Pedir: "Escreva o job JSON para: <tarefa>. Responda so com o JSON."
3. Guardar a resposta em `tests/jobs-cold/<nome>.json` e correr `python scripts/run_job.py tests/jobs-cold/<nome>.json`.
4. Colar a saida do runner de volta (erros com caminho do no, hints de funcao) e pedir a correcao. Contar as rodadas.

E o mesmo laco que uma LLM agentica faz sozinha, so que a mao. Serve para medir a qualidade do guia e das mensagens.

## 3. Harness por API (para repetir em escala)

Um script que chama a API do fornecedor com o `AGENTS.md` como system prompt e a tarefa como mensagem, guarda o JSON,
corre o runner e devolve a saida ate passar ou esgotar N rodadas. Ainda nao existe; e a forma de comparar fornecedores com
as mesmas 10 tarefas e o mesmo criterio. Fica para quando houver dois fornecedores a comparar.

## Tarefas de referencia (as mesmas das rodadas frias do Claude)

Rodada 1 (docs/tasks/2026-09-04-sessoes-frias-rodada-1.md): A service action que le e grava; B tela Reactive com pesquisa,
Table e Refresh; C tela Traditional + BPT + timer; D client action com JavaScript; E REST GET com query e structure aninhada.
Rodada 2 (…-rodada-2.md): F Mobile local storage + Accordion; G email com ForEach + timer; H refatoracao com usages/rename/
delete; I dois modulos com `reference`; J DatePicker com handler + Tag + Tooltip + Counter.

Resultado do Claude para comparar: 10/10 passaram; rodada 1 todas a primeira; rodada 2 tres com uma execucao falhada;
4 a 12 arquivos lidos alem do guia.

## O que registar por sessao

Execucoes ate `isValid=True`; arquivos lidos alem do guia; perguntas que a LLM fez ou teria feito; trechos do guia que ela
citou como ambiguos. Cada atrito vira texto no guia ou mensagem no runner, como nas rodadas do Claude: o objetivo nao e
pontuar a LLM, e encontrar o que o produto ainda nao diz.
