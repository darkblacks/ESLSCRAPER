// Estoque e cadastro de peças no ESL (módulo Compras). Telas mapeadas em 25/11/2026:
//  Cadastro de peça:   /purchase/product/parts/new → purchase_product_part[code*, name*, fleet_set_item_id*, purchase_group_id*,
//                      purchase_measurement_unit_id*, use_in_service_order, active, comments,
//                      default_purchase_product_supplier_attributes[person_id, product_code]]
//  Entrada (NF):       /storage/invoice/products/new → storage_invoice_product[issuer_id*, recipient_id*, number*, emission_at_date*,
//                      emission_at_time*, comments]  — salvar antes de incluir itens;
//                      itens: aba "Entrada no Estoque" › "Novo Item" › #movement_modal storage_movement[purchase_product_id*, amount*,
//                      unitary_value, icms_percentage, ipi_percentage, purchase_warehouse_id*]
//  Baixa (Saída):      /purchase/storage/parts_withdrawals/new → purchase_storage_parts_withdrawal[corporation_id*, employee_id,
//                      withdrawn_at_date*, withdrawn_at_time*, comments] — salvar antes de incluir itens;
//                      itens: "Novo Item" › #withdrawal_movement_modal storage_movement[purchase_product_id*, amount*, purchase_warehouse_id*]
import { withPage } from './esl.js';
import { open, setSelect2, setText, selectByLabel, setCheckbox, saveMainForm, openTab, openModal, saveModal, brNum, shot, nowBr, assertValue, capture } from './ui.js';

const withShot = async (page, fn) => {
  try {
    return await fn();
  } catch (e) {
    e.screenshot = e.screenshot || (await shot(page).catch(() => null));
    throw e;
  }
};

/** Cadastra uma peça. p = { code, name, setItemId, setItemText, groupId, groupText, unitId, supplierId, supplierText, supplierCode, comments } */
export async function createPart(s, p) {
  const P = 'purchase_product_part';
  return withPage(s, async (page) =>
    withShot(page, async () => {
      await open(page, '/purchase/product/parts/new');
      await setText(page, `${P}[code]`, p.code);
      await setText(page, `${P}[name]`, p.name);
      await setSelect2(page, `${P}[fleet_set_item_id]`, p.setItemId, p.setItemText);
      await setSelect2(page, `${P}[purchase_group_id]`, p.groupId, p.groupText);
      // unidade é select2 com opções fixas: precisa do evento select2:select para o ESL registrar
      await setSelect2(page, `${P}[purchase_measurement_unit_id]`, p.unitId, p.unitText || p.unitId);
      await assertValue(page, `${P}[purchase_measurement_unit_id]`, p.unitId, 'Unidade de Medida');
      await setCheckbox(page, `${P}[use_in_service_order]`, true);
      await setCheckbox(page, `${P}[active]`, true);
      if (p.comments) await setText(page, `${P}[comments]`, p.comments);
      if (p.supplierId) {
        await setSelect2(page, `${P}[default_purchase_product_supplier_attributes][person_id]`, p.supplierId, p.supplierText);
        if (p.supplierCode) await setText(page, `${P}[default_purchase_product_supplier_attributes][product_code]`, p.supplierCode);
        // com fornecedor padrão o ESL exige a data de homologação
        await setText(page, `${P}[default_purchase_product_supplier_attributes][homologation_date]`, p.homologationDate || nowBr().date);
      }
      return saveMainForm(page, /\/purchase\/product\/parts\/(\d+)\/edit/);
    })
  );
}

/**
 * Campo do tipo da NF de entrada (Avulsa / Pedido) na tela aberta: <select> ou rádios cujo name termina em [invoice_type]
 * (ou que tenham "tipo" no rótulo com opções avulsa/pedido). Só lê a tela.
 */
const TIPO_JS = (I) => {
  const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
  const labelOf = (e) => {
    const l = (e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`)) || e.closest('label');
    return (l?.innerText || e.parentElement?.innerText || e.value || '').trim();
  };
  // "avulsa" identifica o campo (um select de pedidos também teria "pedido" no texto)
  const ehTipo = (txts) => txts.some((t) => /AVULSA/.test(norm(t)));
  const sels = [...document.querySelectorAll(`select[name^="${I}["]`)];
  const sel = sels.find((e) => /\[invoice_type\]$/.test(e.name)) || sels.find((e) => ehTipo([...e.options].map((o) => o.text)));
  if (sel) return { tipo: 'select', name: sel.name, atual: sel.selectedOptions[0]?.text.trim() || '', opcoes: [...sel.options].filter((o) => o.value).map((o) => o.text.trim()) };
  const todos = [...document.querySelectorAll(`input[type=radio][name^="${I}["]`)];
  const nome = (todos.find((e) => /\[invoice_type\]$/.test(e.name)) || todos.find((e) => ehTipo([labelOf(e)])))?.name;
  const radios = nome ? todos.filter((e) => e.name === nome) : [];
  if (radios.length) return { tipo: 'radio', name: radios[0].name, atual: labelOf(radios.find((r) => r.checked) || {}) || '', opcoes: radios.map(labelOf) };
  return null;
};

/** Lê (sem salvar nada) como a tela de nova NF de entrada oferece o tipo: { campo, tipo, atual, opcoes } ou null. */
export async function tiposEntrada(s) {
  return withPage(s, async (page) => {
    await open(page, '/storage/invoice/products/new');
    const t = await page.evaluate(TIPO_JS, 'storage_invoice_product');
    return t ? { campo: t.name, tipo: t.tipo, atual: t.atual, opcoes: t.opcoes } : null;
  });
}

/** Marca o tipo da NF (ex.: "Pedido") ANTES de salvar. Não achou campo/opção → erro, nada é gravado. */
export async function setTipoEntrada(page, I, tipo, { opcional = false } = {}) {
  const r = await page.evaluate(
    ({ I, tipo, js }) => {
      const t = new Function(`return (${js})`)()(I);
      if (!t) return { err: 'campo' };
      const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
      const alvo = norm(tipo);
      if (t.tipo === 'select') {
        const el = document.querySelector(`select[name="${t.name}"]`);
        const opt = [...el.options].find((o) => o.value && norm(o.text) === alvo) || [...el.options].find((o) => o.value && norm(o.text).includes(alvo));
        if (!opt) return { err: 'opcao', opcoes: t.opcoes };
        const $ = window.jQuery;
        if ($) $(el).val(opt.value).trigger('change');
        else el.value = opt.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: opt.text.trim() };
      }
      const radios = [...document.querySelectorAll(`input[type=radio][name="${t.name}"]`)];
      const labelOf = (e) => ((e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`)) || e.closest('label') || e.parentElement)?.innerText?.trim() || e.value;
      const r = radios.find((e) => norm(labelOf(e)) === alvo) || radios.find((e) => norm(labelOf(e)).includes(alvo));
      if (!r) return { err: 'opcao', opcoes: t.opcoes };
      r.click();
      r.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: labelOf(r) };
    },
    { I, tipo, js: TIPO_JS.toString() }
  );
  if (r.err === 'campo' && opcional) return null; // Avulsa sem campo de tipo na tela = comportamento de sempre
  if (r.err === 'campo') throw new Error(`Não achei na tela do ESL o campo do tipo da NF de entrada (avulsa/pedido). Nada foi gravado. Lance como "Avulsa" ou avise para ajustar o scraper.`);
  if (r.err) throw new Error(`A tela do ESL não tem a opção "${tipo}" no tipo da NF de entrada. Opções: ${r.opcoes.join(', ') || 'nenhuma'}. Nada foi gravado.`);
  await page.waitForTimeout(600); // a tela pode mostrar/esconder campos conforme o tipo
  return r.ok;
}

/** Cabeçalho da NF de entrada de produtos/peças. h = { issuerId, issuerText, filial, number, date, time, comments, tipo } */
export async function createStorageInvoice(s, h) {
  const I = 'storage_invoice_product';
  return withPage(s, async (page) =>
    withShot(page, async () => {
      await open(page, '/storage/invoice/products/new');
      if (h.tipo) await setTipoEntrada(page, I, h.tipo, { opcional: h.tipo === 'Avulsa' }); // primeiro: a tela pode mudar conforme o tipo
      await setSelect2(page, `${I}[issuer_id]`, h.issuerId, h.issuerText);
      await selectByLabel(page, `${I}[recipient_id]`, h.filial);
      await setText(page, `${I}[number]`, h.number);
      await setText(page, `${I}[emission_at_date]`, h.date);
      await setText(page, `${I}[emission_at_time]`, h.time || '08:00');
      if (h.comments) await setText(page, `${I}[comments]`, h.comments);
      return saveMainForm(page, /\/storage\/invoice\/products\/(\d+)\/edit/);
    })
  );
}

/** Item de entrada no estoque. m = { productId, productText, quantidade, valorUnitario, icms, ipi, warehouseId, warehouseText } */
export async function addStorageMovement(s, invoiceId, m) {
  return withPage(s, async (page) =>
    withShot(page, async () => {
      await open(page, `/storage/invoice/products/${invoiceId}/edit`);
      await openTab(page, 'Entrada no Estoque');
      await openModal(page, 'Novo Item', 'movement_modal');
      const sc = '#movement_modal';
      const unit = brNum(m.valorUnitario, 5);
      await setSelect2(page, 'storage_movement[purchase_product_id]', m.productId, m.productText, sc);
      await page.waitForTimeout(1500); // o ESL preenche unidade/último valor da peça ao escolher — esperar antes de digitar
      await setSelect2(page, 'storage_movement[purchase_warehouse_id]', m.warehouseId, m.warehouseText, sc);
      await setText(page, 'storage_movement[amount]', brNum(m.quantidade, 3), sc);
      await setText(page, 'storage_movement[unitary_value]', unit, sc);
      if (m.icms) await setText(page, 'storage_movement[icms_percentage]', brNum(m.icms, 2), sc);
      if (m.ipi) await setText(page, 'storage_movement[ipi_percentage]', brNum(m.ipi, 2), sc);
      await page.waitForTimeout(400);
      // confere o que ficou no formulário antes de salvar (o ESL pode sobrescrever o valor com o último preço)
      const lido = await page.$eval(`${sc} [name="storage_movement[unitary_value]"]`, (e) => e.value);
      const toNum = (x) => Number(String(x).replace(/\./g, '').replace(',', '.'));
      if (Math.abs(toNum(lido) - m.valorUnitario) > 0.001) {
        await setText(page, 'storage_movement[unitary_value]', unit, sc);
        await page.waitForTimeout(300);
      }
      await saveModal(page, 'movement_modal');
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {}); // não sair antes de o ESL gravar
    })
  );
}

/** Cabeçalho da Saída de Peças. w = { filial, employeeId, employeeText, date, time, comments } */
export async function createWithdrawal(s, w) {
  const W = 'purchase_storage_parts_withdrawal';
  return withPage(s, async (page) =>
    withShot(page, async () => {
      await open(page, '/purchase/storage/parts_withdrawals/new');
      await selectByLabel(page, `${W}[corporation_id]`, w.filial);
      if (w.employeeId) await setSelect2(page, `${W}[employee_id]`, w.employeeId, w.employeeText);
      await setText(page, `${W}[withdrawn_at_date]`, w.date);
      await setText(page, `${W}[withdrawn_at_time]`, w.time || '08:00');
      if (w.comments) await setText(page, `${W}[comments]`, w.comments);
      return saveMainForm(page, /\/purchase\/storage\/parts_withdrawals\/(\d+)\/edit/);
    })
  );
}

/** Item da saída (baixa). m = { productId, productText, quantidade, warehouseId, warehouseText } */
export async function addWithdrawalItem(s, withdrawalId, m) {
  return withPage(s, async (page) =>
    withShot(page, async () => {
      await open(page, `/purchase/storage/parts_withdrawals/${withdrawalId}/edit`);
      await openModal(page, 'Novo Item', 'withdrawal_movement_modal');
      const sc = '#withdrawal_movement_modal';
      await setSelect2(page, 'storage_movement[purchase_product_id]', m.productId, m.productText, sc);
      await page.waitForTimeout(600);
      await setSelect2(page, 'storage_movement[purchase_warehouse_id]', m.warehouseId, m.warehouseText, sc);
      await page.waitForTimeout(600); // o ESL carrega o estoque atual do almoxarifado
      await setText(page, 'storage_movement[amount]', brNum(m.quantidade, 3), sc);
      await saveModal(page, 'withdrawal_movement_modal');
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    })
  );
}

export async function pageShot(s, route, tab) {
  return withPage(s, async (page) => {
    await open(page, route);
    if (tab) await openTab(page, tab);
    return shot(page);
  });
}

/** Ajusta frete/desconto do cabeçalho da NF de entrada (feito depois dos itens, quando o total dos produtos já existe). */
export async function setStorageInvoiceTotals(s, invoiceId, { frete = 0, desconto = 0 }) {
  const I = 'storage_invoice_product';
  return withPage(s, async (page) =>
    withShot(page, async () => {
      await open(page, `/storage/invoice/products/${invoiceId}/edit`);
      await setText(page, `${I}[freight_total]`, brNum(frete, 2));
      await setText(page, `${I}[discount_value]`, brNum(desconto, 2));
      await page.waitForTimeout(500);
      await saveMainForm(page, /\/storage\/invoice\/products\/(\d+)\/edit/);
    })
  );
}

/**
 * Exclui UM item (movimento) da NF de entrada — usado só para remover o que não está no XML
 * numa NF criada pela própria automação. mov = { codigo, quantidade, valorUnitario }.
 * Procura a linha pela combinação código + qtde + vl. unitário (percorre as páginas da tabela),
 * abre o menu da linha › Excluir e confirma SOMENTE a pergunta "Tem certeza que deseja excluir o item?".
 */
export async function deleteStorageMovement(s, invoiceId, mov) {
  return withPage(s, async (page) =>
    withShot(page, async () => {
      await open(page, `/storage/invoice/products/${invoiceId}/edit`);
      await openTab(page, 'Entrada no Estoque');
      const alvo = { codigo: String(mov.codigo), qtd: brNum(mov.quantidade, 3), unit: brNum(mov.valorUnitario, 5) };
      let achou = false;
      for (let pagina = 0; pagina < 15 && !achou; pagina++) {
        achou = await page.evaluate((a) => {
          document.querySelectorAll('[data-esl-del]').forEach((e) => e.removeAttribute('data-esl-del'));
          const linhas = [...document.querySelectorAll('table tbody tr')].filter((tr) => tr.offsetParent !== null);
          const tr = linhas.find((r) => {
            const c = [...r.querySelectorAll('td')].map((td) => td.innerText.trim().replace(/\./g, '')); // ESL mostra 1.309,07000
            return c[0] === a.codigo && c.includes(a.qtd) && c.includes(a.unit);
          });
          if (!tr) return false;
          const toggle = tr.querySelector('.dropdown-toggle, button[data-toggle="dropdown"], .btn-group button:last-child');
          if (!toggle) return false;
          toggle.setAttribute('data-esl-del', 'toggle');
          return true;
        }, alvo);
        if (achou) break;
        // próxima página da tabela de itens
        const prox = await page.evaluate(() => {
          const pag = [...document.querySelectorAll('.pagination')].find((p) => p.offsetParent !== null);
          const a = pag && [...pag.querySelectorAll('li:not(.disabled) a, li:not(.disabled) button')].find((x) => /›|>|próx/i.test(x.innerText.trim()) && !/»/.test(x.innerText));
          if (!a) return false;
          a.click();
          return true;
        });
        if (!prox) break;
        await page.waitForTimeout(1200);
      }
      if (!achou) throw new Error(`Linha ${alvo.codigo} ${alvo.qtd} × ${alvo.unit} não encontrada na tabela da NF de entrada.`);
      await page.click('[data-esl-del="toggle"]');
      await page.waitForTimeout(400);
      const excluir = page.locator('.dropdown-menu:visible a:has-text("Excluir"), .dropdown-menu:visible button:has-text("Excluir")').first();
      await excluir.waitFor({ state: 'visible', timeout: 5000 });
      await capture(page, `antes de excluir ${alvo.codigo} ${alvo.qtd} × ${alvo.unit}`);
      await excluir.click();
      // confirma apenas a pergunta de exclusão de item
      const t = await page.waitForFunction(() => {
        const S = window.Swal || window.swal;
        return S && S.isVisible() ? S.getPopup().innerText.replace(/\s+/g, ' ').trim() : null;
      }, null, { timeout: 8000 }).then((h) => h.jsonValue());
      if (!/certeza.*excluir o item/i.test(t)) {
        await page.evaluate(() => (window.Swal || window.swal).clickCancel()).catch(() => {});
        throw new Error(`Pergunta inesperada ao excluir (cancelada): "${t}"`);
      }
      await page.evaluate(() => (window.Swal || window.swal).clickConfirm());
      await page.waitForTimeout(1500);
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      await capture(page, `excluído ${alvo.codigo} ${alvo.qtd} × ${alvo.unit}`);
    })
  );
}
