# Subir o ESL Scraper: backend no servidor + site no Netlify

```
Netlify (site)  ──HTTPS──▶  esl-xxx.duckdns.org (Caddy) ──▶ backend (Docker + Chromium) ──▶ ESL Cloud
```

## 1. Domínio grátis no DuckDNS

1. Entre em https://www.duckdns.org e faça login (Google ou GitHub).
2. Em **sub domain**, escolha um nome (ex.: `esl-transmassa`) e clique em **add domain**.
3. Em **current ip**, coloque o IP público do servidor e clique em **update ip**.
4. Copie o **token** que aparece no topo da página. Ele vai no `.env` e mantém o IP atualizado sozinho.

O endereço do backend fica `https://esl-transmassa.duckdns.org`.

## 2. Servidor (Linux com Docker)

**Requisitos:**
- portas **80 e 443** abertas para a internet (o certificado HTTPS é emitido por elas);
- 2 GB de RAM ou mais.

```bash
# copie a pasta esl-scraper para o servidor, depois:
cd esl-scraper
cp deploy.env.example .env
nano .env          # preencha DOMINIO, DUCKDNS_*, ADMIN_PASSWORD, API_KEY, CORS_ORIGINS
docker compose up -d --build
docker compose logs -f backend     # deve aparecer "ESL scraper backend em ..."
```

Para testar, abra `https://SEU-DOMINIO.duckdns.org/api/health` no navegador. A resposta deve ser `{"ok":true,...}`.
O certificado pode levar 1–2 minutos na primeira vez.

**Atualizar** depois de mudar o código: `docker compose up -d --build`.
**Backup:** a pasta `backend-data/` guarda o histórico, o de-para de peças e a configuração do /admin.

## 3. Site no Netlify

1. Suba o projeto no GitHub e, no Netlify, use **Add new site › Import from Git**.
2. Em **Base directory**, coloque `frontend`. O resto vem do `frontend/netlify.toml`.
3. Em **Site configuration › Environment variables**, cadastre:
   - `VITE_API_URL` = `https://SEU-DOMINIO.duckdns.org`
   - `VITE_API_KEY` = a mesma `API_KEY` do `.env` do servidor
4. Faça o deploy e copie o endereço do site, por exemplo `https://esl-scraper.netlify.app`.
5. Libere esse endereço no CORS do servidor. Faça isso pelo `/admin` (passo 4) ou colocando-o em `CORS_ORIGINS` no `.env` e rodando `docker compose up -d`.

## 4. /admin — mudar configurações sem mexer no servidor

São dois lugares, e os dois pedem a `ADMIN_PASSWORD`:

**`https://SEU-SITE.netlify.app/admin`**
- **Conexão deste navegador:** troca o endereço do backend e a chave da API sem refazer o deploy.
- **Servidor:** sites liberados no CORS, gravação ligada/desligada, tempo da sessão e gerar uma chave nova da API.

**`https://SEU-DOMINIO.duckdns.org/admin`**
- É a mesma tela do servidor, só que servida pelo próprio backend.
- Use esta se o CORS estiver errado e o site não conseguir falar com o servidor.

O que você altera no /admin vale na hora e fica salvo em `backend-data/config.json`. Isso tem prioridade sobre o `.env`.

**Sobre a chave da API:** ela fica dentro do site (qualquer pessoa que abrir o site consegue ver), então serve para barrar curioso, não como proteção forte. A senha do ESL e a do admin só trafegam por HTTPS.
Se trocar a chave pelo /admin:
- o navegador onde você trocou já passa a usar a nova;
- nos outros navegadores, cole a chave nova em **Conexão deste navegador**;
- para valer para todo mundo, atualize também o `VITE_API_KEY` no Netlify e refaça o deploy.

---
ESL Scraper · criado por **Victor Ferreira**
