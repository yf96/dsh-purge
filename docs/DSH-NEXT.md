# 此 fork 的 DSH NEXT 适配

本分支在 [YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge) 1.1.78 的基础上适配 DSH NEXT。保留原作者署名与许可证。DSH NEXT 是社区项目，与 DeepSeek 官方桌面端不同。

当前范围：Windows **DSH NEXT 2.0.19-next / Harness 0.2.1-rc.2**，插件版本 **1.1.78-next.2**。应用前会核对这两个版本及程序包布局；未知版本会在解包前停止。

## 安装到客户端

在客户端实际使用的 `profiles/desktop` 目录执行：

```powershell
pnpm add https://codeload.github.com/yf96/dsh-purge/tar.gz/refs/heads/compat/dsh-next --ignore-scripts
node node_modules/dsh-purge/scripts/ensure-profile-bundle.mjs
```

不要在 Web profile、源码仓库根或其它客户端的目录执行。安装操作本身不解包、不应用补丁、不重启客户端。原来的其它 bundles 应保留。

随后由使用者完全退出客户端（包括托盘）并重新打开。“清洗”侧栏的宿主标记应显示 **DSH NEXT**。密封包在首次应用前还没有可写的程序目录，显示“已识别，应用时解包”属于预期状态。

在侧栏点击“应用”后，插件才会将本次安装的 `resources/app.asar` 解到旁边的 `resources/app`，按原机制备份目标文件并应用补丁；重启时保留原归档为 `app.asar.bak`，后续加载解开的目录。本分支不将 DSH NEXT 当成官方客户端，也不套用官方外壳的专用补丁或 CLI 改写。重启辅助程序仅处理所选安装路径的进程。桌面应用不会枚举或修改独立的 Web/npm 安装。

## 验证与限制

```powershell
npm test
node scripts/verify-next-install.mjs '<DSH NEXT 程序完整路径>'
node --expose-internals scripts/verify-next-copy.mjs '<DSH NEXT 程序完整路径>'
```

第二条只读核对实际安装的身份、内核和归档哈希。第三条在源码仓库的 `.scratch` 中建立独立副本，使用该版本的真实加载器核对四个插件组件，并在副本上执行补丁、语法检查和逐字节还原检查；不启动或停止客户端，不访问模型账号与会话。

上述验证不能代替使用者在真实客户端上的应用、重启和聊天验证。未验证其它 DSH NEXT 版本、macOS 或 Linux。可选组件不存在时仍按原插件逻辑跳过。

更新来源固定为本 fork 的 `compat/dsh-next` 分支。上游版本需要先合并、重新验证后再使用，不能把上游更新直接视为已经兼容。

## 恢复

界面正常时，先使用“清洗 → 还原”恢复目标文件，再由使用者重启。原机制保留用户提示词文件。

如果应用后的客户端无法启动，完全退出它并保留当前文件：在确认原 `app.asar` 不存在、`app.asar.bak` 是该次应用前的归档后，将 `resources/app` 改名留存，再把 `app.asar.bak` 恢复为 `app.asar`。不要删除用户的 `.dsh` 数据目录，也不要覆盖其它版本的归档。

## next.2 的切换修正

归档切换辅助脚本现在会验证移动结果；失败时保留旧归档、停止重新启动并将原因写到临时目录中对应的 `dsh-purge-asar-swap-<pid>.ps1.log`。DSH NEXT 的切换过程由独立辅助进程完成，不提前请求仅重启 Host。

如果已有补丁和备份，但客户端仍从 `app.asar` 加载，重新启动并加载适配版后，清洗页会再次提示完成整应用切换。应选择该提示里的重启操作，无需重复应用补丁。
