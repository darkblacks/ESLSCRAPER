import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { MODULES, isAllowedRoute } from './targets.js';
import {
  startLogin, submitCode, resendCode, getSession, closeSession, exportState,
  scrapeMenu, scrapeList, scrapeForm, insertRecord,
} from './esl.js';
import { previewXmls, lancarOS, historico } from './manutencao.js';
import * as LK from './lookups.js';
import * as LEDGER from './ledger.js';
import * as IMP from './impressao.js';
import { previewServico, lancarServico } from './lancamento-servicos.js';
import { previewPecas, lancarPecas } from './lancamento-pecas.js';
import { startBatch, getBatch, cancelBatch, getTelas } from './lote.js';
import * as C from './config.js';
import { listSessions, shutdown } from './esl.js';
import { rateLimit } from './rate-limit.js';
import { tiposEntrada } from './estoque.js';
import { adminPage } from './admin-page.js';

const app = express();
const PORT = Number(process.env.PORT || 3333);
const commitOn = () => C.get().allowCommit; // pode ser ligado/desligado pelo /admin
const INICIO = Date.now();
const VERSAO = process.env.GIT_COMMIT || 'dev';
const BODY_LIMIT = process.env.BODY_LIMIT || '25mb';

if (!C.get().apiKey || C.get().apiKey === 'troque-esta-chave') {
  console.warn('[aviso] Defina API_KEY no .env (ou pelo /admin) antes de expor este backend fora da sua máquina.');
}

app.set('trust proxy', 1); // atrás do Caddy/nginx: IP real do cliente
// CORS lido a cada requisição: origens alteradas no /admin valem na hora
app.use(cors({ origin: (origin, cb) => cb(null, C.origemPermitida(origin)), allowedHeaders: ['Content-Type', 'X-API-Key', 'X-Session-Id'], exposedHeaders: ['X-Pedidos-Incluidos', 'X-Pedidos-Faltaram'] }));
app.use(express.json({ limit: BODY_LIMIT })); // lotes de XML (o Caddy também limita o tamanho do corpo)
// corpo grande demais / JSON inválido: responde JSON (o frontend lê data.error)
app.use((err, _req, res, next) => {
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: `Envio grande demais (limite ${BODY_LIMIT}). Divida os XMLs em lotes menores.`, code: 'too_large' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido.', code: 'bad_json' });
  next(err);
});

// Limitação de requisições por IP (o IP real vem do Caddy via X-Forwarded-For; trust proxy = 1).
// Geral: protege contra abuso; login/código: evita força bruta e abertura de muitos Chromium.
const isHealth = (req) => req.path === '/api/health';
app.use('/api', rateLimit({ janelaMs: 60_000, max: Number(process.env.RATE_LIMIT_PER_MIN || 600), pular: (req) => isHealth(req) }));
app.use(['/api/auth/login', '/api/auth/code', '/api/auth/code/resend', '/api/admin/login', '/api/admin/code', '/api/admin/code/resend'], rateLimit({ janelaMs: 15 * 60_000, max: Number(process.env.RATE_LIMIT_LOGIN_15MIN || 20), msg: 'Muitas tentativas de login. Aguarde alguns minutos.' }));

// Nunca logar corpo de requisição (tem senha no /login).
app.use((req, _res, next) => {
  console.log(new Date().toISOString(), req.method, req.path);
  next();
});

// Auth da API: X-API-Key
app.use('/api', (req, res, next) => {
  if (req.path === '/health' || req.path.startsWith('/admin/')) return next(); // /admin usa o login do ESL (abaixo)
  const key = C.get().apiKey;
  if (key && req.get('x-api-key') !== key) return res.status(401).json({ error: 'API key inválida', code: 'api_key' });
  next();
});

/* ---------------------------- /admin ---------------------------- */
// Página própria do backend (mesmo domínio — funciona mesmo se o CORS estiver errado): https://SEU-BACKEND/admin
app.get('/admin', (_req, res) => res.type('html').send(adminPage()));
// Acesso ao /admin = sessão do ESL logada (X-Session-Id), sem senha extra.
// Não exige a chave da API: o /admin do próprio servidor é o caminho de socorro quando o CORS ou a chave estão errados.
// A sessão criada por aqui só dá acesso às rotas /api/admin/*; as operacionais continuam exigindo X-API-Key.
function requireAdmin(req, res, next) {
  const s = getSession(req.get('x-session-id'));
  if (!s) return res.status(401).json({ error: 'Entre com o seu login do ESL para administrar o servidor.', code: 'sem_sessao' });
  if (s.status !== 'ok') return res.status(401).json({ error: 'O login no ESL caiu. Entre de novo.', code: 'reauth' });
  req.esl = s;
  next();
}
const configPublica = () => {
  const c = C.get();
  return { ...c, apiKey: undefined, apiKeyDefinida: !!c.apiKey, apiKeyFinal: c.apiKey ? '…' + c.apiKey.slice(-4) : '' };
};
// Login do ESL para o /admin (mesmo fluxo do site: e-mail + senha → código 2FA). Rate limit de login acima.
app.post('/api/admin/login', (req, res, next) => loginHandler(req, res, next));
app.post('/api/admin/code', (req, res, next) => codeHandler(req, res, next));
app.post('/api/admin/code/resend', (req, res, next) => resendHandler(req, res, next));
app.post('/api/admin/logout', async (req, res) => {
  const s = getSession(req.get('x-session-id'));
  if (s && !s.emLote) await closeSession(s.id).catch(() => {}); // nunca derruba uma sessão com lote rodando
  res.json({ ok: true });
});
app.get('/api/admin/config', requireAdmin, (_req, res) => res.json({ config: configPublica(), status: statusServidor() }));
app.put('/api/admin/config', requireAdmin, (req, res) => {
  try {
  const b = req.body || {};
  const patch = {};
  for (const k of ['corsOrigins', 'allowCommit', 'sessionTtlMin']) if (k in b) patch[k] = b[k];
  let chaveNova;
  if (b.gerarApiKey) patch.apiKey = chaveNova = C.novaChave();
  else if (b.apiKey) patch.apiKey = chaveNova = b.apiKey;
  C.update(patch);
  console.log(new Date().toISOString(), '[admin] configuração alterada por', req.esl.email || '?', ':', Object.keys(patch).join(', '));
  // a chave nova só aparece UMA vez, nesta resposta
  res.json({ config: configPublica(), status: statusServidor(), apiKeyNova: chaveNova });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});
function statusServidor() {
  return { online: true, desde: new Date(INICIO).toISOString(), sessoes: listSessions(), node: process.version };
}

// Sessão ESL: X-Session-Id (retornado no login)
// code 'sem_sessao': o backend não conhece a sessão (reiniciou) → login novo.
// code 'reauth': a sessão existe mas o ESL deslogou → login de novo NA MESMA sessão (lote pausado continua).
function requireSession(req, res, next) {
  const s = getSession(req.get('x-session-id'));
  if (!s) return res.status(401).json({ error: 'Sessão ESL inexistente ou expirada. Faça login.', code: 'sem_sessao' });
  if (s.status !== 'ok') return res.status(401).json({ error: 'O login no ESL caiu. Entre de novo para continuar.', code: 'reauth', status: s.status });
  req.esl = s;
  next();
}
// Para acompanhar o lote mesmo com o login caído (o progresso continua visível enquanto você reloga).
function requireKnownSession(req, res, next) {
  const s = getSession(req.get('x-session-id'));
  if (!s) return res.status(401).json({ error: 'Sessão ESL inexistente ou expirada. Faça login.', code: 'sem_sessao' });
  req.esl = s;
  next();
}

function checkRoute(route, res) {
  if (!isAllowedRoute(route)) {
    res.status(400).json({ error: `Rota não permitida: ${route}` });
    return false;
  }
  return true;
}

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error(e);
    res.status(e.status || 500).json({ error: e.message });
  });

/* --------------------------- endpoints --------------------------- */

// Só de dentro do container (ops/deploy.sh): quantos lotes estão rodando. Pelo Caddy chega com X-Forwarded-For → 404.
app.get('/internal/lotes', (req, res) => {
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && !req.get('x-forwarded-for');
  if (!local) return res.status(404).end();
  res.json({ lotes: listSessions().filter((x) => x.emLote).length });
});

app.get('/api/health', (_req, res) => res.json({ ok: true, commitEnabled: commitOn(), versao: VERSAO, uptimeS: Math.round((Date.now() - INICIO) / 1000) }));

const loginHandler = wrap(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email e password são obrigatórios' });
  const reuse = req.body?.sessionId ? getSession(req.body.sessionId) : null;
  const r = await startLogin(email, password, reuse);
  res.status(r.status === 'error' ? 401 : 200).json(r);
});
const codeHandler = wrap(async (req, res) => {
  const s = getSession(req.get('x-session-id') || req.body?.sessionId);
  if (!s) return res.status(401).json({ error: 'Sessão não encontrada. Refaça o login.' });
  const r = await submitCode(s, req.body?.code);
  res.status(r.status === 'error' ? 401 : 200).json({ sessionId: s.id, ...r });
});
const resendHandler = wrap(async (req, res) => {
  const s = getSession(req.get('x-session-id') || req.body?.sessionId);
  if (!s) return res.status(401).json({ error: 'Sessão não encontrada. Refaça o login.' });
  res.json(await resendCode(s));
});
app.post('/api/auth/login', loginHandler);
app.post('/api/auth/code', codeHandler);
app.post('/api/auth/code/resend', resendHandler);

app.get('/api/auth/status', (req, res) => {
  const s = getSession(req.get('x-session-id'));
  res.json(s ? { status: s.status, email: s.email, emLote: !!s.emLote } : { status: 'none' });
});

app.post('/api/auth/logout', wrap(async (req, res) => {
  await closeSession(req.get('x-session-id'));
  res.json({ ok: true });
}));

// Cookies da sessão para o seu servidor reaproveitar (storageState do Playwright)
app.get('/api/auth/state', requireSession, wrap(async (req, res) => res.json(await exportState(req.esl))));

app.get('/api/modules', (_req, res) => res.json(MODULES));

app.get('/api/menu/:module', requireSession, wrap(async (req, res) => {
  const root = { operacional: '/tms', tms: '/tms', frota: '/fleet', fleet: '/fleet', compras: '/purchase', purchase: '/purchase' }[req.params.module];
  if (!root) return res.status(400).json({ error: 'módulo inválido' });
  res.json(await scrapeMenu(req.esl, root));
}));

app.get('/api/list', requireSession, wrap(async (req, res) => {
  const { route } = req.query;
  if (!checkRoute(route, res)) return;
  res.json(await scrapeList(req.esl, route));
}));

app.get('/api/form', requireSession, wrap(async (req, res) => {
  const { route, newHref } = req.query;
  if (!checkRoute(route, res) || (newHref && !checkRoute(newHref, res))) return;
  res.json(await scrapeForm(req.esl, route, newHref));
}));

app.post('/api/insert', requireSession, wrap(async (req, res) => {
  const { route, newHref, data, commit = false } = req.body || {};
  if (!checkRoute(route, res) || (newHref && !checkRoute(newHref, res))) return;
  if (commit && !commitOn()) return res.status(403).json({ error: 'Gravação desativada (ligue "gravação" no /admin ou ALLOW_COMMIT=true no .env).' });
  res.json(await insertRecord(req.esl, { route, newHref, data, commit }));
}));

/* ---------------------- Manutenção (XML → OS) --------------------- */

// { files: [ { name, content } ] }  (conteúdo do XML como texto)
app.post('/api/manutencao/preview', requireSession, wrap(async (req, res) => {
  const files = req.body?.files || [];
  if (!files.length) return res.status(400).json({ error: 'Envie ao menos um XML.' });
  res.json(await previewXmls(req.esl, files));
}));

app.post('/api/manutencao/lancar', requireSession, wrap(async (req, res) => {
  const body = req.body || {};
  if (body.commit && !commitOn()) return res.status(403).json({ error: 'Gravação desativada (ligue "gravação" no /admin ou ALLOW_COMMIT=true no .env).' });
  res.json(await lancarOS(req.esl, body));
}));

app.get('/api/manutencao/historico', requireSession, (_req, res) => res.json(historico()));
const look = (fn) => requireSessionWrap(async (req, res) => res.json(await fn(req.esl, req.query)));
function requireSessionWrap(fn) {
  return [requireSession, wrap(fn)];
}
app.get('/api/lookup/vehicles', ...look((s, q) => LK.searchVehicles(s, q.term || '')));
app.get('/api/lookup/products', ...look((s, q) => LK.searchProducts(s, q.term || '', q.kind)));
app.get('/api/lookup/people', ...look((s, q) => LK.searchPeople(s, q.term || '')));
app.get('/api/lookup/employees', ...look((s, q) => LK.searchEmployees(s, q.term || '')));
app.get('/api/lookup/set-items', ...look((s, q) => LK.searchSetItems(s, q.term || '')));
app.get('/api/lookup/warehouses', ...look((s, q) => LK.searchWarehouses(s, q.term || '')));
app.get('/api/lookup/groups', ...look((s, q) => LK.searchGroups(s, q.term || '')));
app.get('/api/lookup/units', ...look((s) => LK.listUnits(s)));
app.get('/api/lookup/filiais', ...look((s) => LK.listFiliais(s)));
app.get('/api/lookup/service-orders', ...look((s, q) => LK.searchServiceOrders(s, { term: q.term || '', status: q.status || 'pending' })));
app.get('/api/lookup/service-orders/:id', requireSession, wrap(async (req, res) => res.json(await LK.getServiceOrder(req.esl, req.params.id))));

/* ------------- Lançamento automatizado de XML (abas Serviços / Peças) ------------- */

// { file: { name, content } }
app.post('/api/xml/servicos/preview', requireSession, wrap(async (req, res) => {
  const f = req.body?.file;
  if (!f?.content) return res.status(400).json({ error: 'Envie o XML.' });
  try {
    res.json(await previewServico(req.esl, f));
  } catch (e) {
    if (e.status === 401) throw e;
    res.json({ arquivo: f.name, ok: false, error: e.message });
  }
}));

app.post('/api/xml/servicos/lancar', requireSession, wrap(async (req, res) => {
  res.json(await lancarServico(req.esl, req.body || {}, { commit: commitOn(), loteId: LEDGER.novoLoteId() }));
}));

// Só leitura: abre a tela de nova NF de entrada (sem salvar) e devolve as opções do tipo (Avulsa / Pedido).
app.get('/api/xml/pecas/tipos-entrada', requireSession, wrap(async (req, res) => res.json({ ok: true, campo: await tiposEntrada(req.esl) })));

app.post('/api/xml/pecas/preview', requireSession, wrap(async (req, res) => {
  const f = req.body?.file;
  if (!f?.content) return res.status(400).json({ error: 'Envie o XML.' });
  try {
    res.json(await previewPecas(req.esl, f));
  } catch (e) {
    if (e.status === 401) throw e;
    res.json({ arquivo: f.name, ok: false, error: e.message });
  }
}));

app.post('/api/xml/pecas/lancar', requireSession, wrap(async (req, res) => {
  res.json(await lancarPecas(req.esl, req.body || {}, { commit: commitOn(), loteId: LEDGER.novoLoteId() }));
}));

// Lote: { tipo: 'servicos'|'pecas', notas: [ { ref, payload } ] } → { id } ; progresso em GET /api/xml/lote/:id
app.post('/api/xml/lote', requireSession, wrap(async (req, res) => {
  const { tipo, notas = [] } = req.body || {};
  if (!['servicos', 'pecas'].includes(tipo) || !notas.length) return res.status(400).json({ error: 'Informe tipo e notas.' });
  if (!commitOn()) return res.status(403).json({ error: 'Gravação desativada (ligue "gravação" no /admin ou ALLOW_COMMIT=true no .env).' });
  res.json(startBatch(req.esl, tipo, notas, { commit: commitOn() }));
}));
app.get('/api/xml/lote/:id', requireKnownSession, (req, res) => {
  const j = getBatch(req.params.id);
  return j ? res.json(j) : res.status(404).json({ error: 'Lote não encontrado.' });
});
app.get('/api/xml/lote/:id/telas/:ref', requireKnownSession, (req, res) => res.json(getTelas(req.params.id, req.params.ref)));
app.post('/api/xml/lote/:id/cancelar', requireKnownSession, (req, res) => res.json(cancelBatch(req.params.id) || {}));

// Histórico com filtros: ?tipo=pecas|servico&lote=LOTE-...&status=concluido|erro|em_andamento&nf=123&de=AAAA-MM-DD&ate=AAAA-MM-DD
const filtrosHist = (q) => ({ tipo: q.tipo, lote: q.lote, status: q.status, nf: q.nf, de: q.de, ate: q.ate });
app.get('/api/xml/historico', requireKnownSession, (req, res) => {
  res.json(IMP.filtrarHistorico(LEDGER.all(), filtrosHist(req.query)).map(IMP.resumoHistorico));
});
const enviarPdf = (res, pdf, nome) => {
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${nome}"`, 'Cache-Control': 'no-store' });
  res.send(pdf);
};
// PDF único de vários pedidos ("Imprimir Tudo"): mesmos filtros do histórico, SEMPRE só notas concluídas.
app.get('/api/xml/historico/pedidos.pdf', requireKnownSession, wrap(async (req, res) => {
  const regs = IMP.filtrarHistorico(LEDGER.all(), { ...filtrosHist(req.query), tipo: 'pecas', status: 'concluido' })
    .map(IMP.resumoHistorico).filter((r) => r.pedidoId)
    .sort((a, b) => String(a.inicio).localeCompare(String(b.inicio))); // ordem em que foram lançadas
  const r = await IMP.pdfMesclado(req.esl, regs);
  res.set({ 'X-Pedidos-Incluidos': String(r.incluidas.length), 'X-Pedidos-Faltaram': encodeURIComponent(r.faltaram.map((f) => `NF ${f.numero}: ${f.motivo}`).join(' | ').slice(0, 1500)) });
  enviarPdf(res, r.pdf, `pedidos-${String(req.query.lote || 'historico').replace(/[^\w-]/g, '')}.pdf`);
}));
// "Completar histórico": lote para notas antigas + PDF dos pedidos já lançados que ainda não têm (em blocos)
app.post('/api/xml/historico/completar', requireSession, wrap(async (req, res) => {
  res.json(await IMP.completarHistorico(req.esl, { max: Math.min(30, Number(req.query.max) || 15) }));
}));
// PDF do pedido de compra de UMA nota (salvo; se ainda não houver, captura agora com a sessão do ESL)
app.get('/api/xml/historico/:docKey/pedido.pdf', requireKnownSession, wrap(async (req, res) => {
  const pdf = await IMP.pdfDaNota(req.esl, req.params.docKey);
  const reg = LEDGER.get(req.params.docKey);
  enviarPdf(res, pdf, `pedido-NF${String(reg?.numero || '').replace(/\D/g, '')}.pdf`);
}));

// Inserção em lote: { route, newHref, rows: [ {...}, {...} ], commit }
app.post('/api/insert/batch', requireSession, wrap(async (req, res) => {
  const { route, newHref, rows = [], commit = false } = req.body || {};
  if (!checkRoute(route, res) || (newHref && !checkRoute(newHref, res))) return;
  if (commit && !commitOn()) return res.status(403).json({ error: 'Gravação desativada (ligue "gravação" no /admin ou ALLOW_COMMIT=true no .env).' });
  const results = [];
  for (const data of rows) {
    const r = await insertRecord(req.esl, { route, newHref, data, commit });
    delete r.screenshot;
    results.push(r);
  }
  res.json({ total: rows.length, results });
}));

const limpos = LEDGER.limparDeParaSuspeito();
if (limpos) console.log(`[de-para] ${limpos} associação(ões) suspeita(s) de peça removida(s).`);

const server = app.listen(PORT, () => console.log(`ESL scraper backend em http://localhost:${PORT} (versão ${VERSAO}, commit ${commitOn() ? 'LIGADO' : 'desligado'})`));
// Operações do Playwright podem levar minutos: não deixa o Node cortar a conexão antes do Caddy.
server.requestTimeout = 0;
server.headersTimeout = 65_000;
server.keepAliveTimeout = 61_000;

// Docker manda SIGTERM ao parar/reiniciar: fecha o Chromium e as sessões antes de sair.
let saindo = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    if (saindo) return;
    saindo = true;
    console.log(new Date().toISOString(), `[${sig}] encerrando…`);
    server.close();
    await Promise.race([shutdown(), new Promise((ok) => setTimeout(ok, 8000))]);
    process.exit(0);
  });
}
