// Lançamento em LOTE: várias notas (serviços ou peças) executadas em sequência no backend, com progresso consultável.
// A OS pode vir como { modo: 'auto', placa, criarSeNaoHouver, nova: {...} }: o lote procura a OS pendente da placa
// na hora de lançar — assim várias notas do mesmo veículo caem na mesma OS (a 1ª cria, as seguintes reaproveitam).
import crypto from 'node:crypto';
import { kmInteiro } from './hodometro.js';
import { lancarServico } from './lancamento-servicos.js';
import { lancarPecas } from './lancamento-pecas.js';
import * as L from './ledger.js';
import { searchServiceOrders, searchVehicles } from './lookups.js';

const jobs = new Map(); // id -> job
const telas = new Map(); // `${jobId}|${ref}` -> [{ em, legenda, img }]  (fora do job p/ o polling ficar leve)
setInterval(() => {
  const lim = Date.now() - 6 * 3600_000;
  for (const [id, j] of jobs) if (j.fim && Date.parse(j.fim) < lim) jobs.delete(id);
}, 600_000).unref();

async function resolveOs(s, os) {
  if (os?.modo !== 'auto') return { os };
  const placa = String(os.placa || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!placa) return { erro: 'Sem placa/OS para esta nota.' };
  const abertas = (await searchServiceOrders(s, { term: placa, status: 'pending' })).filter((o) => String(o.placa || '').toUpperCase() === placa);
  if (abertas.length === 1) return { os: { modo: 'existente', id: abertas[0].id }, info: `OS ${abertas[0].numero} (aberta)` };
  if (abertas.length > 1) {
    return { erro: `Placa ${placa} tem ${abertas.length} OS abertas (${abertas.map((o) => o.numero).join(', ')}). Escolha a OS desta nota.`, osAbertas: abertas };
  }
  if (!os.criarSeNaoHouver) return { erro: `Placa ${placa} não tem OS aberta.` };
  const v = (await searchVehicles(s, placa)).find((x) => String(x.placa).toUpperCase() === placa);
  if (!v) return { erro: `Veículo ${placa} não encontrado na frota do ESL.` };
  const km = kmInteiro(os.nova?.odometer ?? v.hodometro);
  if (km === null) return { erro: 'Informe o hodômetro real da nova OS para ' + placa + '.' };
  return {
    os: { ...os.nova, modo: 'nova', vehicleId: v.id, vehicleText: v.placa, placa: v.placa, odometer: km, confirmarMesmoVeiculo: false },
    info: `nova OS para ${placa}`,
  };
}

/** tipo: 'servicos' | 'pecas'; notas: [{ ref, payload }] */
export function startBatch(s, tipo, notas, { commit }) {
  const id = crypto.randomUUID();
  const loteId = L.novoLoteId(); // ID legível do envio (LOTE-AAAAMMDD-XXXX), gravado em cada nota do histórico
  const job = {
    id, loteId, tipo, total: notas.length, feitos: 0, atual: null, inicio: new Date().toISOString(), fim: null, cancelado: false,
    resultados: notas.map((n) => ({ ref: n.ref, status: 'na fila' })),
  };
  jobs.set(id, job);
  s.emLote = true;
  (async () => {
    // Login caiu: pausa o lote e espera o usuário entrar de novo (até 12 h); depois segue de onde parou.
    const esperarLogin = async () => {
      const limite = Date.now() + 12 * 3600_000;
      while (s.status !== 'ok' && !job.cancelado && Date.now() < limite) {
        job.pausado = 'O login no ESL caiu — entre de novo e o lote continua sozinho.';
        await new Promise((ok) => setTimeout(ok, 5000));
      }
      job.pausado = null;
      return s.status === 'ok';
    };
    const lancarNota = async (i, n, passada, tentativa = 1) => {
      if (s.status !== 'ok' && !(await esperarLogin())) job.cancelado = true;
      if (job.cancelado) {
        job.resultados[i] = { ref: n.ref, status: 'cancelado' };
        return;
      }
      job.atual = passada > 1 ? `${n.ref} (nova tentativa automática)` : n.ref;
      job.resultados[i] = { ref: n.ref, status: 'lançando' };
      try {
        const ro = await resolveOs(s, n.payload.os);
        if (ro.erro) {
          job.resultados[i] = { ref: n.ref, status: 'pendente', ok: false, error: ro.erro, osAbertas: ro.osAbertas };
        } else {
          const payload = { ...n.payload, os: ro.os };
          // liga a trilha de telas: print do ESL antes/depois de cada Salvar
          const trilha = [];
          s.page._trail = trilha;
          s.page._onShot = (t) => (job.ultimaTela = { ref: n.ref, legenda: t.legenda, em: t.em, img: t.img });
          telas.set(`${id}|${n.ref}`, trilha);
          const r = tipo === 'pecas' ? await lancarPecas(s, payload, { commit, loteId }) : await lancarServico(s, payload, { commit, loteId });
          delete r.servicosOs;
          if (r.screenshot) telas.get(`${id}|${n.ref}`)?.push({ em: new Date().toISOString(), legenda: r.ok ? 'tela final' : 'tela no momento do erro', img: r.screenshot });
          delete r.screenshot;
          job.resultados[i] = { ref: n.ref, status: r.ok ? 'lançado' : 'erro', destinoOs: ro.info, qtdTelas: telas.get(`${id}|${n.ref}`)?.length || 0, passada, ...r };
        }
      } catch (e) {
        job.resultados[i] = { ref: n.ref, status: 'erro', ok: false, error: e.message };
        if (e.status === 401) s.status = 'expirada';
      }
      s.page._trail = null;
      s.page._onShot = null;
      // caiu o login durante esta nota: espera relogar e refaz a nota (a retomada não repete o que já foi gravado)
      if (s.status !== 'ok' && tentativa < 3 && !job.cancelado) {
        job.resultados[i] = { ref: n.ref, status: 'na fila', aviso: 'aguardando novo login para continuar' };
        return lancarNota(i, n, passada, tentativa + 1);
      }
    };
    try {
      for (const [i, n] of notas.entries()) {
        await lancarNota(i, n, 1);
        job.feitos++;
      }
      // 2ª passada: notas que deram erro no meio do caminho (retomáveis) são relançadas sozinhas —
      // a retomada não repete o que já foi gravado. Validação, duplicidade e "pendente" (falta decisão) ficam de fora.
      const deNovo = notas.map((n, i) => [i, n]).filter(([i]) => job.resultados[i]?.status === 'erro' && job.resultados[i]?.retomavel && !job.resultados[i]?.precisaConfirmar && !job.resultados[i]?.precisaConfirmarPeca && !job.resultados[i]?.hodometroCorrecao);
      if (deNovo.length && !job.cancelado) {
        job.segundaPassada = deNovo.length;
        await new Promise((ok) => setTimeout(ok, 30_000)); // dá um respiro ao ESL
        for (const [i, n] of deNovo) await lancarNota(i, n, 2);
      }
    } finally {
      s.emLote = false;
    }
    job.atual = null;
    job.fim = new Date().toISOString();
  })();
  return job;
}

export const getBatch = (id) => jobs.get(id) || null;
export function cancelBatch(id) {
  const j = jobs.get(id);
  if (j) j.cancelado = true;
  return j;
}

/** Telas capturadas de uma nota do lote (legenda + imagem). */
export const getTelas = (id, ref) => telas.get(`${id}|${ref}`) || [];
