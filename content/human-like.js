// 拟人化交互工具：随机延时、带轨迹的鼠标移动、人类节奏的点击
// 作为普通脚本注入，挂载在 window.__pddHuman 下

(function () {
  if (window.__pddHuman) return;

  const rand = (min, max) => Math.floor(min + Math.random() * (max - min));

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // 从 chrome.storage 读取拟人化参数（content script 可以访问 chrome.storage）
  async function getHumanConfig() {
    try {
      const r = await chrome.storage.local.get('settings');
      const h = r.settings?.humanize;
      return {
        clickDelayMin: h?.clickDelayMin ?? 400,
        clickDelayMax: h?.clickDelayMax ?? 1500,
        pageWaitTimeout: h?.pageWaitTimeout ?? 15000
      };
    } catch (_) {
      return { clickDelayMin: 400, clickDelayMax: 1500, pageWaitTimeout: 15000 };
    }
  }

  // 随机延时
  async function humanPause() {
    const cfg = await getHumanConfig();
    await sleep(rand(cfg.clickDelayMin, cfg.clickDelayMax));
  }

  // 等待某个选择器出现（支持多个备选选择器）
  async function waitFor(selectors, { timeout, text } = {}) {
    const cfg = await getHumanConfig();
    const limit = timeout ?? cfg.pageWaitTimeout;
    const list = Array.isArray(selectors) ? selectors : [selectors];
    const start = Date.now();
    while (Date.now() - start < limit) {
      for (const sel of list) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (!el || el.offsetParent === null) continue;
          if (text && !el.textContent.includes(text)) continue;
          return el;
        }
      }
      await sleep(200);
    }
    return null;
  }

  // 从 React fiber 里扒 onClick 回调（React 16/17/18 共用的 key 前缀）
  function getReactHandlers(el) {
    const propsKey = Object.keys(el).find(k => k.startsWith('__reactProps$'));
    if (propsKey) return el[propsKey] || null;
    // React 16 老版本
    const internalKey = Object.keys(el).find(k => k.startsWith('__reactInternalInstance$'));
    if (internalKey) {
      const fiber = el[internalKey];
      return fiber?.memoizedProps || fiber?.pendingProps || null;
    }
    return null;
  }

  function hasClickHandler(props) {
    return !!(props && (props.onClick || props.onClickCapture || props.onTouchEnd || props.onTap));
  }

  // 先往上找祖先，再往下遍历所有后代，返回第一个带 onClick 的 React 节点
  function findReactClickTarget(el, maxUp = 8) {
    // 1. 祖先链
    let cur = el;
    for (let i = 0; i < maxUp && cur; i++) {
      const p = getReactHandlers(cur);
      if (hasClickHandler(p)) return { el: cur, props: p, source: 'ancestor-' + i };
      cur = cur.parentElement;
    }
    // 2. 后代树（BFS，无深度限制）
    const queue = [el];
    while (queue.length) {
      const node = queue.shift();
      if (node !== el) {
        const p = getReactHandlers(node);
        if (p && hasClickHandler(p)) {
          return { el: node, props: p, source: 'descendant' };
        }
      }
      for (const child of node.children) queue.push(child);
    }
    return null;
  }

  // 直接调 React onClick（最后一道杀手锏）
  function invokeReactClick(el) {
    const hit = findReactClickTarget(el);
    if (!hit) return false;
    const r = hit.el.getBoundingClientRect();
    const fakeEvent = {
      type: 'click',
      target: hit.el,
      currentTarget: hit.el,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
      preventDefault: () => {},
      stopPropagation: () => {},
      nativeEvent: { type: 'click' }
    };
    try {
      const label = (hit.el.getAttribute('aria-label') || hit.el.textContent || '').trim().slice(0, 30);
      if (hit.props.onClick) {
        hit.props.onClick(fakeEvent);
        console.log(`[PDD] React onClick (${hit.source}) on <${hit.el.tagName.toLowerCase()}> "${label}"`);
        return true;
      }
      if (hit.props.onTouchEnd) {
        hit.props.onTouchEnd({ ...fakeEvent, type: 'touchend' });
        console.log(`[PDD] React onTouchEnd (${hit.source}) on <${hit.el.tagName.toLowerCase()}> "${label}"`);
        return true;
      }
    } catch (e) {
      console.warn('[PDD] React handler 调用抛错:', e);
    }
    return false;
  }

  // 构造 TouchEvent（有些浏览器不支持 Touch 构造函数，需降级）
  function makeTouchEvent(type, el, x, y) {
    try {
      const touch = new Touch({
        identifier: 1, target: el,
        clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y,
        radiusX: 1, radiusY: 1, rotationAngle: 0, force: 0.5
      });
      const touches = (type === 'touchend' || type === 'touchcancel') ? [] : [touch];
      return new TouchEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        touches, targetTouches: touches, changedTouches: [touch]
      });
    } catch (_) {
      return null;
    }
  }

  // 带轨迹的鼠标移动 + 完整触摸/指针/鼠标三合一点击
  async function humanClick(el) {
    if (!el) throw new Error('humanClick: target is null');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await sleep(rand(200, 500));

    const rect = el.getBoundingClientRect();
    const targetX = rect.left + rect.width / 2 + rand(-5, 5);
    const targetY = rect.top + rect.height / 2 + rand(-3, 3);

    // 模拟从当前鼠标位置到目标的 N 步贝塞尔移动
    const steps = rand(6, 12);
    const startX = window.__pddHuman._lastX ?? rand(0, window.innerWidth);
    const startY = window.__pddHuman._lastY ?? rand(0, window.innerHeight);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
      const x = startX + (targetX - startX) * ease + rand(-2, 2);
      const y = startY + (targetY - startY) * ease + rand(-2, 2);
      el.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, cancelable: true, clientX: x, clientY: y
      }));
      await sleep(rand(10, 30));
    }
    window.__pddHuman._lastX = targetX;
    window.__pddHuman._lastY = targetY;

    const common = {
      bubbles: true, cancelable: true, composed: true,
      clientX: targetX, clientY: targetY,
      screenX: targetX, screenY: targetY,
      button: 0, buttons: 1
    };
    const pointerOpts = {
      ...common, pointerId: 1, pointerType: 'touch',
      width: 1, height: 1, pressure: 0.5, isPrimary: true
    };

    // 1. pointer / mouse over
    try { el.dispatchEvent(new PointerEvent('pointerover', pointerOpts)); } catch (_) {}
    el.dispatchEvent(new MouseEvent('mouseover', common));

    await sleep(rand(50, 150));

    // 2. 按下：pointer + touch + mouse
    try { el.dispatchEvent(new PointerEvent('pointerdown', pointerOpts)); } catch (_) {}
    const tStart = makeTouchEvent('touchstart', el, targetX, targetY);
    if (tStart) el.dispatchEvent(tStart);
    el.dispatchEvent(new MouseEvent('mousedown', { ...common, buttons: 1 }));

    await sleep(rand(40, 120));

    // 3. 抬起：pointer + touch + mouse + click
    try { el.dispatchEvent(new PointerEvent('pointerup', { ...pointerOpts, buttons: 0 })); } catch (_) {}
    const tEnd = makeTouchEvent('touchend', el, targetX, targetY);
    if (tEnd) el.dispatchEvent(tEnd);
    el.dispatchEvent(new MouseEvent('mouseup', { ...common, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', common));

    // 4. 原生 click 兜底
    try { el.click(); } catch (_) {}

    // 5. 终极兜底：直接调 React onClick
    invokeReactClick(el);

    await humanPause();
  }

  // 寻找包含指定文本的可点击元素（按钮类）
  function findByText(text, tagSelector = 'button, div, span, a') {
    const nodes = document.querySelectorAll(tagSelector);
    for (const n of nodes) {
      if (n.offsetParent === null) continue;
      const t = (n.textContent || '').trim();
      if (t === text || t.includes(text)) return n;
    }
    return null;
  }

  async function waitForText(text, tagSelector, timeout) {
    const cfg = await getHumanConfig();
    const limit = timeout ?? cfg.pageWaitTimeout;
    const start = Date.now();
    while (Date.now() - start < limit) {
      const el = findByText(text, tagSelector);
      if (el) return el;
      await sleep(200);
    }
    return null;
  }

  window.__pddHuman = {
    rand, sleep, humanPause, humanClick, waitFor, findByText, waitForText
  };
})();
