// Histórico local dos lançamentos por XML, com checkpoint de cada etapa (permite retomar sem repetir).
// Arquivo: data/lancamentos-xml.json  →  { [docKey]: Registro }
//
// Registro = { docKey, tipo: 'servico'|'pecas', status: 'em_andamento'|'concluido'|'erro',
//              numero, serie, chave, fornecedor, cnpj, inicio, fim, usuario,
//              etapas: { <etapa>: { ok, em, ...dados } }, eventos: [ {em, msg} ] }
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve('data');
const FILE = path.join(DATA_DIR, 'lancamentos-xml.json');
const MAP_FILE = path.join(DATA_DIR, 'mapeamento-pecas.json'); // mesmo de-para do módulo antigo
fs.mkdirSync(DATA_DIR, { recursive: true });

const read = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return {};
  }
};
// Grava com segurança mesmo dentro do OneDrive/antivírus, que às vezes travam o arquivo por alguns instantes
// (erro EPERM/EBUSY no rename). Tenta de novo e, se continuar travado, grava direto no arquivo.
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const write = (f, obj) => {
  const data = JSON.stringify(obj, null, 2);
  const tmp = f + '.tmp';
  for (let t = 0; t < 6; t++) {
    try {
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, f);
      return;
    } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      sleepSync(200 * (t + 1));
    }
  }
  fs.writeFileSync(f, data); // último recurso: sem rename
  try {
    fs.unlinkSync(tmp);
  } catch {}
};

const onlyDigits = (s) => String(s || '').replace(/\D/g, '');

/** Identificador único do documento: chave de acesso; sem chave, CNPJ + número + série. */
export function docKey({ chave, cnpj, numero, serie, tipo }) {
  if (chave && onlyDigits(chave).length >= 44) return onlyDigits(chave);
  return `${tipo || 'doc'}:${onlyDigits(cnpj)}:${String(numero || '').replace(/^0+/, '')}:${serie || ''}`;
}

/** Marca gravada nos comentários do ESL — permite reconhecer o lançamento mesmo sem o histórico local. */
export const marker = (key) => `[XML ${String(key).slice(-12)}]`;

export function get(key) {
  return read(FILE)[key] || null;
}

export function all() {
  return Object.values(read(FILE)).sort((a, b) => String(b.inicio).localeCompare(String(a.inicio)));
}

// Trava em memória: impede dois lançamentos simultâneos do mesmo documento.
const running = new Set();
export function lock(key) {
  if (running.has(key)) {
    const e = new Error('Este XML já está sendo lançado neste momento. Aguarde terminar.');
    e.status = 409;
    throw e;
  }
  running.add(key);
}
export const unlock = (key) => running.delete(key);

export function begin(key, info) {
  const db = read(FILE);
  const cur = db[key];
  db[key] = cur
    ? { ...cur, ...info, status: 'em_andamento', retomadaEm: new Date().toISOString() }
    : { docKey: key, ...info, status: 'em_andamento', inicio: new Date().toISOString(), etapas: {}, eventos: [] };
  write(FILE, db);
  return db[key];
}

export function step(key, etapa, dados) {
  const db = read(FILE);
  if (!db[key]) return;
  db[key].etapas[etapa] = { ...(db[key].etapas[etapa] || {}), ...dados, em: new Date().toISOString() };
  write(FILE, db);
  return db[key].etapas[etapa];
}

export function log(key, msg) {
  const db = read(FILE);
  if (!db[key]) return;
  db[key].eventos.push({ em: new Date().toISOString(), msg });
  write(FILE, db);
}

/** Guarda as etapas atuais em `anteriores` e recomeça do zero (ex.: nota refeita como Pedido). */
export function arquivarEtapas(key, info = {}) {
  const db = read(FILE);
  if (!db[key]) return;
  db[key].anteriores = [...(db[key].anteriores || []), { ...info, etapas: db[key].etapas, fim: db[key].fim, arquivadoEm: new Date().toISOString() }];
  db[key].etapas = {};
  write(FILE, db);
  return db[key];
}
export function atualizarAnterior(key, invoiceId, dados) {
  const db = read(FILE);
  const a = (db[key]?.anteriores || []).find((x) => String(x.invoiceId) === String(invoiceId));
  if (!a) return;
  Object.assign(a, dados, { atualizadoEm: new Date().toISOString() });
  write(FILE, db);
  return a;
}

export function finish(key, status, extra = {}) {
  const db = read(FILE);
  if (!db[key]) return;
  if (status === 'concluido') delete db[key].erro; // não deixa mensagem de erro antiga em nota concluída
  Object.assign(db[key], extra, { status, fim: new Date().toISOString() });
  write(FILE, db);
  return db[key];
}

/* de-para fornecedor+código → peça do ESL (aprendido a cada lançamento) */
export function learnedPart(cnpj, cProd) {
  const m = read(MAP_FILE);
  const hit = m[`${cnpj}|${cProd}`];
  if (!hit) return null;
  // de-para suspeito: outro código do MESMO fornecedor aprendeu a mesma peça (sintoma do lançamento com itens sem número)
  const mesmos = Object.entries(m).filter(([k, v]) => k.startsWith(`${cnpj}|`) && k !== `${cnpj}|${cProd}` && String(v.id) === String(hit.id));
  return mesmos.length ? null : hit;
}

/** Remove de-paras suspeitos (vários códigos do mesmo fornecedor → mesma peça). Roda ao iniciar o backend. */
export function limparDeParaSuspeito() {
  const m = read(MAP_FILE);
  const grupos = {};
  for (const [k, v] of Object.entries(m)) (grupos[`${k.split('|')[0]}|${v.id}`] ||= []).push(k);
  let n = 0;
  for (const ks of Object.values(grupos)) if (ks.length > 1) for (const k of ks) { delete m[k]; n++; }
  if (n) write(MAP_FILE, m);
  return n;
}
export function learnPart(cnpj, cProd, product) {
  const m = read(MAP_FILE);
  m[`${cnpj}|${cProd}`] = { id: product.id, text: product.text };
  write(MAP_FILE, m);
}

/* de-para prestador → como lançar o serviço (aprendido a cada lançamento concluído) */
const SVC_FILE = path.join(DATA_DIR, 'mapeamento-servicos.json'); // cnpj -> { setItem, produto, status }
export function learnedService(cnpj) {
  return read(SVC_FILE)[onlyDigits(cnpj)] || null;
}
export function learnService(cnpj, data) {
  const m = read(SVC_FILE);
  m[onlyDigits(cnpj)] = { ...data, em: new Date().toISOString() };
  write(SVC_FILE, m);
}
