<script setup lang="ts">
import { useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import ConversationStarter from '@/components/ConversationStarter.vue'
const route = useRoute()
const auth = useAuthStore()
</script>
<template><ConversationStarter :key="`${auth.user.id}:${route.fullPath}`" /></template>
