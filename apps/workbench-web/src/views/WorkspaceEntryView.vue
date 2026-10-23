<script setup lang="ts">
defineOptions({ inheritAttrs: false })
import { ref, watch, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useContentStore } from '@/stores/content'
import { workbenchApi } from '@/api/client'
import WorkspaceDetailView from './WorkspaceDetailView.vue'
const route=useRoute(), router=useRouter(), content=useContentStore()
const ready=ref(false), error=ref('')
let generation=0
async function load() {
 const current=++generation
 ready.value=false;error.value=''
 try {
   // Revalidate the legacy ID against a server-authorized list; a guessed
   // "personal" ID must not become a redirect that conceals an access failure.
   const spaces=await workbenchApi.getWorkspaces()
   if(current!==generation)return
   const workspace=spaces.find(w=>w.id===String(route.params.id))
   if(!workspace)throw new Error('工作空间不存在或你没有访问权限')
   content.workspaces=spaces
   if(workspace.type==='personal') {
     const tab=String(route.query.tab??'conversation')
     await router.replace(tab==='files'?'/files?source=material':tab==='artifacts'?'/files?source=artifact':'/history?scope=personal')
   } else ready.value=true
 }catch(cause){if(current===generation)error.value=cause instanceof Error?cause.message:'无法读取工作空间'}
}
watch(()=>route.params.id,()=>{void load()},{immediate:true})
onBeforeUnmount(()=>{generation++})
</script>
<template>
 <!-- 布局、信息栏、插槽等由宿主传入（B 群组页，S5d），原样转交给空间详情。 -->
 <WorkspaceDetailView v-if="ready" v-bind="$attrs">
  <template v-for="(_, name) in $slots" #[name]="scope"><slot :name="name" v-bind="scope ?? {}" /></template>
 </WorkspaceDetailView>
 <el-result v-else-if="error" icon="warning" :title="error"><template #extra><el-button @click="load">重试</el-button><el-button @click="router.push('/workspaces')">返回项目空间</el-button></template></el-result>
 <el-skeleton v-else :rows="6" animated />
</template>
