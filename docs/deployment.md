# Implantação

1. Use um ambiente com Node.js 22.9 ou mais recente e disponibilize os arquivos do projeto.
2. Configure `.env` ou as variáveis do ambiente: ao menos `PORT` conforme o host; defina `STUN_URL`, `TURN_URL` e `TURN_SHARED_SECRET` para dar suporte a redes diferentes.
3. Execute `npm start` sob um gerenciador de processos ou como serviço.
4. Configure proxy reverso com TLS válido. Encaminhe requisições HTTP e upgrades WebSocket ao mesmo processo e mantenha `Upgrade`/`Connection` para a rota `/ws`.
5. Teste o compartilhamento entre redes distintas e confirme que o TURN consegue retransmitir mídia. Proteja o segredo TURN como segredo de servidor.

O estado das salas é local à memória do processo: rode uma única instância. Reiniciar o processo remove todas as salas; múltiplas instâncias precisam de um serviço compartilhado de salas/sinalização que ainda não foi implementado. O servidor não fornece HTTPS próprio. Restrinja o acesso ao processo atrás do proxy e monitore disponibilidade, conexões e falhas de sinalização.
