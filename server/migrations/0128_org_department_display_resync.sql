-- 企业组织架构方案（docs/design/org-structure-plan.md）第 3 节（2026-11-03 调整）：员工的“部门”只由
-- 组织架构维护，AI Hub 登录与目录同步不再写入 users.department_id。
--
-- 迁移 0113 清空历史部门文本时跳过了 AI Hub 账号（当时仍由目录同步维护）。同步停止写入后，这些
-- 旧组织名会一直留着，与组织架构不一致。这里把 AI Hub 账号的显示部门统一为主部门名称，没有主部门
-- 时清空（显示“未分配部门”）。可重复执行。

update users u
   set department_id = primary_department.name,
       updated_at = now()
  from (
    select ai_hub.id as user_id, (
             select d.name from org_department_members m
               join org_departments d on d.tenant_id = m.tenant_id and d.id = m.department_id
              where m.tenant_id = ai_hub.tenant_id and m.user_id = ai_hub.id and m.is_primary
           ) as name, ai_hub.tenant_id
      from users ai_hub
     where ai_hub.identity_provider = 'ai-hub'
  ) primary_department
 where u.tenant_id = primary_department.tenant_id and u.id = primary_department.user_id
   and u.department_id is distinct from primary_department.name;
