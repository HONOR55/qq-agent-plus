// 「QQ 空间」能力（cap.qzone.*）的验收用例。
//
// 这条能力的边界不在"能不能发"，而在"发之前有没有挡住不该发的"：
// 正文为空、tid/uin 形状不对、可见范围乱填、一个插件一分钟刷几十条 —— 这些都必须在这里判红。
// 用例不连协议端、不连 Qzone：`call()` 是注入的假协议端，只断言**宿主发出去的动作与参数**。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-qzone-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄占用就算了 */ } });

const { createQzoneGateway } = await import('../src/plugins/qzone.js');
const { createCapabilities } = await import('../src/plugins/capabilities.js');
const { CAP_METHODS, CAP_REQUIREMENT } = await import('../src/plugins/protocol.js');
const { parsePluginManifest, PLUGIN_CAPABILITIES } = await import('../src/plugins/manifest.js');

const SELF = '10001';

/** 假协议端：记录每个动作，按动作名回一份固定结果。 */
function fakeOnebot(overrides = {}) {
  const calls = [];
  return {
    calls,
    selfId: SELF,
    call: async (action, params) => {
      calls.push({ action, params });
      if (overrides[action]) return overrides[action](params);
      if (action === 'send_qzone_msg') return { tid: 'abc123xyz' };
      if (action === 'get_qzone_msg_list') return { msglist: [{ tid: 'm1', content: '第一条', time: 1700000000, comment_num: 2, like_num: 3 }] };
      if (action === 'get_qzone_feeds') {
        return {
          feeds: [{
            key: 'f1a2b3c4d5e6f7a8', uin: '20002', nickname: '小明', time: 1700000100, appid: 311,
            html: '<div class="f-info">今天下雨了</div><div class="img-box"><img src="https://img.example/a.jpg"></div>'
          }]
        };
      }
      if (action === 'like_qzone') return {};
      if (action === 'comment_qzone') return { comment_id: 'c9' };
      return {};
    }
  };
}

const gatewayOf = (onebot, clock = { t: 1_700_000_000_000 }) => {
  const gateway = createQzoneGateway({ getOnebot: () => onebot, log: () => {}, now: () => clock.t, retryDelayMs: 0 });
  const bound = gateway.bind('demo');
  return { gateway, bound, clock };
};

test('协议表：qzone 的每个方法都要求声明 qzone 能力', () => {
  const methods = Object.values(CAP_METHODS).filter((name) => name.startsWith('cap.qzone.'));
  assert.ok(methods.length >= 6, 'qzone 方法不能只剩下一两个');
  for (const name of methods) assert.equal(CAP_REQUIREMENT[name], 'qzone', `${name} 的鉴权口径必须是 qzone`);
  assert.ok(PLUGIN_CAPABILITIES.includes('qzone'), 'manifest 白名单要认识 qzone');
});

test('manifest：声明 qzone 的插件能通过校验', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-qzone-manifest-'));
  try {
    const parsed = parsePluginManifest({
      id: 'qzone-demo',
      apiVersion: 1,
      name: '空间',
      version: '1.0.0',
      capabilities: ['tools', 'qzone'],
      tools: [{ name: 'post_moment', description: '发一条说说', parameters: { type: 'object', properties: {} } }]
    }, { dir });
    assert.ok(parsed.ok, parsed.error);
    assert.deepEqual(parsed.manifest.capabilities, ['tools', 'qzone']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('publish：正文与可见范围原样交给协议端，返回 tid', async () => {
  const onebot = fakeOnebot();
  const { bound } = gatewayOf(onebot);
  const result = await bound.methods['cap.qzone.publish']({ content: '  今天天气很好  ', images: ['https://img.example/x.jpg'], visibility: 4 });
  assert.equal(result.ok, true);
  assert.equal(result.tid, 'abc123xyz');
  const call = onebot.calls.find((item) => item.action === 'send_qzone_msg');
  assert.ok(call, '必须调用 send_qzone_msg');
  assert.equal(call.params.content, '今天天气很好');
  assert.deepEqual(call.params.images, ['https://img.example/x.jpg']);
  assert.equal(call.params.ugc_right, 4);
});

test('publish：空正文 / 越界可见范围 / 非法图片地址都要被挡住', async () => {
  const { bound } = gatewayOf(fakeOnebot());
  await assert.rejects(() => bound.methods['cap.qzone.publish']({ content: '   ' }), /正文不能为空/);
  await assert.rejects(() => bound.methods['cap.qzone.publish']({ content: 'x', visibility: 99 }), /visibility/);
  await assert.rejects(() => bound.methods['cap.qzone.publish']({ content: 'x', images: ['file:///etc/passwd'] }), /images/);
  await assert.rejects(() => bound.methods['cap.qzone.publish']({ content: 'x', images: 'not-array' }), /字符串数组/);
});

test('publish：每小时 6 条上限（同一个插件）', async () => {
  const { bound } = gatewayOf(fakeOnebot());
  for (let i = 0; i < 6; i += 1) {
    await bound.methods['cap.qzone.publish']({ content: `第 ${i} 条` });
  }
  await assert.rejects(() => bound.methods['cap.qzone.publish']({ content: '第 7 条' }), /每小时/);
});

test('写入总量：一分钟 10 次上限，换一分钟就恢复', async () => {
  const clock = { t: 1_700_000_000_000 };
  const { bound } = gatewayOf(fakeOnebot(), clock);
  for (let i = 0; i < 5; i += 1) {
    await bound.methods['cap.qzone.like']({ tid: 'tid0001', uin: '20002', abstime: 1 });
  }
  for (let i = 0; i < 5; i += 1) {
    await bound.methods['cap.qzone.comment']({ tid: 'tid0001', uin: '20002', content: `评论 ${i}` });
  }
  await assert.rejects(() => bound.methods['cap.qzone.like']({ tid: 'tid0001', uin: '20002' }), /每分钟/);
  clock.t += 61_000;
  const ok = await bound.methods['cap.qzone.like']({ tid: 'tid0001', uin: '20002' });
  assert.equal(ok.ok, true);
});

test('delete：只能删自己的，tid/uin 形状先校验', async () => {
  const onebot = fakeOnebot();
  const { bound } = gatewayOf(onebot);
  await assert.rejects(() => bound.methods['cap.qzone.delete']({ tid: 'tid0001', uin: '20002' }), /只能删机器人自己/);
  await assert.rejects(() => bound.methods['cap.qzone.delete']({ tid: '!!' }), /tid/);
  // 自己不删（走网页接口），这条用例只验"拦住别人的"
});

test('like / comment：参数按协议端要的形状传', async () => {
  const onebot = fakeOnebot();
  const { bound } = gatewayOf(onebot);
  await bound.methods['cap.qzone.like']({ tid: 'tid0001', uin: '20002', abstime: 1700000100 });
  await bound.methods['cap.qzone.comment']({ tid: 'tid0001', uin: '20002', content: '写得真好' });
  const like = onebot.calls.find((item) => item.action === 'like_qzone');
  assert.deepEqual(like.params, { tid: 'tid0001', target_uin: 20002, abstime: 1700000100 });
  const comment = onebot.calls.find((item) => item.action === 'comment_qzone');
  assert.deepEqual(comment.params, { tid: 'tid0001', target_uin: 20002, content: '写得真好' });
});

test('mine：点赞数从好友动态页补上（空间列表接口不返回点赞数）', async () => {
  const onebot = fakeOnebot({
    get_qzone_feeds: () => ({
      feeds: [{
        key: 'm1', uin: SELF, nickname: '橘子', time: 1700000000, appid: 311,
        html: '<div class="f-info">第一条</div><div class="qz_like_btn_v3" data-islike="1" data-likecnt="7"></div>'
      }]
    })
  });
  const { bound } = gatewayOf(onebot);
  const mine = await bound.methods['cap.qzone.mine']({ count: 3 });
  assert.equal(mine.moments[0].likes, 7);
  assert.equal(mine.moments[0].likedBySelf, true);
});

test('mine：好友动态页取不到时，点赞数是 null 而不是 0', async () => {
  const onebot = fakeOnebot({ get_qzone_feeds: () => { throw new Error('busy'); } });
  const { bound } = gatewayOf(onebot);
  const mine = await bound.methods['cap.qzone.mine']({ count: 3 });
  assert.equal(mine.moments[0].likes, null);
  assert.equal(mine.moments[0].comments, 2, '评论数仍然来自列表接口');
});

test('mine / feeds：把协议端的原始结构压成模型能读的字段', async () => {
  const onebot = fakeOnebot();
  const { bound } = gatewayOf(onebot);
  const mine = await bound.methods['cap.qzone.mine']({ count: 5 });
  assert.equal(mine.selfUin, SELF);
  assert.equal(mine.moments[0].tid, 'm1');
  assert.equal(mine.moments[0].comments, 2);
  // 默认的假动态页里没有 m1 → 点赞数必须是 null（未知），不能默认成 0
  assert.equal(mine.moments[0].likes, null);

  const feeds = await bound.methods['cap.qzone.feeds']({ count: 5 });
  assert.equal(feeds.feeds.length, 1);
  assert.equal(feeds.feeds[0].tid, 'f1a2b3c4d5e6f7a8');
  assert.equal(feeds.feeds[0].content, '今天下雨了');
  assert.equal(feeds.feeds[0].images, 1);
});

test('like：缺 abstime 时宿主自己回查好友动态补上（模型只给 tid/uin 也能点）', async () => {
  const onebot = fakeOnebot();
  const { bound } = gatewayOf(onebot);
  const result = await bound.methods['cap.qzone.like']({ tid: 'f1a2b3c4d5e6f7a8', uin: '20002' });
  assert.equal(result.abstime, 1700000100);
  const like = onebot.calls.filter((item) => item.action === 'like_qzone').pop();
  assert.equal(like.params.abstime, 1700000100, '回查到的发布时间要交给 like_qzone');
  assert.ok(onebot.calls.some((item) => item.action === 'get_qzone_feeds'), '回查走的是好友动态接口');
});


test('like：腾讯侧忙（retcode=100）时自动重试一次，成功就算成功', async () => {
  let attempts = 0;
  const onebot = fakeOnebot({
    like_qzone: () => {
      attempts += 1;
      if (attempts === 1) throw new Error('OneBot like_qzone 失败: retcode=100 Unexpected status code: 500');
      return {};
    }
  });
  const { bound } = gatewayOf(onebot);
  const result = await bound.methods['cap.qzone.like']({ tid: 'tid0001', uin: '20002', abstime: 1 });
  assert.equal(result.ok, true);
  assert.equal(attempts, 2, '忙的时候要再点一次');
});

test('like：连续两次忙就如实报「繁忙」，不假装点上了', async () => {
  const onebot = fakeOnebot({ like_qzone: () => { throw new Error('retcode=100 network busy'); } });
  const { bound } = gatewayOf(onebot);
  await assert.rejects(() => bound.methods['cap.qzone.like']({ tid: 'tid0001', uin: '20002', abstime: 1 }), /繁忙/);
});

test('comment：忙的时候**不重试**（避免重复评论），报可读错误', async () => {
  let attempts = 0;
  const onebot = fakeOnebot({ comment_qzone: () => { attempts += 1; throw new Error('retcode=100'); } });
  const { bound } = gatewayOf(onebot);
  await assert.rejects(
    () => bound.methods['cap.qzone.comment']({ tid: 'tid0001', uin: '20002', content: '写得真好' }),
    /不会自动重试/
  );
  assert.equal(attempts, 1, '评论只发一次，忙了也不重试');
});

test('没有协议端时如实报错，不假装发成功', async () => {
  const gateway = createQzoneGateway({ getOnebot: () => null, log: () => {} });
  const { methods } = gateway.bind('demo');
  await assert.rejects(() => methods['cap.qzone.publish']({ content: 'x' }), /没有连上协议端/);
});

test('createCapabilities：接上网关才多出 qzone 方法', () => {
  const plain = createCapabilities({ pluginId: 'a', dataDir, log: () => {} });
  assert.equal(plain.methods['cap.qzone.publish'], undefined, '没接网关时不该有空间方法');

  const gateway = createQzoneGateway({ getOnebot: () => fakeOnebot(), log: () => {} });
  const wired = createCapabilities({ pluginId: 'b', dataDir, log: () => {}, getQzone: () => gateway });
  assert.equal(typeof wired.methods['cap.qzone.publish'], 'function');
  assert.equal(typeof wired.methods['cap.qzone.feeds'], 'function');
});
