# Arquitetura

## Componentes

- `public/index.html`, `public/styles.css` e `public/app.js`: interface responsiva, estado da sala, permissões de captura e lógica WebRTC.
- `server.js`: servidor HTTP, endpoints de salas, entrega dos arquivos estáticos, endpoint de configuração ICE e servidor WebSocket nativo para sinalização.
- `package.json`: scripts de execução; não há bibliotecas npm externas.

## Comunicação

1. O navegador faz `POST /api/rooms`. O servidor gera código hexadecimal aleatório de 12 caracteres e token secreto de anfitrião. O token fica no `sessionStorage` da sessão do criador; o convite contém somente o código.
2. Anfitrião e espectadores conectam em `/ws`. O navegador autentica o anfitrião com o token após a conexão WebSocket; o token não fica na URL do convite. O servidor valida a sala e encaminha apenas mensagens de sinalização entre o anfitrião e os espectadores. Espectadores não podem enviar sinalização a outros espectadores.
3. Ao escolher compartilhar, o navegador chama `getDisplayMedia` após ação do usuário. O anfitrião cria uma conexão RTCPeerConnection por espectador e envia oferta, resposta e candidatos ICE pelo WebSocket.
4. O vídeo vai direto do navegador do anfitrião para os espectadores via WebRTC. O servidor de sinalização não recebe nem grava a mídia.
5. O servidor informa alterações de estado. Parar a captura fecha as conexões de mídia; encerrar a sala fecha os sockets e remove o estado em memória.

## Salas e limites

O servidor armazena salas em memória. Cada sala tem limite de vida de seis horas; se o socket do anfitrião cair, há um período de 90 segundos para reconexão. Reiniciar o processo apaga as salas. A abordagem WebRTC ponto a ponto funciona para grupos pequenos, mas o upload do anfitrião aumenta para cada espectador.

Não há autenticação de espectadores: qualquer pessoa com o link/código pode assistir e compartilhar o link. O token privado permite ao navegador criador retomar o papel de anfitrião e encerrar a sala.
