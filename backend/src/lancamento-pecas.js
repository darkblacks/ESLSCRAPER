// Aba "XML de Peças": NF-e de peças → (cadastro das peças novas) → entrada no estoque → aplicação na OS → baixa no estoque.
// Tudo num único processo, com checkpoint por etapa/item (retomada sem repetir o que já foi feito).
import fs from 'node:fs';
import path from 'node:path';
import * as L from './ledger.js';
import { recuperarRestricao, acumularRestricoes } from './hodometro.js';
import { apiGet } from './esl.js';
import { createClassifier } from './classificacao.js';
import { parseNfe, splitEmissao, condicaoPagamentoDe } from './nfe.js';
import {
  findPersonByDocument, findPurchaseInvoice, findStorageInvoices, storageInvoiceMovements, withdrawalMovements,
  searchSetItems, searchGroups, searchProducts, searchVehicles, searchServiceOrders, getServiceOrder, matchUnit, listFiliais,
  getPurchaseOrder, purchaseOrderItems, findStorageInvoiceByOrder, searchWarehouses,
} from './lookups.js';
import { createPart, createStorageInvoice, linkOrderItem, linkOrderItemRapido, createPurchaseOrder, updatePurchaseOrderHeader, addPurchaseOrderItem, createStorageInvoiceFromOrder, setStorageInvoiceComments, addStorageMovement, setStorageInvoiceTotals, deleteStorageMovement, excluirItemEntrada, createWithdrawal, addWithdrawalItem, pageShot, appendStorageInvoiceComment } from './estoque.js';
import { ctx } from './ui.js';
import { registrarImpressao } from './impressao.js';
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

/** Tipo da NF de entrada como o ESL gravou (ex.: "Avulsa", "Pedido") — só leitura. */
export async function tipoEntrada(s, invoiceId) {
  if (!invoiceId) return null;
  const x = await apiGet(s, `/storage/invoice/products/${invoiceId}.json`).catch(() => null);
  return tipoDaEntrada(x);
}

/**
 * Tipo legível da NF de entrada a partir do JSON do ESL. O JSON do detalhe (/storage/invoice/products/:id.json) NÃO traz
 * invoice_type_formatted (só a lista traz): traz invoice_type cru ("order" = Pedido) e os vínculos purchase_order_id /
 * purchase_invoice_id. Sem pedido e sem nota de compra = Avulsa (conferido no ESL em 26/11/2026).
 */
export function tipoDaEntrada(x) {
  if (!x) return null;
  if (x.invoice_type_formatted) return x.invoice_type_formatted;
  const t = String(x.invoice_type || '').toLowerCase();
  if (x.purchase_order_id || t === 'order') return 'Pedido';
  if (x.purchase_invoice_id || /invoice/.test(t)) return 'Nota de Compra';
  if ('purchase_order_id' in x || 'invoice_type' in x) return 'Avulsa';
  return null;
}

/** NFs de entrada do mesmo fornecedor cujo comentário cita o nº/chave da nota (lançadas a partir de pedido, à mão). */
async function storageInvoicesMentioning(s, issuerId, nf) {
  const list = await apiGet(s, `/storage/invoice/products.json?search%5Bstorage_invoices%5D%5Bissuer_id%5D=${issuerId}&per=40`).catch(() => []);
  const arr = Array.isArray(list) ? list : list.data || [];
  const re = new RegExp(`\\bN\\.?\\s*F\\.?(?:-?e)?\\s*[:nº°o.]*\\s*0*${nf.numero}\\b`, 'i');
  const out = [];
  const alvo = arr.slice(0, 25);
  for (let i = 0; i < alvo.length; i += 5) { // 5 por vez: bem mais rápido e sem sobrecarregar o ESL
    const lote = alvo.slice(i, i + 5);
    const dets = await Promise.all(lote.map((x) => apiGet(s, `/storage/invoice/products/${x.id}.json`).catch(() => null)));
    lote.forEach((x, k) => {
      const c = String(dets[k]?.comments || '');
      if (re.test(c) || (nf.chave && c.includes(nf.chave))) {
        out.push({ id: x.id, numero: x.number, tipo: x.invoice_type_formatted, data: x.emission_at, total: Number(x.total || 0), comentario: c, url: `/storage/invoice/products/${x.id}/edit` });
      }
    });
  }
  return out;
}

/**
 * refazer=true: a nota foi lançada por esta plataforma como AVULSA (só entrada, sem OS/baixa) e vai ser refeita como
 * PEDIDO → não bloqueia; a NF avulsa antiga é esvaziada depois que a nova estiver conferida (ver lancarPecas).
 */
export async function checkPartsDuplicate(s, nf, fornecedorId, { refazer = false } = {}) {
  const key = L.docKey({ chave: nf.chave, cnpj: nf.emitente.cnpj, numero: nf.numero, serie: nf.serie, tipo: 'nfe' });
  const reg = L.get(key);
  // NFs de entrada desta plataforma para esta nota (a atual e as anuladas ao refazer como Pedido) não contam como duplicidade
  const own = new Set([reg?.etapas?.entrada?.invoiceId, ...(reg?.anteriores || []).map((a) => a.invoiceId)].filter(Boolean).map(String));
  const out = { docKey: key, bloqueado: false, motivos: [], existentes: [], alertas: [], retomavel: null };
  if (reg && reg.status !== 'concluido' && !reg.etapas?.os?.id) out.hodometroCorrecao = recuperarRestricao(reg);

  // Pode ser refeita como Pedido? (lançada aqui como Avulsa, só entrada no estoque)
  const ent = reg?.etapas?.entrada?.invoiceId;
  if (reg?.status === 'concluido' && ent && !reg.etapas.os && !reg.etapas.baixa) {
    const tipo = await tipoEntrada(s, ent);
    if (tipo && /AVULSA/.test(norm(tipo))) out.refazivel = { invoiceId: ent, tipo };
  }
  // Já lançada como Pedido, mas o pedido de compra ficou sem Condição de Pagamento (versão antiga) → pode ser corrigida
  const pedidoReg = reg?.etapas?.entrada?.pedidoId;
  if (reg?.status === 'concluido' && pedidoReg && !out.refazivel) {
    const cab = await getPurchaseOrder(s, pedidoReg).catch(() => null);
    if (cab && !String(cab.condicaoPagamento || '').trim()) {
      out.corrigivel = { pedidoId: pedidoReg, pedidoNumero: cab.numero, invoiceId: ent || null, comOsOuBaixa: !!(reg.etapas.os || reg.etapas.baixa) };
    }
  }
  if (refazer && out.refazivel) {
    out.refazer = out.refazivel;
    out.alertas.push(`A NF de entrada avulsa id ${ent} desta nota será esvaziada depois que a NF como Pedido estiver conferida.`);
  }

  // "concluída" pelo histórico, mas a NF de entrada no ESL não bate com o XML → libera para a automação corrigir
  let divergente = null;
  if (!out.refazer && reg?.status === 'concluido' && reg.etapas?.entrada?.invoiceId) {
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
  if (out.refazer) {
    // segue: a nota vai ser lançada de novo como Pedido
  } else if (divergente) {
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

  const classificar = createClassifier({ setItems: t => searchSetItems(s,t), groups: t => searchGroups(s,t), services: t => searchProducts(s,t,'service') });
  const itens = [];
  for (const it of nf.items) {
    const m = await matchItem(s, nf.emitente.cnpj, it);
    const unidade = await matchUnit(s, it.unidade).catch(() => null);
    const descricao = it.nomeLimpo || it.descricao;
    const classificacao = m.situacao === 'certo' ? null : {
      set: await classificar(descricao, 'set'),
      group: await classificar(descricao, 'group', [...new Set(m.sugestoes.filter(p => p.score >= 45).map(p => p.grupo).filter(Boolean))].slice(0,1)),
    };
    itens.push({
      ...it, ...m, classificacao,
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
    arquivo: file.name, ok: true, nf: { ...nf, items: undefined }, itens, fornecedor, filial, duplicidade: dup, pagamento: condicaoPagamentoDe(nf),
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
export async function lancarPecas(s, payload, { commit, loteId = null }) {
  const { nf, fornecedor, filial, almoxarifado, itens = [], os, baixa = {} } = payload;
  const faltas = [];
  if (!nf?.numero) faltas.push('número da NF');
  if (!fornecedor?.id) faltas.push('fornecedor cadastrado no ESL');
  if (!filial) faltas.push('filial (destinatário)');
  if (!payload.date) faltas.push('data de emissão');
  // Tipo da NF de entrada no ESL: "Pedido" por padrão; "Avulsa" só se pedido explicitamente.
  const refazer = !!payload.refazerComoPedido; // nota lançada aqui como Avulsa → refazer como Pedido
  const tipoNf = payload.tipoEntrada === 'avulsa' && !refazer ? 'Avulsa' : 'Pedido';
  if (payload.tipoEntrada && !['pedido', 'avulsa'].includes(payload.tipoEntrada)) faltas.push('tipo da NF de entrada (pedido ou avulsa)');
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

  if (payload.corrigirPedido) return corrigirPedidoLancado(s, payload, { commit });

  // 1) Revalida duplicidade do XML
  const nfComItens = { ...nf, items: nf.items || itens.map((i) => ({ quantidade: Number(i.quantidade), valorTotal: Math.round(Number(i.quantidade) * Number(i.valorUnitario) * 100) / 100 })) };
  const dup = await checkPartsDuplicate(s, nfComItens, fornecedor.id, { refazer });
  if (dup.bloqueado) return { ok: false, etapa: 'duplicidade', error: dup.motivos.join(' '), duplicidade: dup };
  const pendentes = () => (L.get(dup.docKey)?.anteriores || []).filter((a) => a.retirada !== 'feita');
  if (refazer && !dup.refazer && !pendentes().length) {
    return { ok: false, etapa: 'duplicidade', error: 'Refazer como Pedido só vale para nota lançada por esta plataforma como Avulsa, só com entrada no estoque (sem OS e sem baixa).' };
  }
  p('Duplicidade do XML', true, dup.retomavel ? 'Processamento anterior incompleto encontrado — retomando.' : 'Nota ainda não lançada no ESL.');

  const key = dup.docKey;
  L.lock(key);
  try {
  L.begin(key, { tipo: 'pecas', numero: nf.numero, serie: nf.serie, chave: nf.chave, fornecedor: fornecedor.nome, cnpj: onlyDigits(nf.emitente.cnpj), valor: nf.valorNota, usuario: s.email });
  L.marcarLote(key, loteId);
  if (dup.refazer) {
    L.arquivarEtapas(key, { invoiceId: dup.refazer.invoiceId, tipo: dup.refazer.tipo, motivo: 'refeita como Pedido', retirada: 'pendente' });
    p('Refazer como Pedido', true, `A NF avulsa id ${dup.refazer.invoiceId} fica intacta até a NF como Pedido estar conferida; depois os itens saem dela.`);
  }
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

    // 3) Entrada no estoque (NF de entrada).
    //    Pedido (padrão): a tela de nova NF NÃO tem campo de tipo; no ESL o tipo "Pedido" só sai criando o Pedido de Compra
    //    e depois a NF "Com Pedido de Compra" (o ESL copia o cabeçalho do pedido; nº da entrada = nº do pedido).
    //    Avulsa: tela /storage/invoice/products/new, como sempre.
    const codigoDe = (pr, it) => (it.acao === 'cadastrar' ? it.novo.code : String(pr.text || '').split(' - ')[0]).trim();
    // padrão (NF, chave, marca de controle) primeiro — nunca é cortado; depois o texto livre do usuário (até 500 caracteres)
    // comentário padrão (como lançam à mão: "PLACA NF: nº"): placa da NF, nº/série, chave e marca de controle — nunca cortado;
    // depois o texto livre do usuário (até 500 caracteres)
    const placaNf = String(os?.placa || nf.placaNoTexto || '').toUpperCase().replace(/[^A-Z0-9]/g, '') || null;
    const comentarioEntrada = [`${placaNf ? `PLACA ${placaNf} ` : ''}NF: ${nf.numero} série ${nf.serie}`, nf.chave && `Chave ${nf.chave}`, mk, limpaTexto(payload.comentarioEntrada), limpaTexto(payload.comentarioNf)]
      .filter(Boolean).join(' | ');
    // condição de pagamento padronizada (A PRAZO | CARTAO CREDITO | A VISTA), nunca em branco
    const pag = payload.condicaoPagamento && ['A PRAZO', 'CARTAO CREDITO', 'A VISTA'].includes(String(payload.condicaoPagamento).toUpperCase())
      ? { condicao: String(payload.condicaoPagamento).toUpperCase(), motivo: 'escolhida na tela' }
      : condicaoPagamentoDe(nf);
    let invoiceId = E().entrada?.invoiceId;
    if (!invoiceId && tipoNf === 'Avulsa') {
      ctx(s.page, `NF ${nf.numero} · entrada avulsa · cabeçalho`);
      invoiceId = await createStorageInvoice(s, {
        issuerId: fornecedor.id, issuerText: fornecedor.nome, filial, number: nf.numero, date: payload.date, time: payload.time, comments: comentarioEntrada,
      });
      L.step(key, 'entrada', { invoiceId, itensOk: [] });
      p('Entrada no estoque', true, `NF de entrada criada (id ${invoiceId}, tipo Avulsa).`);
    } else if (!invoiceId) {
      // 3a) pedido de compra
      let pedidoId = E().entrada?.pedidoId;
      const pedidoNovo = !pedidoId;
      if (!pedidoId) {
        ctx(s.page, `NF ${nf.numero} · pedido de compra · cabeçalho`);
        pedidoId = await createPurchaseOrder(s, {
          filial, providerId: fornecedor.id, providerText: fornecedor.nome, date: payload.date, time: payload.time,
          paymentCondition: pag.condicao, comments: comentarioEntrada,
        });
        L.step(key, 'entrada', { pedidoId });
        p('Pedido de compra', true, `Pedido de compra criado (id ${pedidoId}), condição ${pag.condicao} (${pag.motivo}).`);
      }
      {
        // condição de pagamento é OBRIGATÓRIA: confere no ESL o que gravou (pedido novo ou retomado) e corrige se vazia
        if (!pedidoNovo) p('Pedido de compra', true, `Retomando pedido de compra id ${pedidoId}.`);
        // pedido criado antes (versão antiga ou parada no meio) ou que não gravou: condição / comentário em branco → corrige
        const cab = await getPurchaseOrder(s, pedidoId).catch(() => null);
        const faltaCond = cab && !String(cab.condicaoPagamento || '').trim();
        const faltaCom = cab && !String(cab.comentario || '').includes(mk);
        if (faltaCond || faltaCom) {
          const r = await updatePurchaseOrderHeader(s, pedidoId, {
            paymentCondition: faltaCond ? pag.condicao : null,
            comments: faltaCom ? [comentarioEntrada, String(cab.comentario || '').trim()].filter(Boolean).join(' | ') : null,
          });
          p('Pedido de compra', r.aplicado, r.aplicado
            ? `Corrigido no pedido: ${[faltaCond && `condição ${pag.condicao}`, faltaCom && 'comentário padrão'].filter(Boolean).join(' e ')}.`
            : `Não deu para corrigir o pedido em branco: ${r.motivo}.`);
          if (faltaCond) {
            const conf = await getPurchaseOrder(s, pedidoId).catch(() => null);
            if (!String(conf?.condicaoPagamento || '').trim()) {
              throw Object.assign(new Error(`O pedido ${cab.numero || pedidoId} ficou sem Condição de Pagamento (obrigatória) — preencha "${pag.condicao}" no ESL e lance de novo.`), { etapa: 'Pedido de compra' });
            }
          }
        }
        L.step(key, 'entrada', { pedidoCabOk: true });
      }

      // itens do pedido: concilia com o que já está no ESL (retomada não duplica)
      const casaPedido = (lista, it) => {
        const cod = norm(codigoDe(produtos[it.nItem], it));
        const i = lista.findIndex((x) => norm(x.codigo) === cod && Math.abs(x.quantidade - Number(it.quantidade)) < 0.001);
        return i >= 0 ? lista.splice(i, 1)[0] : null;
      };
      let noPedido = await purchaseOrderItems(s, pedidoId);
      for (const it of itens) {
        if (casaPedido(noPedido, it)) continue;
        ctx(s.page, `NF ${nf.numero} · pedido de compra · item ${it.nItem} (${it.cProd}) ${it.quantidade} × ${money(it.valorUnitario)}`);
        await addPurchaseOrderItem(s, pedidoId, {
          productId: produtos[it.nItem].id, productText: produtos[it.nItem].text, quantidade: it.quantidade, valorUnitario: it.valorUnitario,
        });
      }
      noPedido = await purchaseOrderItems(s, pedidoId);
      const faltamPedido = itens.filter((it) => !casaPedido(noPedido, it));
      if (faltamPedido.length || noPedido.length) {
        throw Object.assign(new Error(`O pedido de compra ${pedidoId} não bate com o XML: ` +
          [faltamPedido.length && `faltam ${faltamPedido.map((it) => `item ${it.nItem} (${it.cProd})`).join(', ')}`,
            noPedido.length && `sobram ${noPedido.map((x) => `${x.codigo} ${x.quantidade}`).join(', ')}`].filter(Boolean).join('; ') + '.'), { etapa: 'Pedido de compra' });
      }
      const pedido = await getPurchaseOrder(s, pedidoId);
      L.step(key, 'entrada', { pedidoId, pedidoNumero: pedido.numero, pedidoOk: true });
      p('Pedido de compra', true, `Pedido ${pedido.numero} com ${itens.length} item(ns), igual ao XML.`);

      // 3b) NF de entrada "Com Pedido de Compra" (se já existir uma ligada a este pedido, usa ela)
      ctx(s.page, `NF ${nf.numero} · entrada com pedido ${pedido.numero}`);
      invoiceId = (await findStorageInvoiceByOrder(s, fornecedor.id, pedidoId))?.id;
      if (!invoiceId) {
        const r = await createStorageInvoiceFromOrder(s, { orderId: pedidoId, orderText: String(pedido.numero) });
        invoiceId = r.id || (await findStorageInvoiceByOrder(s, fornecedor.id, pedidoId))?.id;
        if (!invoiceId) {
          throw Object.assign(new Error(`O ESL não criou a NF de entrada com o pedido ${pedido.numero}${r.erro ? `: ${r.erro}` : '.'}`), { etapa: 'Entrada no estoque' });
        }
      }
      // comentário com NF/chave/marca (a marca é o que autoriza a correção automática a mexer nesta NF)
      await setStorageInvoiceComments(s, invoiceId, comentarioEntrada);
      L.step(key, 'entrada', { invoiceId, itensOk: [] });
      p('Entrada no estoque', true, `NF de entrada com pedido ${pedido.numero} criada (id ${invoiceId}, tipo Pedido).`);
    } else {
      p('Entrada no estoque', true, `Retomando NF de entrada id ${invoiceId}.`);
      // NF criada antes com comentário em branco (ou sem a marca): corrige — a marca é o que identifica a NF desta nota
      const atual = String((await apiGet(s, `/storage/invoice/products/${invoiceId}.json`).catch(() => null))?.comments || '').trim();
      if (!atual.includes(mk)) {
        await setStorageInvoiceComments(s, invoiceId, [comentarioEntrada, atual].filter(Boolean).join(' | '));
        p('Entrada no estoque', true, atual ? 'Comentário padrão (NF/placa/marca) incluído na NF de entrada.' : 'Comentário em branco corrigido (NF/placa/marca).');
      }
    }
    // Confere no ESL o tipo gravado antes de colocar itens (também ao retomar)
    const tipoGravado = await tipoEntrada(s, invoiceId);
    if (tipoGravado && !norm(tipoGravado).includes(norm(tipoNf))) {
      throw Object.assign(new Error(`A NF de entrada id ${invoiceId} está no ESL como "${tipoGravado}", não como "${tipoNf}". Parei antes de lançar os itens: corrija o tipo no ESL (ou exclua a NF) e lance de novo.`), { etapa: 'Entrada no estoque' });
    }
    if (tipoGravado) p('Tipo da NF de entrada', true, `No ESL: ${tipoGravado}.`);

    // NF com pedido: os itens entram pelo vínculo do item do pedido (🔗 › "Deseja vincular este produto?"), como à mão;
    // NF avulsa: pelo "Novo Item" da Entrada no Estoque
    const pedidoDaNf = (await apiGet(s, `/storage/invoice/products/${invoiceId}.json`).catch(() => null))?.purchase_order_id || null;
    const comPedido = !!pedidoDaNf;
    /** NF com pedido: tenta o vínculo rápido (mesma chamada do botão "Sim" do ESL); se não der, faz pela tela. */
    const vincular = async (it) => {
      const cod = norm(codigoDe(produtos[it.nItem], it));
      const doPedido = (await purchaseOrderItems(s, pedidoDaNf)).find((x) => norm(x.codigo) === cod && Math.abs(x.quantidade - Number(it.quantidade)) < 0.001);
      if (doPedido && doPedido.recebido < doPedido.quantidade - 0.0001) {
        const t0 = Date.now();
        const r = await linkOrderItemRapido(s, invoiceId, { orderItemId: doPedido.id, quantidade: it.quantidade, warehouseId: almoxarifado.id });
        if (r.ok || r.talvez) {
          // confere pela API (o ESL pode processar em segundo plano): a Qtde Recebida tem que subir
          for (let t = 0; t < 10; t++) {
            const agora = (await purchaseOrderItems(s, pedidoDaNf)).find((x) => x.id === doPedido.id);
            if (agora && agora.recebido > doPedido.recebido + 0.0001) {
              console.log(`[tempo] ${((Date.now() - t0) / 1000).toFixed(1)}s — vínculo rápido item ${it.nItem} (${it.cProd})`);
              return;
            }
            await new Promise((ok) => setTimeout(ok, 1000));
          }
          // pediu e não confirmou: NÃO tenta de novo pela tela (poderia vincular duas vezes) — a conferência decide
          throw new Error(`Vínculo do item ${it.nItem} enviado ao ESL, mas a Qtde Recebida não mudou em 10 s. Lance de novo para conferir.`);
        }
        console.log(`[tempo] vínculo rápido indisponível (${r.motivo}) — item ${it.nItem} pela tela`);
      }
      return linkOrderItem(s, invoiceId, { codigo: codigoDe(produtos[it.nItem], it), quantidade: it.quantidade, warehouseId: almoxarifado.id, warehouseText: almoxarifado.nome });
    };
    const entrarItem = (it) => comPedido
      ? vincular(it)
      : addStorageMovement(s, invoiceId, {
          productId: produtos[it.nItem].id, productText: produtos[it.nItem].text, quantidade: it.quantidade, valorUnitario: it.valorUnitario,
          icms: it.icms, ipi: it.ipi, warehouseId: almoxarifado.id, warehouseText: almoxarifado.nome,
        });

    // Concilia item a item com o que JÁ está gravado no ESL (retomada não duplica e não confia só no histórico)
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
        await entrarItem(it);
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
        await excluirItemEntrada(s, invoiceId, { id: m.id, codigo: m.codigo, quantidade: m.quantidade, valorUnitario: m.valorUnitario });
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
        await excluirItemEntrada(s, invoiceId, { id: m.id, codigo: m.codigo, quantidade: m.quantidade, valorUnitario: m.valorUnitario });
        const ainda = (await storageInvoiceMovements(s, invoiceId)).some((x) => x.id === m.id);
        if (ainda) throw Object.assign(new Error(`Não consegui remover o item ${m.codigo} (${m.quantidade} × ${money(m.valorUnitario)}) da NF de entrada.`), { etapa: 'Entrada no estoque' });
        p('Entrada', true, `Removido ${m.codigo} ${m.quantidade} × R$ ${money(m.valorUnitario)} (não estava no XML).`);
      }
      // os de valor errado entram de novo, certos
      for (const it of comValorErrado) {
        ctx(s.page, `NF ${nf.numero} · entrada · item ${it.nItem} (${it.cProd}) relançado com valor do XML`);
        await entrarItem(it);
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
      const tot = await setStorageInvoiceTotals(s, invoiceId, { frete, desconto: desc });
      if (tot?.aplicado === false) {
        // NF com pedido: o ESL pode travar frete/desconto. Não interrompe (itens e quantidades estão certos), mas avisa.
        L.step(key, 'entrada', { totaisOk: false, alertaTotais: tot.motivo });
        p('Entrada', false, `Desconto R$ ${money(desc)}${frete ? ` / frete R$ ${money(frete)}` : ''} da NF não aplicado: ${tot.motivo}. Ajuste no ESL se precisar.`);
      } else {
        L.step(key, 'entrada', { totaisOk: true });
        p('Entrada', true, `Cabeçalho ajustado: desconto R$ ${money(desc)}${frete ? `, frete R$ ${money(frete)}` : ''} (total da NF R$ ${money(vGrav - desc + frete)}).`);
      }
    }
    L.step(key, 'entrada', { ok: true, conferencia: { itens: movs.length, quantidade: qGrav, valor: vGrav } });

    // Refeita como Pedido: agora que a NF nova está conferida, tira os itens da NF avulsa antiga
    for (const ant of pendentes()) {
      const old = ant.invoiceId;
      if (String(old) === String(invoiceId)) continue;
      ctx(s.page, `NF ${nf.numero} · retirando itens da NF avulsa ${old}`);
      const tipoOld = await tipoEntrada(s, old);
      if (tipoOld && !/AVULSA/.test(norm(tipoOld))) {
        throw Object.assign(new Error(`A NF de entrada antiga id ${old} não é mais Avulsa (está "${tipoOld}") — não mexo nela. Confira no ESL.`), { etapa: 'Retirada da NF avulsa' });
      }
      const antigos = await storageInvoiceMovements(s, old);
      const codigosDaNota = new Set(movs.map((m) => norm(m.codigo)));
      const estranhos = antigos.filter((m) => !codigosDaNota.has(norm(m.codigo)));
      if (estranhos.length) {
        throw Object.assign(new Error(`A NF avulsa id ${old} tem itens que não são desta nota (${estranhos.map((m) => m.codigo).join(', ')}) — não removo nada automaticamente. A NF como Pedido id ${invoiceId} já está feita; tire os itens da avulsa à mão.`), { etapa: 'Retirada da NF avulsa' });
      }
      for (const m of antigos) {
        await excluirItemEntrada(s, old, { id: m.id, codigo: m.codigo, quantidade: m.quantidade, valorUnitario: m.valorUnitario });
      }
      const sobrou = await storageInvoiceMovements(s, old);
      if (sobrou.length) throw Object.assign(new Error(`A NF avulsa id ${old} ainda tem ${sobrou.length} item(ns) depois da retirada. Lance de novo para tentar outra vez.`), { etapa: 'Retirada da NF avulsa' });
      const cabOld = await apiGet(s, `/storage/invoice/products/${old}.json`).catch(() => null);
      if (Number(cabOld?.discount_value || 0) || Number(cabOld?.freight_total || 0)) await setStorageInvoiceTotals(s, old, { frete: 0, desconto: 0 });
      await appendStorageInvoiceComment(s, old, `ANULADA pela automação: itens retirados e lançados na NF de entrada id ${invoiceId} (Pedido) em ${new Date().toLocaleString('pt-BR')}`).catch(() => null);
      L.atualizarAnterior(key, old, { retirada: 'feita', itensRetirados: antigos.length, novaEntrada: invoiceId });
      p('Retirada da NF avulsa', true, `${antigos.length} item(ns) retirados da NF avulsa id ${old}; os itens ficam só na NF id ${invoiceId} (Pedido).`);
    }

    // Só entrada no estoque (compra para estoque): termina aqui, sem OS e sem baixa.
    if (os.modo === 'nenhuma') {
      // PDF do pedido de compra (Ações › Imprimir do ESL), capturado em aba própria — falha vira aviso, não erro
      ctx(s.page, `NF ${nf.numero} · PDF do pedido de compra`);
      const imp = await registrarImpressao(s, key);
      if (imp) p('Impressão do pedido', !!imp.ok, imp.ok ? `PDF do pedido ${imp.pedidoNumero || imp.pedidoId} salvo para impressão.` : `PDF do pedido não capturado: ${imp.erro}. Dá para gerar depois pelo Histórico.`);
      const reg = L.finish(key, 'concluido', { resultado: { invoiceId, somenteEntrada: true, valor: vEsp } });
      return {
        ok: true, somenteEntrada: true, passos, itens: itensResumo(), registro: reg, invoiceId, tipoEntrada: await tipoEntrada(s, invoiceId),
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

    ctx(s.page, `NF ${nf.numero} · PDF do pedido de compra`);
    const imp = await registrarImpressao(s, key);
    if (imp) p('Impressão do pedido', !!imp.ok, imp.ok ? `PDF do pedido ${imp.pedidoNumero || imp.pedidoId} salvo para impressão.` : `PDF do pedido não capturado: ${imp.erro}. Dá para gerar depois pelo Histórico.`);
    const reg = L.finish(key, 'concluido', { resultado: { invoiceId, osId, osNumero: osInfo.numero, withdrawalId: wId, valor: vEsp } });
    return {
      ok: true, passos, itens: itensResumo(), registro: reg, osId, osNumero: osInfo.numero, invoiceId, withdrawalId: wId, tipoEntrada: await tipoEntrada(s, invoiceId),
      conferencia: { esperado: vEsp, entrada: vGrav, os: vOs, quantidade: qEsp, baixa: qBaixa },
      screenshot: await pageShot(s, `/fleet/service_orders/${osId}/edit`, 'Produtos e Peças').catch(() => null),
    };
  } catch (e) {
    L.log(key, `Erro${e.etapa ? ' em ' + e.etapa : ''}: ${e.message}`);
    const anteriorKm = recuperarRestricao(L.get(key));
    if (e.hodometroCorrecao) e.hodometroCorrecao = acumularRestricoes(anteriorKm, e.hodometroCorrecao);
    L.finish(key, 'erro', { erro: e.message, hodometroCorrecao: e.hodometroCorrecao || anteriorKm || null });
    p(e.etapa || 'Execução', false, e.message);
    return { ok: false, etapa: e.etapa || 'execução', error: e.message, passos, itens: itensResumo(), invoiceId: E().entrada?.invoiceId, screenshot: e.screenshot, retomavel: true, precisaConfirmarPeca: e.precisaConfirmarPeca, hodometroCorrecao: e.hodometroCorrecao };
  }
  } finally {
    L.unlock(key);
  }
}

/* ------------------------------------------------------------------ */
/* Corrigir pedido de nota JÁ LANÇADA (condição de pagamento em branco) */
/* ------------------------------------------------------------------ */

/**
 * Nota lançada como Pedido por uma versão que não preenchia a Condição de Pagamento.
 * 1) tenta gravar direto no pedido; 2) se o ESL travou o cabeçalho (itens já recebidos): tira os itens da NF de entrada
 *    (o pedido volta a ficar aberto), grava a condição (e o comentário, se faltar), e vincula os MESMOS itens de novo
 *    (mesmo almoxarifado e quantidade), conferindo no fim. O plano dos itens fica no histórico (etapa "correcao"), então
 *    se parar no meio, ao repetir ele termina de vincular o que faltou. Nota com OS/baixa: não mexe (corrigir à mão).
 */
export async function corrigirPedidoLancado(s, payload, { commit }) {
  const { nf } = payload;
  if (!commit) return { ok: false, error: 'Gravação desativada no backend (ALLOW_COMMIT=false).' };
  const key = L.docKey({ chave: nf.chave, cnpj: nf.emitente?.cnpj, numero: nf.numero, serie: nf.serie, tipo: 'nfe' });
  const reg = L.get(key);
  const passos = [];
  const p = (etapa, ok, msg) => passos.push({ etapa, ok, msg });
  const pedidoId = reg?.etapas?.entrada?.pedidoId;
  const invoiceId = reg?.etapas?.entrada?.invoiceId;
  if (!reg || reg.status !== 'concluido' || !pedidoId) return { ok: false, etapa: 'correção', error: 'Esta nota não está concluída como Pedido nesta plataforma — nada para corrigir.' };
  if (reg.etapas.os || reg.etapas.baixa) return { ok: false, etapa: 'correção', error: 'A nota já foi aplicada em OS/baixa: corrija a Condição de Pagamento do pedido no ESL à mão.' };
  const pag = ['A PRAZO', 'CARTAO CREDITO', 'A VISTA'].includes(String(payload.condicaoPagamento || '').toUpperCase())
    ? { condicao: String(payload.condicaoPagamento).toUpperCase(), motivo: 'escolhida na tela' }
    : condicaoPagamentoDe(nf);
  const mk = L.marker(key);
  const placaNf = String(nf.placaNoTexto || '').toUpperCase().replace(/[^A-Z0-9]/g, '') || null;
  const comentarioPadrao = [`${placaNf ? `PLACA ${placaNf} ` : ''}NF: ${nf.numero} série ${nf.serie}`, nf.chave && `Chave ${nf.chave}`, mk].filter(Boolean).join(' | ');
  L.lock(key);
  {
    try {
      const cab = await getPurchaseOrder(s, pedidoId);
      const condOk = () => getPurchaseOrder(s, pedidoId).then((c) => String(c.condicaoPagamento || '').trim()).catch(() => '');
      const comentarioPedido = String(cab.comentario || '').includes(mk) ? null : [comentarioPadrao, String(cab.comentario || '').trim()].filter(Boolean).join(' | ');
      if (!String(cab.condicaoPagamento || '').trim()) {
        // 1) direto
        ctx(s.page, `NF ${nf.numero} · corrigir pedido ${cab.numero}`);
        const r1 = await updatePurchaseOrderHeader(s, pedidoId, { paymentCondition: pag.condicao, comments: comentarioPedido });
        if (r1.aplicado && (await condOk())) {
          p('Pedido de compra', true, `Condição de pagamento ${pag.condicao} gravada no pedido ${cab.numero} (${pag.motivo}).`);
        } else {
          // 2) cabeçalho travado: tira os itens da NF de entrada, corrige e vincula de novo
          if (!invoiceId) throw new Error('Pedido travado e sem NF de entrada registrada — corrija no ESL à mão.');
          const salvo = reg.etapas.correcao?.plano;
          const movs = await storageInvoiceMovements(s, invoiceId);
          const plano = salvo?.length ? salvo : movs.map((m) => ({ codigo: m.codigo, quantidade: m.quantidade, valorUnitario: m.valorUnitario, local: m.local }));
          if (!plano.length) throw new Error('A NF de entrada não tem itens — nada para refazer.');
          L.step(key, 'correcao', { plano, pedidoId, invoiceId, concluida: false });
          p('Pedido de compra', true, `Pedido ${cab.numero} travado pelo ESL (itens recebidos): tirando ${movs.length} item(ns) da NF de entrada para corrigir.`);
          for (const m of movs) {
            ctx(s.page, `NF ${nf.numero} · corrigir pedido · tira ${m.codigo} da NF de entrada`);
            await excluirItemEntrada(s, invoiceId, { id: m.id, codigo: m.codigo, quantidade: m.quantidade, valorUnitario: m.valorUnitario });
          }
          let erroCab = null;
          try {
            const r2 = await updatePurchaseOrderHeader(s, pedidoId, { paymentCondition: pag.condicao, comments: comentarioPedido });
            if (!r2.aplicado || !(await condOk())) erroCab = r2.motivo || 'o ESL não gravou a condição';
          } catch (e) {
            erroCab = e.message;
          }
          // vincula de novo SEMPRE (mesmo se o cabeçalho falhou) — a NF de entrada não pode ficar vazia
          const almox = new Map();
          const idAlmox = async (nome) => {
            if (!almox.has(nome)) {
              const ws = await searchWarehouses(s, nome).catch(() => []);
              almox.set(nome, ws.find((w) => norm(w.nome) === norm(nome))?.id || payload.almoxarifado?.id || null);
            }
            return almox.get(nome);
          };
          const doPedido = await purchaseOrderItems(s, pedidoId);
          const jaNaNf = await storageInvoiceMovements(s, invoiceId);
          for (const it of plano) {
            const iJa = jaNaNf.findIndex((x) => norm(x.codigo) === norm(it.codigo) && Math.abs(x.quantidade - it.quantidade) < 0.001);
            if (iJa >= 0) { jaNaNf.splice(iJa, 1); continue; } // retomada: este já voltou
            const oi = doPedido.find((x) => norm(x.codigo) === norm(it.codigo) && Math.abs(x.quantidade - it.quantidade) < 0.001 && x.recebido < x.quantidade - 0.0001);
            const whId = await idAlmox(it.local);
            if (!oi || !whId) throw new Error(`Não achei ${!oi ? 'o item ' + it.codigo + ' no pedido' : 'o almoxarifado ' + it.local} para vincular de novo — vincule à mão no ESL (NF de entrada id ${invoiceId}).`);
            ctx(s.page, `NF ${nf.numero} · corrigir pedido · vincula ${it.codigo} de novo`);
            const r = await linkOrderItemRapido(s, invoiceId, { orderItemId: oi.id, quantidade: it.quantidade, warehouseId: whId });
            if (!r.ok && !r.talvez) await linkOrderItem(s, invoiceId, { codigo: it.codigo, quantidade: it.quantidade, warehouseId: whId, warehouseText: it.local });
          }
          // confere: a NF de entrada tem de novo exatamente os itens do plano
          let falta = [];
          for (let t = 0; t < 10; t++) {
            const agora = await storageInvoiceMovements(s, invoiceId);
            falta = plano.filter((it) => {
              const i = agora.findIndex((x) => norm(x.codigo) === norm(it.codigo) && Math.abs(x.quantidade - it.quantidade) < 0.001);
              return i >= 0 ? (agora.splice(i, 1), false) : true;
            });
            if (!falta.length) break;
            await new Promise((ok) => setTimeout(ok, 1000));
          }
          if (falta.length) throw new Error(`Itens que não voltaram para a NF de entrada id ${invoiceId}: ${falta.map((f) => `${f.codigo} ${f.quantidade}`).join(', ')}. Lance a correção de novo para terminar.`);
          L.step(key, 'correcao', { concluida: true });
          p('Entrada no estoque', true, `${plano.length} item(ns) vinculados de novo na NF de entrada id ${invoiceId}, conferidos.`);
          if (erroCab) throw new Error(`Itens de volta na NF, mas a Condição de Pagamento não gravou: ${erroCab}. Preencha "${pag.condicao}" no pedido ${cab.numero} no ESL.`);
          p('Pedido de compra', true, `Condição de pagamento ${pag.condicao} gravada no pedido ${cab.numero} (${pag.motivo}).`);
        }
      } else p('Pedido de compra', true, `O pedido ${cab.numero} já tem condição de pagamento (${cab.condicaoPagamento}).`);
      // comentário da NF de entrada sem a marca → inclui
      if (invoiceId) {
        const atual = String((await apiGet(s, `/storage/invoice/products/${invoiceId}.json`).catch(() => null))?.comments || '').trim();
        if (!atual.includes(mk)) {
          await setStorageInvoiceComments(s, invoiceId, [comentarioPadrao, atual].filter(Boolean).join(' | '));
          p('Entrada no estoque', true, 'Comentário padrão (NF/placa/marca) incluído na NF de entrada.');
        }
      }
      L.step(key, 'entrada', { condicaoPagamento: pag.condicao });
      return { ok: true, passos, invoiceId, corrigido: true, resumo: `Pedido corrigido: ${pag.condicao}` };
    } catch (e) {
      p('Correção', false, e.message);
      return { ok: false, etapa: 'correção', error: e.message, passos };
    } finally {
      L.unlock(key);
    }
  }
}
