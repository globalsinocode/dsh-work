/** This release implements logical removal only. Null is NOT a purge deadline.
 * No retention duration is invented on behalf of the enterprise. A later approved
 * purge needs a separate migration, reference analysis and explicit rollout. */
export const personalContentPolicy = Object.freeze({
  version: 'logical-retention-v1',
  conversationRemoval: 'hide-history-retain-files',
  fileRemoval: 'deny-new-use-retain-evidence',
  accountDeactivation: 'revoke-access-retain-content-no-transfer',
  restoreRemovedConversation: false,
  physicalDeletion: false,
  retentionDays: null,
  notice: '移除对话只隐藏历史入口，文件和成果独立保留；移除文件停止下载和新引用。本版本不作物理删除，保留期限待企业批准策略明确。账号停用撤销访问，不自动转交内容。',
})
