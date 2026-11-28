# ESL Scraper (Vue 3 + backend Node/Playwright)

Lê e insere dados no ESL Cloud da Transmassa (`transmassa.eslcloud.com.br`) através de um navegador
Chromium controlado pelo backend. Foco: **Operacional (TMS)**, **Frota (Ordens de Serviço)** e **Compras**.
Cadastros ficam de fora (rotas bloqueadas no backend).

```
esl-scraper/
├─ backend/   Express + Playwright  → API REST (porta 3333)
└─ frontend/  Vue 3 + Vite          → tela de login + explorador (porta 5173)
```

## Módulo 1 — Manutenção: XML de NF-e → Ordem de Serviço

Para quem recebe as NFs de peças e lança uma a uma no ESL. A pessoa solta os XMLs e o app:

1. Lê cada XML (número, emitente/CNPJ, data, itens com código, OEM, qtd e valor).
2. Consulta o ESL:
   - fornecedor pelo CNPJ (`/people?term=CNPJ`);
   - se a nota já veio da SEFAZ (`/purchase/invoices?term=chave`);
   - peças do catálogo (`/purchase/products?term=`), testando o código do fornecedor (`VA32634-143` e `VA32634`), o código OEM do começo da descrição (`9584770015`) e o nome.
3. Mostra cada NF para conferência. **Placa e hodômetro precisam ser informados**, porque o XML não traz a placa. O hodômetro vem preenchido com o atual do veículo.
4. **Simular** preenche o cabeçalho da OS no ESL e devolve um print, sem salvar nada.
5. **Lançar** faz o seguinte:
   - cria a OS em *Frota › Serviços › Ordens de Serviço* (Oficina Terceirizada; oficina = fornecedor);
   - lança cada peça na aba *Produtos e Peças*;
   - confere o `total_parts_value` da OS com o total da nota.
6. Grava `data/lancamentos.json`, que bloqueia lançar a mesma chave duas vezes, e `data/mapeamento-pecas.json`, que guarda o de-para entre código do fornecedor e peça do ESL. Assim, da 2ª vez em diante a peça já vem escolhida.

Campos preenchidos na OS (nomes do formulário do ESL):

| Campo ESL | Origem |
|---|---|
| `fleet_service_order[service_at_date/time]` | emissão da NF (editável) |
| `fleet_service_order[vehicle_id]` | placa informada |
| `fleet_service_order[current_odometer]` | hodômetro (padrão = atual do veículo) |
| `fleet_service_order[maintenance_type]` | Corretiva (editável) |
| `fleet_service_order[service_description]` | "Peças NF {nº} - {fornecedor}" |
| `...workshop_attributes[person_id]` | fornecedor (CNPJ) ou outra oficina |
| `...workshop_attributes[reception_responsible]` | responsável (fica salvo no navegador) |
| `...workshop_attributes[reception_at_date/time]` | data da NF |
| `...workshop_attributes[comments]` | "NF {nº} série {s} - chave {chave}" |
| peça: `fleet_service_order_part[purchase_product_id / quantity / unitary_value]` | itens do XML |

> **Validar na 1ª vez:** rode com `HEADLESS=false` e `ALLOW_COMMIT=true` e lance **uma** NF acompanhando o
> Chromium. O cabeçalho da OS foi mapeado na tela real; o modal de peças (`#workshop_part_modal`) foi
> mapeado pelos campos, mas o clique em "Novo item" + "Salvar" do modal ainda não foi exercitado numa OS
> aberta. Se a OS deve ser **Oficina Própria** em vez de Terceirizada para algum caso, isso ainda não está coberto.

Endpoints: `POST /api/manutencao/preview` `{files:[{name,content}]}`, `POST /api/manutencao/lancar`,
`GET /api/manutencao/historico`, `GET /api/lookup/{vehicles|products|people}?term=`.

## Módulo 2 — Lançamento automatizado de XML (abas **XML de Serviços** e **XML de Peças**)

Tela principal do frontend ("Lançamento de XML"). O tipo é escolhido **antes** do upload, pela aba.
Cada aba tem upload, validações e campos próprios. Um botão principal executa tudo no ESL e confere o resultado.

### Telas do ESL usadas (mapeadas nas telas reais em 25/11/2026)

| Operação | Tela / endpoint |
|---|---|
| OS (listar/consultar) | `/fleet/service_orders.json?search[fleet_service_orders][status|sequence_code|vehicle_id]`, `/fleet/service_orders/:id.json`, `/:id/services`, `/:id/parts` |
| OS (criar) | `/fleet/service_orders/new?workshop_type=outsourced` (sem o parâmetro o ESL abre **Oficina Própria**) |
| Serviço na OS | aba Serviços › "Novo Serviço" › `#outsourced_workshop_service_modal` (item do conjunto*, status*, serviço do catálogo*, valor mão de obra, observação) |
| Peça na OS | aba Produtos e Peças › "Novo item" › `#workshop_part_modal` — **não movimenta estoque** |
| Cadastro de peça | `/purchase/product/parts/new` (código*, nome*, conjunto e item*, grupo*, unidade*, fornecedor padrão + código no fornecedor) |
| Entrada no estoque | Compras › Notas Fiscais Entrada › Produtos e peças: `/storage/invoice/products/new` + aba "Entrada no Estoque" › `#movement_modal` (peça, qtde, vl. unitário, almoxarifado) |
| Baixa no estoque | Estoque › Saída de Peças: `/purchase/storage/parts_withdrawals/new` + `#withdrawal_movement_modal` (peça, qtde, almoxarifado) |
| Conferências | `/storage/invoices/:id/movements`, `/purchase/storage/withdrawals/:id/movements`, `/purchase/invoices?term=<chave>` |
| Auxiliares | `/fleet/sets/items/all?term=`, `/purchase/groups`, `/purchase/warehouses`, `/purchase/measurement_units.json`, `/employees?term=`, `/people?term=` |

### Duplicidade
Antes de mostrar a nota e de novo no clique de lançar:
1. histórico local (`data/lancamentos-xml.json`, chave de acesso ou CNPJ+número+série) e o histórico do módulo antigo;
2. **Notas Fiscais de Entrada** do ESL do mesmo fornecedor com o mesmo número — pega lançamentos manuais de outros operadores;
3. NFs de entrada do fornecedor cujo **comentário** cita o nº da nota (entradas feitas a partir de pedido de compra, ex.: `EVO9H62 NF: 1483`);
4. na OS: serviços/peças com a marca `[XML …]` que a plataforma grava nos comentários, ou com referência à NFS-e; peça igual lançada à mão exige confirmação.

Processamento interrompido fica como **incompleto**: o botão vira "RETOMAR LANÇAMENTO" e cada etapa/item já gravado é pulado.

### Serviços (`POST /api/xml/servicos/preview` · `/lancar`)
Aceita NFS-e Padrão Nacional, ABRASF, Paulistana e NF-e modelo 55. Lança o serviço na OS (existente pendente ou nova de
Oficina Terceirizada com a oficina = prestador), grava o comentário, reconsulta a OS e confere quantidade/valor. Não gera
entrada nem baixa de estoque. Observação: o ESL exige **Item do Conjunto** e **Serviço do catálogo** — o XML não traz
esses dados, então são escolhidos na tela.

### Peças (`POST /api/xml/pecas/preview` · `/lancar`)
Para cada item: peça encontrada com certeza (código igual ou de-para já aprendido) é usada; havendo dúvida o usuário escolhe;
sem correspondência, o formulário de cadastro vem preenchido com dados do XML. Ao lançar: cadastra peças novas →
NF de entrada no almoxarifado → confere → aplica na OS → confere → Saída de Peças (baixa) com comentário "OS n - placa - NF" → confere.

### Modo lote (padrão das duas abas)
Solte vários XMLs de uma vez. Os **padrões do lote** são preenchidos uma vez e ficam salvos no navegador:
- Serviços: item do conjunto, serviço do catálogo, status, comentário; cada prestador "aprende" o item/serviço usados no último lançamento (`data/mapeamento-servicos.json`).
- Peças: destino (entrada + OS + baixa, ou **só entrada no estoque**), almoxarifado, solicitante da baixa, conjunto e grupo para peças novas, política para peça duvidosa (conferir ou cadastrar).
- OS automática pela placa (lida do XML ou digitada na linha): 1 OS pendente → usa; nenhuma → cria (se marcado); várias → a nota fica pendente para escolher. Notas da mesma placa caem na mesma OS.

`POST /api/xml/lote {tipo, notas:[{ref,payload}]}` roda as notas em sequência no backend; progresso em `GET /api/xml/lote/:id`, parar em `POST /api/xml/lote/:id/cancelar`.

### Primeira execução real
Os seletores e campos foram conferidos nas telas reais, mas **nenhum registro foi gravado durante o desenvolvimento**.
Rode o backend com `HEADLESS=false` e `ALLOW_COMMIT=true` e lance **uma** nota de cada aba acompanhando o Chromium.
Endpoint de histórico: `GET /api/xml/historico`.

## Rodando local

```bash
# backend
cd backend
cp .env.example .env        # defina API_KEY
npm install                 # instala o Chromium do Playwright também
npm run dev

# frontend (outro terminal)
cd frontend
cp .env.example .env        # mesma API_KEY do backend
npm install
npm run dev                 # http://localhost:5173
```

Para ver o navegador agindo (útil no 1º login), use `HEADLESS=false` no `.env` do backend.

## Fluxo de login

1. `POST /api/auth/login` com `{ email, password }` → o backend abre `/users/sign_in`, preenche
   `user[email]` / `user[password]` e envia.
2. Se o ESL pedir **código de autenticação**, a resposta vem com `status: "code_required"` e um `sessionId`.
   O frontend mostra o campo de código → `POST /api/auth/code` com `{ sessionId, code }`.
3. Com `status: "ok"`, use o `sessionId` no header `X-Session-Id` em todas as chamadas.

A senha não é gravada em disco nem em log; só fica no Chromium da sessão. A sessão expira após
`SESSION_TTL_MIN` minutos sem uso.

> A etapa de código é a página `/email_otp` do ESL (campo `code`, 6 dígitos, expira em 10 min, com reenvio em `/email_otp/resend` → exposto em `POST /api/auth/code/resend`). Há um fallback genérico em `findCodeInput()` caso o ESL mude essa tela.

## API (para o seu servidor consumir)

Todos os endpoints exigem `X-API-Key`. Os que leem o ESL exigem também `X-Session-Id`.

| Método | Rota | O que faz |
|---|---|---|
| GET | `/api/health` | status e se a gravação está ligada |
| POST | `/api/auth/login` | `{email,password}` → `{sessionId,status}` |
| POST | `/api/auth/code` | `{sessionId,code}` → `{status}` |
| GET | `/api/auth/status` | status da sessão |
| POST | `/api/auth/logout` | fecha a sessão |
| GET | `/api/auth/state` | cookies da sessão (storageState) p/ reaproveitar em HTTP puro |
| GET | `/api/modules` | telas mapeadas por módulo |
| GET | `/api/menu/:modulo` | lê o menu ao vivo (`operacional`, `frota`, `compras`) |
| GET | `/api/list?route=/fleet/service_orders` | colunas, linhas, link "novo" e chamadas JSON da página |
| GET | `/api/form?route=/fleet/service_orders` | campos do formulário de criação |
| POST | `/api/insert` | `{route, data:{ "campo[name]": valor }, commit:false}` |
| POST | `/api/insert/batch` | `{route, rows:[...], commit:false}` |

Exemplo (curl):

```bash
API=http://localhost:3333; KEY=sua-chave
curl -s -X POST $API/api/auth/login -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"email":"voce@empresa.com","password":"***"}'
# → {"sessionId":"...","status":"code_required"}
curl -s -X POST $API/api/auth/code -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"sessionId":"...","code":"123456"}'
curl -s "$API/api/list?route=/fleet/service_orders" -H "X-API-Key: $KEY" -H "X-Session-Id: ..."
```

## Inserção com segurança

- `commit:false` (padrão) só **preenche** o formulário e devolve um screenshot. Nada é salvo.
- Para gravar de fato: `ALLOW_COMMIT=true` no `.env` do backend **e** `commit:true` na requisição.
- Campos `select2` (autocomplete de cliente, veículo, fornecedor…) são preenchidos digitando o texto e
  escolhendo o 1º resultado — confira no screenshot do dry-run.
- Descubra os `name` dos campos com `/api/form` (ou a aba "Formulário" no frontend → "Baixar mapa do form").

## Rotas mapeadas

Ver `backend/src/targets.js`. Principais:

- **Operacional:** `/picks` (coletas), `/freights` (fretes), `/freight/agile/batches` (emissão ágil),
  `/manifests`, `/scheduling/services` (demandas), `/freight_delivery_receipts` (comprovantes)
- **Frota:** `/fleet/service_orders` (OS), `/fleet/defect_communications`, `/fleet/checklists`,
  `/fleet/fuel/requests`, `/fleet/fuel/supplies`, relatórios `/report/fleet/...`
- **Compras:** `/purchase/request/{products,services}`, `/purchase/bid/{products,services}`,
  `/purchase/order/products`, aprovações

## Levar para o servidor

Produção roda na VPS com Docker Compose (backend + Caddy com HTTPS) — veja **[DEPLOY.md](DEPLOY.md)**.
API pública: `https://194-61-238-7.sslip.io` · atualização: `sudo /opt/esl-scraper-git/ops/deploy.sh`.
Como cada sessão é um Chromium, conte ~150–250 MB de RAM por sessão ativa.

## Próximos passos sugeridos

1. Logar, abrir cada tela e usar a aba **Chamadas JSON**: se a listagem vier de um endpoint JSON do ESL,
   trocar o scraping de tabela por chamadas HTTP diretas com os cookies de `/api/auth/state` (mais rápido).
2. Fixar os `name` dos campos de OS, Frete e Solicitação de Compra num "modelo" por tela e expor
   endpoints dedicados (`POST /api/os`, `POST /api/fretes`…).

## Buscar XML pela chave de acesso

Nas abas de peças e manutenção, informe a chave de 44 dígitos de uma NF-e modelo 55. O backend consulta a página pública do Meu DANFE em um Chromium separado e, se o download normal estiver disponível, devolve o XML ao fluxo de upload existente. A consulta exige sessão ESL autenticada, valida o dígito verificador e confere a chave do XML retornado. Não grava no ESL automaticamente. Se o site exigir verificação humana ou não oferecer download direto, faça a consulta manual e envie o arquivo. Não utiliza a API paga do fornecedor. Consulte apenas documentos autorizados. A automação depende da interface do site e requer teste real antes de produção.

### Sugestões de catálogo pelo XML

A leitura de peças e serviços pesquisa descrições e categorias no catálogo ESL. Correspondências claras são pré-selecionadas por item/nota; alternativas ficam no menu. Em lotes homogêneos o padrão exibe a sugestão comum, sem persistir automaticamente a classificação. Padrões manuais continuam como fallback e as escolhas por item/nota podem ser alteradas. Nenhum registro é criado durante a classificação.

### Hodômetro da nova OS

Nas abas de peças e serviços, o hodômetro do cadastro do veículo é pré-preenchido e pode ser editado por nota. Para OS retroativas, se o ESL rejeitar a leitura por abastecimento/manifesto, o lote não repete automaticamente a nota: apresenta os limites informados pelo ESL e pede confirmação da quilometragem real antes da retomada. O limite sugerido não comprova a leitura na data. A entrada já registrada é retomada pelo histórico existente.
