<script setup lang="ts">
defineProps<{
  directoryAccount: 'none' | 'missing'
  bindFailed?: boolean
}>()

defineEmits<{ bind: [] }>()
</script>

<template>
  <el-result icon="info" title="连接知识库账号">
    <template #sub-title>
      <p v-if="directoryAccount === 'missing'">知识库账号尚未开通，请联系管理员。</p>
      <p v-if="bindFailed">连接未完成，请重试。</p>
      <p>使用你在 WeKnora 中的账号完成一次连接后，即可在此查阅知识库。</p>
    </template>
    <template #extra>
      <el-button type="primary" @click="$emit('bind')">连接知识库账号</el-button>
    </template>
  </el-result>
</template>
