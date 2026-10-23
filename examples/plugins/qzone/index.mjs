// 官方插件：QQ 空间（发 / 看 / 删 / 好友动态 / 点赞 / 评论）。
//
// 为什么这个插件**不自己发 HTTP**：在 Linux 上插件进程被宿主关进没有网络接口的命名空间，
// 也读不到 config.json 里的协议端令牌；发说说只能走宿主的 `cap.qzone.*`（背后是 SnowLuma 的
// send_qzone_msg / like_qzone / comment_qzone）。所以这里的每个工具都是一层"把参数说清楚、
// 把结果整理成模型能读的形状"的薄封装，真正的守卫（长度、限频、只能删自己的）在宿主侧。
//
// 两件这层要自己做的事：
//   1. **查重**：Qzone 没有幂等键，模型超时重试就会发出两条一样的说说。这里把最近发过的正文
//      记在 storage 里，30 分钟内同文直接拒；
//   2. **删除白名单**：只允许删"这个插件自己发过、并且 tid 还在最近 20 条里"的说说 ——
//      模型手里只要有一个 tid 就能调，这层是最后一道可读的错。
const send = (message) => { process.stdout.write(`${JSON.stringify(message)}\n`); };

const REPEAT_WINDOW_MS = 30 * 60 * 1000;
const KEEP_TIDS = 20;
const MAX_CONTENT = 1000;
const MAX_COMMENT = 200;

let settings = {};
let buffer = '';
let requestSeq = 0;
const pending = new Map();

const callHost = (method, params) => new Promise((resolve, reject) => {
  const id = ++requestSeq;
  pending.set(id, { resolve, reject });
  send({ id, method, params });
});

const wrap = (error, code) => Object.assign(new Error(String(error?.message || error)), { code });

async function callQzone(method, params = {}) {
  try {
    return await callHost(`cap.qzone.${method}`, params);
  } catch (error) {
    // 宿主没接这条能力（老版本）时，给一句人话，而不是把 "unknown method" 原样丢给模型
    if (/未知|unknown|不支持|E_CAP/i.test(String(error?.message || ''))) {
      throw wrap(new Error('当前宿主不支持 QQ 空间能力（需要带 qzone 能力的宿主版本）'), 'E_NO_CAP');
    }
    throw error;
  }
}

const storage = {
  async get(key, fallback) {
    try {
      const result = await callHost('cap.storage.get', { key });
      return result?.value === null || result?.value === undefined ? fallback : result.value;
    } catch {
      return fallback;
    }
  },
  async set(key, value) {
    try { await callHost('cap.storage.set', { key, value }); } catch { /* 存不下不影响发布本身 */ }
  }
};

const textOf = (value, max) => String(value ?? '').replace(/\0/g, '').trim().slice(0, max);

function visibilityOf(value) {
  const raw = value === undefined || value === null ? Number(settings.defaultVisibility) || 1 : Number(value);
  return [1, 4, 16, 128].includes(raw) ? raw : 1;
}

/** 最近发布记录：`[{ content, tid, at }]`，只留最近 20 条。 */
async function recentPosts() {
  const list = await storage.get('recentPosts', []);
  return Array.isArray(list) ? list.filter((item) => item && typeof item === 'object') : [];
}

async function rememberPost(entry) {
  const list = await recentPosts();
  list.unshift(entry);
  await storage.set('recentPosts', list.slice(0, KEEP_TIDS));
}

const tools = {
  async post_moment(args = {}) {
    const content = textOf(args.content, MAX_CONTENT);
    if (!content) return { error: '正文不能为空（说说总得有一句话）' };
    const images = Array.isArray(args.images) ? args.images.map((item) => String(item || '').trim()).filter(Boolean) : [];
    for (const url of images) {
      if (!/^https?:\/\//i.test(url)) return { error: `配图地址必须是 http(s):// 开头：${url}` };
    }
    if (images.length > 9) return { error: '配图最多 9 张' };

    // 查重：同一段正文 30 分钟内不重复发。模型在超时后重试是最常见的重复来源。
    const recent = await recentPosts();
    const now = Date.now();
    const duplicate = recent.find((item) => item.content === content && now - Number(item.at || 0) < REPEAT_WINDOW_MS);
    if (duplicate) {
      return {
        error: `这条正文 ${Math.max(1, Math.round((now - Number(duplicate.at || 0)) / 60000))} 分钟前刚发过（tid=${duplicate.tid || '?'}），不要发重复内容；确实要再发一条就改一下正文。`
      };
    }

    const result = await callQzone('publish', {
      content, images, visibility: visibilityOf(args.visibility)
    });
    if (result?.unknown) {
      // 结果未知：**不记进查重列表**（记了会挡住用户真正想重发的场景），但要把话说清楚
      return {
        ok: false,
        unknown: true,
        message: result.note || '协议端没有返回 tid，这条说说可能已经发出。先 list_my_moments 核对，不要直接重发。'
      };
    }
    await rememberPost({ content, tid: String(result?.tid || ''), at: now });
    return {
      ok: true,
      tid: String(result?.tid || ''),
      visibility: result?.visibility ?? visibilityOf(args.visibility),
      images: images.length,
      note: '已发布。要撤掉的话用 delete_moment（tid 就是上面这个）。'
    };
  },

  async list_my_moments(args = {}) {
    const count = Math.min(Math.max(Number(args.count) || 10, 1), 30);
    const result = await callQzone('mine', { count });
    const moments = Array.isArray(result?.moments) ? result.moments : [];
    if (!moments.length) return { moments: [], note: '空间里还没有说说。' };
    return { selfUin: result.selfUin, moments };
  },

  async delete_moment(args = {}) {
    const tid = textOf(args.tid, 64);
    if (!tid) return { error: 'tid 不能为空' };
    const recent = await recentPosts();
    if (!recent.some((item) => String(item.tid || '') === tid)) {
      return {
        error: `tid=${tid} 不在这个插件最近发过的 ${KEEP_TIDS} 条里。先 list_my_moments 核对 tid，或确认它是不是别的途径发的（那种这里删不了）。`
      };
    }
    const result = await callQzone('delete', { tid });
    if (result?.ok) {
      await storage.set('recentPosts', recent.filter((item) => String(item.tid || '') !== tid));
      return { ok: true, tid, note: '已删除。' };
    }
    return { ok: false, message: '删除没有成功，宿主没有返回成功标记。' };
  },

  async list_friend_feeds(args = {}) {
    const count = Math.min(Math.max(Number(args.count) || 8, 1), 20);
    const result = await callQzone('feeds', { count });
    const feeds = Array.isArray(result?.feeds) ? result.feeds : [];
    if (!feeds.length) return { feeds: [], note: '这一批没有取到好友动态（可能是没人发，也可能是接口繁忙）。' };
    return {
      feeds: feeds.map((item) => ({
        tid: item.tid,
        uin: item.uin,
        nickname: item.nickname,
        content: item.content,
        time: item.createdAt ? new Date(Number(item.createdAt) * 1000).toISOString() : '',
        // 秒级时间戳：点赞时可以原样传给 like_moment 的 abstime（Qzone 的点赞接口要它）
        abstime: Number(item.createdAt) || 0,
        images: item.images,
        liked: item.isLiked,
        likes: item.likes,
        comments: item.comments
      }))
    };
  },

  async like_moment(args = {}) {
    const tid = textOf(args.tid, 64);
    const uin = textOf(args.uin, 20);
    if (!tid || !uin) return { error: 'tid 与 uin 都要给（从 list_friend_feeds 里拿）' };
    // abstime 可选：list_friend_feeds 会返回秒级时间戳；不给的话宿主自己回查
    const result = await callQzone('like', { tid, uin, abstime: Number(args.abstime) || 0 });
    return { ok: Boolean(result?.ok), tid, uin, abstime: result?.abstime ?? (Number(args.abstime) || 0) };
  },

  async comment_moment(args = {}) {
    const tid = textOf(args.tid, 64);
    const uin = textOf(args.uin, 20);
    const content = textOf(args.content, MAX_COMMENT);
    if (!tid || !uin) return { error: 'tid 与 uin 都要给（从 list_friend_feeds 里拿）' };
    if (!content) return { error: '评论正文不能为空' };
    const result = await callQzone('comment', { tid, uin, content });
    return { ok: Boolean(result?.ok), tid, uin, commentId: result?.commentId || '' };
  },

  async read_moment_comments(args = {}) {
    const tid = textOf(args.tid, 64);
    const uin = textOf(args.uin, 20);
    if (!tid || !uin) return { error: 'tid 与 uin 都要给（从 list_friend_feeds 里拿）' };
    const result = await callQzone('comments', { tid, uin });
    return {
      tid: result?.tid,
      uin: result?.uin,
      nickname: result?.nickname,
      content: result?.content,
      comments: Array.isArray(result?.comments) ? result.comments : []
    };
  }
};

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index = buffer.indexOf('\n');
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      let message = null;
      try { message = JSON.parse(line); } catch { message = null; }
      if (message?.method === 'callTool') {
        const fn = tools[message.params?.name];
        if (!fn) {
          send({ id: message.id, error: { code: 'E_NO_TOOL', message: `没有这个工具：${message.params?.name}` } });
        } else {
          Promise.resolve()
            .then(() => fn(message.params?.args ?? {}))
            .then((result) => send({ id: message.id, result }))
            .catch((error) => send({ id: message.id, error: { code: error?.code || 'E_TOOL', message: String(error?.message || error) } }));
        }
      } else if (message?.method === 'init') {
        settings = message.params?.settings && typeof message.params.settings === 'object' ? message.params.settings : {};
        send({ id: message.id, result: { ok: true } });
      } else if (message?.method === 'ping') {
        send({ id: message.id, result: {} });
      } else if (message?.method === 'schedule') {
        send({ id: message.id, result: {} });
      } else if (message?.method === 'shutdown') {
        send({ id: message.id, result: {} });
        setTimeout(() => process.exit(0), 10);
      } else if (message?.id !== undefined) {
        const entry = pending.get(message.id);
        if (entry) {
          pending.delete(message.id);
          if (message.error) entry.reject(Object.assign(new Error(message.error.message || '能力调用失败'), { code: message.error.code }));
          else entry.resolve(message.result ?? null);
        }
      }
    }
    index = buffer.indexOf('\n');
  }
});
