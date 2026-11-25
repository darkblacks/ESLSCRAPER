# Próxima sessão — estado do ESL Scraper

_Última atualização: 25/11/2026 (implantação do backend na VPS Foxya)._

## Estado atual

- Backend **no ar** em `https://194-61-238-7.sslip.io` (health: `/api/health`), Docker Compose em
  `/opt/esl-scraper-git`, Caddy com certificado Let's Encrypt (renovação automática).
- **Modo simulação ativo** (`ALLOW_COMMIT=false`): nada é gravado no ESL.
- Frontend continua no Netlify (não foi alterado nem redeployado por esta sessão).
- Repo GitHub = fonte do código; `/opt/esl-scraper-v5` é cópia antiga idêntica ao 1º commit (não usada).

## O que foi feito na implantação

- Docker 29 + Compose v2 (pacotes do Ubuntu), swap 2 GB, `ufw` (22, 80, 443), backup diário (`esl-backup.timer`).
- Backend: roda como `pwuser` (sem root), `init`, `no-new-privileges`, limite de memória, logs rotacionados.
- `server.js`: rate limit por IP (geral e login), limite de corpo configurável com 413 em JSON, timeouts longos
  para Playwright, health com `versao`, encerramento limpo do Chromium no SIGTERM (`esl.js#shutdown`).
- Caddy: HTTPS, HSTS e cabeçalhos de segurança, limite de upload 30 MB, timeouts de 15 min, log **sem cabeçalhos**.
- Testes: `backend/test/` (20 testes offline + smoke do Chromium). `ops/deploy.sh` com rollback automático.
- Nenhuma regra de negócio foi alterada.

## Testes realizados (25/11/2026)

**Simulados / locais (sem ESL):** 20 testes `npm test` (parsing NF-e/NFS-e, duplicidade, retomada por
checkpoint, trava de concorrência, de-para, CORS, modo simulação de serviços e peças sem tocar a sessão,
validação, auth por API key, 401 `sem_sessao` em todas as rotas operacionais, 413, JSON inválido, admin
sem vazar chave, 429 no login); Chromium 159 headless no container; health local/HTTPS; certificado;
CORS de origem desconhecida recusado; HTTP→HTTPS; porta 3333 inacessível externamente; `kill -9` do
Node → container volta sozinho; `systemctl restart docker` → tudo volta; deploy `--rebuild` e rollback
forçado (teste quebrado num commit local) → versão anterior mantida.

**Contra o ESL real (somente leitura):** abertura da tela `/users/sign_in` pelo Chromium do servidor (HTTP 200,
formulário encontrado). **Nenhum login, nenhuma gravação.**

## Pendências

1. ~~URL do frontend~~ — feito: `https://eslscraper.netlify.app` liberado em `CORS_ORIGINS` (testado: preflight
   e GET com essa origem recebem `Access-Control-Allow-Origin`; outras origens não).
2. **Variáveis no Netlify** (usuário): `VITE_API_URL=https://194-61-238-7.sslip.io` e `VITE_API_KEY=<API_KEY do .env>`,
   depois redeploy do site. Em 25/11 o bundle publicado ainda apontava para `http://localhost:3333`.
   Alternativa sem redeploy: `https://eslscraper.netlify.app/admin` › Conexão deste navegador.
3. **Teste de ponta a ponta pelo site** (usuário, com credenciais ESL + código 2FA): login, prévia de XML de
   serviço e de peças em modo simulação, histórico.
4. **Primeiro lançamento real**: só com autorização explícita — ligar gravação no `/admin`, lançar UMA nota de
   cada aba acompanhando, desligar se algo divergir.
5. Reboot completo da VPS não foi executado (derrubaria a sessão do Claude); simulado com restart do Docker.
6. Avaliar: `GET /api/auth/state` exporta cookies da sessão ESL para quem tem o `X-Session-Id` (recurso
   existente, não usado pelo frontend). Considerar desligar por variável se não houver consumidor.
7. Lotes e sessões ESL ficam em memória: reiniciar o backend os encerra (o histórico/checkpoints persistem).
   `ops/deploy.sh` recusa reiniciar com lote ativo.
8. O commit inicial (3dc30aa) expõe o e-mail pessoal do autor nos metadados do git (repo público). Não há
   senhas/tokens/XML no repositório. Reescrever histórico exigiria force push (não feito).
9. Dependência externa: `sslip.io` (DNS). Se cair, trocar por domínio próprio/DuckDNS (ver DEPLOY.md §1).

## Como retomar

```bash
cd /opt/esl-scraper-git && git pull --ff-only && docker compose ps && curl -s https://194-61-238-7.sslip.io/api/health
```
