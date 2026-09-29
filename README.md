# cf-vless-node

一个 agent skill + 四个能单独跑的 node 脚本，用来**部署、优选和排障**跑在 Cloudflare Workers 上的
免费 VLESS-WS 节点（客户端是 Clash Verge / mihomo）。

> A skill plus four standalone Node scripts to deploy, daily-optimize and troubleshoot a free
> VLESS-over-WebSocket node running on Cloudflare Workers, with the *correct* pass/fail criteria.

---

## 为什么需要它

免费、不限流量、出口地区随便换 —— 原理是：**Worker 在哪个 CF 机房执行，你的出口就是哪个国家**，
而执行机房由你连的入口 IP 决定。所以"换出口地区"不需要 WARP、不需要加钱，只需要换一批 IP。

听起来很简单，但真正耗人的是**判断**。这个项目里 80% 的代码是为了不再得出错误结论：

| 直觉做法 | 实测真相 |
|---|---|
| WS 握手拿到 `101 Switching Protocols` → 节点能用 | ❌ CF 边缘先答 upgrade，Worker 才校验 UUID。**错 UUID 照样 101**。唯一判据是 Worker 回的 VLESS 状态字节 `0` |
| 打开部署源码 grep UUID，那是生效值 | ❌ 源码里那行是模板占位默认值，真值在 `env.uuid` 绑定里。照着源码改配置会把能用的节点改坏 |
| 中文"测我的 IP"站显示我家宽带 IP → 代理没生效 | ❌ `GEOSITE,cn` 会把这类站点判成直连。要拿境外站经代理口测 |
| cfst(CloudflareSpeedTest) 的延迟数字拿来排序 | ❌ 测的不是同一条路径，实测和真实探测差 5 倍。cfst 只能当候选池和机房筛选 |
| 自动切换组不切 = 坏了 | ❌ `url-test` 只在别的成员快出 `tolerance` 时才切；而且在里面手点一个成员会**永久钉死**该组 |

这些坑全部来自真机实测，逐条记录在 [`references/pitfalls.md`](references/pitfalls.md)。

## 前置

- 一个 Cloudflare 免费账号 + 一个自己的域名（挂在 CF 上）。没有域名也能跑，但 `workers.dev` 域名在国内基本连不通
- 本机 [Clash Verge Rev](https://github.com/clash-verge-rev/clash-verge-rev)
- Node.js 18+（脚本只用内置模块，无依赖）
- API Token 存成一行明文 `~/.cf_token`（脚本自己读，不会打印出来）

## 30 秒上手

```bash
# 1. 拿 Worker 源码
curl -Lx http://127.0.0.1:7897 -o yg_worker.js \
  https://raw.githubusercontent.com/yonggekkk/Cloudflare-vless-trojan/main/Vless_workers_pages/_worker.js

# 2. 先看要动什么，不真动（会打印本次生成的 UUID）
node scripts/deploy.cjs --account <你的账户ID> --zone example.com --host cdn-edge-demo \
  --source ./yg_worker.js --dry-run

# 3. 确认无误去掉 --dry-run，然后照 assets/profile.template.yaml 填一份客户端配置
node scripts/deploy.cjs ... (同上，去掉 --dry-run)
node scripts/pickip.cjs --config ./cf-node.yaml --top 8
```

之后每天只需要一条命令：

```bash
node scripts/pickip.cjs --config ./cf-node.yaml              # 默认挑香港机房
node scripts/pickip.cjs --config ./cf-node.yaml --colo LAX --only '^美国'   # 只重选美国那组
node scripts/check.cjs groups --config ./cf-node.yaml        # 客户端现在到底在用什么
```

## 四个脚本

| 脚本 | 回答什么问题 |
|---|---|
| `scripts/check.cjs` | 排障四连：`ip`（这个入口能不能过 VLESS 认证）/ `egress`（真实流量从哪个机房出去）/ `bindings`（线上 UUID、源码 UUID、本地配置 UUID 三方对账）/ `groups`（客户端分组状态、有没有被手点钉死） |
| `scripts/pickip.cjs` | 两段式优选入口 IP 并写回配置：cfst 出候选池 → 真实认证探测排序（每 IP 测 4 次，**按最慢一次**排名）。认证全通的不够数就**拒绝写文件** |
| `scripts/deploy.cjs` | 部署 Worker + DNS 记录 + 路由。默认 `--dry-run` 只读预演。UUID 用 `plain_text` 绑定注入，**不改源码** |
| `scripts/lib.cjs` | 探测的唯一实现。`readConfig` 直接从你的 yaml 反解 host/uuid/path，所以不存在"脚本和配置各有一份 UUID"这种事故 |

`assets/profile.template.yaml` 是一份可直接改用的 Clash 配置骨架（`select` 组套 `hidden` `url-test` 组，
以及 `ws-opts.headers.Host` 这类容易写错的地方都注释好了）。

## 实测延迟（大陆宽带，晚高峰）

| 出口 | 入口握手最慢一次 |
|---|---|
| 香港 HKG | 388–425ms，8 个里有 2 个偶发 600/1200ms |
| 洛杉矶 LAX | 728–880ms |

数字只为说明量级，别当结论看 —— 高峰期会涨，判断好坏请看网页实际打开时间。
脚本排序用的是"最慢一次"而不是平均值：宁要一直 400ms，不要平均 380ms 但会蹦到 1900ms。

## 装成 skill（可选）

脚本本身用 `node` 直接跑就行。如果你用支持 skill 的 agent CLI，把整个目录放进去：

```bash
cp -r . ~/.qoder-cn/skills/cf-vless-node      # 之后可以直接说"优选 IP""节点通没通"
```

`SKILL.md` 里写的是给 agent 的操作顺序和红线（含"绝不杀用户正在用的 mihomo 进程"这类约束）。

## 已知边界

- 中国大陆没有 CF 机房，所以做不出"国内出口"
- 小众机房可能筛不出 8 个可用入口，用 `--top 4` 或换机房
- Netflix / Disney+ 这类会风控 CF 数据中心 IP，**选了某国不等于那国内容能看**
- 出口 IP 是 CF 的共享 anycast，可能被别人连过，介意者用付费方案

## 致谢

- Worker 实现来自 [yonggekkk/Cloudflare-vless-trojan](https://github.com/yonggekkk/Cloudflare-vless-trojan)
- 入口 IP 扫描用 [XIU2/CloudflareSpeedTest](https://github.com/XIU2/CloudflareSpeedTest)（v2.3.5；脚本按机房各扫一轮，结果缓存 24 小时，cfst 目录默认 `~/cfst`，用 `--cfst <dir>` 指定）
- 客户端 [clash-verge-rev](https://github.com/clash-verge-rev/clash-verge-rev)

## License

MIT
