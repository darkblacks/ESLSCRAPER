<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api.js';

const props = defineProps({ commitEnabled: Boolean });

const modules = ref({});
const activeModule = ref('operacional');
const screen = ref(null);
const tab = ref('list'); // list | form | xhr
const loading = ref(false);
const error = ref('');

const list = ref(null);
const form = ref(null);
const values = ref({});
const result = ref(null);
const filter = ref('');

onMounted(async () => {
  modules.value = await api.modules();
});

const screens = computed(() => modules.value[activeModule.value]?.screens || []);
const filteredRows = computed(() => {
  if (!list.value) return [];
  const f = filter.value.toLowerCase();
  return f ? list.value.rows.filter((r) => r.cells.join(' ').toLowerCase().includes(f)) : list.value.rows;
});

async function run(fn) {
  loading.value = true;
  error.value = '';
  try {
    await fn();
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

function pick(s) {
  screen.value = s;
  list.value = null;
  form.value = null;
  result.value = null;
  values.value = {};
  tab.value = 'list';
  loadList();
}

const loadList = () => run(async () => (list.value = await api.list(screen.value.route)));
const loadForm = () =>
  run(async () => {
    tab.value = 'form';
    form.value = await api.form(screen.value.route, list.value?.newHref);
    values.value = {};
    result.value = null;
  });

const filledData = () =>
  Object.fromEntries(Object.entries(values.value).filter(([, v]) => v !== '' && v !== undefined && v !== null));

const dryRun = () =>
  run(async () => {
    result.value = await api.insert({ route: screen.value.route, newHref: form.value?.target, data: filledData(), commit: false });
  });

const commit = () => {
  if (!confirm(`Gravar de verdade no ESL em "${screen.value.label}"?`)) return;
  run(async () => {
    result.value = await api.insert({ route: screen.value.route, newHref: form.value?.target, data: filledData(), commit: true });
  });
};

function download(name, obj) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
  a.download = name;
  a.click();
}
</script>

<template>
  <div class="layout">
    <aside>
      <div class="mod-tabs">
        <button v-for="(m, k) in modules" :key="k" :class="{ active: activeModule === k }" @click="activeModule = k">
          {{ m.label }}
        </button>
      </div>
      <ul class="screens">
        <li v-for="s in screens" :key="s.key" :class="{ active: screen?.key === s.key }" @click="pick(s)">
          {{ s.label }}<small>{{ s.route }}</small>
        </li>
      </ul>
    </aside>

    <section class="content">
      <p v-if="!screen" class="muted">Escolha uma tela à esquerda.</p>

      <template v-else>
        <div class="head">
          <h2>{{ screen.label }} <small class="muted">{{ screen.route }}</small></h2>
          <div class="tabs">
            <button :class="{ active: tab === 'list' }" @click="tab = 'list'">Listagem</button>
            <button :class="{ active: tab === 'xhr' }" @click="tab = 'xhr'">Chamadas JSON ({{ list?.xhr?.length || 0 }})</button>
            <button :class="{ active: tab === 'form' }" @click="form ? (tab = 'form') : loadForm()">Formulário / Inserir</button>
          </div>
        </div>

        <p v-if="loading" class="muted">Carregando do ESL…</p>
        <p v-if="error" class="msg">{{ error }}</p>

        <!-- LISTAGEM -->
        <div v-if="tab === 'list' && list" class="card">
          <div class="row">
            <input v-model="filter" placeholder="Filtrar linhas…" />
            <span class="muted">{{ filteredRows.length }} linhas · {{ list.pager || 'sem paginação detectada' }}</span>
            <span class="spacer" />
            <button class="ghost" @click="loadList">Recarregar</button>
            <button class="ghost" @click="download(`${screen.key}-lista.json`, list)">Baixar JSON</button>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr><th v-for="c in list.columns" :key="c">{{ c }}</th></tr></thead>
              <tbody>
                <tr v-for="(r, i) in filteredRows" :key="i">
                  <td v-for="(c, j) in r.cells" :key="j">{{ c }}</td>
                </tr>
              </tbody>
            </table>
            <p v-if="!list.rows.length" class="muted">Nenhuma linha na tabela (a tela pode exigir filtro/pesquisa — veja a aba de chamadas JSON).</p>
          </div>
        </div>

        <!-- XHR -->
        <div v-if="tab === 'xhr' && list" class="card">
          <p class="muted">Requisições JSON feitas pela página ao abrir. Se a listagem vier daqui, dá para consumir direto via HTTP.</p>
          <details v-for="(x, i) in list.xhr" :key="i">
            <summary><code>{{ x.method }} {{ x.status }} {{ x.url }}</code></summary>
            <pre>{{ x.sample }}</pre>
          </details>
        </div>

        <!-- FORM -->
        <div v-if="tab === 'form' && form" class="card">
          <div class="row">
            <span class="muted">Form: <code>{{ form.method }} {{ form.action }}</code> · {{ form.fields.length }} campos · HTTP {{ form.httpStatus }}</span>
            <span class="spacer" />
            <button class="ghost" @click="download(`${screen.key}-form.json`, form)">Baixar mapa do form</button>
          </div>

          <div class="fields">
            <label v-for="f in form.fields.filter((x) => x.visible || x.kind === 'autocomplete')" :key="f.name">
              <span>
                {{ f.label || f.name }} <b v-if="f.required">*</b>
                <small class="muted">{{ f.kind }} · {{ f.name }}</small>
              </span>
              <select v-if="f.kind === 'select'" v-model="values[f.name]">
                <option value="" />
                <option v-for="o in f.options" :key="o.value" :value="o.value">{{ o.text }}</option>
              </select>
              <input v-else-if="f.kind === 'checkbox'" type="checkbox" v-model="values[f.name]" />
              <input v-else v-model="values[f.name]" :type="['date', 'number', 'datetime-local', 'time'].includes(f.type) ? f.type : 'text'"
                :placeholder="f.kind === 'autocomplete' ? 'texto a buscar (escolhe o 1º resultado)' : ''" />
            </label>
          </div>

          <div class="row">
            <button @click="dryRun" :disabled="loading">Simular (não salva)</button>
            <button class="danger" @click="commit" :disabled="loading || !props.commitEnabled"
              :title="props.commitEnabled ? '' : 'Ative ALLOW_COMMIT=true no backend'">Gravar no ESL</button>
          </div>

          <div v-if="result" class="result">
            <p><b>{{ result.committed ? 'Gravado' : 'Não gravado' }}</b> <span v-if="result.url">· {{ result.url }}</span></p>
            <p v-if="result.message">{{ result.message }}</p>
            <ul v-if="result.errors?.length || result.formErrors?.length" class="msg">
              <li v-for="e in result.errors" :key="e.field">{{ e.field }}: {{ e.error }}</li>
              <li v-for="e in result.formErrors" :key="e">{{ e }}</li>
            </ul>
            <img v-if="result.screenshot" :src="'data:image/jpeg;base64,' + result.screenshot" />
          </div>
        </div>
      </template>
    </section>
  </div>
</template>
