// Serialized by Playwright: keep every dependency inside this function.
export function probeLayout({ surface, rules, inspect = false } = {}) {
  const checks = [], diagnostics = [];
  const sources = {
    'UI-LAYOUT-CANVAS': ['browser-extension/entrypoints/workspace/results.css', 'browser-extension/entrypoints/workspace/canvas-workspace.css', 'browser-extension/entrypoints/popup/App.tsx'],
    'UI-LAYOUT-QUICK': ['browser-extension/entrypoints/popup/compact-editor.css', 'browser-extension/entrypoints/popup/QuickWorkspace.tsx'],
    'UI-IMAGE-PREVIEW': ['browser-extension/entrypoints/popup/image-preview.css', 'browser-extension/entrypoints/popup/ImagePreview.tsx'],
  };
  const app = document.querySelector(surface === 'workspace' ? '.app.workspace-app' : '.app:not(.workspace-app)');
  const q = selector => app?.querySelector(selector);
  const near = (a, b) => Math.abs(a - b) <= 1;
  const px = value => parseFloat(value) || 0;
  const rect = node => {
    const box = node.getBoundingClientRect();
    return Object.fromEntries(['x', 'y', 'width', 'height', 'top', 'right', 'bottom', 'left'].map(key => [key, Math.round(box[key] * 100) / 100]));
  };
  const name = node => `${node.tagName.toLowerCase()}${[...node.classList].slice(0, 4).map(value => `.${value}`).join('')}`;
  const visible = node => {
    if (!node?.getClientRects().length) return false;
    let { left, right, top, bottom } = node.getBoundingClientRect();
    if (right <= left || bottom <= top) return false;
    for (let item = node; item; item = item.parentElement) {
      const css = getComputedStyle(item);
      if (item.hidden || css.display === 'none' || css.visibility === 'hidden' || css.visibility === 'collapse' || Number(css.opacity) === 0) return false;
      if (item === node || css.display === 'contents') continue;
      const box = item.getBoundingClientRect(), x = box.left + item.clientLeft, y = box.top + item.clientTop;
      if (/^(hidden|clip)$/.test(css.overflowX)) { left = Math.max(left, x); right = Math.min(right, x + item.clientWidth); }
      // Scrollable content can be brought into view; test its scrollport against outer clips.
      else if (/^(auto|scroll)$/.test(css.overflowX) && item.scrollWidth > item.clientWidth + 1) { left = x; right = x + item.clientWidth; }
      if (/^(hidden|clip)$/.test(css.overflowY)) { top = Math.max(top, y); bottom = Math.min(bottom, y + item.clientHeight); }
      else if (/^(auto|scroll)$/.test(css.overflowY) && item.scrollHeight > item.clientHeight + 1) { top = y; bottom = y + item.clientHeight; }
      if (right <= left || bottom <= top) return false;
    }
    return true;
  };
  const record = (ruleId, status, target, expected, actual, message, node) => {
    checks.push({ ruleId, status, target, expected, actual, sourceFiles: sources[ruleId] || [], message });
    if ((status !== 'failed' && !inspect) || diagnostics.length >= 16) return;
    for (const root of Array.isArray(node) ? node : [node]) {
      if (diagnostics.length >= 16) break;
      const ancestors = [];
      for (let item = root, depth = 0; item && depth < 5; item = item.parentElement, depth++) {
        const css = getComputedStyle(item), box = rect(item);
        ancestors.push({ target: name(item), rect: box, computedStyle: Object.fromEntries([
          'display', 'position', 'boxSizing', 'width', 'height', 'minWidth', 'minHeight', 'padding', 'margin',
          'borderWidth', 'gap', 'gridTemplateColumns', 'gridTemplateRows', 'overflowX', 'overflowY', 'visibility', 'transform', 'objectFit', 'objectPosition',
        ].map(key => [key, css[key]])), scroll: { clientWidth: item.clientWidth, clientHeight: item.clientHeight, scrollWidth: item.scrollWidth, scrollHeight: item.scrollHeight },
        clipping: { x: /hidden|clip|auto|scroll/.test(css.overflowX) && item.scrollWidth > item.clientWidth + 1, y: /hidden|clip|auto|scroll/.test(css.overflowY) && item.scrollHeight > item.clientHeight + 1 } });
      }
      diagnostics.push({ ruleId, target, ...(Array.isArray(node) && { measuredTarget: name(root) }), sourceCandidates: sources[ruleId] || [], note: 'Source candidates and measured ancestors are diagnostic evidence, not a root-cause attribution.', ancestors });
    }
  };
  const assert = (id, ok, target, expected, actual, message, node) => record(id, ok ? 'passed' : 'failed', target, expected, actual, message, node);
  const required = (id, selector) => {
    const node = q(selector);
    if (!node) record(id, 'failed', selector, 'target present', null, 'Expected target is missing.', app);
    return node;
  };
  const skip = (id, target, message) => record(id, 'skipped', target, null, null, message);
  for (const id of rules || Object.keys(sources)) {
    if (!sources[id]) { record(id, 'failed', 'rule', 'known rule ID', id, 'Unknown geometry rule.'); continue; }
    if (surface !== 'workspace' && surface !== 'popup') { record(id, 'failed', 'surface', 'workspace or popup', surface ?? null, 'Unsupported surface.'); continue; }
    if ((id === 'UI-LAYOUT-CANVAS' && surface !== 'workspace') || (id === 'UI-LAYOUT-QUICK' && surface !== 'popup')) { skip(id, surface, 'Rule belongs to the other surface.'); continue; }
    if (!app) { record(id, 'failed', surface === 'workspace' ? '.app.workspace-app' : '.app:not(.workspace-app)', 'app root present', null, 'Expected app root is missing.'); continue; }
    if (id === 'UI-LAYOUT-CANVAS') {
      if (q('.gallery-main') || q('.workspace-body[data-history="true"]') || q('main > .empty')) { skip(id, '.workspace-body', 'Gallery, project library or explicit new-project empty state has no dual canvas.'); continue; }
      const body = required(id, '.workspace-body'), editor = required(id, '.workspace-editor'), result = required(id, '.workspace-results');
      if (!body || !editor || !result) continue;
      const state = body.getAttribute('data-results-open');
      if (state !== 'true' && state !== 'false') { record(id, 'failed', '.workspace-body', 'explicit data-results-open true/false', state, 'Drawer state is missing.', body); continue; }
      const open = state === 'true';
      if (matchMedia('(max-width:650px)').matches) {
        const active = open ? result : editor, closed = open ? editor : result;
        assert(id, closed.inert && !active.inert, 'narrow drawer sides', { closedInert: true, activeInert: false }, { closedInert: closed.inert, activeInert: active.inert }, 'Narrow view must isolate the closed side.', closed);
        const box = rect(active), area = rect(body), css = getComputedStyle(body);
        const left = area.left + px(css.borderLeftWidth) + px(css.paddingLeft), right = area.right - px(css.borderRightWidth) - px(css.paddingRight);
        assert(id, visible(active) && box.height > 0 && near(box.left, left) && near(box.right, right) && active.scrollWidth <= active.clientWidth + 1,
          name(active), { left, right, visible: true, horizontalOverflow: false }, { rect: box, visible: visible(active), clientWidth: active.clientWidth, scrollWidth: active.scrollWidth }, 'Active narrow region must fill its workspace without horizontal overflow.', active);
        for (const selector of open ? ['.workspace-results .result-toolbar', '.workspace-results .preview-canvas', '.workspace-results .result-history'] : ['.canvas-label', '.canvas-large', '.canvas-filmstrip']) {
          const node = required(id, selector);
          if (node) { const bounds = rect(node); assert(id, visible(node) && bounds.width > 0 && bounds.height > 0 && bounds.left >= left - 1 && bounds.right <= right + 1, selector, 'visible non-empty track within active region', bounds, 'Check active narrow track geometry.', node); }
        }
        continue;
      }
      if (!open) {
        const input = ['.canvas-label', '.canvas-large', '.canvas-filmstrip'].map(selector => required(id, selector));
        if (input.every(Boolean)) skip(id, '.workspace-body[data-results-open="false"]', 'Closed drawer has no dual-column alignment to compare.');
        continue;
      }
      for (const [leftSelector, rightSelector] of [['.canvas-label', '.workspace-results .result-toolbar'], ['.canvas-large', '.workspace-results .preview-canvas'], ['.canvas-filmstrip', '.workspace-results .result-history']]) {
        const left = required(id, leftSelector), right = required(id, rightSelector);
        if (!left || !right) continue;
        const a = rect(left), b = rect(right);
        assert(id, visible(left) && visible(right) && a.width > 0 && a.height > 0 && b.height > 0 && near(a.width, b.width) && near(a.top, b.top) && near(a.bottom, b.bottom),
          `${leftSelector} ↔ ${rightSelector}`, 'equal width and top/bottom baselines within 1 CSS px', { input: a, result: b }, 'Compare shared label, canvas and filmstrip tracks.', [left, right]);
      }
    }
    if (id === 'UI-LAYOUT-QUICK') {
      const quick = required(id, '.quick-workspace');
      if (!quick) continue;
      for (const [selector, height] of [['.quick-canvas', 180], ['.quick-filmstrip', 36]]) {
        if (selector === '.quick-filmstrip' && !q(selector) && q('.quick-heading h1')?.textContent === '选择参考图' && q('.quick-canvas > .quick-upload') && !q('.quick-canvas img')) { skip(id, selector, 'Explicit select-reference upload state has no filmstrip.'); continue; }
        const node = required(id, selector);
        if (node) { const box = rect(node); assert(id, visible(node) && box.width > 0 && near(box.height, height), selector, { height, tolerance: 1 }, box, 'Check fixed quick-workspace track height.', node); }
      }
    }
    if (id === 'UI-IMAGE-PREVIEW') {
      const frames = [...app.querySelectorAll('.image-preview')].filter(visible);
      const loose = [...app.querySelectorAll('.canvas-large img, .quick-canvas img, .preview-canvas img')].filter(img => visible(img) && !img.closest('.image-preview') && !img.closest('.generation-effect'));
      for (const img of loose) record(id, 'failed', name(img), 'ImagePreview wrapper', 'unwrapped image', 'Previewable canvas image bypasses the shared preview component.', img);
      if (!frames.length && !loose.length) {
        if (q('.loading-placeholder, .quick-upload, .canvas-upload, .empty-canvas, .empty, .gallery-main, .workspace-body[data-history="true"]')) skip(id, '.image-preview', 'Explicit empty, loading, gallery or library state has no visible preview image.');
        else record(id, 'failed', '.image-preview', 'visible preview target or explicit non-image state', null, 'Expected preview targets are missing.', app);
      }
      frames.forEach((frame, index) => {
        const target = `.image-preview[${index}]`, img = frame.querySelector('img'), button = frame.querySelector('.image-preview-trigger');
        if (!img) { record(id, 'failed', target, 'image element present', null, 'Preview image element is missing.', frame); return; }
        if (!img.complete || !img.naturalWidth || !img.naturalHeight) { assert(id, !visible(button), target, 'button hidden while image unavailable', { imageReady: false, buttonVisible: visible(button) }, 'Unavailable images must not expose a preview button.', frame); return; }
        if (!visible(button)) { record(id, 'failed', target, 'visible preview button', null, 'Loaded preview image is missing its visible button.', frame); return; }
        const css = getComputedStyle(img), imageBox = rect(img), buttonBox = rect(button);
        const width = img.clientWidth - px(css.paddingLeft) - px(css.paddingRight), height = img.clientHeight - px(css.paddingTop) - px(css.paddingBottom);
        const contained = css.objectFit === 'contain' || css.objectFit === 'scale-down';
        const scale = Math.min(width / img.naturalWidth, height / img.naturalHeight, css.objectFit === 'scale-down' ? 1 : Infinity);
        const drawnWidth = contained ? img.naturalWidth * scale : width, drawnHeight = contained ? img.naturalHeight * scale : height;
        const right = imageBox.left + img.clientLeft + px(css.paddingLeft) + (width + drawnWidth) / 2;
        const bottom = imageBox.top + img.clientTop + px(css.paddingTop) + (height + drawnHeight) / 2;
        const actual = { width: buttonBox.width, height: buttonBox.height, rightInset: right - buttonBox.right, bottomInset: bottom - buttonBox.bottom, objectFit: css.objectFit, objectPosition: css.objectPosition };
        assert(id, contained && near(actual.width, 34) && near(actual.height, 34) && near(actual.rightInset, 4) && near(actual.bottomInset, 4) && css.objectPosition === '50% 50%',
          target, { width: 34, height: 34, rightInset: 4, bottomInset: 4, objectFit: 'contain or scale-down', objectPosition: '50% 50%', tolerance: 1 }, actual, 'Measure button against the centered visible image, including contain letterboxing.', button);
      });
    }
  }
  return { checks, diagnostics };
}
