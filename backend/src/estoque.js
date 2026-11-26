// Estoque e cadastro de peças no ESL (módulo Compras). Telas mapeadas em 25/11/2026:
//  Cadastro de peça:   /purchase/product/parts/new → purchase_product_part[code*, name*, fleet_set_item_id*, purchase_group_id*,
//                      purchase_measurement_unit_id*, use_in_service_order, active, comments,
//                      default_purchase_product_supplier_attributes[person_id, product_code]]
//  Pedido de compra:   /purchase/order/products/new → purchase_order_product[corporation_id*, provider_id*, order_at_date*,
//                      order_at_time*, payment_condition, deadline_at*, comments] — salvar antes de incluir itens;
//                      itens: "Novo Item" › #purchase_item_modal purchase_order_item[product_id*, amount*, unitary_value*, comments]
//                      (mapeado em 26/11/2026; itens em /purchase/order/:id/order_items)
//  Entrada COM PEDIDO (padrão da Transmassa, tipo "Pedido"): lista /storage/invoice/products › "Novo nota fiscal de produto
//                      ou peça" › "Com Pedido de Compra" › #storage-invoice-modal storage_invoice_product[purchase_order_id*]
//                      (busca select2 /purchase/order/products?search[only_available_orders]=true&term=<nº do pedido>).
//                      O ESL copia fornecedor, filial, nº (= nº do pedido), data e hora do pedido e trava esses campos;
//                      o comentário continua editável. Itens: aba "Entrada no Estoque" › "Novo Item" (igual à avulsa).
//  Entrada avulsa:     /storage/invoice/products/new (tipo "Avulsa") — só quando o usuário escolhe "Avulsa" na tela.
//                      storage_invoice_product[issuer_id*, recipient_id*, number*, emission_at_date*,
//                      emission_at_time*, comments]  — salvar antes de incluir itens;
//                      itens: aba "Entrada no Estoque" › "Novo Item" › #movement_modal storage_movement[purchase_product_id*, amount*,
//                      unitary_value, icms_percentage, ipi_percentage, purchase_warehouse_id*]
//  Baixa (Saída):      /purchase/storage/parts_withdrawals/new → purchase_storage_parts_withdrawal[corporation_id*, employee_id,
//                      withdrawn_at_date*, withdrawn_at_time*, comments] — salvar antes de incluir itens;
//                      itens: "Novo Item" › #withdrawal_movement_modal storage_movement[purchase_product_id*, amount*, purchase_warehouse_id*]
import { withPage } from './esl.js';
import { open, setSelect2, setText, selectByLabel, setCheckbox, saveMainForm, openTab, openModal, saveModal, brNum, shot, nowBr, assertValue, capture, clickAndConfirm, formErrors } from './ui.js';

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
 * Pedido de compra de peças (Compras › Pedidos › Produtos e peças).
 * o = { filial, providerId, providerText, date, time, paymentCondition, comments } — date/time viram data/hora da NF de entrada.
 */
export async function createPurchaseOrder(s, o) {
  const P = 'purchase_order_product';
  return withPage(s, async (page) =>
    withShot(page, async () => {
      await open(page, '/purchase/order/products/new');
      await selectByLabel(page, `${P}[corporation_id]`, o.filial);
      await setSelect2(page, `${P}[provider_id]`, o.providerId, o.providerText);
      await setText(page, `${P}[order_at_date]`, o.date);
      await setText(page, `${P}[order_at_time]`, o.time || '08:00');
      await setText(page, `${P}[deadline_at]`, o.date);
      if (o.paymentCondition) await setText(page, `${P}[payment_condition]`, o.paymentCondition);
      if (o.comments) await setText(page, `${P}[comments]`, o.comments);
      return saveMainForm(page, /\/purchase\/order\/products\/(\d+)\/edit/);
    })
  );
}

/** Item do pedido de compra. it = { productId, productText, quantidade, valorUnitario, comments } */
export async function addPurchaseOrderItem(s, orderId, it) {
  return withPage(s, async (page) =>
    withShot(page, async () => {
      await open(page, `/purchase/order/products/${orderId}/edit`);
      await openModal(page, 'Novo Item', 'purchase_item_modal');
      const sc = '#purchase_item_modal';
      await setSelect2(page, 'purchase_order_item[product_id]', it.productId, it.productText, sc);
      await page.waitForTimeout(1200); // o ESL preenche tipo/unidade/último valor ao escolher a peça
      await setText(page, 'purchase_order_item[amount]', brNum(it.quantidade, 3), sc);
      await setText(page, 'purchase_order_item[unitary_value]', brNum(it.valorUnitario, 5), sc);
      if (it.comments) await setText(page, 'purchase_order_item[comments]', it.comments, sc);
      await page.waitForTimeout(400);
      const lido = await page.$eval(`${sc} [name="purchase_order_item[unitary_value]"]`, (e) => e.value);
      const toNum = (x) => Number(String(x).replace(/\./g, '').replace(',', '.'));
      if (Math.abs(toNum(lido) - it.valorUnitario) > 0.001) {
        await setText(page, 'purchase_order_item[unitary_value]', brNum(it.valorUnitario, 5), sc);
        await page.waitForTimeout(300);
      }
      await saveModal(page, 'purchase_item_modal');
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    })
  );
}

/**
 * NF de entrada "Com Pedido de Compra" (tipo Pedido). O ESL copia o cabeçalho do pedido.
 * o = { orderId, orderText } — orderText é o que o select2 mostra (nº do pedido). Devolve o id da NF de entrada.
 */
export async function createStorageInvoiceFromOrder(s, o) {
  return withPage(s, async (page) =>
    withShot(page, async () => {
      await open(page, '/storage/invoice/products');
      const novo = page.locator('a:visible, button:visible').filter({ hasText: /Novo nota fiscal de produto/i }).first();
      await novo.waitFor({ state: 'visible', timeout: 10_000 });
      await novo.click();
      const opcao = page.locator('.dropdown-menu:visible a, .dropdown-menu:visible button, .dropdown-menu:visible li').filter({ hasText: /^\s*Com Pedido de Compra\s*$/i }).first();
      await opcao.waitFor({ state: 'visible', timeout: 5000 });
      await opcao.click();
      const modal = page.locator('#storage-invoice-modal');
      await modal.waitFor({ state: 'visible', timeout: 10_000 });
      await page.waitForTimeout(300);
      await setSelect2(page, 'storage_invoice_product[purchase_order_id]', o.orderId, o.orderText, '#storage-invoice-modal');
      await page.waitForTimeout(500);
      await capture(page, `pedido ${o.orderText} escolhido, antes de salvar a NF de entrada`);
      const re = /\/storage\/invoice\/products\/(\d+)\/edit/;
      const nav = page.waitForURL(re, { timeout: 25_000 }).catch(() => {});
      await clickAndConfirm(page, () => modal.locator('button:visible').filter({ hasText: /^\s*Salvar\s*$/ }).first().click());
      await nav;
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      const m = page.url().match(re);
      await capture(page, m ? 'NF de entrada com pedido criada' : 'ESL não criou a NF de entrada com pedido');
      if (!m) {
        // quem chama procura a NF ligada ao pedido antes de desistir (o ESL às vezes grava sem navegar)
        const errs = [...(await modal.locator('.has-error, .help-block, .alert-danger').allInnerTexts().catch(() => [])), ...(await formErrors(page))];
        return { id: null, erro: errs.map((t) => t.trim()).filter(Boolean).join(' | ') || null };
      }
      return { id: m[1], erro: null };
    })
  );
}

/** Troca só o comentário da NF de entrada (em NF com pedido é o único campo do cabeçalho que o ESL deixa editar). */
export async function setStorageInvoiceComments(s, invoiceId, comments) {
  const I = 'storage_invoice_product';
  return withPage(s, async (page) =>
    withShot(page, async () => {
      await open(page, `/storage/invoice/products/${invoiceId}/edit`);
      await setText(page, `${I}[comments]`, comments);
      await saveMainForm(page, /\/storage\/invoice\/products\/(\d+)\/edit/);
    })
  );
}

/** Cabeçalho da NF de entrada AVULSA (opção "Avulsa" da aba XML de Peças; o padrão é com pedido). h = { issuerId, issuerText, filial, number, date, time, comments } */
export async function createStorageInvoice(s, h) {
  const I = 'storage_invoice_product';
  return withPage(s, async (page) =>
    withShot(page, async () => {
      await open(page, '/storage/invoice/products/new');
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
      // em NF com pedido o ESL pode travar frete/desconto: não força, avisa quem chamou
      const travados = await page.evaluate((I) => [`${I}[freight_total]`, `${I}[discount_value]`]
        .filter((n) => document.querySelector(`[name="${n}"]`)?.disabled), I);
      if (travados.length) return { aplicado: false, motivo: 'o ESL bloqueia frete/desconto nesta NF de entrada' };
      await setText(page, `${I}[freight_total]`, brNum(frete, 2));
      await setText(page, `${I}[discount_value]`, brNum(desconto, 2));
      await page.waitForTimeout(500);
      await saveMainForm(page, /\/storage\/invoice\/products\/(\d+)\/edit/);
      return { aplicado: true };
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
