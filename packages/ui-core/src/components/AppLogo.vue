<script setup lang="ts">
defineProps<{
  compact?: boolean
  dark?: boolean
}>()
</script>

<template>
  <div class="logo" :class="{ 'logo--compact': compact, 'logo--dark': dark }">
    <div class="logo__mark" aria-hidden="true">
      <span class="logo__mark-dot"></span>
      <span class="logo__mark-line"></span>
    </div>
    <div v-if="!compact" class="logo__text">
      <div class="logo__title-row">
        <strong>dsh-work</strong>
        <slot name="badge" />
      </div>
      <span>企业 Agent 工作空间</span>
    </div>
  </div>
</template>

<style scoped>
.logo {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}

.logo__mark {
  position: relative;
  display: grid;
  flex: 0 0 auto;
  width: 34px;
  height: 34px;
  place-items: center;
  overflow: hidden;
  border-radius: 10px;
  background: #4c73eb;
}

.logo__mark::before,
.logo__mark::after {
  position: absolute;
  width: 7px;
  height: 7px;
  border: 2px solid white;
  border-radius: 3px;
  content: '';
}

.logo__mark::before {
  top: 7px;
  left: 7px;
}

.logo__mark::after {
  right: 7px;
  bottom: 7px;
}

.logo__mark-dot {
  position: absolute;
  top: 7px;
  right: 7px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #b9f0dc;
}

.logo__mark-line {
  width: 13px;
  height: 2px;
  transform: rotate(-45deg);
  border-radius: 2px;
  background: white;
}

.logo__text {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.logo__title-row {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 6px;
  white-space: nowrap;
}

.logo__text strong {
  color: #fff;
  font-size: var(--dsh-font-size-section);
  font-weight: 680;
  letter-spacing: -0.015em;
}

.logo__text span {
  margin-top: 2px;
  overflow: hidden;
  color: #8994aa;
  font-size: var(--dsh-font-size-micro);
  letter-spacing: 0.025em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.logo--dark .logo__text strong {
  color: var(--dsh-color-ink);
}

.logo--compact .logo__mark {
  width: 31px;
  height: 31px;
}
</style>
