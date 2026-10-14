// Lightweight wrapper over chrome.storage.local
// Shared by background / popup / options.

export const KEYS = {
  PRODUCTS: 'products',        // 用户预设的商品列表
  ORDERS: 'orders',            // 已下单的订单记录（含发货状态）
  SETTINGS: 'settings'         // 全局设置
};

export const DEFAULT_SETTINGS = {
  shippingCheckEnabled: true,
  shippingCheckIntervalMinutes: 120,
  humanize: {
    clickDelayMin: 400,
    clickDelayMax: 1500,
    pageWaitTimeout: 15000
  },
  stopBeforePay: true,
  batchDelaySec: 8                    // 批量下单时每个商品之间的冷却秒数
};

export async function getAll(key, fallback) {
  const r = await chrome.storage.local.get(key);
  return r[key] ?? fallback;
}

export async function setAll(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

export async function getProducts() {
  return await getAll(KEYS.PRODUCTS, []);
}

export async function saveProducts(list) {
  await setAll(KEYS.PRODUCTS, list);
}

export async function getOrders() {
  return await getAll(KEYS.ORDERS, []);
}

export async function saveOrders(list) {
  await setAll(KEYS.ORDERS, list);
}

export async function addOrder(order) {
  const list = await getOrders();
  list.unshift(order);
  // 只保留最近 100 条
  await saveOrders(list.slice(0, 100));
}

export async function updateOrder(orderId, patch) {
  const list = await getOrders();
  const idx = list.findIndex(o => o.id === orderId);
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...patch };
    await saveOrders(list);
  }
}

export async function getSettings() {
  const s = await getAll(KEYS.SETTINGS, {});
  return { ...DEFAULT_SETTINGS, ...s };
}

export async function saveSettings(settings) {
  await setAll(KEYS.SETTINGS, settings);
}
