// 商品页/下单页/支付页通用 content script（隔离世界）
// React 相关点击全部委托给 page-helper.js（MAIN world）
// 这里只负责：读 pendingTask、等页面状态、chrome.runtime.sendMessage

(async function () {
  const H = window.__pddHuman;
  if (!H) {
    console.warn('[PDD] human-like.js 未加载');
    return;
  }

  const path = location.pathname;
  const isGoodsPage = /\/goods/i.test(path);
  const isCheckoutPage = /order_checkout/i.test(path);
  const isPayPage = /\/pay/i.test(path);

  const resp = await chrome.runtime.sendMessage({ type: 'getPendingTask' });
  const task = resp?.task;
  if (!task || task.type !== 'placeOrder') return;

  const product = task.product;
  const settings = (await chrome.storage.local.get('settings')).settings || {};
  const stopBeforePay = settings.stopBeforePay !== false;

  console.log('[PDD] 下单流程启动，当前页面:', path, '任务:', task);
  console.log('[PDD] viewport:', window.innerWidth, 'x', window.innerHeight);

  try {
    if (isGoodsPage) {
      await handleGoodsPage(product);
    } else if (isCheckoutPage) {
      await handleCheckoutPage(product);
    } else if (isPayPage) {
      await handlePayPage(product, stopBeforePay);
    }
  } catch (err) {
    console.error('[PDD] 下单流程失败:', err);
    await chrome.runtime.sendMessage({
      type: 'orderError',
      reason: err?.message || String(err)
    });
    await chrome.runtime.sendMessage({ type: 'clearPendingTask' });
    // 失败也要让批量继续下一个
    await chrome.runtime.sendMessage({ type: 'batchItemDone', success: false });
  }

  // ========== 跨世界桥 ==========
  // 向 MAIN world 的 page-helper 发指令，等响应
  function callMain(action, params = {}, timeout = 3000) {
    return new Promise((resolve) => {
      const id = 'cmd-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
      const timer = setTimeout(() => {
        window.removeEventListener('pdd:resp', handler);
        resolve({ ok: false, reason: 'main world 响应超时（可能 page-helper 未加载）' });
      }, timeout);
      const handler = (ev) => {
        if (ev.detail?.id !== id) return;
        clearTimeout(timer);
        window.removeEventListener('pdd:resp', handler);
        resolve(ev.detail.result);
      };
      window.addEventListener('pdd:resp', handler);
      window.dispatchEvent(new CustomEvent('pdd:cmd', { detail: { id, action, params } }));
    });
  }

  // ========== 工具 ==========
  async function waitForDialogVisible(timeout = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const info = await callMain('getDialogInfo');
      if (info?.exists && info.visible) return info;
      await new Promise(r => setTimeout(r, 200));
    }
    return null;
  }

  function detectToast() {
    const text = document.body.innerText || '';
    for (const kw of ['请选择规格', '该商品暂不支持', '参团失败', '活动已结束', '库存不足', '已售罄']) {
      if (text.includes(kw)) return kw;
    }
    return null;
  }

  // ========== 商品页 ==========
  async function handleGoodsPage(product) {
    await H.humanPause();

    // 1. 让 MAIN world 点底部购买按钮
    const r1 = await callMain('clickBottomBuy');
    console.log('[PDD] 底部购买按钮点击结果:', r1);
    if (!r1.ok) {
      throw new Error('点击购买按钮失败: ' + r1.reason);
    }

    // 2. 等面板出现
    const dialogInfo = await waitForDialogVisible(5000);
    if (!dialogInfo) {
      const info = await callMain('getDialogInfo');
      console.error('[PDD] 面板未显示，当前 dialog 信息:', info);
      throw new Error('面板未弹出（React handler 已调用但 state 未更新？）');
    }
    console.log('[PDD] 面板已出现:', dialogInfo.rect);

    await H.humanPause();

    // 3. 选规格
    if (product.spec) {
      const tokens = product.spec.split(/[、,，\s]+/).filter(Boolean);
      for (const token of tokens) {
        const r = await callMain('clickInDialog', { text: token });
        if (r.ok) {
          console.log('[PDD] 规格点中:', token, '→', r.foundLabel,
            `[src=${r.src} invoked=${r.invoked} cls=${r.cls}]`);
        } else {
          console.warn('[PDD] 规格未点中:', token, '原因:', r.reason, '可选:', r.availableSpecs);
        }
        await H.humanPause();
      }
    } else {
      const r = await callMain('listDialogSpecs');
      console.log('[PDD] 未配置规格，面板里可选:', r?.specs);
    }

    // 4. 点确定
    await new Promise(r => setTimeout(r, 400));
    const CONFIRM_LABELS = ['确定', '发起拼单', '立即购买', '确认开团', '确认', '立即支付', '去支付', '去结算'];
    let confirmR = null;
    for (const label of CONFIRM_LABELS) {
      confirmR = await callMain('clickInDialog', { text: label });
      if (confirmR.ok) {
        console.log('[PDD] 确定点中:', label, '→', confirmR.foundLabel);
        break;
      }
    }
    if (!confirmR?.ok) {
      throw new Error('面板里没找到确定按钮: ' + (confirmR?.reason || 'unknown'));
    }

    // 5. 等待跳转
    const urlBefore = location.href;
    await new Promise(r => setTimeout(r, 2200));
    const toast = detectToast();
    if (toast) throw new Error('PDD 拒绝: ' + toast);
    if (location.href === urlBefore) {
      const info = await callMain('getDialogInfo');
      console.warn('[PDD] 确定后 URL 未变。dialog 状态:', info);
    } else {
      console.log('[PDD] 已跳转:', location.href);
    }
  }

  // ========== 结算页 ==========
  async function handleCheckoutPage(product) {
    await H.humanPause();
    const title = document.querySelector('[class*="goods-name"], [class*="title"]')?.textContent?.trim() || '';

    // 如果配了地址关键词，先切换地址
    if (product.addressKey) {
      const cur = await callMain('getCurrentAddress');
      console.log('[PDD] 当前地址栏:', cur?.text?.slice(0, 60) || '(未读到)');
      const ar = await callMain('selectAddress', { key: product.addressKey }, 6000);
      if (ar.ok) {
        console.log('[PDD] 地址切换结果:', ar.skipped ? '已匹配，跳过' : '切到: ' + ar.matched);
      } else {
        console.warn('[PDD] 地址切换失败:', ar.reason, '可选:', ar.available);
      }
      await H.humanPause();
      await new Promise(r => setTimeout(r, 500));
    }

    // 让结算页也走 MAIN world React invocation
    const r = await callMain('clickBottomSubmit');
    console.log('[PDD] 结算页提交结果:', r);
    if (!r.ok) throw new Error('结算页没找到提交按钮: ' + r.reason);

    await chrome.runtime.sendMessage({
      type: 'orderSubmitted',
      productUrl: product.url,
      productTitle: title || product.title || '',
      quantity: product.quantity || 1,
      spec: product.spec || ''
    });

    // 🔑 结算页"立即支付"已点，订单已经提交到待支付。
    // 此时就通知批量继续，不等页面跳转（支付页加载慢/PDD 自跳转/用户关闭等都可能让后续代码没机会跑）
    await chrome.runtime.sendMessage({ type: 'clearPendingTask' });
    await chrome.runtime.sendMessage({ type: 'batchItemDone', success: true });
    console.log('[PDD] 已通知批量继续（本单到待支付）');

    // 等待跳转提示（可选，不阻塞批量）
    await new Promise(r => setTimeout(r, 2500));
    const toast = detectToast();
    if (toast) console.warn('[PDD] 结算页提示:', toast);
    console.log('[PDD] 结算后 URL:', location.href);
  }

  // ========== 支付页 ==========
  async function handlePayPage(product, stopBeforePay) {
    console.log('[PDD] 到达支付页，等待用户手动完成支付');
    // 结算页已经通知过 batchItemDone 了，支付页只负责清任务 + 显示横幅
    await chrome.runtime.sendMessage({ type: 'clearPendingTask' });
    if (stopBeforePay) {
      const bar = document.createElement('div');
      bar.textContent = '✅ 已到支付页，请手动完成支付';
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999999;background:#e02e24;color:#fff;font-size:14px;padding:10px;text-align:center;font-family:system-ui;';
      document.body.appendChild(bar);
      setTimeout(() => bar.remove(), 8000);
    }
  }
})();
