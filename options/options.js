import {
  getProducts, saveProducts,
  getSettings, saveSettings, DEFAULT_SETTINGS
} from '../lib/storage.js';

const $ = (id) => document.getElementById(id);

let products = [];

async function init() {
  products = await getProducts();
  renderProducts();

  const s = await getSettings();
  $('shippingEnabled').checked = s.shippingCheckEnabled;
  $('shippingInterval').value = s.shippingCheckIntervalMinutes;
  $('delayMin').value = s.humanize.clickDelayMin;
  $('delayMax').value = s.humanize.clickDelayMax;
  $('pageWaitTimeout').value = s.humanize.pageWaitTimeout;
  $('stopBeforePay').checked = s.stopBeforePay !== false;
  $('batchDelaySec').value = s.batchDelaySec || 8;
}

function renderProducts() {
  const tbody = $('productsTable').querySelector('tbody');
  tbody.innerHTML = '';
  products.forEach((p, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="text" data-k="title" value="${escape(p.title || '')}" placeholder="自己看的名字"></td>
      <td><input type="text" data-k="url" value="${escape(p.url || '')}" placeholder="https://mobile.yangkeduo.com/goods.html?..."></td>
      <td><input type="text" data-k="spec" value="${escape(p.spec || '')}" placeholder="如：黑色 XL"></td>
      <td><input type="number" data-k="quantity" value="${p.quantity || 1}" min="1"></td>
      <td><input type="text" data-k="addressKey" value="${escape(p.addressKey || '')}" placeholder="如：家 / 丁泓伊"></td>
      <td class="del"><button class="btn-icon" title="删除">✕</button></td>
    `;
    tr.querySelectorAll('input').forEach(inp => {
      inp.addEventListener('input', (e) => {
        const k = e.target.dataset.k;
        if (k === 'quantity') products[i][k] = parseInt(e.target.value) || 1;
        else products[i][k] = e.target.value;
      });
    });
    tr.querySelector('.btn-icon').addEventListener('click', () => {
      products.splice(i, 1);
      renderProducts();
    });
    tbody.appendChild(tr);
  });
}

function escape(s) {
  return String(s ?? '').replace(/"/g, '&quot;');
}

$('addProduct').addEventListener('click', () => {
  products.push({
    id: 'p-' + Date.now(),
    title: '',
    url: '',
    spec: '',
    quantity: 1
  });
  renderProducts();
});

$('save').addEventListener('click', async () => {
  // 过滤掉空链接
  const valid = products.filter(p => p.url && p.url.trim());
  valid.forEach(p => { if (!p.id) p.id = 'p-' + Date.now() + Math.random().toString(36).slice(2, 6); });
  await saveProducts(valid);
  products = valid;
  renderProducts();

  const settings = {
    shippingCheckEnabled: $('shippingEnabled').checked,
    shippingCheckIntervalMinutes: Math.max(10, parseInt($('shippingInterval').value) || 120),
    humanize: {
      clickDelayMin: Math.max(0, parseInt($('delayMin').value) || 400),
      clickDelayMax: Math.max(0, parseInt($('delayMax').value) || 1500),
      pageWaitTimeout: Math.max(2000, parseInt($('pageWaitTimeout').value) || 15000)
    },
    stopBeforePay: $('stopBeforePay').checked,
    batchDelaySec: Math.max(2, parseInt($('batchDelaySec').value) || 8)
  };
  if (settings.humanize.clickDelayMax < settings.humanize.clickDelayMin) {
    settings.humanize.clickDelayMax = settings.humanize.clickDelayMin + 500;
  }
  await saveSettings(settings);
  await chrome.runtime.sendMessage({ type: 'rescheduleAlarm' });

  const status = $('saveStatus');
  status.textContent = '已保存 ✓';
  setTimeout(() => status.textContent = '', 2000);
});

init();
