# Brutroom

Salas temporárias para compartilhar a tela com outras pessoas por um link. O navegador captura a tela somente depois que o anfitrião escolhe **Compartilhar tela** e concede permissão.

## Funcionalidades

- Criar salas com código aleatório e link de convite.
- Entrar por link ou código, copiar o convite e sair da sala.
- Compartilhar e encerrar a tela; detectar quando a captura é interrompida pelo navegador.
- Assistir como espectador, sem controles de captura.
- Usar WebRTC para mídia e WebSocket para sinalização.
- Configurar STUN e TURN por variáveis de ambiente. Credenciais TURN de curta duração são geradas no servidor.
- Encerrar a sala pelo anfitrião e limpar salas após expiração ou desconexão prolongada.

## Requisitos

- Node.js 22.9 ou mais recente; Node.js 24 LTS é recomendado. npm vem com Node.js.
- Navegador moderno com suporte a `getDisplayMedia`, WebRTC e WebSocket. A permissão de captura depende do navegador e do sistema operacional.
- HTTPS para uso fora de `localhost`.

Não há dependências npm externas. Servidor HTTP, sinalização WebSocket e interface usam APIs nativas do Node.js e do navegador.

## Instalação e execução

```bash
node --version
npm start
```

Abra [http://localhost:3000](http://localhost:3000). Para reiniciar o servidor automaticamente durante desenvolvimento:

```bash
npm run dev
```

Copie `.env.example` para `.env` se precisar alterar a configuração. O `.env` é ignorado pelo Git. Não é necessário rodar `npm install`, pois o projeto não usa pacotes externos.

## Como usar

1. Clique em **Criar uma sala**. O navegador cria uma sala temporária e mantém o token de anfitrião na sessão local.
2. Clique em **Copiar convite** e envie o link aos espectadores.
3. Clique em **Compartilhar tela** e escolha uma tela, janela ou aba nas opções oferecidas pelo navegador.
4. Os espectadores abrem o convite e recebem a transmissão quando a negociação WebRTC se completa.
5. O anfitrião pode encerrar somente a transmissão ou encerrar a sala. O espectador pode sair.

As salas e tokens são mantidos em memória pelo processo Node. Reiniciar o servidor encerra as salas.

## Teste entre navegadores

Execute o teste automatizado de sala, sinalização e encerramento com:

```bash
npm test
```

1. Inicie o servidor em `localhost`.
2. Em uma janela, crie a sala, copie o link e inicie o compartilhamento.
3. Abra o link em outro navegador ou janela privada. Confirme que a imagem aparece e que o espectador não vê o controle de captura.
4. Pare o compartilhamento pelo site e também pelo seletor do navegador; confirme o estado de espera.
5. Encerre a sala e confirme que o link passa a informar que ela não existe mais.

Para testar em dispositivos diferentes, a aplicação precisa estar disponível por HTTPS e acessível pelos dois dispositivos. Redes diferentes podem exigir STUN/TURN; o teste só em `localhost` não valida a conectividade por TURN.

## Limitações

- O estado das salas fica em memória: uma instância única é necessária e uma reinicialização apaga todas as salas.
- WebRTC faz uma conexão direta entre o anfitrião e cada espectador. O upload do anfitrião cresce com o número de espectadores; não há SFU nem infraestrutura de escala.
- STUN não retransmite mídia. Configure TURN para redes restritivas; sem TURN, algumas combinações de rede não conectarão.
- Por padrão, usa-se o servidor STUN público indicado no código. Para produção, configure um serviço STUN/TURN sob seu controle.
- O endereço de captura requer HTTPS, exceto `localhost` e outras origens que o navegador trate como seguras.
- Não há conta, controle de acesso para espectadores, persistência, gravação, áudio ou chat.

## Implantação

Use um host que execute Node.js 22.9+, mantenha o processo `npm start` em execução e coloque um proxy HTTPS/WSS na frente do serviço HTTP. Encaminhe WebSocket sem buffer, configure o certificado TLS e disponibilize a aplicação pela mesma origem. Defina `PORT`, `STUN_URL`, `TURN_URL` e `TURN_SHARED_SECRET` no ambiente de execução, sem colocar segredos no repositório. O estado em memória exige uma instância e não é adequado a reinicializações sem aviso ou múltiplas instâncias.

Mais detalhes: [arquitetura](docs/architecture.md), [configuração](docs/configuration.md) e [implantação](docs/deployment.md).
