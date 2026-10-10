# SSAM por HTTPS para um cliente de fora

Como publicar o servidor hospedado (`ssam serve`, [SERVIDOR-LOCAL.md](SERVIDOR-LOCAL.md)) para um testador fora desta
máquina. O desenho está em [FASE2-AGENTE.md](FASE2-AGENTE.md), seção 9.1.

## Regras antes de começar

- O servidor continua escutando em `127.0.0.1`. Quem publica o HTTPS é um túnel ou proxy NESTA máquina.
- Só o servidor **hospedado** pode ser exposto. **Nunca exponha um servidor `--local-studios`** por túnel ou proxy:
  nesse modo qualquer token dirige os Studios do dono. Ele recusa `--public-host`, `--allow-remote` e pedidos com
  cabeçalho de proxy (`FORWARDED_REFUSED`), mas isso é rede de segurança: um proxy que não manda esses cabeçalhos
  passaria, e o túnel rápido abaixo reescreve o `Host` para `127.0.0.1:7300`, que passa na verificação de loopback.
- O proxy não pode bufferizar respostas: o `/mcp` usa SSE e o canal do agente (`/agent/v1/stream`) usa NDJSON. O
  servidor manda `: keepalive` a cada 25 s numa resposta SSE parada; um `o11_deliver` pode levar até 60 min.
- `--allow-remote` não é necessário para nenhum dos caminhos abaixo.

## Conta Windows dedicada (recomendado)

OML e JSON enviados pelo cliente são lidos pelas DLLs de modelo do Studio e pelo kernel, na sessão de quem roda o
servidor. Um defeito de parser vira acesso àquela conta. Por isso:

1. Crie uma conta Windows local sem privilégio de administrador só para o servidor.
2. Dê a ela leitura na pasta do clone (`C:\Users\andre\SSAM-Hybrid-servidor`) e escrita só nas pastas `.local` do
   clone (estado do servidor, workspaces dos clientes, índices).
3. Instale ou aponte o Service Studio do kernel: `ANVIL_STUDIO_DIR` com a pasta do Service Studio 11.55.91 (o padrão
   é a cópia da faixa sob o perfil do usuário, que essa conta não tem).
4. Rode `.\scripts\servidor.ps1 start` com essa conta. Os tokens são emitidos na mesma `.local\server`
   (`.\ssam server-token ...`, ou `SSAM_SERVER_DIR` apontando para ela).

## Caminho 1: túnel rápido da Cloudflare (teste)

Sem conta nem domínio. A URL muda a cada início.

1. Suba o servidor hospedado: `.\scripts\servidor.ps1 start` (porta 7300).
2. Em outro terminal:

   ```powershell
   cloudflared tunnel --url http://127.0.0.1:7300 --http-host-header 127.0.0.1:7300
   ```

   O `cloudflared` mostra uma URL `https://<aleatório>.trycloudflare.com`. O `--http-host-header` reescreve o `Host`
   para `127.0.0.1:7300`, então o servidor aceita sem `--public-host`.
3. Emita o token do cliente: `.\ssam server-token issue --customer "Cliente X" --days 7`. Mande o token e a credencial
   do agente por um canal seguro, separados.
4. O cliente configura o MCP com `https://<aleatório>.trycloudflare.com/mcp` (exemplo
   `docs/exemplos/mcp-cliente-hospedado.json`) e o agente com `setup --server https://<aleatório>.trycloudflare.com`
   (`docs/AGENTE-CLIENTE.md`).
5. Para encerrar: `Ctrl+C` no `cloudflared` e `.\ssam server-token revoke --id tok_...`.

O `cloudflared` não bufferiza respostas. Só use este comando com o servidor hospedado.

## Caminho 2: túnel nomeado com domínio próprio (estável)

Para uma URL fixa, com o domínio na Cloudflare:

1. `cloudflared tunnel login` e `cloudflared tunnel create ssam`.
2. Rota DNS: `cloudflared tunnel route dns ssam ssam.seudominio.com`.
3. `config.yml` do túnel:

   ```yaml
   tunnel: ssam
   credentials-file: C:\Users\<conta>\.cloudflared\<id>.json
   ingress:
     - hostname: ssam.seudominio.com
       service: http://127.0.0.1:7300
     - service: http_status:404
   ```

4. Servidor com o nome público: `.\ssam serve --public-host ssam.seudominio.com --log-file .local\server\server.log`.
   O `--public-host` aceita `ssam.seudominio.com` (e `:443`) no `Host` e `https://ssam.seudominio.com` na `Origin`;
   os demais hosts continuam recusados. Repita a opção para mais de um nome.
5. `cloudflared tunnel run ssam`.

O `servidor.ps1` não repassa `--public-host`; para o túnel nomeado rode `.\ssam serve` em primeiro plano (ou num
agendador de tarefas da conta dedicada).

## Caminho 3: Caddy ou nginx (domínio e porta 443 abertos)

Caddy, com `flush_interval -1` para não bufferizar:

```
ssam.seudominio.com {
  reverse_proxy 127.0.0.1:7300 {
    flush_interval -1
  }
}
```

nginx, com `proxy_buffering off` e tempo de leitura longo:

```
location / {
  proxy_pass http://127.0.0.1:7300;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_buffering off;
  proxy_read_timeout 3700s;
}
```

Nos dois casos rode `.\ssam serve --public-host ssam.seudominio.com`.

## Conferir

- `https://<host>/health` responde `{"ok":true,"pid":...}` sem token.
- `https://<host>/mcp` sem token: 401. Com o token: o cliente MCP lista as ferramentas.
- O log (`.local\server\server.log`) mostra `listening` com `mode: "hosted"`, as sessões e o canal do agente
  (`agent-connected`) quando o cliente liga o agente.
- `.\ssam server-token revoke --id tok_...` derruba a sessão MCP e o canal do agente em até 1 s.
