<script setup>
// Campo de busca com lista de resultados (autocomplete simples).
import { ref, watch } from 'vue';

const props = defineProps({
  modelValue: Object, // { id, text }
  search: Function, // async (term) => [{ id, text, sub }]
  placeholder: String,
  options: { type: Array, default: () => [] }, // sugestões prontas
});
const emit = defineEmits(['update:modelValue']);

const term = ref('');
const results = ref([]);
const open = ref(false);
const loading = ref(false);
let t;

watch(term, (v) => {
  clearTimeout(t);
  if (!v || v.length < 2) {
    results.value = [];
    return;
  }
  t = setTimeout(async () => {
    loading.value = true;
    try {
      results.value = await props.search(v);
    } catch {
      results.value = [];
    } finally {
      loading.value = false;
    }
  }, 300);
});

function pick(o) {
  emit('update:modelValue', o);
  open.value = false;
  term.value = '';
}
</script>

<template>
  <div class="pick">
    <button type="button" class="pick-value" :class="{ empty: !modelValue }" @click="open = !open">
      {{ modelValue?.text || placeholder || 'Selecionar…' }}
    </button>
    <div v-if="open" class="pick-pop">
      <input v-model="term" placeholder="Buscar…" autofocus />
      <ul>
        <li v-if="loading" class="muted">buscando…</li>
        <li v-for="o in (term.length >= 2 ? results : options)" :key="o.id" @click="pick(o)">
          {{ o.text }}<small v-if="o.sub">{{ o.sub }}</small>
        </li>
        <li v-if="!loading && term.length >= 2 && !results.length" class="muted">nada encontrado</li>
      </ul>
    </div>
  </div>
</template>
