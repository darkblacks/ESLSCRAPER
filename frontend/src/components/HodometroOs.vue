<script setup>
import { editarKm, consultarKm, pendenciaKm, usarKmSugerido } from './useLote.js';
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
    <button type="button" class="ghost small" :disabled="linha.kmCarregando" @click="consultarKm(linha)">Consultar hodômetro atual do cadastro</button>
    <template v-if="linha.kmLimites">
      <small class="warnc block">O ESL rejeitou a quilometragem. Confira a leitura real na data da OS.</small>
      <small v-for="(x,i) in linha.kmLimites.limites" :key="i" class="muted block">{{ x.origem }}: {{ x.km }} km ({{ x.tipo === 'max' ? 'máximo' : 'mínimo' }})</small>
      <small v-if="linha.kmLimites.max != null" class="warnc block">Máximo permitido pelo erro do ESL: {{ linha.kmLimites.max.toLocaleString('pt-BR') }} km</small>
      <small v-if="linha.kmLimites.min != null" class="warnc block">Mínimo permitido pelo erro do ESL: {{ linha.kmLimites.min.toLocaleString('pt-BR') }} km</small>
      <template v-if="linha.kmLimites.sugestao != null">
        <small class="muted block">Sugestão dentro dos limites encontrados: {{ linha.kmLimites.sugestao.toLocaleString('pt-BR') }} km. Confira a leitura real.</small>
        <button type="button" class="ghost small" @click="usarKmSugerido(linha)">Usar sugestão de {{ linha.kmLimites.sugestao.toLocaleString('pt-BR') }} km</button>
      </template>
      <small v-else class="msg block">Não foi possível identificar um limite numérico seguro. Consulte as referências do ESL e informe a leitura real. O hodômetro atual do cadastro não é necessariamente válido na data da nota.</small>
      <small v-if="!linha.kmLimites.limites?.length && linha.kmLimites.mensagem" class="muted block">{{ linha.kmLimites.mensagem }}</small>
      <label class="inline"><input type="checkbox" v-model="linha.kmConfirmado" /> Confirmo a quilometragem real para a data da OS</label>
    </template>
    <small v-if="pendenciaKm(linha)" class="warnc block">{{ pendenciaKm(linha) }}</small>
  </div>
</template>
<style scoped>
.km-os { margin-top: 6px; display: grid; gap: 4px; min-width: 150px; }
.km-os input:not([type=checkbox]) { width: 100%; box-sizing: border-box; }
</style>
