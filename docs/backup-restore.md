# 备份与离线恢复

新备份使用 `.tle-backup` 文件，完整 TAR（包括清单）由 AES-256-GCM 认证加密。
恢复必须使用备份时的密钥；`--force` 无法跳过加密认证。Compose 默认将密钥保存到
`<EDGE_DATA_ROOT>/.master.key`（0600），恢复 CLI 通过 `MASTER_KEY_FILE` 读取同一文件；
旧部署的 `MASTER_KEY` 环境变量仍然可用。密钥文件不包含在业务备份中，应单独安全保管；
异机恢复时先准备原密钥文件，恢复命令不会自动生成替代密钥。
备份读取已声明实例或其子目录失败时，整个请求失败，不返回缺失这些文件的成功备份。

## 恢复前提和范围

恢复和中断恢复均为离线操作：停止 Manager、所有目标 Node-RED 实例及其他数据写入者，
并确保只运行一个恢复进程。实例是兄弟容器，`docker compose stop manager` 不会停止实例。
这些前提需由运维保证；启动门禁用于阻止未完成事务被使用，不能替代跨进程停机协调。

CLI 要求标准布局：`DATA_DIR=<EDGE_DATA_ROOT>/manager`、
`INSTANCE_DATA_ROOT=<EDGE_DATA_ROOT>/instances`。非标准布局会在读取归档前拒绝。
数据根可以是 Docker bind mount，必须支持根内的同文件系统 rename 和文件/目录 fsync。
恢复进程需要读写、切换和清理这几个目标的权限：

- `manager/edge.db`：替换为备份快照。
- `manager/edge.db-wal`、`manager/edge.db-shm`：删除旧 WAL/SHM，与数据库一起参与回滚。
- `instances`：整体替换；备份中不存在的旧实例、文件、迁移/探针目录会移除。

`manager/npm`、`manager/npm-seed`、`manager/spool` 及其他非恢复目标内容保留。
因此这不是所有 Manager 配置、缓存和运行数据的完整机器镜像。

```sh
docker compose run --rm --entrypoint node manager \
  dist/index.js restore /path/to/backup.tle-backup
```

## 中断恢复

恢复先认证并检查所有待恢复普通文件的目的路径，在数据根内的私有暂存目录写入新快照。
完成暂存和持久化日志后，用 rename 切换固定目标；提交前报错会回滚。
多个目标不是一次系统调用切换：切换期间不得有读写者，也不得启动旧版本 Manager。
当前 Manager 在打开数据库之前检测 `.restore-transaction`，发现事务则拒绝启动。

断电、进程终止或回滚失败后，保留现场与事务日志，继续保持 Manager 和实例停止，执行：

```sh
docker compose run --rm --entrypoint node manager \
  dist/index.js restore --recover
```

未提交事务恢复旧快照，已提交事务保留新快照并完成清理。该命令可以重试。
不要手工删除事务目录来绕过门禁。若恢复命令失败，应排查权限、空间或文件系统错误，
修复后再重试。成功回滚后，可重新执行正常恢复；成功恢复后再启动 Manager 和实例。

## 尚未覆盖的边界

本安全切片不代表发布可接受。历史 v1 明文 TAR 仍自动兼容，显式 legacy 许可与完整 manifest
字段校验及严格 TAR 完整性校验尚未落地。备份/恢复仍全包驻留内存。SQLite 使用一致性快照，但运行中实例的跨文件
一致性尚无保证；文件模式、符号链接及任意空目录也没有完整保真。需要跨文件一致的备份时，
先停止实例和其他实例文件写入者，再由 Manager 下载备份。
