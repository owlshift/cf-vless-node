---
name: cf-vless-node
description: >
  部署、优选和排障跑在 Cloudflare Workers 上的免费 VLESS-WS 节点（Clash/mihomo 客户端）。
  使用场景：从零部署 yonggekkk/Cloudflare-vless-trojan 的 edge-proxy Worker 并挂域名路由、
  给 Clash Verge 生成配置、每天优选 CF 入口 IP、换出口落地地区（香港/美国）、
  以及回答"节点到底通没通""为什么测出来还是我家宽带的 IP""是不是代理没生效"这类判断。
  触发词：CF节点、Cloudflare 节点、VLESS、workers 代理、优选 IP、出口地区、edge-proxy、cdn-cgi/trace、
  代理没生效、节点延迟。凡是要断定"节点可用/UUID 对不对/走没走代理"，都必须用本 skill 的实测判据，
  不要凭 WS 握手 101 或源码文本里的 UUID 下结论（两者都会得出错误结论，见 references/pitfalls.md）。
---

# CF Workers VLESS 节点

## 概述

自己的 Cloudflare 账号 + 一个 Worker = 免费代理，出口地区由连到哪个 CF 机房的入口 IP 决定。
本 skill 覆盖部署、优选入口 IP、以及最耗人的那部分：**判断结论的正确方法**。

核心红线（每条都有翻车史）：

1. **WS 拿到 101 ≠ 节点能用**。CF 边缘先答 upgrade，Worker 才校验 UUID；错 UUID 照样 101。
   唯一判据是 Worker 回的 VLESS 状态字节 `0`。→ `check.cjs ip`
2. **grep 部署源码里的 UUID 会读到不生效的占位值**。真值在 `env.uuid` 绑定里。
   → `check.cjs bindings`
3. **中文"测我的 IP"站会被 `GEOSITE,cn` 判成直连**，用它自查代理必然误报"没生效"。
   → `check.cjs egress`
4. **不要凭记忆操作**，先跑 check 拿实测数据；改配置前先 `--dry-run`。

## 前置

- Cloudflare API Token 存在 `~/.cf_token`（一行明文）。**任何情况下都不要把值打印到对话里**，
  脚本一律用 `lib.readToken()` 读。
- 账户 ID（32 位十六进制）在 CF 后台右侧栏，脚本里作为 `--account` 传入。
- 动手前确认 Clash Verge 的 core 活着：`check.cjs groups` 能连上控制口就行。
- **绝不杀 `verge-mihomo.exe` 里带 `-d ...\io.github.clash-verge-rev...` 的进程**（用户正在用的代理）。

## 流程 A：从零部署

```bash
# 1. 拿 Worker 源码。GitHub 直连不通，先确认本地代理开着再 -x
curl -Lx http://127.0.0.1:7897 -o yg_worker.js \
  https://raw.githubusercontent.com/yonggekkk/Cloudflare-vless-trojan/main/Vless_workers_pages/_worker.js
```
> 正确路径是 `Vless_workers_pages/_worker.js`（610KB，混淆）。同目录 `_worker明.js` 是 72KB 可读版，
> 用来看逻辑；仓库根下**没有** `workers/_worker.js`，那个路径 404。

```bash
# 2. 先看要动什么，不真动
node scripts/deploy.cjs --account <id> --zone example.com --host cdn-edge-demo \
  --source ./yg_worker.js --dry-run
# 3. 确认无误再去掉 --dry-run；它会打印本次生成的 UUID，deploy 完立刻写进配置
node scripts/deploy.cjs ... (同上，去掉 --dry-run)
```
UUID 通过 `plain_text` 绑定注入，**不改源码**（改了也会被 `env.uuid` 覆盖，且下次 grep 会骗人）。

## 流程 B：生成客户端配置

复制 `assets/profile.template.yaml`，替换 `{{HOST}}`（就是 `cf-node.example.com`）
和 `{{UUID}}`（deploy 打印的那个），存成用户的配置文件。

五个必查点：
- `port: 443` + `tls: true` —— VLESS 不加密，明文端口等于裸奔
- Host 头只能写在 `ws-opts.headers.Host`，写成 `ws-opts.host` 会被静默忽略 → 403
- 自动切换必须是 `select` 组套 `hidden` 的 `url-test` 组 —— 用户在 url-test 组里手点成员会
  **永久钉死**该组（`fixed` 写进 cache.db，重启不失效）
- 必须带 `dns:` 段（fake-ip + 国内外分流 + `prefer-h3: false`）—— 缺了它走系统 DNS，
  Google 冷门域名被污染，症状是"网页能开但 Google 商店永远等待中"（详见 pitfalls 12b）
- `GEOSITE,google,CF` 必须在 `GEOSITE,cn,DIRECT` **之前** —— `gvt2-cn.com`（Play 下载 CDN）
  同时属于 cn 分类，被直连规则先吃掉就是"更新永远等待中"（详见 pitfalls 12c）

然后 `node scripts/pickip.cjs --config <那个文件>` 填 8 个入口 IP。

## 流程 C：日常优选入口 IP

```bash
node scripts/pickip.cjs --config <yaml>            # 默认 HKG、top 8
node scripts/pickip.cjs --config <yaml> --dry-run  # 只看不动配置
node scripts/pickip.cjs --config <yaml> --colo LAX --only '^美国'  # 只重选美国那组

# 一份配置里同时有香港组和美国组时，--only 必须带（按节点名的正则）：
# 不带就去找全部 server 行，16 行 ≠ --top 8 → 脚本会拒绝写入（这是故意的，别绕过）
```

两段式，顺序不能反：
1. cfst(XIU2) 扫段 → 只当候选池 + 机房粗筛，**它的延迟数字不能排序**（测的不是同一条路径，实测差 5 倍）
2. 真实 VLESS-over-WS 认证探测排序，每 IP 4 次，**按最慢一次**排名（宁要一直 400，不要平均 380 但会蹦 1900）

内置的 12 个锚点 IP 只保证"能用且是 HK 出口"，不保证别的机房。所以非 HKG 那轮会自动排除它们
（否则实测 LAX 排名前五里会混进 4 个 HK 入口，出口就还是香港）。

安全行为：认证全通的不足 `--top` 个就拒绝写文件，不会把好配置写坏；未知/拼错的 `--参数` 会当场停手，
不会退回默认值去动线上配置。
cfst 结果按机房缓存 24 小时，日常跑约 1 分钟；缺 `cfst.exe` 时会打印下载命令。
挂定时任务时保留"写文件前先 `--dry-run`"的习惯，或让它写副本。

## 流程 D：排障（先分类，再动手）

症状永远是同一句话："节点是不是坏了"。**按顺序走，不要跳**：

```bash
node scripts/check.cjs groups      # 1. 客户端到底在用什么
node scripts/check.cjs egress      # 2. 真实流量从哪出去
node scripts/check.cjs ip          # 3. 节点本身过不过认证
node scripts/check.cjs bindings --account <id>   # 4. UUID 三方对账
```

读结果：

| 观察 | 结论 | 下一步 |
|---|---|---|
| `egress` 两行 ip 相同 | **这个请求没走代理**，与节点无关 | 看直连规则命中 / `ProxyEnable=0` / 生效的不是这份配置 |
| `egress` 经代理是 HK/SG 且 `ip` 直连不同 | 代理正常工作 | 用户的"显示国内 IP"来自中文测速站 → 判据 3，误报 |
| `ip` 全部 `状态字节 0` | 节点通 | 问题在客户端侧 |
| `ip` 有 upgrade 但拿不到状态字节 | UUID 不匹配或 Worker 挂了 | 走 `bindings` 对账 |
| `ip` 全部 TLS/upgrade 失败 | 真是网络或入口 IP 不通 | `pickip.cjs` 重选 |
| `groups` 提示快出 tolerance 却不切 | 组被手点钉死 | 重新导入配置；提醒用户只点 `CF` 组、保持「自动」 |
| `bindings` 三者不一致 | 真 UUID 故障 | 以线上绑定为准改配置 |

关键先验：**mihomo 代理失败不会回退直连**，只会连接报错。所以"能上网 + 显示国内 IP"
两件事同时成立时，原因必定是这个请求根本没走代理，不是节点坏了 —— 别去改节点。

## 换出口落地地区

入口 IP 决定 Worker 执行机房 = 出口地区，不需要 WARP、不需要加钱。
`cdn-cgi/trace` 的 `colo=` 就是机房码。哪些 IP 属于哪个机房由 cfst 的 `-cfcolo` 筛，
它**只接受单个机房**，所以多地区要传逗号列表（脚本会按机房各扫一轮再合并）。

机房码 → 城市用上游仓库的 `locations.json`（字段 `iata/city/region/cca2`）挑：

```bash
curl -sx http://127.0.0.1:7897 https://raw.githubusercontent.com/yonggekkk/Cloudflare-vless-trojan/main/locations.json \
 | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).filter(x=>x.cca2==="US").map(x=>x.iata+" "+x.city).join("\n")))'
```
权衡：HK 出口约 350ms，美国机房 600–800ms。只为绕地区限制的话 HK 通常够；
判断好坏让用户看网页打开时间，别看延迟数字（高峰期会涨）。

## 资源

- `scripts/lib.cjs` — 探测的唯一实现（`readConfig` 从 yaml 反解 host/uuid/path/port/tolerance；
  `probe` 做两帧认证探测）。改判据只改这里。
- `scripts/check.cjs` — 排障四连：`ip` / `egress` / `bindings` / `groups`
- `scripts/pickip.cjs` — 优选入口 IP 并写回配置
- `scripts/deploy.cjs` — 部署 Worker + DNS + 路由（默认先 `--dry-run`）
- `references/pitfalls.md` — 26 条实测坑与判据。**下结论前先查这里**，尤其标 ⚑ 的：
  101 不等于能用、两帧缺一不可、grep 源码 UUID 会错、中文测 IP 站必然误报、cfst 数字不能排序、
  url-test 手点会永久钉死
- `assets/profile.template.yaml` — Clash 配置骨架（`select` + `hidden` `url-test` 结构）

所有脚本都要显式给 `--config <你的 clash yaml>`；没给会直接停手，不猜路径。
