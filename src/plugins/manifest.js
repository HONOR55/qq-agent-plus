// 插件 manifest（plugin.json）的解析与校验 —— **fail-closed**：任一项不合法就拒载并给出
// 可读原因，不做"尽力而为"的宽容解析。插件是第三方代码，宽容解析等于把边界交给对方。
//
// 契约（apiVersion 1，见 docs/PLUGINS.md）：
//   {
//     "id": "weather",                       // 小写字母数字与连字符，2-32 位
//     "apiVersion": 1,
//     "name": "Minecraft 服务器状态",          // 给人看的名字
//     "version": "1.0.0",
//     "description": "一句话说明（可选）",
//     "entry": "index.mjs",                  // 可选，默认 index.mjs；必须落在插件目录内
//     "capabilities": ["tools", "http"],     // 声明式：宿主只按这份清单注入能力
//     "tools": [ { "name": "mc_status", "description": "…", "parameters": {…} } ],
//     "schedule": [ { "name": "poll", "everyMs": 300000 } ]
//   }
//
// ⚠️ 这里的每一条限制都对应一个真实的失败模式：id 会进工具名前缀（撞名/注入）、entry 会进
// 文件系统路径（目录穿越）、tool 描述会进提示词（提示注入面）、everyMs 会变成定时器（0 或
// 负数 = 空转烧 CPU）。校验失败一律返回 `{ ok:false, error }`，由调用方决定怎么报。
import path from 'node:path';

export const PLUGIN_API_VERSION = 1;

/** v1 能力白名单。加能力 = 加一条宿主侧实现 + 这里补一个名字（`send` 刻意不在 v1 里）。 */
export const PLUGIN_CAPABILITIES = Object.freeze([
  'tools',      // 把 manifest 里声明的工具暴露给模型（只读）
  'observe',    // 收到入站消息（只读，不能改内容、不能拦消息）
  'schedule',   // 按 manifest 声明的周期跑任务
  'http',       // 经宿主发 HTTP（走 safe-fetch 的守卫，便于审计；**不是**安全边界，见 docs/PLUGINS.md）
  'log',        // 经宿主写日志（带插件前缀 + 脱敏）
  'storage',    // 经宿主读写自己那点状态（宿主侧落盘，插件进程没有写权限）
  'config',     // 读自己那段配置（plugins.settings.<id>）
  'send',       // **代机器人发言**（走宿主的发送队列：非活跃时间、观察/暂停模式、群白名单、
                //  禁言预检、限频、outbox 记账全都在里面）。信任面最大的一条，界面上会明确标出来
  'qzone'       // **QQ 空间读写**（发/删说说、看好友动态、点赞、评论）。写出去的每一条都是
                //  公开可见的，宿主侧另有按插件计的每分钟/每小时上限与逐条审计日志
]);

const ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{1,31}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const MAX_TOOLS = 12;
const MAX_DESCRIPTION = 300;
const MAX_TOOL_DESCRIPTION = 900;
const MIN_EVERY_MS = 60 * 1000;                 // 低于一分钟的周期任务没有意义，只会烧 CPU
const MAX_EVERY_MS = 7 * 24 * 3600 * 1000;

// 单个工具的入参 schema 上限：属性数与序列化字节数（见 validateTool 注释）
const MAX_TOOL_PROPERTIES = 64;
const MAX_TOOL_SCHEMA_BYTES = 16 * 1024;

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const str = (value) => (typeof value === 'string' ? value.trim() : '');

/** 校验声明式工具的入参 schema：只认 OpenAI 那套 JSON Schema 形状的最小子集。 */
function validateTool(raw, index) {
  const where = `tools[${index}]`;
  if (!isPlainObject(raw)) return { error: `${where} 必须是对象` };
  const name = str(raw.name);
  if (!TOOL_NAME_RE.test(name)) {
    return { error: `${where}.name 只能是小写字母开头的字母/数字/下划线（2-32 位），实际 ${JSON.stringify(raw.name)}` };
  }
  const description = str(raw.description);
  if (!description) return { error: `${where}.description 不能为空（模型靠它决定要不要调用）` };
  if (description.length > MAX_TOOL_DESCRIPTION) return { error: `${where}.description 太长（上限 ${MAX_TOOL_DESCRIPTION} 字）` };
  const parameters = raw.parameters ?? { type: 'object', properties: {} };
  if (!isPlainObject(parameters) || parameters.type !== 'object') {
    return { error: `${where}.parameters 必须是 {"type":"object",…} 形状` };
  }
  if (parameters.properties !== undefined && !isPlainObject(parameters.properties)) {
    return { error: `${where}.parameters.properties 必须是对象` };
  }
  if (parameters.required !== undefined
    && (!Array.isArray(parameters.required) || parameters.required.some((k) => typeof k !== 'string'))) {
    return { error: `${where}.parameters.required 必须是字符串数组` };
  }
  // schema 会原样进每一轮模型请求（direct 模式）或拼进 plugin_call 的描述（meta 模式）。
  // 不设上限时，一个 5MB 内的包可以塞两万个属性，让之后**每一次**请求都超长被拒 ——
  // 整个机器人静默停摆到有人禁用插件为止（2026-10-17 审查 P2）。
  const propertyCount = Object.keys(parameters.properties || {}).length;
  if (propertyCount > MAX_TOOL_PROPERTIES) {
    return { error: `${where}.parameters.properties 太多（${propertyCount} 个，上限 ${MAX_TOOL_PROPERTIES}）` };
  }
  const requiredCount = Array.isArray(parameters.required) ? parameters.required.length : 0;
  if (requiredCount > MAX_TOOL_PROPERTIES) {
    return { error: `${where}.parameters.required 太多（${requiredCount} 个，上限 ${MAX_TOOL_PROPERTIES}）` };
  }
  let serialized = '';
  try { serialized = JSON.stringify(parameters); } catch { return { error: `${where}.parameters 不能序列化` }; }
  if (serialized.length > MAX_TOOL_SCHEMA_BYTES) {
    return { error: `${where}.parameters 太大（${serialized.length} 字节，上限 ${MAX_TOOL_SCHEMA_BYTES}）` };
  }
  return { tool: { name, description, parameters } };
}

/** 校验周期任务：宿主侧起定时器，所以周期必须有硬下限，免得插件把机器人空转死。 */
function validateSchedule(raw, index) {
  const where = `schedule[${index}]`;
  if (!isPlainObject(raw)) return { error: `${where} 必须是对象` };
  const name = str(raw.name);
  if (!TOOL_NAME_RE.test(name)) return { error: `${where}.name 只能是小写字母开头的字母/数字/下划线（2-32 位）` };
  const everyMs = Number(raw.everyMs);
  if (!Number.isFinite(everyMs) || everyMs < MIN_EVERY_MS || everyMs > MAX_EVERY_MS) {
    return { error: `${where}.everyMs 必须是 ${MIN_EVERY_MS / 60000} 分钟到 7 天之间的毫秒数，实际 ${JSON.stringify(raw.everyMs)}` };
  }
  return { schedule: { name, everyMs } };
}

/**
 * 解析并校验一份 manifest。
 * @param raw   plugin.json 的解析结果（对象）
 * @param dir   插件目录的绝对路径（用于校验 entry 不越界）
 * @returns {{ok:true, manifest}|{ok:false, error:string}}
 */
export function parsePluginManifest(raw, { dir = '' } = {}) {
  if (!isPlainObject(raw)) return { ok: false, error: 'manifest 必须是 JSON 对象' };

  const id = str(raw.id);
  if (!ID_RE.test(id)) {
    return { ok: false, error: `id 只能是小写字母/数字/连字符（2-32 位，首字符为字母或数字），实际 ${JSON.stringify(raw.id)}` };
  }
  if (Number(raw.apiVersion) !== PLUGIN_API_VERSION) {
    return {
      ok: false,
      error: `apiVersion 不匹配：本机支持 ${PLUGIN_API_VERSION}，插件声明 ${JSON.stringify(raw.apiVersion)}`
    };
  }
  const name = str(raw.name);
  if (!name) return { ok: false, error: 'name 不能为空（控制台与日志里要能认出是哪个插件）' };
  if (name.length > MAX_DESCRIPTION) return { ok: false, error: `name 太长（上限 ${MAX_DESCRIPTION} 字）` };
  const version = str(raw.version);
  if (!SEMVER_RE.test(version)) return { ok: false, error: `version 必须是形如 1.0.0 的版本号，实际 ${JSON.stringify(raw.version)}` };
  const description = str(raw.description);
  if (description.length > MAX_DESCRIPTION) return { ok: false, error: `description 太长（上限 ${MAX_DESCRIPTION} 字）` };

  const capabilities = raw.capabilities;
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    return { ok: false, error: 'capabilities 必须是非空数组（哪怕只声明 ["tools"]）' };
  }
  const unknown = capabilities.filter((cap) => !PLUGIN_CAPABILITIES.includes(cap));
  if (unknown.length) {
    return { ok: false, error: `不认识的能力：${unknown.join(' / ')}（可选：${PLUGIN_CAPABILITIES.join(' / ')}）` };
  }
  if (new Set(capabilities).size !== capabilities.length) return { ok: false, error: 'capabilities 里有重复项' };

  // entry 必须落在插件目录内：这是唯一一处把 manifest 里的字符串拿去拼路径的地方，
  // 也是目录穿越的唯一入口（`"entry": "../../../etc/passwd"`）。
  const entry = str(raw.entry) || 'index.mjs';
  if (entry.includes('\0')) return { ok: false, error: 'entry 含非法字符' };
  const entryAbs = path.resolve(dir, entry);
  if (dir && entryAbs !== dir && !entryAbs.startsWith(dir + path.sep)) {
    // 不回显 entryAbs：这条错误会一路显示到控制台，绝对路径属于不该漏的服务器细节
    return { ok: false, error: `entry 必须落在插件目录内（收到的是 ${JSON.stringify(raw.entry)}）` };
  }

  const rawTools = raw.tools ?? [];
  if (!Array.isArray(rawTools)) return { ok: false, error: 'tools 必须是数组' };
  if (rawTools.length > MAX_TOOLS) return { ok: false, error: `工具数超过上限 ${MAX_TOOLS} 个（每个工具都会占提示词预算）` };
  if (rawTools.length && !capabilities.includes('tools')) {
    return { ok: false, error: '声明了 tools 就必须在 capabilities 里带上 "tools"' };
  }
  const tools = [];
  for (const [index, item] of rawTools.entries()) {
    const result = validateTool(item, index);
    if (result.error) return { ok: false, error: result.error };
    if (tools.some((t) => t.name === result.tool.name)) return { ok: false, error: `工具名重复：${result.tool.name}` };
    tools.push(result.tool);
  }

  const rawSchedule = raw.schedule ?? [];
  if (!Array.isArray(rawSchedule)) return { ok: false, error: 'schedule 必须是数组' };
  if (rawSchedule.length && !capabilities.includes('schedule')) {
    return { ok: false, error: '声明了 schedule 就必须在 capabilities 里带上 "schedule"' };
  }
  const schedule = [];
  for (const [index, item] of rawSchedule.entries()) {
    const result = validateSchedule(item, index);
    if (result.error) return { ok: false, error: result.error };
    if (schedule.some((s) => s.name === result.schedule.name)) return { ok: false, error: `周期任务名重复：${result.schedule.name}` };
    schedule.push(result.schedule);
  }

  return {
    ok: true,
    manifest: {
      id, apiVersion: PLUGIN_API_VERSION, name, version, description,
      dir: dir || '',                 // 插件目录（宿主起进程时的 cwd 与 --allow-fs-read 目标）
      entry: entryAbs || entry,
      capabilities: [...capabilities],
      tools,
      schedule
    }
  };
}

/**
 * 模型看到的工具名：`<插件id>__<工具名>` —— 插件之间、插件与内置工具之间都不许撞名。
 * 用双下划线而不是点号：OpenAI 的 function name 只允许 [a-zA-Z0-9_-]，点号在**严格校验**的
 * 兼容端点上会让整个请求 400 —— 那就不只是"这个工具用不了"，而是这一轮对话全挂
 *（2026-10-15 复审 P3-4）。id 里只可能有 `-`，工具名里只可能有 `_`，所以分隔符不会歧义。
 */
export function qualifiedToolName(pluginId, toolName) {
  return `${pluginId}__${toolName}`;
}
