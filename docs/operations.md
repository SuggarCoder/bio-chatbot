# 运维手册

适用于单机部署，规模约 100 人同时在线。本文涵盖部署拓扑、滚动发布、监控、备份恢复、Redis 配置和故障处置。数据保留期限见 [data-retention.md](data-retention.md)，容量上限、实测数据与扩容时机见 [capacity.md](capacity.md)，首次部署清单见 [production-deployment.md](production-deployment.md)。

## 1. 拓扑

```
nginx (GPAS2 HTTPS) ──upstream──▶ app   :8090 ┐
                                  app-2 :8091 ┤── PostgreSQL (pgvector, pg17)
                                  worker      ┤── Redis
                                  worker-2    ┘
                                  db-backup ──▶ BACKUP_DIR、node-exporter textfile
Prometheus / Alertmanager / Grafana (deploy/monitoring) ── 抓取各实例 :9464/metrics
```

| 服务 | 内存上限 | 堆上限 | PG 连接池 | 停止宽限期 |
|---|---|---|---|---|
| app / app-2 | 2g（`API_MEM_LIMIT`） | 1536 MiB（`NODE_HEAP_MB`） | 12（`API_PG_POOL_MAX`） | 30 s |
| worker / worker-2 | 3g（`WORKER_MEM_LIMIT`） | 1536 MiB | 12（`WORKER_PG_POOL_MAX`） | 200 s（排空） |
| db-backup | 1g | — | 1 | — |

- **数据库连接**：2×12 + 2×12 = 48，加上备份、导出器和人工运维，`max_connections` 保持默认的 100 即可。如果服务器 `.env` 里还写着旧值 `API_PG_POOL_MAX=20` / `WORKER_PG_POOL_MAX=16`，总数是 72，仍在预算内，但建议删掉这两行，使用新的默认值。
- **上游模型并发**：生成并发上限 96 是 Redis 中的全局限额，两个 worker 共享。后台并发按 worker 计，2×2 = 4。合计 96 + 4 = 100，不超过 `UPSTREAM_CONCURRENCY`。增加 worker 时要重新核算。
- **健康检查**：
  - 容器健康检查（存活）：`:9464/healthz`，只说明进程在运行、循环在转动。
  - 就绪检查：`/ai-chatbot/api/health`。只有当 `status` 为 `ok`（PostgreSQL、Redis、worker 心跳都正常）时，发布流程才继续。
  - 依赖短暂中断时容器不会被重启，进程会自行重连。

## 2. 发布

向 `main` 推送后由 GitHub Actions 自动执行，流程如下：

1. 构建镜像。
2. 执行 `storage-init` 和 `migrate`。
3. 用 `up --no-recreate` 补齐缺失的服务（首次发布会创建 app-2、worker-2 和 db-backup）。
4. 依次替换 app → app-2 → worker → worker-2。每个实例必须先通过容器健康检查，并且就绪检查返回 `"status":"ok"`，才会继续下一个。
5. worker 收到 SIGTERM 后不再领取新任务，最多等待 170 s（`WORKER_DRAIN_TIMEOUT_MS`）让进行中的生成完成，然后中断剩余任务，由另一个 worker 接手。
6. 最后检查 8090 和 8091 两个端口都处于就绪状态。

任何一步失败都会停止发布。尚未替换的实例继续运行旧版本，服务不中断。

### 迁移必须向后兼容

滚动发布期间，旧版本和新版本会同时连接同一个数据库，迁移必须遵循"先扩展、后收缩"：

- 允许：新增表、新增可空列或带默认值的列、新增索引（大表使用 `CREATE INDEX CONCURRENTLY`，见下文）。
- 需要分两次发布：删除或重命名列、收紧约束。先发布不再使用该列的代码，下一次发布再删除。
- 已有迁移 0000–0005 都是扩展型。

大表加索引时，drizzle 生成的 `CREATE INDEX` 会锁写。当某张表超过约百万行时，应把语句手工改为 `CREATE INDEX CONCURRENTLY`，并单独作为一个迁移文件（它不能在事务内执行）。

### 回滚

```bash
git revert <commit> && git push origin main
```

回滚同样走滚动发布。迁移不会自动回滚，因为扩展型迁移对旧代码无害。

## 3. 监控

```bash
cd deploy/monitoring
docker compose -f compose.monitoring.yml -p ai-chatbot-monitoring up -d
```

- **访问**：Prometheus、Alertmanager 和 Grafana 只监听 127.0.0.1，通过 SSH 隧道访问。Grafana 的初始密码由 `GRAFANA_ADMIN_PASSWORD` 设置。
- **告警通知**：在 `alertmanager.yml` 的 receiver 中填写企业微信、钉钉或邮件的 webhook。
- **数据保留**：Prometheus 保留 30 天，且不超过 10 GB。
- **备份指标**：node-exporter 读取 `NODE_EXPORTER_TEXTFILE_DIR`（默认 `/home/lu/node-exporter-textfile`）中的 `chatbot_backup.prom`。该目录必须与 db-backup 使用的是同一个目录。
- **规则校验**：PromQL 规则尚未在 promtool 中执行过。首次启动后，在 Prometheus 的 Status → Rules 页面确认所有规则都已加载，状态为 OK 而非 error。也可以执行：

  ```bash
  docker run --rm -v "$PWD:/c" --entrypoint promtool prom/prometheus:v2.53.2 check rules /c/alerts.yml
  ```

### 告警处置

| 告警 | 先看哪里 | 常见处置 |
|---|---|---|
| ChatbotTargetDown、WorkerLoopStalled | `docker compose ps`、实例日志 | 进程卡住时重启该实例，另一个实例继续服务 |
| WorkerLoopStepFailing、RedisErrors、PostgresDown | 查看 Grafana 的依赖面板和 worker 的 `/healthz` 详情 | 检查 PostgreSQL 和 Redis。应用会自动重连，无需重启 |
| ApiServerErrors、GenerationErrorRateHigh | 查看日志中的 error 和 errorCode 分布 | 先区分是上游模型、GPAS 还是自身代码出错 |
| ApiLoadShedding、EventLoopLagHigh、DatabasePoolSaturated | 查看事件循环延迟、连接池等待，以及 `pg_stat_activity` 中的慢查询 | 短时出现属于正常保护；持续出现则排查慢查询或扩容 |
| GenerationQueueBacklog | 查看排队数和上游并发 | 上游限额已满。可提高 `UPSTREAM_CONCURRENCY` 等配额，或接受排队 |
| HeapNearLimit | 查看该实例的内存曲线 | 临时处置为重启该实例；根因需在测试环境用 `--inspect` 抓堆快照来定位 |
| GpasDegraded | GPAS 熔断状态 | GPAS 上游故障，熔断器会自动恢复 |
| RedisMemoryHigh | Redis 内存 | 见第 5 节 |
| PostgresConnectionsHigh | 按 application_name 分组查看 `pg_stat_activity` | 核对连接预算（第 1 节） |
| DiskSpaceLow | `df -h`、`du -sh BACKUP_DIR` | 缩短备份保留期，或把备份移到独立磁盘 |
| BackupMissing、BackupFailed、BackupRestoreCheckStale | `docker logs ai-chatbot-db-backup` | 检查磁盘、数据库连通性和权限，然后手动执行一次备份（见下节） |

## 4. 备份与恢复

### 逻辑备份（已启用）

db-backup 服务每天 UTC 18:00（北京时间 02:00）执行 `pg_dump -Fc`：

- 备份写入 `BACKUP_DIR/daily`，保留 14 天；每周日另存一份到 `weekly`，保留 8 周。
- 每个文件都会先用 `pg_restore --list` 校验可读，并附带 sha256 校验文件。
- 如果上次成功距今超过 26 小时（例如首次启动或漏跑），会立即补做；失败后每小时重试一次。
- 每周把最新备份完整恢复到临时库 `<库名>_restore_check`，检查表数、迁移记录和用户表，然后删除临时库。这一步要求数据库账号有 CREATEDB 权限，并能创建 vector 扩展（docker 官方镜像的默认账号是超级用户，满足要求）。如果权限不足，设置 `BACKUP_VERIFY_RESTORE=false`，并改为手动演练。

手动立即备份一次：

```bash
docker compose -p ai-chatbot exec db-backup bash /backup/backup.sh now
```

**异地副本（强烈建议）**：同一台机器上的备份防不住磁盘或主机故障。

- 把 `BACKUP_DIR` 放在独立磁盘上。
- 在宿主机 cron 中每天同步到另一台机器或对象存储，例如：

  ```bash
  rsync -a --delete /home/lu/backups/ai-chatbot/ backup-host:/srv/ai-chatbot/
  ```

  或使用 `rclone sync` 同步到 OSS/S3。

### 恢复（灾难恢复演练也按此执行）

1. 停止 API 和 worker：

   ```bash
   docker compose -p ai-chatbot stop app app-2 worker worker-2
   ```

2. 校验 sha256 后，在单个事务内覆盖恢复：

   ```bash
   docker compose -p ai-chatbot run --rm --entrypoint bash -e RESTORE_CONFIRM=<库名> db-backup /backup/restore.sh /backups/daily/chatbot-<时间>.dump
   ```

3. 清理本应用的 Redis 键。其中的流、队列和缓存都引用被替换前的数据。`<前缀>` 即 `REDIS_KEY_PREFIX`，默认 `gpas2cb:prod:v3:`：

   ```bash
   redis-cli --scan --pattern '<前缀>*' | xargs -r -n 500 redis-cli del
   ```

4. 启动服务：

   ```bash
   docker compose -p ai-chatbot up -d
   ```

5. 打开任意会话，确认能正常读取和对话。

恢复点为最近一次每日备份，最多可能丢失 24 小时数据。如果需要更小的恢复点，见下一节。

### WAL 归档与时间点恢复（PITR，建议正式运营前启用）

逻辑备份的恢复点目标（RPO）是 24 小时。若要做到分钟级 RPO，可在 PostgreSQL 容器上启用 WAL 归档，推荐使用 pgBackRest 或 WAL-G。

1. 在 postgresql.conf 中设置：

   ```
   wal_level = replica
   archive_mode = on
   archive_command = 'pgbackrest --stanza=chatbot archive-push %p'
   archive_timeout = 60
   ```

   设置后需要重启数据库。

2. 每周做一次全量备份，每天做一次增量备份。备份仓库放在独立磁盘或对象存储上，`repo1-retention-full=4`。

3. 恢复到指定时间点：

   ```bash
   pgbackrest --stanza=chatbot --type=time --target="2026-11-03 10:00:00+08" restore
   ```

4. 启用后保留逻辑备份。它们是独立的第二道保障，也可以用来单独恢复某张表。

## 5. Redis

Redis 只承担协调和实时数据，权威数据都在 PostgreSQL。清空 Redis 只会中断进行中的生成，不会丢失会话数据。

建议的 redis.conf：

```
maxmemory 1gb
maxmemory-policy noeviction
appendonly no
save ""
```

- **为什么用 `noeviction`**：队列、租约和去重键不能被悄悄淘汰。被淘汰会导致重复执行或任务丢失；改为写入失败时，应用会返回 503 并重试，这是可以看到、也可以恢复的。
- **内存估算**（100 人同时在线）：
  - 每个进行中的生成占用约 0.2–1 MB（合并后的事件流、快照和租约）。按 96 路计，峰值约 100 MB。
  - 生成结束后，事件流保留 3–10 分钟。
  - 上下文缓存 15 分钟，每个会话几十 KB。
  - 合计稳定在 100–300 MB，1 GB 有充足余量。
- **监控**：在 Grafana 的 Redis 面板（redis_exporter）关注 `used_memory` 占 maxmemory 的比例。告警 RedisMemoryHigh 的阈值为 70%。

## 6. 常用命令

```bash
docker compose -p ai-chatbot ps
```

```bash
docker compose -p ai-chatbot logs -f --tail=200 app worker
```

```bash
curl -s http://10.88.20.19:8090/ai-chatbot/api/health | jq
```

```bash
docker exec ai-chatbot-worker node -e "fetch('http://127.0.0.1:9464/healthz').then(r=>r.text()).then(console.log)"
```

重启单个实例（另一个继续服务；worker 会先排空）：

```bash
docker compose -p ai-chatbot restart app-2
```
