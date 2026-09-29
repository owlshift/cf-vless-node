#!/usr/bin/env node
// 优选 CF 入口 IP 并写回 Clash 配置。两段式，顺序不能反：
//   1) cfst(XIU2 CloudflareSpeedTest) 扫 CF 段 → 只当「候选池 + 出口机房过滤」，它的延迟数字不能用来排序
//   2) 真实 VLESS-over-WS 认证探测做排序，每个 IP 测 N 次，按「最慢一次」排名
// 用法:
//   node pickip.cjs --config <yaml> [--colo HKG] [--top 8] [--pool 120] [--probes 4]
//                   [--cfst <dir>] [--anchors ip,ip] [--only <名字正则>] [--dry-run]
// --only：一份配置里有多个地区时（如 节点* 走 HK、US-* 走美国），只改写名字匹配的节点，其余不动
const { execFileSync } = require('child_process'), fs = require('fs'), path = require('path');
const { readConfig, probeMs, args } = require('./lib.cjs');

const a = args(process.argv.slice(2));
if (!a.config) { console.error('✗ 必须给 --config <yaml>：要更新的那份 Clash 配置文件路径'); process.exit(1); }
const cfg = readConfig(a.config);
const TOP = +(a.top || 8), POOL = +(a.pool || 120), PROBES = +(a.probes || 4);
const COLOS = String(a.colo || 'HKG').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const ONLY = a.only ? new RegExp(a.only) : null;
const CFST = a.cfst || path.join(process.env.HOME || process.env.USERPROFILE || '.', 'cfst');
// 实测稳定但不在 cfst 扫描范围内的入口，手动并进候选池
const ANCHORS = String(a.anchors || '172.66.0.100,104.21.80.100,104.16.0.100,104.19.185.48,141.101.120.100,' +
  '188.114.96.100,172.67.192.100,104.17.168.155,104.18.32.100,104.20.56.100,104.22.64.100,198.41.224.100')
  .split(',').map(s => s.trim()).filter(Boolean);

const die = m => { console.error('✗ ' + m); process.exit(1); };
// 参数写错必须当场停：忽略未知参数会让 `--dryrun` 这种拼错静默变成"用默认配置真写文件"
const KNOWN = ['config', 'colo', 'top', 'pool', 'probes', 'cfst', 'anchors', 'only', 'dry-run'];
const bad = Object.keys(a).filter(k => k !== '_' && !KNOWN.includes(k));
if (bad.length) die(`不认识 --${bad.join(' / --')}，已停手。拼错参数比不跑更危险（会退回默认值动线上配置）`);
if (a._ && a._.length) die(`多了位置参数 ${a._.join(' ')}，已停手`);

// cfst 只用来产生"这个 IP 属于哪个机房"的判断，扫一轮几分钟，24 小时内的结果按机房分开缓存
function cfstPool(colo) {
  const exe = path.join(CFST, process.platform === 'win32' ? 'cfst.exe' : 'cfst');
  if (!fs.existsSync(exe)) die(`找不到 ${exe}\n  取一次（走代理，GitHub 直连不通）：\n` +
    `  curl -Lx http://127.0.0.1:7897 -o cfst.zip https://github.com/XIU2/CloudflareSpeedTest/releases/download/v2.3.5/CloudflareW-windows-amd64-v2.3.5.zip 然后解压到 ${CFST}`);
  const csv = path.join(CFST, `result-${colo}.csv`);
  if (!fs.existsSync(csv) || Date.now() - fs.statSync(csv).mtimeMs > 864e5) {
    console.log(`cfst 扫描 ${colo}（几分钟，README 提示 HTTPing 可能被 CF/运营商限流）…`);
    execFileSync(exe, ['-httping', '-url', 'https://cp.cloudflare.com/generate_204', '-httping-code', '204',
      '-cfcolo', colo, '-tp', String(cfg.port), '-t', '2', '-n', '150', '-tlr', '0.1', '-dn', '0', '-p', '0', '-o', `result-${colo}.csv`],
      { cwd: CFST, stdio: 'ignore', timeout: 600000 });
  } else console.log(`cfst ${colo} 用 24 小时内的缓存`);
  return fs.readFileSync(csv, 'utf8').split('\n').slice(1).map(l => l.split(',')[0].trim()).filter(ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
}

// 锚点是"实测稳定但不在 cfst 扫描范围内"的 HK 入口，它们没有机房保证，所以只在默认 HKG 那一轮并进候选池；
// 要别的机房时混进来会污染排名（实测 LAX 前几名被这几个 HK IP 占了）
const pool = [...new Set([
  ...(COLOS.every(c => c === 'HKG') ? ANCHORS : []),
  ...COLOS.flatMap(cfstPool),
])].slice(0, POOL);
console.log(`域名 ${cfg.host}  UUID ${cfg.uuid.slice(0, 8)}…  机房 ${COLOS.join('/')}  候选 ${pool.length} 个`);

(async () => {
  const r = [];
  for (let i = 0; i < pool.length; i += 20) {
    const batch = await Promise.all(pool.slice(i, i + 20).map(async ip => {
      const t = await Promise.all(Array.from({ length: PROBES }, () => probeMs(ip, cfg)));
      if (!t.every(x => x)) return null;
      return { ip, worst: Math.max(...t), med: t.slice().sort((x, y) => x - y)[PROBES - 2] };
    }));
    r.push(...batch.filter(Boolean));
    process.stdout.write(`\r  已测 ${Math.min(i + 20, pool.length)}/${pool.length}，认证全通 ${r.length} 个`);
  }
  console.log();
  r.sort((x, y) => x.worst - y.worst || x.med - y.med);
  if (r.length < TOP) {
    console.error(`认证全通的只有 ${r.length} 个，不够 ${TOP} 个，配置保持不动`);
    if (!r.length) console.error('  一个都没有：先跑 `node check.cjs ip --config …` 看是网络不通还是 UUID/Worker 的问题，别急着怀疑网络');
    process.exit(1);
  }
  const best = r.slice(0, TOP);
  console.log(`取最稳的 ${TOP} 个: ${best.map(x => `${x.ip} 最慢${x.worst}ms`).join(' | ')}`);
  if (a['dry-run']) return console.log('（--dry-run，没写文件）');

  const text = fs.readFileSync(cfg.file, 'utf8');
  const EOL = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(EOL);
  let name = '', n = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*-\s*name:\s*(\S+)/);
    if (m) name = m[1];
    const s = lines[i].match(/^(\s*)server: \d+\.\d+\.\d+\.\d+\s*$/);
    // 按行扫描记录"当前属于哪个节点"，才能只改本地区的节点；整份 replace 会把别的地区一起写坏
    if (s && (!ONLY || ONLY.test(name))) lines[i] = `${s[1]}server: ${best[n++].ip}`;
  }
  if (n !== TOP) die(`配置里${ONLY ? `名字匹配 ${a.only} 的` : ''}server 行有 ${n} 个，和 --top ${TOP} 不符，结构变了没敢写`);
  fs.writeFileSync(cfg.file, lines.join(EOL));
  console.log(`已写入 ${cfg.file}（${n} 个 server 行${ONLY ? `，只动名字匹配 ${a.only} 的` : ''}）—— 记得到客户端里重新导入一次`);
})();
