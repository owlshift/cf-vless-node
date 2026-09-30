# CF Workers VLESS：踩过的坑与判据

每条都是实测结论，不是推测。标 ⚑ 的会直接导致"看起来成功其实没用"。

## 认证与可用性

**1. ⚑ WS 拿到 101 不代表节点能用。**
CF 边缘先应答 upgrade，Worker 才在第一个 VLESS 包上校验 UUID。所以错的 UUID 照样返回 101。
唯一可信判据是 Worker 回的**状态字节**：`0` = 放行，非 0 = 拒绝，直接断链 = 也不通。
`check.cjs ip` 测的就是这个。

**2. ⚑ 只发 VLESS 认证包，Worker 会一直不作声。**
Worker 手上没有可转发的目标数据时不回认证结果。必须连发两帧：VLESS 包 + 一个内层 HTTP 请求
（`GET /generate_204` 到 www.gstatic.com）。四种组合实测过：只有两帧都发才拿得到状态字节，
否则一律超时——看起来像"节点全死"。

**3. VLESS 包的端口字段是 2 字节，不能省。**
`ver(1) uuid(16) addLen(1) cmd(1) port(2) atyp(1) len(1) addr`。缺 port 的包格式不合法，
Worker 解析失败后行为不确定，此时"没回包"不能当成认证失败的证据。

## UUID 到底生效哪一个

**4. ⚑ 部署源码文本里 grep 到的 UUID，多半是不生效的那个。**
yonggekkk 的 Worker 是 `userID = env.uuid || 源码默认值`。源码顶部
`let userID = "86c50e3a-…"` 那行带注释"可以改为你自定义的uuid"，是**模板占位默认值**。
真值走 `plain_text` 绑定 `uuid`。只读源码文本会得出"配置里的 UUID 不存在"的错误结论。

**5. 生效值只在这里能查到：**
`GET /accounts/{account}/workers/scripts/{worker}/settings` → `bindings[]`。
`check.cjs bindings` 做的就是这个 + 三方对账（线上绑定 / 源码文本 / 本地配置）。

## 出口地区

**6. 入口 IP 决定出口地区，这条是对的。**
Worker 在你连上的那台 CF 机房里执行，`fetch` 出口就是该机房的 IP。所以选入口 IP = 选落地地区，
不需要 WARP、不需要加钱。
验证：`curl -x http://127.0.0.1:7897 https://cloudflare.com/cdn-cgi/trace` → 看 `colo=`。

**7. 端口无关紧要，入口 IP 才要紧。**
2082/80 是明文，443/2053/2083/2087/2096/8443 是 TLS。同一 IP 换端口延迟基本不变。
但 VLESS 本身不加密 —— 走明文端口等于把内容裸奔给 CF 和中间路径。**只用 TLS 端口。**

**8. cfst 的 `-cfcolo` 只接受单个机房。**
要美国出口就得按 LAX / SJC / SEA / IAD / DFW / EWR 各扫一轮再合并候选池
（`pickip.cjs --colo LAX,SJC,SEA` 已经这么做了）。顺带：HK 出口延迟 ~350ms，美国机房 600-800ms，
只是为绕开地区限制的话 HK 通常就够。

## 测速与排序

**9. ⚑ CloudflareSpeedTest 的延迟数字不能用来排序。**
它测的是到 CF 通用边缘的明文 GET，和到你这个 zone 的 WS 路径不是一条，实测差 5 倍。
cfst 在这套流程里只承担两件事：快速产生候选 IP、按机房粗筛。排序必须用真实 WS 握手。

**10. 按「最慢一次」排，不按平均。**
宁要一直 400 的，不要平均 380 但会蹦到 1900 的。上一版按 cfst 数字排序就是这么翻的车。

**11. 排序口径要单一。**
认证探测那一趟含目标站点的往返，掺进排名会让结果抖动且和历史数字不可比。
`pickip.cjs` 只用 TLS+upgrade 的握手耗时排名，认证只作为通过/不通过的开关。

## 客户端行为

**12. ⚑ url-test 组里手点成员 = 永久钉死。**
选任意成员会把 `fixed` 写进 `cache.db`，**重启客户端不失效**，此后该组不再自动切换。
给不折腾命令行的人，配置必须做成：`select` 组（用户只碰这个，保持选「自动」）
套一个 `hidden: true` 的 `url-test` 组。界面里看不到隐藏组，就点不到。

**12b. ⚑ 配置缺 `dns:` 段 = 手机能开 YouTube 但 Google 商店永远「等待中」。**
不写 `dns`，mihomo 走系统 DNS，大陆网络下 Google 冷门域名（`clients3.google.com`、
Play 下载依赖的一堆域）被污染解析到错误 IP。症状极具迷惑性：大站（YouTube）能开让人以为节点坏了，
其实节点 16/16 全通、电脑同节点实测 `dl.google.com` 也 200。
判据：`curl -x 本地代理 https://clients3.google.com/generate_204` 电脑通、手机不通 → 客户端 DNS，非节点。
修：配置补 `enhanced-mode: fake-ip` + `nameserver-policy` 国内外分流（见 profile.template.yaml），
`prefer-h3: false` 禁 QUIC。手机 cmfa 若装了旧版无 dns 段的配置，重导新配置 + 清 Play 商店数据。

**12c. ⚑ `gvt2-cn.com` 同时挂在 geosite 的 cn 分类里，直连规则会吃掉 Play 下载。**
Play 的更新 CDN 域名有区域变体（gvt1-cn / gvt2-cn），实测 `gvt2-cn.com` 在 `[CN]` 分类（解析 geosite.dat 确认）。
所以 `GEOSITE,cn,DIRECT` 排前面时，商店页面（google.com 系）全走代理看着正常，
一点"更新"命中 gvt2-cn 就直连 → 永远"等待中"。新装应用命中别的 CDN 节点还能成功，极具迷惑性。
修：`GEOSITE,google,CF` 放在 `GEOSITE,cn,DIRECT` 之前（模板已带）。同类误伤：中文测 IP 站（见判据 3）。

**12d. ⚑ cmfa 关 IPv6 ≠ 只走 IPv4，是把 `::/0` 黑洞了，FCM 跟着死。**
关闭时不是"IPv6 回落 IPv4"，是整个 v6 被丢弃。
Google 基础设施 IPv6 优先，FCM（bb*.google.com）连不上 → Play 下载没有"开始"信号 → 等待中。
"开了 IPv6 不稳定"是误解：接管 v6 不等于节点要支持 v6，app 连的是 fake-ip6，出口仍是节点的 IPv4 隧道。
判据：`adb shell dumpsys connectivity | grep '::/0'`，出现 unreachable 即中招。修：开 cmfa IPv6 开关 + `dns.ipv6: true`。

**13. `tolerance` 内的不切换是设计行为，不是卡住。**
mihomo 只在别的成员快出 tolerance 时才切。判断"是不是被钉死"要用组自己的 history + tolerance，
单次测速的差值不算证据（`check.cjs groups` 按这个规则实现）。

**14. mihomo 不认 `ws-opts.host`。**
Host 头只能写在 `ws-opts.headers.Host`，写成 `host:` 字段会被静默忽略，症状是 Worker 返回 403。

**14b. ⚑ 单节点也不能删 proxy-groups —— cmfa 的"节点信息"UI 只渲染组。**
内核允许规则直写节点名且 `-t` 校验通过，但 cmfa 代理页/配置卡没有组就显示"没有节点信息"。
订阅配置里哪怕只有一个节点，也要包一层 `select` 组。

**15. 不要杀 Clash Verge 的正式 core。**
`verge-mihomo.exe` 里带 `-d ...\io.github.clash-verge-rev...` 的是用户正在用的那个。
自己起的测试实例要用不同的 config 目录，杀的时候按命令行里有没有那个测试目录过滤。
按进程名一刀切会连带把用户的代理打死。

## 怎么判断"到底走没走代理"

**16. ⚑ 中文测 IP 站会被 `GEOSITE,cn,DIRECT` 判成直连。**
`myip.ipip.net`、`ip.cn` 这类站点命中直连规则，返回的是你家真实出口 —— 用它自查代理，
必然误报"代理没生效"。要用 `cloudflare.com/cdn-cgi/trace` 或 `api.ipify.org`。

**17. 直连有 IPv6 的话，测出口必须锁 IPv4。**
`curl` 不加 `-4` 可能走 v6 直连，回显一个国内地址，看起来像代理失效。
`-4` 才是对的；注意 `--ipversion=4` 不是有效 curl 参数，会被静默忽略。

**18. 代理失败不会回退直连。**
mihomo 走代理失败就是连接报错，不会悄悄改走直连。
所以"能打开网页 + 显示国内 IP"这两件事同时成立，原因必定是**这个请求根本没走代理**
（直连规则命中 / 系统代理开关 ProxyEnable=0 / 当前生效的不是这份配置），而不是节点坏了。

## Windows 与命令行

**19. `powershell -Command "..."` 里的 `$_` 会被 bash 吞掉。**
写成 `.ps1` 文件再 `powershell -File x.ps1`。

**20. 中文进 `curl -d` 会被编码搞坏**（表现为 400，报 "proxy not exist" 之类的误导性错误）。
用 node 脚本 + `encodeURIComponent` 发请求。

**21. `curl -s` 把错误也一起吞了。** 用 `-sS`：静默进度但保留报错。

**22. GitHub 直连不通时先确认本地代理再动手**，下载上游 Worker / cfst 都要 `-x http://127.0.0.1:7897`。

**23. Git Bash 的 `/tmp` 和 node 的 `/tmp` 不是一个地方。**
node 会把 `/tmp/x.yaml` 解析成 `C:\tmp\x.yaml`。跨 bash/node 传路径要用 `~/` 或绝对 Windows 路径。
