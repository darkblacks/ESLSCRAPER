# Deploy do ESL Scraper — backend na VPS + frontend no Netlify

```
Netlify (frontend Vue) ──HTTPS──▶ 194-61-238-7.sslip.io:443 (Caddy, Let's Encrypt)
                                        │  rede interna do Docker
                                        ▼
                                  backend:3333 (Node 20+ · Express · Playwright/Chromium headless)
                                        │
                                        ▼
                                  ESL Cloud (https://transmassa.eslcloud.com.br)
```

## 1. Servidor (VPS Foxya)

| Item | Valor |
|---|---|
| SO | Ubuntu 26.04.1 LTS · 3 vCPU · 3,8 GB RAM + 2 GB swap (`/swapfile`) |
| IP público | `194.61.238.7` |
| API pública | `https://194-61-238-7.sslip.io` |
| Health check | `https://194-61-238-7.sslip.io/api/health` |
| Admin do servidor | `https://194-61-238-7.sslip.io/admin` (senha `ADMIN_PASSWORD` do `.env`) |
| Código (git) | `/opt/esl-scraper-git` → github.com/darkblacks/ESLSCRAPER (branch `main`) |
| Configuração | `/opt/esl-scraper-git/.env` (chmod 600, **fora do git**) |
| Dados persistentes | `/opt/esl-scraper-git/backend-data/` (dono uid 1001 = `pwuser` do container) |
| Backups | `/var/backups/esl-scraper/` (diário 03:30 via `esl-backup.timer` + antes de cada deploy; mantém 30) |
| Cópia antiga | `/opt/esl-scraper-v5/` — idêntica ao commit inicial; **não é usada** |

### Serviços

| Serviço | Como roda | Portas |
|---|---|---|
| `docker` | systemd, habilitado no boot | — |
| `esl-scraper-backend-1` | Docker, `restart: unless-stopped`, usuário `pwuser` (sem root), `init`, `no-new-privileges`, limite 2,5 GB | `3333` **só na rede interna do Docker** |
| `esl-scraper-caddy-1` | Docker, `restart: unless-stopped` | `80` (ACME + redirect), `443` tcp/udp |
| `esl-backup.timer` | systemd | — |
| Firewall `ufw` | ativo: entrada negada, exceto 22/tcp, 80/tcp, 443/tcp, 443/udp | — |

O backend volta sozinho se o processo morrer e após reinício do servidor (Docker habilitado no boot +
`unless-stopped`). Não depende do Claude Code nem da sessão SSH.

### Por que `sslip.io`?

Não há domínio próprio. `194-61-238-7.sslip.io` é um DNS público que sempre responde o IP embutido no nome,
então o Caddy obtém um certificado Let's Encrypt válido (renovação automática). Se um dia houver domínio
próprio ou DuckDNS: aponte o DNS para `194.61.238.7`, troque `DOMINIO` no `.env`,
`docker compose up -d --force-recreate caddy`, atualize `VITE_API_URL` no Netlify e redeploy do site.
(DuckDNS: preencha `DUCKDNS_*` e suba com `docker compose --profile duckdns up -d`.)

## 2. Variáveis do `.env` (servidor)

Modelo: `deploy.env.example`. Nunca commitar o `.env`.

| Variável | Para quê |
|---|---|
| `DOMINIO` | host do certificado HTTPS (hoje `194-61-238-7.sslip.io`) |
| `ESL_BASE` | `https://transmassa.eslcloud.com.br` |
| `API_KEY` | chave exigida no header `X-API-Key` (≥16 chars). **Vai no frontend → não é segredo forte.** |
| `ADMIN_PASSWORD` | senha do `/admin` (≥8 chars). Segredo de verdade. 5 erros → bloqueio de 5 min por IP. |
| `CORS_ORIGINS` | URL(s) do site no Netlify, separadas por vírgula (aceita `https://*.netlify.app`) |
| `ALLOW_COMMIT` | `false` = **modo simulação** (nada é gravado no ESL). Pode ser ligado pelo `/admin`. |
| `SESSION_TTL_MIN` | minutos ociosos até fechar a sessão ESL (padrão 60) |
| `MAX_UPLOAD` / `BODY_LIMIT` | limite do envio no Caddy (30MB) / no Node (25mb) |
| `RATE_LIMIT_PER_MIN` / `RATE_LIMIT_LOGIN_15MIN` | limite por IP: geral (600/min) / login+código (20 por 15 min) |

O que for alterado pelo `/admin` (CORS, gravação, TTL, nova chave) fica em `backend-data/config.json` e
**tem prioridade sobre o `.env`**.

## 3. Netlify (frontend — já publicado, não recriar)

Em **Site configuration › Environment variables** (dá para colar tudo de uma vez em **Add a variable ›
Import from a .env file**, usando `frontend/netlify.env.example` com a chave preenchida):

| Variável | Valor |
|---|---|
| `VITE_API_URL` | `https://194-61-238-7.sslip.io` |
| `VITE_API_KEY` | o valor de `API_KEY` do `.env` do servidor (`sudo grep ^API_KEY= /opt/esl-scraper-git/.env`) |

Pode marcar `VITE_API_KEY` como **Contains secret values** (fica mascarada no painel do Netlify). O
`netlify.toml` já tira `VITE_API_URL`/`VITE_API_KEY` do secret scanning (`SECRETS_SCAN_OMIT_KEYS`), senão o
deploy falharia: o valor aparece no JavaScript do site de propósito. Se a **smart detection** ainda bloquear o
build, adicione no Netlify `SECRETS_SCAN_SMART_DETECTION_OMIT_VALUES` com o valor da chave.

Com as variáveis no build, o site abre já conectado — ninguém precisa preencher `/admin › Conexão deste
navegador`. O que estiver salvo nessa tela em um navegador continua valendo mais que o build (botão "Usar o padrão do build"
lá, se a chave mudar).

Depois: **Deploys › Trigger deploy** (variáveis `VITE_*` entram no build). E libere a URL do site no CORS
(`CORS_ORIGINS` no `.env` + `docker compose up -d backend`, ou pelo `/admin`).

> `VITE_API_KEY` fica visível no JavaScript do site. A proteção real das operações é o **login no ESL**
> (toda rota operacional exige `X-Session-Id` de uma sessão logada) + `ADMIN_PASSWORD` + rate limit.
> Nunca coloque senha do ESL ou `ADMIN_PASSWORD` em variáveis `VITE_*`.

## 4. Operação do dia a dia

```bash
cd /opt/esl-scraper-git
docker compose ps                                  # status (backend deve estar "healthy")
docker compose logs -f --tail 200 backend          # logs do backend (método + rota; nunca corpo/senha)
docker compose logs -f --tail 200 caddy            # logs do HTTPS/proxy (sem cabeçalhos)
curl -s https://194-61-238-7.sslip.io/api/health   # {"ok":true,"commitEnabled":false,"versao":"<commit>",...}
docker compose restart backend                     # reinicia o backend (encerra sessões ESL e lotes!)
docker compose up -d backend                       # aplica mudanças do .env
sudo ops/backup.sh manual                          # backup na hora
```

Logs do Docker rotacionam (10 MB × 5 por container).

## 5. Atualizar o backend (GitHub → servidor)

1. Desenvolva, rode os testes e faça push para `main`.
2. No servidor:

```bash
sudo /opt/esl-scraper-git/ops/deploy.sh --check    # há atualização?
sudo /opt/esl-scraper-git/ops/deploy.sh            # aplica
```

O script: trava contra execução dupla → confere branch/árvore limpa/fast-forward → recusa se houver **lote em
andamento** (`FORCAR=1` ignora) → backup → `git merge --ff-only` → build da imagem (`npm ci`) → **testes**
(`npm test` + Chromium headless + validação do Caddyfile, numa imagem nova, sem dados reais) → reinicia →
health check local e HTTPS → se qualquer passo falhar, **volta sozinho** para o commit e a imagem anteriores.
`.env`, `backend-data/` e certificados nunca são tocados. Não existe deploy automático: é sempre manual.

Outras opções: `--rebuild` (reconstrói sem commit novo) · `ALVO=<commit>` (vai para um commit específico à frente).

## 6. Recuperação

| Problema | O que fazer |
|---|---|
| Deploy falhou | o script já voltou; veja a saída e `docker compose logs --tail 200 backend` |
| Voltar uma versão manualmente | `git log --oneline` → `git reset --hard <commit>` → `docker compose up -d --build` |
| Imagem anterior | `docker tag esl-scraper-backend:previous esl-scraper-backend:latest && docker compose up -d --no-build --force-recreate backend` |
| Restaurar dados | `docker compose stop backend` → `tar -C /opt/esl-scraper-git -xzf /var/backups/esl-scraper/<arquivo>.tar.gz` → `chown -R 1001:1001 backend-data` → `docker compose up -d` |
| Certificado | `docker compose logs caddy \| grep -i certif` (portas 80/443 precisam estar abertas) |
| Site não fala com a API | CORS: confira a URL exata do site em `CORS_ORIGINS` ou pelo `https://194-61-238-7.sslip.io/admin` |
| Chave da API trocada | atualize `VITE_API_KEY` no Netlify e redeploy, ou cole a nova em `/admin` › Conexão deste navegador |
| Servidor reiniciou | nada: Docker sobe tudo. Confira `docker compose ps`. Sessões ESL e lotes em memória se perdem (o histórico com checkpoints permanece, e a retomada continua de onde parou) |

## 7. Rodando local (desenvolvimento)

Veja o README (`backend/.env.example`, `npm install`, `npm run dev`). Testes: `cd backend && npm test`
(offline; nunca tocam o ESL) · `npm run test:browser` (Chromium) · `npm run test:esl` (abre só a tela de login do ESL).

---
ESL Scraper · criado por **Victor Ferreira**
