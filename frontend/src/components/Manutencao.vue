<script setup>
// Manutenção: XMLs de NF-e de peças → Ordem de Serviço no ESL.
import { ref, computed } from 'vue';
import { api } from '../api.js';
import SearchPick from './SearchPick.vue';

const props = defineProps({ commitEnabled: Boolean });

const TIPOS = [
  ['corrective', 'Corretiva'], ['preventive', 'Preventiva'], ['preparation', 'Preparação'],
  ['damage', 'Avaria'], ['reform', 'Reforma'], ['help', 'Socorro'],
];

const responsavel = ref(localStorage.getItem('mnt_responsavel') || '');
const notas = ref([]); // um card por XML
const loading = ref(false);
const error = ref('');
const dragging = ref(false);

const fmt = (n) => Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

const searchVehicles = async (t) =>
  (await api.vehicles(t)).map((v) => ({ id: v.id, text: v.placa, sub: `${v.modelo || ''} · hod. ${v.hodometro ?? '-'}`, hodometro: v.hodometro }));
const searchProducts = async (t) =>
  (await api.products(t)).map((p) => ({ id: p.id, text: p.text, sub: `${p.tipo || ''} · ${p.unidade || ''}${p.ultimoValor ? ' · último ' + fmt(p.ultimoValor) : ''}` }));
const searchPeople = async (t) => (await api.people(t)).map((p) => ({ id: p.id, text: p.nome, sub: p.documento }));

async function readFiles(fileList) {
  const files = [];
  for (const f of fileList) {
    if (!/\.xml$/i.test(f.name)) continue;
    files.push({ name: f.name, content: await f.text() });
  }
  if (!files.length) {
    error.value = 'Nenhum arquivo .xml selecionado.';
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    const prev = await api.mntPreview(files);
    for (const p of prev) notas.value.push(montarCard(p));
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

function montarCard(p) {
  if (!p.ok) return { ...p, status: 'erro' };
  const nf = p.nf;
  const items = p.items.map((it) => {
    const sug = it.sugestoes.map((s) => ({ id: s.id, text: s.text, sub: `${s.tipo || ''} · score ${s.score}` }));
    const escolhido = it.aprendido || (it.sugestoes[0]?.score >= 80 ? { id: it.sugestoes[0].id, text: it.sugestoes[0].text } : null);
    return { ...it, opcoes: sug, produto: escolhido, auto: !!it.aprendido };
  });
  const v = p.veiculoSugerido;
  return {
    ...p,
    status: p.jaLancada ? 'lancada' : 'pendente',
    items,
    form: {
      veiculo: v ? { id: v.id, text: v.placa, hodometro: v.hodometro } : null,
      odometer: v?.hodometro ?? '',
      maintenanceType: 'corrective',
      date: p.date,
      time: p.time,
      oficina: p.fornecedor ? { id: p.fornecedor.id, text: p.fornecedor.nome } : null,
      description: `Peças NF ${nf.numero} - ${nf.emitente.nome}`,
      comments: `NF ${nf.numero} série ${nf.serie} - chave ${nf.chave}`,
    },
    result: null,
  };
}

function onVehicle(card, v) {
  card.form.veiculo = v;
  if (v?.hodometro != null) card.form.odometer = v.hodometro;
}

const pronta = (c) =>
  c.ok && c.form.veiculo && c.form.oficina && c.form.date && responsavel.value && c.items.every((i) => i.produto);

function payload(c, commit) {
  localStorage.setItem('mnt_responsavel', responsavel.value);
  return {
    commit,
    chave: c.nf.chave,
    numero: c.nf.numero,
    cnpj: c.nf.emitente.cnpj,
    fornecedorNome: c.nf.emitente.nome,
    os: {
      vehicleId: c.form.veiculo?.id, vehicleText: c.form.veiculo?.text,
      odometer: c.form.odometer, maintenanceType: c.form.maintenanceType,
      date: c.form.date, time: c.form.time,
      oficinaId: c.form.oficina?.id, oficinaText: c.form.oficina?.text,
      receptionResponsible: responsavel.value,
      description: c.form.description, comments: c.form.comments,
    },
    items: c.items.map((i) => ({
      cProd: i.cProd, productId: i.produto?.id, productText: i.produto?.text,
      quantidade: i.quantidade, valorUnitario: i.valorUnitario,
    })),
  };
}

async function enviar(c, commit) {
  if (commit && !confirm(`Lançar a OS da NF ${c.nf.numero} (${c.nf.emitente.nome}) no ESL?`)) return;
  c.busy = true;
  c.result = null;
  try {
    c.result = await api.mntLancar(payload(c, commit));
    if (c.result.committed) c.status = 'lancada';
  } catch (e) {
    c.result = { error: e.message };
  } finally {
    c.busy = false;
  }
}

async function lancarTodas() {
  const prontas = notas.value.filter((c) => c.status === 'pendente' && pronta(c));
  if (!prontas.length || !confirm(`Lançar ${prontas.length} OS no ESL, uma por vez?`)) return;
  for (const c of prontas) {
    c.busy = true;
    try {
      c.result = await api.mntLancar(payload(c, true));
      if (c.result.committed) c.status = 'lancada';
    } catch (e) {
      c.result = { error: e.message };
    } finally {
      c.busy = false;
    }
  }
}

const resumo = computed(() => ({
  total: notas.value.length,
  prontas: notas.value.filter((c) => c.status === 'pendente' && pronta(c)).length,
  lancadas: notas.value.filter((c) => c.status === 'lancada').length,
}));
</script>

<template>
  <div class="mnt">
    <div class="card row">
      <label class="inline">Responsável pela recepção
        <input v-model="responsavel" placeholder="ex.: EDUARDO" style="max-width: 200px" />
      </label>
      <span class="spacer" />
      <span class="muted">{{ resumo.total }} NFs · {{ resumo.prontas }} prontas · {{ resumo.lancadas }} lançadas</span>
      <button :disabled="!resumo.prontas || !props.commitEnabled" @click="lancarTodas"
        :title="props.commitEnabled ? '' : 'Ative ALLOW_COMMIT=true no backend'">Lançar todas as prontas</button>
      <button class="ghost" @click="notas = []">Limpar</button>
    </div>

    <label class="drop" :class="{ on: dragging }"
      @dragover.prevent="dragging = true" @dragleave="dragging = false"
      @drop.prevent="dragging = false; readFiles($event.dataTransfer.files)">
      <input type="file" accept=".xml" multiple hidden @change="readFiles($event.target.files); $event.target.value = ''" />
      <strong>Solte os XMLs das notas aqui</strong> ou clique para escolher
      <small class="muted">cada XML vira uma Ordem de Serviço com as peças da nota</small>
    </label>
    <p v-if="loading" class="muted">Lendo XMLs e consultando o ESL…</p>
    <p v-if="error" class="msg">{{ error }}</p>

    <div v-for="(c, idx) in notas" :key="idx" class="card nf" :class="c.status">
      <template v-if="!c.ok">
        <b>{{ c.arquivo }}</b> <span class="msg">{{ c.error }}</span>
      </template>
      <template v-else>
        <div class="nf-head">
          <div>
            <b>NF {{ c.nf.numero }}</b> · {{ c.nf.emitente.nome }}
            <div class="muted small">{{ c.date }} {{ c.time }} · {{ fmt(c.nf.valorNota) }} · {{ c.items.length }} item(ns)
              · pedido fornecedor {{ c.nf.pedidoNoTexto || '-' }}
              <span v-if="c.notaCompraId"> · nota na SEFAZ/ESL ✓</span></div>
          </div>
          <span class="spacer" />
          <span v-if="c.status === 'lancada'" class="badge ok">lançada{{ c.jaLancada?.osNumero ? ' · OS ' + c.jaLancada.osNumero : c.result?.osNumero ? ' · OS ' + c.result.osNumero : '' }}</span>
          <span v-else-if="pronta(c)" class="badge ready">pronta</span>
          <span v-else class="badge warn">falta conferir</span>
        </div>

        <p v-if="!c.fornecedor" class="msg small">Fornecedor CNPJ {{ c.nf.emitente.cnpj }} não encontrado no ESL — escolha a oficina manualmente.</p>

        <div class="grid">
          <label>Veículo (placa) *
            <SearchPick :model-value="c.form.veiculo" @update:model-value="onVehicle(c, $event)" :search="searchVehicles" placeholder="buscar placa" />
          </label>
          <label>Hodômetro *<input v-model="c.form.odometer" inputmode="numeric" /></label>
          <label>Tipo manutenção
            <select v-model="c.form.maintenanceType"><option v-for="[v, t] in TIPOS" :key="v" :value="v">{{ t }}</option></select>
          </label>
          <label>Data<input v-model="c.form.date" placeholder="dd/mm/aaaa" /></label>
          <label>Hora<input v-model="c.form.time" placeholder="hh:mm" /></label>
          <label>Oficina *
            <SearchPick v-model="c.form.oficina" :search="searchPeople" placeholder="buscar oficina/fornecedor" />
          </label>
          <label class="wide">Descrição do serviço<input v-model="c.form.description" /></label>
          <label class="wide">Observação (oficina)<input v-model="c.form.comments" /></label>
        </div>

        <table class="items">
          <thead><tr><th>Código NF</th><th>Descrição na NF</th><th>Qtd</th><th>Unit.</th><th>Total</th><th>Peça no ESL *</th></tr></thead>
          <tbody>
            <tr v-for="it in c.items" :key="it.nItem">
              <td>{{ it.cProd }}<small v-if="it.oem" class="muted"> OEM {{ it.oem }}</small></td>
              <td>{{ it.descricao }}</td>
              <td>{{ it.quantidade }} {{ it.unidade }}</td>
              <td>{{ fmt(it.valorUnitario) }}</td>
              <td>{{ fmt(it.valorTotal) }}</td>
              <td class="pick-cell">
                <SearchPick v-model="it.produto" :options="it.opcoes" :search="searchProducts" placeholder="escolher peça" />
                <small v-if="it.auto" class="muted">já usada antes p/ este código</small>
              </td>
            </tr>
          </tbody>
        </table>

        <div class="row">
          <button class="ghost" :disabled="c.busy" @click="enviar(c, false)">Simular (não salva)</button>
          <button :disabled="c.busy || !pronta(c) || c.status === 'lancada' || !props.commitEnabled" @click="enviar(c, true)">
            {{ c.busy ? 'Lançando…' : 'Lançar OS no ESL' }}
          </button>
        </div>

        <div v-if="c.result" class="result">
          <p v-if="c.result.error" class="msg">{{ c.result.error }}</p>
          <p v-if="c.result.message">{{ c.result.message }}</p>
          <p v-if="c.result.committed">
            OS <b>{{ c.result.osNumero }}</b> criada ·
            peças {{ c.result.pecas.filter((p) => p.ok).length }}/{{ c.result.pecas.length }} ·
            total esperado {{ fmt(c.result.conferencia.esperado) }} / gravado {{ fmt(c.result.conferencia.gravado) }}
            <b :class="c.result.conferencia.bate ? 'okc' : 'msg'">{{ c.result.conferencia.bate ? '✓ confere' : '✗ conferir no ESL' }}</b>
          </p>
          <ul v-if="c.result.formErrors?.length || c.result.pecas?.some((p) => !p.ok)" class="msg">
            <li v-for="e in c.result.formErrors" :key="e">{{ e }}</li>
            <li v-for="p in (c.result.pecas || []).filter((p) => !p.ok)" :key="p.cProd">{{ p.cProd }}: {{ p.error }}</li>
          </ul>
          <details v-if="c.result.screenshot"><summary>ver tela do ESL</summary>
            <img :src="'data:image/jpeg;base64,' + c.result.screenshot" />
          </details>
        </div>
      </template>
    </div>
  </div>
</template>
