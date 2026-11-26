# Próxima sessão — estado do ESL Scraper

_Última atualização: 25/11/2026 (implantação do backend na VPS Foxya)._

## 26/11/2026 — Impressão dos pedidos de compra + ID do lote

- **ID do lote** `LOTE-AAAAMMDD-XXXX` criado a cada envio (`L.novoLoteId`, em `startBatch` e nas rotas de lançamento
  avulso); cada nota guarda `lote` (último) e `lotes` (todos). Aparece ao lado do progresso do lote e no Histórico.
- **Imprimir do ESL** = `window.open('/purchase/order/products/print?ids=<pedido>')`: página HTML que chama `print()` ao
  carregar; UM pedido por vez (lista de ids só imprime o 1º). O robô abre essa página numa aba própria da mesma sessão,
  com `window.print` desligado, e salva `page.pdf` (mídia print) em `data/pedidos/<id>.pdf`. Etapa `impressao` no
  histórico. Falha não derruba o lançamento (passo "Impressão do pedido" com ok=false). Precisa de HEADLESS=true.
- API: `GET /api/xml/historico?lote&status&nf&de&ate&tipo`; `GET /api/xml/historico/:docKey/pedido.pdf` (captura na hora se
  não houver e houver sessão); `GET /api/xml/historico/pedidos.pdf?...` = PDF único, só notas concluídas, em ordem de
  lançamento (cabeçalhos `X-Pedidos-Incluidos` / `X-Pedidos-Faltaram`).
- Site (Histórico): filtros, coluna Lote (clique filtra), "Imprimir" por nota e "Imprimir Tudo"; PDF num iframe fora da tela
  + `contentWindow.print()` (se o navegador bloquear, abre o PDF numa aba).

## 26/11/2026 — NF de entrada como Pedido: pelo Pedido de Compra

- A tela `/storage/invoice/products/new` **não tem campo de tipo**: tudo salvo por ela fica "Avulsa" (conferido no ESL).
  O `setTipoEntrada` não acha campo e parava sem gravar. Agora "Pedido" = cria o **Pedido de Compra** com os itens do
  XML → NF de entrada **"Com Pedido de Compra"** (menu da lista) → comentário com a marca → itens. Mapa no topo de `src/estoque.js`.
- Nº da entrada com pedido = nº do pedido (o ESL preenche e trava); NF/chave/marca ficam no comentário.
- Frete/desconto travados na NF com pedido → segue e avisa (passo ok=false).
- "Conferir na tela do ESL" agora lê o menu da lista (Com Nota de Compra / Com Pedido de Compra / Avulsa).
- NF 35029 (EMG) está no ESL como Avulsa (id 143540) → candidata a "Refazer como Pedido".
- Confirmações do ESL (SweetAlert 8): `swalConfirmar` clica "Sim/OK" e, se a janela não fechar, dá **Enter** no botão;
  `fecharAvisosSwal` fecha o aviso de sucesso que vem depois (erro → para). Exclusão de item da NF de entrada: confirma
  "Tem certeza que deseja excluir o item?", fecha o aviso, aceita `confirm()` nativo e **confere que a linha sumiu**.
- NF com pedido, mapeado na tela real (NF 143555 / pedido 4121): salvar o modal pergunta "Tem certeza que deseja salvar
  esses dados?" (Sim/Enter) e abre /storage/invoice/products/:id/edit. Os itens entram pela aba **Itens do Pedido** › 🔗
  → "Deseja vincular este produto?" com Almoxarifado (select2 `#order_item_warehouse`) e Qtde Recebida (`.amount_received`)
  → Sim. `linkOrderItem` faz isso e confere a Qtde Recebida. NF avulsa continua com "Novo Item".
- Busca do pedido no modal mostra "Nº Pedido:4121 FORNECEDOR" — o pedido é escolhido digitando (o ESL precisa dos dados
  completos do resultado; injetar a opção quebrava com "reading 'id'").
- **Modo rápido (lido no JS do ESL)**: cada registro é um `Record.Base` gravado por `_(namespacedUrlFor(path)).postJSON({data:{<nome>: campos}})`
  (PATCH para alterar, DELETE para excluir). Caminhos: `purchase_order_item` → /purchase/order/:order_id/order_items;
  `storage_movement` → /storage/invoices/:invoice_id/movements e /purchase/storage/withdrawals/:withdrawal_id/movements;
  `fleet_service_order_part` → /fleet/service_orders/:id/parts; vínculo do item do pedido →
  POST /storage/invoice/products/:id/link_order_items {purchase_order_item_id, amount_received "328,000", warehouse_id}.
  Já usado: vínculo rápido (`linkOrderItemRapido`, qtde < 1000, confere pela API; falha de envio → caminho pela tela).
  Próximos: itens do pedido, peças na OS, itens da baixa e exclusão pelo mesmo caminho — antes, capturar o envio real
  da tela (formato dos números) para copiar idêntico.
- Pedido de compra: **Condições de Pagamento** padronizada (`condicaoPagamentoDe` em nfe.js): só "A PRAZO" | "CARTAO CREDITO" |
  "A VISTA" (textos que já existem no ESL); vem do XML (pag/detPag + cobr/dup), nunca em branco (padrão A PRAZO).
  `payload.condicaoPagamento` (um dos três) tem prioridade, se o site mandar.
- Comentário padrão do pedido e da NF de entrada: `PLACA XXX0X00 NF: nº série s | Chave … | [XML …] | texto do usuário`
  (placa = da OS ou a achada no texto da NF). Ao retomar, pedido com condição/comentário em branco e NF sem a marca são corrigidos.
- **Ainda não rodado com gravação.** Validar com UMA nota, com autorização.

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
