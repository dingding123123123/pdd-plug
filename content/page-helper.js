// 这个脚本在页面的 MAIN world 里跑（manifest 里 world:"MAIN"）
// 可以访问页面的 React 内部对象（__reactProps$XXX）
// 隔离世界的 order-flow.js 通过 window CustomEvent 向它发指令

(function () {
  if (window.__pddPageHelper) return;
  window.__pddPageHelper = true;

  const CMD = 'pdd:cmd';
  const RESP = 'pdd:resp';

  function getReactProps(el) {
    const k = Object.keys(el).find(x => x.startsWith('__reactProps$'));
    return k ? el[k] : null;
  }

  // 向上找带 handler 的 React 节点，再向下 BFS
  function findReactHandler(root, maxUp = 10) {
    let cur = root;
    for (let i = 0; i < maxUp && cur; i++) {
      const p = getReactProps(cur);
      if (p && (p.onClick || p.onTouchEnd)) return { el: cur, props: p, src: 'up-' + i };
      cur = cur.parentElement;
    }
    const queue = [root];
    while (queue.length) {
      const n = queue.shift();
      if (n !== root) {
        const p = getReactProps(n);
        if (p && (p.onClick || p.onTouchEnd)) return { el: n, props: p, src: 'down' };
      }
      for (const c of n.children) queue.push(c);
    }
    return null;
  }

  function makeFakeEvent(el, type = 'click') {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    return {
      type,
      target: el,
      currentTarget: el,
      clientX: cx, clientY: cy,
      pageX: cx, pageY: cy,
      screenX: cx, screenY: cy,
      touches: [{ clientX: cx, clientY: cy, pageX: cx, pageY: cy, identifier: 1 }],
      changedTouches: [{ clientX: cx, clientY: cy, pageX: cx, pageY: cy, identifier: 1 }],
      targetTouches: [{ clientX: cx, clientY: cy, pageX: cx, pageY: cy, identifier: 1 }],
      button: 0, buttons: 1,
      preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {},
      persist() {},
      isPropagationStopped: () => false,
      isDefaultPrevented: () => false,
      nativeEvent: { type, isTrusted: false },
      bubbles: true, cancelable: true
    };
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // 派发真实 DOM 事件（冒泡），走 React 17+ 根容器事件代理
  // 关键：事件之间要有真实时间间隔，React 才能按顺序 flush state
  async function dispatchNativeClick(el) {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    await sleep(50);

    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const common = {
      bubbles: true, cancelable: true, composed: true,
      clientX: cx, clientY: cy, screenX: cx, screenY: cy,
      pageX: cx, pageY: cy,
      button: 0, buttons: 1,
      view: window
    };

    // 1. pointerdown
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', {
        ...common, pointerId: 1, pointerType: 'touch', width: 1, height: 1,
        pressure: 0.5, isPrimary: true
      }));
    } catch (_) {}

    // 2. touchstart
    let touch = null;
    try {
      if (typeof TouchEvent !== 'undefined' && typeof Touch !== 'undefined') {
        touch = new Touch({
          identifier: 1, target: el,
          clientX: cx, clientY: cy, pageX: cx, pageY: cy,
          screenX: cx, screenY: cy,
          radiusX: 2, radiusY: 2, rotationAngle: 0, force: 0.5
        });
        el.dispatchEvent(new TouchEvent('touchstart', {
          bubbles: true, cancelable: true, composed: true,
          touches: [touch], targetTouches: [touch], changedTouches: [touch]
        }));
      }
    } catch (_) {}

    // 真人手指按下到松开大约 60-120ms，PDD 可能有 tap 判定逻辑
    await sleep(80);

    // 3. touchend
    try {
      if (touch) {
        el.dispatchEvent(new TouchEvent('touchend', {
          bubbles: true, cancelable: true, composed: true,
          touches: [], targetTouches: [], changedTouches: [touch]
        }));
      }
    } catch (_) {}

    // 4. pointerup
    try {
      el.dispatchEvent(new PointerEvent('pointerup', {
        ...common, pointerId: 1, pointerType: 'touch', buttons: 0
      }));
    } catch (_) {}

    // 5. mouse 事件 + click
    el.dispatchEvent(new MouseEvent('mousedown', common));
    el.dispatchEvent(new MouseEvent('mouseup', { ...common, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...common, buttons: 0 }));

    // 6. 原生 click 兜底
    try { el.click(); } catch (_) {}
  }

  // 列出整条祖先链上每个 React 节点的 handler 字段名，便于诊断
  function dumpAncestorHandlers(el, depth = 10) {
    const out = [];
    let cur = el;
    for (let i = 0; i < depth && cur; i++) {
      const p = getReactProps(cur);
      if (p) {
        const handlers = Object.keys(p).filter(k => /^on[A-Z]/.test(k));
        if (handlers.length) {
          out.push(`[${i}] <${cur.tagName.toLowerCase()}.${(cur.className||'').toString().slice(0,20)}> ${handlers.join(',')}`);
        }
      }
      cur = cur.parentElement;
    }
    return out;
  }

  // 策略：从 el 自身开始往上找，调所有带 handler 的节点的 onClick/onTouchEnd
  // 关键改进：之前只调第一个找到 handler 的节点；现在尝试把事件派给祖先链上所有节点
  // 原因：PDD 规格 state 可能在父组件（通过 Context）管理，直接子节点 onClick 可能只做视觉态
  async function reactClick(el) {
    const invokedList = [];
    const ancestry = dumpAncestorHandlers(el);
    console.log('[PDD-main] 祖先 handler 链:', ancestry.join(' | '));

    // 调用祖先链上第一个带 onClick 的节点
    const hit = findReactHandler(el);

    if (hit) {
      const p = hit.props;
      try {
        // 核心修复：PDD 的 onClick 是 toggle 逻辑，调多个 handler 会把状态切回来
        // 优先级：onClick > onTouchEnd > onPointerUp。只调一个！
        if (p.onClick) {
          p.onClick(makeFakeEvent(hit.el, 'click'));
          invokedList.push('click');
        } else if (p.onTouchEnd) {
          p.onTouchEnd(makeFakeEvent(hit.el, 'touchend'));
          invokedList.push('tend');
        } else if (p.onPointerUp) {
          p.onPointerUp(makeFakeEvent(hit.el, 'pointerup'));
          invokedList.push('ptup');
        }
      } catch (e) {
        console.warn('[PDD-main] React handler 异常:', e);
      }
      return {
        ok: true,
        src: hit.src,
        tag: hit.el.tagName,
        cls: (hit.el.className || '').toString().slice(0, 40),
        text: (hit.el.textContent || '').trim().slice(0, 30),
        invoked: invokedList.join(',') || 'none',
        ancestry
      };
    }

    // 兜底：找不到 React handler 时派发原生事件
    try { await dispatchNativeClick(el); }
    catch (e) { console.warn('[PDD-main] dispatchNativeClick 异常:', e); }
    return {
      ok: true,
      src: 'native-fallback',
      tag: el.tagName,
      cls: (el.className || '').toString().slice(0, 40),
      text: (el.textContent || '').trim().slice(0, 30),
      invoked: 'native',
      ancestry
    };
  }

  // 节点自身或任意后代是否带 React handler
  function hasReactHandlerAnywhere(el) {
    const stack = [el];
    while (stack.length) {
      const n = stack.pop();
      const p = getReactProps(n);
      if (p && (p.onClick || p.onTouchEnd || p.onPointerDown)) return true;
      for (const c of n.children) stack.push(c);
    }
    return false;
  }

  // 通用：扫视口里文本匹配正则 + 底部位置的按钮
  // 排序优先级：元素自身带 handler > 后代带 handler > （同级）面积小的（更具体）
  function findBottomReactButton(textRegex, bottomRatio = 0.45) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const matches = [];
    for (const n of document.querySelectorAll('[role="button"], button, div, span, a')) {
      const r = n.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cx < 0 || cx > vw || cy < vh * (1 - bottomRatio) || cy > vh) continue;
      if (r.width < 40 || r.height < 20 || r.width > vw + 10) continue;
      const t = (n.textContent || '').trim();
      if (!t || t.length > 25) continue;        // 不要选"更多收藏客服...发起拼单"这种整个 bar 的文本
      if (!textRegex.test(t)) continue;
      const ownProps = getReactProps(n);
      const hasOwnHandler = !!(ownProps && (ownProps.onClick || ownProps.onTouchEnd || ownProps.onPointerDown));
      matches.push({
        el: n, area: r.width * r.height, rect: r, text: t,
        hasOwnHandler,
        hasAnyHandler: hasOwnHandler || hasReactHandlerAnywhere(n)
      });
    }
    matches.sort((a, b) => {
      if (a.hasOwnHandler !== b.hasOwnHandler) return b.hasOwnHandler - a.hasOwnHandler;
      if (a.hasAnyHandler !== b.hasAnyHandler) return b.hasAnyHandler - a.hasAnyHandler;
      return a.area - b.area;                   // 同级：面积小的（更具体的元素）
    });
    if (matches.length) {
      console.log(`[PDD-main] findBottomReactButton 共 ${matches.length} 个候选，选中:`,
        `[${Math.round(matches[0].rect.left)},${Math.round(matches[0].rect.top)}] ${Math.round(matches[0].rect.width)}x${Math.round(matches[0].rect.height)}`,
        `"${matches[0].text}" ownHandler=${matches[0].hasOwnHandler}`);
    }
    return matches[0] || null;
  }

  function findBottomBuy() {
    return findBottomReactButton(/发起拼单|立即购买|单独购买|立即开团|一键开团|马上抢|立即抢购/, 0.45);
  }

  function findBottomSubmit() {
    return findBottomReactButton(/立即支付|提交订单|确认支付|去支付|提交并支付|微信支付/, 0.3);
  }

  // 结算页顶部的地址栏（包含收件人+手机+详细地址）
  function findAddressBar() {
    const vh = window.innerHeight;
    const PHONE_RE = /\d{3}\*{3,}\d{3,}|1\d{10}/;
    const AREA_RE = /[省市区县]/;
    for (const n of document.querySelectorAll('[role="button"], div')) {
      const r = n.getBoundingClientRect();
      if (r.top > vh * 0.35 || r.top < 0) continue;    // 必在页面顶部
      if (r.width < 200 || r.height < 40 || r.height > 200) continue;
      const t = (n.textContent || '').trim();
      if (!t || t.length < 10 || t.length > 200) continue;
      if (!PHONE_RE.test(t) && !AREA_RE.test(t)) continue;
      const p = getReactProps(n);
      if (!p || !(p.onClick || p.onTouchEnd)) continue;
      return { el: n, text: t };
    }
    return null;
  }

  // 当前地址栏文本是否包含关键词（如果包含就说明已经是对的，无需切换）
  function currentAddressMatches(key) {
    const bar = findAddressBar();
    if (!bar) return false;
    return bar.text.includes(key);
  }

  // 地址列表 sheet：找 dialog/sheet 里包含关键词的那条地址
  async function selectAddressByKey(key) {
    // 1. 如果当前地址已经匹配，直接跳过
    if (currentAddressMatches(key)) {
      return { ok: true, matched: 'current', skipped: true };
    }
    // 2. 找地址栏点开
    const bar = findAddressBar();
    if (!bar) return { ok: false, reason: '页面上没找到地址栏' };
    const barClick = await reactClick(bar.el);
    if (!barClick.ok) return { ok: false, reason: '地址栏不可点: ' + barClick.reason };

    // 3. 等地址列表 sheet 出现（新的 dialog 或列表容器）
    const sheet = await new Promise(resolve => {
      const start = Date.now();
      const timer = setInterval(() => {
        // 新出现的 role=dialog，或任何位置:fixed 的大容器
        const dialogs = document.querySelectorAll('[role="dialog"]');
        for (const d of dialogs) {
          const r = d.getBoundingClientRect();
          if (r.height > 150 && (d.textContent || '').match(/[省市区县]/)) {
            clearInterval(timer); return resolve(d);
          }
        }
        if (Date.now() - start > 3000) {
          clearInterval(timer); resolve(null);
        }
      }, 150);
    });
    if (!sheet) return { ok: false, reason: '地址列表 sheet 未弹出' };

    // 4. 找 sheet 里包含关键词 + 带 React handler 的地址行
    const rows = Array.from(sheet.querySelectorAll('[role="button"], div, li'));
    const matches = [];
    for (const n of rows) {
      const t = (n.textContent || '').trim();
      if (!t || t.length < 10 || t.length > 300) continue;
      if (!t.includes(key)) continue;
      if (!(/[省市区县]/.test(t) || /\d{3}\*{3,}\d{3,}|1\d{10}/.test(t))) continue;
      const p = getReactProps(n);
      if (!p || !(p.onClick || p.onTouchEnd)) continue;
      const r = n.getBoundingClientRect();
      matches.push({ el: n, text: t.slice(0, 60), area: r.width * r.height });
    }
    // 挑最小面积的（通常是单条地址行而非它的父容器）
    matches.sort((a, b) => a.area - b.area);
    if (!matches.length) {
      const available = Array.from(sheet.querySelectorAll('[role="button"]'))
        .map(n => (n.textContent || '').trim().slice(0, 60))
        .filter(t => t.length > 10)
        .slice(0, 5);
      return { ok: false, reason: '地址列表里没匹配到 "' + key + '"', available };
    }
    const hit = matches[0];
    const click = await reactClick(hit.el);
    return click.ok ? { ok: true, matched: hit.text } : { ok: false, reason: '地址行点击失败: ' + click.reason };
  }

  // 标准化：去除空白、中英文括号/方括号差异，统一到小写
  function normText(s) {
    return (s || '')
      .replace(/[\s　]+/g, '')
      .replace(/[【\[\(（]/g, '')
      .replace(/[】\]\)）]/g, '')
      .replace(/[:：]/g, '')
      .toLowerCase();
  }

  // 面板里找按钮：标准化比较，兼容 【3袋】 vs 3袋 vs 【3袋】试吃 等各种写法
  function findInDialog(text) {
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]')
      || Array.from(document.querySelectorAll('[role="dialog"]')).find(d => d.getBoundingClientRect().height > 100);
    if (!dialog) return { dialog: null, el: null };

    const normTarget = normText(text);
    if (!normTarget) return { dialog, el: null };

    const all = Array.from(dialog.querySelectorAll('[role="button"], div, span, li, a, button'));
    const candidates = [];
    for (const n of all) {
      const al = normText(n.getAttribute('aria-label') || '');
      const t = normText(n.textContent || '');
      // 匹配等级（越高越好）：
      //   4 = aria-label 精确
      //   3 = text 精确
      //   2 = aria-label 包含 target
      //   1 = text 包含 target（text 不太长）
      let rank = -1;
      if (al && al === normTarget) rank = 4;
      else if (t === normTarget) rank = 3;
      else if (al && al.includes(normTarget)) rank = 2;
      else if (t.includes(normTarget) && t.length <= normTarget.length + 20) rank = 1;
      if (rank < 0) continue;
      const r = n.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      candidates.push({
        el: n, rank, area: r.width * r.height,
        hasHandler: hasReactHandlerAnywhere(n),
        label: (n.getAttribute('aria-label') || n.textContent || '').trim().slice(0, 40)
      });
    }
    // 排序：带 handler 优先 → rank 高优先 → 面积小优先
    candidates.sort((a, b) => (b.hasHandler - a.hasHandler) || (b.rank - a.rank) || (a.area - b.area));
    return { dialog, el: candidates[0]?.el || null, candidatesCount: candidates.length };
  }

  function listDialogSpecs() {
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
    if (!dialog) return [];
    return Array.from(dialog.querySelectorAll('[role="button"][aria-label]'))
      .map(b => b.getAttribute('aria-label'))
      .filter(l => l && l !== '确定' && l !== '关闭');
  }

  window.addEventListener(CMD, async (ev) => {
    const { id, action, params = {} } = ev.detail || {};
    let result;
    try {
      if (action === 'clickBottomBuy') {
        const found = findBottomBuy();
        if (!found) {
          result = { ok: false, reason: 'no bottom buy button with react handler' };
        } else {
          result = await reactClick(found.el);
          result.foundRect = {
            x: Math.round(found.rect.left), y: Math.round(found.rect.top),
            w: Math.round(found.rect.width), h: Math.round(found.rect.height)
          };
          result.foundText = found.text;
        }
      } else if (action === 'selectAddress') {
        result = await selectAddressByKey(params.key);
      } else if (action === 'getCurrentAddress') {
        const bar = findAddressBar();
        result = bar ? { ok: true, text: bar.text } : { ok: false, reason: '没找到地址栏' };
      } else if (action === 'clickBottomSubmit') {
        const found = findBottomSubmit();
        if (!found) {
          result = { ok: false, reason: 'no bottom submit button with react handler' };
        } else {
          result = await reactClick(found.el);
          result.foundRect = {
            x: Math.round(found.rect.left), y: Math.round(found.rect.top),
            w: Math.round(found.rect.width), h: Math.round(found.rect.height)
          };
          result.foundText = found.text;
        }
      } else if (action === 'clickInDialog') {
        const { text } = params;
        const { dialog, el, candidatesCount } = findInDialog(text);
        if (!dialog) {
          result = { ok: false, reason: 'no dialog' };
        } else if (!el) {
          result = {
            ok: false,
            reason: 'no match for text: ' + text,
            availableSpecs: listDialogSpecs(),
            // 另外列出面板里所有 role=button 的文本和 aria-label，方便 debug
            allButtons: Array.from(dialog.querySelectorAll('[role="button"], button'))
              .map(b => ({
                label: b.getAttribute('aria-label') || '',
                text: (b.textContent || '').trim().slice(0, 40)
              }))
              .filter(b => b.label || b.text)
              .slice(0, 20)
          };
        } else {
          result = await reactClick(el);
          result.foundLabel = el.getAttribute('aria-label') || el.textContent.trim();
          result.candidatesCount = candidatesCount;
        }
      } else if (action === 'listDialogSpecs') {
        result = { ok: true, specs: listDialogSpecs() };
      } else if (action === 'getDialogInfo') {
        const d = document.querySelector('[role="dialog"]');
        if (!d) result = { ok: true, exists: false };
        else {
          const r = d.getBoundingClientRect();
          result = {
            ok: true, exists: true,
            visible: r.height > 100,
            rect: { x: r.left, y: r.top, w: r.width, h: r.height },
            text: (d.textContent || '').slice(0, 200)
          };
        }
      } else {
        result = { ok: false, reason: 'unknown action: ' + action };
      }
    } catch (e) {
      result = { ok: false, reason: String(e?.message || e) };
    }
    window.dispatchEvent(new CustomEvent(RESP, { detail: { id, result } }));
  });

  console.log('[PDD-main] page-helper loaded in MAIN world');
})();
