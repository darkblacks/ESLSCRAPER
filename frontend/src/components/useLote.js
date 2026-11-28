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
      if (r.hodometroCorrecao && l.resultado?.hodometroCorrecao?.mensagem !== r.hodometroCorrecao.mensagem) aplicarRestricaoKm(l, r.hodometroCorrecao);
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

// Só exibe sugestão comum no padrão se TODOS os itens relevantes concordarem.
export function sugestaoComum(values) {
  if (!values.length || values.some(v => !v?.id)) return null;
  return values.every(v => String(v.id) === String(values[0].id)) ? values[0] : null;
}
export const opcoesUnicas = values => [...new Map(values.filter(v => v?.id).map(v => [String(v.id),v])).values()];

// Hodômetro individual da nota, não altera o cadastro do veículo.
const kmTexto = v => {
  const s = String(v ?? '').trim();
  return /^\d{1,3}(?:\.\d{3})+$/.test(s) ? s.replace(/\./g,'') : s;
};
export function inicialKm(p, placa) {
  const v = p.veiculoSugerido;
  const atual = placaFmt(v?.placa) === placaFmt(placa) ? v?.hodometro : null;
  const anterior = p.duplicidade?.hodometroCorrecao || null;
  const r = anterior?.placa && placa && placaFmt(anterior.placa) !== placaFmt(placa) ? null : anterior;
  return { km: kmTexto(r?.sugestao ?? atual), kmAtual: atual ?? null, kmLimites: r, kmConfirmado: !r, kmEditado: false, kmCarregando: false, kmErro: '' };
}
export function editarKm(l, value) {
  l.km = kmTexto(value);
  l.kmEditado = true;
  l.kmConfirmado = !l.kmLimites;
}
export function aplicarRestricaoKm(l, r) {
  if (!r) return;
  l.kmLimites = r;
  l.km = r.sugestao == null ? l.km : String(r.sugestao);
  l.kmConfirmado = false;
  l.kmEditado = false;
}
export function pendenciaKm(l) {
  if (l.kmCarregando) return 'consultando hodômetro';
  const n = String(l.km ?? '').trim();
  if (!/^\d+$/.test(n) || !Number.isSafeInteger(Number(n))) return 'hodômetro da nova OS';
  if (l.kmLimites?.conflitante) return 'limites de hodômetro conflitantes no ESL';
  if ((l.kmLimites?.min != null && Number(n) < l.kmLimites.min) || (l.kmLimites?.max != null && Number(n) > l.kmLimites.max)) return 'hodômetro fora dos limites do ESL';
  if (l.kmLimites && !l.kmConfirmado) return 'confirmar hodômetro corrigido';
  return '';
}
export async function consultarKm(l) {
  const placa = placaFmt(l.placa);
  if (placa.length !== 7) return;
  const req = (l.kmReq || 0) + 1;
  l.kmReq = req;
  l.kmCarregando = true;
  l.kmErro = '';
  try {
    const v = (await api.vehicles(placa)).find(v => placaFmt(v.placa) === placa);
    if (l.kmReq !== req || placaFmt(l.placa) !== placa) return;
    if (!v) { l.kmErro = 'Veículo não encontrado no ESL.'; return; }
    l.kmAtual = v.hodometro ?? null;
    if (!l.kmEditado && !l.kmLimites) l.km = kmTexto(v.hodometro);
  } catch (e) {
    if (l.kmReq === req) l.kmErro = e.message;
  } finally {
    if (l.kmReq === req) l.kmCarregando = false;
  }
}
export function trocarPlacaKm(l, value) {
  if (placaFmt(l.placa) === placaFmt(value)) return;
  l.kmReq = (l.kmReq || 0) + 1;
  const preservar = !placaFmt(l.placa) && l.kmLimites && (!l.kmLimites.placa || placaFmt(l.kmLimites.placa).startsWith(placaFmt(value)));
  // Conserva a restrição de uma nota reimportada enquanto se completa a placa original.
  const parcial = l.kmLimites && placaFmt(l.placa).length < 7 && placaFmt(value).startsWith(placaFmt(l.placa)) && (!l.kmLimites.placa || placaFmt(l.kmLimites.placa).startsWith(placaFmt(value)));
  if (preservar || parcial) { l.kmCarregando = false; return; }
  Object.assign(l, { km: '', kmAtual: null, kmLimites: null, kmConfirmado: true, kmEditado: false, kmCarregando: false, kmErro: '' });
}
