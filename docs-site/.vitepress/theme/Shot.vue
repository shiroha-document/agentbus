<script setup lang="ts">
// Screenshot that follows the colour scheme: <Shot name="home" alt="首页" />
import { withBase } from "vitepress";
defineProps<{ name: string; alt: string; caption?: string }>();
</script>

<template>
  <figure class="ab-shot">
    <div class="ab-shot__frame">
      <div class="ab-shot__bar"><i /><i /><i /></div>
      <img class="ab-shot__img ab-shot__img--light" :src="withBase(`/screenshots/${name}-light.png`)" :alt="alt" loading="lazy" />
      <img class="ab-shot__img ab-shot__img--dark" :src="withBase(`/screenshots/${name}-dark.png`)" :alt="alt" loading="lazy" />
    </div>
    <figcaption v-if="caption">{{ caption }}</figcaption>
  </figure>
</template>
