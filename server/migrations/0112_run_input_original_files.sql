-- 执行隔离 2b-4：装配 bash 时，二进制成果（xlsx、docx、pptx、pdf、png、jpg）以原始文件挂载为本轮输入。
-- 这类成果在 2b-3 之前没有解析文本，因此 run_input_files 允许不关联解析记录；有解析文本的输入照常关联。
alter table run_input_files alter column extraction_id drop not null;
