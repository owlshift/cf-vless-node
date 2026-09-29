#!/usr/bin/env node
// CF Workers VLESS 节点排障。四种问法，各自回答一个具体的"到底通没通/走的哪儿"。
//   node check.cjs ip      [IP..] --config <yaml>   这个入口能不能过 VLESS 认证（不信 101）
//   node check.cjs egress  --config <yaml>          真实流量从哪个机房出去（Worker 执行点 = 出口地区）
//   node check.cjs bindings --config <yaml> --account <id> [--worker <name>]   UUID 三方对账
//   node check.cjs groups  --config <yaml>          客户端现在的分组状态、有没有被手点钉死
const { readConfig, probe, readToken, args } = require('./lib.cjs');
const a = args(process.argv.slice(2));
const cmd = (a._ || [])[0];
const CFG = a.config;
const API = 'https://api.cloudflare.com/client/v4';

const fail = m => { console.log('✗ ' + m); process.exitCode = 1; };
if (!CFG) { console.log('✗ 必须给 --config <yaml>：要排障的那份 Clash 配置文件路径'); process.exit(1); }

async function main() {
  const cfg = readConfig(CFG);
  if (cmd === 'ip') {
    const ips = (a._ || []).slice(1).length ? (a._ || []).slice(1) : cfg.servers;
    console.log(`域名 ${cfg.host}  UUID ${cfg.uuid.slice(0, 8)}…  路径 ${cfg.path}`);
    const res = await Promise.all(ips.map(async ip => ({ ip, r: await probe(ip, cfg) })));
    for (const { ip, r } of res)
      console.log(`  ${ip.padEnd(16)} ${r.ok ? '✓ 通' : '✗ 不通'}  ${String(r.ms).padStart(4)}ms  ${r.why}`);
    const bad = res.filter(x => !x.r.ok);
    if (bad.length === res.length) fail('全部不通：优先怀疑 UUID 或 Worker 本身，不是网络（101 拿得到不代表认证过）');
    else console.log(`\n${res.length - bad.length}/${res.length} 通`);
  }

  else if (cmd === 'egress') {
    const via = await trace(VIA(cfg.mixedPort));
    const direct = await trace(NO_PROXY);
    console.log(`经本地代理 :${cfg.mixedPort}  →  ${via}`);
    console.log(`直连             →  ${direct}`);
    if (!via.startsWith('错误')) {
      const colo = (via.match(/colo=(\w+)/) || [])[1], loc = (via.match(/loc=(\w+)/) || [])[1];
      console.log(`\n出口机房 ${colo} (${loc}) —— Worker 就在这一台 CF 机房里执行，fetch 出口也是它`);
      if (direct === via) fail('两者相同：这个请求根本没走代理（检查客户端开关 / 域名是否命中 GEOSITE,cn 直连规则）');
      else console.log('（两行里只有 ip= 是"流量从哪儿出去"；直连那行的 colo 是你直连时进的 CF 机房，和代理无关，别混着看）');
    }
    console.log('\n注意：myip.ipip.net 这类中文测 IP 站会被 GEOSITE,cn 判成直连，用它自查出口必然误报"没走代理"。');
  }

  else if (cmd === 'bindings') {
    if (!a.account) return fail('要 --account <Cloudflare 账户 ID>（CF 后台右侧栏那串 32 位十六进制）');
    const tok = readToken(a.token);
    const H = { Authorization: `Bearer ${tok}` };
    const name = a.worker || 'edge-proxy';
    const get = async u => (await (await fetch(API + u, { headers: H })).json());
    const st = await get(`/accounts/${a.account}/workers/scripts/${name}/settings`);
    if (!st.success) return fail(`读不到 worker "${name}": ${(st.errors || []).map(e => e.message).join('; ')}`);
    const live = (st.result.bindings || []).filter(b => /uuid/i.test(b.name))
      .map(b => `${b.name}=${b.type === 'secret_text' ? '<secret 不可读>' : b.text}`);
    console.log(`线上 worker "${name}" 的绑定 : ${live.join(', ') || '没有任何 uuid 绑定！'}`);

    const src = await (await fetch(`${API}/accounts/${a.account}/workers/scripts/${name}`, { headers: H })).text();
    const inSrc = [...new Set((src.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || []))];
    console.log(`线上源码文本里的 UUID   : ${inSrc.join(', ') || '无'}`);
    console.log(`本地配置里的 UUID       : ${cfg.uuid}`);

    const liveUuid = (live[0] || '').split('=')[1];
    if (!liveUuid) console.log('\n没有 uuid 变量 → Worker 用的是源码里硬编码那个（上面"线上源码文本里的 UUID"就是生效值）。');
    else if (liveUuid === cfg.uuid) console.log('\n✓ 生效值与本地配置一致。源码文本里另一个 UUID 是模板占位默认值，被变量覆盖，不生效。');
    else fail(`✗ 生效值是 ${liveUuid.slice(0, 8)}…，配置写的是 ${cfg.uuid.slice(0, 8)}… —— 这才是真不匹配`);
    console.log('\n要点：yonggekkk 的 Worker 是 `userID = env.uuid || 源码默认值`，只 grep 源码文本会读到永不生效的占位值。');
  }

  else if (cmd === 'groups') {
    const port = a.controller || 9097, secret = a.secret || 'set-your-secret';
    const api = async p => {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers: { Authorization: `Bearer ${secret}` } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    };
    let ver, conf;
    try {
      ver = await api('/version');
      conf = await api('/configs');
    } catch (e) { return fail(`连不上 mihomo 控制口 127.0.0.1:${port} (${e.message})——客户端没开，或端口/secret 不是默认值`); }
    console.log(`mihomo ${ver.version}  模式 ${conf.mode}`);
    const all = await api('/proxies');
    // 控制口返回的组类型是 Selector / URLTest，不是配置文件里写的 select / url-test
    const groups = Object.entries(all.proxies).filter(([, p]) => /^(selector|url-?test)$/i.test(p.type));
    if (!groups.length) fail('/proxies 里没有任何策略组——当前生效的是这份配置吗？');
    for (const [n, p] of groups) {
      const hist = p.history || [];
      console.log(`  ${n}${p.hidden ? ' (hidden)' : ''} = ${p.now}   成员 ${(p.all || []).length}` +
        (hist.length ? `   最近 ${hist[hist.length - 1].delay}ms` : ''));
    }
    const auto = groups.find(([, p]) => /url-?test/i.test(p.type));
    if (auto) {
      const [, p] = auto;
      // 用组自己测出来的 history，不要另起一次探测：url-test 的决策依据就是这份滚动数据
      const d = m => (all.proxies[m]?.history || []).slice(-1)[0]?.delay ?? null;
      const ds = (p.all || []).map(m => ({ m, d: d(m) })).filter(x => x.d != null).sort((x, y) => x.d - y.d);
      const cur = ds.find(x => x.m === p.now), best = ds[0];
      console.log(`\n${p.name} 组内测速: ${ds.map(x => `${x.m}=${x.d}ms`).join('  ')}`);
      if (!ds.length) console.log('  还没有测速记录（刚导入或间隔未到），等一个 interval 再看');
      else if (!cur) console.log(`⚠ 当前 ${p.now} 没有测速记录，可能不在成员列表里`);
      else if (best && best.d < cur.d - cfg.tolerance)
        console.log(`⚠ ${best.m}(${best.d}ms) 比当前 ${cur.m}(${cur.d}ms) 快超过 tolerance ${cfg.tolerance}ms 却一直没切 —— 这个组被手点钉死了（fixed 写进 cache.db，重启也不失效）。重新导入配置可解，之后别手点 url-test 组的成员。`);
      else console.log(`✓ 自动切换正常：当前 ${cur.m}(${cur.d}ms)，没有成员比它快出 tolerance ${cfg.tolerance}ms（差值在 tolerance 内不切换是设计行为，不是卡住）`);
    }
    const sys = await new Promise(res => require('child_process').execFile('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyEnable'],
      (e, o) => res(e ? '?' : (o.match(/ProxyEnable\s+REG_DWORD\s+0x(\d)/) || [])[1] ?? '?')));
    console.log(`\n系统代理开关 ProxyEnable = ${sys}（0 = 浏览器根本没走代理，跟节点好坏无关）`);
  }

  else console.log(`用法:
  node check.cjs ip       [IP..] --config <yaml>          认证是否真通过（不信 101）
  node check.cjs egress   --config <yaml>                 出口机房
  node check.cjs bindings --config <yaml> --account <id>  UUID 三方对账
  node check.cjs groups   --config <yaml>                 分组与自动切换
默认 --config ${CFG}`);
}

// 经/不经本地代理各拿一次 CF 自己的回显：ip=出口 ip, colo=执行机房
function trace(extra) {
  const { execFile } = require('child_process');
  return new Promise(res => execFile('curl', ['-sS', '-4', '-m', '15', ...extra,
    'https://cloudflare.com/cdn-cgi/trace'], (e, out) => {
      if (e) return res(`错误: ${e.message.split('\n')[0]}`);
      res(out.split('\n').filter(l => /^(ip|colo|loc)=/.test(l)).join('  '));
    }));
}
const NO_PROXY = ['--noproxy', '*'];            // curl 的 --noproxy 必须带值，裸写会报错
const VIA = p => ['--proxy', `http://127.0.0.1:${p}`];

main().catch(e => fail(e.message));
