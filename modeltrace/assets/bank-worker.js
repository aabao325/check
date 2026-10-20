/* bank-worker.js —— 在后台线程里重建指纹库，避免交叉验证（上百次重建）卡住页面。
 * 收：{ rows, modelMeta }   发：{ type:'progress', done, total } / { type:'done', bank } / { type:'error', message } */
import { buildBank } from './engine/bank-builder.js?v=13';

self.onmessage = (e) => {
  try {
    const { rows, modelMeta } = e.data;
    let last = 0;
    const bank = buildBank(rows, {
      modelMeta,
      onProgress: (done, total) => {
        const now = Date.now();
        if (now - last > 120 || done === total) { last = now; self.postMessage({ type: 'progress', done, total }); }
      },
    });
    self.postMessage({ type: 'done', bank });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err?.message || err) });
  }
};
