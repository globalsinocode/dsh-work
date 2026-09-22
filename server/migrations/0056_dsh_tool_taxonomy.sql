-- 统一工具分类后，DSH Connector 只代表由 DSH Runtime 提供的普通内置工具。
-- 保留稳定 connector id，避免影响现有 Tool Version、Binding 和运行证据。
update connectors
   set name = 'DSH Runtime 内置工具连接器',
       scope_description = '承载 DSH Runtime 普通内置工具；仅访问当前 Run 显式挂载的工作空间与输入文件。',
       updated_at = now()
 where tenant_id = 'tenant-dsh-work'
   and id = 'connector-dsh-workspace';
