<script setup>
// Progresso do lote + última tela do ESL (atualiza a cada consulta de progresso).
import { computed } from 'vue';
const props = defineProps({ job: Object });
const pct = computed(() => (props.job?.total ? Math.round((props.job.feitos / props.job.total) * 100) : 0));
</script>

<template>
  <Transition name="rise">
    <section v-if="job && !job.fim" class="card aovivo">
      <div class="prog-head">
        <b>{{ job.pausado ? 'Lote pausado' : 'Lançando no ESL' }}</b>
        <span class="muted small">{{ job.feitos }}/{{ job.total }} nota(s){{ job.atual ? ' · ' + job.atual : '' }}</span>
        <span class="spacer" />
        <b class="pct">{{ pct }}%</b>
      </div>
      <div class="progress" :class="{ paused: job.pausado }"><i :style="{ width: Math.max(pct, 3) + '%' }" /></div>
      <Transition name="fade">
        <p v-if="job.pausado" class="alertbox">{{ job.pausado }}</p>
      </Transition>
      <template v-if="job.ultimaTela">
        <div class="small"><b>ESL agora</b> — {{ job.ultimaTela.legenda }} <span class="muted">({{ new Date(job.ultimaTela.em).toLocaleTimeString('pt-BR') }})</span></div>
        <img :src="'data:image/jpeg;base64,' + job.ultimaTela.img" />
      </template>
    </section>
  </Transition>
</template>
