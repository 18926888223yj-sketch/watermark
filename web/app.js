/* =========================================================
   水印工坊 - 主逻辑
   ========================================================= */
'use strict';

/* ---------------- 小工具 ---------------- */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const bridge = (typeof window.AndroidBridge !== 'undefined') ? window.AndroidBridge : null;

/* ---------------- 全局状态 ---------------- */
const LIMIT_PHOTOS = 10;
const state = {
  photos: [],
  cur: -1,
  sel: null,          // 当前选中的水印实例 id
  cropMode: false,
  cropRatio: 'free',
  outPng: false,
  quality: 0.98,
  library: [],        // [{id,name,blob,url,w,h}]
  defaults: { scale: 0.20, rotPct: 0, opacity: 1, gap: 25, gapAuto: true, tile: false },
  idbOK: true
};

/* =========================================================
   1. 弹层 / 提示
   ========================================================= */
function toast(msg, ms) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms || 1800);
}
function busy(on, txt) {
  $('#busyTxt').textContent = txt || '处理中…';
  $('#busy').hidden = !on;
}
function dialog(opt) {
  return new Promise((resolve) => {
    const m = $('#modal');
    $('#mTitle').textContent = opt.title || '提示';
    $('#mMsg').textContent = opt.msg || '';
    $('#mMsg').style.display = opt.msg ? '' : 'none';
    const wrap = $('#mBtns');
    wrap.innerHTML = '';
    (opt.buttons || [{ label: '好', value: true, cls: 'yes2' }]).forEach((b) => {
      const el = document.createElement('button');
      el.className = 'btn ' + (b.cls || 'no');
      el.textContent = b.label;
      el.onclick = () => { m.hidden = true; resolve(b.value); };
      wrap.appendChild(el);
    });
    m.hidden = false;
  });
}
function sheet(title, options) {
  return new Promise((resolve) => {
    const s = $('#sheet');
    $('#shTitle').textContent = title;
    const list = $('#shList');
    list.innerHTML = '';
    options.forEach((o) => {
      const b = document.createElement('button');
      b.className = o.cls || '';
      b.textContent = o.label;
      b.onclick = () => { s.hidden = true; resolve(o.value); };
      list.appendChild(b);
    });
    $('#shCancel').onclick = () => { s.hidden = true; resolve(null); };
    s.hidden = false;
  });
}
/* 二次确认：第一层 + 第二层 */
async function confirmTwice(step1, step2) {
  const a = await dialog({ title: step1.title, msg: step1.msg, buttons: [{ label: step1.cancel || '取消', value: 0, cls: 'no' }, { label: step1.ok, value: 1, cls: 'yes2' }] });
  if (!a) return false;
  const b = await dialog({ title: step2.title, msg: step2.msg, buttons: [{ label: '否', value: 0, cls: 'no' }, { label: '是', value: 1, cls: 'yes' }] });
  return !!b;
}

/* =========================================================
   2. 水印库（IndexedDB 持久化）
   ========================================================= */
let _db = null;
function idbOpen() {
  return new Promise((res, rej) => {
    if (_db) return res(_db);
    let r;
    try { r = indexedDB.open('wm-studio', 1); } catch (e) { state.idbOK = false; return rej(e); }
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('wms')) d.createObjectStore('wms', { keyPath: 'id' });
    };
    r.onsuccess = () => { _db = r.result; res(_db); };
    r.onerror = () => { state.idbOK = false; rej(r.error); };
  });
}
async function libLoad() {
  try {
    const d = await idbOpen();
    const all = await new Promise((res, rej) => {
      const rq = d.transaction('wms', 'readonly').objectStore('wms').getAll();
      rq.onsuccess = () => res(rq.result || []); rq.onerror = () => rej(rq.error);
    });
    all.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    state.library = all.map((r) => ({ ...r, url: URL.createObjectURL(r.blob) }));
  } catch (e) {
    state.idbOK = false;
    console.warn('水印库读取失败', e);
  }
  renderLibrary();
}
async function libPut(rec) {
  try {
    const d = await idbOpen();
    await new Promise((res, rej) => {
      const rq = d.transaction('wms', 'readwrite').objectStore('wms').put(rec);
      rq.onsuccess = res; rq.onerror = () => rej(rq.error);
    });
  } catch (e) { state.idbOK = false; }
}
async function libDel(id) {
  try {
    const d = await idbOpen();
    await new Promise((res, rej) => {
      const rq = d.transaction('wms', 'readwrite').objectStore('wms').delete(id);
      rq.onsuccess = res; rq.onerror = () => rej(rq.error);
    });
  } catch (e) { /* ignore */ }
}

/* 读取图片尺寸 */
function fileImgSize(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => res({ url, w: im.naturalWidth, h: im.naturalHeight });
    im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('无法读取该图片（可能是 HEIC 等不支持的格式）')); };
    im.src = url;
  });
}

async function addWatermarks(files) {
  const list = Array.from(files || []).filter((f) => /^image\//.test(f.type) || /\.(png|jpe?g|webp|gif|bmp|avif|heic|heif|svg|tiff?)$/i.test(f.name || ''));
  if (!list.length) return;
  busy(true, '正在导入水印…');
  let ok = 0;
  for (const f of list) {
    try {
      const info = await fileImgSize(f);
      const rec = {
        id: uid(),
        name: (f.name || '水印').replace(/\.[^.]+$/, '').slice(0, 16),
        blob: f,
        w: info.w, h: info.h,
        createdAt: Date.now()
      };
      state.library.push({ ...rec, url: URL.createObjectURL(f) });
      await libPut(rec);
      ok++;
    } catch (e) { console.warn(e); }
  }
  busy(false);
  renderLibrary();
  ensureLibImages();
  toast(ok ? ('已导入 ' + ok + ' 个水印') : '导入失败，请换一张图片试试');
}

/* =========================================================
   2.5 文字水印
   文字先由离屏 Canvas 栅格化成"透明底 PNG"并入水印库，
   之后完全复用图片水印的拖动/缩放/旋转/平铺/导出管线。
   导出时按最终像素尺寸重新绘制 → 放大不模糊。
   ========================================================= */
const TEXT_FONT = '"Noto Sans CJK SC","Source Han Sans SC","PingFang SC","Microsoft YaHei","Heiti SC",system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif';
const TEXT_BASE_PX = 160;      // 存入水印库的基准栅格字号
const TEXT_MAX_W = 2600;       // 栅格宽度上限（防止超长文字占用过大内存）
const TEXT_COLORS = ['#ffffff', '#000000', '#9aa3b5', '#ff5f6d', '#ffd166', '#3ddc97', '#4a9dff'];
const STROKE_COLORS = ['#000000', '#ffffff', '#5f5e5a', '#791f1f', '#0c447c', '#27500a'];
const T_DEFAULT = { text: '', color: '#ffffff', strokeColor: '#000000', strokeW: 0.04, bold: false, italic: false, initScale: 0.20, opacity: 1 };

let tEdit = null;      // 编辑器当前参数
let tEditId = null;    // 非空 = 正在编辑水印库中已有的文字水印

function textFontCss(meta, px) {
  return (meta.italic ? 'italic ' : '') + (meta.bold ? '700' : '400') + ' ' + px.toFixed(2) + 'px ' + TEXT_FONT;
}
/* 量出文字块尺寸（含描边与内边距），padding 与字号成正比，保证不同尺寸下比例一致 */
function measureTextBlock(meta, px) {
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = textFontCss(meta, px);
  const m = ctx.measureText(String(meta.text == null ? ' ' : meta.text));
  const asc = m.actualBoundingBoxAscent || m.fontBoundingBoxAscent || px * 0.86;
  const desc = m.actualBoundingBoxDescent || m.fontBoundingBoxDescent || px * 0.24;
  const sw = Math.max(0, meta.strokeW || 0) * px;
  const pad = px * 0.06 + sw;   // 纯比例内边距：任何字号下宽高比完全一致
  return { px, pad, asc, w: Math.ceil(Math.max(1, m.width) + pad * 2), h: Math.ceil(asc + desc + pad * 2) };
}
/* 把文字画成透明底画布；targetW 给定时按目标像素宽度重新光栅化（导出用，保证清晰） */
function renderTextCanvas(meta, targetW) {
  let px = TEXT_BASE_PX;
  if (targetW && targetW > 4) {
    const b0 = measureTextBlock(meta, TEXT_BASE_PX);
    px = TEXT_BASE_PX * (targetW / b0.w);
  }
  let m = measureTextBlock(meta, clamp(px, 6, 6000));
  if (m.w > TEXT_MAX_W) m = measureTextBlock(meta, Math.max(6, m.px * (TEXT_MAX_W / m.w)));
  const cv = document.createElement('canvas');
  cv.width = m.w; cv.height = m.h;
  const ctx = cv.getContext('2d');
  ctx.font = textFontCss(meta, m.px);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const x = m.pad, y = m.pad + m.asc;
  const sw = Math.max(0, meta.strokeW || 0) * m.px;
  if (sw > 0) {
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = meta.strokeColor || '#000000';
    ctx.lineWidth = Math.max(1, sw * 2);
    ctx.strokeText(meta.text, x, y);
  }
  ctx.fillStyle = meta.color || '#ffffff';
  ctx.fillText(meta.text, x, y);
  return cv;
}
/* 取用于绘制的位图：文字水印按目标宽度重新光栅化（带缓存），图片水印直接用已解码图 */
function wmDrawable(w, targetW) {
  if (!w) return null;
  if (w.kind !== 'text' || !w.meta) return w._img || null;
  const key = Math.max(1, Math.round(targetW / 4));
  if (!w._rs) w._rs = {};
  if (!w._rs[key]) w._rs[key] = renderTextCanvas(w.meta, Math.max(24, targetW));
  return w._rs[key];
}

/* ---- 编辑器 ---- */
function textEditMeta() {
  const t = (tEdit.text || '').trim();
  return {
    text: t || '水印文字',
    color: tEdit.color,
    strokeColor: tEdit.strokeColor,
    strokeW: tEdit.strokeW,
    bold: !!tEdit.bold,
    italic: !!tEdit.italic,
    initScale: tEdit.initScale,
    opacity: tEdit.opacity
  };
}
function buildSwatches(host, colors, get, set) {
  host.innerHTML = '';
  colors.forEach((c) => {
    const b = document.createElement('button');
    b.className = 'sw' + (get() === c ? ' on' : '');
    b.style.background = c;
    b.onclick = () => { set(c); buildSwatches(host, colors, get, set); refreshTextPreview(); };
    host.appendChild(b);
  });
}
function refreshTextPreview() {
  const meta = textEditMeta();
  const txt = (tEdit.text || '').trim();
  const cv = renderTextCanvas({ ...meta, text: txt || '水印文字' }, 620);
  const box = $('#tPreview');
  box.width = cv.width; box.height = cv.height;
  const c = box.getContext('2d');
  c.clearRect(0, 0, box.width, box.height);
  c.drawImage(cv, 0, 0);
  cv.width = cv.height = 0;
  $('#valTFont').textContent = Math.round(tEdit.initScale * 100) + '%';
  $('#valTOpa').textContent = Math.round(tEdit.opacity * 100) + '%';
  $('#valTStroke').textContent = tEdit.strokeW > 0 ? String(Math.round(tEdit.strokeW * 100)) : '无';
  $('#btnTBold').classList.toggle('on', !!tEdit.bold);
  $('#btnTItalic').classList.toggle('on', !!tEdit.italic);
}
function openTextEditor(w) {
  tEditId = w ? w.id : null;
  tEdit = w && w.meta ? { ...T_DEFAULT, ...w.meta } : (tEdit ? { ...tEdit } : { ...T_DEFAULT });
  $('#tEditTitle').textContent = w ? '编辑文字水印' : '添加文字水印';
  $('#btnTOk').textContent = w ? '保存修改' : '存入水印库';
  $('#tText').value = tEdit.text || '';
  $('#rngTFont').value = Math.round(tEdit.initScale * 100);
  $('#rngTOpa').value = Math.round(tEdit.opacity * 100);
  $('#rngTStroke').value = Math.round(tEdit.strokeW * 100);
  buildSwatches($('#swText'), TEXT_COLORS, () => tEdit.color, (c) => { tEdit.color = c; });
  buildSwatches($('#swStroke'), STROKE_COLORS, () => tEdit.strokeColor, (c) => { tEdit.strokeColor = c; });
  $('#tedit').hidden = false;
  refreshTextPreview();
  if (!w) setTimeout(() => { try { $('#tText').focus(); } catch (e) { /* ignore */ } }, 120);
}
async function saveTextWatermark() {
  const txt = ($('#tText').value || '').trim();
  if (!txt) { toast('请输入水印文字'); return; }
  tEdit.text = txt;
  const meta = textEditMeta();
  busy(true, '正在生成文字水印…');
  let blob = null, bw = 0, bh = 0;
  try {
    const cv = renderTextCanvas(meta, null);
    bw = cv.width; bh = cv.height;
    blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
    cv.width = cv.height = 0;
  } catch (e) { blob = null; }
  if (!blob || !bw) { busy(false); toast('文字生成失败，请换个短一点的文字试试'); return; }

  /* 编辑已有文字水印：原地更新，已放置的实例自动跟随 */
  if (tEditId) {
    const w = state.library.find((x) => x.id === tEditId);
    if (w) {
      if (w.url) { try { URL.revokeObjectURL(w.url); } catch (e) { /* ignore */ } }
      w.blob = blob; w.meta = meta; w.w = bw; w.h = bh; w.name = txt.slice(0, 12);
      delete w._img; delete w._rs;
      w.url = URL.createObjectURL(blob);
      await libPut({ id: w.id, kind: 'text', name: w.name, blob: blob, w: bw, h: bh, meta: meta, createdAt: w.createdAt });
      busy(false);
      $('#tedit').hidden = true;
      renderLibrary(); ensureLibImages();
      drawWmLayer(); drawTileOverlay(curPhoto());
      toast('文字水印已更新');
      return;
    }
  }

  const rec = { id: uid(), kind: 'text', name: txt.slice(0, 12), blob: blob, w: bw, h: bh, meta: meta, createdAt: Date.now() };
  state.library.push({ ...rec, url: URL.createObjectURL(blob) });
  await libPut(rec);
  busy(false);
  $('#tedit').hidden = true;
  tEditId = null;
  renderLibrary(); ensureLibImages();
  if (curPhoto()) useWatermark(rec.id);
  else toast('文字水印已存入水印库，上传照片后点击即可使用');
}

function renderLibrary() {
  const g = $('#libGrid');
  g.innerHTML = '';
  $('#libEmpty').style.display = state.library.length ? 'none' : 'block';
  const cur = curPhoto();
  state.library.forEach((w) => {
    const d = document.createElement('div');
    d.className = 'lib-item';
    const used = cur ? cur.items.filter((it) => it.wmId === w.id).length : 0;
    d.innerHTML = '<img src="' + w.url + '" alt="">' +
      (used ? '<span class="uc">×' + used + '</span>' : '') +
      '<span class="nm">' + escapeHtml(w.name) + '</span>';
    bindLibItem(d, w);
    g.appendChild(d);
  });
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* 点击添加 / 长按弹删除菜单 */
function bindLibItem(el, w) {
  let timer = null, longPressed = false, sx = 0, sy = 0;
  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
  el.addEventListener('pointerdown', (e) => {
    longPressed = false; sx = e.clientX; sy = e.clientY;
    try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    clear();
    timer = setTimeout(async () => {
      longPressed = true;
      clear();
      const opts = [{ label: '删除水印', value: 'del', cls: 'del' }];
      if (w.kind === 'text') opts.push({ label: '编辑文字', value: 'edit', cls: 'ren' });
      opts.push({ label: '重命名', value: 'ren', cls: 'ren' }, { label: '取消', value: null, cls: 'cel' });
      const act = await sheet('水印：' + w.name, opts);
      if (act === 'del') {
        const yes = await dialog({
          title: '删除水印',
          msg: '确定要删除水印「' + w.name + '」吗？\n删除后需要重新导入。',
          buttons: [{ label: '否', value: 0, cls: 'no' }, { label: '是', value: 1, cls: 'yes' }]
        });
        if (!yes) return;
        await libDel(w.id);
        state.library = state.library.filter((x) => x.id !== w.id);
        // 同步移除已放置的实例
        state.photos.forEach((p) => { p.items = p.items.filter((it) => it.wmId !== w.id); });
        state.sel = null;
        renderLibrary(); drawWmLayer(); syncSliders();
        toast('已删除水印');
      } else if (act === 'edit') {
        openTextEditor(w);
      } else if (act === 'ren') {
        const nn = await promptText('重命名水印', w.name);
        if (nn) {
          w.name = nn.slice(0, 16);
          const rec = { ...w };
          delete rec.url; delete rec._img; delete rec._rs;
          await libPut(rec);
          renderLibrary();
        }
      }
    }, 520);
  });
  el.addEventListener('pointermove', (e) => {
    if (Math.abs(e.clientX - sx) > 8 || Math.abs(e.clientY - sy) > 8) clear();
  });
  el.addEventListener('pointerup', () => { clear(); if (!longPressed) useWatermark(w.id); });
  el.addEventListener('pointercancel', clear);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}
/* 点击水印库图标：直接把该水印添加到当前照片（并选中） */
function useWatermark(wmId) {
  if (state.cropMode) { toast('请先退出裁剪再添加水印'); return; }
  const p = curPhoto();
  if (!p) { toast('请先上传照片，再添加水印'); return; }
  const w = state.library.find((x) => x.id === wmId);
  const tm = (w && w.kind === 'text' && w.meta) ? w.meta : null;
  const it = {
    id: uid(),
    wmId: wmId,
    x: 0.5, y: 0.5,
    scale: tm && tm.initScale ? tm.initScale : state.defaults.scale,
    rot: 0,
    opacity: tm && tm.opacity != null ? tm.opacity : state.defaults.opacity,
    gap: state.defaults.gap || 25,
    gapAuto: true,
    tile: false
  };
  p.items.push(it);
  state.sel = it.id;
  refreshSelection();
  renderLibrary();
  toast('已添加水印，可拖动调整位置');
}

function promptText(title, def) {
  return new Promise((res) => {
    const m = $('#modal');
    $('#mTitle').textContent = title;
    const msg = $('#mMsg');
    msg.style.display = '';
    msg.innerHTML = '<input id="_pt" type="text" style="width:100%;padding:10px;border-radius:10px;border:1px solid #2e3346;background:#14161f;color:#eef1f8;font-size:14px">';
    $('#_pt').value = def || '';
    const wrap = $('#mBtns'); wrap.innerHTML = '';
    const mk = (label, val, cls) => {
      const b = document.createElement('button');
      b.className = 'btn ' + cls; b.textContent = label;
      b.onclick = () => { m.hidden = true; res(val === 'ok' ? ($('#_pt') ? $('#_pt').value : '') : null); };
      wrap.appendChild(b);
    };
    mk('取消', null, 'no'); mk('确定', 'ok', 'yes2');
    m.hidden = false;
    setTimeout(() => { const i = $('#_pt'); if (i) { i.focus(); i.select(); } }, 60);
  });
}

/* =========================================================
   3. 照片管理
   ========================================================= */
function curPhoto() { return state.cur >= 0 ? state.photos[state.cur] : null; }

async function addPhotos(files) {
  const list = Array.from(files || []).filter((f) => /^image\//.test(f.type) || /\.(png|jpe?g|webp|gif|bmp|avif|heic|heif)$/i.test(f.name));
  if (!list.length) { toast('请选择图片文件'); return; }
  const room = LIMIT_PHOTOS - state.photos.length;
  if (room <= 0) { toast('最多只能导入 ' + LIMIT_PHOTOS + ' 张照片'); return; }
  const use = list.slice(0, room);
  if (list.length > room) toast('一次最多 ' + LIMIT_PHOTOS + ' 张，已导入前 ' + room + ' 张');
  busy(true, '正在载入照片…');
  for (const f of use) {
    try {
      const info = await fileImgSize(f);
      const p = {
        id: uid(),
        name: (f.name || 'photo').replace(/\.[^.]+$/, ''),
        ext: (f.name || '').match(/\.([^.]+)$/) ? RegExp.$1.toLowerCase() : 'jpg',
        url: info.url,
        w0: info.w, h0: info.h,
        lo: null,           // 低分辨率原图（预览用）
        tf: { rot: 0, flipH: false, flipV: false, fine: 0 },
        crop: null,
        items: [],
        previewUrl: ''
      };
      p.lo = await makeLo(info.url, info.w, info.h);
      state.photos.push(p);
    } catch (e) { toast(e.message || '照片读取失败'); }
  }
  busy(false);
  if (state.cur < 0 && state.photos.length) state.cur = 0;
  await rebuildPreview();
  renderThumbs();
  updateInfo();
}

/* 生成低分辨率原图（保持比例，长边 1400） */
function makeLo(url, w, h) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => {
      const k = Math.min(1, 1400 / Math.max(w, h));
      if (k >= 1) return res(im);
      const c = document.createElement('canvas');
      c.width = Math.round(w * k); c.height = Math.round(h * k);
      c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
      const o = new Image();
      o.onload = () => res(o);
      o.onerror = rej;
      o.src = c.toDataURL('image/jpeg', 0.94);
    };
    im.onerror = () => rej(new Error('图片解码失败'));
    im.src = url;
  });
}

function renderThumbs() {
  const box = $('#thumbs');
  box.innerHTML = '';
  state.photos.forEach((p, i) => {
    const d = document.createElement('div');
    d.className = 'thumb' + (i === state.cur ? ' active' : '');
    d.innerHTML = '<img src="' + p.url + '"><span class="tdel">×</span>';
    d.onclick = () => { state.cur = i; state.sel = null; rebuildPreview().then(() => { renderThumbs(); updateInfo(); }); };
    d.querySelector('.tdel').onclick = async (e) => {
      e.stopPropagation();
      const yes = await dialog({ title: '移除照片', msg: '确定把这张照片从列表移除吗？', buttons: [{ label: '否', value: 0, cls: 'no' }, { label: '是', value: 1, cls: 'yes' }] });
      if (!yes) return;
      state.photos.splice(i, 1);
      if (state.cur >= state.photos.length) state.cur = state.photos.length - 1;
      state.sel = null;
      await rebuildPreview(); renderThumbs(); updateInfo();
    };
    box.appendChild(d);
  });
}
function updateInfo() {
  $('#pageInfo').textContent = (state.photos.length ? (state.cur + 1) : 0) + '/' + state.photos.length;
  $('#outInfo').textContent = '照片数量：' + state.photos.length + ' / ' + LIMIT_PHOTOS;
  const p = curPhoto();
  $('#photoInfo').textContent = p
    ? ('当前：' + p.name + ' · ' + p.w0 + '×' + p.h0 + ' · 旋转 ' + p.tf.rot + '°' + (p.tf.flipH ? ' · 水平镜像' : '') + (p.tf.flipV ? ' · 垂直镜像' : '') + (p.crop ? ' · 已裁剪' : ''))
    : '未选择照片';
  $('#emptyHint').style.display = p ? 'none' : 'flex';
}

/* =========================================================
   4. 变换（旋转/镜像/微调）尺寸与渲染
   ========================================================= */
function tfSize(natW, natH, tf) {
  const rot90 = ((tf.rot % 180) + 180) % 180 !== 0;
  const w1 = rot90 ? natH : natW;
  const h1 = rot90 ? natW : natH;
  const a = (tf.fine || 0) * Math.PI / 180;
  const W = Math.abs(w1 * Math.cos(a)) + Math.abs(h1 * Math.sin(a));
  const H = Math.abs(w1 * Math.sin(a)) + Math.abs(h1 * Math.cos(a));
  return { w1, h1, W: Math.ceil(W), H: Math.ceil(H) };
}
function renderTransformed(img, tf, k) {
  const nw = img.naturalWidth * k, nh = img.naturalHeight * k;
  const s = tfSize(nw, nh, tf);
  const c = document.createElement('canvas');
  c.width = s.W; c.height = s.H;
  const ctx = c.getContext('2d');
  if (tf.fine) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height); }
  ctx.save();
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((tf.fine || 0) * Math.PI / 180);
  ctx.rotate(tf.rot * Math.PI / 180);
  ctx.scale(tf.flipH ? -1 : 1, tf.flipV ? -1 : 1);
  ctx.drawImage(img, -nw / 2, -nh / 2, nw, nh);
  ctx.restore();
  return { canvas: c, W: s.W, H: s.H };
}

/* =========================================================
   5. 预览渲染
   ========================================================= */
let stageSW = 0, stageSH = 0;      // 舞台像素尺寸
let outW = 0, outH = 0;            // 输出像素尺寸（全分辨率）

function previewOutputSize(p) {
  const s = tfSize(p.w0, p.h0, p.tf);
  const c = p.crop || { x: 0, y: 0, w: 1, h: 1 };
  return { W1: s.W, H1: s.H, ow: Math.max(1, Math.round(c.w * s.W)), oh: Math.max(1, Math.round(c.h * s.H)) };
}

async function rebuildPreview() {
  const p = curPhoto();
  if (!p) { $('#photoImg').removeAttribute('src'); $('#wmLayer').innerHTML = ''; updateInfo(); return; }
  const k = p.lo.naturalWidth / p.w0;
  const r = renderTransformed(p.lo, p.tf, 1);
  p.previewUrl = r.canvas.toDataURL('image/jpeg', 0.9);
  p._pw = r.W; p._ph = r.H;
  const sz = previewOutputSize(p);
  outW = sz.ow; outH = sz.oh;
  const img = $('#photoImg');
  img.src = p.previewUrl;
  layoutStage();
  drawWmLayer();
  syncSliders();
}

function layoutStage() {
  const p = curPhoto();
  if (!p) return;
  const wrap = $('#stageWrap');
  const bw = wrap.clientWidth, bh = wrap.clientHeight;
  const c = state.cropMode ? { x: 0, y: 0, w: 1, h: 1 } : (p.crop || { x: 0, y: 0, w: 1, h: 1 });
  const s0 = tfSize(p.w0, p.h0, p.tf);
  const ar = (s0.W * c.w) / (s0.H * c.h);         // 可见区域宽高比
  let SW = bw, SH = SW / ar;
  if (SH > bh) { SH = bh; SW = SH * ar; }
  SW = Math.max(40, Math.floor(SW)); SH = Math.max(40, Math.floor(SH));
  stageSW = SW; stageSH = SH;
  const st = $('#stage');
  st.style.width = SW + 'px';
  st.style.height = SH + 'px';
  const fullW = SW / c.w, fullH = SH / c.h;       // 整张图在舞台中的显示尺寸
  const img = $('#photoImg');
  img.style.width = fullW + 'px';
  img.style.height = fullH + 'px';
  img.style.left = (-c.x * fullW) + 'px';
  img.style.top = (-c.y * fullH) + 'px';
  const cl = $('#cropLayer');
  if (state.cropMode) { cl.hidden = false; placeCropBox(); } else { cl.hidden = true; }
}

/* ---- 水印 DOM ---- */
function drawWmLayer() {
  const p = curPhoto();
  const layer = $('#wmLayer');
  layer.innerHTML = '';
  if (!p) { drawTileOverlay(null); return; }
  layer.style.display = state.cropMode ? 'none' : '';
  p.items.forEach((it) => {
    const w = state.library.find((x) => x.id === it.wmId);
    if (!w) return;
    const el = document.createElement('div');
    el.className = 'wm-item' + (it.id === state.sel ? ' sel' : '') + (it.tile ? ' tiled' : '');
    el.dataset.id = it.id;
    if (it.tile) {
      el.innerHTML = '<span class="wm-chip">平铺 · ' + escapeHtml(w.name) + '</span>' +
        '<span class="badge-plus">＋1</span>' +
        '<span class="hd hd-del">🗑</span>';
      el.style.left = (it.x * stageSW) + 'px';
      el.style.top = (it.y * stageSH) + 'px';
      el.style.width = 'auto';
      el.style.transform = 'translate(-50%,-50%)';
    } else {
      el.style.left = (it.x * stageSW) + 'px';
      el.style.top = (it.y * stageSH) + 'px';
      el.style.width = (it.scale * stageSW) + 'px';
      el.style.opacity = it.opacity;
      el.style.transform = 'translate(-50%,-50%) rotate(' + it.rot + 'deg)';
      el.innerHTML = '<img src="' + w.url + '" alt="">' +
        '<span class="wm-frame"></span>' +
        '<span class="badge-plus">＋1</span>' +
        '<span class="hd hd-del">🗑</span>' +
        '<span class="hd hd-rot">↻</span>' +
        '<span class="hd hd-scale">⤡</span>';
    }
    layer.appendChild(el);
  });
  drawTileOverlay(p);
}

/* 平铺阵列：间距占图片短边的百分比。
   it.gapAuto = true 时按"图片尺寸 + 水印显示尺寸"自动计算合理密度，
   手动拖动密度滑杆后转为固定比例（gap 字段保存百分比 5~60）。 */
function tileGapPct(it, W, H) {
  const minSide = Math.max(1, Math.min(W, H));
  if (!it.gapAuto && it.gap) return clamp(it.gap, 5, 60);
  const w = state.library.find((x) => x.id === it.wmId);
  const wmW = it.scale * W;
  const wmH = w ? wmW * (w.h / Math.max(1, w.w)) : wmW * 0.4;
  let step = Math.max(wmW, wmH) * 2.2;                 // 间距 ≈ 水印长边的 2.2 倍
  step = clamp(step, minSide * 0.14, minSide * 0.5);   // 限制在短边的 14%~50%
  return Math.round(step / minSide * 100);
}

/* 平铺使用独立画布绘制，避免大量 DOM 节点 */
function drawTileOverlay(p) {
  let cv = $('#tileCv');
  if (!cv) {
    cv = document.createElement('canvas');
    cv.id = 'tileCv';
    cv.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    $('#stage').appendChild(cv);
  }
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.max(1, Math.round(stageSW * dpr));
  cv.height = Math.max(1, Math.round(stageSH * dpr));
  cv.style.width = stageSW + 'px';
  cv.style.height = stageSH + 'px';
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, stageSW, stageSH);
  if (!p || state.cropMode) return;
  const k = stageSW / outW;                       // 输出像素 -> 舞台像素
  p.items.filter((it) => it.tile).forEach((it) => {
    const w = state.library.find((x) => x.id === it.wmId);
    if (!w || !w._img) return;
    const tw = it.scale * stageSW;
    const th = tw * (w.h / w.w);
    const pct = tileGapPct(it, outW, outH);
    const step = Math.max(4, (pct / 100) * Math.min(outW, outH) * k);
    ctx.save();
    ctx.globalAlpha = it.opacity;
    const cols = Math.ceil(stageSW / step) + 2, rows = Math.ceil(stageSH / step) + 1;
    const ox = (stageSW - (cols - 1) * step) / 2, oy = (stageSH - (rows - 1) * step) / 2;
    for (let r = 0; r < rows; r++) {
      const off = (r % 2) * step / 2;             // 奇数行错位半个间距，形成规则阵列
      for (let c = 0; c < cols; c++) {
        const cx = ox + c * step - off, cy = oy + r * step;
        if (cx < -tw || cx > stageSW + tw || cy < -th || cy > stageSH + th) continue;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(it.rot * Math.PI / 180);
        ctx.drawImage(w._img, -tw / 2, -th / 2, tw, th);
        ctx.restore();
      }
    }
    ctx.restore();
  });
}
/* 预解码水印图片，便于画布绘制 */
function ensureLibImages() {
  state.library.forEach((w) => {
    if (w._img) return;
    const im = new Image();
    im.onload = () => { w._img = im; drawTileOverlay(curPhoto()); };
    im.src = w.url;
  });
}

/* =========================================================
   6. 手势：拖动 / 等比例缩放 / 旋转 / 双指
   ========================================================= */
const stageEl = $('#stage');
const pointers = new Map();
let mode = null, startItem = null, startData = null, pinch = null;

function itemById(id) { const p = curPhoto(); return p ? p.items.find((x) => x.id === id) : null; }

stageEl.addEventListener('pointerdown', (e) => {
  const p = curPhoto();
  if (!p || state.cropMode) return;
  const handle = e.target.closest && e.target.closest('.hd');
  const plus = e.target.closest && e.target.closest('.badge-plus');
  const itemEl = e.target.closest && e.target.closest('.wm-item');
  stageEl.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size >= 2 && state.sel) { startPinch(); return; }
  if (!itemEl) { state.sel = null; refreshSelection(); return; }
  const it = itemById(itemEl.dataset.id);
  if (!it) return;
  if (plus) { duplicateItem(it); return; }
  if (handle && handle.classList.contains('hd-del')) {
    state.sel = it.id;
    removeItemWithConfirm(it);
    return;
  }
  state.sel = it.id;
  refreshSelection();
  startItem = it;
  startData = { x: it.x, y: it.y, scale: it.scale, rot: it.rot, px: e.clientX, py: e.clientY, opa: it.opacity };
  if (handle) mode = handle.classList.contains('hd-scale') ? 'scale' : 'rot';
  else mode = 'move';
  e.preventDefault();
});

stageEl.addEventListener('pointermove', (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch) { doPinch(); return; }
  if (!mode || !startItem) return;
  const dx = e.clientX - startData.px, dy = e.clientY - startData.py;
  if (mode === 'move') {
    startItem.x = clamp(startData.x + dx / stageSW, 0, 1);
    startItem.y = clamp(startData.y + dy / stageSH, 0, 1);
  } else if (mode === 'scale') {
    const cx = startData.x * stageSW, cy = startData.y * stageSH;
    const d0 = Math.hypot(startData.px - (startData.px), 0);
    const dNow = Math.hypot(e.clientX - cx, e.clientY - cy);
    const dStart = Math.hypot(startData.px - cx, startData.py - cy);
    const k = dStart > 4 ? dNow / dStart : 1;
    startItem.scale = clamp(startData.scale * k, 0.01, 2);
  } else if (mode === 'rot') {
    const cx = startData.x * stageSW, cy = startData.y * stageSH;
    const a0 = Math.atan2(startData.py - cy, startData.px - cx);
    const a1 = Math.atan2(e.clientY - cy, e.clientX - cx);
    startItem.rot = normDeg(startData.rot + (a1 - a0) * 180 / Math.PI);
  }
  if (startItem.tile) { drawTileOverlay(curPhoto()); }
  else { applyItemStyle(startItem); }
  syncSliders();
  e.preventDefault();
});

function endPointer(e) {
  if (pointers.has(e.pointerId)) pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 0) { mode = null; startItem = null; }
}
stageEl.addEventListener('pointerup', endPointer);
stageEl.addEventListener('pointercancel', endPointer);

function startPinch() {
  const pts = Array.from(pointers.values()).slice(0, 2);
  const it = itemById(state.sel);
  if (!it) return;
  pinch = {
    it, d0: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
    a0: Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x),
    s0: it.scale, r0: it.rot
  };
}
function doPinch() {
  const pts = Array.from(pointers.values()).slice(0, 2);
  if (pts.length < 2 || !pinch) return;
  const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  const a = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);
  if (pinch.d0 > 4) pinch.it.scale = clamp(pinch.s0 * (d / pinch.d0), 0.01, 2);
  pinch.it.rot = normDeg(pinch.r0 + (a - pinch.a0) * 180 / Math.PI);
  applyItemStyle(pinch.it);
  syncSliders();
}
function normDeg(d) { d = ((d % 360) + 360) % 360; return d > 180 ? d - 360 : d; }

function applyItemStyle(it) {
  const el = $('#wmLayer').querySelector('.wm-item[data-id="' + it.id + '"]');
  if (!el || it.tile) return;
  el.style.left = (it.x * stageSW) + 'px';
  el.style.top = (it.y * stageSH) + 'px';
  el.style.width = (it.scale * stageSW) + 'px';
  el.style.opacity = it.opacity;
  el.style.transform = 'translate(-50%,-50%) rotate(' + it.rot + 'deg)';
  const lb = $('#selLabel');
  if (state.sel === it.id) lb.textContent = labelOf(it);
}
function refreshSelection() { drawWmLayer(); syncSliders(); }
function labelOf(it) {
  const w = state.library.find((x) => x.id === it.wmId);
  return '已选中：' + (w ? w.name : '水印') + (it.tile ? '（平铺中）' : '');
}

/* 预览中删除水印：点左下角红色删除图标 → 是/否 二级确认 */
async function removeItemWithConfirm(it) {
  const p = curPhoto();
  if (!p) return;
  const w = state.library.find((x) => x.id === it.wmId);
  const yes = await dialog({
    title: '删除水印',
    msg: '确定从当前照片上删除水印「' + (w ? w.name : '未命名') + '」吗？',
    buttons: [{ label: '否', value: 0, cls: 'no' }, { label: '是', value: 1, cls: 'yes' }]
  });
  if (!yes) return;
  p.items = p.items.filter((x) => x.id !== it.id);
  state.sel = null;
  refreshSelection();
  renderLibrary();
  toast('已删除水印');
}

/* +1：复制一个同款水印实例 */
function duplicateItem(it) {
  const p = curPhoto();
  if (!p) return;
  const n = JSON.parse(JSON.stringify(it));
  n.id = uid();
  n.x = clamp(it.x + 0.06, 0.02, 0.98);
  n.y = clamp(it.y + 0.06, 0.02, 0.98);
  n.tile = false;
  p.items.push(n);
  state.sel = n.id;
  refreshSelection();
  renderLibrary();
  toast('已添加：数量 +1');
}

/* =========================================================
   7. 水印参数（三条进度条）
   ========================================================= */
function selectedItem() { const p = curPhoto(); return p && state.sel ? p.items.find((x) => x.id === state.sel) : null; }

function syncSliders() {
  const it = selectedItem();
  const v = it || state.defaults;
  $('#rngScale').value = Math.round((it ? it.scale : state.defaults.scale) * 100);
  $('#rngRot').value = Math.round(it ? (it.rot / 180 * 100) : state.defaults.rotPct);
  $('#rngOpa').value = Math.round((it ? it.opacity : state.defaults.opacity) * 100);
  $('#chkTile').checked = it ? !!it.tile : !!state.defaults.tile;
  $('#rowGap').hidden = !(it ? it.tile : state.defaults.tile);
  if (it) {
    const pct = tileGapPct(it, outW || 1, outH || 1);
    $('#rngGap').value = pct;
    $('#valGap').textContent = it.gapAuto ? ('自动 · ' + pct + '%') : (pct + '%');
  } else {
    $('#rngGap').value = state.defaults.gap || 25;
    $('#valGap').textContent = state.defaults.gapAuto ? '自动' : ($('#rngGap').value + '%');
  }
  $('#valScale').textContent = $('#rngScale').value + '%';
  $('#valRot').textContent = $('#rngRot').value + '%  (' + Math.round((+$('#rngRot').value) * 1.8) + '°)';
  $('#valOpa').textContent = $('#rngOpa').value + '%';
  $('#selLabel').textContent = it ? labelOf(it) : (curPhoto() ? '未选中水印 · 当前为新建默认值' : '未选中水印');
  $('#selHint').textContent = it ? '拖动可移动，右下角可等比例放大缩小' : '点击图片上的水印可选中';
  const dis = false;
  ['rngScale', 'rngRot', 'rngOpa'].forEach((id) => { $('#' + id).disabled = false; });
  const has = !!it;
  $('#btnPlus1').style.opacity = has ? '' : '.5';
  $('#btnResetItem').style.opacity = has ? '' : '.5';
  $('#btnDelItem').style.opacity = has ? '' : '.5';
  $('#btnCenter').style.opacity = has ? '' : '.5';
}
function writeSlider(field, val) {
  const it = selectedItem();
  if (field === 'scale') { if (it) it.scale = val; else state.defaults.scale = val; }
  if (field === 'rotPct') { if (it) it.rot = Math.round(val * 1.8); else state.defaults.rotPct = val; }
  if (field === 'opacity') { if (it) it.opacity = val; else state.defaults.opacity = val; }
  if (field === 'gap') { if (it) { it.gap = val; it.gapAuto = false; } else { state.defaults.gap = val; state.defaults.gapAuto = false; } }
}
function onSliderChange(field, raw) {
  const it = selectedItem();
  if (field === 'scale') writeSlider('scale', clamp(raw / 100, 0.01, 2));
  if (field === 'rotPct') writeSlider('rotPct', raw);
  if (field === 'opacity') writeSlider('opacity', clamp(raw / 100, 0, 1));
  if (field === 'gap') writeSlider('gap', raw);
  if (it) {
    if (it.tile) drawTileOverlay(curPhoto());
    else applyItemStyle(it);
  }
  syncSliders();
}

/* =========================================================
   8. 裁剪
   ========================================================= */
let cropRect = { x: 0.05, y: 0.05, w: 0.9, h: 0.9 };   // 归一化（整图空间）
function placeCropBox() {
  const b = $('#cropBox');
  b.style.left = (cropRect.x * stageSW) + 'px';
  b.style.top = (cropRect.y * stageSH) + 'px';
  b.style.width = (cropRect.w * stageSW) + 'px';
  b.style.height = (cropRect.h * stageSH) + 'px';
}
function enterCrop() {
  const p = curPhoto();
  if (!p) { toast('请先上传照片'); return; }
  state.cropMode = true;
  state.sel = null;
  cropRect = p.crop ? { ...p.crop } : { x: 0.06, y: 0.06, w: 0.88, h: 0.88 };
  $('#btnCrop').hidden = true;
  $('#btnCropCancel').hidden = false;
  $('#btnCropApply').hidden = false;
  $('#ratioRow').hidden = false;
  layoutStage();
  drawWmLayer();
  toast('拖动圆点调整裁剪框');
}
function exitCrop() {
  state.cropMode = false;
  $('#btnCrop').hidden = false;
  $('#btnCropCancel').hidden = true;
  $('#btnCropApply').hidden = true;
  $('#ratioRow').hidden = true;
  layoutStage();
  drawWmLayer();
}
function ratioValue(r) {
  if (r === 'free') return null;
  const [a, b] = r.split(':').map(Number);
  return a / b;
}
const cropBoxEl = $('#cropBox');
let cropDrag = null;
cropBoxEl.addEventListener('pointerdown', (e) => {
  const h = e.target.dataset ? e.target.dataset.h : null;
  cropDrag = { h: h || 'move', sx: e.clientX, sy: e.clientY, r: { ...cropRect } };
  cropBoxEl.setPointerCapture(e.pointerId);
  e.preventDefault();
  e.stopPropagation();
});
cropBoxEl.addEventListener('pointermove', (e) => {
  if (!cropDrag) return;
  const dx = (e.clientX - cropDrag.sx) / stageSW;
  const dy = (e.clientY - cropDrag.sy) / stageSH;
  const o = cropDrag.r;
  let r = { ...o };
  const h = cropDrag.h;
  const MIN = 0.05;
  if (h === 'move') { r.x = clamp(o.x + dx, 0, 1 - o.w); r.y = clamp(o.y + dy, 0, 1 - o.h); }
  else {
    let l = o.x, t = o.y, ri = o.x + o.w, bo = o.y + o.h;
    if (h.indexOf('w') >= 0) l = clamp(o.x + dx, 0, ri - MIN);
    if (h.indexOf('e') >= 0) ri = clamp(o.x + o.w + dx, l + MIN, 1);
    if (h.indexOf('n') >= 0) t = clamp(o.y + dy, 0, bo - MIN);
    if (h.indexOf('s') >= 0) bo = clamp(o.y + o.h + dy, t + MIN, 1);
    r = { x: l, y: t, w: ri - l, h: bo - t };
    const ar = ratioValue(state.cropRatio);
    if (ar) {
      const p = curPhoto();
      const imgAR = (stageSW / stageSH) * (r.h / r.w) * (r.w / r.h) * (stageSW / stageSH);
      // 像素宽高比 = (r.w*imgW) / (r.h*imgH)
      const pxAR = (r.w * stageSW) / (r.h * stageSH);
      if (pxAR > ar) { const nw = ar * r.h * stageSH / stageSW; r.x += (r.w - nw) / 2; r.w = nw; }
      else { const nh = (r.w * stageSW) / ar / stageSH; r.y += (r.h - nh) / 2; r.h = nh; }
      r.x = clamp(r.x, 0, 1 - r.w); r.y = clamp(r.y, 0, 1 - r.h);
    }
  }
  cropRect = r;
  placeCropBox();
  e.preventDefault();
});
cropBoxEl.addEventListener('pointerup', () => { cropDrag = null; });
cropBoxEl.addEventListener('pointercancel', () => { cropDrag = null; });

/* =========================================================
   9. 导出与保存
   ========================================================= */
function loadFull(p) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('原图解码失败'));
    im.src = p.url;
  });
}
async function renderOutputCanvas(p, wmImages) {
  const hi = await loadFull(p);
  const s = tfSize(hi.naturalWidth, hi.naturalHeight, p.tf);
  const c = p.crop || { x: 0, y: 0, w: 1, h: 1 };
  const ow = Math.max(1, Math.round(c.w * s.W));
  const oh = Math.max(1, Math.round(c.h * s.H));
  const cv = document.createElement('canvas');
  cv.width = ow; cv.height = oh;
  const ctx = cv.getContext('2d');
  ctx.save();
  ctx.translate(-c.x * s.W, -c.y * s.H);
  // 底图（含旋转/镜像/微调）
  if (p.tf.fine || p.tf.flipH || p.tf.flipV || p.tf.rot) {
    if (p.tf.fine) { ctx.fillStyle = '#ffffff'; ctx.fillRect(c.x * s.W, c.y * s.H, ow, oh); }
    ctx.save();
    ctx.translate(s.W / 2, s.H / 2);
    ctx.rotate((p.tf.fine || 0) * Math.PI / 180);
    ctx.rotate(p.tf.rot * Math.PI / 180);
    ctx.scale(p.tf.flipH ? -1 : 1, p.tf.flipV ? -1 : 1);
    ctx.drawImage(hi, -hi.naturalWidth / 2, -hi.naturalHeight / 2);
    ctx.restore();
  } else {
    ctx.drawImage(hi, 0, 0, s.W, s.H);
  }
  // 水印
  for (const it of p.items) {
    const w = state.library.find((x) => x.id === it.wmId);
    if (!w) continue;
    const tw = it.scale * ow;
    const im = wmDrawable(w, tw) || wmImages[w.id] || w._img;   // 文字水印：按输出像素重新绘制，放大不模糊
    if (!im) continue;
    const iw = im.naturalWidth || im.width || 1;
    const ih = im.naturalHeight || im.height || 1;
    const th = tw * (ih / iw);
    ctx.globalAlpha = it.opacity;
    if (it.tile) {
      const pct = tileGapPct(it, ow, oh);
      const step = Math.max(4, (pct / 100) * Math.min(ow, oh));
      const cols = Math.ceil(ow / step) + 2, rows = Math.ceil(oh / step) + 1;
      const ox = c.x * s.W + (ow - (cols - 1) * step) / 2;
      const oy = c.y * s.H + (oh - (rows - 1) * step) / 2;
      for (let r = 0; r < rows; r++) {
        const off = (r % 2) * step / 2;           // 与预览一致：奇数行错位半间距
        for (let cc = 0; cc < cols; cc++) {
          const px = ox + cc * step - off, py = oy + r * step;
          if (px < c.x * s.W - tw || px > (c.x + c.w) * s.W + tw || py < c.y * s.H - th || py > (c.y + c.h) * s.H + th) continue;
          ctx.save(); ctx.translate(px, py); ctx.rotate(it.rot * Math.PI / 180);
          ctx.drawImage(im, -tw / 2, -th / 2, tw, th); ctx.restore();
        }
      }
    } else {
      ctx.save();
      ctx.translate(c.x * s.W + it.x * ow, c.y * s.H + it.y * oh);
      ctx.rotate(it.rot * Math.PI / 180);
      ctx.drawImage(im, -tw / 2, -th / 2, tw, th);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();
  return cv;
}
function b64(u8) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}
async function saveCanvas(cv, name, mime) {
  const blob = await new Promise((r) => cv.toBlob(r, mime, state.outPng ? undefined : state.quality));
  if (!blob) throw new Error('编码失败');
  if (bridge && bridge.beginSave) {
    const u8 = new Uint8Array(await blob.arrayBuffer());
    const CH = 384 * 1024;
    const total = Math.ceil(u8.length / CH);
    bridge.beginSave(name, mime, u8.length, total);
    for (let i = 0; i < total; i++) {
      bridge.saveChunk(b64(u8.subarray(i * CH, Math.min((i + 1) * CH, u8.length))));
      if (i % 8 === 7) await new Promise((r) => setTimeout(r, 0));
    }
    const r = bridge.endSave();
    if (r && r !== 'ok') throw new Error(r);
  } else {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 8000);
  }
}
async function saveList(indexes) {
  if (!state.photos.length) { toast('还没有照片'); return; }
  const wmImages = {};
  busy(true, '正在准备水印…');
  for (const w of state.library) {
    if (!wmImages[w.id]) {
      wmImages[w.id] = await new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = w.url; });
    }
  }
  const mime = state.outPng ? 'image/png' : 'image/jpeg';
  const ext = state.outPng ? 'png' : 'jpg';
  let ok = 0;
  for (let n = 0; n < indexes.length; n++) {
    const p = state.photos[indexes[n]];
    busy(true, '正在保存 ' + (n + 1) + '/' + indexes.length + ' …');
    await new Promise((r) => setTimeout(r, 30));
    try {
      const cv = await renderOutputCanvas(p, wmImages);
      const name = p.name + '_水印_' + Date.now().toString().slice(-6) + '.' + ext;
      await saveCanvas(cv, name, mime);
      cv.width = cv.height = 0;
      ok++;
    } catch (e) { console.error(e); toast('保存失败：' + e.message); }
  }
  busy(false);
  state.library.forEach((w) => { delete w._rs; });   // 释放文字水印的高清栅格缓存
  toast(ok ? ('已保存 ' + ok + ' 张到相册') : '保存失败');
}

/* =========================================================
   10. 事件绑定
   ========================================================= */
$('#btnPickPhoto').onclick = pickPhotos;
$('#emptyHint').onclick = pickPhotos;
$('#filePhoto').onchange = (e) => { addPhotos(e.target.files); e.target.value = ''; };
$('#btnAddWm').onclick = pickWatermarks;
$('#btnBatchWm').onclick = pickWatermarks;
$('#fileWm').onchange = (e) => { addWatermarks(e.target.files); e.target.value = ''; };

/* ---- 文字水印编辑器 ---- */
$('#btnAddText').onclick = () => openTextEditor(null);
$('#tText').oninput = (e) => { tEdit.text = e.target.value; refreshTextPreview(); };
$('#rngTFont').oninput = (e) => { tEdit.initScale = clamp(+e.target.value / 100, 0.02, 1); refreshTextPreview(); };
$('#rngTOpa').oninput = (e) => { tEdit.opacity = clamp(+e.target.value / 100, 0.05, 1); refreshTextPreview(); };
$('#rngTStroke').oninput = (e) => { tEdit.strokeW = clamp(+e.target.value / 100, 0, 0.12); refreshTextPreview(); };
$('#btnTBold').onclick = () => { tEdit.bold = !tEdit.bold; refreshTextPreview(); };
$('#btnTItalic').onclick = () => { tEdit.italic = !tEdit.italic; refreshTextPreview(); };
$('#btnTReset').onclick = () => {
  const t = tEdit.text;
  tEdit = { ...T_DEFAULT, text: t };
  $('#rngTFont').value = 20; $('#rngTOpa').value = 100; $('#rngTStroke').value = 4;
  buildSwatches($('#swText'), TEXT_COLORS, () => tEdit.color, (c) => { tEdit.color = c; });
  buildSwatches($('#swStroke'), STROKE_COLORS, () => tEdit.strokeColor, (c) => { tEdit.strokeColor = c; });
  refreshTextPreview();
};
$('#btnTCancel').onclick = () => { $('#tedit').hidden = true; tEditId = null; };
$('#btnTOk').onclick = saveTextWatermark;

/* ---------------- 选图通道 ----------------
   安卓端 <input type=file> 在部分机型/ROM 上不会回调原生选择器，
   因此优先使用原生桥接的 pickImages()；浏览器预览时回退到 input。 */
function toFile(blob, name, type) {
  const t = type || blob.type || 'image/jpeg';
  const nm = name || ('image_' + Date.now() + '.jpg');
  try { return new File([blob], nm, { type: t }); } catch (e) { /* 旧内核无 File */ }
  try { blob.name = nm; } catch (e2) { /* ignore */ }
  return blob;
}
function pickNative(kind, handler) {
  if (!bridge || typeof bridge.pickImages !== 'function') return false;
  window.__nativePickHandler = handler;
  try {
    bridge.pickImages(kind);
    return true;
  } catch (e) {
    window.__nativePickHandler = null;
    return false;
  }
}
/* 原生选图结果回调：kind = 'photo' | 'wm'，json = [{name,type,url}] */
window.__onNativePicked = async function (kind, json) {
  const handler = window.__nativePickHandler;
  window.__nativePickHandler = null;
  if (!handler) return;
  let list = [];
  try { list = json ? JSON.parse(json) : []; } catch (e) { list = []; }
  if (!list || !list.length) { busy(false); return; }   // 用户取消
  busy(true, '正在读取图片…');
  const files = [];
  for (const it of list) {
    try {
      const r = await fetch(it.url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const blob = await r.blob();
      if (!blob.size) throw new Error('文件为空');
      files.push(toFile(blob, it.name, it.type));
    } catch (e) { console.warn('图片读取失败', it && it.name, e); }
  }
  busy(false);
  if (!files.length) { toast('图片读取失败，请换一张试试'); return; }
  try { await handler(files); } catch (e) { console.error(e); toast('导入失败：' + (e.message || e)); }
};
function pickPhotos() {
  if (pickNative('photo', (files) => addPhotos(files))) return;
  $('#filePhoto').click();
}
function pickWatermarks() {
  if (pickNative('wm', (files) => addWatermarks(files))) return;
  $('#fileWm').click();
}

$$('#tabs .tab').forEach((t) => {
  t.onclick = () => {
    $$('#tabs .tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    $$('.pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === t.dataset.tab));
    if (t.dataset.tab === 'lib') renderLibrary();
  };
});
function goTab(name) { const t = $('#tabs .tab[data-tab="' + name + '"]'); if (t) t.click(); }

$('#rngScale').oninput = (e) => onSliderChange('scale', +e.target.value);
$('#rngRot').oninput = (e) => onSliderChange('rotPct', +e.target.value);
$('#rngOpa').oninput = (e) => onSliderChange('opacity', +e.target.value);
$('#rngGap').oninput = (e) => onSliderChange('gap', +e.target.value);
$('#rngFine').oninput = (e) => {
  const p = curPhoto(); if (!p) return;
  p.tf.fine = +e.target.value;
  $('#valFine').textContent = e.target.value + '°';
  rebuildPreview();
};
$('#rngQuality').oninput = (e) => { state.quality = +e.target.value / 100; $('#valQuality').textContent = e.target.value + '%'; };
$('#chkPng').onchange = (e) => { state.outPng = e.target.checked; $('#rowQuality').style.display = state.outPng ? 'none' : ''; };

$('#chkTile').onchange = (e) => {
  const it = selectedItem();
  if (it) {
    it.tile = e.target.checked;
    if (it.tile) { it.gapAuto = true; if (!it.gap) it.gap = 25; }  // 每次开启平铺重新自动适配密度
  } else {
    state.defaults.tile = e.target.checked;
    if (e.target.checked) state.defaults.gapAuto = true;
  }
  syncSliders(); drawWmLayer();
};
$('#btnPlus1').onclick = () => {
  const it = selectedItem();
  if (!it) { toast('请先点击图片上的水印'); return; }
  duplicateItem(it);
};
$('#btnCenter').onclick = () => {
  const it = selectedItem(); if (!it) { toast('请先选中一个水印'); return; }
  it.x = 0.5; it.y = 0.5;
  if (it.tile) drawTileOverlay(curPhoto()); else applyItemStyle(it);
};
$('#btnResetItem').onclick = () => {
  const it = selectedItem(); if (!it) { toast('请先选中一个水印'); return; }
  it.scale = state.defaults.scale; it.rot = 0; it.opacity = 1; it.tile = false;
  it.gap = state.defaults.gap || 25; it.gapAuto = true;
  it.x = 0.5; it.y = 0.5;
  refreshSelection();
};
$('#btnDelItem').onclick = async () => {
  const it = selectedItem(); if (!it) { toast('请先选中一个水印'); return; }
  const yes = await dialog({ title: '移除水印', msg: '确定从这张照片上移除该水印吗？', buttons: [{ label: '否', value: 0, cls: 'no' }, { label: '是', value: 1, cls: 'yes' }] });
  if (!yes) return;
  const p = curPhoto();
  p.items = p.items.filter((x) => x.id !== it.id);
  state.sel = null;
  refreshSelection(); renderLibrary();
};
$('#btnApplyAll').onclick = async () => {
  const p = curPhoto();
  if (!p) { toast('请先选择照片'); return; }
  const yes = await dialog({ title: '同步到全部照片', msg: '将当前照片的水印摆放与参数复制到其余 ' + (state.photos.length - 1) + ' 张照片？', buttons: [{ label: '取消', value: 0, cls: 'no' }, { label: '同步', value: 1, cls: 'yes2' }] });
  if (!yes) return;
  const copy = JSON.parse(JSON.stringify(p.items));
  state.photos.forEach((q) => { if (q.id !== p.id) q.items = JSON.parse(JSON.stringify(copy)).map((x) => ({ ...x, id: uid() })); });
  toast('已同步到全部照片');
  renderLibrary();
};

/* 照片编辑 */
$('#btnRotL').onclick = () => rotatePhoto(-90);
$('#btnRotR').onclick = () => rotatePhoto(90);
function rotatePhoto(d) {
  const p = curPhoto(); if (!p) { toast('请先上传照片'); return; }
  p.tf.rot = ((p.tf.rot + d) % 360 + 360) % 360;
  rebuildPreview(); updateInfo();
}
$('#btnMirrorH').onclick = () => { const p = curPhoto(); if (!p) return toast('请先上传照片'); p.tf.flipH = !p.tf.flipH; rebuildPreview(); updateInfo(); };
$('#btnMirrorV').onclick = () => { const p = curPhoto(); if (!p) return toast('请先上传照片'); p.tf.flipV = !p.tf.flipV; rebuildPreview(); updateInfo(); };
$('#btnCrop').onclick = enterCrop;
$('#btnCropCancel').onclick = () => { exitCrop(); };
$('#btnCropApply').onclick = () => {
  const p = curPhoto();
  p.crop = { ...cropRect };
  exitCrop();
  drawTileOverlay(p);
  updateInfo();
  toast('裁剪已应用');
};
$$('#ratioRow .chip').forEach((c) => {
  c.onclick = () => {
    $$('#ratioRow .chip').forEach((x) => x.classList.remove('active'));
    c.classList.add('active');
    state.cropRatio = c.dataset.ratio;
  };
});
$('#btnResetPhoto').onclick = async () => {
  const p = curPhoto(); if (!p) return toast('请先选择照片');
  const yes = await dialog({ title: '还原照片', msg: '清除这张照片的旋转、镜像与裁剪？', buttons: [{ label: '否', value: 0, cls: 'no' }, { label: '是', value: 1, cls: 'yes' }] });
  if (!yes) return;
  p.tf = { rot: 0, flipH: false, flipV: false, fine: 0 };
  p.crop = null; p.items = []; state.sel = null;
  $('#rngFine').value = 0; $('#valFine').textContent = '0°';
  rebuildPreview(); updateInfo(); renderLibrary();
};
$('#btnDeletePhoto').onclick = async () => {
  const i = state.cur; if (i < 0) return toast('请先选择照片');
  const yes = await dialog({ title: '移除照片', msg: '把当前照片从列表中移除？', buttons: [{ label: '否', value: 0, cls: 'no' }, { label: '是', value: 1, cls: 'yes' }] });
  if (!yes) return;
  state.photos.splice(i, 1);
  if (state.cur >= state.photos.length) state.cur = state.photos.length - 1;
  state.sel = null;
  await rebuildPreview(); renderThumbs(); updateInfo();
};

/* 保存 */
$('#btnSaveAll').onclick = () => saveList(state.photos.map((_, i) => i));
$('#btnSaveAll2').onclick = () => saveList(state.photos.map((_, i) => i));
$('#btnSaveCur').onclick = () => { if (state.cur < 0) return toast('请先选择照片'); saveList([state.cur]); };

/* 一键重置（二级确认） */
async function globalReset() {
  const yes = await confirmTwice(
    { title: '重置全部参数', msg: '将清除所有照片的水印摆放、缩放/旋转/不透明度、旋转镜像与裁剪设置。\n水印库中的水印会保留。', ok: '确认重置', cancel: '取消' },
    { title: '再次确认', msg: '此操作不可撤销，是否确定重置？', }
  );
  if (!yes) return;
  state.photos.forEach((p) => {
    p.items = [];
    p.tf = { rot: 0, flipH: false, flipV: false, fine: 0 };
    p.crop = null;
  });
  state.sel = null;
  state.defaults = { scale: 0.20, rotPct: 0, opacity: 1, gap: 25, gapAuto: true, tile: false };
  state.outPng = false;
  state.quality = 0.98;
  $('#chkPng').checked = false;
  $('#rowQuality').style.display = '';
  $('#rngQuality').value = 98; $('#valQuality').textContent = '98%';
  $('#rngFine').value = 0; $('#valFine').textContent = '0°';
  if (state.cropMode) exitCrop();
  await rebuildPreview();
  renderThumbs(); updateInfo(); renderLibrary();
  toast('已重置全部参数');
}
$('#btnGlobalReset').onclick = globalReset;
$('#btnGlobalReset2').onclick = globalReset;

/* 窗口尺寸变化 */
let rzT = null;
window.addEventListener('resize', () => { clearTimeout(rzT); rzT = setTimeout(() => { layoutStage(); drawWmLayer(); }, 150); });
window.addEventListener('orientationchange', () => setTimeout(() => { layoutStage(); drawWmLayer(); }, 300));

/* Android 返回键：优先关闭浮层 */
window.__onAndroidBack = function () {
  if (!$('#tedit').hidden) { $('#tedit').hidden = true; tEditId = null; return true; }
  if (!$('#modal').hidden) { $('#modal').hidden = true; return true; }
  if (!$('#sheet').hidden) { $('#sheet').hidden = true; return true; }
  if (state.cropMode) { exitCrop(); return true; }
  if (state.sel) { state.sel = null; refreshSelection(); return true; }
  return false;
};

/* =========================================================
   启动
   ========================================================= */
(function boot() {
  libLoad().then(() => { ensureLibImages(); });
  syncSliders();
  updateInfo();
  layoutStage();
  if (!bridge) {
    console.log('浏览器预览模式（导出将直接下载文件）');
  }
})();
