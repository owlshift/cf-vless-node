#!/usr/bin/env node
// 部署 yonggekkk Cloudflare-vless-trojan 的 Worker，并挂上 域名 + 路由。
// 关键：UUID 走 plain_text 绑定 env.uuid，不改源码 —— 源码顶部那个 let userID 是模板占位值，改了也会被覆盖（见 check.cjs bindings）。
// 用法:
//   node deploy.cjs --account <id> --zone example.com --host cdn-edge-demo --source ./yg_worker.js [--uuid <uuid>] [--worker edge-proxy] [--dry-run]
const fs = require('fs'), crypto = require('crypto');
const { readToken, args } = require('./lib.cjs');
const a = args(process.argv.slice(2));
const API = 'https://api.cloudflare.com/client/v4';

const need = (k, msg) => { if (!a[k]) { console.error(`✗ 缺 --${k} ${msg}`); process.exit(1); } return a[k]; };
const ACCOUNT = need('account', '(CF 后台右侧那串 32 位十六进制)');
const ZONE = need('zone', '(你的域名，如 example.com)');
const HOST = need('host', '(子域前缀，如 cdn-edge-demo)');
const SOURCE = need('source', '(Worker 源码文件路径)');
const WORKER = a.worker || 'edge-proxy';
const DRY = !!a['dry-run'];
const UUID = a.uuid || crypto.randomUUID();
const FQDN = `${HOST}.${ZONE}`;

if (!fs.existsSync(SOURCE)) { console.error(`✗ 源码文件不存在: ${SOURCE}`); console.error(`  取上游（GitHub 直连不通时先确认本地代理再 -x http://127.0.0.1:7897）:\n  见 SKILL.md「拿 Worker 源码」`); process.exit(1); }
const code = fs.readFileSync(SOURCE, 'utf8');
if (!/env\.uuid|uuid/i.test(code)) console.warn(`⚠ 源码里没看到 uuid 变量：这个版本可能只认硬编码 userID，那 UUID 必须自己改进源码再部署`);

const H = { Authorization: `Bearer ${readToken(a.token)}` };
async function j(url, opt = {}) {
  const headers = { ...H, ...(opt.headers || {}) };
  if (opt.body instanceof FormData) delete headers['Content-Type'];
  const r = await fetch(API + url, { ...opt, headers });
  const d = await r.json();
  if (!d.success) throw new Error(`${opt.method || 'GET'} ${url}\n   → ${(d.errors || []).map(e => e.code + ':' + e.message).join('; ')}`);
  return d.result;
}

(async () => {
  const zones = await j(`/zones?name=${ZONE}`);
  if (!zones.length) throw new Error(`账户下找不到 zone "${ZONE}"（token 有没有这个区的权限？）`);
  const zone = zones[0];
  console.log(`zone      ${zone.name}  ${zone.id}`);

  const routes0 = await j(`/zones/${zone.id}/workers/routes`);
  const pat = `${FQDN}/*`;
  const hit = routes0.find(r => r.pattern === pat);
  const dns0 = await j(`/zones/${zone.id}/dns_records?name=${FQDN}`);
  const dnsHit = dns0[0];
  console.log(`worker    ${WORKER}  (${(code.length / 1024).toFixed(0)}KB, uuid=${UUID.slice(0, 8)}…)${DRY ? '  [待创建/更新]' : ''}`);
  console.log(`dns       ${dnsHit ? `已有 ${dnsHit.type} ${dnsHit.content} proxied=${dnsHit.proxied}` : '待新建 A 记录 → 192.0.2.1 proxied=true'}`);
  console.log(`route     ${hit ? `已有 ${hit.pattern} → ${hit.script}` : `待新建 ${pat} → ${WORKER}`}`);
  if (DRY) return console.log('\n--dry-run，什么都没改。去掉 --dry-run 才真部署。');

  const fd = new FormData();
  fd.append('metadata', new Blob([JSON.stringify({
    main_module: 'worker.mjs', compatibility_date: a['compat-date'] || new Date().toISOString().slice(0, 10),
    usage_model: 'bundled', bindings: [{ type: 'plain_text', name: 'uuid', text: UUID }]
  })], { type: 'application/json' }));
  fd.append('worker.mjs', new File([code], 'worker.mjs', { type: 'application/javascript+module' }));
  await j(`/accounts/${ACCOUNT}/workers/scripts/${WORKER}`, { method: 'PUT', body: fd });
  console.log(`✓ worker 已部署`);

  let rec = dnsHit;
  if (!rec) {
    rec = await j(`/zones/${zone.id}/dns_records`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: HOST, type: 'A', content: '192.0.2.1', ttl: 1, proxied: true })
    });
  }
  await j(`/zones/${zone.id}/workers/routes${hit ? '/' + hit.id : ''}`, hit ? {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pattern: pat, script: WORKER })
  } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pattern: pat, script: WORKER })
  });
  console.log(`✓ dns(${rec.name} proxied=${rec.proxied}) + route 就位: ${pat}`);

  console.log(`\n下一步：
  1. 把 servername 填 ${FQDN}、uuid 填 ${UUID}、path 填 /?ed=2560、tls 开、port 443 —— 用 assets/profile.template.yaml
  2. node pickip.cjs --config <你的yaml>     选入口 IP
  3. node check.cjs ip --config <你的yaml>   确认真的过认证`);
})().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
