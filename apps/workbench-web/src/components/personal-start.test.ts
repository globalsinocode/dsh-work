import { createPinia, setActivePinia } from 'pinia'
import { mount, flushPromises } from '@vue/test-utils'
import { reactive } from 'vue'
import ElementPlus from 'element-plus'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskComposer } from '@dsh-work/workbench-components'
import { useContentStore } from '@/stores/content'
import { useTaskStore } from '@/stores/tasks'
import ConversationStarter from './ConversationStarter.vue'
const routes=vi.hoisted(()=>({push:vi.fn(),replace:vi.fn(),query:{} as Record<string,string>}))
vi.mock('vue-router',()=>({useRouter:()=>routes,useRoute:()=>({query:routes.query})}))
describe('D12 personal default and explicit team origin',()=>{
 beforeEach(()=>{setActivePinia(createPinia());routes.query={};vi.clearAllMocks()})
 async function setup(props:Record<string,unknown>={}){
   const content=useContentStore();content.initialized=true
   content.workspaces=[{id:'team-first',name:'不应作为默认的团队',type:'team',status:'active',files:[]} as never]
   vi.spyOn(content,'load').mockResolvedValue();vi.spyOn(content,'refreshSkills').mockResolvedValue([])
   const store=useTaskStore(),create=vi.spyOn(store,'createTask').mockResolvedValue({id:'run-test'} as never)
   const wrapper=mount(ConversationStarter,{props,global:{plugins:[ElementPlus]}})
   await flushPromises();return{wrapper,create}
 }
 it('RED: global composer never falls back to first team and sends no workspace even with a forged child payload',async()=>{
   const {wrapper,create}=await setup()
   const composer=wrapper.findComponent(TaskComposer)
   expect(composer.props('initialWorkspaceId')).toBe('')
   composer.vm.$emit('submit',{prompt:'个人任务',files:[],workspaceId:'team-first'});await flushPromises()
   expect(create.mock.calls[0]?.[2]).toBeUndefined()
   expect(wrapper.find('.composer-workspace').exists()).toBe(false)
   wrapper.unmount()
 })
 it('team origin pins its own workspace, never a child payload workspace',async()=>{
   const {wrapper,create}=await setup({workspaceId:'team-one',workspaceName:'团队一',workspaceLocked:true,requiresAgentMember:true,presetAgentMember:{id:'member-agent',name:'Agent',status:'available'},startableAgentMemberIds:['member-agent']})
   wrapper.findComponent(TaskComposer).vm.$emit('submit',{prompt:'团队任务',files:[],workspaceId:'team-forged'});await flushPromises()
   expect(create.mock.calls[0]?.[2]).toBe('team-one');expect(create.mock.calls[0]?.[7]).toBe('member-agent')
   wrapper.unmount()
 })
 it('changing the locked workspace clears pending references',async()=>{
   const {wrapper,create}=await setup({workspaceId:'team-one',workspaceLocked:true})
   ;(wrapper.vm as unknown as {useWorkspaceFile(file:unknown):void}).useWorkspaceFile({id:'old-file',name:'旧文件'})
   await wrapper.setProps({workspaceId:'team-two'})
   wrapper.findComponent(TaskComposer).vm.$emit('submit',{prompt:'新任务',files:[],workspaceId:'team-two'});await flushPromises()
   expect(create.mock.calls[0]?.[5]).toEqual([]);wrapper.unmount()
 })
 it('global reference with unreadable metadata is not silently dropped into an unrelated task',async()=>{
   routes.query=reactive({file:'inaccessible'})
   const {workbenchApi}=await import('@/api/client')
   vi.spyOn(workbenchApi,'getPersonalFile').mockRejectedValue(new Error('无权读取'))
   const {wrapper,create}=await setup()
   expect(wrapper.text()).toContain('无权读取')
   wrapper.findComponent(TaskComposer).vm.$emit('submit',{prompt:'分析',files:[],workspaceId:''});await flushPromises()
   expect(create).not.toHaveBeenCalled();wrapper.unmount()
 })
})
