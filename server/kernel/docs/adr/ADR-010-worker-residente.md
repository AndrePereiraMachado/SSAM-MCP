# ADR-010: Worker residente com fila observavel

Data: 2026-09-04. Estado: aceito e provado no SS5 (passo 17).

## Decisao

O mesmo Dispatch do CLI serve o processo frio e o worker, incluindo comandos de servidor que recebem
--credentials por arquivo. Nenhuma credencial entra no protocolo como segredo ou em logs de argumentos.
O transporte vive em Hosting, sem dependencias do modelo: aceita conexoes em paralelo, responde ping fora
da fila e entrega comandos a uma unica thread. Metricas do modelo sao capturadas nessa thread depois do
comando; ping consulta a copia e o estado da fila, nunca acessa o modelo concorrentemente.

ping informa busy/currentCommand/runningMs/queued, commands (nao-ping), served (todos), PID e identidade da
instancia. queuedMs pertence ao envelope do comando. O worker drena depois de ANVIL_WORKER_MAX_COMMANDS
(default 5000) ou heap >2 GB em dois comandos consecutivos. Pedidos ainda na fila recebem executed:false e
retryable:true. O cliente so os repete nessa condicao ou se connect foi recusado antes de enviar bytes.
Ligacao perdida depois do envio tem resultado desconhecido e nunca provoca replay automatico.

anvil_cli arranca o worker sob lock O_EXCL por porta; outro processo ganhar a porta conta como sucesso.
Ping sem resposta com listener vivo permite terminar apenas o PID do ultimo ping deste protocolo, depois
de comparar a identidade de criacao do processo (handle no Windows). PID reutilizado nunca autoriza kill.
ECONNREFUSED arranca outro worker sem matar um processo que ainda esta a terminar respostas da reciclagem.
ANVIL_WORKER=0 e o opt-out; Studio ausente conserva o caminho frio e a mesma mensagem de instalacao.
Logs separados por porta e PID; shutdown espera o processo sair antes de permitir build.

## Provas

Sockets reais em WorkerServerTests: ping com trabalho em curso, fila serial, recusa antes de executar ao
drenar, limite de heap com dois pedidos e pings fora da contagem. Cliente Python: 8 testes de fallback,
identidade, locks e replay. Dois applies simultaneos no SS5: segundo queuedMs=3711, ambos accepted via worker.
Porta isolada: dois processos arrancaram o mesmo PID 44712; limite 5, comandos 6/7 no PID 42988; processo
suspenso foi substituido pelo PID 59680 e depois encerrado. Soak service-action, 2 rodadas: assinaturas
identicas ao frio e zero erros novos, heap pos-GC de 8 MB; logs sem client gone.
