# 1B-T5 团队可见统计性能基线

**生成时间：** 2026-09-11T11:18:12.639Z
**数据规模参数：** 成员 40 · 会话 200 · 共享文件 200 · 热点会话 Run 60 · 团队空间 5（**含个人空间共 6 个可见空间**）· 测量视角成员 1 · 并发 10

> 本文件由 `scripts/bench/team-workspace-statistics.ts` 在一次性库上生成；
> 复跑：`DSH_WORK_TEST_DATABASE_URL=… pnpm bench:team-workspace-statistics --members=40 --sessions=200 --files=200 --spaces=5 --runs=60 --concurrency=10 --out docs/history/team-workspace-1b-statistics.md`。
> 绝对延迟随机器变化，应关注**往返次数**、**相对量级**与**随数据量的增长趋势**。

## 1. 实际数据量

| 对象 | 行数 |
| --- | --- |
| workspaces | 52 |
| members | 102 |
| sessions | 201 |
| runs | 60 |
| files | 360 |
| artifacts | 0 |
| sessionBytes | 240 kB |
| fileBytes | 296 kB |

## 2. 冷启动（授权缓存为空，各 1 次）

| 调用 | SQL 语句数 | p50 (ms) | p95 (ms) | max (ms) | 样例数 |
| --- | --- | --- | --- | --- | --- |
| listWorkspaces（可见空间统计） | 16 | 85 | 85 | 85 | 1 |
| listWorkspaces（另一成员） | 16 | 26.54 | 26.54 | 26.54 | 1 |
| listWorkspaceSessions 首页 | 1 | 2.06 | 2.06 | 2.06 | 1 |
| listWorkspaceFiles 首页 | 3 | 3.14 | 3.14 | 3.14 | 1 |
| listArtifacts（无成果） | 1 | 10.33 | 10.33 | 10.33 | 1 |

## 3. 热路径（20 轮）

| 调用 | SQL 语句数 | p50 (ms) | p95 (ms) | max (ms) | 样例数 |
| --- | --- | --- | --- | --- | --- |
| listWorkspaces（可见空间统计） | 16 | 28.48 | 33.27 | 33.6 | 20 |
| listWorkspaceSessions 首页 | 1 | 0.94 | 1.3 | 1.56 | 20 |
| listWorkspaceSessions 深翻页 | 1 | 0.84 | 1.56 | 29.59 | 20 |
| listWorkspaceSessions 标题搜索 | 1 | 0.79 | 1.46 | 6.63 | 20 |
| listWorkspaceFiles 首页 | 3 | 2.24 | 2.75 | 2.82 | 20 |
| listWorkspaceFiles 深翻页 | 3 | 2.27 | 2.58 | 3.32 | 20 |
| listWorkspaceFiles 名称搜索 | 3 | 2.23 | 2.35 | 2.5 | 20 |
| listArtifacts（无成果） | 1 | 9.59 | 10.05 | 10.45 | 20 |

## 4. 并发

| 调用 | SQL 语句数 | p50 (ms) | p95 (ms) | max (ms) | 样例数 |
| --- | --- | --- | --- | --- | --- |
| 并发 10 路混合读取 | 59 | 58.2 | 58.2 | 58.2 | 1 |

## 5. listArtifacts 可见范围过滤（N+1 复核，同一批数据上的 A/B）

在测量视角成员名下造 200 条团队成果后，对比两种实现形态：

| 调用 | SQL 语句数 | p50 (ms) | p95 (ms) | max (ms) | 样例数 |
| --- | --- | --- | --- | --- | --- |
| 当前实现：按空间去重复核（200 条，冷） | 6 | 32.4 | 32.4 | 32.4 | 1 |
| 当前实现：按空间去重复核（200 条，热） | 3 | 24.57 | 24.57 | 24.57 | 1 |
| 候选实现：逐行门禁（200 条，冷） | 404 | 226.2 | 226.2 | 226.2 | 1 |
| 候选实现：逐行门禁（200 条，热） | 404 | 212.12 | 212.12 | 212.12 | 1 |

个人空间成果（同一成员的个人空间，10 条）：

| 调用 | SQL 语句数 | p50 (ms) | p95 (ms) | max (ms) | 样例数 |
| --- | --- | --- | --- | --- | --- |
| 个人空间成果（10 条） | 3 | 22.49 | 22.49 | 22.49 | 1 |

## 6. 关键查询计划

### listWorkspaces 主查询（可见空间 + 成员/会话/成果计数 + updatedAt 排序）

```
Sort  (cost=43.54..43.54 rows=1 width=84) (actual time=4780.825..4780.834 rows=6 loops=1)
  Sort Key: (GREATEST(w.created_at, COALESCE(max(s.last_active_at), w.created_at))) DESC
  Sort Method: quicksort  Memory: 25kB
  Buffers: shared hit=139119, temp read=155106 written=155283
  ->  GroupAggregate  (cost=43.43..43.53 rows=1 width=84) (actual time=0.676..4780.820 rows=6 loops=1)
        Group Key: w.id, creator.display_name
        Buffers: shared hit=139119, temp read=155106 written=155283
        ->  Incremental Sort  (cost=43.43..43.48 rows=2 width=176) (actual time=0.640..2054.336 rows=3448712 loops=1)
              Sort Key: w.id, creator.display_name, wm.user_id
              Presorted Key: w.id
              Full-sort Groups: 2  Sort Method: quicksort  Average Memory: 33kB  Peak Memory: 33kB
              Pre-sorted Groups: 6  Sort Methods: quicksort, external merge  Average Memory: 16kB  Peak Memory: 25kB  Average Disk: 150661kB  Peak Disk: 451984kB
              Buffers: shared hit=139119, temp read=112991 written=113130
              ->  Nested Loop Left Join  (cost=0.95..43.42 rows=1 width=176) (actual time=0.130..451.976 rows=3448712 loops=1)
                    Buffers: shared hit=139119
                    ->  Nested Loop Left Join  (cost=0.68..35.12 rows=1 width=176) (actual time=0.118..4.975 rows=17265 loops=1)
                          Join Filter: (s.workspace_id = w.id)
                          Rows Removed by Join Filter: 5763
                          Buffers: shared hit=1111
                          ->  Nested Loop Left Join  (cost=0.40..26.82 rows=1 width=136) (actual time=0.064..0.190 rows=56 loops=1)
                                Buffers: shared hit=47
                                ->  Nested Loop  (cost=0.13..18.51 rows=1 width=104) (actual time=0.046..0.092 rows=6 loops=1)
                                      Join Filter: (creator.id = w.created_by)
                                      Rows Removed by Join Filter: 13
                                      Buffers: shared hit=21
                                      ->  Index Scan using workspaces_tenant_id_id_key on workspaces w  (cost=0.13..16.45 rows=1 width=104) (actual time=0.042..0.067 rows=6 loops=1)
                                            Index Cond: (tenant_id = 'tenant-dsh-work'::text)
                                            Filter: ((status = 'active'::text) AND (((workspace_type = 'personal'::text) AND (created_by = 'bench-actor-0-5ac3f5d5'::text)) OR ((workspace_type = 'team'::text) AND (ANY ((tenant_id = (hashed SubPlan 2).col1) AND (id = (hashed SubPlan 2).col2))))))
                                            Rows Removed by Filter: 46
                                            Buffers: shared hit=9
                                            SubPlan 2
                                              ->  Seq Scan on workspace_members access  (cost=0.00..15.12 rows=2 width=64) (actual time=0.004..0.010 rows=6 loops=1)
                                                    Filter: (user_id = 'bench-actor-0-5ac3f5d5'::text)
                                                    Rows Removed by Filter: 96
                                                    Buffers: shared hit=2
                                      ->  Seq Scan on users creator  (cost=0.00..2.05 rows=1 width=96) (actual time=0.002..0.002 rows=3 loops=6)
                                            Filter: (tenant_id = 'tenant-dsh-work'::text)
                                            Buffers: shared hit=12
                                ->  Index Only Scan using workspace_members_pkey on workspace_members wm  (cost=0.27..8.29 rows=1 width=96) (actual time=0.006..0.013 rows=9 loops=6)
                                      Index Cond: ((tenant_id = 'tenant-dsh-work'::text) AND (workspace_id = w.id))
                                      Heap Fetches: 56
                                      Buffers: shared hit=26
                          ->  Index Scan using sessions_by_workspace on sessions s  (cost=0.27..8.29 rows=1 width=104) (actual time=0.004..0.038 rows=411 loops=56)
                                Index Cond: (tenant_id = 'tenant-dsh-work'::text)
                                Buffers: shared hit=1064
                    ->  Index Scan using artifacts_by_workspace on artifacts a  (cost=0.27..8.29 rows=1 width=96) (actual time=0.006..0.016 rows=200 loops=17265)
                          Index Cond: ((tenant_id = 'tenant-dsh-work'::text) AND (workspace_id = w.id))
                          Buffers: shared hit=138008
Planning:
  Buffers: shared hit=29
Planning Time: 0.396 ms
Execution Time: 4780.973 ms
```

### listWorkspaceSessions 首页（与实现同形：本人范围 + 状态过滤 + 最新 Run 侧连接 + Run 计数）

```
Limit  (cost=17.14..371.55 rows=21 width=117) (actual time=0.093..0.118 rows=21 loops=1)
  Buffers: shared hit=135
  ->  Result  (cost=17.14..3966.30 rows=234 width=117) (actual time=0.092..0.117 rows=21 loops=1)
        Buffers: shared hit=135
        ->  Incremental Sort  (cost=17.14..2020.01 rows=234 width=129) (actual time=0.079..0.080 rows=21 loops=1)
              Sort Key: s.last_active_at DESC, s.id DESC
              Presorted Key: s.last_active_at
              Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 30kB  Peak Memory: 30kB
              Buffers: shared hit=72
              ->  Nested Loop Left Join  (cost=8.58..2009.48 rows=234 width=129) (actual time=0.033..0.071 rows=22 loops=1)
                    Buffers: shared hit=72
                    ->  Nested Loop  (cost=0.27..56.75 rows=234 width=101) (actual time=0.017..0.028 rows=22 loops=1)
                          Buffers: shared hit=6
                          ->  Index Scan using sessions_by_owner on sessions s  (cost=0.27..51.15 rows=234 width=86) (actual time=0.013..0.015 rows=22 loops=1)
                                Index Cond: ((tenant_id = 'tenant-dsh-work'::text) AND (created_by = 'bench-actor-0-5ac3f5d5'::text))
                                Filter: ((workspace_id = 'ws-bench-main-5ac3f5d5'::text) AND (status = 'active'::text))
                                Rows Removed by Filter: 10
                                Buffers: shared hit=4
                          ->  Materialize  (cost=0.00..2.68 rows=1 width=54) (actual time=0.000..0.000 rows=1 loops=22)
                                Buffers: shared hit=2
                                ->  Seq Scan on users u  (cost=0.00..2.67 rows=1 width=54) (actual time=0.003..0.008 rows=1 loops=1)
                                      Filter: ((tenant_id = 'tenant-dsh-work'::text) AND (id = 'bench-actor-0-5ac3f5d5'::text))
                                      Rows Removed by Filter: 44
                                      Buffers: shared hit=2
                    ->  Limit  (cost=8.30..8.32 rows=1 width=36) (actual time=0.002..0.002 rows=1 loops=22)
                          Buffers: shared hit=66
                          ->  Incremental Sort  (cost=8.30..8.35 rows=2 width=36) (actual time=0.002..0.002 rows=1 loops=22)
                                Sort Key: r.created_at DESC, r.id DESC
                                Presorted Key: r.created_at
                                Full-sort Groups: 22  Sort Method: quicksort  Average Memory: 25kB  Peak Memory: 25kB
                                Buffers: shared hit=66
                                ->  Index Scan using runs_by_session on runs r  (cost=0.27..8.29 rows=1 width=36) (actual time=0.001..0.001 rows=1 loops=22)
                                      Index Cond: ((tenant_id = s.tenant_id) AND (session_id = s.id))
                                      Buffers: shared hit=66
        SubPlan 1
          ->  Aggregate  (cost=8.29..8.31 rows=1 width=4) (actual time=0.001..0.002 rows=1 loops=21)
                Buffers: shared hit=63
                ->  Index Only Scan using runs_by_session on runs r_1  (cost=0.27..8.29 rows=1 width=0) (actual time=0.001..0.001 rows=1 loops=21)
                      Index Cond: ((tenant_id = s.tenant_id) AND (session_id = s.id))
                      Heap Fetches: 21
                      Buffers: shared hit=63
Planning:
  Buffers: shared hit=164
Planning Time: 0.462 ms
Execution Time: 0.161 ms
```

### listWorkspaceSessions 深翻页（数据量中点处的 keyset 游标）

```
Limit  (cost=0.84..13.30 rows=21 width=47) (actual time=0.016..0.017 rows=15 loops=1)
  Buffers: shared hit=6
  ->  Incremental Sort  (cost=0.84..34.67 rows=57 width=47) (actual time=0.016..0.016 rows=15 loops=1)
        Sort Key: last_active_at DESC, id DESC
        Presorted Key: last_active_at
        Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 26kB  Peak Memory: 26kB
        Buffers: shared hit=6
        ->  Index Scan using sessions_by_owner on sessions s  (cost=0.27..32.10 rows=57 width=47) (actual time=0.006..0.012 rows=15 loops=1)
              Index Cond: ((tenant_id = 'tenant-dsh-work'::text) AND (created_by = 'bench-actor-0-5ac3f5d5'::text) AND (last_active_at <= '2026-09-11 09:38:05+00'::timestamp with time zone))
              Filter: ((workspace_id = 'ws-bench-main-5ac3f5d5'::text) AND (ROW(last_active_at, id) < ROW('2026-09-11 09:38:05+00'::timestamp with time zone, 'session-bench-100-5ac3f5d5'::text)))
              Buffers: shared hit=6
Planning:
  Buffers: shared hit=10
Planning Time: 0.061 ms
Execution Time: 0.034 ms
```

### listWorkspaceFiles 首页（共享文件 + 游标）

```
Limit  (cost=0.84..10.19 rows=21 width=47) (actual time=0.041..0.043 rows=21 loops=1)
  Buffers: shared hit=91
  ->  Incremental Sort  (cost=0.84..113.50 rows=253 width=47) (actual time=0.041..0.042 rows=21 loops=1)
        Sort Key: f.created_at DESC, f.id DESC
        Presorted Key: f.created_at
        Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 27kB  Peak Memory: 27kB
        Buffers: shared hit=91
        ->  Nested Loop  (cost=0.43..102.12 rows=253 width=47) (actual time=0.013..0.038 rows=22 loops=1)
              Buffers: shared hit=91
              ->  Index Scan using file_objects_workspace_active on file_objects f  (cost=0.28..86.40 rows=253 width=86) (actual time=0.007..0.016 rows=22 loops=1)
                    Index Cond: ((tenant_id = 'tenant-dsh-work'::text) AND (workspace_id = 'ws-bench-main-5ac3f5d5'::text))
                    Filter: ((session_id IS NULL) AND (scan_status <> 'blocked'::text))
                    Rows Removed by Filter: 22
                    Buffers: shared hit=47
              ->  Memoize  (cost=0.15..0.23 rows=1 width=39) (actual time=0.001..0.001 rows=1 loops=22)
                    Cache Key: f.uploaded_by
                    Cache Mode: logical
                    Hits: 0  Misses: 22  Evictions: 0  Overflows: 0  Memory Usage: 4kB
                    Buffers: shared hit=44
                    ->  Index Only Scan using users_tenant_id_id_key on users u  (cost=0.14..0.22 rows=1 width=39) (actual time=0.001..0.001 rows=1 loops=22)
                          Index Cond: ((tenant_id = 'tenant-dsh-work'::text) AND (id = f.uploaded_by))
                          Heap Fetches: 22
                          Buffers: shared hit=44
Planning:
  Buffers: shared hit=66
Planning Time: 0.171 ms
Execution Time: 0.052 ms
```

### listArtifacts（按作者 + 空间类型，用于可见范围过滤）

```
Sort  (cost=78.48..78.78 rows=123 width=61) (actual time=0.362..0.368 rows=210 loops=1)
  Sort Key: av.created_at DESC
  Sort Method: quicksort  Memory: 41kB
  Buffers: shared hit=42
  ->  Hash Left Join  (cost=43.37..74.21 rows=123 width=61) (actual time=0.265..0.326 rows=210 loops=1)
        Hash Cond: (a.workspace_id = w.id)
        Buffers: shared hit=42
        ->  Hash Join  (cost=40.07..70.56 rows=123 width=69) (actual time=0.247..0.288 rows=210 loops=1)
              Hash Cond: (f.id = av.file_object_id)
              Buffers: shared hit=40
              ->  Seq Scan on file_objects f  (cost=0.00..27.12 rows=570 width=37) (actual time=0.004..0.052 rows=570 loops=1)
                    Filter: (tenant_id = 'tenant-dsh-work'::text)
                    Buffers: shared hit=20
              ->  Hash  (cost=38.53..38.53 rows=123 width=102) (actual time=0.194..0.195 rows=210 loops=1)
                    Buckets: 1024  Batches: 1  Memory Usage: 37kB
                    Buffers: shared hit=20
                    ->  Hash Join  (cost=29.89..38.53 rows=123 width=102) (actual time=0.130..0.171 rows=210 loops=1)
                          Hash Cond: (av.artifact_id = a.id)
                          Buffers: shared hit=20
                          ->  Seq Scan on artifact_versions av  (cost=0.00..6.62 rows=210 width=63) (actual time=0.005..0.019 rows=210 loops=1)
                                Filter: (tenant_id = 'tenant-dsh-work'::text)
                                Buffers: shared hit=4
                          ->  Hash  (cost=28.35..28.35 rows=123 width=57) (actual time=0.124..0.125 rows=210 loops=1)
                                Buckets: 1024  Batches: 1  Memory Usage: 27kB
                                Buffers: shared hit=16
                                ->  Hash Join  (cost=20.16..28.35 rows=123 width=57) (actual time=0.071..0.106 rows=210 loops=1)
                                      Hash Cond: (a.session_id = s.id)
                                      Buffers: shared hit=16
                                      ->  Seq Scan on artifacts a  (cost=0.00..7.62 rows=210 width=77) (actual time=0.002..0.015 rows=210 loops=1)
                                            Filter: (tenant_id = 'tenant-dsh-work'::text)
                                            Buffers: shared hit=5
                                      ->  Hash  (cost=17.16..17.16 rows=240 width=39) (actual time=0.062..0.062 rows=240 loops=1)
                                            Buckets: 1024  Batches: 1  Memory Usage: 25kB
                                            Buffers: shared hit=11
                                            ->  Seq Scan on sessions s  (cost=0.00..17.16 rows=240 width=39) (actual time=0.003..0.040 rows=240 loops=1)
                                                  Filter: ((tenant_id = 'tenant-dsh-work'::text) AND (created_by = 'bench-actor-0-5ac3f5d5'::text))
                                                  Rows Removed by Filter: 171
                                                  Buffers: shared hit=11
        ->  Hash  (cost=2.65..2.65 rows=52 width=57) (actual time=0.014..0.014 rows=52 loops=1)
              Buckets: 1024  Batches: 1  Memory Usage: 13kB
              Buffers: shared hit=2
              ->  Seq Scan on workspaces w  (cost=0.00..2.65 rows=52 width=57) (actual time=0.003..0.007 rows=52 loops=1)
                    Filter: (tenant_id = 'tenant-dsh-work'::text)
                    Buffers: shared hit=2
Planning:
  Buffers: shared hit=129
Planning Time: 0.467 ms
Execution Time: 0.409 ms
```
