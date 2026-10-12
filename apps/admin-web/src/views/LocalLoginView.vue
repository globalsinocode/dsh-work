<script setup lang="ts">
import { LocalAuthPage } from '@dsh-work/ui-core'
import { useRoute } from 'vue-router'
const route = useRoute()
</script>

<template><LocalAuthPage :key="route.path" audience="admin" :change-password="route.path === '/change-password'" /></template>
