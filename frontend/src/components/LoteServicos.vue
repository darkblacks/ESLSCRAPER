<script setup>
// Aba "XML de Serviços" em lote: solte várias notas de serviço; padrões preenchidos uma vez; cada nota cai na OS aberta da placa.
import { reactive, computed, watch, ref } from 'vue';
import { api } from '../api.js';
import SearchPick from './SearchPick.vue';
import TelasEsl from './TelasEsl.vue';
import TelaAoVivo from './TelaAoVivo.vue';
import { useLote, fmt, ls, save, placaFmt } from './useLote.js';

const props = defineProps({ commitEnabled: Boolean });
const STATUS = [['fixed', 'C - Consertou/Completou'], ['cleaned', 'L - Lavou/Limpou'], ['regulated', 'R - Regulou/Reparou'], ['changed', 'T - Trocou'], ['verified', 'V - Verificou']];
const TIPOS = [['corrective', 'Corretiva'], ['preventive', 'Preventiva'], ['preparation', 'Preparação'], ['damage', 'Avaria'], ['reform', 'Reforma'], ['help', 'Socorro']];

const pad = reactive(ls('lote_srv_padroes', {
  setItem: null, produto: null, status: 'fixed', comentario: '', criarOs: true, filial: null, responsavel: '', tipo: 'corrective',
}));
watch(pad, (v) => save('lote_srv_padroes', v), { deep: true });
const filiais = ref([]);
api.filiais().then((f) => (filiais.value = f)).catch(() => {});

const searchSetItems = async (t) => (await api.setItems(t)).map((i) => ({ id: i.id, text: i.nome }));
const searchServices = async (t) => (await api.products(t, 'service')).map((p) => ({ id: p.id, text: p.text, sub: p.grupo }));
const searchPeople = async (t) => (await api.people(t)).map((p) => ({ id: p.id, text: p.nome, sub: p.documento }));

function montarLinha(p) {
  const d = p.doc || {};
  const osTexto = (p.osSugeridas || []).find((o) => d.osNoTexto && String(o.numero) === String(d.osNoTexto) && o.status === 'pending');
  const placa = p.veiculoSugerido?.placa || '';
  const unica = osAbertasDe(p, placa);
  return {
    placa,
    // OS citada no texto da nota; senão, a única OS aberta da placa
    osSel: osTexto ? osRef(osTexto) : unica.length === 1 ? osRef(unica[0]) : null,
    osManual: false, // true depois de "trocar": não re-seleciona sozinho até a placa mudar
    fornecedorSel: p.fornecedor ? { id: p.fornecedor.id, text: p.fornecedor.nome } : null,
    setItem: p.aprendido?.setItem || null, // aprendido para este prestador
    produto: p.aprendido?.produto || null,
    valor: d.valorServicos,
  };
}
const { linhas, lendo, job, addFiles, lancar, cancelar, remover, limpar } = useLote('servicos', api.xmlServicosPreview, montarLinha);

const efetivo = (l) => ({ setItem: l.setItem || pad.setItem, produto: l.produto || pad.produto });

/** OS abertas da placa desta nota. Mais de uma → você escolhe antes de lançar. */
function osAbertasDe(p, placa) {
  const pl = placaFmt(placa);
  if (!pl) return [];
  return (p?.osSugeridas || []).filter((o) => o && o.status === 'pending' && placaFmt(o.placa) === pl);
}
const osAbertas = (l) => osAbertasDe(l.p, l.placa);
const osRef = (o) => ({ id: o.id, text: `OS ${o.numero}` });
/** Exatamente 1 OS aberta para a placa e nada escolhido → seleciona essa OS. */
function autoOs(l) {
  if (l.osSel || l.osManual) return;
  const a = osAbertas(l);
  if (a.length === 1) l.osSel = osRef(a[0]);
}
const escolherOs = (l, id) => {
  const o = osAbertas(l).find((x) => String(x.id) === String(id));
  l.osSel = o ? osRef(o) : null;
};
/** Placa digitada/editada: descarta a OS anterior e re-seleciona se houver só 1 aberta. */
function mudarPlaca(l, v) {
  l.placa = v;
  l.osSel = null;
  l.osManual = false;
  autoOs(l);
}
/** "trocar": libera a placa e a escolha da OS (com 1 OS aberta ela aparece no select para confirmar). */
function trocarOs(l) {
  l.osSel = null;
  l.osManual = true;
}
/** "OS específica" (detalhes): OS abertas sugeridas; vazio = automática pela placa. */
function osEspecifica(l, id) {
  const o = (l.p?.osSugeridas || []).find((x) => String(x.id) === String(id));
  l.osSel = o ? osRef(o) : null;
  l.osManual = !o;
}

function pendencias(l) {
  if (!l.p) return [];
  const f = [];
  const d = l.p.doc || {};
  if (!d.numero) f.push('nº da nota');
  if (!d.date) f.push('data');
  if (!l.fornecedorSel) f.push('prestador no ESL');
  if (!l.osSel && !placaFmt(l.placa)) f.push('placa ou OS');
  if (!l.osSel && osAbertas(l).length > 1) f.push(`escolher a OS (${osAbertas(l).length} abertas para ${placaFmt(l.placa)})`);
  if (!l.osSel && pad.criarOs && (!pad.responsavel || !pad.filial)) f.push('filial/responsável (padrões)');
  const e = efetivo(l);
  if (!e.setItem) f.push('item do conjunto');
  if (!e.produto) f.push('serviço do catálogo');
  if (!(Number(l.valor) > 0)) f.push('valor');
  return f;
}
// nota com erro também pode ser lançada de novo (retoma de onde parou)
const prontas = computed(() => linhas.value.filter((l) => l.p && ['conferir', 'erro'].includes(l.estado) && !pendencias(l).length));
const total = computed(() => prontas.value.reduce((a, l) => a + Number(l.valor || 0), 0));

function payload(l) {
  const d = l.p.doc;
  const e = efetivo(l);
  return {
    doc: d,
    fornecedor: { id: l.fornecedorSel.id, nome: l.fornecedorSel.text },
    os: l.osSel
      ? { modo: 'existente', id: l.osSel.id }
      : {
          modo: 'auto', placa: placaFmt(l.placa), criarSeNaoHouver: pad.criarOs,
          nova: {
            corporationId: pad.filial?.id, corporationText: pad.filial?.text, maintenanceType: pad.tipo, date: d.date, time: d.time,
            receptionResponsible: pad.responsavel, description: `Serviços - ${l.fornecedorSel.text}`,
          },
        },
    servicos: [{
      nItem: 1, setItemId: e.setItem.id, setItemText: e.setItem.text, status: pad.status, productId: e.produto.id, productText: e.produto.text,
      valor: Number(l.valor), descricao: d.discriminacao || d.itens?.[0]?.descricao || '',
    }],
    comentario: pad.comentario,
  };
}

function lancarTudo() {
  const n = prontas.value.length;
  if (!confirm(`Lançar ${n} nota(s) de serviço (${fmt(total.value)}) no ESL?\nNotas da mesma placa vão para a mesma OS aberta${pad.criarOs ? '; sem OS aberta, cria uma nova' : ''}.`)) return;
  lancar(prontas.value, payload);
}

const ESTADO = { lendo: ['', 'lendo…'], conferir: ['warn', 'conferir'], bloqueada: ['err', 'já lançada'], erro: ['err', 'erro'], 'na fila': ['ready', 'na fila'], lançando: ['ready', 'lançando…'], lançada: ['ok', 'lançada'] };
const estado = (l) => (l.estado === 'conferir' && !pendencias(l).length ? ['ready', 'pronta'] : l.estado === 'erro' && l.resultado ? ['err', 'erro — pode lançar de novo'] : ESTADO[l.estado] || ['', l.estado]);
</script>

<template>
  <div class="xmltab">
    <section class="card">
      <h3>Padrões do lote <small class="muted">— preencha uma vez; valem para todas as notas (cada prestador também “aprende” o que foi usado da última vez)</small></h3>
      <div class="grid">
        <label>Item do conjunto padrão<SearchPick v-model="pad.setItem" :search="searchSetItems" placeholder="ex.: Freio - Lona" /></label>
        <label>Serviço do catálogo padrão<SearchPick v-model="pad.produto" :search="searchServices" placeholder="ex.: MÃO DE OBRA" /></label>
        <label>Status<select v-model="pad.status"><option v-for="[v, t] in STATUS" :key="v" :value="v">{{ t }}</option></select></label>
        <label class="wide">Comentário (opcional, em todas)<input v-model="pad.comentario" /></label>
        <label class="inline"><input type="checkbox" v-model="pad.criarOs" /> Sem OS aberta para a placa → criar nova OS</label>
        <template v-if="pad.criarOs">
          <label>Filial da nova OS
            <select v-model="pad.filial"><option :value="null">—</option><option v-for="f in filiais" :key="f.id" :value="{ id: f.id, text: f.nome }">{{ f.nome }}</option></select>
          </label>
          <label>Responsável recepção<input v-model="pad.responsavel" /></label>
          <label>Tipo manutenção<select v-model="pad.tipo"><option v-for="[v, t] in TIPOS" :key="v" :value="v">{{ t }}</option></select></label>
        </template>
      </div>
    </section>

    <label class="drop" @dragover.prevent @drop.prevent="addFiles($event.dataTransfer.files)">
      <input type="file" accept=".xml" multiple hidden @change="addFiles($event.target.files); $event.target.value = ''" />
      <strong>Solte aqui VÁRIOS XMLs de notas de SERVIÇO</strong>
      <small class="muted">NFS-e Nacional, ABRASF, Paulistana · lançadas nas OS — sem estoque</small>
    </label>
    <p v-if="lendo" class="muted">{{ lendo }}</p>

    <section v-if="linhas.length" class="card">
      <table class="items lote">
        <thead><tr><th>Nota</th><th>Prestador</th><th>Valor</th><th>Placa / OS</th><th>Lançar como</th><th>Situação</th><th></th></tr></thead>
        <tbody>
          <template v-for="l in linhas" :key="l.ref">
            <tr>
              <td><b>{{ l.p?.doc?.numero || l.arquivo }}</b><small class="muted block">{{ l.p?.doc?.date }}</small></td>
              <td>{{ l.fornecedorSel?.text || l.p?.doc?.prestador?.nome }}<small v-if="l.p && !l.p.fornecedor" class="msg block">não cadastrado</small></td>
              <td>{{ l.p ? fmt(l.valor) : '' }}</td>
              <td>
                <template v-if="l.p && !['lançada', 'na fila', 'lançando'].includes(l.estado)">
                  <input v-if="!l.osSel" :value="l.placa" @input="mudarPlaca(l, $event.target.value)" placeholder="placa" style="max-width: 110px" />
                  <select v-if="!l.osSel && (osAbertas(l).length > 1 || (l.osManual && osAbertas(l).length))" class="block" style="max-width: 170px; margin-top: 4px" @change="escolherOs(l, $event.target.value)">
                    <option value="">{{ osAbertas(l).length > 1 ? 'escolha a OS…' : 'automática pela placa' }}</option>
                    <option v-for="o in osAbertas(l)" :key="o.id" :value="o.id">OS {{ o.numero }}{{ o.data ? ' · ' + o.data : '' }}</option>
                  </select>
                  <span v-else-if="l.osSel" class="block">{{ l.osSel.text }} <a class="link" @click="trocarOs(l)">trocar</a></span>
                  <small v-else class="muted block">{{ placaFmt(l.placa) ? 'sem OS aberta para esta placa' + (pad.criarOs ? ' — cria nova' : '') : 'informe a placa' }}</small>
                </template>
                <span v-else>{{ l.resultado?.osNumero ? 'OS ' + l.resultado.osNumero : l.placa }}</span>
              </td>
              <td class="small">{{ efetivo(l).setItem?.text || '—' }}<br />{{ efetivo(l).produto?.text || '—' }}</td>
              <td>
                <span class="badge" :class="estado(l)[0]">{{ estado(l)[1] }}</span>
                <small v-if="l.estado === 'conferir' && pendencias(l).length" class="warnc block">falta: {{ pendencias(l).join(', ') }}</small>
                <a v-if="l.resultado?.qtdTelas && !l.aberta" class="link small block" @click="l.aberta = true">ver telas do ESL</a>
                <small v-if="l.erro" class="msg block">{{ l.erro }}</small>
                <small v-if="l.estado === 'bloqueada'" class="msg block">{{ (l.p?.duplicidade?.motivos || []).join(' ') }}</small>
                <small v-if="l.p?.duplicidade?.retomavel" class="warnc block">incompleta antes — será retomada</small>
              </td>
              <td><a class="link" @click="l.aberta = !l.aberta">{{ l.aberta ? 'fechar' : 'detalhes' }}</a>
                <a v-if="!['na fila', 'lançando'].includes(l.estado)" class="link muted" @click="remover(l)"> ✕</a></td>
            </tr>
            <tr v-if="l.aberta && l.p" class="sub">
              <td colspan="7">
                <div class="grid">
                  <label>Prestador no ESL<SearchPick v-model="l.fornecedorSel" :search="searchPeople" /></label>
                  <label>Item do conjunto (só esta)<SearchPick v-model="l.setItem" :search="searchSetItems" placeholder="usar padrão" /></label>
                  <label>Serviço (só esta)<SearchPick v-model="l.produto" :options="(l.p.servicosSugeridos || []).map((x) => ({ id: x.id, text: x.text }))" :search="searchServices" placeholder="usar padrão" /></label>
                  <label>Valor<input v-model="l.valor" /></label>
                  <label>Nº<input v-model="l.p.doc.numero" /></label>
                  <label>Data<input v-model="l.p.doc.date" /></label>
                  <label>OS específica
                    <select :value="l.osSel?.id ?? ''" @change="osEspecifica(l, $event.target.value)">
                      <option value="">automática pela placa</option>
                      <option v-for="o in (l.p.osSugeridas || []).filter((o) => o.status === 'pending')" :key="o.id" :value="o.id">OS {{ o.numero }} · {{ o.placa }}</option>
                    </select>
                  </label>
                </div>
                <p class="small muted">{{ l.p.doc.layout }} · {{ l.p.doc.discriminacao }}</p>
                <TelasEsl v-if="l.resultado && job" :job-id="job.id" :nref="l.ref" :qtd="l.resultado.qtdTelas" />
                <p v-if="l.resultado?.passos" class="small"><span v-for="(p, i) in l.resultado.passos" :key="i" :class="p.ok ? 'okc' : 'msg'">{{ p.etapa }}: {{ p.msg }}<br /></span></p>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </section>

    <TelaAoVivo :job="job" />
    <div v-if="linhas.length" class="actionbar">
      <span class="muted small">{{ linhas.length }} nota(s) · {{ prontas.length }} pronta(s) · {{ linhas.filter((l) => l.estado === 'lançada').length }} lançada(s)</span>
      <span v-if="job && !job.fim" class="small">Lançando {{ job.feitos + 1 }}/{{ job.total }}… <a class="link" @click="cancelar">parar após a atual</a></span>
      <span v-if="job?.loteId" class="small muted" title="Use este ID no Histórico para filtrar e imprimir os pedidos deste envio">{{ job.loteId }}</span>
      <span class="spacer" />
      <button class="ghost" @click="limpar">Limpar lista</button>
      <button class="big" :disabled="!prontas.length || (job && !job.fim) || !props.commitEnabled" @click="lancarTudo"
        :title="props.commitEnabled ? '' : 'Ative ALLOW_COMMIT=true no backend'">LANÇAR {{ prontas.length }} SERVIÇO(S)</button>
    </div>
  </div>
</template>
