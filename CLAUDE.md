# CLAUDE.md — ESL Scraper

Guia para sessões do Claude Code neste repositório. Leia também `PROXIMA_SESSAO.md` (estado atual e
pendências) e `DEPLOY.md` (infraestrutura).

## O que é

Automação do ESL Cloud da Transmassa (`https://transmassa.eslcloud.com.br`) via Playwright: lê XML de notas
(NF-e de peças, NFS-e de serviços) e lança no ESL (OS, peças, estoque), com histórico e retomada.

- `frontend/` — Vue 3 + Vite, publicado no **Netlify** (deploy próprio do Netlify a partir do GitHub).
  **Não alterar sem autorização do usuário.** Só leia para entender os contratos da API (`frontend/src/api.js`).
- `backend/` — Node (ESM) + Express + Playwright, roda na VPS em Docker (`backend/Dockerfile`).
- `docker-compose.yml` + `Caddyfile` — backend + Caddy (HTTPS automático). `ops/` — deploy, backup, systemd.

## Produção (VPS Foxya, 194.61.238.7)

- Repositório de produção: `/opt/esl-scraper-git` (este clone). API: `https://194-61-238-7.sslip.io`.
- Segredos só em `/opt/esl-scraper-git/.env` (chmod 600). Dados em `backend-data/`. Ambos fora do git.
- Atualizar: `sudo ops/deploy.sh` (testes + backup + rollback automático). Nunca `docker compose up --build`
  direto em produção sem rodar os testes.
- Logs: `docker compose logs -f --tail 200 backend`.

## Backend — mapa

| Arquivo | Papel |
|---|---|
| `src/server.js` | rotas Express, auth `X-API-Key`, sessão `X-Session-Id`, `/admin`, rate limit, limites |
| `src/config.js` | config em runtime (`.env` + `data/config.json` do /admin), CORS, senha admin |
| `src/esl.js` | sessões Playwright (1 contexto/página por usuário), login + código 2FA, keep-alive, `shutdown()` |
| `src/lancamento-servicos.js` | aba XML de Serviços (OS + serviço; **não movimenta estoque**) |
| `src/lancamento-pecas.js` | aba XML de Peças (cadastro de peça, entrada no estoque, OS, baixa) |
| `src/lote.js` | lotes em memória, pausa quando o login cai, 2ª passada automática para erros retomáveis |
| `src/ledger.js` | histórico `data/lancamentos-xml.json` com checkpoint por etapa (duplicidade + retomada), de-paras |
| `src/nfe.js`, `src/nfse.js` | parsing de XML (NF-e 4.00; NFS-e Nacional/ABRASF/Paulistana) |
| `src/os.js`, `src/estoque.js`, `src/lookups.js`, `src/ui.js` | telas do ESL (formulários, select2, modais) |
| `src/manutencao.js` | módulo antigo XML→OS (aba Manutenção) |
| `src/rate-limit.js` | limitador por IP em memória |
| `test/*.test.js` | testes offline (`npm test`); `test/browser.smoke.js` (Chromium; `--esl` abre só a tela de login) |

## Regras que NÃO podem ser quebradas

1. **Modo simulação**: `ALLOW_COMMIT=false` (ou "gravação" desligada no /admin) bloqueia qualquer gravação no
   ESL — `lancarServico`/`lancarPecas` retornam antes de tocar a sessão; `/api/xml/lote` responde 403.
   Não ligue gravação nem faça lançamento real sem **autorização explícita do usuário**.
2. Não criar OS, cadastrar peças, movimentar estoque, excluir registros ou alterar dados da Transmassa em testes.
3. Fluxos (não simplificar): Serviços = duplicidade geral → OS ativa/nova → duplicidade na OS → serviço →
   comentário → conferência → histórico. Peças = duplicidade geral → peças cadastradas/cadastro → **pedido de compra** →
   entrada no estoque **com pedido** (tipo "Pedido"; "Avulsa" só se escolhida na tela) → OS ativa/nova → duplicidade na OS → peças → comentário → baixa (ou conferência da baixa
   automática) → comentário da baixa → conferência → histórico. Cada nota = uma execução; lote = sequência.
4. Duplicidade e retomada dependem do `ledger` (checkpoint por etapa) + marca `[XML <12 últimos>]` gravada
   nos comentários do ESL. Não mude o formato de `docKey`/`marker` sem migração.
5. Nunca logar corpo de requisição, senhas, cookies, `X-API-Key`, `X-Admin-Password`, `X-Session-Id`.
   O Caddy remove cabeçalhos do log de acesso — mantenha.
6. Nunca commitar `.env`, `backend-data/`, XML real, cookies/storageState, tokens, `node_modules`.
7. Sem `git push --force`. Commits com a identidade já configurada no repo (e-mail noreply do GitHub).
8. A versão do Playwright no `package-lock.json` deve ser igual à da imagem no `Dockerfile` (hoje 1.65.1).

## Comandos

```bash
# testes (sem Node no host: rodam no container)
cd /opt/esl-scraper-git && docker compose build backend && docker run --rm --init esl-scraper-backend:latest npm test
docker run --rm --init --shm-size=1g esl-scraper-backend:latest npm run test:browser
# deploy
sudo ops/deploy.sh --check && sudo ops/deploy.sh
```

O host **não tem Node.js** instalado de propósito: tudo roda na imagem oficial do Playwright.
