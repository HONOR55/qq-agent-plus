// 能力的**宿主侧**实现 —— 插件进程里没有 ctx、没有 onebot、没有 fs 写权限，它唯一的出口
// 就是这几个方法，所以"守卫必须复用"这件事在这里变成结构性的：想发消息必须走宿主给的那条路，
// 想联网必须走宿主实现的那条路（v1 里 send 还没开，见 docs/PLUGINS.md 的分期）。
//
// 每个能力都要在 manifest 里声明才算数（鉴权在 host.js 的 handleCapability 里做，
// 声明表在 protocol.js 的 CAP_REQUIREMENT）——没声明就调，直接拒 + 记一次越权。
import fs from 'node:fs';
import path from 'node:path';
import { CAP_METHODS } from './protocol.js';
import { sanitizeUserText } from '../core/util.js';
import { safeFetch } from '../llm/safe-fetch.js';

const MAX_KEY = 64;
const MAX_VALUE_BYTES = 32 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024;
const MAX_WRITES_PER_MIN = 120;
const MAX_LOG_CHARS = 2000;
const MAX_HTTP_CHARS = 40000;          // 与 web_fetch 的 2 万字符同档：插件也不该把整站塞进上下文
const MAX_INCIDENT_LOGS_PER_MIN = 5;   // 插件崩溃循环时不能把管理员异常面板刷满
const MAX_SEND_CHARS = 800;            // 单条发言上限（比模型的回复短：插件不该长篇大论）
const MAX_SENDS_PER_MIN = 6;           // 每个插件每分钟最多说几句 —— 防"刷屏"这种最直观的作恶

const fail = (code, message) => Object.assign(new Error(message), { code });

/** 插件自己的状态目录（**不放插件目录里**：卸载/重装插件不该顺手把数据删掉）。 */
export function pluginDataDir(dataDir, pluginId) {
  return path.join(dataDir, 'plugin-data', pluginId);
}

/**
 * @param pluginId   插件 id（存储与日志前缀用）
 * @param dataDir    应用数据目录（宿主侧唯一允许写的地方）
 * @param getSettings () => 该插件的配置段（plugins.settings.<id>）
 * @param log        宿主日志函数（约定与各 manager 一致：Error 实例才会进异常面板）
 */
export function createCapabilities({
  pluginId, dataDir, getSettings = () => ({}), log = () => {}, now = () => Date.now(),
  getSender = () => null, getQzone = () => null
} = {}) {
  // 注入点先落到本地常量：`node src/ops.js scan --strict`（CI 门禁）只认 const/let 声明与
  // KNOWN_IGNORE 里的名字，**直接调用解构参数的默认值会被判成"未定义调用"**
  //（同一约定见 src/core/ledger-retention.js 顶部那段注释）。
  const settingsOf = getSettings;
  const nowFn = now;
  const senderOf = getSender;
  const qzoneOf = getQzone;
  const dir = pluginDataDir(dataDir, pluginId);
  const storageFile = path.join(dir, 'storage.json');
  let storage = null;
  const writeTimes = [];
  const incidentLogs = [];
  const stats = { storageWrites: 0, storageBytes: 0, logLines: 0, incidentLogs: 0, httpRequests: 0, sends: 0 };
  const sendTimes = [];

  const loadStorage = () => {
    if (storage) return storage;
    try {
      const raw = JSON.parse(fs.readFileSync(storageFile, 'utf8'));
      storage = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch (error) {
      // 文件坏了/不存在都从空开始，但要留痕（否则"插件状态莫名清空"永远查不出来）
      if (error?.code !== 'ENOENT') {
        log(`[plugin:${pluginId}] 状态文件读不了，按空状态继续：${error?.message ?? error}`);
      }
      storage = {};
    }
    return storage;
  };

  const persist = () => {
    const body = JSON.stringify(storage ?? {});
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${storageFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, storageFile);
    stats.storageBytes = Buffer.byteLength(body);
  };

  const methods = {
    [CAP_METHODS.storageGet]: ({ key } = {}) => {
      const k = String(key ?? '');
      if (!k || k.length > MAX_KEY) throw fail('E_ARGS', `storage key 必须是 1-${MAX_KEY} 字`);
      const value = loadStorage()[k];
      return { value: value === undefined ? null : value };
    },
    [CAP_METHODS.storageSet]: ({ key, value } = {}) => {
      const k = String(key ?? '');
      if (!k || k.length > MAX_KEY) throw fail('E_ARGS', `storage key 必须是 1-${MAX_KEY} 字`);
      const serialized = JSON.stringify(value === undefined ? null : value);
      if (serialized === undefined) throw fail('E_ARGS', 'value 必须能被 JSON 序列化');
      if (Buffer.byteLength(serialized) > MAX_VALUE_BYTES) {
        throw fail('E_TOO_BIG', `单个值上限 ${MAX_VALUE_BYTES / 1024}KB`);
      }
      const store = loadStorage();
      const next = { ...store, [k]: value === undefined ? null : value };
      if (Buffer.byteLength(JSON.stringify(next)) > MAX_TOTAL_BYTES) {
        throw fail('E_FULL', `状态总量上限 ${MAX_TOTAL_BYTES / 1024}KB，先删掉不用的键`);
      }
      const t = nowFn();
      while (writeTimes.length && t - writeTimes[0] > 60_000) writeTimes.shift();
      if (writeTimes.length >= MAX_WRITES_PER_MIN) throw fail('E_RATE', '写得太频繁（每分钟上限 120 次）');
      writeTimes.push(t);
      storage = next;
      persist();
      stats.storageWrites += 1;
      return { ok: true };
    },
    [CAP_METHODS.configGet]: () => ({ settings: structuredClone(settingsOf() ?? {}) }),
    [CAP_METHODS.logWrite]: ({ level, message } = {}) => {
      const lv = ['info', 'warn', 'error'].includes(level) ? level : 'info';
      const text = sanitizeUserText(String(message ?? '')).slice(0, MAX_LOG_CHARS);
      if (!text) return { ok: true };
      stats.logLines += 1;
      const line = `[plugin:${pluginId}] ${text}`;
      if (lv === 'error') {
        const t = nowFn();
        while (incidentLogs.length && t - incidentLogs[0] > 60_000) incidentLogs.shift();
        if (incidentLogs.length < MAX_INCIDENT_LOGS_PER_MIN) {
          incidentLogs.push(t);
          stats.incidentLogs += 1;
          // 传 Error 实例 → 走各模块同一套 moduleLog 约定进异常面板；被限流的部分只留日志行
          log(line, Object.assign(new Error(text), { pluginId }));
          return { ok: true };
        }
      }
      log(line);
      return { ok: true };
    },
    /**
     * **代机器人发言**（v1.1）。这是信任面最大的一条能力，所以：
     *   · 强制走宿主的发送队列（`sender.sendTextBatch`）—— 非活跃时间、观察/暂停模式、群白名单、
     *     禁言预检、限频、outbox 未知写入记账，全都在那条路上，插件绕不过去；
     *   · 每个插件每分钟最多说 MAX_SENDS_PER_MIN 句（防刷屏：最直观的作恶方式）；
     *   · 单条长度上限；内容过 sanitizeUserText（与作者文本同一口径）；
     *   · 每次发言都写一条带插件 id 的日志 —— 控制台里查得到"这句话是哪个插件说的"。
     * 宿主没有发送队列时**明确报错**，不假装发成功。
     */
    [CAP_METHODS.sendText]: async ({ chatKey, text } = {}) => {
      const target = String(chatKey ?? '').trim();
      const body = sanitizeUserText(String(text ?? '').trim()).slice(0, MAX_SEND_CHARS);
      // 收紧到"数字 id"：原先的 \S+ 放行 `group:123:0` 这类形状 —— 下游 `chatKey.split(':')` 只取
      // 前两段（消息真发到群 123），但禁言预检拿的是整串（必失败 → 当成"未禁言"），每会话限频的桶键
      // 也是整串（每次换后缀就是一个新预算桶）→ 一道禁言、一道限频双双被绕。
      if (!/^(group|private):\d+$/.test(target)) throw fail('E_ARGS', 'chatKey 必须是 group:<数字群号> 或 private:<数字QQ号>');
      if (!body) throw fail('E_ARGS', 'text 不能为空');
      const sender = senderOf();
      if (!sender?.sendTextBatch) throw fail('E_NO_SENDER', '宿主没有可用的发送队列（插件暂时发不了言）');
      const cutoff = nowFn() - 60000;
      while (sendTimes.length && sendTimes[0] < cutoff) sendTimes.shift();
      if (sendTimes.length >= MAX_SENDS_PER_MIN) throw fail('E_RATE', `说话太频繁（每分钟上限 ${MAX_SENDS_PER_MIN} 句）`);
      sendTimes.push(nowFn());     // 先记时间再发：失败也占额度，免得一个总失败的插件无限重试刷屏
      await sender.sendTextBatch(target, [body], {});
      stats.sends += 1;
      log(`[plugin:${pluginId}] 以机器人身份在 ${target} 说了一句：${body.slice(0, 60)}`);
      return { ok: true, chatKey: target, chars: body.length };
    },

    [CAP_METHODS.httpRequest]: async ({ url, maxChars } = {}) => {
      const target = String(url ?? '').trim();
      if (!target) throw fail('E_ARGS', 'url 不能为空');
      const limit = Math.min(Number(maxChars) > 0 ? Math.floor(Number(maxChars)) : MAX_HTTP_CHARS, MAX_HTTP_CHARS);
      stats.httpRequests += 1;
      // 复用宿主的 safe-fetch：内网/字面量拦截、重定向逐跳复检、体积与超时上限都在里面。
      // ⚠️ 这是"方便 + 可审计"，不是安全边界：插件进程自己有网络（Node 权限模型不管网络），
      //    要真禁网得靠命名空间/容器，v1 做不到（docs/PLUGINS.md 写明了）。
      const result = await safeFetch(target);
      return {
        status: result?.statusCode ?? 0,
        truncated: Boolean(result?.truncated),
        body: String(result?.body ?? '').slice(0, limit)
      };
    }
  };

  // QQ 空间：网关按插件 id 绑一份（写入配额按插件独立计数，一个插件刷屏不该拖累别的插件）。
  // 没接网关（单元测试 / 独立启动）时这一组方法**不存在** —— 调用会走"未声明能力"那条路被拒，
  // 不会静默成功。
  if (typeof qzoneOf === 'function') {
    const bound = qzoneOf()?.bind?.(pluginId);
    if (bound?.methods) Object.assign(methods, bound.methods);
  }

  return {
    methods,
    storageFile,
    stats,
    /** 退出前/巡检时把内存里的状态落盘（v1 是每次 set 即时落盘，这里留个确定性的收口）。 */
    flush() { try { if (storage) persist(); } catch { /* 落盘失败不该阻断停机 */ } }
  };
}
