<script setup>
// Lançamento automatizado de XML — duas abas independentes (o tipo é escolhido ANTES do upload).
import { ref, reactive, computed } from 'vue';
import { api } from '../api.js';
import LoteServicos from './LoteServicos.vue';
import LotePecas from './LotePecas.vue';

defineProps({ commitEnabled: Boolean });

const aba = ref(sessionStorage.getItem('xml_aba') || 'servicos');
const historico = ref(null);
const ST = { concluido: ['ok', 'concluído'], em_andamento: ['warn', 'em andamento'], erro: ['err', 'incompleto'] };

// Filtros do histórico (lote, situação, NF, período) — o "Imprimir Tudo" usa os mesmos
const filtros = reactive({ lote: '', status: '', nf: '', de: '', ate: '' });
const carregando = ref(false);
const imprimindo = ref(''); // docKey em impressão, ou 'tudo'
const aviso = ref('');
const lotesConhecidos = computed(() => [...new Set((historico.value || []).flatMap((r) => r.lotes || (r.lote ? [r.lote] : [])))].sort().reverse());
const imprimiveis = computed(() => (historico.value || []).filter(podeImprimir));

function trocar(a) {
  aba.value = a;
  sessionStorage.setItem('xml_aba', a);
}
async function carregar() {
  carregando.value = true;
  aviso.value = '';
  try {
    historico.value = await api.xmlHistorico({ ...filtros });
  } catch (e) {
    historico.value = [{ erro: e.message }];
  } finally {
    carregando.value = false;
  }
}
async function verHistorico() {
  if (historico.value) historico.value = null;
  else await carregar();
}
function limparFiltros() {
  Object.assign(filtros, { lote: '', status: '', nf: '', de: '', ate: '' });
  carregar();
}
const filtrarPorLote = (l) => {
  filtros.lote = l;
  carregar();
};

/** Nota inserida com sucesso, de peças, com pedido de compra (o PDF já salvo ou capturável agora). */
const podeImprimir = (r) => r.status === 'concluido' && r.tipo === 'pecas' && !!r.pedidoId;

/** Carrega o PDF num iframe oculto e abre a impressão nativa do navegador (impressora da máquina do usuário). */
function imprimirBlob(blob) {
  const url = URL.createObjectURL(blob);
  let f = document.getElementById('esl-print-frame');
  if (!f) {
    f = document.createElement('iframe');
    f.id = 'esl-print-frame';
    f.title = 'impressão';
    // fora da tela, mas renderizado (com display:none o leitor de PDF não carrega e o print() falha)
    f.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;height:600px;border:0;opacity:0;';
    document.body.appendChild(f);
  }
  f.onload = () =>
    setTimeout(() => {
      try {
        f.contentWindow.focus();
        f.contentWindow.print();
      } catch {
        window.open(url, '_blank'); // navegador bloqueou: abre o PDF numa aba para imprimir de lá
      }
    }, 400);
  f.src = url;
  setTimeout(() => URL.revokeObjectURL(url), 10 * 60_000);
}
async function imprimir(r) {
  imprimindo.value = r.docKey;
  aviso.value = '';
  try {
    imprimirBlob((await api.pedidoPdf(r.docKey)).blob);
    if (!r.temPdf) r.temPdf = true; // foi capturado agora
  } catch (e) {
    aviso.value = `NF ${r.numero}: ${e.message}`;
  } finally {
    imprimindo.value = '';
  }
}
/** Pega o que já foi lançado: dá lote às notas antigas e captura os PDFs de pedido que faltam (repete até acabar). */
const completando = ref('');
async function completarHistorico() {
  completando.value = 'Começando…';
  aviso.value = '';
  let lotes = 0;
  let feitos = 0;
  const falhas = [];
  try {
    for (let volta = 0; volta < 40; volta++) {
      const r = await api.completarHistorico();
      lotes += r.lotesAtribuidos;
      feitos += r.capturados.length;
      falhas.push(...r.falhas);
      completando.value = `PDFs gerados: ${feitos}${r.restantes ? ` · faltam ${r.restantes}` : ''}…`;
      if (!r.restantes || (!r.capturados.length && r.falhas.length)) break; // acabou, ou só falhando (ex.: login caiu)
    }
    aviso.value = [
      lotes && `${lotes} nota(s) antigas ganharam lote (LOTE-…-ANT)`,
      `${feitos} PDF(s) de pedido gerados`,
      falhas.length && `sem PDF: ${falhas.map((f) => `NF ${f.numero} (${f.motivo})`).join('; ')}`,
    ].filter(Boolean).join(' · ');
    await carregar();
  } catch (e) {
    aviso.value = e.message;
  } finally {
    completando.value = '';
  }
}
async function imprimirTudo() {
  imprimindo.value = 'tudo';
  aviso.value = '';
  try {
    // sempre só as notas inseridas com sucesso; respeita lote, NF e período dos filtros
    const { blob, incluidos, faltaram } = await api.pedidosPdf({ lote: filtros.lote, nf: filtros.nf, de: filtros.de, ate: filtros.ate, status: 'concluido' });
    imprimirBlob(blob);
    aviso.value = faltaram ? `${incluidos} pedido(s) enviados para impressão. Ficaram de fora: ${faltaram}` : `${incluidos} pedido(s) enviados para impressão.`;
  } catch (e) {
    aviso.value = e.message;
  } finally {
    imprimindo.value = '';
  }
}
</script>

<template>
  <div class="xml">
    <nav class="xmltabs">
      <button :class="{ active: aba === 'servicos' }" @click="trocar('servicos')">XML de Serviços</button>
      <button :class="{ active: aba === 'pecas' }" @click="trocar('pecas')">XML de Peças</button>
      <span class="spacer" />
      <button class="ghost" @click="verHistorico">{{ historico ? 'Fechar histórico' : 'Histórico' }}</button>
    </nav>

    <section v-if="historico" class="card">
      <h3>Histórico de lançamentos</h3>
      <form class="grid" @submit.prevent="carregar">
        <label>ID do lote
          <input v-model.trim="filtros.lote" list="lotes-conhecidos" placeholder="LOTE-AAAAMMDD-XXXX" />
          <datalist id="lotes-conhecidos"><option v-for="l in lotesConhecidos" :key="l" :value="l" /></datalist>
        </label>
        <label>Situação
          <select v-model="filtros.status">
            <option value="">todas</option>
            <option value="concluido">sucesso / inserida</option>
            <option value="erro">incompleto</option>
            <option value="em_andamento">em andamento</option>
          </select>
        </label>
        <label>Nº da NF<input v-model.trim="filtros.nf" inputmode="numeric" placeholder="ex.: 35029" /></label>
        <label>De<input v-model="filtros.de" type="date" /></label>
        <label>Até<input v-model="filtros.ate" type="date" /></label>
      </form>
      <div class="row" style="margin-top: 10px">
        <button type="button" :disabled="carregando" @click="carregar">{{ carregando ? 'Buscando…' : 'Filtrar' }}</button>
        <button type="button" class="ghost" @click="limparFiltros">Limpar filtros</button>
        <button type="button" class="ghost" :disabled="!!completando || !!imprimindo" @click="completarHistorico"
          title="Pega o que já foi lançado: lote para as notas antigas e PDF do pedido de compra das notas concluídas que ainda não têm">
          {{ completando || 'Completar histórico' }}
        </button>
        <span class="spacer" />
        <button type="button" :disabled="!imprimiveis.length || !!imprimindo" @click="imprimirTudo"
          :title="'Um PDF só com os pedidos de compra das notas inseridas com sucesso' + (filtros.lote ? ' do lote ' + filtros.lote : ' dos filtros')">
          {{ imprimindo === 'tudo' ? 'Preparando…' : `Imprimir Tudo (${imprimiveis.length})` }}
        </button>
      </div>
      <p v-if="aviso" class="small" :class="/de fora|não|erro|sem sessão/i.test(aviso) ? 'warnc' : 'muted'">{{ aviso }}</p>
      <table class="items compact">
        <thead><tr><th>Início</th><th>Lote</th><th>Tipo</th><th>Nota</th><th>Fornecedor</th><th>Valor</th><th>Pedido / OS</th><th>Situação</th><th>Usuário</th><th></th></tr></thead>
        <tbody>
          <tr v-for="r in historico" :key="r.docKey || r.erro">
            <template v-if="r.erro && !r.docKey"><td colspan="10" class="msg">{{ r.erro }}</td></template>
            <template v-else>
              <td>{{ r.inicio ? new Date(r.inicio).toLocaleString('pt-BR') : '' }}</td>
              <td><a v-if="r.lote" class="link small" title="Filtrar por este lote" @click="filtrarPorLote(r.lote)">{{ r.lote }}</a></td>
              <td>{{ r.tipo === 'pecas' ? 'Peças' : 'Serviço' }}</td>
              <td>{{ r.numero }}<small v-if="r.serie" class="muted"> s{{ r.serie }}</small></td>
              <td>{{ r.fornecedor }}</td>
              <td>{{ Number(r.valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) }}</td>
              <td>
                <span v-if="r.pedidoNumero">Pedido {{ r.pedidoNumero }}</span>
                <span v-if="r.etapas?.os?.numero" class="block">OS {{ r.etapas.os.numero }}</span>
              </td>
              <td><span class="badge" :class="ST[r.status]?.[0]">{{ ST[r.status]?.[1] || r.status }}</span><small v-if="r.erro" class="muted block">{{ r.erro }}</small></td>
              <td class="small">{{ r.usuario }}</td>
              <td>
                <button v-if="podeImprimir(r)" type="button" class="ghost small" :disabled="!!imprimindo" @click="imprimir(r)"
                  :title="r.temPdf ? 'Imprimir o pedido de compra' : 'O PDF ainda não foi capturado: gera agora pelo ESL e imprime'">
                  {{ imprimindo === r.docKey ? '…' : 'Imprimir' }}
                </button>
                <small v-if="podeImprimir(r) && r.impressaoErro" class="warnc block" :title="r.impressaoErro">PDF não capturado no lançamento</small>
              </td>
            </template>
          </tr>
          <tr v-if="!historico.length"><td colspan="10" class="muted">Nenhum lançamento com esses filtros.</td></tr>
        </tbody>
      </table>
    </section>

    <KeepAlive>
      <LoteServicos v-if="aba === 'servicos'" :commit-enabled="commitEnabled" />
      <LotePecas v-else :commit-enabled="commitEnabled" />
    </KeepAlive>
  </div>
</template>
