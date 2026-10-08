const sourceFiles = ['ImageViewer.tsx', 'image-viewer.css', 'ImagePreview.tsx', 'image-preview.css'].map(file => `browser-extension/entrypoints/popup/${file}`);
const contains = (outer, inner) => inner.left >= outer.left - 1 && inner.top >= outer.top - 1 && inner.right <= outer.right + 1 && inner.bottom <= outer.bottom + 1;
const clipped = view => ['hidden', 'clip'].includes(view.overflowX) && ['hidden', 'clip'].includes(view.overflowY) && (!view.overflowX.includes('clip') && !view.overflowY.includes('clip') || view.clipMargin <= 1);
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

// Operates on an already-open production dialog. It leaves the dialog open and never applies a rotated input.
export async function checkImageViewer(page, capture) {
  const checks = [];
  const record = (ok, target, expected, actual, message) => checks.push({ ruleId: 'UI-IMAGE-VIEWPORT', status: ok ? 'passed' : 'failed', target, expected, actual, sourceFiles, message });
  const dialog = page.locator('.image-preview-dialog[open]');
  const stage = dialog.locator('.image-viewer-stage'), image = stage.locator('img');
  const measure = () => dialog.evaluate(node => {
    const stage = node.querySelector('.image-viewer-stage'), tools = node.querySelector('.image-viewer-tools'), image = stage?.querySelector('img');
    if (!stage || !tools || !image) throw new Error('Missing image viewport, image or zoom controls');
    const rect = element => {
      const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
      return { left, top, right, bottom, width, height };
    };
    const style = getComputedStyle(stage), toolStyle = getComputedStyle(tools), matrix = new DOMMatrixReadOnly(getComputedStyle(image).transform);
    return { dialog: rect(node), stage: rect(stage), tools: rect(tools), image: rect(image),
      naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight,
      scale: Math.hypot(matrix.a, matrix.b), x: matrix.e, y: matrix.f,
      overflowX: style.overflowX, overflowY: style.overflowY, clipMargin: parseFloat(style.overflowClipMargin) || 0,
      toolsPosition: toolStyle.position, toolsVisible: toolStyle.visibility === 'visible' && Number(toolStyle.opacity) > 0,
      separate: !stage.contains(tools), nativeModal: node.matches(':modal'),
    };
  });
  const fit = async () => {
    await dialog.getByRole('button', { name: '适应窗口', exact: true }).click();
    await settle(page);
    return measure();
  };
  const checkFit = (view, target) => record(Math.abs(view.scale - 1) < .001 && view.naturalWidth > 0 && view.naturalHeight > 0 && view.image.width > 0 && view.image.height > 0 && contains(view.stage, view.image), target,
    'At fit scale the complete image is inside the image viewport (1 CSS px tolerance)', view, 'Fit geometry measures the actual production image after decoding.');
  try {
    if (await dialog.count() !== 1) throw new Error('Expected exactly one open image preview dialog');
    await image.waitFor({ state: 'visible', timeout: 8000 });
    await image.evaluate(element => element.decode());
    let view = await fit();
    const layoutOK = value => value.nativeModal && value.stage.width > 40 && value.stage.height > 40 && value.tools.width > 0 && value.tools.height > 0 && value.toolsVisible && value.separate && !['absolute', 'fixed'].includes(value.toolsPosition) && value.stage.bottom <= value.tools.top + 1 && contains(value.dialog, value.stage) && contains(value.dialog, value.tools);
    record(layoutOK(view), '.image-viewer-stage / .image-viewer-tools', 'Usable viewport and a visible normal-flow toolbar in a separate lower row, both inside the dialog', view, 'The toolbar must reserve layout space instead of covering the poster.');
    checkFit(view, 'image fit');
    await capture?.('fit');

    const zoom = dialog.getByRole('button', { name: '放大图片', exact: true });
    for (let index = 0; index < 10 && await zoom.isEnabled(); index++) await zoom.click();
    await settle(page);
    const enlarged = await measure();
    const axes = { x: enlarged.image.width > enlarged.stage.width + 1, y: enlarged.image.height > enlarged.stage.height + 1 };
    record(enlarged.scale > 1 && (axes.x || axes.y) && clipped(enlarged) && layoutOK(enlarged), 'zoom clipping',
      'Zoomed image exceeds at least one viewport axis; that viewport clips both axes and remains separate from controls', { ...enlarged, overflowAxes: axes }, 'Computed clipping is checked together with actual overflow geometry.');

    const center = { x: enlarged.stage.left + enlarged.stage.width / 2, y: enlarged.stage.top + enlarged.stage.height / 2 };
    await page.mouse.move(center.x, center.y); await page.mouse.down();
    try { await page.mouse.move(center.x + Math.min(60, enlarged.stage.width / 4), center.y + Math.min(60, enlarged.stage.height / 4), { steps: 4 }); }
    finally { await page.mouse.up(); }
    await settle(page);
    const dragged = await measure();
    record((axes.x || axes.y) && (!axes.x || Math.abs(dragged.x - enlarged.x) > 1) && (!axes.y || Math.abs(dragged.y - enlarged.y) > 1) && clipped(dragged) && layoutOK(dragged), 'pointer pan',
      'Dragging moves every overflowing image axis while keeping the viewport clipped', { overflowAxes: axes, before: { x: enlarged.x, y: enlarged.y }, after: { x: dragged.x, y: dragged.y }, clipped: clipped(dragged) }, 'Actual pointer events exercise the production drag handlers.');
    await stage.focus();
    if (axes.x) await page.keyboard.press('ArrowRight');
    if (axes.y) await page.keyboard.press('ArrowDown');
    await settle(page);
    const panned = await measure();
    record((axes.x || axes.y) && (!axes.x || Math.abs(panned.x - dragged.x) > 1) && (!axes.y || Math.abs(panned.y - dragged.y) > 1) && clipped(panned) && layoutOK(panned), 'keyboard pan',
      'Arrow keys move every overflowing image axis within the clipped viewport', { overflowAxes: axes, before: { x: dragged.x, y: dragged.y }, after: { x: panned.x, y: panned.y }, clipped: clipped(panned) }, 'Keys reverse the preceding drag, avoiding a false failure at a pan limit.');

    const output = await dialog.locator('.image-viewer-tools output').boundingBox();
    if (!output) throw new Error('Missing visible zoom output for toolbar interaction');
    const point = { x: output.x + output.width / 2, y: output.y + output.height / 2 };
    await page.mouse.move(point.x, point.y); await page.mouse.wheel(0, 120); await settle(page);
    const wheeled = await measure();
    await page.mouse.down();
    try { await page.mouse.move(point.x + Math.min(8, output.width / 4), point.y + Math.min(5, output.height / 4), { steps: 3 }); }
    finally { await page.mouse.up(); }
    await settle(page);
    const toolbarDrag = await measure();
    const unchanged = value => Math.abs(value.scale - panned.scale) < .001 && Math.abs(value.x - panned.x) < 1 && Math.abs(value.y - panned.y) < 1;
    record(unchanged(wheeled) && unchanged(toolbarDrag), '.image-viewer-tools events', 'Wheel and pointer drag over the toolbar do not change the image transform',
      { before: { scale: panned.scale, x: panned.x, y: panned.y }, afterWheel: { scale: wheeled.scale, x: wheeled.x, y: wheeled.y }, afterDrag: { scale: toolbarDrag.scale, x: toolbarDrag.x, y: toolbarDrag.y } }, 'The toolbar is outside the production wheel/pointer event surface.');
    await capture?.('zoom-pan');
    view = await fit(); checkFit(view, 'fit after pan');

    const rotate = dialog.getByRole('button', { name: '右转 90°', exact: true, includeHidden: true });
    if (await rotate.count()) {
      if (!await rotate.isVisible() || !await rotate.isEnabled()) throw new Error('Input rotation control is hidden or disabled');
      const before = view, previousSource = await image.getAttribute('src');
      await rotate.click();
      await page.waitForFunction(previous => {
        const picture = document.querySelector('.image-preview-dialog[open] .image-viewer-stage img');
        return picture && picture.getAttribute('src') !== previous && picture.complete && picture.naturalWidth > 0;
      }, previousSource, { timeout: 10000 });
      await image.evaluate(element => element.decode());
      const rotated = await fit();
      const ratio = rotated.naturalWidth / rotated.naturalHeight, expectedRatio = before.naturalHeight / before.naturalWidth;
      record(Math.abs(ratio / expectedRatio - 1) < .01 && Math.abs(rotated.image.width / rotated.image.height / ratio - 1) < .01 && layoutOK(rotated), 'rotation aspect ratio',
        'After a production 90-degree rotation, the natural aspect ratio is inverted and displayed without distortion', { before: { width: before.naturalWidth, height: before.naturalHeight }, after: { width: rotated.naturalWidth, height: rotated.naturalHeight }, rendered: rotated.image }, 'Waits for the changed source to decode; it never applies or persists the rotation.');
      checkFit(rotated, 'fit after rotation');
      await capture?.('rotation-fit');
    } else checks.push({ ruleId: 'UI-IMAGE-VIEWPORT', status: 'skipped', target: 'rotation aspect ratio', expected: 'Input-only rotation controls', actual: { present: false }, sourceFiles, message: 'This read-only preview has no rotation controls; no input mutation is attempted.' });
  } catch (error) {
    record(false, '.image-preview-dialog', 'The production viewport and its interactions complete while the dialog remains open', { error: String(error.message).slice(0, 600) }, 'Image viewport verification could not complete.');
  }
  return checks;
}
