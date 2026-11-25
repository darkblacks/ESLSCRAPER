// Telas mapeadas no ESL (Cadastros fora de propósito).
// Só rotas desta lista (e sub-rotas delas, ex. /fleet/service_orders/123) são acessíveis pela API.
export const MODULES = {
  operacional: {
    label: 'Operacional (TMS)',
    screens: [
      { key: 'demandas', label: 'Carga lotação › Demandas', route: '/scheduling/services' },
      { key: 'programacoes', label: 'Carga lotação › Programações', route: '/scheduling/operations' },
      { key: 'coletas', label: 'Coletas › Convencional', route: '/picks' },
      { key: 'coletas_courier', label: 'Coletas › Courier', route: '/pick_couriers' },
      { key: 'coletas_malotes', label: 'Coletas › Malotes', route: '/pick_mailbags' },
      { key: 'pre_embarques', label: 'Pré-Embarques', route: '/pre_boardings' },
      { key: 'fretes', label: 'Fretes', route: '/freights' },
      { key: 'emissao_agil', label: 'Emissão Ágil › Fretes', route: '/freight/agile/batches' },
      { key: 'emissao_agil_dev', label: 'Emissão Ágil › Devoluções', route: '/freight/agile/return_batches' },
      { key: 'rateio', label: 'Rateio de Fretes', route: '/freight/consolidation/sharings' },
      { key: 'roteirizacao', label: 'Roteirização › Coletas e Entregas', route: '/integration/routing/items' },
      { key: 'manifestos', label: 'Manifestos', route: '/manifests' },
      { key: 'minuta_rodo', label: 'Minutas › Rodoviária', route: '/dispatch_draft/roads' },
      { key: 'consolidacao_rodo', label: 'Consolidações › Rodoviária', route: '/consolidation/roads' },
      { key: 'ordens_conferencia', label: 'Volumes › Ordens de Conferência', route: '/check_in/orders' },
      { key: 'notas_fiscais', label: 'Notas fiscais › Consulta', route: '/invoices' },
      { key: 'triagem_nf', label: 'Notas fiscais › Triagem', route: '/invoice/parting' },
      { key: 'comprovantes', label: 'Comprovantes › Lista', route: '/freight_delivery_receipts' },
      { key: 'protocolos', label: 'Comprovantes › Protocolo', route: '/freight/protocols' },
      { key: 'arquivamento', label: 'Comprovantes › Arquivamento', route: '/freight/archivings' },
    ],
  },
  frota: {
    label: 'Frota',
    screens: [
      { key: 'os', label: 'Serviços › Ordens de Serviço', route: '/fleet/service_orders' },
      { key: 'checklists', label: 'Serviços › Checklists', route: '/fleet/checklists' },
      { key: 'defeitos', label: 'Serviços › Comunicações de Defeito', route: '/fleet/defect_communications' },
      { key: 'infracoes', label: 'Serviços › Infrações de Trânsito', route: '/fleet/transit_infractions' },
      { key: 'req_combustivel', label: 'Combustível › Requisição', route: '/fleet/fuel/requests' },
      { key: 'abastecimento', label: 'Combustível › Abastecimento', route: '/fleet/fuel/supplies' },
      { key: 'pneus', label: 'Pneus › Unidades', route: '/fleet/tire/units' },
      { key: 'prev_consulta', label: 'Consulta › Manutenção Preventiva', route: '/fleet/consults/next_maintenances' },
      { key: 'rel_os', label: 'Relatório › Ordens de Serviço', route: '/report/fleet/service_orders' },
      { key: 'rel_os_servicos', label: 'Relatório › Serviços', route: '/report/fleet/service_order_services' },
      { key: 'rel_os_pecas', label: 'Relatório › Peças', route: '/report/fleet/service_order_parts' },
    ],
  },
  compras: {
    label: 'Compras',
    screens: [
      { key: 'solic_produtos', label: 'Solicitações › Produtos e peças', route: '/purchase/request/products' },
      { key: 'solic_servicos', label: 'Solicitações › Serviços', route: '/purchase/request/services' },
      { key: 'solic_aprov', label: 'Solicitações › Aprovações', route: '/purchase/request/approvals' },
      { key: 'cot_produtos', label: 'Cotações › Produtos e peças', route: '/purchase/bid/products' },
      { key: 'cot_servicos', label: 'Cotações › Serviços', route: '/purchase/bid/services' },
      { key: 'cot_aprov', label: 'Cotações › Aprovações', route: '/purchase/bid/approvals' },
      { key: 'ped_produtos', label: 'Pedidos › Produtos e peças', route: '/purchase/order/products' },
    ],
  },
};

const ALL_ROUTES = Object.values(MODULES).flatMap((m) => m.screens.map((s) => s.route));
// Raízes de módulo liberadas para leitura do menu
const MODULE_ROOTS = ['/tms', '/fleet', '/purchase'];

export function isAllowedRoute(route) {
  if (typeof route !== 'string' || !route.startsWith('/') || route.includes('..')) return false;
  const path = route.split('?')[0];
  if (MODULE_ROOTS.includes(path)) return true;
  return ALL_ROUTES.some((r) => path === r || path.startsWith(r + '/'));
}
