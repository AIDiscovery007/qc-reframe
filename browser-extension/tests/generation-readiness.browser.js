// Production App with synthetic health and task messages; never calls a real model.
const scenario = new URLSearchParams(location.search).get('generationReadinessRegression');
const requests = [], send = chrome.runtime.sendMessage;
chrome.runtime.sendMessage = message => { requests.push(structuredClone(message)); return send(message); };
const wait = async predicate => {
  const deadline = Date.now() + 6000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待生图就绪状态超时');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
const assert = (value, message) => { if (!value) throw new Error(message); };
const button = text => [...document.querySelectorAll('button')].find(node => node.textContent.trim() === text);
const generate = () => button('再生成图片') || button('生成图片');
const cancel = () => document.querySelector('[aria-label="取消生图"]') || button('取消生图');
try {
  await wait(() => document.querySelector('.online-dot:not(.offline), .connection .dot.online') && document.querySelector('[aria-label="逆向模式"]') && !document.querySelector('[aria-label="逆向模式"]').disabled);
  const mode = document.querySelector('[aria-label="逆向模式"]');
  mode.value = 'recreate';
  mode.dispatchEvent(new Event('change', { bubbles: true }));
  await wait(() => mode.value === 'recreate' && generate());
  if (scenario === 'blocked') await wait(() => button('更新提示词') && !button('更新提示词').disabled);
  if (['blocked', 'legacy-empty'].includes(scenario)) {
    assert(generate().disabled, '新服务明确未就绪或旧服务缺配置时禁止生图');
    generate().click();
    await new Promise(resolve => setTimeout(resolve, 300));
    assert(!cancel(), '不可用状态不能发起任务');
  } else {
    await wait(() => !generate().disabled);
    if (scenario === 'ready') {
      const reverse = document.querySelector('.canvas-generate, .quick-submit-actions .text-button');
      assert(reverse?.disabled, '无文字模型时逆向仍受保护');
    }
    if (scenario === 'magpie') {
      assert(!document.body.textContent.includes('提交预览'), 'Magpie 不应显示已删除的提交预览');
      assert(button('逆向并生图') && !button('逆向并生图').disabled, 'Magpie 连续入口应可用');
      const sizes = document.querySelector('.generation-ratio select');
      if (sizes) assert(sizes.value === 'auto' && [...sizes.options].some(option => option.value === '1536:1024') && ![...sizes.options].some(option => option.value === '3:2'), 'Magpie 应默认自动尺寸并显示像素预设，不将比例作为像素');
    }
    generate().click();
    await wait(() => cancel());
    if (scenario === 'magpie') {
      const submitted = requests.find(message => message.type === 'alchemy:generate');
      assert(submitted && !submitted.imageSize && !submitted.aspectRatio, 'Magpie 默认请求必须省略像素与旧比例');
    }
    cancel().click();
    await wait(() => generate() && !generate().disabled);
  }
  document.documentElement.dataset.generationReadinessRegression = 'passed';
  document.querySelector('#preview-notice').textContent = '生图独立就绪回归：PASS';
} catch (error) {
  document.documentElement.dataset.generationReadinessRegression = 'failed';
  document.querySelector('#preview-notice').textContent = `生图独立就绪回归：FAIL · ${error.message}`;
  console.error(error);
}
