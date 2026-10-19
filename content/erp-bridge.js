// ERP 页面桥接 content script
// 职责：监听 ERP 页面发出的 window.postMessage，与 service worker 通信，再把结果回传给 ERP 页面
// 协议定义：fe-erp 项目 src/types/pdd-order.ts

(function () {
  const BRIDGE_SOURCE = 'erp-pdd-bridge'

  function reply(data) {
    window.postMessage({ source: BRIDGE_SOURCE, ...data }, window.location.origin)
  }

  // 收到 service worker 转发的完成/失败消息，推回给 ERP 页面
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.target !== 'erp-bridge') return
    if (msg.type === 'erpOrderProgress') {
      reply({ requestId: msg.requestId, type: 'PROGRESS', status: msg.status })
    } else if (msg.type === 'erpOrderDone') {
      reply({
        requestId: msg.requestId,
        type: 'DONE',
        status: msg.status || 'awaiting_payment',
        pddOrderNo: msg.pddOrderNo,
      })
    } else if (msg.type === 'erpOrderFailed') {
      reply({ requestId: msg.requestId, type: 'FAILED', reason: msg.reason })
    }
    sendResponse?.({ ok: true })
  })

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return
    const data = event.data
    if (!data || data.source !== BRIDGE_SOURCE) return
    if (typeof data.requestId !== 'string') return
    // 只处理 ERP → 插件 方向，防止自己回传的消息被再次拾取
    if (!['PING', 'PLACE_ORDER', 'CANCEL'].includes(data.type)) return

    if (data.type === 'PING') {
      reply({ requestId: data.requestId, type: 'PONG' })
      return
    }

    if (data.type === 'PLACE_ORDER') {
      try {
        const res = await chrome.runtime.sendMessage({
          type: 'erpPlaceOrder',
          requestId: data.requestId,
          payload: data.payload,
        })
        if (!res?.ok) {
          reply({
            requestId: data.requestId,
            type: 'FAILED',
            reason: res?.error || '插件接收任务失败',
          })
        }
      } catch (err) {
        reply({
          requestId: data.requestId,
          type: 'FAILED',
          reason: err?.message || '插件通信失败',
        })
      }
    }
  })

  console.log('[PDD] erp-bridge content script loaded on', window.location.href)
})()
