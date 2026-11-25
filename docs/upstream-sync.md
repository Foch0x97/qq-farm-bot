# 独立维护与更新

原上游 liyangpengs/qq-farm-bot 于 2026-11-25 宣布停更。本仓库从现有版本继续独立维护，2026-11-26 起移除上游自动同步工作流及对应脚本，不再定时或手动触发自动合并。已有功能、部署文件和历史提交保留，原上游 README 的停更替换不合入本仓库。

后续更新统一发布到 https://github.com/Foch0x97/qq-farm-bot ，自行修改的提交标题与说明使用中文。Verify 持续执行共享模块构建、后端测试、前端类型检查与测试、完整构建，验证通过后再合并发布。源码验证不能替代真实账号扫码、掉线恢复及容器部署验证。

## 群晖更新

在项目目录拉取本仓库代码：

```bash
cd /volume1/docker/qq-farm-bot
git pull --ff-only origin master
```

拉取成功后，在群晖 Container Manager 的对应项目中手动重新构建。git pull 只更新源码，不会更新已运行的容器。若本地修改过 docker-compose.yml 且与远端更新冲突，应先保留端口和数据挂载配置再合并，不要覆盖账号数据。

移除自动同步只影响 GitHub 的上游合并任务，不需要重新部署现有容器。历史失败记录仍可在 Actions 中查看；主分支不再注册 Sync upstream 定时任务。
