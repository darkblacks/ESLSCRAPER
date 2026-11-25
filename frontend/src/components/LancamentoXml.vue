<script setup>
// Lançamento automatizado de XML — duas abas independentes (o tipo é escolhido ANTES do upload).
import { ref } from 'vue';
import { api } from '../api.js';
import LoteServicos from './LoteServicos.vue';
import LotePecas from './LotePecas.vue';

defineProps({ commitEnabled: Boolean });

const aba = ref(sessionStorage.getItem('xml_aba') || 'servicos');
const historico = ref(null);
const ST = { concluido: ['ok', 'concluído'], em_andamento: ['warn', 'em andamento'], erro: ['err', 'incompleto'] };

function trocar(a) {
  aba.value = a;
  sessionStorage.setItem('xml_aba', a);
}
async function verHistorico() {
  historico.value = historico.value ? null : await api.xmlHistorico().catch((e) => [{ erro: e.message }]);
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
      <table class="items compact">
        <thead><tr><th>Início</th><th>Tipo</th><th>Nota</th><th>Fornecedor</th><th>Valor</th><th>OS</th><th>Situação</th><th>Usuário</th></tr></thead>
        <tbody>
          <tr v-for="r in historico" :key="r.docKey">
            <td>{{ r.inicio ? new Date(r.inicio).toLocaleString('pt-BR') : '' }}</td>
            <td>{{ r.tipo === 'pecas' ? 'Peças' : 'Serviço' }}</td>
            <td>{{ r.numero }}<small v-if="r.serie" class="muted"> s{{ r.serie }}</small></td>
            <td>{{ r.fornecedor }}</td>
            <td>{{ Number(r.valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) }}</td>
            <td>{{ r.etapas?.os?.numero || '' }}</td>
            <td><span class="badge" :class="ST[r.status]?.[0]">{{ ST[r.status]?.[1] || r.status }}</span><small v-if="r.erro" class="muted block">{{ r.erro }}</small></td>
            <td class="small">{{ r.usuario }}</td>
          </tr>
          <tr v-if="!historico.length"><td colspan="8" class="muted">Nenhum lançamento ainda.</td></tr>
        </tbody>
      </table>
    </section>

    <KeepAlive>
      <LoteServicos v-if="aba === 'servicos'" :commit-enabled="commitEnabled" />
      <LotePecas v-else :commit-enabled="commitEnabled" />
    </KeepAlive>
  </div>
</template>
