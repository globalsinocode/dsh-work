-- 2026-10-20 工作簿里的照片、截图只存在于 BIFF/OOXML 的图形层，解析出的表格文字里
-- 只剩空单元格。图片随解析结果一起保存，运行时作为附件挂进工作区，Agent 用图片工具读取。
--
-- 每项形如：
--   {"name":"image-1.png","media_type":"image/png","storage_key":"extractions/<fileId>/attachments/image-1.png",
--    "sha256":"…","size":93478,"source":"Sheet3 第 6 行"}
alter table file_extractions
  add column if not exists attachments jsonb not null default '[]'::jsonb;

alter table file_extractions
  add constraint file_extractions_attachments_is_array
  check (jsonb_typeof(attachments) = 'array');
