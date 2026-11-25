// Lógica comum das abas em lote: leitura dos XMLs, envio do lote ao backend e acompanhamento do progresso.
import { ref, reactive } from 'vue';
import { api } from '../api.js';

export const fmt = (n) => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const ls = (k, def = null) => {
  try {
    return JSON.parse(localStorage.getItem(k) || 'null') ?? def;
  } catch {
    return def;
  }
};
export const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));
export const placaFmt = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export function useLote(tipo, previewFn, montarLinha) {
  const linhas = ref([]);
  const lendo = ref('');
  const job = ref(null);
  let seq = 0;
  let timer;

  async function addFiles(fileList) {
    const files = [...fileList].filter((f) => /\.xml$/i.test(f.name));
    if (!files.length) return;
    // todas as linhas aparecem na hora; 3 notas consultadas ao mesmo tempo no ESL
    const fila = files.map((f) => {
      const linha = reactive({ ref: `n${++seq}`, arquivo: f.name, estado: 'lendo', aberta: false });
      linhas.value.push(linha);
      return { f, linha };
    });
    let feitos = 0;
    lendo.value = `Lendo ${files.length} XML(s)…`;
    const worker = async () => {
      while (fila.length) {
        const { f, linha } = fila.shift();
        try {
          const p = await previewFn({ name: f.name, content: await f.text() });
          if (!p.ok) throw new Error(p.error);
          Object.assign(linha, montarLinha(p), { p, estado: p.duplicidade?.bloqueado ? 'bloqueada' : 'conferir' });
        } catch (e) {
          Object.assign(linha, { estado: 'erro', erro: e.message });
        }
        lendo.value = `Lendo XMLs… ${++feitos}/${files.length}`;
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    // mesmo XML solto duas vezes no lote
    const vistos = new Set();
    for (const l of linhas.value) {
      const k = l.p?.duplicidade?.docKey;
      if (!k) continue;
      if (vistos.has(k) && l.estado !== 'lançada') Object.assign(l, { estado: 'bloqueada', erro: 'XML repetido neste lote.' });
      vistos.add(k);
    }
    lendo.value = '';
  }

  async function lancar(prontas, buildPayload) {
    const notas = prontas.map((l) => ({ ref: l.ref, payload: buildPayload(l) }));
    prontas.forEach((l) => Object.assign(l, { estado: 'na fila', resultado: null }));
    job.value = await api.loteStart(tipo, notas);
    clearInterval(timer);
    timer = setInterval(poll, 2000);
  }

  async function poll() {
    if (!job.value) return;
    try {
      job.value = await api.loteStatus(job.value.id);
    } catch {
      return;
    }
    for (const r of job.value.resultados) {
      const l = linhas.value.find((x) => x.ref === r.ref);
      if (!l) continue;
      l.resultado = r;
      l.estado = { 'na fila': 'na fila', lançando: 'lançando', lançado: 'lançada', pendente: 'conferir', erro: 'erro', cancelado: 'conferir' }[r.status] || l.estado;
      if (r.status === 'lançado' || r.status === 'erro' || r.status === 'pendente') l.erro = r.ok ? '' : r.error;
    }
    if (job.value.fim) clearInterval(timer);
  }

  const cancelar = () => job.value && api.loteCancel(job.value.id);
  const remover = (l) => (linhas.value = linhas.value.filter((x) => x !== l));
  const limpar = () => (linhas.value = linhas.value.filter((x) => ['na fila', 'lançando'].includes(x.estado)));

  return { linhas, lendo, job, addFiles, lancar, cancelar, remover, limpar };
}
