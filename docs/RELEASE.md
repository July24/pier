# 发版流程（tag → npm 自动发布）· 维护者内部文档

> 本页从 README 移入（README 面向使用者，发版细节我们自己知道即可）。
> 守卫逻辑在 `.githooks/pre-push`；本页是完整姿势说明。

发版时**三处版本号必须一致**（由 `.githooks/pre-push` 守卫，不一致会拒绝 push tag）：

| 位置 | 对应 npm 包 |
|---|---|
| git tag（兼容 `v0.2.0` / `0.2.0`） | 触发发布 |
| `packages/pier-ext/package.json` 的 `version` | `pi-pier` |
| 根 `package.json` 的 `version` | `pier-setup` |

```sh
# 1. 同时修改两处 version → 目标版本（必须大于 npm 已有版本）
# 2. 提交后打同名 tag 并推送：
git commit -am "release: 0.2.0"
git tag 0.2.0
git push && git push --tags   # GitHub Actions 自动跑测试并经 Trusted Publishing 发布到 npm
```

规则：

- hook 安装：clone 后执行一次 `git config core.hooksPath .githooks`（`npm install` 会经 prepare 脚本自动配置）
- 版本号只能递增：npm 同版本不可重发；旧 tag 名不可复用
- tag 删除推送（全零 sha）不校验（见 pre-push）
