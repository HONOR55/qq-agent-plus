// 插件 ↔ 宿主的线路协议：**一行一个 JSON**（NDJSON），零依赖。
//
// 这份协议是插件生态的长期契约：插件只依赖这里的方法名与消息形状，宿主内部怎么重构都不影响它，
// 所以 apiVersion 只增不改（破坏性变更要升版本号并在加载时拒掉旧插件）。
//
// 消息形状（JSON-RPC 的最小子集，够用且好读）：
//   请求   { "id": 1, "method": "callTool", "params": { "name": "x", "args": {} } }
//   成功   { "id": 1, "result": {...} }
//   失败   { "id": 1, "error": { "code": "E_TIMEOUT", "message": "…" } }
//   通知   { "method": "observe", "params": {...} }            // 没有 id = 不需要回执
//
// 宿主 → 插件：init / callTool / observe / schedule / ping / shutdown
// 插件 → 宿主：cap.log.write / cap.storage.get / cap.storage.set / cap.config.get / cap.http.request
//   （`cap.` 前缀的就是"能力调用"，宿主按 manifest 声明逐条鉴权）
export const PLUGIN_API_VERSION = 1;

export const HOST_METHODS = Object.freeze({
  init: 'init',
  callTool: 'callTool',
  observe: 'observe',
  schedule: 'schedule',
  ping: 'ping',
  shutdown: 'shutdown'
});

export const CAP_PREFIX = 'cap.';
export const CAP_METHODS = Object.freeze({
  logWrite: `${CAP_PREFIX}log.write`,
  storageGet: `${CAP_PREFIX}storage.get`,
  storageSet: `${CAP_PREFIX}storage.set`,
  configGet: `${CAP_PREFIX}config.get`,
  httpRequest: `${CAP_PREFIX}http.request`,
  sendText: `${CAP_PREFIX}send.text`,
  // QQ 空间：读是只读，写（publish/delete/like/comment）是**公开可见**的副作用，
  // 所以方法名按动作拆开，鉴权与限频都能逐个管，不给一个"随便调空间接口"的总入口。
  qzonePublish: `${CAP_PREFIX}qzone.publish`,
  qzoneMine: `${CAP_PREFIX}qzone.mine`,
  qzoneDelete: `${CAP_PREFIX}qzone.delete`,
  qzoneFeeds: `${CAP_PREFIX}qzone.feeds`,
  qzoneLike: `${CAP_PREFIX}qzone.like`,
  qzoneComment: `${CAP_PREFIX}qzone.comment`,
  qzoneComments: `${CAP_PREFIX}qzone.comments`
});

/** 能力方法 → 需要声明的能力名（鉴权用；漏一条就是"没声明也能用"）。 */
export const CAP_REQUIREMENT = Object.freeze({
  [CAP_METHODS.logWrite]: 'log',
  [CAP_METHODS.storageGet]: 'storage',
  [CAP_METHODS.storageSet]: 'storage',
  [CAP_METHODS.configGet]: 'config',
  [CAP_METHODS.httpRequest]: 'http',
  [CAP_METHODS.sendText]: 'send',
  [CAP_METHODS.qzonePublish]: 'qzone',
  [CAP_METHODS.qzoneMine]: 'qzone',
  [CAP_METHODS.qzoneDelete]: 'qzone',
  [CAP_METHODS.qzoneFeeds]: 'qzone',
  [CAP_METHODS.qzoneLike]: 'qzone',
  [CAP_METHODS.qzoneComment]: 'qzone',
  [CAP_METHODS.qzoneComments]: 'qzone'
});

export const MAX_LINE_BYTES = 1024 * 1024;   // 单行上限：插件不能靠"吐一大坨"把宿主内存打满

export function encodeMessage(message) {
  return `${JSON.stringify(message)}\n`;
}

export function rpcResult(id, result) {
  return { id, result: result === undefined ? null : result };
}

export function rpcError(id, code, message) {
  return { id, error: { code: String(code || 'E_PLUGIN'), message: String(message ?? '') } };
}

export function isResponse(message) {
  return Boolean(message) && typeof message === 'object' && 'id' in message
    && ('result' in message || 'error' in message);
}

export function isRequest(message) {
  return Boolean(message) && typeof message === 'object'
    && typeof message.method === 'string' && message.id !== undefined && message.id !== null;
}

export function isNotification(message) {
  return Boolean(message) && typeof message === 'object'
    && typeof message.method === 'string' && (message.id === undefined || message.id === null);
}

/** 出错时把消息截一段出来当线索（整条可能会很长）。 */
export function previewLine(text, max = 200) {
  const one = String(text || '').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/**
 * 按行切分的解码器（**按字节找 \n，不按字符串**：一块 chunk 可能正好切在多字节字符中间，
 * 先 toString 会得到替换字符，中文参数会被悄悄改坏）。
 * - 超过 maxLineBytes 还没换行 → onViolation('line-too-long')，缓冲区丢掉（这已经不是协议数据了）
 * - JSON 解析失败 → onParseError(line)，单行丢弃、不影响后续
 */
export function createLineDecoder({
  maxLineBytes = MAX_LINE_BYTES, onMessage, onViolation, onParseError
} = {}) {
  let pending = null;
  return {
    push(chunk) {
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      pending = pending?.length ? Buffer.concat([pending, incoming]) : incoming;
      let index = pending.indexOf(0x0a);
      while (index !== -1) {
        let line = pending.subarray(0, index);
        pending = pending.subarray(index + 1);
        if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
        const text = line.toString('utf8').trim();
        if (text) {
          let parsed = null;
          try { parsed = JSON.parse(text); } catch { onParseError?.(text); parsed = null; }
          if (parsed && typeof parsed === 'object') onMessage?.(parsed);
        }
        index = pending.indexOf(0x0a);
      }
      if (pending.length > maxLineBytes) {
        pending = null;
        onViolation?.('line-too-long');
      }
    }
  };
}
