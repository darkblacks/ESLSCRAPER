<script setup>
// Sequência de prints do ESL de uma nota: o que estava na tela antes e depois de cada "Salvar".
import { ref } from 'vue';
import { api } from '../api.js';

const props = defineProps({ jobId: String, nref: String, qtd: Number });
const telas = ref(null);
const aberta = ref(null);
const carregando = ref(false);

async function carregar() {
  if (telas.value) return (telas.value = null);
  carregando.value = true;
  try {
    telas.value = await api.loteTelas(props.jobId, props.nref);
  } finally {
    carregando.value = false;
  }
}
const hora = (t) => new Date(t).toLocaleTimeString('pt-BR');
const erro = (t) => /erro|não salvou|não aceitou|não confirmou/i.test(t.legenda);
</script>

<template>
  <div class="telas">
    <button class="ghost small" type="button" @click="carregar">
      {{ carregando ? 'carregando…' : telas ? 'esconder telas do ESL' : `ver telas do ESL (${qtd || 0})` }}
    </button>
    <div v-if="telas" class="telas-grid">
      <figure v-for="(t, i) in telas" :key="i" :class="{ errt: erro(t) }" @click="aberta = t">
        <img :src="'data:image/jpeg;base64,' + t.img" />
        <figcaption><b>{{ i + 1 }}.</b> {{ t.legenda }} <small class="muted">{{ hora(t.em) }}</small></figcaption>
      </figure>
      <p v-if="!telas.length" class="muted small">Nenhuma tela capturada.</p>
    </div>
    <div v-if="aberta" class="tela-zoom" @click="aberta = null">
      <figure><img :src="'data:image/jpeg;base64,' + aberta.img" /><figcaption>{{ aberta.legenda }} — clique para fechar</figcaption></figure>
    </div>
  </div>
</template>
