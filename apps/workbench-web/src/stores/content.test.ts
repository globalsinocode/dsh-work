import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, expect, it, vi } from 'vitest'

import { workbenchApi } from '@/api/client'
import { useContentStore } from './content'
import type { Workspace, WorkspaceFile } from '@/types/domain'

vi.mock('@/api/client', () => ({
  workbenchApi: {
    getWorkspaces: vi.fn(),
    getArtifacts: vi.fn(),
    getAgents: vi.fn(),
    uploadWorkspaceFile: vi.fn(),
  },
}))

function workspaceFile(overrides: Partial<WorkspaceFile> = {}): WorkspaceFile {
  return {
    id: 'file-existing',
    name: '既有文件.txt',
    type: 'TXT',
    size: '2 KB',
    uploadedBy: '林岚',
    uploadedAt: '2026-09-10 08:00',
    ...overrides,
  }
}

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-team',
    name: '供应链团队',
    description: '团队共享的协作空间。',
    type: 'team',
    memberCount: 2,
    sessionCount: 1,
    artifactCount: 0,
    updatedAt: '2026-09-10T00:00:00.000Z',
    owner: '林岚',
    members: ['林岚', '周航'],
    files: [],
    status: 'active',
    archivedAt: null,
    ...overrides,
  }
}

/** 上传接口返回的是逻辑文件投影：没有 type / uploadedBy / uploadedAt 列表列。 */
function uploadedProjection() {
  return {
    id: 'file-new',
    logicalFileId: 'wfile-new',
    name: '巡检记录.md',
    source: 'workspace' as const,
    sizeLabel: '1 KB',
    versionNo: 1,
    versionCount: 1,
    parseStatus: 'succeeded' as const,
    parseErrorCode: null,
    canReference: true,
    canDownload: true,
    createdAt: '2026-11-03 08:00',
    updatedAt: '2026-11-03 08:00',
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.mocked(workbenchApi.getWorkspaces).mockResolvedValue([])
  vi.mocked(workbenchApi.getArtifacts).mockResolvedValue([])
  vi.mocked(workbenchApi.getAgents).mockResolvedValue([])
})

it('共享文件上传成功后出现在团队空间的共享文件列表里', async () => {
  const store = useContentStore()
  store.workspaces.splice(0, store.workspaces.length, workspace({ files: [workspaceFile()] }))
  vi.mocked(workbenchApi.uploadWorkspaceFile).mockResolvedValue(uploadedProjection() as never)
  // 服务端摘要才是共享文件列表的渲染口径（type / uploadedBy / uploadedAt 等列）。
  vi.mocked(workbenchApi.getWorkspaces).mockResolvedValue([workspace({
    files: [
      workspaceFile({
        id: 'file-new',
        logicalFileId: 'wfile-new',
        name: '巡检记录.md',
        type: 'MD',
        size: '1 KB',
        uploadedBy: '周航',
        uploadedAt: '2026-11-03 08:00',
        versionNo: 1,
        versionCount: 1,
        canReference: true,
        canDownload: true,
      }),
      workspaceFile(),
    ],
  })])

  await store.uploadWorkspaceFile('ws-team', new File(['巡检正文'], '巡检记录.md', { type: 'text/markdown' }))

  expect(workbenchApi.getWorkspaces).toHaveBeenCalledTimes(1)
  expect(store.workspaces[0].files.map(file => file.name)).toEqual(['巡检记录.md', '既有文件.txt'])
  // 列表行需要展示列；上传投影直接塞进列表会渲染出没有类型与上传者的空行。
  expect(store.workspaces[0].files[0]).toMatchObject({
    id: 'file-new',
    type: 'MD',
    uploadedBy: '周航',
    uploadedAt: '2026-11-03 08:00',
  })
})

it('个人空间上传仍然就地插入，不额外拉取空间列表（AC-23）', async () => {
  const store = useContentStore()
  store.workspaces.splice(0, store.workspaces.length, workspace({
    id: 'ws-personal',
    type: 'personal',
    files: [workspaceFile()],
  }))
  vi.mocked(workbenchApi.uploadWorkspaceFile).mockResolvedValue({
    id: 'file-personal-new',
    name: '个人笔记.txt',
    type: 'TXT',
    size: '3 KB',
    sizeLabel: '3 KB',
    uploadedBy: '周航',
    uploadedAt: '2026-11-03 08:00',
    extractionStatus: 'succeeded',
    logicalFileId: null,
    versionNo: null,
  } as never)

  await store.uploadWorkspaceFile('ws-personal', new File(['笔记'], '个人笔记.txt', { type: 'text/plain' }))

  expect(workbenchApi.getWorkspaces).not.toHaveBeenCalled()
  expect(store.workspaces[0].files.map(file => file.name)).toEqual(['个人笔记.txt', '既有文件.txt'])
})
