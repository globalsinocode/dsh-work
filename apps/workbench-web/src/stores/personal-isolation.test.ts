import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, expect, it, vi } from 'vitest'
import { useTaskStore } from './tasks'
import { useContentStore } from './content'
import { workbenchApi } from '@/api/client'
vi.mock('@/api/client', () => ({workbenchApi:{getRun:vi.fn(),getTasks:vi.fn(),createSession:vi.fn(),startRun:vi.fn(),getWorkspaces:vi.fn(),getArtifacts:vi.fn(),getAgents:vi.fn(),createWorkspace:vi.fn()}}))
function deferred<T>() { let resolve!: (value:T)=>void;const promise=new Promise<T>(r=>{resolve=r});return {promise,resolve} }
beforeEach(()=>{setActivePinia(createPinia())})
it('late Run refresh cannot repopulate the next account',async()=>{
 const wait=deferred<never>();vi.mocked(workbenchApi.getRun).mockReturnValue(wait.promise)
 const store=useTaskStore(), pending=store.refreshRun('old');const rejected=expect(pending).rejects.toThrow('账号已切换')
 store.reset();wait.resolve({id:'old',status:'succeeded'} as never);await rejected;expect(store.tasks).toEqual([])
})
it('account switch during Session creation stops before executing the task',async()=>{
 const wait=deferred<never>();vi.mocked(workbenchApi.createSession).mockReturnValue(wait.promise)
 const store=useTaskStore(),pending=store.createTask('old request',[]);const rejected=expect(pending).rejects.toThrow('账号已切换')
 store.reset();wait.resolve({id:'old-session'} as never);await rejected;expect(workbenchApi.startRun).not.toHaveBeenCalled()
})
it('late content refresh and creation cannot enter a new account Store',async()=>{
 const wait=deferred<never>();vi.mocked(workbenchApi.getWorkspaces).mockReturnValue(wait.promise)
 vi.mocked(workbenchApi.getArtifacts).mockResolvedValue([]);vi.mocked(workbenchApi.getAgents).mockResolvedValue([])
 const store=useContentStore(),pending=store.refresh();store.reset();wait.resolve([{id:'other-team'}] as never);await pending;expect(store.workspaces).toEqual([])
 const create=deferred<never>();vi.mocked(workbenchApi.createWorkspace).mockReturnValue(create.promise)
 const creating=store.createTeamWorkspace({name:'old',description:''});const rejected=expect(creating).rejects.toThrow('账号已切换')
 store.reset();create.resolve({id:'old-team'} as never);await rejected;expect(store.workspaces).toEqual([])
})
