-- Agent 知识检索工具方案（docs/design/knowledge-search-tool-plan.md，KO9）。
--
-- 引用快照区分来源：执行前检索注入 Manifest 的分段（pre_retrieval），与 Agent 在 Attempt 内调用
-- knowledge_search 检索到的分段（tool）。两者共用同一组序号，回答末尾的资料列表与执行详情都读这张表。
alter table run_knowledge_citations
  add column if not exists source text not null default 'pre_retrieval'
    check (source in ('pre_retrieval', 'tool'));
