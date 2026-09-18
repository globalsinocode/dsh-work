import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { usePagedQuery } from './usePagedQuery'
function deferred<T>() { let resolve!: (value:T) => void; const promise = new Promise<T>(r => { resolve = r }); return { resolve, promise } }
describe('shared personal query lifecycle', () => {
  it('ignores an old identity or filter response', async () => {
    const source=ref('user-a'), first=deferred<{items:string[];nextCursor:null}>()
    const fetchPage=vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue({items:['b'],nextCursor:null})
    let query!: ReturnType<typeof usePagedQuery<string>>
    const wrapper=mount(defineComponent({setup(){query=usePagedQuery(source,fetchPage);return()=>null}}))
    source.value='user-b';await flushPromises();first.resolve({items:['a-secret'],nextCursor:null});await flushPromises()
    expect(query.items.value).toEqual(['b']);wrapper.unmount()
  })
  it('clears stale data on a failed new filter', async () => {
    const source=ref('one'), fetchPage=vi.fn().mockResolvedValueOnce({items:['old'],nextCursor:'next'}).mockRejectedValue(new Error('offline'))
    let query!: ReturnType<typeof usePagedQuery<string>>
    const wrapper=mount(defineComponent({setup(){query=usePagedQuery(source,fetchPage);return()=>null}}))
    await flushPromises();source.value='two';await flushPromises()
    expect(query.items.value).toEqual([]);expect(query.error.value).toBe('offline');expect(query.nextCursor.value).toBeNull();wrapper.unmount()
  })
  it('keeps pagination retryable but drops content after revocation', async () => {
    const fetchPage=vi.fn().mockResolvedValueOnce({items:['old'],nextCursor:'next'}).mockRejectedValueOnce(new Error('offline')).mockRejectedValue({status:403})
    let query!: ReturnType<typeof usePagedQuery<string>>
    const wrapper=mount(defineComponent({setup(){query=usePagedQuery(ref('a'),fetchPage);return()=>null}}))
    await flushPromises();await query.loadMore();expect(query.items.value).toEqual(['old']);await query.loadMore();expect(query.items.value).toEqual([]);wrapper.unmount()
  })
})
