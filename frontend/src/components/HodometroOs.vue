<script setup>
import { editarKm, consultarKm, pendenciaKm } from './useLote.js';
defineProps({ linha: { type: Object, required: true } });
</script>
<template>
  <div class="km-os">
    <label>Hodômetro da nova OS (km)
      <input :value="linha.km" inputmode="numeric" placeholder="Informe a km real" @input="editarKm(linha, $event.target.value)" />
    </label>
    <small v-if="linha.kmAtual != null" class="muted block">Último hodômetro do cadastro ESL: {{ linha.kmAtual }} km (pode ser posterior à nota)</small>
    <small v-if="linha.kmCarregando" class="muted block">Consultando veículo…</small>
    <small v-if="linha.kmErro" class="msg block">{{ linha.kmErro }}</small>
    <button type="button" class="ghost small" :disabled="linha.kmCarregando" @click="consultarKm(linha)">Consultar último km</button>
    <template v-if="linha.kmLimites">
      <small class="warnc block">O ESL rejeitou a quilometragem. Confira a leitura real na data da OS.</small>
      <small v-for="(x,i) in linha.kmLimites.limites" :key="i" class="muted block">{{ x.origem }}: {{ x.km }} km ({{ x.tipo === 'max' ? 'máximo' : 'mínimo' }})</small>
      <small v-if="linha.kmLimites.sugestao != null" class="muted block">Valor sugerido pelo limite: {{ linha.kmLimites.sugestao }} km — não é uma leitura confirmada.</small>
      <label class="inline"><input type="checkbox" v-model="linha.kmConfirmado" /> Confirmo a quilometragem real para a data da OS</label>
    </template>
    <small v-if="pendenciaKm(linha)" class="warnc block">{{ pendenciaKm(linha) }}</small>
  </div>
</template>
<style scoped>
.km-os { margin-top: 6px; display: grid; gap: 4px; min-width: 150px; }
.km-os input:not([type=checkbox]) { width: 100%; box-sizing: border-box; }
</style>
