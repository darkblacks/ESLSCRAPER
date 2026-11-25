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
import { previewServico, lancarServico } from './lancamento-servicos.js';
import { previewPecas, lancarPecas } from './lancamento-pecas.js';
import { startBatch, getBatch, cancelBatch, getTelas } from './lote.js';
import * as C from './config.js';
import { listSessions } from './esl.js';
import { adminPage } from './admin-page.js';

const app = express();
const PORT = Number(process.env.PORT || 3333);
const commitOn = () => C.get().allowCommit; // pode ser ligado/desligado pelo /admin
const INICIO = Date.now();

if (!C.get().apiKey || C.get().apiKey === 'troque-esta-chave') {
  console.warn('[aviso] Defina API_KEY no .env (ou pelo /admin) antes de expor este backend fora da sua máquina.');
}
if (!C.adminConfigurado()) console.warn('[aviso] ADMIN_PASSWORD não definida (mín. 8 caracteres) — o /admin fica desligado.');

app.set('trust proxy', 1); // atrás do Caddy/nginx: IP real do cliente
// CORS lido a cada requisição: origens alteradas no /admin valem na hora
app.use(cors({ origin: (origin, cb) => cb(null, C.origemPermitida(origin)), allowedHeaders: ['Content-Type', 'X-API-Key', 'X-Session-Id', 'X-Admin-Password'] }));
app.use(express.json({ limit: '25mb' })); // lotes de XML

// Nunca logar corpo de requisição (tem senha no /login).
app.use((req, _res, next) => {
  console.log(new Date().toISOString(), req.method, req.path);
  next();
});

// Auth da API: X-API-Key
app.use('/api', (req, res, next) => {
  if (req.path === '/health' || req.path.startsWith('/admin/')) return next(); // /admin usa a senha de administrador
  const key = C.get().apiKey;
  if (key && req.get('x-api-key') !== key) return res.status(401).json({ error: 'API key inválida', code: 'api_key' });
  next();
});

/* ---------------------------- /admin ---------------------------- */
// Página própria do backend (mesmo domínio — funciona mesmo se o CORS estiver errado): https://SEU-BACKEND/admin
app.get('/admin', (_req, res) => res.type('html').send(adminPage()));
function requireAdmin(req, res, next) {
  if (!C.adminConfigurado()) return res.status(503).json({ error: 'Defina ADMIN_PASSWORD (mín. 8 caracteres) no .env do servidor para usar o /admin.' });
  const r = C.checarAdmin(req.ip, req.get('x-admin-password'));
  if (r.bloqueado) return res.status(429).json({ error: `Muitas tentativas. Tente de novo em ${r.bloqueado}s.` });
  if (!r.ok) return res.status(401).json({ error: 'Senha de administrador incorreta.' });
  next();
}
const configPublica = () => {
  const c = C.get();
  return { ...c, apiKey: undefined, apiKeyDefinida: !!c.apiKey, apiKeyFinal: c.apiKey ? '…' + c.apiKey.slice(-4) : '' };
};
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
  console.log(new Date().toISOString(), '[admin] configuração alterada:', Object.keys(patch).join(', '));
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

app.get('/api/health', (_req, res) => res.json({ ok: true, commitEnabled: commitOn() }));

app.post('/api/auth/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email e password são obrigatórios' });
  const reuse = req.body?.sessionId ? getSession(req.body.sessionId) : null;
  const r = await startLogin(email, password, reuse);
  res.status(r.status === 'error' ? 401 : 200).json(r);
}));

app.post('/api/auth/code', wrap(async (req, res) => {
  const s = getSession(req.get('x-session-id') || req.body?.sessionId);
  if (!s) return res.status(401).json({ error: 'Sessão não encontrada. Refaça o login.' });
  const r = await submitCode(s, req.body?.code);
  res.status(r.status === 'error' ? 401 : 200).json({ sessionId: s.id, ...r });
}));

app.post('/api/auth/code/resend', wrap(async (req, res) => {
  const s = getSession(req.get('x-session-id') || req.body?.sessionId);
  if (!s) return res.status(401).json({ error: 'Sessão não encontrada. Refaça o login.' });
  res.json(await resendCode(s));
}));

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
  res.json(await lancarServico(req.esl, req.body || {}, { commit: commitOn() }));
}));

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
  res.json(await lancarPecas(req.esl, req.body || {}, { commit: commitOn() }));
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

app.get('/api/xml/historico', requireSession, (req, res) => {
  const tipo = req.query.tipo;
  res.json(LEDGER.all().filter((r) => !tipo || r.tipo === tipo));
});

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

app.listen(PORT, () => console.log(`ESL scraper backend em http://localhost:${PORT} (commit ${commitOn() ? 'LIGADO' : 'desligado'})`));
