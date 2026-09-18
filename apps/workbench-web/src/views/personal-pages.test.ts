import { mount, flushPromises } from '@vue/test-utils'
import { reactive } from 'vue'
import ElementPlus, { ElMessageBox } from 'element-plus'
import { createPinia } from 'pinia'
import { beforeEach, expect, it, vi } from 'vitest'
import { workbenchApi } from '@/api/client'
import MyFilesView from './MyFilesView.vue'
import HistoryView from './HistoryView.vue'
import WorkspaceEntryView from './WorkspaceEntryView.vue'
const state = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), removeSession: vi.fn(), route: {} as {params:{id?:string};query:Record<string,string>} }))
vi.mock('vue-router', () => ({ useRoute: () => state.route, useRouter: () => state }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({user:{id:'U00001'}}) }))
vi.mock('@/stores/tasks', () => ({ useTaskStore: () => ({deleteConversation:state.removeSession}) }))
vi.mock('@/api/client', () => ({ workbenchApi: { listSessions:vi.fn(),listPersonalFiles:vi.fn(),getWorkspaces:vi.fn(),removePersonalFile:vi.fn(),downloadPersonalFile:vi.fn() } }))
function render(component: Parameters<typeof mount>[0]) { return mount(component, { global: { plugins: [createPinia(), ElementPlus], stubs: { RouterLink: {template:'<a><slot /></a>'}, WorkspaceDetailView:{template:'<div>团队详情</div>'} } } }) }
beforeEach(() => {
  state.route=reactive({params:{},query:{}})
  state.push.mockReset();state.replace.mockReset();state.removeSession.mockReset()
  vi.mocked(workbenchApi.listSessions).mockResolvedValue({items:[],nextCursor:null})
  vi.mocked(workbenchApi.listPersonalFiles).mockResolvedValue({items:[],nextCursor:null})
})
it.each([['files','/files?source=material'],['artifacts','/files?source=artifact'],['conversation','/history?scope=personal']])('legacy personal %s link is authorized before redirect', async (tab, target) => {
  state.route.params.id='ws-personal';state.route.query.tab=tab
  vi.mocked(workbenchApi.getWorkspaces).mockResolvedValue([{id:'ws-personal',type:'personal'}] as never)
  const wrapper=render(WorkspaceEntryView);await flushPromises()
  expect(workbenchApi.getWorkspaces).toHaveBeenCalled();expect(state.replace).toHaveBeenCalledWith(target)
  wrapper.unmount()
})
it('guessed and failed legacy personal links do not silently redirect to a team', async () => {
  state.route.params.id='ws-personal-other'
  vi.mocked(workbenchApi.getWorkspaces).mockResolvedValue([{id:'team',type:'team'}] as never)
  const wrapper=render(WorkspaceEntryView);await flushPromises()
  expect(state.replace).not.toHaveBeenCalled();expect(wrapper.text()).toContain('没有访问权限')
  vi.mocked(workbenchApi.getWorkspaces).mockRejectedValue(new Error('权限服务不可用'))
  await wrapper.findAll('button').find(b=>b.text()==='重试')!.trigger('click');await flushPromises()
  expect(state.replace).not.toHaveBeenCalled();expect(wrapper.text()).toContain('权限服务不可用');wrapper.unmount()
})
it('files show source kinds and removed-source labels; logical removal calls the existing object API', async () => {
  vi.mocked(workbenchApi.listPersonalFiles).mockResolvedValue({items:[{id:'f',name:'材料.txt',source:'material',type:'TXT',size:'1 KB',scanStatus:'clean',parseStatus:'succeeded',canReference:true,canDownload:true,removable:true},{id:'a',name:'成果.txt',source:'artifact',type:'TXT',size:'1 KB',sessionId:'removed',sourceSessionState:'removed',scanStatus:'clean',parseStatus:'succeeded'}] as never,nextCursor:null})
  vi.spyOn(ElMessageBox,'confirm').mockResolvedValue('confirm' as never)
  const wrapper=render(MyFilesView);await flushPromises()
  expect(wrapper.text()).toContain('个人材料');expect(wrapper.text()).toContain('生成成果');expect(wrapper.text()).toContain('原对话已移除，文件独立保留')
  expect(wrapper.findAll('a').length).toBe(0)
  await wrapper.findAll('button').find(b=>b.text()==='引用到新对话')!.trigger('click')
  expect(state.push).toHaveBeenCalledWith({path:'/workbench',query:{file:'f'}})
  await wrapper.findAll('button').find(b=>b.text()==='移除')!.trigger('click');await flushPromises()
  expect(workbenchApi.removePersonalFile).toHaveBeenCalledWith('f')
  expect(ElMessageBox.confirm).toHaveBeenCalledWith(expect.stringContaining('保留'), '移除文件？', expect.anything());wrapper.unmount()
})
it('history uses Session identity, preserves team labels, and does not expose a personal space name', async () => {
  vi.mocked(workbenchApi.listSessions).mockResolvedValue({items:[{sessionId:'s',title:'个人旧对话',runCount:65,workspaceName:'我的空间',workspaceType:'personal',lastActiveAt:'2026-09-18T00:00:00Z',canRemove:true},{sessionId:'t',title:'团队旧对话',runCount:1,workspaceType:'team',workspaceName:'团队甲',workspaceStatus:'archived',lastActiveAt:'2026-09-18T00:00:00Z',canRemove:false}] as never,nextCursor:null})
  const wrapper=render(HistoryView);await flushPromises()
  expect(wrapper.text()).not.toContain('我的空间');expect(wrapper.text()).toContain('团队甲（只读）')
  await wrapper.findAll('button').find(b=>b.text().includes('个人旧对话'))!.trigger('click')
  expect(state.push).toHaveBeenCalledWith('/sessions/s');expect(wrapper.findAll('button[aria-label^="移除对话："]')).toHaveLength(1)
  wrapper.unmount()
})
