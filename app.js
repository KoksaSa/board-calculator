// ============================================================
// Калькулятор досок — клиентское приложение (без сервера)
// ============================================================

// --- Состояние ---
let components = [];
let crossSections = [];
let cutResults = [];

// --- Утилиты ---
function ensureArray(val) {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' Б';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' КБ';
  return (bytes / 1048576).toFixed(1) + ' МБ';
}

function $(id) { return document.getElementById(id); }

function showError(msg) {
  const box = $('error-box');
  const text = $('error-text');
  if (box && text) {
    text.textContent = msg;
    box.classList.remove('hidden');
  }
}

// --- DAE-парсер (COLLADA XML, работает в браузере через DOMParser) ---
function parseDAE(text) {
  const warnings = [];
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'text/xml');

  const parseError = doc.querySelector('parsererror');
  if (parseError) throw new Error('Не удалось разобрать XML-структуру DAE файла');

  // Единицы измерения
  const unitEl = doc.querySelector('asset unit');
  const unitMeter = unitEl ? parseFloat(unitEl.getAttribute('meter')) || 1 : 1;
  const unitName = unitEl ? unitEl.getAttribute('name') || 'meter' : 'meter';
  const toMm = unitMeter * 1000;

  // Извлечь BBox геометрий
  const geometryBBoxes = new Map();
  const geometries = doc.querySelectorAll('library_geometries geometry');
  geometries.forEach(geom => {
    const id = geom.getAttribute('id');
    const name = geom.getAttribute('name') || id;
    if (!id) return;

    // Найти float_array с позициями
    let allVerts = [];
    const sources = geom.querySelectorAll('mesh source');
    let found = false;

    // Стратегия 1: источник с XYZ параметрами
    sources.forEach(src => {
      if (found) return;
      const accessor = src.querySelector('technique_common accessor');
      if (!accessor) return;
      const stride = parseInt(accessor.getAttribute('stride')) || 0;
      if (stride !== 3) return;
      const params = accessor.querySelectorAll('param');
      const paramNames = Array.from(params).map(p => p.getAttribute('name') || '');
      if (!paramNames.includes('X') && !paramNames.includes('Y')) return;

      const fa = src.querySelector('float_array');
      if (!fa) return;
      const text = fa.textContent || fa.firstChild?.textContent || '';
      const verts = parsePositions(text);
      if (verts.length >= 2) { allVerts = verts; found = true; }
    });

    // Стратегия 2: первый источник со stride=3
    if (!found) {
      sources.forEach(src => {
        if (found) return;
        const accessor = src.querySelector('technique_common accessor');
        if (!accessor) return;
        const stride = parseInt(accessor.getAttribute('stride')) || 0;
        if (stride !== 3) return;
        const fa = src.querySelector('float_array');
        if (!fa) return;
        const text = fa.textContent || fa.firstChild?.textContent || '';
        const verts = parsePositions(text);
        if (verts.length >= 2) { allVerts = verts; found = true; }
      });
    }

    if (allVerts.length < 2) return;
    let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity, minZ=Infinity, maxZ=-Infinity;
    for (const [x,y,z] of allVerts) {
      minX=Math.min(minX,x); maxX=Math.max(maxX,x);
      minY=Math.min(minY,y); maxY=Math.max(maxY,y);
      minZ=Math.min(minZ,z); maxZ=Math.max(maxZ,z);
    }
    geometryBBoxes.set(id, { id, name, minX, maxX, minY, maxY, minZ, maxZ });
  });

  // Определения компонентов (library_nodes + visual_scene)
  const nodeDefs = new Map();

  function collectNodeDef(node) {
    const id = node.getAttribute('id');
    const name = node.getAttribute('name') || id;
    if (!id) return;
    // Пропускаем узлы-размещения (instance_node) — нам нужны только определения (instance_geometry)
    if (node.querySelector(':scope > instance_node') && !node.querySelector(':scope > instance_geometry')) return;
    const geomRefs = [];
    node.querySelectorAll('instance_geometry').forEach(ig => {
      const url = ig.getAttribute('url');
      if (url) geomRefs.push(url.startsWith('#') ? url.slice(1) : url);
    });
    const childRefs = [];
    node.querySelectorAll(':scope > instance_node').forEach(in_ => {
      const url = in_.getAttribute('url');
      if (url) childRefs.push(url.startsWith('#') ? url.slice(1) : url);
    });
    if (geomRefs.length > 0 || childRefs.length > 0) {
      nodeDefs.set(id, { id, name, geomRefs, childRefs });
    }
  }

  // Сначала из library_nodes
  doc.querySelectorAll('library_nodes node').forEach(node => collectNodeDef(node));

  // Затем из visual_scene (SketchUp часто помещает определения компонентов прямо туда)
  if (nodeDefs.size === 0) {
    doc.querySelectorAll('library_visual_scenes visual_scene node node').forEach(node => collectNodeDef(node));
  }

  // Подсчёт экземпляров компонентов в visual scenes
  const instanceCounts = new Map();
  function processNode(node) {
    // Считаем только ПРЯМЫЕ дочерние instance_node (не рекурсивно, чтобы избежать двойного счёта)
    node.querySelectorAll(':scope > instance_node').forEach(in_ => {
      const url = in_.getAttribute('url');
      if (url) {
        const ref = url.startsWith('#') ? url.slice(1) : url;
        instanceCounts.set(ref, (instanceCounts.get(ref) || 0) + 1);
      }
    });
    node.querySelectorAll(':scope > node').forEach(child => processNode(child));
  }
  doc.querySelectorAll('library_visual_scenes visual_scene > node').forEach(n => processNode(n));

  // Вычисление размеров узлов
  function computeNodeDims(nodeDef, visited) {
    if (visited.has(nodeDef.id)) return null;
    visited.add(nodeDef.id);

    let oMinX=Infinity, oMaxX=-Infinity, oMinY=Infinity, oMaxY=-Infinity, oMinZ=Infinity, oMaxZ=-Infinity;
    let hasAny = false;

    for (const gr of nodeDef.geomRefs) {
      const bbox = geometryBBoxes.get(gr);
      if (bbox) {
        oMinX=Math.min(oMinX,bbox.minX); oMaxX=Math.max(oMaxX,bbox.maxX);
        oMinY=Math.min(oMinY,bbox.minY); oMaxY=Math.max(oMaxY,bbox.maxY);
        oMinZ=Math.min(oMinZ,bbox.minZ); oMaxZ=Math.max(oMaxZ,bbox.maxZ);
        hasAny=true;
      }
    }

    for (const cr of nodeDef.childRefs) {
      const child = nodeDefs.get(cr);
      if (child) {
        const r = computeNodeDims(child, visited);
        if (r) {
          const h = [r[0]/2, r[1]/2, r[2]/2];
          oMinX=Math.min(oMinX,-h[2]); oMaxX=Math.max(oMaxX,h[2]);
          oMinY=Math.min(oMinY,-h[0]); oMaxY=Math.max(oMaxY,h[0]);
          oMinZ=Math.min(oMinZ,-h[1]); oMaxZ=Math.max(oMaxZ,h[1]);
          hasAny=true;
        }
      }
    }

    if (!hasAny) return null;
    return [Math.abs(oMaxX-oMinX), Math.abs(oMaxY-oMinY), Math.abs(oMaxZ-oMinZ)];
  }

  // Формирование компонентов
  const result = [];

  if (nodeDefs.size > 0 && instanceCounts.size > 0) {
    for (const [nodeId, count] of instanceCounts) {
      const nodeDef = nodeDefs.get(nodeId);
      if (!nodeDef) { warnings.push(`Ссылка на "${nodeId}" (${count} шт.) — определение не найдено`); continue; }
      if (nodeDef.name.startsWith('skp_camera')) continue;

      const dims = computeNodeDims(nodeDef, new Set());
      let thickness, width, length;

      if (dims) {
        const sorted = [...dims].sort((a,b) => a-b);
        const significant = sorted.filter(d => d * toMm > 0.5);
        if (significant.length < 3) { warnings.push(`"${nodeDef.name}" (${count} шт.) — не доскообразный объект`); continue; }
        thickness = Math.round(sorted[0] * toMm);
        width = Math.round(sorted[1] * toMm);
        length = Math.round(sorted[2] * toMm);
      } else {
        // Попробовать из имени
        const nd = parseDimsFromName(nodeDef.name);
        if (nd) { thickness=nd.thickness; width=nd.width; length=nd.length; }
        else { warnings.push(`Не удалось определить размеры "${nodeDef.name}" (${count} шт.)`); continue; }
      }

      if (thickness < 1 && width < 1 && length < 1) continue;

      result.push({ id: crypto.randomUUID(), name: nodeDef.name, thickness, width, length, count });
    }
  }

  // Fallback: простой DAE без library_nodes — считаем instance_geometry
  if (result.length === 0 && geometryBBoxes.size > 0) {
    const geomCounts = new Map();
    function countGeomInNode(node) {
      node.querySelectorAll('instance_geometry').forEach(ig => {
        const url = ig.getAttribute('url');
        if (url) {
          const ref = url.startsWith('#') ? url.slice(1) : url;
          geomCounts.set(ref, (geomCounts.get(ref) || 0) + 1);
        }
      });
      node.querySelectorAll('node').forEach(n => countGeomInNode(n));
    }
    doc.querySelectorAll('library_visual_scenes visual_scene > node').forEach(n => countGeomInNode(n));

    for (const [geomId, count] of geomCounts) {
      const bbox = geometryBBoxes.get(geomId);
      if (!bbox) continue;
      const dims = [
        Math.abs(bbox.maxX-bbox.minX)*toMm,
        Math.abs(bbox.maxY-bbox.minY)*toMm,
        Math.abs(bbox.maxZ-bbox.minZ)*toMm
      ].sort((a,b) => a-b);
      if (dims.filter(d=>d>0.5).length < 3) continue;
      result.push({
        id: crypto.randomUUID(), name: bbox.name || geomId,
        thickness: Math.round(dims[0]), width: Math.round(dims[1]), length: Math.round(dims[2]), count
      });
    }
  }

  if (result.length === 0) warnings.push('Не удалось извлечь компоненты-доски из файла.');

  return { components: result, warnings, unitInfo: { meter: unitMeter, name: unitName } };
}

function parsePositions(text) {
  const values = text.trim().split(/\s+/).map(Number).filter(v => !isNaN(v));
  const verts = [];
  for (let i = 0; i + 2 < values.length; i += 3) verts.push([values[i], values[i+1], values[i+2]]);
  return verts;
}

function parseDimsFromName(name) {
  const m = name.match(/(\d+)\s*[xхX]\s*(\d+)(?:\s*[xхX]\s*(\d+))?/);
  if (!m) return null;
  const dims = [Number(m[1]), Number(m[2])];
  if (m[3]) dims.push(Number(m[3]));
  if (dims.length < 3) return null;
  dims.sort((a,b) => a-b);
  return { thickness: dims[0], width: dims[1], length: dims[2] };
}

// --- SKP-парсер (бинарный, эвристика) ---
function parseSKP(buffer) {
  const warnings = [];
  const view = new Uint8Array(buffer);
  const names = new Map();

  // Извлечение строк из бинарника
  function extractStrings() {
    const result = [];
    // UTF-8 строки
    let str = '';
    for (let i = 0; i < view.length; i++) {
      const b = view[i];
      if (b >= 32 && b < 127) { str += String.fromCharCode(b); }
      else { if (str.length >= 4) result.push(str); str = ''; }
    }
    if (str.length >= 4) result.push(str);

    // UTF-16LE строки
    str = '';
    for (let i = 0; i + 1 < view.length; i += 2) {
      const code = view[i] | (view[i+1] << 8);
      if (code >= 32 && code < 127) { str += String.fromCharCode(code); }
      else { if (str.length >= 4) result.push(str); str = ''; }
    }
    return result;
  }

  const skipPatterns = /^(Component|Edge|Face|Vertex|Material|Layer|Group|Drawing|Model|Scene|Camera|Sun|Shadow|Style|Section|Image|Text|Dimension|Guide|Construction|Axes|Origin|Inset|texture|shader|polygon|line|arc|circle|curve|surface|mesh|skp_|SU|SketchUp|Active|ComponentDefinition|ComponentInstance|Entities|DrawingElement|Transformation|LengthFormatter|AngleFormatter|Point|Vector|Vector3d|Matrix|Array|Hash|String|Integer|Float|Boolean|Object|NilClass|Numeric|Comparable|Enumerable|Precision|Length|Volume|Area|Weight|Color|UV|XYZ|position|rotation|scale|translation|scaling|identity|inverse|origin|xaxis|yaxis|zaxis|identity\?|valid\?|nil\?)/i;

  function isComponentName(s) {
    if (s.length < 4 || s.length > 200) return false;
    if (skipPatterns.test(s)) return false;
    if (/^[0-9\s\W]+$/.test(s)) return false;
    if (!/[a-zA-Zа-яА-ЯёЁ]/.test(s)) return false;
    return true;
  }

  const strings = extractStrings();
  for (const s of strings) {
    if (isComponentName(s)) {
      const dimMatch = s.match(/(\d+)\s*[xхX]\s*(\d+)(?:\s*[xхX]\s*(\d+))?/);
      if (dimMatch) {
        names.set(s, (names.get(s) || 0) + 1);
      }
    }
  }

  const result = [];
  for (const [name, rawCount] of names) {
    const count = Math.max(1, Math.round(rawCount / 2)); // SKP дублирует
    const nd = parseDimsFromName(name);
    if (nd) {
      result.push({ id: crypto.randomUUID(), name, thickness: nd.thickness, width: nd.width, length: nd.length, count });
    }
  }

  if (result.length === 0) warnings.push('Не удалось найти компоненты с размерами в SKP файле. Попробуйте экспортировать в .dae');
  return { components: result, warnings };
}

// --- Раскрой досок (First Fit Decreasing) ---
function optimizeCutting(pieces, standardLength) {
  const items = [];
  for (const p of pieces) {
    for (let i = 0; i < p.count; i++) {
      items.push({ length: p.length, name: p.names[0] || p.length + ' мм' });
    }
  }
  items.sort((a, b) => b.length - a.length);

  const bins = [];
  for (const item of items) {
    let placed = false;
    for (const bin of bins) {
      if (bin.remaining >= item.length) {
        bin.cuts.push({ length: item.length, name: item.name });
        bin.remaining -= item.length;
        placed = true;
        break;
      }
    }
    if (!placed) {
      bins.push({ remaining: standardLength - item.length, cuts: [{ length: item.length, name: item.name }] });
    }
  }

  const totalWaste = bins.reduce((s, b) => s + b.remaining, 0);
  const totalAvailable = bins.length * standardLength;
  const wastePercent = totalAvailable > 0 ? Math.round((totalWaste / totalAvailable) * 1000) / 10 : 0;
  const totalLinearM = items.reduce((s, it) => s + it.length, 0) / 1000;

  return {
    boardsToBuy: bins.length,
    cutPlan: bins.map((b, i) => ({
      boardIndex: i + 1,
      standardLength,
      cuts: b.cuts,
      waste: b.remaining
    })),
    totalWaste,
    wastePercent,
    totalLinearM: Math.round(totalLinearM * 100) / 100
  };
}

// --- Группировка по сечениям ---
function buildCrossSections(comps) {
  const groups = new Map();
  for (const c of comps) {
    const key = c.thickness + '×' + c.width;
    if (!groups.has(key)) {
      groups.set(key, { key, thickness: c.thickness, width: c.width, pieces: [], standardLength: 6000 });
    }
    const g = groups.get(key);
    const existing = g.pieces.find(p => p.length === c.length);
    if (existing) {
      existing.count += c.count;
      if (!existing.names.includes(c.name)) existing.names.push(c.name);
    } else {
      g.pieces.push({ length: c.length, count: c.count, names: [c.name] });
    }
  }
  for (const g of groups.values()) g.pieces.sort((a, b) => b.length - a.length);
  return Array.from(groups.values()).sort((a, b) => a.thickness !== b.thickness ? a.thickness - b.thickness : a.width - b.width);
}

// --- Отрисовка UI ---
function render() {
  if (components.length === 0) {
    $('results').classList.add('hidden');
    $('btn-clear').classList.add('hidden');
    return;
  }

  $('results').classList.remove('hidden');
  $('btn-clear').classList.remove('hidden');

  // Статистика
  const totalCount = components.reduce((s, c) => s + c.count, 0);
  const totalVolume = components.reduce((s, c) => s + c.count * c.thickness * c.width * c.length / 1e9, 0);
  const totalLinear = components.reduce((s, c) => s + c.count * c.length / 1000, 0);
  $('stat-types').textContent = components.length;
  $('stat-total').textContent = totalCount;
  $('stat-volume').textContent = totalVolume.toFixed(3);
  $('stat-linear').textContent = totalLinear.toFixed(1);

  // Таблица компонентов с кнопкой удаления
  const tbody = $('table-body');
  tbody.innerHTML = '';
  components.forEach((c, i) => {
    const tr = document.createElement('tr');
    tr.className = i % 2 === 1 ? 'bg-amber-50/30' : '';
    tr.innerHTML = `
      <td class="px-3 py-2 text-center text-gray-500">${i + 1}</td>
      <td class="px-3 py-2 font-medium" title="${c.name}">${c.name}</td>
      <td class="px-3 py-2">${c.thickness}×${c.width}</td>
      <td class="px-3 py-2">${c.length}</td>
      <td class="px-3 py-2 text-center">${c.count}</td>
      <td class="px-3 py-2 text-right">${(c.count * c.length / 1000).toFixed(2)}</td>
      <td class="px-3 py-2 text-right">${(c.count * c.thickness * c.width * c.length / 1e9).toFixed(4)}</td>
      <td class="px-3 py-2 text-center">
        <button data-id="${c.id}" class="del-comp-btn p-1 rounded hover:bg-red-100 text-red-400 hover:text-red-600 transition" title="Удалить позицию">
          <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
  // Итого
  const tr = document.createElement('tr');
  tr.className = 'bg-amber-100/60 font-semibold';
  tr.innerHTML = `
    <td colspan="4" class="px-3 py-2 text-right">Итого:</td>
    <td class="px-3 py-2 text-center">${totalCount}</td>
    <td class="px-3 py-2 text-right">${totalLinear.toFixed(2)}</td>
    <td class="px-3 py-2 text-right">${totalVolume.toFixed(4)}</td>
    <td></td>
  `;
  tbody.appendChild(tr);

  // Слушатели удаления компонентов
  tbody.querySelectorAll('.del-comp-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      components = components.filter(c => c.id !== id);
      crossSections = buildCrossSections(components);
      cutResults = [];
      render();
      renderCutResults();
    });
  });

  // Сечения для раскроя
  renderCrossSections();
}

function renderCrossSections() {
  const container = $('cross-sections');
  container.innerHTML = '';
  crossSections.forEach(cs => {
    const totalPieces = cs.pieces.reduce((s, p) => s + p.count, 0);
    const lengths = cs.pieces.map(p => p.length).join(', ');
    const div = document.createElement('div');
    div.className = 'flex flex-col sm:flex-row sm:items-center gap-2 p-3 bg-amber-50/50 rounded-lg border border-amber-100';
    div.innerHTML = `
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <span class="font-semibold text-sm">${cs.key} мм</span>
          <span class="text-xs text-gray-500">(${cs.thickness}×${cs.width})</span>
        </div>
        <div class="text-xs text-gray-500 mt-0.5">${totalPieces} шт. • длины: ${lengths} мм</div>
      </div>
      <div class="flex items-center gap-2">
        <label class="text-xs text-gray-500 whitespace-nowrap">Станд. длина:</label>
        <input type="number" min="1" step="1" value="${cs.standardLength}" data-key="${cs.key}" class="std-length h-8 w-28 text-center text-sm border rounded-md px-2">
        <span class="text-xs text-gray-500">мм</span>
      </div>
    `;
    container.appendChild(div);
  });

  // Слушатели для изменения стандартной длины
  container.querySelectorAll('.std-length').forEach(input => {
    input.addEventListener('change', () => {
      const key = input.dataset.key;
      const val = parseInt(input.value, 10);
      if (!isNaN(val) && val > 0) {
        const cs = crossSections.find(c => c.key === key);
        if (cs) cs.standardLength = val;
      }
    });
  });
}

function renderCutResults() {
  if (cutResults.length === 0) {
    $('cut-summary').classList.add('hidden');
    $('cut-details').classList.add('hidden');
    $('btn-reset-cut').classList.add('hidden');
    $('add-cut-board').classList.add('hidden');
    $('btn-pdf').classList.add('hidden');
    updateTotalCost();
    return;
  }

  $('btn-reset-cut').classList.remove('hidden');
  $('add-cut-board').classList.remove('hidden');
  $('btn-pdf').classList.remove('hidden');

  // Summary cards
  const totalBoards = cutResults.reduce((s, r) => s + r.boardsToBuy, 0);
  const avgWaste = Math.round(cutResults.reduce((s, r) => s + r.wastePercent, 0) / cutResults.length * 10) / 10;
  const totalLinear = cutResults.reduce((s, r) => s + r.totalLinearM, 0);

  const summary = $('cut-summary');
  summary.classList.remove('hidden');
  summary.innerHTML = `
    <div class="bg-amber-50 rounded-lg p-3 border border-amber-100"><div class="flex items-center gap-2"><svg class="h-4 w-4 text-amber-600" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 002 1.61h9.72a2 2 0 002-1.61L23 6H6"/></svg><span class="text-xs text-gray-500">Досок купить</span></div><p class="text-xl font-bold mt-1">${totalBoards}</p></div>
    <div class="bg-amber-50 rounded-lg p-3 border border-amber-100"><div class="flex items-center gap-2"><svg class="h-4 w-4 text-orange-600" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21.3 15.3a2.4 2.4 0 010 3.4l-2.6 2.6a2.4 2.4 0 01-3.4 0L2.7 8.7a2.41 2.41 0 010-3.4l2.6-2.6a2.41 2.41 0 013.4 0z"/></svg><span class="text-xs text-gray-500">Сечений</span></div><p class="text-xl font-bold mt-1">${cutResults.length}</p></div>
    <div class="bg-amber-50 rounded-lg p-3 border border-amber-100"><div class="flex items-center gap-2"><svg class="h-4 w-4 text-yellow-600" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="8 3 4 7 8 11"/><polyline points="16 3 20 7 16 11"/><line x1="4" y1="7" x2="20" y2="7"/></svg><span class="text-xs text-gray-500">Пог. м</span></div><p class="text-xl font-bold mt-1">${totalLinear.toFixed(1)}</p></div>
    <div class="bg-amber-50 rounded-lg p-3 border border-amber-100"><div class="flex items-center gap-2"><svg class="h-4 w-4 text-red-500" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg><span class="text-xs text-gray-500">Отходы</span></div><p class="text-xl font-bold mt-1">${avgWaste}%</p></div>
  `;

  // Detailed cut plan
  const details = $('cut-details');
  details.classList.remove('hidden');
  const plan = $('cut-plan');
  plan.innerHTML = '';

  // Цвета для сегментов
  const segColors = ['#d97706','#b45309','#92400e','#78350f','#f59e0b','#fbbf24','#fcd34d','#ca8a04','#a16207','#854d0e'];

  cutResults.forEach((result, resultIdx) => {
    const cs = crossSections.find(c => c.key === result.crossSectionKey);
    if (!cs) return;

    const section = document.createElement('div');
    section.className = 'border rounded-xl overflow-hidden';

    // Header с кнопками ± для количества досок
    const header = document.createElement('div');
    header.className = 'w-full flex items-center justify-between p-4 bg-amber-50/80';
    header.innerHTML = `
      <div class="flex items-center gap-3">
        <span class="font-bold text-base">${result.crossSectionKey}</span>
        <span class="text-sm text-gray-500">${result.thickness}×${result.width} мм</span>
      </div>
      <div class="flex items-center gap-3">
        <div class="flex items-center gap-1">
          <button data-result="${resultIdx}" data-action="board-dec" class="board-cnt-btn w-7 h-7 flex items-center justify-center rounded bg-amber-200 hover:bg-amber-300 text-amber-800 text-sm font-bold transition" title="Убрать доску">−</button>
          <span class="text-sm font-semibold text-amber-700 min-w-[60px] text-center">Купить: ${result.boardsToBuy} досок</span>
          <button data-result="${resultIdx}" data-action="board-inc" class="board-cnt-btn w-7 h-7 flex items-center justify-center rounded bg-amber-200 hover:bg-amber-300 text-amber-800 text-sm font-bold transition" title="Добавить доску">+</button>
        </div>
        <div class="text-right text-xs text-gray-500">
          по ${result.standardLength} мм • отходы ${result.wastePercent}%
        </div>
        <button class="chevron-btn p-1 rounded hover:bg-amber-200 transition" title="Развернуть/свернуть">
          <svg class="h-5 w-5 text-gray-400 chevron transition-transform" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
      </div>
    `;

    const body = document.createElement('div');
    body.className = 'hidden p-4 space-y-2 bg-white';

    // Разворачивание/сворачивание
    header.querySelector('.chevron-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const open = !body.classList.contains('hidden');
      body.classList.toggle('hidden');
      header.querySelector('.chevron').style.transform = open ? '' : 'rotate(180deg)';
    });

    // Board bars
    result.cutPlan.forEach((board, boardIdx) => {
      const boardDiv = document.createElement('div');
      boardDiv.className = 'border rounded-lg p-3 relative';

      const usedLength = board.cuts.reduce((s, c) => s + c.length, 0);
      const usedPct = Math.round(usedLength / board.standardLength * 100);

      // Визуальная полоска раскроя
      let barHTML = '<div class="board-bar mt-1 mb-2">';
      let offset = 0;
      board.cuts.forEach((cut, ci) => {
        const pct = (cut.length / board.standardLength * 100).toFixed(1);
        const color = segColors[ci % segColors.length];
        barHTML += `<div class="segment" style="left:${offset}%;width:${pct}%;background:${color}" title="${cut.name}: ${cut.length} мм">${cut.length}</div>`;
        offset += parseFloat(pct);
      });
      // Остаток
      if (board.waste > 0) {
        const wastePct = (board.waste / board.standardLength * 100).toFixed(1);
        barHTML += `<div class="segment waste-seg" style="left:${offset}%;width:${wastePct}%" title="Остаток: ${board.waste} мм"></div>`;
      }
      barHTML += '</div>';

      // Список резов
      let cutsHTML = board.cuts.map(c => `<span class="inline-block text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded mr-1 mb-1">${c.name}: ${c.length} мм</span>`).join('');

      // Кнопка удаления доски
      const isEmpty = board.cuts.length === 0;
      boardDiv.innerHTML = `
        <div class="flex items-center justify-between text-sm">
          <span class="font-medium">${isEmpty ? 'Пустая доска' : result.crossSectionKey + ' — Доска #' + board.boardIndex}</span>
          <div class="flex items-center gap-2">
            <span class="text-gray-500">${usedLength}/${board.standardLength} мм (${usedPct}%)</span>
            <button data-result="${resultIdx}" data-board="${boardIdx}" data-action="del-board" class="del-board-btn p-1 rounded hover:bg-red-100 text-red-400 hover:text-red-600 transition" title="Удалить эту доску">
              <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
            </button>
          </div>
        </div>
        ${barHTML}
        <div class="flex items-center justify-between gap-2">
          <div class="flex flex-wrap items-center gap-1">
            ${cutsHTML}
          </div>
          ${board.waste > 0 ? '<span class="text-xs bg-red-50 text-red-600 px-2 py-0.5 rounded whitespace-nowrap">Остаток: ' + board.waste + ' мм</span>' : ''}
        </div>
      `;
      body.appendChild(boardDiv);
    });

    // Итого по сечению
    const footer = document.createElement('div');
    footer.className = 'mt-3 flex items-center justify-between text-sm text-gray-500 pt-2 border-t';
    footer.innerHTML = `
      <span>Всего отходов: ${result.totalWaste} мм (${result.wastePercent}%)</span>
      <span>${result.boardsToBuy} досок × ${result.standardLength} мм = ${(result.boardsToBuy * result.standardLength / 1000).toFixed(1)} пог. м</span>
    `;
    body.appendChild(footer);

    section.appendChild(header);
    section.appendChild(body);
    plan.appendChild(section);
  });

  // --- Слушатели: +/- досок в сечении ---
  plan.querySelectorAll('.board-cnt-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const resultIdx = parseInt(btn.dataset.result);
      const action = btn.dataset.action;
      const result = cutResults[resultIdx];
      if (!result) return;

      if (action === 'board-inc') {
        // Добавить пустую доску
        result.cutPlan.push({
          boardIndex: result.cutPlan.length + 1,
          standardLength: result.standardLength,
          cuts: [],
          waste: result.standardLength
        });
        result.boardsToBuy++;
        // Пересчитать отходы
        recalcCutResult(result);
      } else if (action === 'board-dec') {
        if (result.boardsToBuy <= 0) return;
        // Удалить последнюю доску
        result.cutPlan.pop();
        result.boardsToBuy = Math.max(0, result.boardsToBuy - 1);
        // Перенумеровать
        result.cutPlan.forEach((b, i) => b.boardIndex = i + 1);
        recalcCutResult(result);
      }

      renderCutResults();
    });
  });

  // --- Слушатели: удаление конкретной доски ---
  plan.querySelectorAll('.del-board-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const resultIdx = parseInt(btn.dataset.result);
      const boardIdx = parseInt(btn.dataset.board);
      const result = cutResults[resultIdx];
      if (!result) return;

      const board = result.cutPlan[boardIdx];
      if (!board) return;

      result.cutPlan.splice(boardIdx, 1);
      result.boardsToBuy = result.cutPlan.length;
      result.cutPlan.forEach((b, i) => b.boardIndex = i + 1);
      recalcCutResult(result);

      renderCutResults();
    });
  });

  // Обновить стоимость
  updateTotalCost();
}

// Пересчёт отходов и итогов для одного сечения
function recalcCutResult(result) {
  const totalWaste = result.cutPlan.reduce((s, b) => {
    const used = b.cuts.reduce((s2, c) => s2 + c.length, 0);
    b.waste = b.standardLength - used;
    return s + b.waste;
  }, 0);
  const totalAvailable = result.cutPlan.length * result.standardLength;
  result.totalWaste = totalWaste;
  result.wastePercent = totalAvailable > 0 ? Math.round((totalWaste / totalAvailable) * 1000) / 10 : 0;
  result.boardsToBuy = result.cutPlan.length;
}

// Обновление стоимости
function updateTotalCost() {
  const pricePerCube = parseFloat($('price-per-cube')?.value) || 0;
  const costEl = $('total-cost');

  if (pricePerCube <= 0 || cutResults.length === 0) {
    if (costEl) costEl.classList.add('hidden');
    return;
  }

  // Объём покупаемых досок: для каждого сечения — кол-во досок × толщина × ширина × станд.длина
  let totalVolume = 0;
  cutResults.forEach(r => {
    const stdLen = r.standardLength || r.cutPlan?.[0]?.standardLength || 0;
    const vol = (r.boardsToBuy || 0) * (r.thickness || 0) * (r.width || 0) * stdLen / 1e9;
    if (!isNaN(vol)) totalVolume += vol;
  });
  const totalCost = totalVolume * pricePerCube;

  if (isNaN(totalCost) || isNaN(totalVolume)) {
    if (costEl) costEl.classList.add('hidden');
    return;
  }

  if (costEl) {
    costEl.classList.remove('hidden');
    costEl.innerHTML = `Объём: ${totalVolume.toFixed(4)} м³ × ${pricePerCube.toLocaleString('ru-RU')} руб. = <span class="text-amber-900">${totalCost.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} руб.</span>`;
  }
}

// --- CSV экспорт ---
function exportCSV() {
  const BOM = '\uFEFF';
  const sep = ';';
  const lines = [];

  // === Секция 1: Перечень материалов ===
  lines.push('=== ПЕРЕЧЕНЬ МАТЕРИАЛОВ ===');
  lines.push(['№', 'Название', 'Толщина (мм)', 'Ширина (мм)', 'Длина (мм)', 'Количество', 'Погонные метры', 'Объём (м³)'].join(sep));
  components.forEach((c, i) => {
    lines.push([
      i + 1,
      c.name,
      c.thickness,
      c.width,
      c.length,
      c.count,
      (c.count * c.length / 1000).toFixed(2),
      (c.count * c.thickness * c.width * c.length / 1e9).toFixed(4)
    ].join(sep));
  });
  const totalCount = components.reduce((s, c) => s + c.count, 0);
  const totalLinear = components.reduce((s, c) => s + c.count * c.length / 1000, 0);
  const totalVolume = components.reduce((s, c) => s + c.count * c.thickness * c.width * c.length / 1e9, 0);
  lines.push(['', '', '', '', '', 'Итого: ' + totalCount, totalLinear.toFixed(2), totalVolume.toFixed(4)].join(sep));

  // === Секция 2: Раскрой досок ===
  if (cutResults.length > 0) {
    lines.push('');
    lines.push('=== РАСКРОЙ ДОСОК ===');

    // Сводка по сечениям
    lines.push('');
    lines.push('--- Сводка по сечениям ---');
    lines.push(['Сечение', 'Толщина (мм)', 'Ширина (мм)', 'Станд. длина (мм)', 'Досок купить', 'Пог. м', 'Отходы (мм)', 'Отходы (%)'].join(sep));
    cutResults.forEach(r => {
      lines.push([
        r.crossSectionKey,
        r.thickness,
        r.width,
        r.standardLength,
        r.boardsToBuy,
        r.totalLinearM.toFixed(2),
        r.totalWaste,
        r.wastePercent
      ].join(sep));
    });

    const totalBoards = cutResults.reduce((s, r) => s + r.boardsToBuy, 0);
    const totalWasteAll = cutResults.reduce((s, r) => s + r.totalWaste, 0);
    const totalLinearAll = cutResults.reduce((s, r) => s + r.totalLinearM, 0);
    const totalAvailAll = cutResults.reduce((s, r) => s + r.boardsToBuy * r.standardLength, 0);
    const avgWastePct = totalAvailAll > 0 ? Math.round((totalWasteAll / totalAvailAll) * 1000) / 10 : 0;
    lines.push(['Итого', '', '', '', totalBoards, totalLinearAll.toFixed(2), totalWasteAll, avgWastePct].join(sep));

    // Подробный раскрой по каждой доске
    lines.push('');
    lines.push('--- Подробный раскрой ---');
    lines.push(['Сечение', 'Доска №', 'Станд. длина (мм)', 'Деталь', 'Длина детали (мм)', 'Использовано (мм)', 'Остаток (мм)', 'Использование (%)'].join(sep));

    cutResults.forEach(r => {
      r.cutPlan.forEach(board => {
        const usedLength = board.cuts.reduce((s, c) => s + c.length, 0);
        const usedPct = Math.round(usedLength / board.standardLength * 100);

        if (board.cuts.length === 1) {
          const cut = board.cuts[0];
          lines.push([
            r.crossSectionKey,
            board.boardIndex,
            board.standardLength,
            cut.name,
            cut.length,
            usedLength,
            board.waste,
            usedPct
          ].join(sep));
        } else {
          board.cuts.forEach((cut, ci) => {
            lines.push([
              r.crossSectionKey,
              board.boardIndex,
              board.standardLength,
              cut.name,
              cut.length,
              ci === board.cuts.length - 1 ? usedLength : '',
              ci === board.cuts.length - 1 ? board.waste : '',
              ci === board.cuts.length - 1 ? usedPct : ''
            ].join(sep));
          });
        }
      });
    });
  }

  // === Секция 3: Стоимость ===
  const pricePerCube = parseFloat($('price-per-cube')?.value) || 0;
  if (pricePerCube > 0 && cutResults.length > 0) {
    lines.push('');
    lines.push('=== СТОИМОСТЬ ===');
    lines.push(['Сечение', 'Досок купить', 'Толщина (мм)', 'Ширина (мм)', 'Станд. длина (мм)', 'Объём (м³)', 'Цена за м³', 'Стоимость (руб.)'].join(sep));
    let grandVolume = 0;
    let grandCost = 0;
    cutResults.forEach(r => {
      const stdLen = r.standardLength || r.cutPlan?.[0]?.standardLength || 0;
      const vol = (r.boardsToBuy || 0) * (r.thickness || 0) * (r.width || 0) * stdLen / 1e9;
      const cost = isNaN(vol) ? 0 : vol * pricePerCube;
      if (!isNaN(vol)) grandVolume += vol;
      if (!isNaN(cost)) grandCost += cost;
      lines.push([
        r.crossSectionKey,
        r.boardsToBuy,
        r.thickness,
        r.width,
        stdLen,
        isNaN(vol) ? '0.0000' : vol.toFixed(4),
        pricePerCube,
        Math.round(cost)
      ].join(sep));
    });
    lines.push(['Итого', '', '', '', '', grandVolume.toFixed(4), '', Math.round(grandCost)].join(sep));
  }

  const csv = BOM + lines.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'доски_каркасный_дом.csv'; a.click();
  URL.revokeObjectURL(url);
}

// --- PDF экспорт подробного раскроя (html2canvas + jsPDF) ---
async function exportPDF() {
  if (cutResults.length === 0) return;

  if (typeof html2canvas === 'undefined') {
    showError('Библиотека html2canvas не загружена. Проверьте подключение к интернету и перезагрузите страницу.');
    return;
  }
  if (typeof window.jspdf === 'undefined') {
    showError('Библиотека jsPDF не загружена. Проверьте подключение к интернету и перезагрузите страницу.');
    return;
  }

  const btn = $('btn-pdf');
  const origText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<svg class="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg> Генерация...';

  try {
    const pricePerCube = parseFloat($('price-per-cube')?.value) || 0;
    const segColors = ['#d97706','#b45309','#92400e','#78350f','#f59e0b','#fbbf24','#fcd34d','#ca8a04','#a16207','#854d0e'];

    // Собираем HTML для PDF — все секции развёрнуты, только inline-стили
    let html = '';
    html += '<div style="font-family:Arial,Helvetica,sans-serif;color:#1f2937;padding:24px;width:760px;background:#fff;">';
    html += '<h1 style="font-size:22px;margin:0 0 4px;color:#92400e;">Раскрой досок</h1>';
    html += '<p style="font-size:12px;color:#6b7280;margin:0 0 20px;">Каркасный дом — подробный раскрой</p>';

    // Сводная таблица
    const totalBoards = cutResults.reduce((s, r) => s + r.boardsToBuy, 0);
    const totalWasteAll = cutResults.reduce((s, r) => s + r.totalWaste, 0);
    const totalLinearAll = cutResults.reduce((s, r) => s + r.totalLinearM, 0);
    const totalAvailAll = cutResults.reduce((s, r) => s + r.boardsToBuy * r.standardLength, 0);
    const avgWastePct = totalAvailAll > 0 ? Math.round((totalWasteAll / totalAvailAll) * 1000) / 10 : 0;

    html += '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:20px;">';
    html += '<thead><tr style="background:#fef3c7;">';
    html += '<th style="border:1px solid #e5e7eb;padding:8px 10px;text-align:left;">Сечение</th>';
    html += '<th style="border:1px solid #e5e7eb;padding:8px 10px;text-align:center;">Станд. длина</th>';
    html += '<th style="border:1px solid #e5e7eb;padding:8px 10px;text-align:center;">Досок купить</th>';
    html += '<th style="border:1px solid #e5e7eb;padding:8px 10px;text-align:center;">Пог. м</th>';
    html += '<th style="border:1px solid #e5e7eb;padding:8px 10px;text-align:center;">Отходы</th>';
    html += '<th style="border:1px solid #e5e7eb;padding:8px 10px;text-align:center;">Объём, м³</th>';
    if (pricePerCube > 0) {
      html += '<th style="border:1px solid #e5e7eb;padding:8px 10px;text-align:right;">Стоимость</th>';
    }
    html += '</tr></thead><tbody>';

    let grandCost = 0;
    cutResults.forEach(r => {
      const vol = r.boardsToBuy * r.thickness * r.width * r.standardLength / 1e9;
      const cost = pricePerCube > 0 ? vol * pricePerCube : 0;
      grandCost += cost;
      html += '<tr>';
      html += '<td style="border:1px solid #e5e7eb;padding:6px 10px;font-weight:600;">' + r.crossSectionKey + ' мм</td>';
      html += '<td style="border:1px solid #e5e7eb;padding:6px 10px;text-align:center;">' + r.standardLength + ' мм</td>';
      html += '<td style="border:1px solid #e5e7eb;padding:6px 10px;text-align:center;">' + r.boardsToBuy + '</td>';
      html += '<td style="border:1px solid #e5e7eb;padding:6px 10px;text-align:center;">' + r.totalLinearM.toFixed(2) + '</td>';
      html += '<td style="border:1px solid #e5e7eb;padding:6px 10px;text-align:center;">' + r.totalWaste + ' мм (' + r.wastePercent + '%)</td>';
      html += '<td style="border:1px solid #e5e7eb;padding:6px 10px;text-align:center;">' + vol.toFixed(4) + '</td>';
      if (pricePerCube > 0) {
        html += '<td style="border:1px solid #e5e7eb;padding:6px 10px;text-align:right;">' + Math.round(cost).toLocaleString('ru-RU') + ' руб.</td>';
      }
      html += '</tr>';
    });

    const grandVol = cutResults.reduce((s, r) => s + r.boardsToBuy * r.thickness * r.width * r.standardLength / 1e9, 0);
    html += '<tr style="background:#fef3c7;font-weight:700;">';
    html += '<td style="border:1px solid #e5e7eb;padding:6px 10px;">Итого</td>';
    html += '<td style="border:1px solid #e5e7eb;padding:6px 10px;"></td>';
    html += '<td style="border:1px solid #e5e7eb;padding:6px 10px;text-align:center;">' + totalBoards + '</td>';
    html += '<td style="border:1px solid #e5e7eb;padding:6px 10px;text-align:center;">' + totalLinearAll.toFixed(2) + '</td>';
    html += '<td style="border:1px solid #e5e7eb;padding:6px 10px;text-align:center;">' + totalWasteAll + ' мм (' + avgWastePct + '%)</td>';
    html += '<td style="border:1px solid #e5e7eb;padding:6px 10px;text-align:center;">' + grandVol.toFixed(4) + '</td>';
    if (pricePerCube > 0) {
      html += '<td style="border:1px solid #e5e7eb;padding:6px 10px;text-align:right;">' + Math.round(grandCost).toLocaleString('ru-RU') + ' руб.</td>';
    }
    html += '</tr></tbody></table>';

    // Подробный раскрой
    cutResults.forEach(result => {
      html += '<div style="margin-top:20px;border:1px solid #d1d5db;border-radius:8px;overflow:hidden;">';
      html += '<div style="background:#fef3c7;padding:12px 16px;">';
      html += '<table style="width:100%;font-size:13px;"><tr>';
      html += '<td style="text-align:left;"><b style="font-size:16px;">' + result.crossSectionKey + '</b> <span style="color:#6b7280;">' + result.thickness + '×' + result.width + ' мм</span></td>';
      html += '<td style="text-align:right;color:#6b7280;">Купить: <b>' + result.boardsToBuy + '</b> досок по ' + result.standardLength + ' мм &bull; отходы ' + result.wastePercent + '%</td>';
      html += '</tr></table></div>';
      html += '<div style="padding:12px 16px;">';

      result.cutPlan.forEach(board => {
        const usedLength = board.cuts.reduce((s, c) => s + c.length, 0);
        const usedPct = board.standardLength > 0 ? Math.round(usedLength / board.standardLength * 100) : 0;
        const isEmpty = board.cuts.length === 0;

        // Полоска раскроя
        let barHTML = '<div style="height:24px;border-radius:4px;overflow:hidden;background:#f3f4f6;margin:6px 0 8px;white-space:nowrap;font-size:0;">';
        board.cuts.forEach((cut, ci) => {
          const pct = (cut.length / board.standardLength * 100).toFixed(1);
          const color = segColors[ci % segColors.length];
          barHTML += '<div style="display:inline-block;height:24px;width:' + pct + '%;background:' + color + ';text-align:center;line-height:24px;font-size:10px;font-weight:600;color:#fff;vertical-align:top;box-sizing:border-box;border-right:1px solid rgba(255,255,255,0.3);">' + cut.length + '</div>';
        });
        if (board.waste > 0) {
          const wastePct = (board.waste / board.standardLength * 100).toFixed(1);
          barHTML += '<div style="display:inline-block;height:24px;width:' + wastePct + '%;background:repeating-linear-gradient(45deg,#fecaca,#fecaca 4px,#fff1f2 4px,#fff1f2 8px);vertical-align:top;box-sizing:border-box;"></div>';
        }
        barHTML += '</div>';

        const cutsStr = board.cuts.map(c => '<span style="display:inline-block;font-size:11px;background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:3px;margin:0 4px 3px 0;">' + c.name + ': ' + c.length + ' мм</span>').join('');

        html += '<div style="border:1px solid #e5e7eb;border-radius:6px;padding:10px 12px;margin-bottom:8px;">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;">';
        html += '<span style="font-weight:600;">' + (isEmpty ? 'Пустая доска' : result.crossSectionKey + ' — Доска #' + board.boardIndex) + '</span>';
        html += '<span style="color:#6b7280;">' + usedLength + '/' + board.standardLength + ' мм (' + usedPct + '%)</span>';
        html += '</div>';
        html += barHTML;
        html += '<div style="display:flex;justify-content:space-between;align-items:center;">';
        html += '<div>' + (cutsStr || '<span style="color:#9ca3af;font-size:11px;">—</span>') + '</div>';
        if (board.waste > 0) {
          html += '<span style="font-size:11px;background:#fef2f2;color:#dc2626;padding:3px 8px;border-radius:4px;white-space:nowrap;">Остаток: ' + board.waste + ' мм</span>';
        }
        html += '</div></div>';
      });

      // Итого по сечению
      html += '<div style="display:flex;justify-content:space-between;font-size:12px;color:#6b7280;margin-top:10px;padding-top:8px;border-top:1px solid #e5e7eb;">';
      html += '<span>Всего отходов: ' + result.totalWaste + ' мм (' + result.wastePercent + '%)</span>';
      html += '<span>' + result.boardsToBuy + ' досок × ' + result.standardLength + ' мм = ' + (result.boardsToBuy * result.standardLength / 1000).toFixed(1) + ' пог. м</span>';
      html += '</div>';

      html += '</div></div>';
    });

    html += '</div>';

    // Создаём временный контейнер и добавляем в body
    // ВАЖНО: html2canvas может НЕ отрендерить элементы за пределами экрана (left:-9999px)
    // Поэтому размещаем контейнер в видимой области, но за белым оверлеем
    const container = document.createElement('div');
    container.id = 'pdf-render-container';
    container.style.cssText = 'position:fixed;left:0;top:0;width:794px;background:#fff;z-index:9998;overflow:visible;';
    container.innerHTML = html;
    document.body.appendChild(container);

    // Белый оверлей поверх контейнера, чтобы пользователь не видел мелькание
    const whiteOverlay = document.createElement('div');
    whiteOverlay.id = 'pdf-white-overlay';
    whiteOverlay.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;background:#fff;z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:Arial,sans-serif;';
    whiteOverlay.innerHTML = '<div style="width:40px;height:40px;border:4px solid #d97706;border-top-color:transparent;border-radius:50%;animation:pdfSpin 0.8s linear infinite;"></div><p style="margin-top:16px;color:#92400e;font-size:16px;font-weight:600;">Генерация PDF...</p><style>@keyframes pdfSpin{to{transform:rotate(360deg)}}</style>';
    document.body.appendChild(whiteOverlay);

    // Ждём рендера браузером
    await new Promise(r => setTimeout(r, 500));

    // Убедимся, что контейнер отрендерился и имеет высоту
    const containerHeight = container.scrollHeight;
    console.log('PDF container dimensions:', 794, 'x', containerHeight);

    // Рендерим через html2canvas
    const canvas = await html2canvas(container, {
      scale: 2,
      useCORS: true,
      backgroundColor: '#ffffff',
      width: 794,
      height: containerHeight,
      windowWidth: 794,
      windowHeight: containerHeight,
      scrollX: 0,
      scrollY: 0,
      logging: true
    });

    // Удаляем временные элементы
    container.remove();
    whiteOverlay.remove();

    // Создаём PDF из canvas
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const marginMm = 8;
    const imgW = pageW - marginMm * 2;
    const imgH = (canvas.height * imgW) / canvas.width;

    const imgData = canvas.toDataURL('image/jpeg', 0.95);
    let yOffset = 0;
    const imgHeightPerPage = pageH - marginMm * 2;

    // Первая страница
    pdf.addImage(imgData, 'JPEG', marginMm, marginMm, imgW, imgH);

    // Если контент не помещается на одну страницу — режем на несколько
    if (imgH > imgHeightPerPage) {
      const totalPages = Math.ceil(imgH / imgHeightPerPage);
      for (let i = 1; i < totalPages; i++) {
        yOffset = i * imgHeightPerPage;
        pdf.addPage();
        // Добавляем то же изображение со смещением
        pdf.addImage(imgData, 'JPEG', marginMm, marginMm - yOffset, imgW, imgH);
      }
    }

    pdf.save('раскрой_досок.pdf');

  } catch (err) {
    console.error('PDF export error:', err);
    showError('Ошибка генерации PDF: ' + err.message);
    const c = document.getElementById('pdf-render-container');
    if (c) c.remove();
    const o = document.getElementById('pdf-white-overlay');
    if (o) o.remove();
  } finally {
    btn.disabled = false;
    btn.innerHTML = origText;
  }
}

// --- Обработчики событий ---
document.addEventListener('DOMContentLoaded', () => {
  const dropZone = $('drop-zone');
  const fileInput = $('file-input');
  let selectedFile = null;

  // Drag & drop
  dropZone.addEventListener('dragenter', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', e => { e.preventDefault(); dropZone.classList.remove('drag-over'); });
  dropZone.addEventListener('drop', e => {
    e.preventDefault(); dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });
  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); });

  function handleFile(file) {
    const ext = file.name.toLowerCase();
    if (!ext.endsWith('.skp') && !ext.endsWith('.dae')) {
      showError('Неподдерживаемый формат файла. Поддерживаются только .skp и .dae');
      return;
    }
    selectedFile = file;
    $('upload-prompt').classList.add('hidden');
    $('file-selected').classList.remove('hidden');
    $('file-name').textContent = file.name;
    $('file-size').textContent = formatSize(file.size);
    fileInput.value = '';
  }

  $('btn-remove-file').addEventListener('click', e => {
    e.stopPropagation();
    selectedFile = null;
    $('upload-prompt').classList.remove('hidden');
    $('file-selected').classList.add('hidden');
  });

  $('btn-parse').addEventListener('click', e => {
    e.stopPropagation();
    if (!selectedFile) return;
    parseFile(selectedFile);
  });

  $('btn-clear').addEventListener('click', () => {
    components = []; crossSections = []; cutResults = [];
    selectedFile = null;
    $('upload-prompt').classList.remove('hidden');
    $('file-selected').classList.add('hidden');
    $('error-box').classList.add('hidden');
    $('warnings-box').classList.add('hidden');
    render();
    renderCutResults();
  });

  $('btn-csv').addEventListener('click', exportCSV);
  $('btn-pdf').addEventListener('click', exportPDF);

  // Цена за куб — обновление расчёта стоимости
  $('price-per-cube').addEventListener('input', () => {
    updateTotalCost();
  });

  $('btn-optimize').addEventListener('click', () => {
    // Валидация
    const errors = [];
    crossSections.forEach(cs => {
      if (!cs.standardLength || cs.standardLength <= 0) errors.push(`Укажите длину для сечения ${cs.key}`);
      const maxLen = Math.max(...cs.pieces.map(p => p.length));
      if (cs.standardLength < maxLen) errors.push(`Сечение ${cs.key}: стандартная длина (${cs.standardLength} мм) меньше максимальной детали (${maxLen} мм)`);
    });
    if (errors.length > 0) { showError(errors.join('. ')); return; }

    cutResults = crossSections.map(cs => {
      const r = optimizeCutting(cs.pieces, cs.standardLength);
      return { ...r, crossSectionKey: cs.key, thickness: cs.thickness, width: cs.width, standardLength: cs.standardLength };
    });

    $('error-box').classList.add('hidden');
    renderCutResults();
  });

  $('btn-reset-cut').addEventListener('click', () => {
    cutResults = [];
    renderCutResults();
  });

  // Добавить свою доску в раскрой
  $('btn-cut-add').addEventListener('click', () => {
    const t = parseFloat($('cut-add-thickness').value);
    const w = parseFloat($('cut-add-width').value);
    const stdLen = parseFloat($('cut-add-length').value);
    const count = parseInt($('cut-add-count').value, 10);

    if (isNaN(t) || t <= 0) { showError('Укажите толщину'); return; }
    if (isNaN(w) || w <= 0) { showError('Укажите ширину'); return; }
    if (isNaN(stdLen) || stdLen <= 0) { showError('Укажите стандартную длину'); return; }
    if (isNaN(count) || count <= 0) { showError('Укажите количество досок'); return; }

    const key = t + '×' + w;

    // Ищем существующее сечение в раскрое
    let existing = cutResults.find(r => r.crossSectionKey === key);

    if (existing) {
      // Добавить пустые доски в существующее сечение
      for (let i = 0; i < count; i++) {
        existing.cutPlan.push({
          boardIndex: existing.cutPlan.length + 1,
          standardLength: stdLen,
          cuts: [],
          waste: stdLen
        });
      }
      recalcCutResult(existing);
    } else {
      // Создать новое сечение с пустыми досками
      const newResult = {
        crossSectionKey: key,
        thickness: t,
        width: w,
        standardLength: stdLen,
        boardsToBuy: count,
        cutPlan: [],
        totalWaste: 0,
        wastePercent: 0,
        totalLinearM: 0
      };
      for (let i = 0; i < count; i++) {
        newResult.cutPlan.push({
          boardIndex: i + 1,
          standardLength: stdLen,
          cuts: [],
          waste: stdLen
        });
      }
      recalcCutResult(newResult);
      cutResults.push(newResult);
    }

    $('error-box').classList.add('hidden');
    renderCutResults();

    // Очистить поля
    $('cut-add-thickness').value = '';
    $('cut-add-width').value = '';
    $('cut-add-length').value = '6000';
    $('cut-add-count').value = '1';
  });

  $('btn-add').addEventListener('click', () => {
    const name = $('add-name').value.trim();
    const t = parseFloat($('add-thickness').value);
    const w = parseFloat($('add-width').value);
    const l = parseFloat($('add-length').value);
    const c = parseInt($('add-count').value, 10);

    if (!name) { showError('Введите название'); return; }
    if (isNaN(t) || t <= 0) { showError('Толщина должна быть положительным числом'); return; }
    if (isNaN(w) || w <= 0) { showError('Ширина должна быть положительным числом'); return; }
    if (isNaN(l) || l <= 0) { showError('Длина должна быть положительным числом'); return; }
    if (isNaN(c) || c <= 0) { showError('Количество должно быть положительным числом'); return; }

    const dims = [t, w, l].sort((a, b) => a - b);
    // Проверка — есть ли уже такая доска
    const existing = components.find(comp => comp.name === name && comp.thickness === dims[0] && comp.width === dims[1] && comp.length === dims[2]);
    if (existing) { existing.count += c; }
    else {
      components.push({ id: crypto.randomUUID(), name, thickness: dims[0], width: dims[1], length: dims[2], count: c });
    }

    crossSections = buildCrossSections(components);
    cutResults = [];
    render();
    renderCutResults();

    $('add-name').value = '';
    $('add-thickness').value = '';
    $('add-width').value = '';
    $('add-length').value = '';
    $('add-count').value = '1';
    $('error-box').classList.add('hidden');
  });

  async function parseFile(file) {
    $('error-box').classList.add('hidden');
    $('warnings-box').classList.add('hidden');
    $('btn-parse').disabled = true;
    $('btn-parse').innerHTML = '<span class="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"></span> Разбираем...';

    try {
      const ext = file.name.toLowerCase();
      let result;

      if (ext.endsWith('.dae')) {
        const text = await file.text();
        result = parseDAE(text);
      } else {
        const buffer = await file.arrayBuffer();
        result = parseSKP(buffer);
      }

      components = result.components;
      $('badge-file').textContent = '📄 ' + file.name;

      if (result.warnings && result.warnings.length > 0) {
        const wb = $('warnings-box');
        wb.classList.remove('hidden');
        wb.innerHTML = result.warnings.map(w => `<p class="text-sm text-amber-700">⚠ ${w}</p>`).join('');
      }

      crossSections = buildCrossSections(components);
      cutResults = [];
      render();
      renderCutResults();

    } catch (err) {
      showError(err.message || 'Неизвестная ошибка при разборе файла');
    } finally {
      $('btn-parse').disabled = false;
      $('btn-parse').innerHTML = '<svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Разобрать файл';
    }
  }

  // showError теперь глобальная функция
});