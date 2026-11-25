// Módulo Manutenção: XML de NF-e de peças → Ordem de Serviço no ESL (Frota › Serviços › Ordens de Serviço).
//
// Fluxo levantado no ESL (24/11/2026):
//  - A NF chega da SEFAZ em Compras › Integrações › Notas de Compra (/purchase/invoices).
//  - A manutenção abre uma OS (/fleet/service_orders/new, "Oficina Terceirizada"), com veículo, hodômetro,
//    tipo (Corretiva...), oficina (= fornecedor), recepção, e lança as peças na aba "Produtos e Peças"
//    (modal #workshop_part_modal: produto do catálogo, quantidade, valor unitário).
//  - O XML NÃO traz a placa: ela tem de ser informada por quem lança.
//
// Endpoints JSON do ESL usados (GET com cookies da sessão):
//  /people?term=<CNPJ>                       → fornecedor/oficina (campo cnpj)
//  /vehicles?term=<placa>&search[only_actives]=true&search[fleet_managed]=true → veículo (odometer atual)
//  /purchase/products?term=<código|texto>    → peça/produto do catálogo
//  /purchase/invoices?term=<chave>           → nota já importada da SEFAZ (id)
//  /fleet/service_orders/:id.json            → conferência da OS gravada
import fs from 'node:fs';
import path from 'node:path';
import { apiGet, withPage, goto } from './esl.js';
import { parseNfe, splitEmissao } from './nfe.js';
import { clickAndConfirm } from './ui.js';

const DATA_DIR = path.resolve('data');
const MAP_FILE = path.join(DATA_DIR, 'mapeamento-pecas.json'); // `${cnpj}|${cProd}` -> { id, text }
const LEDGER_FILE = path.join(DATA_DIR, 'lancamentos.json'); // chave -> { osId, osNumero, ... }
fs.mkdirSync(DATA_DIR, { recursive: true });

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return {};
  }
};
const writeJson = (f, obj) => fs.writeFileSync(f, JSON.stringify(obj, null, 2));

const enc = encodeURIComponent;
const onlyDigits = (s) => String(s || '').replace(/\D/g, '');
const brNum = (n, dec = 2) => Number(n).toLocaleString('pt-BR', { minimumFractionDigits: dec, maximumFractionDigits: dec, useGrouping: false });

/* ------------------------------------------------------------------ */
/* Consultas                                                          */
/* ------------------------------------------------------------------ */

export async function findSupplier(s, cnpj) {
  const list = await apiGet(s, `/people?term=${enc(cnpj)}`);
  const hit = list.find((p) => onlyDigits(p.cnpj) === onlyDigits(cnpj));
  return hit ? { id: hit.id, nome: hit.name, documento: hit.formatted_document } : null;
}

export async function searchVehicles(s, term) {
  const list = await apiGet(s, `/vehicles?term=${enc(term)}&search%5Bonly_actives%5D=true&search%5Bfleet_managed%5D=true`);
  return list.slice(0, 20).map((v) => ({ id: v.id, placa: v.license_plate, modelo: v.model, hodometro: v.odometer, frota: v.fleet_number }));
}

export async function searchProducts(s, term) {
  if (!term || String(term).trim().length < 2) return [];
  const list = await apiGet(s, `/purchase/products?term=${enc(term)}`);
  return list.slice(0, 25).map((p) => ({
    id: p.id, codigo: p.code, nome: p.name, tipo: p.type_formatted, unidade: p.measurement_unit_name,
    ultimoValor: p.last_unitary_value ? Number(p.last_unitary_value) : null, text: p.label_name || `${p.code} - ${p.name}`,
  }));
}

export async function searchPeople(s, term) {
  const list = await apiGet(s, `/people?term=${enc(term)}`);
  return list.slice(0, 20).map((p) => ({ id: p.id, nome: p.name, documento: p.formatted_document }));
}

async function findPurchaseInvoice(s, chave) {
  try {
    const list = await apiGet(s, `/purchase/invoices?term=${enc(chave)}`);
    return list[0]?.id ?? null;
  } catch {
    return null;
  }
}

/** Sugestões de peça para um item do XML, da mais provável para a menos. */
async function suggestProducts(s, cnpj, item) {
  const learned = readJson(MAP_FILE)[`${cnpj}|${item.cProd}`];
  const terms = [...new Set([item.cProd, item.cProdBase, item.oem, item.nomeLimpo.split(/\s+/).slice(0, 3).join(' ')].filter(Boolean))];
  const seen = new Map();
  for (const t of terms) {
    for (const p of await searchProducts(s, t).catch(() => [])) {
      if (seen.has(p.id)) continue;
      const code = onlyDigits(p.codigo) || p.codigo;
      let score = 1;
      if (p.codigo === item.cProd || p.codigo === item.cProdBase) score = 90;
      else if (item.oem && (p.codigo || '').replace(/[^A-Z0-9]/gi, '').endsWith(item.oem)) score = 80;
      else if (t === item.oem || t === item.cProdBase) score = 50;
      else if (code && item.descricao.includes(code)) score = 40;
      seen.set(p.id, { ...p, score, via: t });
    }
  }
  const sugestoes = [...seen.values()].sort((a, b) => b.score - a.score).slice(0, 8);
  return { aprendido: learned || null, sugestoes };
}

/**
 * Lê os XMLs e devolve uma prévia pronta para conferência:
 * fornecedor no ESL, nota da SEFAZ no ESL, sugestões de peça por item, se já foi lançada, placa sugerida.
 */
export async function previewXmls(s, files) {
  const ledger = readJson(LEDGER_FILE);
  const out = [];
  for (const f of files) {
    try {
      const nf = parseNfe(f.content);
      const fornecedor = await findSupplier(s, nf.emitente.cnpj);
      const notaCompraId = await findPurchaseInvoice(s, nf.chave);
      const items = [];
      for (const it of nf.items) items.push({ ...it, ...(await suggestProducts(s, nf.emitente.cnpj, it)) });
      let veiculoSugerido = null;
      if (nf.placaNoTexto) veiculoSugerido = (await searchVehicles(s, nf.placaNoTexto))[0] || null;
      out.push({
        arquivo: f.name, ok: true, nf: { ...nf, items: undefined }, items,
        fornecedor, notaCompraId, veiculoSugerido,
        jaLancada: ledger[nf.chave] || null,
        ...splitEmissao(nf.emissao),
      });
    } catch (e) {
      out.push({ arquivo: f.name, ok: false, error: e.message });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Lançamento da OS                                                   */
/* ------------------------------------------------------------------ */

// Seleciona um valor num select2 do ESL pelo id exato (sem "digitar e escolher o 1º").
async function setSelect2(page, name, id, text) {
  const ok = await page.evaluate(
    ({ name, id, text }) => {
      const $ = window.jQuery;
      const el = $(`[name="${name}"]`);
      if (!el.length) return false;
      if (!el.find(`option[value="${id}"]`).length) el.append(new Option(text, id, true, true));
      el.val(String(id)).trigger('change').trigger({ type: 'select2:select', params: { data: { id, text } } });
      return true;
    },
    { name, id: String(id), text: String(text || id) }
  );
  if (!ok) throw new Error(`Campo não encontrado: ${name}`);
}

async function setText(page, name, value) {
  const sel = `[name="${name}"]`;
  await page.waitForSelector(sel, { state: 'attached', timeout: 10_000 });
  await page.fill(sel, String(value ?? ''));
  await page.$eval(sel, (e) => {
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
    e.dispatchEvent(new Event('blur', { bubbles: true }));
  });
}

async function formErrors(page) {
  return page.$$eval('.has-error .help-block, .field_with_errors, .invalid-feedback, .alert-danger, .toast-error',
    (els) => [...new Set(els.map((e) => e.innerText.trim()).filter(Boolean))].slice(0, 20));
}

const WS = 'fleet_service_order[fleet_service_order_workshop_attributes]';

/**
 * payload = {
 *   chave, numero, fornecedorNome,
 *   os: { vehicleId, vehicleText, odometer, maintenanceType, date, time, oficinaId, oficinaText,
 *         receptionResponsible, description, comments },
 *   items: [ { cProd, productId, productText, quantidade, valorUnitario } ],
 *   commit: boolean, cnpj
 * }
 */
export async function lancarOS(s, payload) {
  const { os, items = [], commit = false } = payload;
  const missing = [];
  if (!os?.vehicleId) missing.push('veículo');
  if (!os?.oficinaId) missing.push('oficina');
  if (!os?.date) missing.push('data');
  if (!os?.receptionResponsible) missing.push('responsável pela recepção');
  items.forEach((it, i) => !it.productId && missing.push(`peça do item ${i + 1} (${it.cProd})`));
  if (missing.length) return { committed: false, error: `Faltam: ${missing.join(', ')}` };

  const ledger = readJson(LEDGER_FILE);
  if (commit && ledger[payload.chave]) {
    return { committed: false, error: `NF já lançada na OS ${ledger[payload.chave].osNumero} em ${ledger[payload.chave].em}.` };
  }

  return withPage(s, async (page) => {
    await goto(page, '/fleet/service_orders/new?workshop_type=outsourced'); // sem o parâmetro o ESL abre Oficina Própria
    await page.waitForFunction(() => window.jQuery && window.jQuery.fn.select2, null, { timeout: 15_000 });

    // Cabeçalho
    await setText(page, 'fleet_service_order[service_at_date]', os.date);
    await setText(page, 'fleet_service_order[service_at_time]', os.time || '08:00');
    await setSelect2(page, 'fleet_service_order[vehicle_id]', os.vehicleId, os.vehicleText);
    await page.waitForTimeout(1200); // o ESL preenche o hodômetro ao escolher o veículo
    if (os.odometer) await setText(page, 'fleet_service_order[current_odometer]', os.odometer);
    await page.selectOption('[name="fleet_service_order[maintenance_type]"]', os.maintenanceType || 'corrective');
    await page.evaluate(() => window.jQuery('[name="fleet_service_order[maintenance_type]"]').trigger('change'));
    if (os.description) await setText(page, 'fleet_service_order[service_description]', os.description);

    // Aba Oficina
    await setSelect2(page, `${WS}[person_id]`, os.oficinaId, os.oficinaText);
    await setText(page, `${WS}[reception_responsible]`, os.receptionResponsible);
    await setText(page, `${WS}[reception_at_date]`, os.date);
    await setText(page, `${WS}[reception_at_time]`, os.time || '08:00');
    if (os.comments) await setText(page, `${WS}[comments]`, os.comments);

    const previewShot = (await page.screenshot({ fullPage: true, type: 'jpeg', quality: 60 })).toString('base64');
    if (!commit) {
      return {
        committed: false,
        dryRun: true,
        message: 'Simulação: cabeçalho da OS preenchido, nada foi salvo. As peças entram depois que a OS for salva.',
        pecasPlanejadas: items.map((i) => ({ produto: i.productText, quantidade: i.quantidade, valorUnitario: i.valorUnitario })),
        screenshot: previewShot,
      };
    }

    // 1) Salva a OS
    const before = page.url();
    const marked = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button, input[type=submit], a.btn')].find(
        (e) => /Salvar/.test(e.innerText || e.value || '') && !e.closest('.modal') && e.offsetWidth > 0
      );
      if (b) b.setAttribute('data-esl-save', '1');
      return !!b;
    });
    if (!marked) return { committed: false, error: 'Botão Salvar da OS não encontrado.' };
    const nav = page.waitForURL(/\/fleet\/service_orders\/\d+\/edit/, { timeout: 20_000 }).catch(() => {});
    await clickAndConfirm(page, () => page.click('[data-esl-save="1"]'));
    await nav;
    await page.waitForLoadState('networkidle').catch(() => {});
    const m = page.url().match(/\/fleet\/service_orders\/(\d+)/);
    if (!m || page.url() === before) {
      return { committed: false, error: 'OS não foi salva.', formErrors: await formErrors(page),
        screenshot: (await page.screenshot({ fullPage: true, type: 'jpeg', quality: 60 })).toString('base64') };
    }
    const osId = m[1];

    // 2) Lança as peças na aba "Produtos e Peças"
    const pecas = [];
    await page.locator('a:has-text("Produtos e Peças"), li:has-text("Produtos e Peças") a').first().click();
    await page.waitForTimeout(800);
    for (const it of items) {
      try {
        await page.locator('button:has-text("Novo item"), a:has-text("Novo item")').first().click();
        const modal = page.locator('#workshop_part_modal');
        await modal.waitFor({ state: 'visible', timeout: 10_000 });
        await setSelect2(page, 'fleet_service_order_part[purchase_product_id]', it.productId, it.productText);
        await page.waitForTimeout(400);
        await setText(page, 'fleet_service_order_part[quantity]', brNum(it.quantidade, 3));
        await setText(page, 'fleet_service_order_part[unitary_value]', brNum(it.valorUnitario, 2));
        if (it.comments) await setText(page, 'fleet_service_order_part[comments]', it.comments);
        await clickAndConfirm(page, () => modal.locator('button:visible').filter({ hasText: /^\s*Salvar\s*$/ }).first().click());
        await modal.waitFor({ state: 'hidden', timeout: 15_000 });
        await page.waitForTimeout(600);
        pecas.push({ cProd: it.cProd, ok: true });
      } catch (e) {
        pecas.push({ cProd: it.cProd, ok: false, error: e.message, formErrors: await formErrors(page) });
        await page.keyboard.press('Escape').catch(() => {});
      }
    }

    // 3) Confere no ESL
    const conf = await apiGet(s, `/fleet/service_orders/${osId}.json`).catch(() => null);
    const esperado = items.reduce((acc, i) => acc + i.quantidade * i.valorUnitario, 0);
    const gravado = conf ? Number(conf.total_parts_value) : null;

    // 4) Guarda histórico e aprendizado do de-para de peças
    const registro = {
      osId, osNumero: conf?.sequence_code ?? null, nf: payload.numero, fornecedor: payload.fornecedorNome,
      em: new Date().toISOString(), totalPecasEsperado: esperado, totalPecasGravado: gravado,
    };
    const led = readJson(LEDGER_FILE);
    led[payload.chave] = registro;
    writeJson(LEDGER_FILE, led);
    const map = readJson(MAP_FILE);
    for (const it of items) map[`${payload.cnpj}|${it.cProd}`] = { id: it.productId, text: it.productText };
    writeJson(MAP_FILE, map);

    return {
      committed: true,
      osId,
      osNumero: registro.osNumero,
      url: page.url(),
      pecas,
      conferencia: { esperado, gravado, bate: gravado !== null && Math.abs(gravado - esperado) < 0.01 },
      screenshot: (await page.screenshot({ fullPage: true, type: 'jpeg', quality: 60 })).toString('base64'),
    };
  });
}

export function historico() {
  return readJson(LEDGER_FILE);
}
