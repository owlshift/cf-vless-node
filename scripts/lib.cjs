// CF Workers VLESS 节点探测的公共实现。两个脚本都用它，因为"必须补发第二帧"这个坑值得只错一次。
const fs = require('fs'), tls = require('tls'), crypto = require('crypto');

// 全部参数从一份 Clash 配置里取，域名/UUID/路径/port 都不在脚本里重复一份
function readConfig(p) {
  if (!fs.existsSync(p)) throw new Error(`配置文件不存在: ${p}`);
  const t = fs.readFileSync(p, 'utf8');
  const one = re => (t.match(re) || [])[1];
  const c = {
    file: p,
    host: one(/^\s{4}servername:\s*(\S+)\s*$/m),
    uuid: one(/^\s{4}uuid:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/im),
    path: one(/^\s{6}path:\s*(\S+)\s*$/m),
    port: +(one(/^\s{4}port:\s*(\d+)/m) || 443),
    mixedPort: +(one(/^mixed-port:\s*(\d+)/m) || 7897),
    // url-test 只有当别的成员比当前快出 tolerance 才切换，差值在 tolerance 内不算"卡住不切"
    tolerance: +(one(/^\s{4}tolerance:\s*(\d+)/m) || 50),
    servers: [...t.matchAll(/^\s{4}server:\s*(\d+\.\d+\.\d+\.\d+)\s*$/gm)].map(m => m[1])
  };
  const missing = ['host', 'uuid', 'path'].filter(k => !c[k]);
  if (missing.length) throw new Error(`配置里读不到 ${missing.join('/')}，没法探测`);
  return c;
}

// VLESS 请求: ver(1) uuid(16) addLen(1) cmd(1=TCP) port(2) atyp(2=域名) len(1) addr
// 目标固定 www.gstatic.com:80 —— Worker 会真的去连它，所以第二帧能拿到东西转发；换成不可达目标 Worker 就不回话
const TARGET_HOST = 'www.gstatic.com';
function vlessPacket(uuid) {
  const dom = Buffer.from(TARGET_HOST);
  return Buffer.concat([Buffer.from([1]), Buffer.from(uuid.replace(/-/g, ''), 'hex'),
    Buffer.from([0, 1, 0, 80]), Buffer.from([2, dom.length]), dom]);
}
function wsFrame(payload) {
  const key = crypto.randomBytes(4), masked = Buffer.from(payload.map((b, i) => b ^ key[i % 4]));
  const head = payload.length < 126 ? Buffer.from([0x82, 0x80 | payload.length])
    : Buffer.from([0x82, 0x80 | 126, (payload.length >> 8) & 255, payload.length & 255]);
  return Buffer.concat([head, key, masked]);
}
const INNER_REQ = Buffer.from(`GET /generate_204 HTTP/1.1\r\nHost: ${TARGET_HOST}\r\nConnection: close\r\n\r\n`);

// 单个入口 IP 的完整判定。返回 {ok, ms, why}
//   ms  = 入口 TLS+WS 握手耗时（排序用这个；含认证那一趟的话会掺进 gstatic 的往返，数字不可比也会抖）
//   why = 失败原因，给人看的
function probe(ip, cfg, opt = {}) {
  const timeout = opt.timeout || 9000;
  return new Promise(done => {
    const t0 = Date.now();
    let head = '', upgraded = false, handMs = null, buf = Buffer.alloc(0);
    const s = tls.connect({
      host: ip, port: cfg.port, servername: cfg.host, ALPNProtocols: ['http/1.1'],
      rejectUnauthorized: true, timeout
    }, () => s.write([`GET ${cfg.path} HTTP/1.1`, `Host: ${cfg.host}`, 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}`, 'Sec-WebSocket-Version: 13', '', ''].join('\r\n')));

    const fin = r => { clearTimeout(kill); s.destroy(); done({ ok: r.ok === true, ms: r.ms ?? handMs ?? (Date.now() - t0), why: r.why }); };
    const kill = setTimeout(() => fin({ why: `超时 ${timeout}ms：${upgraded ? '已 upgrade 但 Worker 没回认证结果' : 'TLS 或 upgrade 没完成'}` }), timeout + 500);

    s.on('data', d => {
      if (!upgraded) {
        head += d.toString('latin1');
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) return;
        const code = head.slice(0, end).split(' ')[1];
        if (code !== '101') return fin({ why: `upgrade 被拒: HTTP ${code}${code === '403' ? '（域名没指向本 Worker，或 Host 头不对）' : ''}` });
        upgraded = true;
        handMs = Date.now() - t0;
        s.write(wsFrame(vlessPacket(cfg.uuid)));
        // 第二帧不能省：Worker 手上没有可转发的目标数据时就不回认证结果，只发 VLESS 包会一直等到超时
        s.write(wsFrame(INNER_REQ));
        d = Buffer.from(head.slice(end + 4), 'latin1');
      }
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 2) {
        let len = buf[1] & 127, off = 2;
        if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
        if (buf.length < off + len) break;
        if ((buf[0] & 15) === 2 && len >= 2) {
          const st = buf[off + 1];
          return st === 0 ? fin({ ok: true, why: '状态字节 0：认证放行且取回了内容' })
            : fin({ why: `状态字节 ${st}：Worker 拒绝了这个 UUID` });
        }
        buf = buf.subarray(off + len);
      }
    });
    s.on('error', e => fin({ why: `TLS/连接错误: ${e.code || e.message}` }));
    s.on('close', () => fin({ why: upgraded ? '连接被关闭，没拿到认证响应（UUID 不对时 Worker 常直接断链）' : 'TLS 握手后被关闭' }));
  });
}

// 只回耗时，跑分专用：不通就是 null
const probeMs = (ip, cfg, opt) => probe(ip, cfg, opt).then(r => (r.ok ? r.ms : null));

function readToken(p = require('path').join(require('os').homedir(), '.cf_token')) {
  if (!fs.existsSync(p)) throw new Error(`找不到 token 文件 ${p}（Cloudflare API Token，一行明文）`);
  return fs.readFileSync(p, 'utf8').trim();
}

// 命令行参数: --key value 与 --flag
function args(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { (a._ ||= []).push(argv[i]); continue; }
    const k = argv[i].slice(2), n = argv[i + 1];
    if (n === undefined || n.startsWith('--')) a[k] = true; else { a[k] = n; i++; }
  }
  return a;
}

module.exports = { readConfig, probe, probeMs, readToken, args, wsFrame, vlessPacket, TARGET_HOST };
