// Consultas JSON ao ESL (GET com os cookies da sessão). Endpoints confirmados nas telas reais em 25/11/2026.
import { apiGet, withPage, goto } from './esl.js';

const enc = encodeURIComponent;
const onlyDigits = (s) => String(s || '').replace(/\D/g, '');
const qs = (o) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${enc(k)}=${enc(v)}`)
    .join('&');
const arr = (r) => (Array.isArray(r) ? r : r?.data || []);

/* ----------------------------- pessoas ----------------------------- */

export async function findPersonByDocument(s, doc) {
  const d = onlyDigits(doc);
  if (!d) return null;
  const list = await apiGet(s, `/people?term=${enc(d)}`);
  const hit = list.find((p) => onlyDigits(p.cnpj || p.cpf || p.formatted_document) === d);
  return hit ? { id: hit.id, nome: hit.nickname || hit.name, razao: hit.name, documento: hit.formatted_document } : null;
}

export async function searchPeople(s, term) {
  const list = await apiGet(s, `/people?term=${enc(term)}`);
  return list.slice(0, 20).map((p) => ({ id: p.id, nome: p.nickname || p.name, razao: p.name, documento: p.formatted_document }));
}

export async function searchEmployees(s, term) {
  const list = await apiGet(s, `/employees?term=${enc(term)}`);
  return list.filter((e) => e.active !== false).slice(0, 20).map((e) => ({ id: e.id, nome: e.name, filial: e.corporation_nickname }));
}

/* ----------------------------- frota ------------------------------- */

export async function searchVehicles(s, term) {
  const list = await apiGet(s, `/vehicles?term=${enc(term)}&search%5Bonly_actives%5D=true&search%5Bfleet_managed%5D=true`);
  return list.slice(0, 20).map((v) => ({ id: v.id, placa: v.license_plate, modelo: v.model, hodometro: v.odometer, frota: v.fleet_number }));
}

export async function searchSetItems(s, term) {
  const list = await apiGet(s, `/fleet/sets/items/all?term=${enc(term || '')}`);
  return list.slice(0, 30).map((i) => ({ id: i.id, nome: i.name_with_set || i.name }));
}

const OS_STATUS = { pending: 'Pendente', finished: 'Finalizado', delivered: 'Entregue' };

function mapOs(o) {
  return {
    id: o.id, numero: o.sequence_code, status: o.status, statusTexto: OS_STATUS[o.status] || o.status,
    placa: o.vehicle_license_plate || o.vehicle?.license_plate, data: o.service_at_date, oficina: o.workshop_type,
    filial: o.corporation_nickname || o.corporation?.nickname, tipo: o.maintenance_type, hodometro: o.current_odometer,
  };
}

/**
 * Busca OS no ESL. term = nº da OS ou placa. status: pending (padrão = abertas) | finished | delivered | all
 */
export async function searchServiceOrders(s, { term = '', status = 'pending' } = {}) {
  const base = { per: 30 };
  if (status && status !== 'all') base['search[fleet_service_orders][status]'] = status;
  const t = String(term).trim().toUpperCase();
  let list = [];
  if (/^\d{1,7}$/.test(t)) {
    list = arr(await apiGet(s, `/fleet/service_orders.json?${qs({ ...base, 'search[fleet_service_orders][sequence_code]': t })}`));
  } else if (t.length >= 3) {
    const veics = await searchVehicles(s, t);
    for (const v of veics.slice(0, 5)) {
      list.push(...arr(await apiGet(s, `/fleet/service_orders.json?${qs({ ...base, 'search[fleet_service_orders][vehicle_id]': v.id })}`)));
    }
  } else {
    list = arr(await apiGet(s, `/fleet/service_orders.json?${qs(base)}`));
  }
  return list.map(mapOs);
}

/** OS completa: cabeçalho + serviços + peças já lançados. */
export async function getServiceOrder(s, id) {
  const o = await apiGet(s, `/fleet/service_orders/${id}.json`);
  const [serv, parts] = await Promise.all([
    apiGet(s, `/fleet/service_orders/${id}/services?page=1&per=200`).catch(() => ({ data: [] })),
    apiGet(s, `/fleet/service_orders/${id}/parts?page=1&per=200`).catch(() => ({ data: [] })),
  ]);
  return {
    ...mapOs({ ...o, vehicle_license_plate: o.vehicle?.license_plate, corporation_nickname: o.corporation?.nickname }),
    workshopType: o.workshop_type,
    oficinaId: o.fleet_service_order_workshop?.person_id ?? null,
    oficinaNome: o.fleet_service_order_workshop?.person?.nickname ?? o.fleet_service_order_workshop?.person?.name ?? null,
    descricao: o.service_description,
    vehicleId: o.vehicle_id,
    corporationId: o.corporation_id,
    podeEditar: o.can_edit !== false,
    totalServicos: Number(o.total_labor_value || 0),
    totalPecas: Number(o.total_parts_value || 0),
    servicos: arr(serv).map((x) => ({
      id: x.id, item: x.set_item_name_with_set || x.fleet_set_item?.name_with_set, status: x.status,
      valor: Number(x.labor_value || 0), comentario: x.comments || '', produtoId: x.purchase_product_id ?? null,
    })),
    pecas: arr(parts).map((x) => ({
      id: x.id, produtoId: x.purchase_product_id, codigo: x.purchase_product_code, nome: x.purchase_part_name || x.purchase_product?.name,
      quantidade: Number(x.quantity || 0), valorUnitario: Number(x.unitary_value || 0), valorTotal: Number(x.total_value || 0), comentario: x.comments || '',
    })),
  };
}

/* ----------------------------- compras ----------------------------- */

const PRODUCT_TYPES = { part: 'Purchase::Product::Part', service: 'Purchase::Product::Service' };

export async function searchProducts(s, term, kind) {
  if (!term || String(term).trim().length < 2) return [];
  const list = await apiGet(s, `/purchase/products?term=${enc(term)}`);
  return list
    .filter((p) => !kind || !p.type || p.type === PRODUCT_TYPES[kind])
    .slice(0, 25)
    .map((p) => ({
      id: p.id, codigo: p.code, nome: p.name, tipo: p.type_formatted, unidade: p.measurement_unit_name, grupo: p.purchase_group_name || p.group_name,
      ultimoValor: p.last_unitary_value ? Number(p.last_unitary_value) : null, text: p.label_name || `${p.code} - ${p.name}`,
    }));
}

export async function searchWarehouses(s, term = '') {
  const list = await apiGet(s, `/purchase/warehouses?term=${enc(term)}`);
  return list.map((w) => ({ id: w.id, nome: w.name, tipo: w.warehouse_type, saldo: w.current_amount_in_warehouse }));
}

export async function searchGroups(s, term = '') {
  const list = await apiGet(s, `/purchase/groups?term=${enc(term)}`);
  return list.map((g) => ({ id: g.id, nome: g.name, tipo: g.group_type }));
}

let unitsCache = null;
export async function listUnits(s) {
  if (unitsCache) return unitsCache;
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const l = arr(await apiGet(s, `/purchase/measurement_units.json?page=${page}&per=100`));
    out.push(...l);
    if (l.length < 12) break;
  }
  unitsCache = [...new Map(out.map((u) => [u.id, { id: u.id, nome: u.name, codigo: u.code, xml: u.xml_units || [] }])).values()];
  return unitsCache;
}

export async function matchUnit(s, uCom) {
  const norm = (x) => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
  const u = norm(uCom);
  const units = await listUnits(s);
  return (
    units.find((x) => (x.xml || []).map(norm).includes(u)) ||
    units.find((x) => norm(x.nome) === u || norm(x.codigo) === u) ||
    units.find((x) => ({ UN: ['PC', 'UND', 'UNID', 'UNIDADE'], PC: ['UN', 'PECA', 'PCA'] })[norm(x.nome)]?.includes(u)) ||
    null
  );
}

/** Opções estáticas de <select> de um formulário do ESL (ex.: filiais). Cache por sessão. */
export async function formOptions(s, route, name) {
  s.optCache ||= {};
  const key = `${route}|${name}`;
  if (s.optCache[key]) return s.optCache[key];
  const opts = await withPage(s, async (page) => {
    await goto(page, route);
    return page.evaluate((name) => {
      const el = document.querySelector(`select[name="${name}"]`);
      return el ? [...el.options].filter((o) => o.value).map((o) => ({ id: o.value, nome: o.text.trim() })) : [];
    }, name);
  });
  s.optCache[key] = opts;
  return opts;
}

export const listFiliais = (s) => formOptions(s, '/fleet/service_orders', 'search[fleet_service_orders][corporation_id][]');

/* ------------------------ notas já lançadas ------------------------ */

/** Nota da SEFAZ em Compras › Notas de Compra (pela chave de 44 dígitos). */
export async function findPurchaseInvoice(s, chave) {
  if (!chave || String(chave).length !== 44) return null;
  const list = await apiGet(s, `/purchase/invoices?term=${enc(chave)}`).catch(() => []);
  const n = list.find((x) => x.key === chave);
  return n ? { id: n.id, numero: n.number, serie: n.series, status: n.status, statusTexto: n.status_formatted, valor: Number(n.value) } : null;
}

/**
 * Notas Fiscais de Entrada já lançadas (inclusive manualmente por outros operadores).
 * tipo: 'products' (peças/produtos) | 'services'
 */
export async function findStorageInvoices(s, tipo, { numero, issuerId }) {
  if (!numero) return [];
  const q = qs({ 'search[storage_invoices][number]': numero, 'search[storage_invoices][issuer_id]': issuerId, per: 50 });
  const list = arr(await apiGet(s, `/storage/invoice/${tipo}.json?${q}`).catch(() => []));
  const n = String(numero).replace(/^0+/, '');
  return list
    .filter((x) => String(x.number || '').replace(/^0+/, '') === n)
    .map((x) => ({
      id: x.id, numero: x.number, serie: x.series, fornecedor: x.issuer_nickname, filial: x.recipient_nickname,
      tipo: x.invoice_type_formatted, data: x.emission_at, total: Number(x.total || 0), purchaseInvoiceId: x.purchase_invoice_id,
      url: `/storage/invoice/${tipo}/${x.id}/edit`,
    }));
}

export async function storageInvoiceMovements(s, id) {
  const r = await apiGet(s, `/storage/invoices/${id}/movements?page=1&per=200`);
  return arr(r).map((m) => ({ id: m.id, codigo: m.purchase_product_code, nome: m.purchase_product_name, quantidade: Number(m.amount), valorUnitario: Number(m.unitary_value), total: Number(m.total_value), local: m.locale }));
}

export async function withdrawalMovements(s, id) {
  const r = await apiGet(s, `/purchase/storage/withdrawals/${id}/movements?page=1&per=200`);
  return arr(r).map((m) => ({ id: m.id, codigo: m.purchase_product_code, nome: m.purchase_product_name, quantidade: Number(m.amount), local: m.locale || m.purchase_warehouse_name }));
}
