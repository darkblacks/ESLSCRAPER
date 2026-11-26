// Impressão do pedido de compra (Compras › Pedidos › Ações › Imprimir) capturada como PDF no servidor.
//
// No ESL (lido no JS em 26/11/2026): o botão chama printPurchaseOrder → window.open('/purchase/order/products/print?ids=<id>').
// A página é HTML (não PDF), imprime UM pedido por vez e chama window.print() ao carregar.
// Aqui: abre essa página numa ABA PRÓPRIA da mesma sessão (não mexe na aba de trabalho), desliga window.print antes de
// carregar e gera o PDF pelo próprio Chromium headless (page.pdf, mídia "print"). Nunca abre diálogo de impressão.
//
// Arquivos: data/pedidos/<id do pedido>.pdf (fora do git, dentro do backup). Histórico: etapas.impressao.
import fs from 'node:fs';
import path from 'node:path';
import * as L from './ledger.js';
import { BASE } from './esl.js';
import { mesclarPdfs } from './pdf.js';

const DIR = path.resolve('data', 'pedidos');
const idOk = (id) => /^\d{1,12}$/.test(String(id));
export const arquivoPedido = (pedidoId) => (idOk(pedidoId) ? path.join(DIR, `${pedidoId}.pdf`) : null);
export const temPdf = (pedidoId) => {
  const f = arquivoPedido(pedidoId);
  return !!f && fs.existsSync(f);
};

/** Abre a impressão do pedido numa aba própria (mesma sessão do ESL) e devolve o PDF (Buffer). */
export async function capturarPedido(s, pedidoId) {
  if (!idOk(pedidoId)) throw new Error('Pedido inválido para impressão.');
  const page = await s.context.newPage();
  try {
    await page.addInitScript(() => {
      window.print = () => {}; // a página do ESL chama print() ao carregar: no servidor não abre nada
    });
    await page.goto(`${BASE}/purchase/order/products/print?ids=${pedidoId}`, { waitUntil: 'load', timeout: 30_000 });
    if (/\/users\/sign_in/.test(page.url())) {
      const e = new Error('Sessão expirada no ESL. Faça login de novo.');
      e.status = 401;
      throw e;
    }
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    await page.emulateMedia({ media: 'print' });
    const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
    if (!pdf?.length || pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('O Chromium não gerou um PDF válido.');
    fs.mkdirSync(DIR, { recursive: true });
    const destino = arquivoPedido(pedidoId);
    fs.writeFileSync(destino + '.tmp', pdf);
    fs.renameSync(destino + '.tmp', destino);
    return pdf;
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Depois do lançamento: captura o PDF do pedido de compra da nota e registra no histórico.
 * Nunca derruba o lançamento — erro vira aviso (etapas.impressao.ok = false) e pode ser refeito pelo histórico.
 */
export async function registrarImpressao(s, key) {
  const reg = L.get(key);
  const pedidoId = reg?.etapas?.entrada?.pedidoId;
  if (!pedidoId) return null; // NF avulsa: não tem pedido de compra para imprimir
  const t0 = Date.now();
  try {
    const pdf = await capturarPedido(s, pedidoId);
    console.log(`[tempo] ${((Date.now() - t0) / 1000).toFixed(1)}s — PDF do pedido ${reg.etapas.entrada.pedidoNumero || pedidoId}`);
    return L.step(key, 'impressao', { ok: true, pedidoId, pedidoNumero: reg.etapas.entrada.pedidoNumero || null, arquivo: `${pedidoId}.pdf`, bytes: pdf.length, erro: null });
  } catch (e) {
    return L.step(key, 'impressao', { ok: false, pedidoId, pedidoNumero: reg.etapas.entrada.pedidoNumero || null, erro: e.message });
  }
}

/** Filtros do histórico: { tipo, lote, status, nf, de, ate } (de/ate = AAAA-MM-DD, pela data de início). */
export function filtrarHistorico(lista, f = {}) {
  const nf = String(f.nf || '').replace(/\D/g, '');
  const lote = String(f.lote || '').trim().toUpperCase();
  return lista.filter((r) => {
    if (f.tipo && r.tipo !== f.tipo) return false;
    if (f.status && r.status !== f.status) return false;
    if (lote && !(r.lotes || [r.lote]).some((l) => String(l || '').toUpperCase().includes(lote))) return false;
    if (nf && !String(r.numero || '').replace(/^0+/, '').includes(nf.replace(/^0+/, ''))) return false;
    const dia = String(r.inicio || '').slice(0, 10);
    if (f.de && dia < f.de) return false;
    if (f.ate && dia > f.ate) return false;
    return true;
  });
}

/** Linha do histórico para o site: registro + pedido/PDF. */
export function resumoHistorico(r) {
  const pedidoId = r.etapas?.impressao?.pedidoId || r.etapas?.entrada?.pedidoId || null;
  return {
    ...r,
    pedidoId,
    pedidoNumero: r.etapas?.impressao?.pedidoNumero || r.etapas?.entrada?.pedidoNumero || null,
    temPdf: temPdf(pedidoId),
    impressaoErro: r.etapas?.impressao?.ok === false ? r.etapas.impressao.erro : null,
  };
}

/** PDF de uma nota: o salvo, ou captura agora (se houver sessão no ESL). */
export async function pdfDaNota(s, key) {
  const r = L.get(key);
  if (!r) throw Object.assign(new Error('Nota não encontrada no histórico.'), { status: 404 });
  const { pedidoId } = resumoHistorico(r);
  if (!pedidoId) throw Object.assign(new Error('Esta nota não tem pedido de compra (NF avulsa ou não concluída).'), { status: 404 });
  if (temPdf(pedidoId)) return fs.readFileSync(arquivoPedido(pedidoId));
  if (!s || s.status !== 'ok') throw Object.assign(new Error('PDF ainda não capturado e não há sessão no ESL para capturar agora. Entre no ESL e tente de novo.'), { status: 409 });
  const res = await registrarImpressao(s, key);
  if (!res?.ok) throw Object.assign(new Error(`Não consegui gerar o PDF do pedido: ${res?.erro || 'erro desconhecido'}`), { status: 502 });
  return fs.readFileSync(arquivoPedido(pedidoId));
}

/**
 * Um PDF só com os pedidos das notas (na ordem da lista). Notas sem PDF são capturadas agora se houver sessão.
 * Devolve { pdf, incluidas, faltaram: [{ numero, motivo }] }.
 */
export async function pdfMesclado(s, registros, { max = 200 } = {}) {
  const buffers = [];
  const incluidas = [];
  const faltaram = [];
  for (const r of registros.slice(0, max)) {
    try {
      buffers.push(await pdfDaNota(s, r.docKey));
      incluidas.push(r.numero);
    } catch (e) {
      faltaram.push({ numero: r.numero, motivo: e.message });
    }
  }
  if (!buffers.length) throw Object.assign(new Error(faltaram[0]?.motivo || 'Nenhum pedido para imprimir com esses filtros.'), { status: faltaram.length ? 409 : 404, faltaram });
  return { pdf: mesclarPdfs(buffers), incluidas, faltaram };
}

/** Lote das notas lançadas antes de existir o ID de lote: um por dia de início (LOTE-AAAAMMDD-ANT). */
export const loteAntigoDe = (r) => {
  const d = new Date(r.inicio || Date.now());
  const sp = new Date(d.getTime() - 3 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '');
  return `LOTE-${sp}-ANT`;
};

/**
 * "Completar histórico": pega o que já foi lançado e completa o que falta para imprimir.
 *  1) notas sem lote ganham LOTE-AAAAMMDD-ANT (pelo dia em que foram lançadas);
 *  2) notas de peças CONCLUÍDAS com pedido de compra e sem PDF → captura o PDF agora (com a sessão do ESL).
 * Faz no máximo `max` capturas por chamada (o site chama de novo até `restantes` = 0). Idempotente.
 */
/** Notas sem lote (lançadas antes do ID de lote) ganham LOTE-AAAAMMDD-ANT. Automático: na subida e ao abrir o histórico. */
export function migrarLotesAntigos() {
  let n = 0;
  for (const r of L.all()) {
    if (!r.lote && !(r.lotes || []).length) {
      L.marcarLote(r.docKey, loteAntigoDe(r));
      n++;
    }
  }
  return n;
}

export async function completarHistorico(s, { max = 15 } = {}) {
  const lotesAtribuidos = migrarLotesAntigos();
  const todos = L.all();
  const pendentes = todos
    .map(resumoHistorico)
    .filter((r) => r.tipo === 'pecas' && r.status === 'concluido' && r.pedidoId && !r.temPdf)
    .sort((a, b) => String(a.inicio).localeCompare(String(b.inicio)));
  const capturados = [];
  const falhas = [];
  for (const r of pendentes.slice(0, max)) {
    const res = await registrarImpressao(s, r.docKey);
    if (res?.ok) capturados.push({ numero: r.numero, pedido: res.pedidoNumero || res.pedidoId });
    else {
      falhas.push({ numero: r.numero, motivo: res?.erro || 'erro desconhecido' });
      if (/sess[aã]o expirada|sign_in/i.test(res?.erro || '')) break; // login caiu: para aqui, o resto fica para depois
    }
  }
  const restantes = Math.max(0, pendentes.length - capturados.length - falhas.length);
  return { lotesAtribuidos, capturados, falhas, restantes, totalPendentes: pendentes.length };
}
