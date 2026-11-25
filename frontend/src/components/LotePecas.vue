<script setup>
// Aba "XML de Peças" em lote: várias NF-e → cadastro das peças novas → entrada no estoque → aplicação na OS → baixa.
import { reactive, computed, watch, ref } from 'vue';
import { api } from '../api.js';
import SearchPick from './SearchPick.vue';
import TelasEsl from './TelasEsl.vue';
import TelaAoVivo from './TelaAoVivo.vue';
import { useLote, fmt, ls, save, placaFmt } from './useLote.js';

const props = defineProps({ commitEnabled: Boolean });
const TIPOS = [['corrective', 'Corretiva'], ['preventive', 'Preventiva'], ['preparation', 'Preparação'], ['damage', 'Avaria'], ['reform', 'Reforma'], ['help', 'Socorro']];

const pad = reactive(ls('lote_pec_padroes', {
  destino: 'os', filial: '', almoxarifado: null, solicitante: null, setItem: null, grupo: null, duvida: 'conferir',
  criarOs: true, filialOs: null, responsavel: '', tipo: 'corrective', oficina: 'outsourced', comentarioOs: '',
}));
watch(pad, (v) => save('lote_pec_padroes', v), { deep: true });
const filiais = ref([]);
const unidades = ref([]);
api.filiais().then((f) => (filiais.value = f)).catch(() => {});
api.units().then((u) => (unidades.value = u)).catch(() => {});

const searchPeople = async (t) => (await api.people(t)).map((p) => ({ id: p.id, text: p.nome, sub: p.documento }));
const searchParts = async (t) => (await api.products(t, 'part')).map((p) => ({ id: p.id, text: p.text, sub: `${p.grupo || ''} · ${p.unidade || ''}` }));
const searchSetItems = async (t) => (await api.setItems(t)).map((i) => ({ id: i.id, text: i.nome }));
const searchGroups = async (t) => (await api.groups(t)).map((g) => ({ id: g.id, text: g.nome }));
const searchWarehouses = async (t) => (await api.warehouses(t)).map((w) => ({ id: w.id, text: w.nome, sub: w.tipo }));
const searchEmployees = async (t) => (await api.employees(t)).map((e) => ({ id: e.id, text: e.nome, sub: e.filial }));

function montarLinha(p) {
  return {
    placa: p.veiculoSugerido?.placa || '',
    osSel: null,
    destino: null, // null = padrão do lote
    comentarioNf: '', // texto livre desta NF, vai no comentário da entrada depois do padrão
    fornecedorSel: p.fornecedor ? { id: p.fornecedor.id, text: p.fornecedor.nome } : null,
    filialNf: p.filial || '',
    itens: p.itens.map((it) => reactive({
      ...it,
      acao: it.situacao === 'certo' ? 'existente' : it.situacao === 'nenhum' ? 'cadastrar' : null, // null = dúvida
      produtoSel: it.produto ? { id: it.produto.id, text: it.produto.text } : null,
      opcoes: it.sugestoes.map((s) => ({ id: s.id, text: s.text, sub: `score ${s.score}` })),
      novo: reactive({ ...it.novo, setItem: null, group: null }),
    })),
  };
}
const { linhas, lendo, job, addFiles, lancar, cancelar, remover, limpar } = useLote('pecas', api.xmlPecasPreview, montarLinha);

/** Destino efetivo da nota: 'os' (entrada + OS + baixa) ou 'estoque' (só entrada). */
const destino = (l) => l.destino || pad.destino;

/** Ação efetiva do item, aplicando a política de dúvida do lote. */
const acao = (it) => it.acao || (pad.duvida === 'cadastrar' ? 'cadastrar' : null);
const novoOk = (it) => it.novo.code && it.novo.name && it.novo.unitId && (it.novo.setItem || pad.setItem) && (it.novo.group || pad.grupo);

/** OS abertas da placa desta nota (vindas da leitura do XML). Mais de uma → você escolhe antes de lançar. */
const osAbertas = (l) => (l.p?.osSugeridas || []).filter((o) => (!o.status || o.status === 'pending') && placaFmt(o.placa) === placaFmt(l.placa));
const escolherOs = (l, id) => {
  const o = osAbertas(l).find((x) => String(x.id) === String(id));
  l.osSel = o ? { id: o.id, text: `OS ${o.numero}` } : null;
};

function pendencias(l) {
  if (!l.p) return [];
  const f = [];
  if (!l.fornecedorSel) f.push('fornecedor no ESL');
  if (!(l.filialNf || pad.filial)) f.push('filial');
  if (!pad.almoxarifado) f.push('almoxarifado (padrões)');
  if (destino(l) === 'os') {
    if (!l.osSel && !placaFmt(l.placa)) f.push('placa ou OS');
    if (!l.osSel && osAbertas(l).length > 1) f.push(`escolher a OS (${osAbertas(l).length} abertas para ${placaFmt(l.placa)})`);
    if (!l.osSel && pad.criarOs && !pad.responsavel) f.push('responsável (padrões)');
  }
  const duv = l.itens.filter((it) => !acao(it) || (acao(it) === 'existente' && !it.produtoSel)).length;
  if (duv) f.push(`${duv} peça(s) para conferir`);
  const cad = l.itens.filter((it) => acao(it) === 'cadastrar' && !novoOk(it)).length;
  if (cad) f.push(`${cad} cadastro(s) incompleto(s) — defina conjunto/grupo padrão`);
  return f;
}
// nota com erro também pode ser lançada de novo (retoma de onde parou)
const prontas = computed(() => linhas.value.filter((l) => l.p && ['conferir', 'erro'].includes(l.estado) && !pendencias(l).length));
const totalLinha = (l) => (l.itens || []).reduce((a, i) => a + i.quantidade * i.valorUnitario, 0);
const total = computed(() => prontas.value.reduce((a, l) => a + totalLinha(l), 0));
const novas = (l) => (l.itens || []).filter((it) => acao(it) === 'cadastrar').length;

function payload(l) {
  const nf = l.p.nf;
  return {
    nf, date: l.p.date, time: l.p.time,
    fornecedor: { id: l.fornecedorSel.id, nome: l.fornecedorSel.text },
    filial: l.filialNf || pad.filial,
    almoxarifado: { id: pad.almoxarifado.id, nome: pad.almoxarifado.text },
    itens: l.itens.map((it) => {
      const a = acao(it);
      const set = it.novo.setItem || pad.setItem;
      const grp = it.novo.group || pad.grupo;
      return {
        nItem: it.nItem, cProd: it.cProd, descricao: it.descricao, quantidade: it.quantidade, valorUnitario: it.valorUnitario, desconto: it.desconto, frete: it.frete, acao: a,
        produto: a === 'existente' ? it.produtoSel : null,
        novo: a === 'cadastrar' ? { code: it.novo.code, name: it.novo.name, unitId: it.novo.unitId, unitText: unidades.value.find((u) => u.id === it.novo.unitId)?.nome, comments: it.novo.comments, setItemId: set.id, setItemText: set.text, groupId: grp.id, groupText: grp.text } : null,
      };
    }),
    os: destino(l) === 'estoque'
      ? { modo: 'nenhuma' }
      : l.osSel
      ? { modo: 'existente', id: l.osSel.id }
      : {
          modo: 'auto', placa: placaFmt(l.placa), criarSeNaoHouver: pad.criarOs,
          nova: {
            workshopType: pad.oficina, corporationId: pad.filialOs?.id, corporationText: pad.filialOs?.text, maintenanceType: pad.tipo,
            date: l.p.date, time: l.p.time, oficinaId: l.fornecedorSel.id, oficinaText: l.fornecedorSel.text, receptionResponsible: pad.responsavel,
          },
        },
    baixa: { employeeId: pad.solicitante?.id, employeeText: pad.solicitante?.text },
    comentarioOs: pad.comentarioOs,
    comentarioNf: l.comentarioNf || '',
  };
}

function lancarTudo() {
  const n = prontas.value.length;
  const cad = prontas.value.reduce((a, l) => a + novas(l), 0);
  const soEstoque = prontas.value.filter((l) => destino(l) === 'estoque').length;
  const comOs = n - soEstoque;
  if (!confirm(`Lançar ${n} NF(s) de peças (${fmt(total.value)})?\n\n${cad ? `• cadastrar ${cad} peça(s) nova(s)\n` : ''}• entrada no almoxarifado ${pad.almoxarifado.text} (todas)\n` +
    (comOs ? `• ${comOs} NF(s): aplicar na OS aberta de cada placa${pad.criarOs ? ' (ou criar nova)' : ''} e dar baixa\n` : '') +
    (soEstoque ? `• ${soEstoque} NF(s): só entrada no estoque (sem OS, sem baixa)` : ''))) return;
  lancar(prontas.value, payload);
}

/** Frase clara: lançou, não lançou ou lançou em parte. */
function resumo(l) {
  const r = l.resultado;
  if (!r || !['lançada', 'erro'].includes(l.estado)) return '';
  if (r.ok) return r.somenteEntrada ? `Lançada: entrada no estoque feita (NF de entrada id ${r.invoiceId}).` : `Lançada: entrada, OS ${r.osNumero} e baixa feitas.`;
  const feito = (r.passos || []).filter((p) => p.ok).map((p) => p.etapa);
  if (r.invoiceId) return `Lançada EM PARTE: a NF de entrada foi criada no ESL (id ${r.invoiceId}), e a automação já tentou corrigir sozinha (repetiu os itens e refez a NF), mas faltou o que está em vermelho abaixo. Veja a tela do erro e clique em lançar de novo — o que já está no ESL não é repetido.`;
  if (feito.some((e) => /Cadastro/.test(e))) return 'Não lançada no estoque. Só o cadastro de peça(s) foi feito. Lance de novo depois de corrigir.';
  return 'Não lançada: nada foi gravado no ESL.';
}
const ITEM_ETAPAS = [['cadastro', 'Cadastro'], ['entrada', 'Entrada'], ['os', 'OS'], ['baixa', 'Baixa']];

const ESTADO = { lendo: ['', 'lendo…'], conferir: ['warn', 'conferir'], bloqueada: ['err', 'já lançada'], erro: ['err', 'erro'], 'na fila': ['ready', 'na fila'], lançando: ['ready', 'lançando…'], lançada: ['ok', 'lançada'] };
const estado = (l) => (l.estado === 'conferir' && !pendencias(l).length ? ['ready', 'pronta'] : l.estado === 'erro' && l.resultado ? ['err', 'erro — pode lançar de novo'] : ESTADO[l.estado] || ['', l.estado]);
const SIT = { certo: 'ok', duvida: 'warn', nenhum: 'err' };
</script>

<template>
  <div class="xmltab">
    <section class="card">
      <h3>Padrões do lote <small class="muted">— preencha uma vez; valem para todas as notas</small></h3>
      <div class="grid">
        <label>O que fazer com as notas
          <select v-model="pad.destino"><option value="os">Entrada + aplicar na OS + baixa</option><option value="estoque">Só entrada no estoque (compra p/ estoque)</option></select>
        </label>
        <label>Filial (se o XML não indicar)
          <select v-model="pad.filial"><option value="">—</option><option v-for="f in filiais" :key="f.id" :value="f.nome">{{ f.nome }}</option></select>
        </label>
        <label>Almoxarifado *<SearchPick v-model="pad.almoxarifado" :search="searchWarehouses" placeholder="ex.: PEÇAS SBC" /></label>
        <label>Solicitante da baixa<SearchPick v-model="pad.solicitante" :search="searchEmployees" placeholder="funcionário" /></label>
        <label>Peças novas: conjunto e item<SearchPick v-model="pad.setItem" :search="searchSetItems" placeholder="ex.: Diversos - Peças" /></label>
        <label>Peças novas: grupo<SearchPick v-model="pad.grupo" :search="searchGroups" placeholder="ex.: MECANICA" /></label>
        <label>Peça com correspondência duvidosa
          <select v-model="pad.duvida"><option value="conferir">deixar para eu conferir</option><option value="cadastrar">cadastrar como nova</option></select>
        </label>
        <label class="wide">Comentário na OS (opcional)<input v-model="pad.comentarioOs" /></label>
        <label v-if="pad.destino === 'os'" class="inline"><input type="checkbox" v-model="pad.criarOs" /> Sem OS aberta para a placa → criar nova OS</label>
        <template v-if="pad.criarOs && pad.destino === 'os'">
          <label>Filial da nova OS
            <select v-model="pad.filialOs"><option :value="null">—</option><option v-for="f in filiais" :key="f.id" :value="{ id: f.id, text: f.nome }">{{ f.nome }}</option></select>
          </label>
          <label>Oficina da nova OS<select v-model="pad.oficina"><option value="outsourced">Terceirizada (= fornecedor)</option><option value="own">Própria</option></select></label>
          <label>Responsável recepção *<input v-model="pad.responsavel" /></label>
          <label>Tipo manutenção<select v-model="pad.tipo"><option v-for="[v, t] in TIPOS" :key="v" :value="v">{{ t }}</option></select></label>
        </template>
      </div>
    </section>

    <label class="drop" @dragover.prevent @drop.prevent="addFiles($event.dataTransfer.files)">
      <input type="file" accept=".xml" multiple hidden @change="addFiles($event.target.files); $event.target.value = ''" />
      <strong>Solte aqui VÁRIOS XMLs de NF-e de PEÇAS</strong>
      <small class="muted">cada nota: cadastro das peças novas → entrada no estoque → aplicação na OS → baixa</small>
    </label>
    <p v-if="lendo" class="muted">{{ lendo }}</p>

    <section v-if="linhas.length" class="card">
      <table class="items lote">
        <thead><tr><th>NF</th><th>Fornecedor</th><th>Itens</th><th>Total</th><th>Destino / placa</th><th>Situação</th><th></th></tr></thead>
        <tbody>
          <template v-for="l in linhas" :key="l.ref">
            <tr>
              <td><b>{{ l.p?.nf.numero || l.arquivo }}</b><small class="muted block">{{ l.p?.date }}</small></td>
              <td>{{ l.fornecedorSel?.text || l.p?.nf.emitente.nome }}<small v-if="l.p && !l.p.fornecedor" class="msg block">não cadastrado</small>
                <template v-if="l.p && !['lançada', 'na fila', 'lançando'].includes(l.estado)">
                  <textarea v-model="l.comentarioNf" maxlength="500" rows="1" class="coment" placeholder="comentário desta NF (opcional)"></textarea>
                  <small v-if="l.comentarioNf" class="muted block">{{ l.comentarioNf.length }}/500</small>
                </template>
                <small v-else-if="l.comentarioNf" class="muted block">“{{ l.comentarioNf }}”</small>
              </td>
              <td class="small" v-if="l.itens">{{ l.itens.length }} item(ns)<span v-if="novas(l)"> · {{ novas(l) }} nova(s)</span></td><td v-else></td>
              <td>{{ l.itens ? fmt(totalLinha(l)) : '' }}</td>
              <td>
                <template v-if="l.p && !['lançada', 'na fila', 'lançando'].includes(l.estado)">
                  <select :value="destino(l)" @change="l.destino = $event.target.value" style="max-width: 150px; margin-bottom: 4px">
                    <option value="os">aplicar em OS</option><option value="estoque">só estoque</option>
                  </select>
                  <template v-if="destino(l) === 'os'">
                    <input v-if="!l.osSel" v-model="l.placa" placeholder="placa" style="max-width: 110px" />
                    <select v-if="!l.osSel && osAbertas(l).length > 1" class="block" style="max-width: 170px; margin-top: 4px" @change="escolherOs(l, $event.target.value)">
                      <option value="">escolha a OS…</option>
                      <option v-for="o in osAbertas(l)" :key="o.id" :value="o.id">OS {{ o.numero }}{{ o.data ? ' · ' + o.data : '' }}</option>
                    </select>
                    <span v-else>{{ l.osSel.text }} <a class="link" @click="l.osSel = null">trocar</a></span>
                  </template>
                </template>
                <span v-else>{{ l.resultado?.somenteEntrada ? 'só estoque' : l.resultado?.osNumero ? 'OS ' + l.resultado.osNumero : destino(l) === 'estoque' ? 'só estoque' : l.placa }}</span>
              </td>
              <td>
                <span class="badge" :class="estado(l)[0]">{{ estado(l)[1] }}</span>
                <small v-if="l.estado === 'conferir' && pendencias(l).length" class="warnc block">falta: {{ pendencias(l).join(', ') }}</small>
                <a v-if="l.resultado?.qtdTelas && !l.aberta" class="link small block" @click="l.aberta = true">ver telas do ESL</a>
                <small v-if="resumo(l)" class="block" :class="l.resultado?.ok ? 'okc' : 'msg'"><b>{{ resumo(l) }}</b></small>
                <small v-if="l.erro && !l.resultado?.itens" class="msg block">{{ l.erro }}</small>
                <a v-if="l.resultado?.itens && !l.aberta" class="link small" @click="l.aberta = true">ver item por item</a>
                <small v-if="l.estado === 'bloqueada'" class="msg block">{{ l.p?.duplicidade.motivos.join(' ') }}</small>
                <small v-if="l.p?.duplicidade.retomavel" class="warnc block">incompleta antes — será retomada</small>
              </td>
              <td><a class="link" @click="l.aberta = !l.aberta">{{ l.aberta ? 'fechar' : 'detalhes' }}</a>
                <a v-if="!['na fila', 'lançando'].includes(l.estado)" class="link muted" @click="remover(l)"> ✕</a></td>
            </tr>
            <tr v-if="l.aberta && l.p" class="sub">
              <td colspan="7">
                <div class="grid">
                  <label>Fornecedor no ESL<SearchPick v-model="l.fornecedorSel" :search="searchPeople" /></label>
                  <label>Filial desta NF
                    <select v-model="l.filialNf"><option value="">usar padrão</option><option v-for="f in filiais" :key="f.id" :value="f.nome">{{ f.nome }}</option></select>
                  </label>
                  <label v-if="destino(l) === 'os'">OS específica
                    <select @change="l.osSel = $event.target.value ? { id: +$event.target.value, text: 'OS ' + $event.target.selectedOptions[0].dataset.n } : null">
                      <option value="">automática pela placa</option>
                      <option v-for="o in l.p.osSugeridas" :key="o.id" :value="o.id" :data-n="o.numero">OS {{ o.numero }} · {{ o.placa }}</option>
                    </select>
                  </label>
                </div>
                <table class="items compact">
                  <thead><tr><th>Código</th><th>Descrição</th><th>Qtd</th><th>Unit.</th><th>Peça no ESL</th></tr></thead>
                  <tbody>
                    <tr v-for="it in l.itens" :key="it.nItem">
                      <td>{{ it.cProd }}</td><td>{{ it.descricao }}</td><td>{{ it.quantidade }} {{ it.unidade }}</td><td>{{ fmt(it.valorUnitario) }}<small v-if="it.desconto" class="muted block">desconto do item {{ fmt(it.desconto) }} (vai no cabeçalho)</small></td>
                      <td class="pick-cell">
                        <span class="badge" :class="SIT[it.situacao]">{{ it.situacao === 'certo' ? 'encontrada' : it.situacao === 'duvida' ? 'dúvida' : 'nova' }}</span>
                        <div class="seg small">
                          <button type="button" :class="{ on: acao(it) === 'existente' }" @click="it.acao = 'existente'">existente</button>
                          <button type="button" :class="{ on: acao(it) === 'cadastrar' }" @click="it.acao = 'cadastrar'">cadastrar</button>
                        </div>
                        <SearchPick v-if="acao(it) === 'existente'" v-model="it.produtoSel" :options="it.opcoes" :search="searchParts" placeholder="escolher peça" />
                        <div v-else-if="acao(it) === 'cadastrar'" class="grid">
                          <label>Código<input v-model="it.novo.code" /></label>
                          <label>Nome<input v-model="it.novo.name" /></label>
                          <label>Unidade<select v-model="it.novo.unitId"><option :value="null">—</option><option v-for="u in unidades" :key="u.id" :value="u.id">{{ u.nome }}</option></select></label>
                          <label>Conjunto<SearchPick v-model="it.novo.setItem" :search="searchSetItems" :placeholder="pad.setItem?.text || 'padrão'" /></label>
                          <label>Grupo<SearchPick v-model="it.novo.group" :search="searchGroups" :placeholder="pad.grupo?.text || 'padrão'" /></label>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
                <template v-if="l.resultado?.itens">
                  <h4 class="small" style="margin: 10px 0 4px">Resultado item por item</h4>
                  <table class="items compact">
                    <thead><tr><th>#</th><th>Código</th><th>Descrição</th><th>Qtd × unit.</th><th v-for="[k, t] in ITEM_ETAPAS" :key="k">{{ t }}</th></tr></thead>
                    <tbody>
                      <tr v-for="it in l.resultado.itens" :key="it.nItem">
                        <td>{{ it.nItem }}</td><td>{{ it.cProd }}</td><td>{{ it.descricao }}</td><td>{{ it.quantidade }} × {{ fmt(it.valorUnitario) }}</td>
                        <td v-for="[k] in ITEM_ETAPAS" :key="k" :class="it[k] ? (it[k].ok ? 'okc' : 'msg') : 'muted'">
                          {{ it[k] ? (it[k].ok ? '✓ ' : '✗ ') + it[k].msg : '—' }}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </template>
                <TelasEsl v-if="l.resultado && job" :job-id="job.id" :nref="l.ref" :qtd="l.resultado.qtdTelas" />
                <details v-if="l.resultado?.passos" class="small"><summary>passo a passo</summary>
                  <span v-for="(p, i) in l.resultado.passos" :key="i" :class="p.ok ? 'okc' : 'msg'">{{ p.etapa }}: {{ p.msg }}<br /></span></details>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </section>

    <TelaAoVivo :job="job" />
    <div v-if="linhas.length" class="actionbar">
      <span class="muted small">{{ linhas.length }} NF(s) · {{ prontas.length }} pronta(s) · {{ linhas.filter((l) => l.estado === 'lançada').length }} lançada(s)</span>
      <span v-if="job && !job.fim" class="small">Lançando {{ job.feitos + 1 }}/{{ job.total }}… <a class="link" @click="cancelar">parar após a atual</a></span>
      <span class="spacer" />
      <button class="ghost" @click="limpar">Limpar lista</button>
      <button class="big" :disabled="!prontas.length || (job && !job.fim) || !props.commitEnabled" @click="lancarTudo"
        :title="props.commitEnabled ? '' : 'Ative ALLOW_COMMIT=true no backend'">LANÇAR {{ prontas.length }} NF(S) DE PEÇAS</button>
    </div>
  </div>
</template>
