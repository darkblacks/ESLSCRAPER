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
//  Entrada avulsa (NF): /storage/invoice/products/new — a tela NÃO tem campo de tipo (conferido em 26/11/2026);
//                      tudo que é salvo por ela fica "Avulsa". Pedido só pelo caminho acima.
//                      → storage_invoice_product[issuer_id*, recipient_id*, number*, emission_at_date*,
//                      emission_at_time*, comments]  — salvar antes de incluir itens;
//                      itens: aba "Entrada no Estoque" › "Novo Item" › #movement_modal storage_movement[purchase_product_id*, amount*,
//                      unitary_value, icms_percentage, ipi_percentage, purchase_warehouse_id*]
//  Baixa (Saída):      /purchase/storage/parts_withdrawals/new → purchase_storage_parts_withdrawal[corporation_id*, employee_id,
//                      withdrawn_at_date*, withdrawn_at_time*, comments] — salvar antes de incluir itens;
//                      itens: "Novo Item" › #withdrawal_movement_modal storage_movement[purchase_product_id*, amount*, purchase_warehouse_id*]
import { withPage } from './esl.js';
import { open, setSelect2, setText, selectByLabel, setCheckbox, saveMainForm, openTab, openModal, saveModal, brNum, shot, nowBr, assertValue, capture, clickAndConfirm, formErrors, swalConfirmar, fecharAvisosSwal, select2Pesquisar } from './ui.js';

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

/**
 * Lê (sem salvar nada) como o ESL oferece o tipo da NF de entrada: no menu "Novo nota fiscal de produto ou peça" da
 * lista (Com Nota de Compra / Com Pedido de Compra / Avulsa). A tela /new não tem campo de tipo (sempre Avulsa).
 * Devolve { campo, tipo: 'menu', atual, opcoes } ou, se o menu não existir, o campo antigo da tela /new (ou null).
 */
export async function tiposEntrada(s) {
  return withPage(s, async (page) => {
    await open(page, '/storage/invoice/products');
    const opcoes = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('a, button')].find((b) => /Novo nota fiscal de produto/i.test(b.innerText || ''));
      const menu = btn?.closest('.btn-group, .dropdown, .dropup')?.querySelector('.dropdown-menu');
      return menu ? [...menu.querySelectorAll('a, li')].map((a) => (a.innerText || '').trim()).filter(Boolean) : [];
    });
    const uniq = [...new Set(opcoes)];
    if (uniq.length) return { campo: 'menu "Novo nota fiscal de produto ou peça"', tipo: 'menu', atual: '', opcoes: uniq };
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
      // escolhe o pedido pela busca do próprio ESL (digita o nº e clica no resultado): o ESL precisa dos dados completos
      // do pedido que vêm da busca — injetar só id/texto quebra o handler dele (loadPurchaseOrderElements)
      const esc = await select2Pesquisar(page, 'storage_invoice_product[purchase_order_id]', o.orderText, o.orderText, '#storage-invoice-modal');
      if (String(esc.valor) !== String(o.orderId)) {
        throw new Error(`Na busca do pedido ${o.orderText} o ESL trouxe outro pedido (id ${esc.valor}, esperado ${o.orderId}). Nada foi salvo.`);
      }
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

/**
 * Entrada de UM item do pedido numa NF de entrada COM PEDIDO (como no ESL à mão): aba "Itens do Pedido" › botão 🔗 da linha
 * → janela "Deseja vincular este produto?" (SweetAlert) com Almoxarifado (select2 #order_item_warehouse) e Qtde Recebida
 * (#amount_received) → Sim (clique; Enter se não fechar) → aviso → confere que a Qtde Recebida da linha subiu.
 * Mapeado na tela real em 26/11/2026 (NF 143555, pedido 4121). it = { codigo, quantidade, warehouseId, warehouseText }
 */
export async function linkOrderItem(s, invoiceId, it) {
  return withPage(s, async (page) =>
    withShot(page, async () => {
      await open(page, `/storage/invoice/products/${invoiceId}/edit`);
      await openTab(page, 'Itens do Pedido');
      const alvo = { codigo: String(it.codigo).trim(), qtd: Number(it.quantidade) };
      const lerLinha = () => page.evaluate((a) => {
        const num = (t) => Number(String(t).replace(/\./g, '').replace(',', '.'));
        document.querySelectorAll('[data-esl-link]').forEach((e) => e.removeAttribute('data-esl-link'));
        const linhas = [...document.querySelectorAll('#tab-order-items tbody tr')].filter((tr) => tr.offsetParent !== null);
        // colunas: Código | Item | Quantidade | Qtde Recebida | Saldo | Valor Unitário | Valor Total | 🔗
        const cand = linhas.map((tr) => ({ tr, c: [...tr.querySelectorAll('td')].map((td) => td.innerText.trim()) }))
          .filter((x) => x.c[0] === a.codigo && Math.abs(num(x.c[2]) - a.qtd) < 0.001);
        if (!cand.length) return { erro: 'linha' };
        const aberta = cand.find((x) => num(x.c[4]) > 0.0001);
        if (!aberta) return { recebido: num(cand[0].c[3]), jaRecebido: true };
        const b = aberta.tr.querySelector('td:last-child a, td:last-child button');
        if (!b) return { erro: 'botao' };
        b.setAttribute('data-esl-link', '1');
        return { recebido: num(aberta.c[3]), saldo: num(aberta.c[4]) };
      }, alvo);
      const antes = await lerLinha();
      if (antes.erro === 'linha') throw new Error(`Item ${alvo.codigo} (${alvo.qtd}) não está nos Itens do Pedido desta NF de entrada.`);
      if (antes.erro) throw new Error(`Não achei o botão de vincular do item ${alvo.codigo} nos Itens do Pedido.`);
      if (antes.jaRecebido) return { jaRecebido: true };
      await page.locator('[data-esl-link="1"]').first().scrollIntoViewIfNeeded().catch(() => {});
      await page.click('[data-esl-link="1"]');
      const t = await page.waitForFunction(() => {
        const S = window.Swal || window.swal;
        return S && S.isVisible() ? S.getPopup().innerText.replace(/\s+/g, ' ').trim() : null;
      }, null, { timeout: 8000 }).then((h) => h.jsonValue()).catch(() => null);
      if (!t || !/vincular/i.test(t)) {
        if (t) await page.evaluate(() => (window.Swal || window.swal).clickCancel()).catch(() => {});
        throw new Error(`Ao clicar em vincular o item ${alvo.codigo}, o ESL ${t ? `perguntou outra coisa: "${t}"` : 'não abriu a janela de vínculo'}.`);
      }
      try {
        const esc = await select2Pesquisar(page, '#order_item_warehouse', it.warehouseText, it.warehouseText);
        if (String(esc.valor) !== String(it.warehouseId)) throw new Error(`a busca do almoxarifado "${it.warehouseText}" escolheu outro (id ${esc.valor}, esperado ${it.warehouseId})`);
        await page.evaluate((q) => {
          const e = document.querySelector('.swal2-popup #amount_received, .swal2-popup .amount_received');
          e.value = q;
          e.dispatchEvent(new Event('input', { bubbles: true }));
          e.dispatchEvent(new Event('change', { bubbles: true }));
        }, brNum(alvo.qtd, 3));
      } catch (e) {
        await page.evaluate(() => (window.Swal || window.swal).clickCancel()).catch(() => {});
        throw new Error(`Vínculo do item ${alvo.codigo} cancelado: ${e.message}`);
      }
      await capture(page, `vincular ${alvo.codigo} ${alvo.qtd} em ${it.warehouseText}`);
      if (!(await swalConfirmar(page))) throw new Error(`O ESL não aceitou o "Sim" do vínculo do item ${alvo.codigo} (nem com Enter).`);
      await fecharAvisosSwal(page, 5000);
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      // confere: recarrega e a Qtde Recebida da linha tem que ter subido
      await open(page, `/storage/invoice/products/${invoiceId}/edit`);
      await openTab(page, 'Itens do Pedido');
      const depois = await lerLinha();
      const recebidoDepois = depois.jaRecebido ? depois.recebido : depois.recebido ?? 0;
      if (!(recebidoDepois > (antes.recebido || 0) + 0.0001)) {
        await capture(page, `vínculo NÃO confirmado ${alvo.codigo}`);
        throw new Error(`Confirmei o vínculo do item ${alvo.codigo}, mas a Qtde Recebida não mudou no ESL.`);
      }
      await capture(page, `vinculado ${alvo.codigo}`);
      return { recebido: recebidoDepois };
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

/** Acrescenta um texto ao comentário do cabeçalho da NF de entrada (mantém o que já existe). */
export async function appendStorageInvoiceComment(s, invoiceId, texto) {
  const I = 'storage_invoice_product';
  return withPage(s, async (page) =>
    withShot(page, async () => {
      await open(page, `/storage/invoice/products/${invoiceId}/edit`);
      const atual = await page.$eval(`[name="${I}[comments]"]`, (e) => e.value || '').catch(() => '');
      if (atual.includes(texto)) return invoiceId;
      await setText(page, `${I}[comments]`, [atual.trim(), texto].filter(Boolean).join(' | '));
      await page.waitForTimeout(300);
      await saveMainForm(page, /\/storage\/invoice\/products\/(\d+)\/edit/);
      return invoiceId;
    })
  );
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
      const contar = () => page.evaluate((a) => [...document.querySelectorAll('table tbody tr')].filter((r) => r.offsetParent !== null).filter((r) => {
        const c = [...r.querySelectorAll('td')].map((td) => td.innerText.trim().replace(/\./g, ''));
        return c[0] === a.codigo && c.includes(a.qtd) && c.includes(a.unit);
      }).length, alvo);
      const linhasAntes = await contar();
      // confirm() nativo também é aceito — sem isso o Playwright recusaria e a exclusão não aconteceria
      const onDialog = (d) => (/exclu/i.test(d.message()) ? d.accept() : d.dismiss()).catch(() => {});
      page.on('dialog', onDialog);
      try {
        await excluir.click();
        // a tela de confirmação SEMPRE aparece: "Tem certeza que deseja excluir o item?" → Sim (clique, e Enter se não fechar)
        const t = await page.waitForFunction(() => {
          const S = window.Swal || window.swal;
          return S && S.isVisible() ? S.getPopup().innerText.replace(/\s+/g, ' ').trim() : null;
        }, null, { timeout: 8000 }).then((h) => h.jsonValue()).catch(() => null);
        if (t !== null) {
          if (!/certeza.*exclu/i.test(t)) {
            await page.evaluate(() => (window.Swal || window.swal).clickCancel()).catch(() => {});
            throw new Error(`Pergunta inesperada ao excluir (cancelada): "${t}"`);
          }
          if (!(await swalConfirmar(page))) throw new Error(`O ESL não aceitou a confirmação da exclusão (nem com Enter): "${t}"`);
        }
        // depois vem o aviso "excluído com sucesso" → OK/Enter (erro aqui = não excluiu)
        await fecharAvisosSwal(page, 4000);
      } finally {
        page.off('dialog', onDialog);
      }
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      await page.waitForTimeout(800);
      // confere na tela: a linha tem que ter sumido (se havia mais de uma igual, uma a menos)
      const linhasDepois = await contar();
      if (linhasDepois >= linhasAntes) {
        await capture(page, `exclusão NÃO confirmada ${alvo.codigo}`);
        throw new Error(`Cliquei em excluir e confirmei, mas a linha ${alvo.codigo} ${alvo.qtd} × ${alvo.unit} continua na NF de entrada.`);
      }
      await capture(page, `excluído ${alvo.codigo} ${alvo.qtd} × ${alvo.unit}`);
    })
  );
}
