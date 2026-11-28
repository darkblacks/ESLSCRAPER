<script setup>
import { ref } from 'vue';
import { api } from '../api.js';
const emit = defineEmits(['files']);
const chave = ref('');
const loading = ref(false);
const erro = ref('');
async function buscar() {
  if (loading.value) return;
  erro.value = '';
  const valor = chave.value.replace(/\s/g, '');
  if (!/^\d{44}$/.test(valor)) { erro.value = 'Informe os 44 dígitos da chave de acesso.'; return; }
  loading.value = true;
  try {
    const r = await api.buscarXmlChave(valor);
    emit('files', [new File([r.content], r.name, { type: 'application/xml' })]);
    chave.value = '';
  } catch (e) { erro.value = e.message; }
  finally { loading.value = false; }
}
</script>
<template>
  <div class="busca-chave">
    <label>Ou busque o XML pela chave de acesso da NF-e
      <input v-model="chave" type="text" inputmode="numeric" autocomplete="off" placeholder="Cole a chave de 44 dígitos" :disabled="loading" @keydown.enter.prevent="buscar" />
    </label>
    <button type="button" :disabled="loading" @click="buscar">{{ loading ? 'Buscando XML…' : 'Buscar XML' }}</button>
    <small class="muted">Consulta via Meu DANFE. Utilize somente notas que você está autorizado a consultar.</small>
    <p v-if="erro" class="msg" role="alert">{{ erro }} <a href="https://meudanfe.com.br/" target="_blank" rel="noopener noreferrer">Abrir Meu DANFE</a></p>
  </div>
</template>
<style scoped>
.busca-chave { display: flex; flex-wrap: wrap; align-items: end; gap: 8px; margin: 12px 0; }
.busca-chave label { flex: 1 1 300px; display: grid; gap: 5px; }
.busca-chave input { width: 100%; box-sizing: border-box; }
.busca-chave small, .busca-chave p { flex: 1 0 100%; margin: 0; }
</style>
