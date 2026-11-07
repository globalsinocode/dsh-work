-- 推荐 AI 同事：推荐时由模型为每位同事写的“发给该同事的问题”（员工口吻、限长纯文本）。
-- 员工点“去聊天”时优先预填它，没有时预填该轮员工的原问题；只预填、不自动发送。
alter table agent_recommendations add column suggested_prompt text
  check (suggested_prompt is null or char_length(suggested_prompt) between 1 and 500);
