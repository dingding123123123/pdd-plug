// Background service worker (MV3)
// 职责：
//   1. 接收 popup/options 发来的"下单请求"，开标签页跳到商品页，content script 自动接管
//   2. 定时轮询发货状态（chrome.alarms），打开订单列表让 content script 抓取
//   3. 聚合 content script 发回的订单状态，必要时推送桌面通知

import {
  getOrders, saveOrders, addOrder, updateOrder,
  getSettings, getProducts
} from '../lib/storage.js';

const ALARM_SHIPPING_CHECK = 'pdd-shipping-check';
const ALARM_BATCH_ADVANCE = 'pdd-batch-advance';

// ---------- Alarms ----------

async function rescheduleShippingCheck() {
  const s = await getSettings();
  await chrome.alarms.clear(ALARM_SHIPPING_CHECK);
  if (!s.shippingCheckEnabled) return;
  const minutes = Math.max(10, s.shippingCheckIntervalMinutes);
  await chrome.alarms.create(ALARM_SHIPPING_CHECK, {
    delayInMinutes: minutes,
    periodInMinutes: minutes
  });
  console.log('[PDD] 下一次发货检查:', minutes, '分钟后');
}

chrome.runtime.onInstalled.addListener(async () => {
  await rescheduleShippingCheck();
});
chrome.runtime.onStartup.addListener(async () => {
  await rescheduleShippingCheck();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_SHIPPING_CHECK) {
    await triggerShippingCheck({ silent: true });
  } else if (alarm.name === ALARM_BATCH_ADVANCE) {
    console.log('[PDD SW] alarm 唤醒，推进批量');
    await advanceBatch();
  }
});

// ---------- 下单编排 ----------

async function setPendingTask(task) {
  try {
    await chrome.storage.session.set({ pendingTask: task });
  } catch (e) {
    console.warn('[PDD SW] session storage 不可用，使用 local:', e);
    await chrome.storage.local.set({ pendingTask: task });
  }
}

async function placeOrder(product) {
  console.log('[PDD SW] placeOrder:', product);
  if (!product?.url) throw new Error('商品链接为空');
  await setPendingTask({ type: 'placeOrder', product, startedAt: Date.now() });
  const tab = await chrome.tabs.create({ url: product.url, active: true });
  console.log('[PDD SW] opened tab:', tab.id, tab.url);
  return tab.id;
}

// ---------- 批量队列 ----------
// 批量状态存 local（跨 SW 重启也能恢复）
async function getBatchState() {
  const r = await chrome.storage.local.get('batchState');
  return r.batchState || null;
}

async function setBatchState(state) {
  if (state) await chrome.storage.local.set({ batchState: state });
  else await chrome.storage.local.remove('batchState');
}

async function startBatch(products) {
  if (!products || products.length === 0) throw new Error('批量商品为空');
  const state = {
    queue: products.slice(),      // 待处理
    total: products.length,
    currentIndex: 0,
    successes: 0,
    failures: 0,
    startedAt: Date.now()
  };
  await setBatchState(state);
  await advanceBatch();            // 立即跑第一个
}

async function advanceBatch() {
  const state = await getBatchState();
  if (!state || state.queue.length === 0) {
    if (state) {
      notify(`批量下单完成：成功 ${state.successes}，失败 ${state.failures}`);
      await setBatchState(null);
    }
    return;
  }
  const next = state.queue.shift();
  state.currentIndex = state.total - state.queue.length - 1;
  await setBatchState(state);
  console.log('[PDD SW] 批量下一个:', next.title || next.url, '剩余:', state.queue.length);
  try {
    await placeOrder(next);
  } catch (e) {
    console.error('[PDD SW] 批量启动失败:', e);
    state.failures++;
    await setBatchState(state);
    // await 保持 SW 存活，再递归下一个
    await new Promise(r => setTimeout(r, 2000));
    await advanceBatch();
  }
}

// content script 通知完成（结算页点完"立即支付"就触发，不等支付页跳转）
async function onBatchItemDone(ok) {
  const state = await getBatchState();
  if (!state) return;
  if (ok) state.successes++;
  else state.failures++;
  await setBatchState(state);
  if (state.queue.length === 0) {
    notify(`批量下单完成：成功 ${state.successes}，失败 ${state.failures}`);
    await setBatchState(null);
    return;
  }
  const settings = await getSettings();
  const delaySec = Math.max(2, settings.batchDelaySec || 8);
  console.log('[PDD SW] 排期 alarm，', delaySec, '秒后处理下一个 (剩余', state.queue.length, '个)');
  // 用 chrome.alarms 做延时：即使 SW 被 Chrome 回收也能可靠唤醒
  // alarms 最小间隔 30s 的限制只针对 periodInMinutes，一次性 delayInMinutes 可以更短（Chrome 120+）
  // 保险起见：短延时用 setTimeout，长延时用 alarms
  if (delaySec >= 25) {
    await chrome.alarms.create(ALARM_BATCH_ADVANCE, { delayInMinutes: delaySec / 60 });
  } else {
    await new Promise(r => setTimeout(r, delaySec * 1000));
    console.log('[PDD SW] 冷却结束，推进批量');
    await advanceBatch();
  }
}

// ---------- 发货检查 ----------

async function triggerShippingCheck({ silent } = {}) {
  const orders = await getOrders();
  const pending = orders.filter(o => o.status !== 'shipped' && o.status !== 'canceled');
  if (pending.length === 0) {
    if (!silent) notify('暂无待发货订单');
    return;
  }
  await chrome.storage.session.set({
    pendingTask: {
      type: 'checkShipping',
      startedAt: Date.now(),
      silent: !!silent
    }
  });
  // 在后台标签页打开订单列表（active:false 不打扰用户）
  await chrome.tabs.create({
    url: 'https://mobile.yangkeduo.com/orders.html',
    active: false
  });
}

// ---------- 消息路由 ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log('[PDD SW] received message:', msg?.type, msg);
  (async () => {
    try {
      switch (msg?.type) {
        case 'getPendingTask': {
          let task = null;
          try {
            const r = await chrome.storage.session.get('pendingTask');
            task = r.pendingTask || null;
          } catch (_) {}
          if (!task) {
            const r = await chrome.storage.local.get('pendingTask');
            task = r.pendingTask || null;
          }
          sendResponse({ ok: true, task });
          break;
        }
        case 'clearPendingTask': {
          try { await chrome.storage.session.remove('pendingTask'); } catch (_) {}
          await chrome.storage.local.remove('pendingTask');
          sendResponse({ ok: true });
          break;
        }
        case 'placeOrder': {
          const tabId = await placeOrder(msg.product);
          sendResponse({ ok: true, tabId });
          break;
        }
        case 'batchOrder': {
          await startBatch(msg.products || []);
          sendResponse({ ok: true });
          break;
        }
        case 'getBatchState': {
          const state = await getBatchState();
          sendResponse({ ok: true, state });
          break;
        }
        case 'batchItemDone': {
          await onBatchItemDone(!!msg.success);
          sendResponse({ ok: true });
          break;
        }
        case 'orderSubmitted': {
          // content script 把订单提交到支付页就报回来
          await addOrder({
            id: msg.orderId || `local-${Date.now()}`,
            productUrl: msg.productUrl,
            productTitle: msg.productTitle || '',
            quantity: msg.quantity || 1,
            spec: msg.spec || '',
            status: 'awaiting_payment',    // 待支付
            createdAt: Date.now(),
            lastCheckedAt: null,
            shippedAt: null
          });
          sendResponse({ ok: true });
          break;
        }
        case 'orderError': {
          notify(`下单失败: ${msg.reason || '未知错误'}`);
          sendResponse({ ok: true });
          break;
        }
        case 'shippingCheckResult': {
          // content script 从订单页抓到的订单状态数组
          await mergeShippingResult(msg.items || [], msg.silent);
          sendResponse({ ok: true });
          // 后台任务结束关掉标签
          if (sender.tab?.id) chrome.tabs.remove(sender.tab.id).catch(() => {});
          break;
        }
        case 'triggerShippingCheckNow': {
          await triggerShippingCheck({ silent: false });
          sendResponse({ ok: true });
          break;
        }
        case 'rescheduleAlarm': {
          await rescheduleShippingCheck();
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'unknown message' });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
  })();
  return true;  // 异步响应
});

async function mergeShippingResult(items, silent) {
  const orders = await getOrders();
  let shippedCount = 0;
  for (const item of items) {
    // 用订单号或商品标题 + 时间粗匹配本地订单
    let localIdx = orders.findIndex(o => o.id === item.orderId);
    if (localIdx < 0 && item.title) {
      localIdx = orders.findIndex(o =>
        o.productTitle && item.title.includes(o.productTitle) && o.status !== 'shipped'
      );
    }
    if (localIdx < 0) continue;
    const local = orders[localIdx];
    const newStatus = item.shipped ? 'shipped' : (local.status === 'awaiting_payment' ? 'paid' : local.status);
    if (local.status !== 'shipped' && newStatus === 'shipped') {
      shippedCount++;
      orders[localIdx] = {
        ...local,
        status: 'shipped',
        shippedAt: Date.now(),
        trackingNo: item.trackingNo || local.trackingNo || '',
        lastCheckedAt: Date.now()
      };
    } else {
      orders[localIdx] = { ...local, status: newStatus, lastCheckedAt: Date.now() };
    }
  }
  await saveOrders(orders);
  if (shippedCount > 0) {
    notify(`${shippedCount} 个订单已发货`);
  } else if (!silent) {
    notify('没有新发货的订单');
  }
}

function notify(message, title = '拼多多下单助手') {
  const iconUrl = chrome.runtime.getURL('icons/icon128.png');
  chrome.notifications.create({
    type: 'basic',
    iconUrl,
    title,
    message,
    priority: 1
  }, () => {
    if (chrome.runtime.lastError) {
      console.warn('[PDD] 通知失败:', chrome.runtime.lastError.message, 'iconUrl=', iconUrl);
    }
  });
}
