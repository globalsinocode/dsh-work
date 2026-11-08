-- 主动任务接入输入预检（数据防护方案 5.6.1）：保存时和每次触发时各查一次。
alter table data_protection_input_blocks drop constraint data_protection_input_blocks_entry_check;
alter table data_protection_input_blocks add constraint data_protection_input_blocks_entry_check
  check (entry in ('conversation', 'task-execution', 'automation-save', 'automation-trigger', 'routine-save', 'routine-trigger'));
