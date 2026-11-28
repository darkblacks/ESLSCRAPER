// Testes da API HTTP: sobe o servidor real num diretório temporário e verifica autenticação, CORS, limites e rotas.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpCwd } from './helpers.js';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/server.js');
const PORT = 33000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = 'chave-de-teste-1234567890';
const ORIGEM = 'https://site-teste.netlify.app';
let proc;

before(async () => {
  const cwd = tmpCwd();
  proc = spawn(process.execPath, [SERVER], {
    cwd,
    env: { PATH: process.env.PATH, PORT: String(PORT), API_KEY: KEY, CORS_ORIGINS: ORIGEM, ALLOW_COMMIT: 'false', RATE_LIMIT_LOGIN_15MIN: '3', BODY_LIMIT: '1mb', ESL_BASE: 'http://127.0.0.1:9' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(BASE + '/api/health')).ok) return;
    } catch {}
    await new Promise((ok) => setTimeout(ok, 100));
  }
  throw new Error('servidor não subiu:\n' + log);
});
after(() => proc?.kill('SIGTERM'));

const get = (p, h = {}) => fetch(BASE + p, { headers: h });
const post = (p, body, h = {}) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('health é público e informa modo simulação', async () => {
  const r = await get('/api/health');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.commitEnabled, false);
});

test('rotas exigem X-API-Key', async () => {
  const r = await get('/api/modules');
  assert.equal(r.status, 401);
  assert.equal((await r.json()).code, 'api_key');
  assert.equal((await get('/api/modules', { 'X-API-Key': 'errada' })).status, 401);
  assert.equal((await get('/api/modules', { 'X-API-Key': KEY })).status, 200);
});

test('rotas operacionais exigem sessão ESL (sem_sessao)', async () => {
  const h = { 'X-API-Key': KEY };
  for (const [m, p] of [['POST', '/api/xml/buscar-chave'], ['POST', '/api/xml/servicos/preview'], ['POST', '/api/xml/pecas/preview'], ['POST', '/api/xml/servicos/lancar'], ['POST', '/api/xml/pecas/lancar'], ['POST', '/api/xml/lote'], ['GET', '/api/xml/historico'], ['GET', '/api/auth/state'], ['GET', '/api/lookup/vehicles']]) {
    const r = m === 'GET' ? await get(p, h) : await post(p, { file: { name: 'a.xml', content: '<x/>' } }, h);
    assert.equal(r.status, 401, `${m} ${p}`);
    assert.equal((await r.json()).code, 'sem_sessao', `${m} ${p}`);
  }
  assert.equal((await get('/api/xml/lote/qualquer', { ...h, 'X-Session-Id': 'inventada' })).status, 401);
});

test('auth/status sem sessão responde none', async () => {
  const r = await get('/api/auth/status', { 'X-API-Key': KEY });
  assert.deepEqual(await r.json(), { status: 'none' });
});

test('CORS: libera só a origem do frontend', async () => {
  const ok = await fetch(BASE + '/api/modules', { method: 'OPTIONS', headers: { Origin: ORIGEM, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-api-key,x-session-id,content-type' } });
  assert.equal(ok.headers.get('access-control-allow-origin'), ORIGEM);
  assert.match(ok.headers.get('access-control-allow-headers'), /X-Session-Id/i);
  const no = await fetch(BASE + '/api/modules', { method: 'OPTIONS', headers: { Origin: 'https://malicioso.example', 'Access-Control-Request-Method': 'GET' } });
  assert.equal(no.headers.get('access-control-allow-origin'), null);
});

test('upload acima do limite → 413 JSON; JSON inválido → 400', async () => {
  const big = await post('/api/xml/pecas/preview', { file: { name: 'g.xml', content: 'x'.repeat(1.2 * 1024 * 1024) } }, { 'X-API-Key': KEY });
  assert.equal(big.status, 413);
  assert.equal((await big.json()).code, 'too_large');
  const bad = await post('/api/xml/pecas/preview', '{nao-json', { 'X-API-Key': KEY });
  assert.equal(bad.status, 400);
});

test('/admin: exige sessão ESL logada (sem senha de administrador)', async () => {
  const r = await get('/api/admin/config');
  assert.equal(r.status, 401);
  assert.equal((await r.json()).code, 'sem_sessao');
  // a antiga senha de administrador não dá mais acesso
  assert.equal((await get('/api/admin/config', { 'X-Admin-Password': 'qualquer-coisa' })).status, 401);
  assert.equal((await get('/api/admin/config', { 'X-Session-Id': 'inventada', 'X-API-Key': KEY })).status, 401);
  const put = await fetch(BASE + '/api/admin/config', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'inventada' }, body: JSON.stringify({ allowCommit: true }) });
  assert.equal(put.status, 401);
  assert.equal((await (await get('/api/health')).json()).commitEnabled, false, 'gravação continua desligada');
});

test('/admin: página do servidor usa o login do ESL', async () => {
  const html = await (await get('/admin')).text();
  assert.match(html, /login do ESL/);
  assert.ok(!/ADMIN_PASSWORD|X-Admin-Password/.test(html));
});

test('/internal/lotes: só de dentro do container', async () => {
  const r = await get('/internal/lotes');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { lotes: 0 });
  assert.equal((await get('/internal/lotes', { 'X-Forwarded-For': '203.0.113.9' })).status, 404);
});

test('login: limite de tentativas por IP (429)', async () => {
  const h = { 'X-API-Key': KEY };
  for (let i = 0; i < 3; i++) await post('/api/auth/login', {}, h); // 400 (sem email/senha), mas conta
  const r = await post('/api/auth/login', {}, h);
  assert.equal(r.status, 429);
  assert.equal((await r.json()).code, 'rate_limit');
  // o login do /admin (sem chave da API) divide o mesmo limite
  assert.equal((await post('/api/admin/login', {})).status, 429);
});
