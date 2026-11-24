# 鸿蒙端部署与跨端同步指南

> 适用于 Ink Canvas 鸿蒙端（HarmonyOS API 26 / HarmonyOS 7.x）。本文覆盖环境、构建、签名、安装、模拟器与 InkCast 局域网同步，以及常见故障排查。

## 1. 环境要求

| 项 | 版本/路径 |
|---|---|
| DevEco command-line-tools | 26.0.1.x（自带 node/jre） |
| HarmonyOS SDK | 26.0.1 / API 26（hms + openharmony） |
| 工具链根目录 | `D:\Huawei\DevEcoCLI\command-line-tools` |
| 缓存目录 | `D:\Huawei\cache\{hvigor,ohpm,npm}` |
| 仓库实体路径 | `D:\Ink-Canvas-HEHS`（必须 ASCII，详见 §2） |

会话环境脚本 `tools/harmony-env.ps1` 已把 `PATH`、`OHOS_BASE_SDK_HOME`、`HVIGOR_USER_HOME` 指向 D 盘，使用前先 dot-source：

```powershell
. D:\Ink-Canvas-HEHS\tools\harmony-env.ps1
```

## 2. 构建

> hvigor 硬性限制：工程路径只能包含字母/数字/-/_/./括号/空格/@。**中文路径会直接报 `00306003`**（junction 也会被 realpath 解析）。

```powershell
. D:\Ink-Canvas-HEHS\tools\harmony-env.ps1
cd D:\Ink-Canvas-HEHS\harmony
ohpm install --all
hvigorw assembleHap --mode module -p product=default -p buildMode=debug --no-daemon
```

产物：

```
harmony/entry/build/default/outputs/default/entry-default-signed.hap
```

彻底重建（代码改动未生效时）：

```powershell
hvigorw clean --no-daemon
hvigorw assembleHap --mode module -p product=default -p buildMode=debug --no-daemon
```

## 3. 签名

真机只接受已签名 HAP，未签名会报 `9568320 no signature file`。

- 团队调试证书由 DevEco 自动签名生成，位于 `C:\Users\<user>\.ohos\config\default_*.{p12,cer,p7b}`；
- 工程内 `.sign/sign-config.json5` 保存了同一套配置（密码为加密串，hvigor 构建时自动解密）；
- `build-profile.json5` 的 `app.signingConfigs` 引用该配置即可直接产出 signed HAP；
- 给**第三方 HAP**（例如团队成员的 release 包）签名时，可用 `hap-sign-tool.jar` + 解密后的密码（`DecipherUtil.decryptPwd`），命令示例：

```powershell
java -jar hap-sign-tool.jar sign-app -keyAlias debugKey -signAlg SHA256withECDSA -mode localSign `
  -appCertFile <cer> -profileFile <p7b> -inFile <输入.hap> -keystoreFile <p12> `
  -outFile <输出-signed.hap> -keyPwd <keyPassword> -keystorePwd <storePassword>
```

## 4. 安装到真机

```powershell
hdc list targets -v          # 确认为 Connected
hdc install entry-default-signed.hap
hdc shell aa start -a EntryAbility -b com.inkcanvas.harmony
```

注意事项：

- `hdc install` 会把相对路径拼到当前目录，**必须先 `Set-Location` 到 HAP 目录**；
- 降级/换证书安装会被拒绝：先 `hdc uninstall -k com.inkcanvas.harmony`（`-k` 保留数据），再安装；
- 开发者模式下锁屏无法自动解锁，`aa start` 会报 `10106102`，需先手动解锁。

## 5. 模拟器（可选）

```powershell
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = '"D:\Huawei\DevEcoCLI\command-line-tools\emulator\Emulator.exe" -start InkTablet -instancePath "D:\Huawei\emulator\instances" -imageRoot "D:\Huawei\emulator\images"'
  CurrentDirectory = "D:\Huawei\DevEcoCLI\command-line-tools"
}
```

工具会话会回收子进程，必须用 WMI 常驻启动；`-instancePath`/`-imageRoot` 必须显式传入，否则会去 `%LOCALAPPDATA%\Huawei\Emulator\deployed` 找实例而失败。

## 6. InkCast 局域网墨迹同步

链路：**鸿蒙平板（TCP 9091 / NDJSON）→ Windows 服务 → 大屏浏览器（HTTP/SSE 9090）**。

Windows 端任选一种服务：

```powershell
# A. .NET 原生服务（推荐）
dotnet run --project tools\InkCastServer

# B. Node 演示服务
node D:\Huawei\inkcast\server.js
```

平板上：

1. 设置 → 局域网同步（InkCast）→ 打开「启用墨迹同步」；
2. 地址默认 `127.0.0.1:9091`，USB 场景用端口转发把设备回环映射到电脑：

```powershell
hdc rport tcp:9091 tcp:9091
```

3. 大屏打开 `http://<PC-IP>:9090/`，平板书写即实时出现；AI 识题/公式的结果会以批注卡片推送到大屏。

连通性自查：

```powershell
curl http://127.0.0.1:9090/health
# {"ok":true,"strokes":N,"sse":M}
```

断线恢复：客户端内置**指数退避重连（1s→2s→…→15s）与 5s 心跳**，服务重启或 Wi-Fi 抖动后自动重连，并把断线期间缓存的笔画补发（最多 500 条）。

## 7. 常见故障排查

| 现象 | 原因/处理 |
|---|---|
| `00306003` 构建失败 | 工程路径含中文；把仓库实体放到 ASCII 路径（`D:\Ink-Canvas-HEHS`），junction 无效 |
| `9568320 no signature file` | HAP 未签名；配置 `signingConfigs` 或使用 `hap-sign-tool` |
| 安装报版本冲突 | 目标版本低于已装版本或证书不同；先 `uninstall -k` 再装 |
| `10106102` 启动失败 | 设备锁屏；手动解锁后再 `aa start` |
| 同步 health 始终 0 | 检查 `hdc rport`、平板是否在同一网络、设置里是否启用同步 |
| 大屏无笔画但有 health 计数 | 浏览器未连上 SSE（刷新页面，检查 9090 端口/防火墙） |
| 图标空白/方块 | 内置 Segoe 字体缺失时的回退路径；公开分发前需替换为开源字体或 SVG |

## 8. 已知平台限制

- **跨应用悬浮窗**：`window.createWindow(TYPE_FLOAT)` 需要 `ohos.permission.SYSTEM_FLOAT_WINDOW`（`system_basic`），普通/调试签名无法申请；跨应用置顶需用户在多任务中切换为系统「悬浮窗」。
- **透明批注**：全屏窗口透明在真机上会被合成为浅灰底，不能真正透出下层；仅工具栏悬浮窗下体验最佳。
- **模拟器缺少 OCR**：端侧文字识别在模拟器不可用，AI 识题/识公式显示「设备不支持端侧识别」，需真机验证。
- **Segoe 图标字体**：仅用于内部测试，不可随公开版本分发。