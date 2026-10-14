// 订单列表页抓取发货状态
// URL: mobile.yangkeduo.com/orders.html

(async function () {
  const resp = await chrome.runtime.sendMessage({ type: 'getPendingTask' });
  const task = resp?.task;
  if (!task || task.type !== 'checkShipping') return;

  const silent = !!task.silent;

  // 等页面渲染好
  await new Promise(r => setTimeout(r, 2500));

  // PDD 订单项通常是列表 div，每个订单包含商品标题 + 状态标签
  // 常见状态文本: 待付款 / 待发货 / 待收货 / 已完成 / 已取消 / 已发货
  const items = scrapeOrders();

  console.log('[PDD] 抓到订单:', items);

  await chrome.runtime.sendMessage({
    type: 'shippingCheckResult',
    items,
    silent
  });

  // 任务完成，清掉；标签页由 background 关闭
  await chrome.runtime.sendMessage({ type: 'clearPendingTask' });

  function scrapeOrders() {
    const result = [];

    // 策略 1: 寻找包含状态文本的卡片，往上找最近的订单容器
    const statusTexts = ['待付款', '待发货', '待收货', '已完成', '已发货', '已取消'];
    const nodes = Array.from(document.querySelectorAll('div, span'));
    const seen = new Set();

    for (const n of nodes) {
      const t = (n.textContent || '').trim();
      if (!t) continue;
      // 必须正好是状态标签那种短文本，不是整个订单
      if (!statusTexts.some(s => t === s)) continue;
      const card = findOrderCard(n);
      if (!card || seen.has(card)) continue;
      seen.add(card);

      const title = pickTitle(card);
      const orderId = pickOrderId(card);
      const shipped = (t === '待收货' || t === '已发货' || t === '已完成');
      const trackingNo = pickTracking(card);

      result.push({
        orderId: orderId || '',
        title: title || '',
        statusText: t,
        shipped,
        trackingNo: trackingNo || ''
      });
    }

    return result;
  }

  function findOrderCard(el) {
    let cur = el;
    for (let i = 0; i < 8 && cur; i++) {
      const r = cur.getBoundingClientRect();
      if (r.height > 80 && r.width > 200) return cur;
      cur = cur.parentElement;
    }
    return cur;
  }

  function pickTitle(card) {
    const titleEl = card.querySelector(
      '[class*="goods-name"], [class*="title"], [class*="goodsName"]'
    );
    if (titleEl) return titleEl.textContent.trim();
    // 兜底：取卡片里最长的那个文本节点
    const all = Array.from(card.querySelectorAll('span, div'))
      .map(e => (e.textContent || '').trim())
      .filter(t => t.length > 6 && t.length < 80);
    return all.sort((a, b) => b.length - a.length)[0] || '';
  }

  function pickOrderId(card) {
    const text = card.textContent || '';
    const m = text.match(/订单号[：: ]*([0-9]{10,})/)
      || text.match(/\b(\d{15,22})\b/);
    return m ? m[1] : '';
  }

  function pickTracking(card) {
    const text = card.textContent || '';
    const m = text.match(/物流单号[：: ]*([A-Za-z0-9]{8,})/);
    return m ? m[1] : '';
  }
})();
