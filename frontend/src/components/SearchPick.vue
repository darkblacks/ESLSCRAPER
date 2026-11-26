<script>
import { ref as sharedRef } from 'vue';
// Só uma lista aberta por vez na tela inteira: abrir uma fecha a anterior.
const abertoGlobal = sharedRef(null);
let seq = 0;
</script>

<script setup>
// Campo de busca com lista de resultados (autocomplete simples).
// A lista é desenhada solta no <body> (Teleport + position: fixed): fica por cima de tudo, inclusive da área de
// soltar XML e de tabelas com rolagem, e acompanha o campo quando a página rola.
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue';

const props = defineProps({
  modelValue: Object, // { id, text }
  search: Function, // async (term) => [{ id, text, sub }]
  placeholder: String,
  options: { type: Array, default: () => [] }, // sugestões prontas
});
const emit = defineEmits(['update:modelValue']);

const id = ++seq;
const term = ref('');
const results = ref([]);
const loading = ref(false);
const root = ref(null);
const pop = ref(null);
const input = ref(null);
const pos = ref({});
let t;

const open = computed({
  get: () => abertoGlobal.value === id,
  set: (v) => {
    if (v) abertoGlobal.value = id;
    else if (abertoGlobal.value === id) abertoGlobal.value = null;
  },
});
const lista = computed(() => (term.value.length >= 2 ? results.value : props.options));

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

/** Posiciona a lista colada no campo; abre para cima se não couber embaixo. */
function place() {
  const el = root.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const w = Math.min(Math.max(r.width, 300), window.innerWidth - 16);
  const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
  const abaixo = window.innerHeight - r.bottom;
  const acima = r.top > abaixo && abaixo < 320;
  pos.value = acima
    ? { left: `${left}px`, width: `${w}px`, bottom: `${window.innerHeight - r.top + 4}px`, maxHeight: `${Math.max(160, r.top - 16)}px` }
    : { left: `${left}px`, width: `${w}px`, top: `${r.bottom + 4}px`, maxHeight: `${Math.max(160, abaixo - 16)}px` };
}
function foraDaqui(e) {
  if (root.value?.contains(e.target) || pop.value?.contains(e.target)) return;
  open.value = false;
}
function tecla(e) {
  if (e.key === 'Escape') open.value = false;
}
function ligar() {
  document.addEventListener('mousedown', foraDaqui, true);
  document.addEventListener('keydown', tecla);
  window.addEventListener('scroll', place, true);
  window.addEventListener('resize', place);
}
function desligar() {
  document.removeEventListener('mousedown', foraDaqui, true);
  document.removeEventListener('keydown', tecla);
  window.removeEventListener('scroll', place, true);
  window.removeEventListener('resize', place);
}
watch(open, async (v) => {
  if (v) {
    place();
    ligar();
    await nextTick();
    input.value?.focus();
  } else {
    desligar();
    term.value = '';
  }
});
onBeforeUnmount(() => {
  desligar();
  open.value = false;
});

function pick(o) {
  emit('update:modelValue', o);
  open.value = false;
}
function enter() {
  if (lista.value.length) pick(lista.value[0]);
}
</script>

<template>
  <div ref="root" class="pick">
    <button type="button" class="pick-value" :class="{ empty: !modelValue, on: open }" @click="open = !open">
      {{ modelValue?.text || placeholder || 'Selecionar…' }}
    </button>
    <Teleport to="body">
      <div v-if="open" ref="pop" class="pick-pop solto" :style="pos">
        <input ref="input" v-model="term" placeholder="Buscar…" @keydown.enter.prevent="enter" />
        <ul>
          <li v-if="loading" class="muted">buscando…</li>
          <li v-for="o in lista" :key="o.id" @click="pick(o)">
            {{ o.text }}<small v-if="o.sub">{{ o.sub }}</small>
          </li>
          <li v-if="!loading && term.length >= 2 && !results.length" class="muted">nada encontrado</li>
          <li v-if="!loading && term.length < 2 && !options.length" class="muted">digite 2 letras para buscar</li>
        </ul>
      </div>
    </Teleport>
  </div>
</template>
