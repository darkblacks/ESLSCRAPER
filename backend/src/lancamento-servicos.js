// Aba "XML de Serviços": nota de serviço → serviço(s) lançado(s) numa OS. Não movimenta estoque.
import * as L from './ledger.js';
import { recuperarRestricao } from './hodometro.js';
import { ctx } from './ui.js';
import { createClassifier } from './classificacao.js';
import { parseServiceXml } from './nfse.js';
import {
  findPersonByDocument, findStorageInvoices, searchVehicles, searchServiceOrders, getServiceOrder, searchProducts, searchSetItems, searchGroups,
} from './lookups.js';
import { createServiceOrder, addServiceToOrder, openOrdersForVehicle, orderScreenshot } from './os.js';

const onlyDigits = (s) => String(s || '').replace(/\D/g, '');
const money = (n) => Number(n || 0).toFixed(2);

/** Procura o documento em: histórico local, NF de entrada de serviço no ESL e serviços da OS (pela marca). */
export async function checkServiceDuplicate(s, doc, fornecedorId, osId = null) {
  const key = L.docKey({ ...doc, cnpj: doc.prestador.cnpj, tipo: 'nfse' });
  const reg = L.get(key);
  const out = { docKey: key, bloqueado: false, motivos: [], existentes: [], retomavel: null };
  if (reg && reg.status !== 'concluido' && !reg.etapas?.os?.id) out.hodometroCorrecao = recuperarRestricao(reg);

  if (reg?.status === 'concluido') {
    out.bloqueado = true;
    out.motivos.push(`Nota já lançada por esta plataforma em ${new Date(reg.fim).toLocaleString('pt-BR')}.`);
    out.existentes.push({ origem: 'Histórico', os: reg.etapas?.os?.numero, osId: reg.etapas?.os?.id });
  } else if (reg?.status === 'em_andamento' || reg?.status === 'erro') {
    out.retomavel = { etapas: Object.keys(reg.etapas || {}), os: reg.etapas?.os || null, servicosOk: reg.etapas?.servicos?.ok || [] };
  }

  if (fornecedorId && doc.numero) {
    const nfs = await findStorageInvoices(s, 'services', { numero: doc.numero, issuerId: fornecedorId });
    if (nfs.length) {
      out.bloqueado = true;
      out.motivos.push(`Já existe Nota Fiscal de Entrada de serviço nº ${doc.numero} deste prestador no ESL (Compras › Notas Fiscais Entrada › Serviços).`);
      nfs.forEach((n) => out.existentes.push({ origem: 'NF de Entrada (Serviços)', ...n }));
    }
  }

  if (osId) {
    const os = await getServiceOrder(s, osId);
    const mk = L.marker(key);
    const ref = new RegExp(`NFS-?e\\s*(n[º°o.]?\\s*)?0*${doc.numero}\\b`, 'i');
    const hits = os.servicos.filter((x) => x.comentario.includes(mk) || ref.test(x.comentario));
    // serviço do mesmo prestador já lançado nessa OS com o mesmo valor total da nota
    const sameValue = os.servicos.filter((x) => money(x.valor) === money(doc.valorServicos) && !hits.includes(x));
    if (hits.length && !reg?.etapas?.servicos?.ok?.length) {
      out.bloqueado = true;
      out.motivos.push(`A OS ${os.numero} já tem serviço referente a esta nota.`);
      hits.forEach((h) => out.existentes.push({ origem: `OS ${os.numero}`, osId: os.id, servico: h.item, valor: h.valor, comentario: h.comentario }));
    } else if (sameValue.length) {
      out.alertas = [`A OS ${os.numero} já tem serviço com o mesmo valor (${sameValue.map((x) => x.item).join(', ')}). Confira se não é a mesma nota.`];
    }
  }
  return out;
}

export async function previewServico(s, file) {
  const doc = parseServiceXml(file.content);
  const fornecedor = doc.prestador.cnpj ? await findPersonByDocument(s, doc.prestador.cnpj) : null;
  const dup = await checkServiceDuplicate(s, doc, fornecedor?.id);

  let veiculoSugerido = null;
  if (doc.placaNoTexto) veiculoSugerido = (await searchVehicles(s, doc.placaNoTexto).catch(() => []))[0] || null;
  let osSugeridas = [];
  if (doc.osNoTexto) osSugeridas = await searchServiceOrders(s, { term: doc.osNoTexto, status: 'all' }).catch(() => []);
  // sempre traz também as OS abertas da placa (para saber se há mais de uma e pedir a escolha antes de lançar)
  if (veiculoSugerido) {
    const daPlaca = await searchServiceOrders(s, { term: veiculoSugerido.placa, status: 'pending' }).catch(() => []);
    osSugeridas = [...new Map([...osSugeridas, ...daPlaca].map((o) => [o.id, o])).values()];
  }

  // A descrição da nota atual tem prioridade sobre o histórico do fornecedor.
  const descricao = [...new Set([...(doc.itens || []).map(i => i.descricao), doc.discriminacao].filter(Boolean))].join(' ').slice(0, 2000);
  const classificar = createClassifier({ setItems: t => searchSetItems(s,t), groups: t => searchGroups(s,t), services: t => searchProducts(s,t,'service') });
  const [set, service] = await Promise.all([classificar(descricao,'set'), classificar(descricao,'service')]);
  const aprendido = L.learnedService(doc.prestador.cnpj);
  return { arquivo: file.name, ok: true, doc, fornecedor, duplicidade: dup, veiculoSugerido, osSugeridas, servicosSugeridos: service.options, classificacao: { set, service }, aprendido };
}

/**
 * payload = {
 *   doc,                         // devolvido pelo preview (pode ter campos completados manualmente)
 *   fornecedor: { id, nome },
 *   os: { modo: 'existente', id } |
 *       { modo: 'nova', corporationId, corporationText, vehicleId, vehicleText, placa, odometer, maintenanceType,
 *         date, time, description, receptionResponsible, confirmarMesmoVeiculo },
 *   servicos: [ { nItem, setItemId, setItemText, status, productId, productText, valor, descricao } ],
 *   comentario
 * }
 */
export async function lancarServico(s, payload, { commit, loteId = null }) {
  const { doc, fornecedor, os, servicos = [], comentario = '' } = payload;
  const faltas = [];
  if (!doc?.numero) faltas.push('número da nota');
  if (!doc?.prestador?.cnpj) faltas.push('CNPJ do prestador');
  if (!fornecedor?.id) faltas.push('prestador cadastrado no ESL');
  if (!os?.modo) faltas.push('OS de destino');
  if (os?.modo === 'existente' && !os.id) faltas.push('OS existente');
  if (os?.modo === 'nova') {
    if (!os.vehicleId) faltas.push('veículo da nova OS');
    if (!os.date) faltas.push('data da OS');
    if (!os.receptionResponsible) faltas.push('responsável pela recepção');
  }
  if (!servicos.length) faltas.push('ao menos um serviço');
  servicos.forEach((x, i) => {
    if (!x.setItemId) faltas.push(`item do conjunto do serviço ${i + 1}`);
    if (!x.productId) faltas.push(`serviço do catálogo do item ${i + 1}`);
    if (!(Number(x.valor) > 0)) faltas.push(`valor do serviço ${i + 1}`);
  });
  if (faltas.length) return { ok: false, etapa: 'validação', error: `Faltam: ${faltas.join(', ')}.` };
  if (!commit) return { ok: false, error: 'Gravação desativada no backend (ALLOW_COMMIT=false).' };

  const passos = [];
  const p = (etapa, ok, msg, extra = {}) => passos.push({ etapa, ok, msg, ...extra });

  // 1) Revalida duplicidade
  const dup0 = await checkServiceDuplicate(s, doc, fornecedor.id, os.modo === 'existente' ? os.id : null);
  if (dup0.bloqueado) return { ok: false, etapa: 'duplicidade', error: dup0.motivos.join(' '), duplicidade: dup0 };
  p('Duplicidade do XML', true, 'Nenhum lançamento anterior encontrado.');

  const key = dup0.docKey;
  L.lock(key);
  try {
  const reg = L.begin(key, {
    tipo: 'servico', numero: doc.numero, serie: doc.serie, chave: doc.chave, fornecedor: fornecedor.nome, cnpj: onlyDigits(doc.prestador.cnpj),
    valor: doc.valorServicos, usuario: s.email,
  });
  L.marcarLote(key, loteId);
  const mk = L.marker(key);

  try {
    // 2) OS
    let osId = reg.etapas?.os?.id || (os.modo === 'existente' ? os.id : null);
    if (osId) {
      const cur = await getServiceOrder(s, osId);
      if (cur.status !== 'pending') throw Object.assign(new Error(`A OS ${cur.numero} está "${cur.statusTexto}" — só é possível lançar em OS pendente.`), { etapa: 'OS' });
      if (!cur.podeEditar) throw Object.assign(new Error(`A OS ${cur.numero} não pode ser editada.`), { etapa: 'OS' });
      L.step(key, 'os', { id: cur.id, numero: cur.numero, criada: !!reg.etapas?.os?.criada });
      p('OS', true, reg.etapas?.os?.id ? `Retomando na OS ${cur.numero}.` : `OS ${cur.numero} localizada (${cur.placa}).`);
    } else {
      const abertas = await openOrdersForVehicle(s, os.placa || os.vehicleText);
      if (abertas.length && !os.confirmarMesmoVeiculo) {
        L.finish(key, 'erro', { erro: 'OS aberta para o mesmo veículo' });
        return {
          ok: false, etapa: 'OS', precisaConfirmar: true, osAbertas: abertas,
          error: `Já existe OS pendente para ${os.placa || os.vehicleText}: ${abertas.map((o) => o.numero).join(', ')}. Use uma delas ou confirme a criação de uma nova.`,
        };
      }
      ctx(s.page, `NFS-e ${doc.numero} · criando OS`);
      osId = await createServiceOrder(s, {
        workshopType: 'outsourced', corporationId: os.corporationId, corporationText: os.corporationText,
        vehicleId: os.vehicleId, vehicleText: os.vehicleText, odometer: os.odometer, maintenanceType: os.maintenanceType,
        date: os.date, time: os.time, description: os.description || `Serviço NFS-e ${doc.numero} - ${fornecedor.nome}`,
        oficinaId: fornecedor.id, oficinaText: fornecedor.nome, receptionResponsible: os.receptionResponsible,
        comments: `NFS-e ${doc.numero} - ${fornecedor.nome} ${mk}`,
      });
      const cur = await getServiceOrder(s, osId);
      L.step(key, 'os', { id: osId, numero: cur.numero, criada: true });
      p('OS', true, `OS ${cur.numero} criada (Oficina Terceirizada · ${fornecedor.nome}).`);
    }

    // 3) Duplicidade do serviço na OS (com a OS definida)
    if (!reg.etapas?.servicos?.ok?.length) {
      const dup1 = await checkServiceDuplicate(s, doc, fornecedor.id, osId);
      if (dup1.bloqueado) throw Object.assign(new Error(dup1.motivos.join(' ')), { etapa: 'duplicidade na OS', duplicidade: dup1 });
    }
    p('Duplicidade na OS', true, 'Serviço ainda não lançado na OS.');

    // 4) e 5) Serviços + comentário
    const feitos = new Set(L.get(key).etapas?.servicos?.ok || []);
    // o que já está na OS com a marca deste XML conta como feito (o histórico pode ter ficado para trás)
    const jaNaOs = (await getServiceOrder(s, osId)).servicos.filter((x) => x.comentario.includes(mk));
    for (const [i, sv] of servicos.entries()) {
      const id = sv.nItem ?? i + 1;
      if (!feitos.has(id)) {
        const k = jaNaOs.findIndex((x) => String(x.produtoId) === String(sv.productId) && Math.abs(x.valor - Number(sv.valor)) < 0.01);
        if (k >= 0) {
          jaNaOs.splice(k, 1);
          feitos.add(id);
          L.step(key, 'servicos', { ok: [...feitos] });
        }
      }
      if (feitos.has(id)) {
        p(`Serviço ${id}`, true, 'Já lançado anteriormente (retomada).');
        continue;
      }
      const comments = [comentario, `NFS-e ${doc.numero}${doc.serie ? ' série ' + doc.serie : ''} - ${fornecedor.nome}`, sv.descricao ? sv.descricao.slice(0, 180) : '', mk]
        .filter(Boolean).join(' | ');
      ctx(s.page, `NFS-e ${doc.numero} · OS · serviço ${id}`);
      await addServiceToOrder(s, osId, { ...sv, comments });
      feitos.add(id);
      L.step(key, 'servicos', { ok: [...feitos] });
      p(`Serviço ${id}`, true, `${sv.productText} · R$ ${money(sv.valor)} lançado.`);
    }

    // 6) e 7) Confere na OS
    const fim = await getServiceOrder(s, osId);
    const gravados = fim.servicos.filter((x) => x.comentario.includes(mk));
    const esperado = servicos.reduce((a, x) => a + Number(x.valor), 0);
    const totalGravado = gravados.reduce((a, x) => a + x.valor, 0);
    const confere = gravados.length >= servicos.length && Math.abs(totalGravado - esperado) < 0.01;
    p('Conferência', confere, confere
      ? `${gravados.length} serviço(s) na OS ${fim.numero}, total R$ ${money(totalGravado)}.`
      : `Esperado ${servicos.length} serviço(s) / R$ ${money(esperado)}; encontrado ${gravados.length} / R$ ${money(totalGravado)}. Confira a OS.`);

    // 8) e 9) Resultado + histórico
    if (confere && servicos[0]) {
      const x = servicos[0];
      L.learnService(doc.prestador.cnpj, { setItem: { id: x.setItemId, text: x.setItemText }, produto: { id: x.productId, text: x.productText }, status: x.status });
    }
    const final = L.finish(key, confere ? 'concluido' : 'erro', { resultado: { osId, osNumero: fim.numero, totalGravado, esperado } });
    return {
      ok: confere, osId, osNumero: fim.numero, passos, conferencia: { esperado, gravado: totalGravado, confere },
      servicosOs: fim.servicos, registro: final, screenshot: await orderScreenshot(s, osId, 'Serviços').catch(() => null),
    };
  } catch (e) {
    L.log(key, `Erro: ${e.message}`);
    L.finish(key, 'erro', { erro: e.message, hodometroCorrecao: e.hodometroCorrecao || null });
    p(e.etapa || 'Execução', false, e.message);
    return { ok: false, etapa: e.etapa || 'execução', error: e.message, passos, duplicidade: e.duplicidade, screenshot: e.screenshot, retomavel: true, hodometroCorrecao: e.hodometroCorrecao };
  }
  } finally {
    L.unlock(key);
  }
}
