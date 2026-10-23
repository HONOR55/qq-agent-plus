// 「QQ 空间」能力（`cap.qzone.*`）—— 插件唯一一条能读写空间的出口。
//
// 为什么必须在宿主：插件进程在 Linux 上被放进没有网络接口的命名空间，也读不到 config.json
// 里的协议端令牌；而发说说只能走宿主的 OneBot 连接（SnowLuma 的 `send_qzone_msg`）。
// 所以这条能力不是"给插件开个后门"，而是把宿主**已经在用**的那条路按动作粒度收窄后开放：
//
//   · 只认白名单里的方法，参数逐个校验（tid / uin 形状、正文长度、图片条数、可见范围）；
//   · 写入（发 / 删 / 赞 / 评论）每个插件每分钟有独立上限，阅读不吃这个配额；
//   · 每次写入都写一条带插件 id 的日志 —— 控制台里查得到"这条说说是谁发的"；
//   · 正文过 `sanitizeUserText`（与群消息同一口径：模型读到的是外部文本）。
//
// 大小写与命名：协议层（protocol.js）用 `cap.qzone.publish` 这类**扁平**方法名，
// 这里的方法表直接以这些名字为键，宿主不需要再做一次映射。
import { parseQzoneFeed, QzoneWebClient } from '../onebot/qzone-feed.js';
import { sanitizeUserText } from '../core/util.js';

const MAX_CONTENT = 1000;          // 说说正文（与 daily-moments 同一条上限）
const MAX_COMMENT = 200;           // 评论正文：比说说短得多，避免插件拿空间当公告板
const MAX_IMAGES = 9;              // Qzone 单条最多九图
const MAX_FEEDS = 20;
const MAX_MINE = 30;
const MAX_WRITES_PER_MIN = 10;     // 每插件每分钟的写入上限（发 / 删 / 赞 / 评共享）
const MAX_PUBLISH_PER_HOUR = 6;    // 发说说单独再压一层：公开内容刷屏的代价比评论大得多
const DEFAULT_TIMEOUT = 45000;
const PUBLISH_TIMEOUT = 90000;     // 带图上传慢，与 daily-moments 一致
// 腾讯侧"忙"的几种说法：Qzone 点赞接口回 retcode=100 / HTTP 500 / network busy。
// 只用于**幂等**的点赞重试，评论绝不重试（重了就是两条）。
const BUSY_RE = /retcode=100|status code:\s*500|network busy|繁忙|使用人数过多/i;
const LIKE_RETRY_DELAY_MS = 2500;

/** Qzone 的可见范围：1 公开 / 4 仅自己 / 16 指定好友 / 128 部分可见。 */
const VISIBILITIES = Object.freeze([1, 4, 16, 128]);

const TID_RE = /^[0-9A-Za-z_-]{4,64}$/;
const UIN_RE = /^\d{5,12}$/;

const fail = (code, message) => Object.assign(new Error(message), { code });

function text(value, max) {
  return sanitizeUserText(String(value ?? '').replace(/\0/g, '').trim()).slice(0, max);
}

function uinOf(value, field = 'uin') {
  const raw = String(value ?? '').trim();
  if (!UIN_RE.test(raw)) throw fail('E_ARGS', `${field} 必须是 5-12 位数字，实际 ${JSON.stringify(value)}`);
  return raw;
}

function tidOf(value) {
  const raw = String(value ?? '').trim();
  if (!TID_RE.test(raw)) throw fail('E_ARGS', `tid 形状不对（4-64 位字母数字/下划线/连字符），实际 ${JSON.stringify(value)}`);
  return raw;
}

function countOf(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

/**
 * 图片：只放行两种形状 —— `base64://…`（插件自己带的字节）与 `http(s)://…`（交给协议端去取）。
 * 不做长度上限以外的检查：真正的下载/上传在协议端，宿主这边拦的是"插件把任意字符串塞进上传参数"。
 */
function imagesOf(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw fail('E_ARGS', 'images 必须是字符串数组');
  const list = value.map((item) => String(item ?? '').trim()).filter(Boolean);
  for (const item of list) {
    if (!/^https?:\/\//i.test(item) && !/^base64:\/\//i.test(item)) {
      throw fail('E_ARGS', 'images 的每一项必须是 http(s):// 或 base64:// 开头');
    }
  }
  return list.slice(0, MAX_IMAGES);
}

/**
 * 点赞接口要「动态发布时间（秒）」。模型手里只有 tid/uin 时，宿主回查一页好友动态把它找出来。
 * 回查失败不阻断调用（返回 0，行为与之前一致），但审计日志里会留下 `abstime 回查=0` 的痕迹。
 */
async function resolvePostTime(client, postId, owner) {
  try {
    const data = await client.call('get_qzone_feeds', { page_num: 1, count: 20 }, DEFAULT_TIMEOUT);
    const hit = (Array.isArray(data?.feeds) ? data.feeds : [])
      .map((item) => parseQzoneFeed(item))
      .find((post) => post.tid === postId && (!owner || post.uin === owner));
    return Number(hit?.time) || 0;
  } catch {
    return 0;
  }
}

/**
 * 建一个「空间网关」：宿主只建一份，每个插件进程启动时 `bind(pluginId)` 拿到自己那份
 * （写入配额是按插件算的，不能被别的插件用光）。
 *
 * @param getOnebot () => OneBotClient（拿不到就如实报错，不假装成功）
 * @param log       宿主日志函数（Error 实例才进异常面板，与各 manager 同约定）
 * @param now       时钟注入点（用例用它压频率窗口）
 */
export function createQzoneGateway({
  getOnebot = () => null, log = () => {}, now = () => Date.now(), retryDelayMs = LIKE_RETRY_DELAY_MS
} = {}) {
  const onebotOf = getOnebot;
  const nowFn = now;
  const logFn = log;
  const retryDelay = Math.max(0, Number(retryDelayMs) || 0);

  const clientOf = () => {
    const client = onebotOf();
    if (!client?.call) throw fail('E_NO_ONEBOT', '宿主没有连上协议端（OneBot 不可用），空间操作暂时做不了');
    return client;
  };

  const selfIdOf = (client) => String(client?.selfId || '');
  // 删除与评论详情走的是 Qzone 的网页接口（要 Cookie），宿主里已经有现成的客户端，
  // 这里**复用**它而不是另写一份 —— 两边的 g_tk / Cookie 取法必须是同一套。
  const webOf = (client) => new QzoneWebClient(client);

  return {
    /** 给某个插件绑一份能力方法表（写入配额按插件独立计数）。 */
    bind(pluginId) {
      const id = String(pluginId || '');
      const writes = [];          // 最近一分钟的写入时间戳
      const publishes = [];       // 最近一小时的发说说时间戳
      const stats = { publishes: 0, deletes: 0, likes: 0, comments: 0, reads: 0, denied: 0 };

      const gateWrite = (kind) => {
        const t = nowFn();
        while (writes.length && t - writes[0] > 60_000) writes.shift();
        if (writes.length >= MAX_WRITES_PER_MIN) {
          stats.denied += 1;
          throw fail('E_RATE', `写得太频繁（每个插件每分钟最多 ${MAX_WRITES_PER_MIN} 次空间写入）`);
        }
        if (kind === 'publish') {
          while (publishes.length && t - publishes[0] > 3_600_000) publishes.shift();
          if (publishes.length >= MAX_PUBLISH_PER_HOUR) {
            stats.denied += 1;
            throw fail('E_RATE', `发说说太频繁（每个插件每小时最多 ${MAX_PUBLISH_PER_HOUR} 条）`);
          }
          publishes.push(t);
        }
        writes.push(t);
      };

      const audit = (action, detail) => {
        logFn(`[plugin:${id}] 空间${action}：${detail}`);
      };

      const methods = {
        /** 发一条说说。返回协议端给的 tid（拿不到 tid 就是没发成，不猜）。 */
        'cap.qzone.publish': async ({ content, images, visibility } = {}) => {
          const body = text(content, MAX_CONTENT);
          if (!body) throw fail('E_ARGS', '说说正文不能为空');
          const list = imagesOf(images);
          const visRaw = visibility === undefined || visibility === null ? 1 : Number(visibility);
          if (!VISIBILITIES.includes(visRaw)) {
            throw fail('E_ARGS', `visibility 只能是 ${VISIBILITIES.join(' / ')}（1 公开 / 4 仅自己 / 16 指定好友 / 128 部分可见）`);
          }
          gateWrite('publish');
          const client = clientOf();
          const result = await client.call('send_qzone_msg', {
            content: body,
            images: list,
            ugc_right: visRaw
          }, PUBLISH_TIMEOUT);
          const tid = String(result?.tid ?? result?.data?.tid ?? '');
          stats.publishes += 1;
          audit('发布', `${body.slice(0, 40)}${list.length ? `（${list.length} 张图）` : ''}${tid ? ` tid=${tid}` : ''}`);
          if (!tid) {
            // 协议端没回 tid：写入很可能已经发生，如实说"结果未知"，别让调用方以为没发出去而重试。
            return { ok: true, tid: '', unknown: true, note: '协议端没有返回 tid，这条说说可能已经发出（结果待核对），不要直接重发' };
          }
          return { ok: true, tid, visibility: visRaw, images: list.length };
        },

        /** 读自己最近的说说（用于查重与"我刚发了啥"）。 */
        'cap.qzone.mine': async ({ count } = {}) => {
          const client = clientOf();
          const selfId = selfIdOf(client);
          if (!UIN_RE.test(selfId)) throw fail('E_NO_SELF', '无法确认当前登录的 QQ 号');
          const num = countOf(count, 10, MAX_MINE);
          const result = await client.call('get_qzone_msg_list', {
            target_uin: Number(selfId), pos: 0, num
          }, DEFAULT_TIMEOUT);
          const list = Array.isArray(result?.msglist) ? result.msglist : [];
          // ⚠️ `get_qzone_msg_list` **不返回点赞数**（实测字段只有 tid/content/time/comment_num/
          // is_private/images）。点赞数只在"好友动态"那页的 HTML 里（`.qz_like_btn_v3` 的
          // data-likecnt）。所以再取一页动态把点赞数、自己赞没赞过补上；
          // 补不到的（比一页还旧）**返回 null**，不能把"不知道"说成 0 个赞。
          const likes = new Map();
          try {
            const feedData = await client.call('get_qzone_feeds', {
              page_num: 1, count: Math.min(Math.max(num, 8), MAX_FEEDS)
            }, DEFAULT_TIMEOUT);
            for (const item of (Array.isArray(feedData?.feeds) ? feedData.feeds : [])) {
              const post = parseQzoneFeed(item);
              if (post.tid) likes.set(post.tid, { likes: post.likeCount, liked: post.isLiked });
            }
          } catch {
            // 取不到就当作"这一页没有"：下面的 likes 会是 null，模型据此说"看不到点赞数"
            logFn(`[plugin:${id}] 空间点赞数回查失败（好友动态页取不到），本次点赞数按未知处理`);
          }
          stats.reads += 1;
          return {
            selfUin: selfId,
            moments: list.map((item) => {
              const tid = String(item?.tid || '');
              const like = likes.get(tid);
              return {
                tid,
                content: text(item?.content, 1200),
                createdAt: Number(item?.time) || 0,
                comments: Number(item?.comment_num) || 0,
                likes: like ? like.likes : null,
                likedBySelf: like ? like.liked : null
              };
            }).filter((item) => item.tid),
            note: '评论数来自空间列表接口；点赞数来自好友动态页，比那一页更旧的说说拿不到（likes 为 null = 未知，不是 0）。'
          };
        },

        /** 删一条**自己发的**说说。别人的删不掉（Qzone 侧也会拒），这里先挡一道更清楚的错。 */
        'cap.qzone.delete': async ({ tid, uin } = {}) => {
          const postId = tidOf(tid);
          const client = clientOf();
          const selfId = selfIdOf(client);
          if (uin !== undefined && String(uin) !== selfId) {
            throw fail('E_FORBIDDEN', '只能删机器人自己发的说说');
          }
          gateWrite('delete');
          const deleted = await webOf(client).deletePost(selfId, postId);
          stats.deletes += 1;
          audit('删除', `tid=${postId}${deleted?.code != null ? ` code=${deleted.code}` : ''}`);
          return { ok: true, tid: postId };
        },

        /** 好友动态（只读）。返回已解析好的结构化条目，不把整段 HTML 交给模型。 */
        'cap.qzone.feeds': async ({ count } = {}) => {
          const client = clientOf();
          const num = countOf(count, 8, MAX_FEEDS);
          const result = await client.call('get_qzone_feeds', { page_num: 1, count: num }, DEFAULT_TIMEOUT);
          const raw = Array.isArray(result?.feeds) ? result.feeds : null;
          if (!raw) throw fail('E_BAD_RESPONSE', '好友动态接口返回格式无效');
          stats.reads += 1;
          return {
            feeds: raw.slice(0, num).map((item) => {
              const post = parseQzoneFeed(item);
              return {
                tid: post.tid,
                uin: post.uin,
                nickname: post.nickname,
                content: post.content,
                createdAt: post.time,
                images: post.images.length,
                isLiked: post.isLiked,
                likes: post.likeCount,
                comments: post.comments.length
              };
            }).filter((item) => item.tid && item.uin)
          };
        },

        /** 点赞一条好友动态。 */
        'cap.qzone.like': async ({ tid, uin, abstime } = {}) => {
          const postId = tidOf(tid);
          const owner = uinOf(uin, 'uin');
          gateWrite('like');
          const client = clientOf();
          // Qzone 的点赞接口要的是「这条动态的发布时间（秒）」。模型经常只拿得到 tid/uin，
          // 所以这里在缺 abstime 时**自己回查一次好友动态**，而不是把 0 丢给上游 ——
          // 上游对 0 有时接受、有时静默失败，那种"点了但没点上"最难查。
          const given = Number(abstime) || 0;
          const when = given > 0 ? given : await resolvePostTime(client, postId, owner);
          const params = { tid: postId, target_uin: Number(owner), abstime: when };
          try {
            await client.call('like_qzone', params, DEFAULT_TIMEOUT);
          } catch (error) {
            // 腾讯侧对点赞偶发 `retcode=100` / HTTP 500（"操作繁忙"）。点赞是**幂等**的：
            // 重点一次最多是"已经赞过"，不会像评论那样留下第二条 —— 所以这里值得重试一次。
            if (!BUSY_RE.test(String(error?.message ?? error))) throw error;
            await new Promise((resolve) => setTimeout(resolve, retryDelay));
            try {
              await client.call('like_qzone', params, DEFAULT_TIMEOUT);
            } catch (retryError) {
              throw fail('E_QZONE_BUSY', `QQ 空间那边繁忙（${String(retryError?.message ?? retryError)}），这次没点上；过一会儿再让它试一次`);
            }
          }
          stats.likes += 1;
          audit('点赞', `tid=${postId} uin=${owner}${given > 0 ? '' : `（abstime 回查=${when}）`}`);
          return { ok: true, tid: postId, uin: owner, abstime: when };
        },

        /** 评论一条好友动态（也用于回复别人的评论：Qzone 侧按 tid + 正文处理）。 */
        'cap.qzone.comment': async ({ tid, uin, content } = {}) => {
          const postId = tidOf(tid);
          const owner = uinOf(uin, 'uin');
          const body = text(content, MAX_COMMENT);
          if (!body) throw fail('E_ARGS', '评论正文不能为空');
          gateWrite('comment');
          const client = clientOf();
          let result = null;
          try {
            result = await client.call('comment_qzone', {
              tid: postId, target_uin: Number(owner), content: body
            }, DEFAULT_TIMEOUT);
          } catch (error) {
            // 评论**不重试**：Qzone 没有幂等键，忙的时候重试就是两条一样的评论。
            if (BUSY_RE.test(String(error?.message ?? error))) {
              throw fail('E_QZONE_BUSY', 'QQ 空间那边繁忙，这次评论没发出去（不会自动重试，避免重复评论）；过一会儿再试');
            }
            throw error;
          }
          stats.comments += 1;
          audit('评论', `tid=${postId} uin=${owner}：${body.slice(0, 40)}`);
          return {
            ok: true,
            tid: postId,
            uin: owner,
            commentId: String(result?.comment_id ?? result?.commentId ?? '')
          };
        },

        /** 读一条动态的完整评论树（回复别人之前先看清上下文）。 */
        'cap.qzone.comments': async ({ tid, uin } = {}) => {
          const postId = tidOf(tid);
          const owner = uinOf(uin, 'uin');
          const client = clientOf();
          // 与删除同一条路：评论详情是 Qzone 网页接口（要 Cookie + g_tk），宿主里已有客户端
          const detail = await webOf(client).getPostDetail(owner, postId);
          stats.reads += 1;
          return {
            tid: detail.tid,
            uin: detail.uin,
            nickname: detail.nickname,
            content: detail.content,
            createdAt: detail.time,
            comments: detail.comments.map((item) => ({
              commentId: item.commentId,
              uin: item.uin,
              nickname: item.nickname,
              content: item.content,
              parentTid: item.parentTid,
              self: item.uin === selfIdOf(client)
            }))
          };
        }
      };

      return { methods, stats };
    }
  };
}
