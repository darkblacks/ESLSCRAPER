// Ordem de Serviço (Frota › Serviços › Ordens de Serviço) — criação e itens.
// Telas mapeadas em 25/11/2026:
//  /fleet/service_orders/new?workshop_type=outsourced  → OS de Oficina Terceirizada
//  /fleet/service_orders/new?workshop_type=own         → OS de Oficina Própria
//  /fleet/service_orders/:id/edit  abas: Oficina | Pneus | Serviços ("Novo Serviço") | Produtos e Peças ("Novo item")
//  modal #outsourced_workshop_service_modal: fleet_set_item_id*, status*, purchase_product_id* (serviço), labor_value, warranty_date, mileage_warranty, comments
//  modal #workshop_part_modal: purchase_product_id*, quantity*, unitary_value, total_value, warranty_date, mileage_warranty, comments
//  Obs.: peça lançada na OS NÃO movimenta estoque no ESL (o modal não tem almoxarifado) — baixa é feita em Saída de Peças.
import { withPage } from './esl.js';
import { open, setSelect2, setText, saveMainForm, openTab, openModal, saveModal, brNum, shot } from './ui.js';
import { searchServiceOrders } from './lookups.js';

const FSO = 'fleet_service_order';
const WS = `${FSO}[fleet_service_order_workshop_attributes]`;

/** OS abertas (pendentes) do mesmo veículo — para alertar duplicidade antes de criar outra. */
export async function openOrdersForVehicle(s, plate) {
  if (!plate) return [];
  return (await searchServiceOrders(s, { term: plate, status: 'pending' })).filter((o) => String(o.placa || '').toUpperCase() === String(plate).toUpperCase());
}

/**
 * Cria a OS. os = { workshopType:'outsourced'|'own', corporationId, corporationText, vehicleId, vehicleText, odometer,
 *   maintenanceType, date, time, description, oficinaId, oficinaText, receptionResponsible, comments }
 * Retorna o id.
 */
export async function createServiceOrder(s, os) {
  return withPage(s, async (page) => {
    await open(page, `/fleet/service_orders/new?workshop_type=${os.workshopType === 'own' ? 'own' : 'outsourced'}`);
    if (os.corporationId) await setSelect2(page, `${FSO}[corporation_id]`, os.corporationId, os.corporationText);
    await setText(page, `${FSO}[service_at_date]`, os.date);
    await setText(page, `${FSO}[service_at_time]`, os.time || '08:00');
    await setSelect2(page, `${FSO}[vehicle_id]`, os.vehicleId, os.vehicleText);
    await page.waitForTimeout(1500); // o ESL preenche o hodômetro atual ao escolher o veículo
    if (os.odometer !== undefined && os.odometer !== '' && os.odometer !== null) await setText(page, `${FSO}[current_odometer]`, os.odometer);
    await setSelect2(page, `${FSO}[maintenance_type]`, os.maintenanceType || 'corrective');
    if (os.description) await setText(page, `${FSO}[service_description]`, os.description);
    if (os.workshopType !== 'own' && os.oficinaId) await setSelect2(page, `${WS}[person_id]`, os.oficinaId, os.oficinaText);
    if (os.receptionResponsible) await setText(page, `${WS}[reception_responsible]`, os.receptionResponsible);
    await setText(page, `${WS}[reception_at_date]`, os.date);
    await setText(page, `${WS}[reception_at_time]`, os.time || '08:00');
    if (os.comments) await setText(page, `${WS}[comments]`, os.comments);
    try {
      return await saveMainForm(page, /\/fleet\/service_orders\/(\d+)\/edit/);
    } catch (e) {
      e.screenshot = await shot(page);
      throw e;
    }
  });
}

/** Lança um serviço numa OS de oficina terceirizada. sv = { setItemId, setItemText, status, productId, productText, valor, comments } */
export async function addServiceToOrder(s, osId, sv) {
  return withPage(s, async (page) => {
    await open(page, `/fleet/service_orders/${osId}/edit`);
    await openTab(page, 'Serviços');
    const own = await page.locator('#own_workshop_service_modal').count();
    const modalId = own ? 'own_workshop_service_modal' : 'outsourced_workshop_service_modal';
    if (own) throw new Error('A OS é de Oficina Própria (exige funcionário/horas). Use uma OS de Oficina Terceirizada para lançar a nota de serviço.');
    await openModal(page, 'Novo Serviço', modalId);
    const sc = `#${modalId}`;
    await setSelect2(page, 'fleet_service_order_service[fleet_set_item_id]', sv.setItemId, sv.setItemText, sc);
    await setSelect2(page, 'fleet_service_order_service[status]', sv.status || 'fixed', sv.status || 'fixed', sc);
    await setSelect2(page, 'fleet_service_order_service[purchase_product_id]', sv.productId, sv.productText, sc);
    await setText(page, 'fleet_service_order_service[labor_value]', brNum(sv.valor, 2), sc);
    if (sv.comments) await setText(page, 'fleet_service_order_service[comments]', sv.comments, sc);
    await saveModal(page, modalId);
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  });
}

/** Aplica uma peça na OS (aba Produtos e Peças). p = { productId, productText, quantidade, valorUnitario, comments } */
export async function addPartToOrder(s, osId, p) {
  return withPage(s, async (page) => {
    await open(page, `/fleet/service_orders/${osId}/edit`);
    await openTab(page, 'Produtos e Peças');
    await openModal(page, 'Novo item', 'workshop_part_modal');
    const sc = '#workshop_part_modal';
    await setSelect2(page, 'fleet_service_order_part[purchase_product_id]', p.productId, p.productText, sc);
    await page.waitForTimeout(500);
    await setText(page, 'fleet_service_order_part[quantity]', brNum(p.quantidade, 3), sc);
    await setText(page, 'fleet_service_order_part[unitary_value]', brNum(p.valorUnitario, 2), sc);
    await setText(page, 'fleet_service_order_part[total_value]', brNum(p.quantidade * p.valorUnitario, 2), sc);
    if (p.comments) await setText(page, 'fleet_service_order_part[comments]', p.comments, sc);
    await saveModal(page, 'workshop_part_modal');
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  });
}

export async function orderScreenshot(s, osId, tab) {
  return withPage(s, async (page) => {
    await open(page, `/fleet/service_orders/${osId}/edit`);
    if (tab) await openTab(page, tab);
    return shot(page);
  });
}
