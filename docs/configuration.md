# Configuração

Copie `.env.example` para `.env`. Os scripts npm carregam esse arquivo com a opção nativa `--env-file-if-exists`. Para execução direta, defina as mesmas variáveis no ambiente antes de `node server.js`.

| Variável | Obrigatória | Uso |
| --- | --- | --- |
| `PORT` | Não | Porta HTTP e WebSocket; padrão `3000`. |
| `HOST` | Não | Interface de rede do servidor; padrão `0.0.0.0`. |
| `STUN_URL` | Não | Uma ou mais URLs STUN, separadas por vírgula. Padrão: `stun:stun.l.google.com:19302`. |
| `TURN_URL` | Em redes que precisem de retransmissão | Uma ou mais URLs TURN, separadas por vírgula. Sem ela, não há relay TURN. |
| `TURN_SHARED_SECRET` | Com `TURN_URL` | Segredo compartilhado do servidor TURN compatível com credenciais temporárias no formato HMAC-SHA1 (como coturn REST). Permanece no back-end. |

`GET /api/ice` fornece ao navegador a lista ICE. O servidor gera nome de usuário e senha TURN com validade de uma hora usando o segredo compartilhado. Configure URLs e segredo no serviço TURN e na aplicação. Não use senha estática no front-end. Os exemplos em `.env.example` são endereços fictícios e devem ser substituídos.

O servidor HTTP não configura TLS. Em produção, termine HTTPS/WSS em um proxy reverso e encaminhe as conexões WebSocket.
