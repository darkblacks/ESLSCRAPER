// Configuração em tempo de execução: começa pelo .env e pode ser alterada pelo /admin (sem reiniciar).
// O que for alterado no /admin fica salvo em data/config.json e tem prioridade sobre o .env.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const FILE = path.resolve('data', 'config.json');
fs.mkdirSync(path.dirname(FILE), { recursive: true });

const lista = (s) => String(s || '').split(',').map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean);

const padrao = () => ({
  corsOrigins: lista(process.env.CORS_ORIGINS || 'http://localhost:5173'),
  apiKey: process.env.API_KEY || '',
  allowCommit: process.env.ALLOW_COMMIT === 'true',
  sessionTtlMin: Number(process.env.SESSION_TTL_MIN || 60),
});

let salvo = {};
try {
  salvo = JSON.parse(fs.readFileSync(FILE, 'utf8'));
} catch {}

export const get = () => ({ ...padrao(), ...salvo });

/** Campos que o /admin pode alterar. */
export function update(patch = {}) {
  const novo = { ...salvo };
  if ('corsOrigins' in patch) novo.corsOrigins = (Array.isArray(patch.corsOrigins) ? patch.corsOrigins : lista(patch.corsOrigins)).map((o) => String(o).trim().replace(/\/+$/, '')).filter(Boolean);
  if ('apiKey' in patch) {
    const k = String(patch.apiKey || '').trim();
    if (k && k.length < 16) throw Object.assign(new Error('A chave da API precisa ter pelo menos 16 caracteres.'), { status: 400 });
    novo.apiKey = k;
  }
  if ('allowCommit' in patch) novo.allowCommit = !!patch.allowCommit;
  if ('sessionTtlMin' in patch) novo.sessionTtlMin = Math.min(24 * 60, Math.max(10, Number(patch.sessionTtlMin) || 60));
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(novo, null, 2));
  try {
    fs.renameSync(tmp, FILE);
  } catch {
    fs.writeFileSync(FILE, JSON.stringify(novo, null, 2));
  }
  salvo = novo;
  return get();
}

export const novaChave = () => crypto.randomBytes(24).toString('base64url');

/** Origem liberada? Aceita curinga: https://*.netlify.app libera qualquer subdomínio. */
export function origemPermitida(origin) {
  if (!origin) return true; // chamadas sem Origin (curl, o próprio backend, mesmo domínio)
  const o = origin.replace(/\/+$/, '');
  return get().corsOrigins.some((p) => {
    if (p === '*') return true;
    if (!p.includes('*')) return p === o;
    const re = new RegExp('^' + p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[a-z0-9-]+') + '$', 'i');
    return re.test(o);
  });
}

/* ---------------- senha do /admin ---------------- */
const ADMIN = process.env.ADMIN_PASSWORD || '';
const tentativas = new Map(); // ip -> { n, ate }
export const adminConfigurado = () => ADMIN.length >= 8;
export function checarAdmin(ip, senha) {
  const t = tentativas.get(ip) || { n: 0, ate: 0 };
  if (t.ate > Date.now()) return { ok: false, bloqueado: Math.ceil((t.ate - Date.now()) / 1000) };
  const a = Buffer.from(String(senha || ''));
  const b = Buffer.from(ADMIN);
  const ok = adminConfigurado() && a.length === b.length && crypto.timingSafeEqual(a, b);
  if (ok) tentativas.delete(ip);
  else {
    t.n++;
    if (t.n >= 5) Object.assign(t, { n: 0, ate: Date.now() + 5 * 60_000 }); // 5 erros → 5 min bloqueado
    tentativas.set(ip, t);
  }
  return { ok };
}
