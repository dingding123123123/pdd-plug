import { getProducts, getOrders, getSettings } from '../lib/storage.js';

const $ = (id) => document.getElementById(id);

let selectedIds = new Set();

async function render() {
  const [products, orders, settings, batchState] = await Promise.all([
    getProducts(), getOrders(), getSettings(),
    chrome.runtime.sendMessage({ type: 'getBatchState' }).catch(() => null)
  ]);

  // 商品列表
  const productList = $('productList');
  productList.innerHTML = '';
  $('noProducts').classList.toggle('hidden', products.length > 0);

  for (const p of products) {
    const row = document.createElement('div');
    row.className = 'item';
    const checked = selectedIds.has(p.id) ? 'checked' : '';
    row.innerHTML = `
      <input type="checkbox" data-id="${p.id}" ${checked}>
      <div class="name" title="${escapeHtml(p.url)}">${escapeHtml(p.title || p.url)}</div>
      <span class="meta">x${p.quantity || 1}${p.spec ? ' · ' + escapeHtml(p.spec) : ''}${p.addressKey ? ' · 📍' + escapeHtml(p.addressKey) : ''}</span>
      <button class="btn-primary" data-id="${p.id}">下单</button>
    `;
    const cb = row.querySelector('input[type="checkbox"]');
    cb.addEventListener('change', () => {
      if (cb.checked) selectedIds.add(p.id);
      else selectedIds.delete(p.id);
      updateBatchButton();
    });
    row.querySelector('button').addEventListener('click', async () => {
      await startSingle(p, row);
    });
    productList.appendChild(row);
  }
  updateBatchButton();

  // 显示当前批量进度
  const bs = batchState?.state;
  if (bs && bs.queue && bs.queue.length > 0) {
    $('batchStatus').classList.remove('hidden');
    $('batchStatus').textContent = `批量进行中：剩余 ${bs.queue.length}，正在处理第 ${bs.currentIndex + 1}/${bs.total}`;
  }

  // 订单列表
  const orderList = $('orderList');
  orderList.innerHTML = '';
  $('noOrders').classList.toggle('hidden', orders.length > 0);
  for (const o of orders.slice(0, 10)) {
    const row = document.createElement('div');
    row.className = 'item';
    const badge = statusBadge(o.status);
    row.innerHTML = `
      <div class="name" title="${escapeHtml(o.productTitle || o.productUrl)}">${escapeHtml(o.productTitle || o.productUrl)}</div>
      <span class="meta">${timeAgo(o.createdAt)}</span>
      ${badge}
    `;
    orderList.appendChild(row);
  }

  // 轮询信息
  $('checkInfo').textContent = settings.shippingCheckEnabled
    ? `每 ${settings.shippingCheckIntervalMinutes} 分钟自动检查`
    : '自动检查已关闭';
}

function statusBadge(status) {
  const map = {
    awaiting_payment: ['pending', '待支付'],
    paid: ['paid', '已支付'],
    shipped: ['shipped', '已发货'],
    canceled: ['', '已取消']
  };
  const [cls, text] = map[status] || ['', status || '未知'];
  return `<span class="badge ${cls}">${text}</span>`;
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const h = Math.floor(diff / 3600000);
  if (h < 1) return '刚刚';
  if (h < 24) return `${h}小时前`;
  return `${Math.floor(h / 24)}天前`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

async function startSingle(p, row) {
  const btn = row.querySelector('button');
  btn.disabled = true;
  btn.textContent = '启动中';
  if (!p.url || !p.url.startsWith('http')) {
    alert('商品链接为空或格式不对：\n' + (p.url || '(空)'));
    btn.disabled = false; btn.textContent = '下单'; return;
  }
  try {
    const r = await chrome.runtime.sendMessage({ type: 'placeOrder', product: p });
    if (!r?.ok) {
      alert('下单失败：' + (r?.error || '后台无响应'));
      btn.disabled = false; btn.textContent = '下单';
    } else {
      window.close();
    }
  } catch (err) {
    alert('后台通信失败：' + (err?.message || err));
    btn.disabled = false; btn.textContent = '下单';
  }
}

function updateBatchButton() {
  const btn = $('batchOrder');
  btn.textContent = `批量下单 (${selectedIds.size})`;
  btn.disabled = selectedIds.size === 0;
}

$('selectAll').addEventListener('click', async () => {
  const products = await getProducts();
  if (selectedIds.size === products.length) {
    selectedIds.clear();
  } else {
    products.forEach(p => selectedIds.add(p.id));
  }
  render();
});

$('batchOrder').addEventListener('click', async () => {
  if (selectedIds.size === 0) return;
  const products = await getProducts();
  const list = products.filter(p => selectedIds.has(p.id));
  const bad = list.find(p => !p.url || !p.url.startsWith('http'));
  if (bad) {
    alert('商品"' + (bad.title || bad.url) + '"链接无效');
    return;
  }
  const btn = $('batchOrder');
  btn.disabled = true;
  btn.textContent = '启动批量...';
  const r = await chrome.runtime.sendMessage({ type: 'batchOrder', products: list });
  if (!r?.ok) {
    alert('启动批量失败：' + (r?.error || '未知'));
    btn.disabled = false;
    updateBatchButton();
  } else {
    window.close();
  }
});

$('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

$('checkNow').addEventListener('click', async () => {
  $('checkNow').disabled = true;
  await chrome.runtime.sendMessage({ type: 'triggerShippingCheckNow' });
  setTimeout(() => window.close(), 500);
});

render();
