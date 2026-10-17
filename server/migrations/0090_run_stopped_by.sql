-- 项目空间方案第 5 节：停止沿用现有取消，并在线程中标注由谁停止。
-- 记录第一个请求停止该 Run 的员工；系统撤权取消不写入（显示为授权撤销）。
alter table runs add column cancel_requested_by text;
alter table runs add constraint runs_cancel_requested_by_fk
  foreign key (tenant_id, cancel_requested_by) references users(tenant_id, id);
