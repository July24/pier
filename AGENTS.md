# AGENTS.md —— 本机/本仓环境注意事项（给在此仓库工作的 agent）

## git SSH：中文用户名 HOME 在 git-bash 下损坏

**症状**：`git fetch/push` 报 `Host key verification failed` 或 `Permission denied (publickey)`；`ssh -v` 可见 HOME 被读成 GBK 乱码路径：

```
debug1: identity file /c/Users/\322\266\360\251\323\356/.ssh/id_rsa type -1   # -1 = 找不到 key
debug1: load_hostkeys: fopen /c/Users/\322\266\360\251\323\356/.ssh/known_hosts: No such file
```

**根因**：Windows 用户名为中文（`叶皓宇`），git-bash 的 ssh 以错误编码展开 `$HOME`，`~/.ssh/id_rsa` 实际存在却读不到。

**workaround**（临时 ASCII 路径 key 副本；用完必删）：

```sh
mkdir -p /f/.tmp-ssh && cp ~/.ssh/id_rsa ~/.ssh/id_rsa.pub /f/.tmp-ssh/
git -c core.sshCommand="ssh -i F:/.tmp-ssh/id_rsa \
  -o UserKnownHostsFile=F:/.tmp-ssh/known_hosts \
  -o StrictHostKeyChecking=accept-new" push origin master
rm -rf /f/.tmp-ssh   # 立即删除 key 副本
```

注：`ssh-keyscan -p 443 ssh.github.com` 在本机也会因 KEX 协商失败拿不到 host key（`unsupported KEX method sntrup761…`），用 `StrictHostKeyChecking=accept-new` 首连记录即可。用户自己的 WarpTerminal push 不受影响；永久修复可在 `~/.ssh/config` 为 `[ssh.github.com]:443` 显式写绝对路径的 `IdentityFile`/`UserKnownHostsFile`。

## pi 配置：权威文件是 `~/.pi/agent/settings.json`

`~/.pi/` 下还有一个顶层 `settings.json`——**pi 不读它**（`PI_CODING_AGENT_DIR` 默认根是 `~/.pi/agent`）。改默认 provider/model 只改顶层文件会看到新 pi 会话仍用旧模型。当前默认：`zai-coding-cn / glm-5.3-highspeed`（2026-08-28 起；此前的 `opencode-go / ox-alpha-free` 已 401 失效）。两处文件已保持同步镜像。

## 中转模型可靠性（本机网络）

`zai-coding-cn` 与 `opencode-go` 的 glm 系模型在 **toolCall 参数流中随机停摆**（pi spinner 挂在工具名 + `working` 不动、execute 无痕迹、会话 jsonl 截断在参数字符串中间、进程恒开一条 TCP）。排障时先怀疑它而不是插件代码；`opencode-go/kimi-k2.7-code` 实测稳定（spike 用 `D98_MODEL` env 切换）。pi 侧中断恢复：herdr `pane.send_keys {keys:["escape"]}` ESC 后重发。
