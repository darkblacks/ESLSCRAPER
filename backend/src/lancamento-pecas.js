// Aba "XML de Peças": NF-e de peças → (cadastro das peças novas) → entrada no estoque → aplicação na OS → baixa no estoque.
// Tudo num único processo, com checkpoint por etapa/item (retomada sem repetir o que já foi feito).
import fs from 'node:fs';
import path from 'node:path';
import * as L from './ledger.js';
import { apiGet } from './esl.js';
import { parseNfe, splitEmissao } from './nfe.js';
import {
  findPersonByDocument, findPurchaseInvoice, findStorageInvoices, storageInvoiceMovements, withdrawalMovements,
  searchProducts, searchVehicles, searchServiceOrders, getServiceOrder, matchUnit, listFiliais,
} from './lookups.js';
import { createPart, createStorageInvoice, addStorageMovement, setStorageInvoiceTotals, deleteStorageMovement, createWithdrawal, addWithdrawalItem, pageShot } from './estoque.js';
import { ctx } from './ui.js';
import { createServiceOrder, addPartToOrder, openOrdersForVehicle } from './os.js';

const onlyDigits = (s) => String(s || '').replace(/\D/g, '');
const money = (n) => Number(n || 0).toFixed(2);
/** Texto livre do usuário: uma linha só (o campo do ESL é de linha única) e no máximo 500 caracteres. */
const limpaTexto = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 500);
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const LEGACY = path.resolve('data', 'lancamentos.json'); // histórico do módulo antigo (Manutenção XML → OS)
const legacy = () => {
  try {
    return JSON.parse(fs.readFileSync(LEGACY, 'utf8'));
  } catch {
    return {};
  }
};

/* ------------------------------------------------------------------ */
/* Duplicidade                                                        */
/* ------------------------------------------------------------------ */

/** NFs de entrada do mesmo fornecedor cujo comentário cita o nº/chave da nota (lançadas a partir de pedido, à mão). */
async function storageInvoicesMentioning(s, issuerId, nf) {
  const list = await apiGet(s, `/storage/invoice/products.json?search%5Bstorage_invoices%5D%5Bissuer_id%5D=${issuerId}&per=40`).catch(() => []);
  const arr = Array.isArray(list) ? list : list.data || [];
  const re = new RegExp(`\\bN\\.?\\s*F\\.?(?:-?e)?\\s*[:nº°o.]*\\s*0*${nf.numero}\\b`, 'i');
  const out = [];
  for (const x of arr.slice(0, 25)) {
    const d = await apiGet(s, `/storage/invoice/products/${x.id}.json`).catch(() => null);
    const c = String(d?.comments || '');
    if (re.test(c) || (nf.chave && c.includes(nf.chave))) {
      out.push({ id: x.id, numero: x.number, tipo: x.invoice_type_formatted, data: x.emission_at, total: Number(x.total || 0), comentario: c, url: `/storage/invoice/products/${x.id}/edit` });
    }
  }
  return out;
}

export async function checkPartsDuplicate(s, nf, fornecedorId) {
  const key = L.docKey({ chave: nf.chave, cnpj: nf.emitente.cnpj, numero: nf.numero, serie: nf.serie, tipo: 'nfe' });
  const reg = L.get(key);
  const own = new Set([reg?.etapas?.entrada?.invoiceId].filter(Boolean).map(String));
  const out = { docKey: key, bloqueado: false, motivos: [], existentes: [], alertas: [], retomavel: null };

  // "concluída" pelo histórico, mas a NF de entrada no ESL não bate com o XML → libera para a automação corrigir
  let divergente = null;
  if (reg?.status === 'concluido' && reg.etapas?.entrada?.invoiceId) {
    const mv = await storageInvoiceMovements(s, reg.etapas.entrada.invoiceId).catch(() => null);
    if (mv) {
      const q = mv.reduce((a, m) => a + m.quantidade, 0);
      const v = mv.reduce((a, m) => a + m.total, 0);
      const xi = nf.items || []; // no lançamento os itens vêm da tela (ver lancarPecas)
      const qx = xi.reduce((a, i) => a + Number(i.quantidade), 0);
      const vx = xi.reduce((a, i) => a + Number(i.valorTotal), 0);
      if (mv.length !== xi.length || Math.abs(q - qx) > 0.001 || Math.abs(v - vx) > 0.05) {
        divergente = `NF de entrada no ESL tem ${mv.length} itens / ${q} un / R$ ${money(v)}; o XML tem ${xi.length} / ${qx} / R$ ${money(vx)}`;
      }
    }
  }
  if (divergente) {
    out.retomavel = { status: 'divergente', etapas: Object.keys(reg.etapas || {}), erro: `${divergente} — ao lançar, a automação corrige (inclui o que falta e remove o que sobra).` };
  } else if (reg?.status === 'concluido') {
    out.bloqueado = true;
    out.motivos.push(`Nota já lançada por esta plataforma em ${new Date(reg.fim).toLocaleString('pt-BR')}.`);
    out.existentes.push({ origem: 'Histórico', entrada: reg.etapas?.entrada?.invoiceId, os: reg.etapas?.os?.numero, baixa: reg.etapas?.baixa?.withdrawalId });
  } else if (reg) {
    out.retomavel = { status: reg.status, etapas: Object.keys(reg.etapas || {}), erro: reg.erro || null };
  }
  const old = legacy()[nf.chave];
  if (old) {
    out.bloqueado = true;
    out.motivos.push(`Nota já lançada pelo módulo anterior na OS ${old.osNumero ?? old.osId}.`);
    out.existentes.push({ origem: 'Histórico (módulo anterior)', os: old.osNumero, osId: old.osId });
  }

  const sefaz = await findPurchaseInvoice(s, nf.chave).catch(() => null);
  if (sefaz) out.notaSefaz = sefaz;

  if (fornecedorId) {
    const byNumber = (await findStorageInvoices(s, 'products', { numero: nf.numero, issuerId: fornecedorId })).filter((x) => !own.has(String(x.id)));
    const bySefaz = sefaz ? (await findStorageInvoices(s, 'products', { numero: sefaz.numero, issuerId: fornecedorId })).filter((x) => x.purchaseInvoiceId === sefaz.id) : [];
    const byComment = (await storageInvoicesMentioning(s, fornecedorId, nf)).filter((x) => !own.has(String(x.id)));
    const found = [...new Map([...byNumber, ...bySefaz, ...byComment].map((x) => [x.id, x])).values()];
    if (found.length) {
      out.bloqueado = true;
      out.motivos.push(`A NF ${nf.numero} já tem entrada no estoque do ESL (Compras › Notas Fiscais Entrada).`);
      found.forEach((x) => out.existentes.push({ origem: 'NF de Entrada (Produtos e peças)', ...x }));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Pré-visualização                                                   */
/* ------------------------------------------------------------------ */

/** Sugestões de peça para um item, com classificação: certo | duvida | nenhum. */
async function matchItem(s, cnpj, item) {
  const learned = L.learnedPart(cnpj, item.cProd);
  const terms = [...new Set([item.cProd, item.cProdBase, item.oem, item.ean, item.nomeLimpo.split(/\s+/).slice(0, 3).join(' ')].filter(Boolean))];
  const seen = new Map();
  for (const t of terms) {
    for (const p of await searchProducts(s, t, 'part').catch(() => [])) {
      if (seen.has(p.id)) continue;
      let score = 10;
      const pc = norm(p.codigo);
      if (pc && (pc === norm(item.cProd) || pc === norm(item.cProdBase))) score = 95;
      else if (item.oem && pc.endsWith(norm(item.oem))) score = 85;
      else if (item.ean && pc === norm(item.ean)) score = 85;
      else if (pc && norm(item.descricao).includes(pc) && pc.length >= 5) score = 50;
      else if (norm(p.nome) === norm(item.nomeLimpo)) score = 45;
      seen.set(p.id, { ...p, score, via: t });
    }
  }
  const sugestoes = [...seen.values()].sort((a, b) => b.score - a.score).slice(0, 8);
  const top = sugestoes[0];
  const second = sugestoes[1];
  let situacao = 'nenhum';
  let produto = null;
  const exato = sugestoes.find((x) => x.score >= 95);
  if (learned && (!exato || String(exato.id) === String(learned.id))) {
    situacao = 'certo';
    produto = { ...learned, via: 'já usado antes para este código do fornecedor' };
  } else if (top && top.score >= 85 && !(second && second.score >= 85)) {
    situacao = 'certo';
    produto = { id: top.id, text: top.text, via: `código ${top.codigo}` };
  } else if (sugestoes.length) {
    situacao = 'duvida';
  }
  return { situacao, produto, sugestoes };
}

export async function previewPecas(s, file) {
  const nf = parseNfe(file.content);
  const fornecedor = await findPersonByDocument(s, nf.emitente.cnpj);
  const dup = await checkPartsDuplicate(s, nf, fornecedor?.id);

  // filial destinatária pelo CNPJ do destinatário
  let filial = null;
  const dest = nf.destinatario?.cnpj ? await findPersonByDocument(s, nf.destinatario.cnpj).catch(() => null) : null;
  if (dest) {
    const fil = await listFiliais(s).catch(() => []);
    filial = fil.find((f) => norm(f.nome) === norm(dest.nome))?.nome || dest.nome;
  }

  const itens = [];
  for (const it of nf.items) {
    const m = await matchItem(s, nf.emitente.cnpj, it);
    const unidade = await matchUnit(s, it.unidade).catch(() => null);
    itens.push({
      ...it, ...m,
      novo: {
        code: it.cProd, name: it.nomeLimpo.toUpperCase().slice(0, 120), unitId: unidade?.id ?? null, unitText: unidade?.nome ?? it.unidade,
        comments: [it.ncm && `NCM ${it.ncm}`, it.ean && `EAN ${it.ean}`, `Cód. fornecedor ${it.cProd}`].filter(Boolean).join(' · '),
      },
    });
  }

  let veiculoSugerido = null;
  if (nf.placaNoTexto) veiculoSugerido = (await searchVehicles(s, nf.placaNoTexto).catch(() => []))[0] || null;
  const osSugeridas = veiculoSugerido ? await searchServiceOrders(s, { term: veiculoSugerido.placa, status: 'pending' }).catch(() => []) : [];

  const faltando = [!nf.numero && 'número', !nf.emitente.cnpj && 'CNPJ do fornecedor', !nf.emissao && 'data de emissão'].filter(Boolean);
  return {
    arquivo: file.name, ok: true, nf: { ...nf, items: undefined }, itens, fornecedor, filial, duplicidade: dup,
    veiculoSugerido, osSugeridas, faltando, ...splitEmissao(nf.emissao),
  };
}

/* ------------------------------------------------------------------ */
/* Lançamento completo                                                */
/* ------------------------------------------------------------------ */

/**
 * payload = {
 *   nf, fornecedor:{id,nome}, filial:'TRANSMASSA - SBC', date, time,
 *   almoxarifado:{id,nome},
 *   itens:[{ nItem, cProd, descricao, quantidade, valorUnitario, acao:'existente'|'cadastrar',
 *            produto:{id,text}, novo:{code,name,setItemId,setItemText,groupId,groupText,unitId,comments} }],
 *   os: { modo:'nenhuma' } (só entrada no estoque) | { modo:'existente', id } | { modo:'nova', workshopType, corporationId, corporationText, vehicleId, vehicleText, placa,
 *         odometer, maintenanceType, date, time, description, oficinaId, oficinaText, receptionResponsible, confirmarMesmoVeiculo },
 *   baixa: { employeeId, employeeText },
 *   comentarioOs, comentarioEntrada
 * }
 */
export async function lancarPecas(s, payload, { commit }) {
  const { nf, fornecedor, filial, almoxarifado, itens = [], os, baixa = {} } = payload;
  const faltas = [];
  if (!nf?.numero) faltas.push('número da NF');
  if (!fornecedor?.id) faltas.push('fornecedor cadastrado no ESL');
  if (!filial) faltas.push('filial (destinatário)');
  if (!payload.date) faltas.push('data de emissão');
  if (!almoxarifado?.id) faltas.push('almoxarifado');
  if (!itens.length) faltas.push('itens');
  // trava de segurança: cada item precisa de número próprio (lista antiga/defeituosa juntava tudo no 1º item)
  const nums = itens.map((it) => it.nItem);
  if (nums.some((n) => !Number.isInteger(Number(n)) || Number(n) < 1) || new Set(nums.map(String)).size !== nums.length) {
    return { ok: false, etapa: 'validação', error: 'Os itens desta nota estão sem numeração válida (lista lida por uma versão antiga). Remova a nota da lista e solte o XML de novo.' };
  }
  // e cada item precisa apontar para uma peça diferente, a menos que a NF repita a mesma peça
  const porProduto = {};
  for (const it of itens) if (it.acao !== 'cadastrar' && it.produto?.id) (porProduto[it.produto.id] ||= []).push(it);
  for (const grupo of Object.values(porProduto)) {
    if (grupo.length > 1 && new Set(grupo.map((g) => String(g.cProd))).size > 1) {
      return { ok: false, etapa: 'validação', error: `Itens diferentes da NF (${grupo.map((g) => g.cProd).join(', ')}) apontam para a mesma peça do ESL (${grupo[0].produto.text}). Confira em "detalhes" antes de lançar.` };
    }
  }
  itens.forEach((it) => {
    if (it.acao === 'cadastrar') {
      const n = it.novo || {};
      if (!n.code || !n.name) faltas.push(`código/nome da peça nova (item ${it.nItem})`);
      if (!n.setItemId) faltas.push(`conjunto e item da peça nova (item ${it.nItem})`);
      if (!n.groupId) faltas.push(`grupo da peça nova (item ${it.nItem})`);
      if (!n.unitId) faltas.push(`unidade da peça nova (item ${it.nItem})`);
    } else if (!it.produto?.id) faltas.push(`peça do ESL para o item ${it.nItem} (${it.cProd})`);
    if (!(Number(it.quantidade) > 0)) faltas.push(`quantidade do item ${it.nItem}`);
  });
  if (!os?.modo) faltas.push('OS de destino');
  if (os?.modo === 'existente' && !os.id) faltas.push('OS existente');
  if (os?.modo === 'nova' && (!os.vehicleId || !os.receptionResponsible || !os.oficinaId)) faltas.push('veículo, oficina e responsável da nova OS');
  if (faltas.length) return { ok: false, etapa: 'validação', error: `Faltam: ${faltas.join(', ')}.` };
  if (!commit) return { ok: false, error: 'Gravação desativada no backend (ALLOW_COMMIT=false).' };

  const passos = [];
  const p = (etapa, ok, msg, extra = {}) => passos.push({ etapa, ok, msg, ...extra });

  // 1) Revalida duplicidade do XML
  const nfComItens = { ...nf, items: nf.items || itens.map((i) => ({ quantidade: Number(i.quantidade), valorTotal: Math.round(Number(i.quantidade) * Number(i.valorUnitario) * 100) / 100 })) };
  const dup = await checkPartsDuplicate(s, nfComItens, fornecedor.id);
  if (dup.bloqueado) return { ok: false, etapa: 'duplicidade', error: dup.motivos.join(' '), duplicidade: dup };
  p('Duplicidade do XML', true, dup.retomavel ? 'Processamento anterior incompleto encontrado — retomando.' : 'Nota ainda não lançada no ESL.');

  const key = dup.docKey;
  L.lock(key);
  try {
  L.begin(key, { tipo: 'pecas', numero: nf.numero, serie: nf.serie, chave: nf.chave, fornecedor: fornecedor.nome, cnpj: onlyDigits(nf.emitente.cnpj), valor: nf.valorNota, usuario: s.email });
  const mk = L.marker(key);
  const E = () => L.get(key).etapas || {};
  const ref = `NF ${nf.numero}${nf.serie ? ' série ' + nf.serie : ''} - ${fornecedor.nome}`;

  const resItens = {}; // nItem -> { cadastro, entrada, os, baixa }
  const itensRes = (it) => (resItens[it.nItem] ||= { nItem: it.nItem, cProd: it.cProd, descricao: it.descricao });
  const usados = {}; // nItem -> id do movimento casado
  const itensResumo = () => itens.map((it) => ({ ...itensRes(it), quantidade: it.quantidade, valorUnitario: it.valorUnitario }));
  try {
    // 2) Cadastro das peças novas
    const produtos = { ...(E().cadastros?.produtos || {}) }; // nItem -> {id,text}
    for (const it of itens) {
      if (it.acao !== 'cadastrar') {
        produtos[it.nItem] = { id: it.produto.id, text: it.produto.text }; // sempre o que está na tela (ignora cache antigo)
        continue;
      }
      if (produtos[it.nItem]) continue;
      ctx(s.page, `NF ${nf.numero} · cadastro · item ${it.nItem} (${it.cProd})`);
      const n = it.novo;
      // revalida: se já existir peça com o mesmo código, usa a existente (não duplica)
      const exist = (await searchProducts(s, n.code, 'part')).find((x) => norm(x.codigo) === norm(n.code));
      if (exist) {
        produtos[it.nItem] = { id: exist.id, text: exist.text };
        itensRes(it).cadastro = { ok: true, msg: `já existia: ${exist.text}` };
        p(`Cadastro item ${it.nItem}`, true, `Peça ${exist.text} já existia — usada sem duplicar.`);
      } else {
        const id = await createPart(s, { ...n, supplierId: fornecedor.id, supplierText: fornecedor.nome, supplierCode: it.cProd, homologationDate: payload.date });
        const conf = (await searchProducts(s, n.code, 'part')).find((x) => String(x.id) === String(id));
        produtos[it.nItem] = { id, text: conf?.text || `${n.code} - ${n.name}` };
        itensRes(it).cadastro = { ok: true, msg: `cadastrada: ${produtos[it.nItem].text}` };
        p(`Cadastro item ${it.nItem}`, true, `Peça ${produtos[it.nItem].text} cadastrada.`);
      }
      L.step(key, 'cadastros', { produtos });
    }
    L.step(key, 'cadastros', { produtos, ok: true });
    for (const it of itens) L.learnPart(onlyDigits(nf.emitente.cnpj), it.cProd, produtos[it.nItem]);

    // 3) Entrada no estoque (NF de entrada)
    let invoiceId = E().entrada?.invoiceId;
    if (!invoiceId) {
      ctx(s.page, `NF ${nf.numero} · entrada · cabeçalho`);
      invoiceId = await createStorageInvoice(s, {
        issuerId: fornecedor.id, issuerText: fornecedor.nome, filial, number: nf.numero, date: payload.date, time: payload.time,
        // padrão (NF, chave, marca de controle) primeiro — nunca é cortado; depois o texto livre do usuário (até 500 caracteres)
        comments: [`NF ${nf.numero} série ${nf.serie}`, nf.chave && `Chave ${nf.chave}`, mk, limpaTexto(payload.comentarioEntrada), limpaTexto(payload.comentarioNf)]
          .filter(Boolean).join(' | '),
      });
      L.step(key, 'entrada', { invoiceId, itensOk: [] });
      p('Entrada no estoque', true, `NF de entrada criada (id ${invoiceId}).`);
    } else p('Entrada no estoque', true, `Retomando NF de entrada id ${invoiceId}.`);

    // Concilia item a item com o que JÁ está gravado no ESL (retomada não duplica e não confia só no histórico)
    const codigoDe = (pr, it) => (it.acao === 'cadastrar' ? it.novo.code : String(pr.text || '').split(' - ')[0]).trim();
    const sobra = [...(await storageInvoiceMovements(s, invoiceId))];
    const casar = (it) => {
      const cod = norm(codigoDe(produtos[it.nItem], it));
      const mesmo = (m) => norm(m.codigo) === cod && Math.abs(m.quantidade - Number(it.quantidade)) < 0.001;
      // prefere a linha com o valor certo (se houver duas iguais, a de valor errado sobra e é removida)
      let i = sobra.findIndex((m) => mesmo(m) && Math.abs(m.valorUnitario - Number(it.valorUnitario)) < 0.01);
      if (i < 0) i = sobra.findIndex(mesmo);
      return i >= 0 ? sobra.splice(i, 1)[0] : null;
    };
    const confereValor = (it, mv) => Math.abs(mv.valorUnitario - Number(it.valorUnitario)) < 0.01;
    const recarregaSobra = async () =>
      sobra.splice(0, sobra.length, ...(await storageInvoiceMovements(s, invoiceId)).filter((m) => !Object.values(usados).includes(m.id)));
    const registrar = (it, mv) => {
      const r = itensRes(it);
      usados[it.nItem] = mv.id;
      r.entrada = confereValor(it, mv)
        ? { ok: true, msg: `${mv.quantidade} × R$ ${money(mv.valorUnitario)}${r.retomado ? ' (já estava no ESL)' : ''}${r.corrigido ? ' (corrigido automaticamente)' : ''}` }
        : { ok: false, msg: `gravado com valor unitário R$ ${money(mv.valorUnitario)}, o XML diz R$ ${money(it.valorUnitario)}` };
    };
    /** Grava um item na NF de entrada e espera ele aparecer (até ~12 s). Retorna o movimento ou null. */
    const gravarItem = async (it, rotulo = '') => {
      const r = itensRes(it);
      ctx(s.page, `NF ${nf.numero} · entrada · item ${it.nItem} (${it.cProd}) ${it.quantidade} × ${money(it.valorUnitario)}${rotulo}`);
      let mv = null;
      try {
        await addStorageMovement(s, invoiceId, {
          productId: produtos[it.nItem].id, productText: produtos[it.nItem].text, quantidade: it.quantidade, valorUnitario: it.valorUnitario,
          icms: it.icms, ipi: it.ipi, warehouseId: almoxarifado.id, warehouseText: almoxarifado.nome,
        });
      } catch (e) {
        r.entrada = { ok: false, msg: e.message };
      }
      // mesmo com erro na tela, o ESL às vezes grava — confere sempre
      for (let t = 0; t < 8 && !mv; t++) {
        await recarregaSobra();
        mv = casar(it);
        if (!mv) await new Promise((ok) => setTimeout(ok, 1500));
      }
      if (!mv && !r.entrada) r.entrada = { ok: false, msg: 'o ESL não gravou o item (salvou o formulário mas o item não aparece na NF de entrada)' };
      return mv;
    };
    const salvarProgresso = () => L.step(key, 'entrada', { itensOk: itens.filter((x) => itensRes(x).entrada?.ok).map((x) => x.nItem) });
    const faltando = () => itens.filter((it) => !usados[it.nItem]);

    for (const it of itens) {
      let mv = casar(it);
      if (mv) itensRes(it).retomado = true;
      else mv = await gravarItem(it);
      if (mv) registrar(it, mv);
      salvarProgresso();
    }

    // Correção automática 1: tenta de novo só os itens que não entraram (até 2 vezes)
    for (let tent = 1; tent <= 2 && faltando().length; tent++) {
      p('Correção automática', true, `${faltando().length} item(ns) não entraram — tentando de novo (tentativa ${tent} de 2).`);
      await recarregaSobra();
      for (const it of faltando()) {
        itensRes(it).corrigido = true;
        delete itensRes(it).entrada;
        const mv = casar(it) || (await gravarItem(it, ` · nova tentativa ${tent}`));
        if (mv) registrar(it, mv);
        salvarProgresso();
      }
    }

    // Correção automática 2: refaz a NF de entrada do zero (esvazia e lança todos os itens de novo).
    // Só em NF criada por esta automação (marca no comentário) — nunca mexe em NF lançada à mão.
    if (faltando().length) {
      const cab = await apiGet(s, `/storage/invoice/products/${invoiceId}.json`).catch(() => null);
      if (!String(cab?.comments || '').includes(mk)) {
        throw Object.assign(new Error(`A NF de entrada ${invoiceId} não foi criada por esta automação — não refaço sozinho. ` +
          faltando().map((it) => `Item ${it.nItem} (${it.cProd}): ${itensRes(it).entrada?.msg || 'não gravou'}`).join(' · ')), { etapa: 'Entrada no estoque' });
      }
      p('Correção automática', true, `Ainda faltam ${faltando().length} item(ns) — refazendo a NF de entrada ${invoiceId} do zero.`);
      const atuais = await storageInvoiceMovements(s, invoiceId);
      for (const m of atuais) {
        ctx(s.page, `NF ${nf.numero} · entrada · refazendo: removendo ${m.codigo}`);
        await deleteStorageMovement(s, invoiceId, { codigo: m.codigo, quantidade: m.quantidade, valorUnitario: m.valorUnitario });
      }
      const resto = await storageInvoiceMovements(s, invoiceId);
      if (resto.length) {
        throw Object.assign(new Error(`Não consegui esvaziar a NF de entrada ${invoiceId} para refazer (${resto.length} item(ns) ficaram).`), { etapa: 'Entrada no estoque' });
      }
      for (const k of Object.keys(usados)) delete usados[k];
      sobra.length = 0;
      L.step(key, 'entrada', { itensOk: [], refeitaEm: new Date().toISOString() });
      for (const it of itens) {
        const r = itensRes(it);
        delete r.entrada;
        delete r.retomado;
        r.corrigido = true;
        const mv = await gravarItem(it, ' · NF refeita');
        if (mv) registrar(it, mv);
        salvarProgresso();
      }
      if (!faltando().length) p('Correção automática', true, `NF de entrada ${invoiceId} refeita com todos os ${itens.length} itens.`);
    }
    const movs = await storageInvoiceMovements(s, invoiceId);
    const qEsp = itens.reduce((a, i) => a + Number(i.quantidade), 0);
    let qGrav = movs.reduce((a, m) => a + m.quantidade, 0);
    const vEsp = itens.reduce((a, i) => a + Number(i.quantidade) * Number(i.valorUnitario), 0);
    let vGrav = movs.reduce((a, m) => a + m.total, 0);
    const falhasAntes = itens.filter((it) => !itensRes(it).entrada?.ok && !usados[it.nItem]); // não gravou (os de valor errado são corrigidos abaixo)
    if (falhasAntes.length) {
      throw Object.assign(new Error(`Entrada incompleta mesmo após a correção automática (repeti os itens e refiz a NF): ${itens.length - falhasAntes.length} de ${itens.length} itens OK. ` +
        falhasAntes.map((it) => `Item ${it.nItem} (${it.cProd} ${String(it.descricao).slice(0, 30)}): ${itensRes(it).entrada?.msg || 'não processado'}`).join(' · ')), { etapa: 'Entrada no estoque' });
    }
    // itens da NF de entrada que NÃO estão no XML: remove (só em NF criada pela automação — tem a marca no comentário)
    // inclui itens casados com valor errado: remove e lança de novo com o valor do XML
    const comValorErrado = itens.filter((it) => itensRes(it).entrada && !itensRes(it).entrada.ok && usados[it.nItem]);
    const remover = [...sobra, ...comValorErrado.map((it) => movs.find((m) => m.id === usados[it.nItem])).filter(Boolean)];
    if (remover.length) {
      const cab = await apiGet(s, `/storage/invoice/products/${invoiceId}.json`).catch(() => null);
      if (!String(cab?.comments || '').includes(mk)) {
        throw Object.assign(new Error(`A NF de entrada ${invoiceId} tem ${remover.length} item(ns) que não estão no XML, mas não foi criada por esta automação — corrija no ESL.`), { etapa: 'Entrada no estoque' });
      }
      for (const m of remover) {
        ctx(s.page, `NF ${nf.numero} · entrada · removendo item que não está no XML`);
        await deleteStorageMovement(s, invoiceId, { codigo: m.codigo, quantidade: m.quantidade, valorUnitario: m.valorUnitario });
        const ainda = (await storageInvoiceMovements(s, invoiceId)).some((x) => x.id === m.id);
        if (ainda) throw Object.assign(new Error(`Não consegui remover o item ${m.codigo} (${m.quantidade} × ${money(m.valorUnitario)}) da NF de entrada.`), { etapa: 'Entrada no estoque' });
        p('Entrada', true, `Removido ${m.codigo} ${m.quantidade} × R$ ${money(m.valorUnitario)} (não estava no XML).`);
      }
      // os de valor errado entram de novo, certos
      for (const it of comValorErrado) {
        ctx(s.page, `NF ${nf.numero} · entrada · item ${it.nItem} (${it.cProd}) relançado com valor do XML`);
        await addStorageMovement(s, invoiceId, {
          productId: produtos[it.nItem].id, productText: produtos[it.nItem].text, quantidade: it.quantidade, valorUnitario: it.valorUnitario,
          warehouseId: almoxarifado.id, warehouseText: almoxarifado.nome,
        });
      }
      // reconfere tudo do zero
      const agora = await storageInvoiceMovements(s, invoiceId);
      const pool = [...agora];
      for (const it of itens) {
        const cod = norm(codigoDe(produtos[it.nItem], it));
        const i = pool.findIndex((m) => norm(m.codigo) === cod && Math.abs(m.quantidade - Number(it.quantidade)) < 0.001 && Math.abs(m.valorUnitario - Number(it.valorUnitario)) < 0.01);
        itensRes(it).entrada = i >= 0 ? { ok: true, msg: `${it.quantidade} × R$ ${money(it.valorUnitario)} (corrigido)` } : { ok: false, msg: 'continua divergente após a correção' };
        if (i >= 0) pool.splice(i, 1);
      }
      const ruins = itens.filter((it) => !itensRes(it).entrada.ok);
      if (ruins.length || pool.length) {
        throw Object.assign(new Error(`Depois da correção a NF de entrada ainda não bate com o XML (${ruins.length} item(ns) divergentes, ${pool.length} sobrando).`), { etapa: 'Entrada no estoque' });
      }
      movs.splice(0, movs.length, ...agora);
      qGrav = movs.reduce((a, m) => a + m.quantidade, 0);
      vGrav = movs.reduce((a, m) => a + m.total, 0);
    }
    // conferência final estrita: mesma quantidade de linhas, quantidades e valores do XML
    if (movs.length !== itens.length || Math.abs(qGrav - qEsp) > 0.001 || Math.abs(vGrav - vEsp) > 0.05) {
      throw Object.assign(new Error(`NF de entrada não bate com o XML: esperado ${itens.length} itens / ${qEsp} un / R$ ${money(vEsp)}; no ESL ${movs.length} / ${qGrav} / R$ ${money(vGrav)}.`), { etapa: 'Entrada no estoque' });
    }
    p('Entrada conferida', true, `${movs.length} item(ns), ${qGrav} un, R$ ${money(vGrav)} em ${almoxarifado.nome} — igual ao XML.`);
    // desconto e frete da NF vão no cabeçalho da entrada (itens ficam com valor bruto) → total da entrada = total da NF
    const desc = Math.round(itens.reduce((a, i) => a + Number(i.desconto || 0), 0) * 100) / 100;
    const frete = Math.round(itens.reduce((a, i) => a + Number(i.frete || 0), 0) * 100) / 100;
    const cabAtual = await apiGet(s, `/storage/invoice/products/${invoiceId}.json`).catch(() => null);
    const descAtual = Number(cabAtual?.discount_value || 0);
    const freteAtual = Number(cabAtual?.freight_total || 0);
    if (Math.abs(descAtual - desc) > 0.009 || Math.abs(freteAtual - frete) > 0.009) {
      ctx(s.page, `NF ${nf.numero} · entrada · desconto/frete do cabeçalho`);
      await setStorageInvoiceTotals(s, invoiceId, { frete, desconto: desc });
      L.step(key, 'entrada', { totaisOk: true });
      p('Entrada', true, `Cabeçalho ajustado: desconto R$ ${money(desc)}${frete ? `, frete R$ ${money(frete)}` : ''} (total da NF R$ ${money(vGrav - desc + frete)}).`);
    }
    L.step(key, 'entrada', { ok: true, conferencia: { itens: movs.length, quantidade: qGrav, valor: vGrav } });

    // Só entrada no estoque (compra para estoque): termina aqui, sem OS e sem baixa.
    if (os.modo === 'nenhuma') {
      const reg = L.finish(key, 'concluido', { resultado: { invoiceId, somenteEntrada: true, valor: vEsp } });
      return {
        ok: true, somenteEntrada: true, passos, itens: itensResumo(), registro: reg, invoiceId,
        conferencia: { esperado: vEsp, entrada: vGrav, quantidade: qEsp },
        screenshot: await pageShot(s, `/storage/invoice/products/${invoiceId}/edit`, 'Entrada no Estoque').catch(() => null),
      };
    }

    // 4) OS
    let osId = E().os?.id || (os.modo === 'existente' ? os.id : null);
    let osInfo;
    if (osId) {
      osInfo = await getServiceOrder(s, osId);
      if (osInfo.status !== 'pending') throw Object.assign(new Error(`A OS ${osInfo.numero} está "${osInfo.statusTexto}" — só é possível aplicar peças em OS pendente.`), { etapa: 'OS' });
      L.step(key, 'os', { id: osInfo.id, numero: osInfo.numero, placa: osInfo.placa });
    } else {
      const abertas = await openOrdersForVehicle(s, os.placa || os.vehicleText);
      if (abertas.length && !os.confirmarMesmoVeiculo) {
        L.finish(key, 'erro', { erro: 'OS aberta para o mesmo veículo — aguardando decisão' });
        return {
          ok: false, etapa: 'OS', precisaConfirmar: true, osAbertas: abertas, passos,
          error: `Entrada no estoque concluída. Já existe OS pendente para ${os.placa || os.vehicleText}: ${abertas.map((o) => o.numero).join(', ')}. Escolha uma delas ou confirme a criação de nova OS e clique em lançar novamente (a entrada não será repetida).`,
        };
      }
      ctx(s.page, `NF ${nf.numero} · criando OS`);
      osId = await createServiceOrder(s, {
        ...os, description: os.description || `Peças ${ref}`, comments: `${ref} ${mk}`,
      });
      osInfo = await getServiceOrder(s, osId);
      L.step(key, 'os', { id: osId, numero: osInfo.numero, placa: osInfo.placa, criada: true });
      p('OS', true, `OS ${osInfo.numero} criada.`);
    }

    // 5) Peças na OS (sem duplicar: itens com a marca deste XML já gravados contam como feitos)
    const osOk = new Set(E().os?.itensOk || []);
    const adotadas = new Set(E().os?.adotadas || []); // peças lançadas à mão reconhecidas como desta NF
    const jaNaOs = osInfo.pecas.filter((x) => x.comentario.includes(mk));
    for (const it of itens) {
      if (osOk.has(it.nItem)) continue;
      const pid = String(produtos[it.nItem].id);
      if (jaNaOs.some((x) => String(x.produtoId) === pid && Math.abs(x.quantidade - it.quantidade) < 0.001)) {
        osOk.add(it.nItem);
        continue;
      }
      // Peça igual lançada à mão (sem a marca): decide sozinho se é a MESMA aplicação desta NF.
      // É a mesma quando bate peça + quantidade E (mesmo valor unitário da NF OU o comentário cita o nº da NF).
      // Pedido normalmente não repete a mesma peça, então com isso é seguro considerar já lançada; senão é outra aplicação e inclui.
      const reNf = new RegExp(`\\b0*${nf.numero}\\b`);
      const manual = osInfo.pecas.find((x) => !x.comentario.includes(mk) && !adotadas.has(x.id) && String(x.produtoId) === pid &&
        Math.abs(x.quantidade - it.quantidade) < 0.001 && (Math.abs(x.valorUnitario - Number(it.valorUnitario)) < 0.01 || reNf.test(x.comentario)));
      if (manual) {
        adotadas.add(manual.id);
        osOk.add(it.nItem);
        L.step(key, 'os', { itensOk: [...osOk], adotadas: [...adotadas] });
        p(`OS item ${it.nItem}`, true, `${manual.nome} (qtd ${manual.quantidade}, R$ ${money(manual.valorUnitario)}) já estava na OS ${osInfo.numero} lançada à mão — considerada a mesma, não lancei de novo.`);
        continue;
      }
      ctx(s.page, `NF ${nf.numero} · OS ${osInfo.numero} · peça ${it.nItem} (${it.cProd})`);
      await addPartToOrder(s, osId, {
        productId: produtos[it.nItem].id, productText: produtos[it.nItem].text, quantidade: it.quantidade, valorUnitario: it.valorUnitario,
        comments: [payload.comentarioOs, ref, mk].filter(Boolean).join(' | '),
      });
      osOk.add(it.nItem);
      L.step(key, 'os', { itensOk: [...osOk] });
    }
    osInfo = await getServiceOrder(s, osId);
    const naOs = osInfo.pecas.filter((x) => x.comentario.includes(mk) || adotadas.has(x.id));
    const vOs = naOs.reduce((a, x) => a + x.valorTotal, 0);
    const osConfere = naOs.length >= itens.length && Math.abs(vOs - vEsp) < 0.05;
    if (!osConfere) throw Object.assign(new Error(`Peças na OS ${osInfo.numero} não conferem: esperado ${itens.length}/R$ ${money(vEsp)}; na OS ${naOs.length}/R$ ${money(vOs)}.`), { etapa: 'Aplicação na OS' });
    L.step(key, 'os', { ok: true });
    p('Aplicação na OS', true, `${naOs.length} peça(s) na OS ${osInfo.numero}, R$ ${money(vOs)}.`);

    // 6) Baixa no estoque (Saída de Peças)
    let wId = E().baixa?.withdrawalId;
    if (!wId) {
      ctx(s.page, `NF ${nf.numero} · baixa · cabeçalho`);
      wId = await createWithdrawal(s, {
        filial, employeeId: baixa.employeeId, employeeText: baixa.employeeText, date: payload.baixaDate || payload.date, time: payload.baixaTime || payload.time,
        comments: `OS ${osInfo.numero} - ${osInfo.placa || ''} - ${ref} ${mk}`,
      });
      L.step(key, 'baixa', { withdrawalId: wId, itensOk: [] });
    }
    const bOk = new Set(E().baixa?.itensOk || []);
    // confere o que JÁ está na saída (o histórico pode ter ficado para trás se o processo caiu no meio)
    const naBaixa = await withdrawalMovements(s, wId).catch(() => []);
    for (const it of itens) {
      if (bOk.has(it.nItem)) {
        const i = naBaixa.findIndex((m) => norm(m.codigo) === norm(String(produtos[it.nItem].text || '').split(' - ')[0]) && Math.abs(m.quantidade - Number(it.quantidade)) < 0.001);
        if (i >= 0) naBaixa.splice(i, 1);
        continue;
      }
      const cod = norm(it.acao === 'cadastrar' ? it.novo.code : String(produtos[it.nItem].text || '').split(' - ')[0]);
      const j = naBaixa.findIndex((m) => norm(m.codigo) === cod && Math.abs(m.quantidade - Number(it.quantidade)) < 0.001);
      if (j >= 0) {
        naBaixa.splice(j, 1);
        bOk.add(it.nItem);
        L.step(key, 'baixa', { itensOk: [...bOk] });
        continue;
      }
      ctx(s.page, `NF ${nf.numero} · baixa · item ${it.nItem} (${it.cProd})`);
      await addWithdrawalItem(s, wId, { productId: produtos[it.nItem].id, productText: produtos[it.nItem].text, quantidade: it.quantidade, warehouseId: almoxarifado.id, warehouseText: almoxarifado.nome });
      bOk.add(it.nItem);
      L.step(key, 'baixa', { itensOk: [...bOk] });
    }
    const wm = await withdrawalMovements(s, wId);
    const qBaixa = wm.reduce((a, m) => a + m.quantidade, 0);
    const baixaConfere = wm.length >= itens.length && Math.abs(qBaixa - qEsp) < 0.001;
    if (!baixaConfere) throw Object.assign(new Error(`Baixa não confere: esperado ${itens.length} itens/${qEsp} un; no ESL ${wm.length}/${qBaixa}.`), { etapa: 'Baixa no estoque' });
    L.step(key, 'baixa', { ok: true });
    p('Baixa no estoque', true, `Saída de peças id ${wId}: ${wm.length} item(ns), ${qBaixa} un.`);

    const reg = L.finish(key, 'concluido', { resultado: { invoiceId, osId, osNumero: osInfo.numero, withdrawalId: wId, valor: vEsp } });
    return {
      ok: true, passos, itens: itensResumo(), registro: reg, osId, osNumero: osInfo.numero, invoiceId, withdrawalId: wId,
      conferencia: { esperado: vEsp, entrada: vGrav, os: vOs, quantidade: qEsp, baixa: qBaixa },
      screenshot: await pageShot(s, `/fleet/service_orders/${osId}/edit`, 'Produtos e Peças').catch(() => null),
    };
  } catch (e) {
    L.log(key, `Erro${e.etapa ? ' em ' + e.etapa : ''}: ${e.message}`);
    L.finish(key, 'erro', { erro: e.message });
    p(e.etapa || 'Execução', false, e.message);
    return { ok: false, etapa: e.etapa || 'execução', error: e.message, passos, itens: itensResumo(), invoiceId: E().entrada?.invoiceId, screenshot: e.screenshot, retomavel: true, precisaConfirmarPeca: e.precisaConfirmarPeca };
  }
  } finally {
    L.unlock(key);
  }
}
