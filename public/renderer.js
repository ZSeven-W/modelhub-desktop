// ModelHub-Desktop — Renderer Script

// ─── State ─────────────────────────────────────────────────────────────────────
let currentView = 'installed';
let viewMode = 'grid';
let installedModels = [];
let browseModels = [];
let tags = [];
let downloads = {}; // name -> { progress, status, done, dl_id }
let compareSelected = [];
let bulkSelected = new Set();
let modelTags = {}; // modelName -> [{id, name, color}]
let eventSource = null;
let isLoading = true;

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  setupNavigation();
  setupViewToggle();
  setupSearch();
  setupSyncButton();
  setupTagModal();
  setupCompareOverlay();
  setupDetailOverlay();
  setupKeyboardShortcuts();
  setupImportExport();
  setupQueueControls();

  // Show loading, wait for backend
  showLoading(true);
  const ready = await waitForBackend(30);
  showLoading(false);

  if (!ready) {
    showToast('后端启动失败，请重试', 'error');
  }

  isLoading = false;
  await checkOllama();
  await loadInstalledModels();
  await loadTags();
  connectSSE();
  await checkDownloads();
});

function showLoading(show) {
  const overlay = document.getElementById('loading-overlay');
  if (overlay) {
    overlay.style.display = show ? 'flex' : 'none';
  }
}

async function waitForBackend(maxSeconds) {
  for (let i = 0; i < maxSeconds; i++) {
    try {
      const resp = await fetch(`${API_BASE}/api/health`);
      if (resp.ok) return true;
    } catch (e) { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

function connectSSE() {
  if (eventSource) {
    eventSource.close();
  }
  eventSource = new EventSource(`${API_BASE}/api/pulls/stream`);
  eventSource.addEventListener('progress', (e) => {
    try {
      const data = JSON.parse(e.data);
      downloads[data.name] = data;
      renderDownloads();
    } catch (err) { /* ignore parse errors */ }
  });
  eventSource.onerror = () => {
    // Reconnect after 5s
    setTimeout(() => {
      if (!isLoading) connectSSE();
    }, 5000);
  };
}

// ─── Keyboard Shortcuts ────────────────────────────────────────────────────────
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    const isMac = navigator.platform.includes('Mac');
    const mod = isMac ? e.metaKey : e.ctrlKey;

    if (mod && e.key === 'k') {
      e.preventDefault();
      document.getElementById('search-input').focus();
    } else if (mod && e.key === 'r') {
      e.preventDefault();
      document.getElementById('sync-btn').click();
    } else if (e.key === 'Escape') {
      closeDetailOverlay();
      closeCompareOverlay();
      closeTagModal();
    }
  });
}

// ─── Navigation ────────────────────────────────────────────────────────────────
function setupNavigation() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', async () => {
      const view = btn.dataset.view;
      switchView(view);

      if (view === 'browse' && browseModels.length === 0) {
        await searchBrowse('llama');
      }
      if (view === 'storage') {
        await loadStorage();
      }
      if (view === 'tags') {
        await loadTags();
      }
      if (view === 'history') {
        await loadDownloadHistory();
      }
    });
  });
}

function switchView(view) {
  currentView = view;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));
}

// ─── View Toggle ────────────────────────────────────────────────────────────────
function setupViewToggle() {
  document.querySelectorAll('.view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      viewMode = btn.dataset.viewMode;
      document.querySelectorAll('.view-btn').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.models-grid').forEach(g => {
        g.classList.toggle('list-view', viewMode === 'list');
      });
    });
  });
}

// ─── Ollama Status ─────────────────────────────────────────────────────────────
async function checkOllama() {
  const resp = await api.get('/api/health');
  const statusEl = document.getElementById('ollama-status');
  if (resp.success) {
    statusEl.innerHTML = '<span class="status-dot online"></span><span class="status-text">Ollama 运行中</span>';
  } else {
    statusEl.innerHTML = '<span class="status-dot offline"></span><span class="status-text">Ollama 未运行</span>';
  }
}

// ─── Sync ──────────────────────────────────────────────────────────────────────
function setupSyncButton() {
  document.getElementById('sync-btn').addEventListener('click', async () => {
    showToast('正在同步...', '');
    await api.post('/api/sync', {});
    await loadInstalledModels();
    showToast('同步完成', 'success');
  });
}

// ─── Installed Models ──────────────────────────────────────────────────────────
async function loadInstalledModels() {
  const resp = await api.get('/api/models');
  if (!resp.success) { showToast('加载失败: ' + resp.error, 'error'); return; }
  installedModels = resp.data || [];

  // Load enhanced data (tags + last_used) in background
  const enhancedResp = await api.get('/api/models/enhanced');
  if (enhancedResp.success) {
    const enhancedMap = {};
    for (const m of enhancedResp.data) {
      m.tag_names = m.tag_names ? m.tag_names.split(',') : [];
      enhancedMap[m.name] = m;
    }
    for (const m of installedModels) {
      const e = enhancedMap[m.name];
      if (e) {
        m.tag_names = e.tag_names;
        m.last_used = e.last_used;
        m.context_length = e.context_length;
      } else {
        m.tag_names = [];
        m.last_used = null;
      }
    }
  }

  renderInstalledModels();
}

function renderInstalledModels() {
  const container = document.getElementById('installed-models');
  const empty = document.getElementById('installed-empty');
  const search = document.getElementById('search-input').value.toLowerCase();
  const filterParam = document.getElementById('filter-param').value;
  const filterQuant = document.getElementById('filter-quant').value;
  const filterTag = document.getElementById('filter-tag')?.value || '';
  const sortBy = document.getElementById('filter-sort').value;

  let models = installedModels.filter(m => {
    const matchSearch = !search || m.name.toLowerCase().includes(search) || (m.tag || '').toLowerCase().includes(search);
    const matchParam = !filterParam || (m.parameters || '').toLowerCase().includes(filterParam);
    const matchQuant = !filterQuant || m.quantization === filterQuant;
    const matchFav = !favoritesOnly || m.is_favorite;
    const matchTag = !filterTag || (m.tag_names && m.tag_names.includes(filterTag));
    return matchSearch && matchParam && matchQuant && matchFav && matchTag;
  });

  const toNum = (s) => {
    if (!s) return 0;
    const m = s.match(/([\d.]+)/);
    const n = m ? parseFloat(m[1]) : 0;
    return s.includes('GB') ? n * 1024 : n;
  };

  if (sortBy === 'size') {
    models.sort((a, b) => toNum(b.size) - toNum(a.size));
  } else if (sortBy === 'last_used') {
    models.sort((a, b) => {
      const aTime = a.last_used ? new Date(a.last_used) : new Date(0);
      const bTime = b.last_used ? new Date(b.last_used) : new Date(0);
      return bTime - aTime;
    });
  } else if (sortBy === 'date') {
    models.sort((a, b) => {
      const aTime = a.created_at ? new Date(a.created_at) : new Date(0);
      const bTime = b.created_at ? new Date(b.created_at) : new Date(0);
      return bTime - aTime;
    });
  } else {
    models.sort((a, b) => a.name.localeCompare(b.name));
  }

  if (models.length === 0) {
    container.innerHTML = '';
    empty.style.display = 'flex';
    return;
  }

  empty.style.display = 'none';
  container.innerHTML = models.map(m => modelCardHTML(m, false)).join('');

  // Bind events
  container.querySelectorAll('.model-card').forEach(card => {
    const name = card.dataset.name;
    card.querySelector('.card-detail')?.addEventListener('click', (e) => { e.stopPropagation(); showModelDetail(name); });
    card.querySelector('.card-favorite')?.addEventListener('click', (e) => { e.stopPropagation(); toggleFavorite(name); });
    card.querySelector('.card-launch')?.addEventListener('click', (e) => { e.stopPropagation(); launchModel(name); });
    card.querySelector('.card-delete')?.addEventListener('click', (e) => { e.stopPropagation(); confirmDeleteModel(name); });
    card.querySelector('.card-compare')?.addEventListener('click', (e) => { e.stopPropagation(); toggleCompare(name); });
    card.querySelector('.card-openfolder')?.addEventListener('click', (e) => { e.stopPropagation(); openModelFolder(name); });

    // Bulk select checkbox
    card.querySelector('.card-checkbox')?.addEventListener('change', (e) => {
      e.stopPropagation();
      if (e.target.checked) {
        bulkSelected.add(name);
      } else {
        bulkSelected.delete(name);
      }
      updateBulkBar();
    });
  });

  updateBulkBar();
}

function updateBulkBar() {
  const bar = document.getElementById('bulk-action-bar');
  const count = document.getElementById('bulk-count');
  if (bar) {
    bar.style.display = bulkSelected.size > 0 ? 'flex' : 'none';
    if (count) count.textContent = bulkSelected.size;
  }
}

async function bulkDelete() {
  if (bulkSelected.size === 0) return;
  const names = [...bulkSelected];
  if (!confirm(`确定要删除 ${names.length} 个模型吗？`)) return;
  showToast(`删除 ${names.length} 个模型中...`, '');
  let failed = 0;
  for (const name of names) {
    const resp = await api.delete(`/api/models/${encodeURIComponent(name)}`);
    if (resp.success) {
      installedModels = installedModels.filter(m => m.name !== name);
      bulkSelected.delete(name);
    } else {
      failed++;
    }
  }
  renderInstalledModels();
  showToast(`${names.length - failed} 个已删除${failed > 0 ? `, ${failed} 个失败` : ''}`, failed > 0 ? 'error' : 'success');
}

function selectAllModels() {
  installedModels.forEach(m => bulkSelected.add(m.name));
  renderInstalledModels();
}

function clearSelection() {
  bulkSelected.clear();
  renderInstalledModels();
}

function modelCardHTML(m, isBrowse = false) {
  const favClass = m.is_favorite ? 'active' : '';
  const isSelected = bulkSelected.has(m.name);
  const cardTags = modelTags[m.name] || [];
  return `
    <div class="model-card ${isBrowse ? 'browse-card' : ''} ${isSelected ? 'selected' : ''}" data-name="${m.name}">
      ${!isBrowse ? `<div class="card-checkbox-wrap">
        <input type="checkbox" class="card-checkbox" data-name="${m.name}" ${isSelected ? 'checked' : ''}>
      </div>` : ''}
      ${m.is_favorite ? '<div class="favorite-star active">★</div>' : '<div class="favorite-star">☆</div>'}
      <div class="model-card-header">
        <div class="model-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
          </svg>
        </div>
        <div class="model-actions">
          ${!isBrowse ? `
          <button class="model-action-btn card-detail" title="详情">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>
            </svg>
          </button>
          <button class="model-action-btn card-compare" title="对比">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/>
              <line x1="6" y1="20" x2="6" y2="14"/><line x1="2" y1="20" x2="22" y2="20"/>
            </svg>
          </button>
          <button class="model-action-btn card-favorite ${favClass}" title="收藏">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="${m.is_favorite ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
            </svg>
          </button>
          <button class="model-action-btn card-launch" title="运行">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
          </button>
          <button class="model-action-btn card-openfolder" title="打开目录">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
          </button>
          <button class="model-action-btn danger card-delete" title="删除">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
          </button>
          ` : `
          <button class="model-action-btn card-pulldownload" title="下载" data-name="${m.name}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
            </svg>
          </button>
          `}
        </div>
      </div>
      <div class="model-name">${m.name}</div>
      <div class="model-info">
        ${m.parameters ? `
        <div class="model-info-row">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5"/></svg>
          ${m.parameters}
        </div>` : ''}
        ${m.quantization ? `
        <div class="model-info-row">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>
          ${m.quantization}
        </div>` : ''}
        ${m.size ? `
        <div class="model-info-row">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/></svg>
          ${m.size}
        </div>` : ''}
      </div>
      ${cardTags.length > 0 ? `<div class="model-card-tags">${cardTags.map(t =>
        `<span class="tag-pill" style="background:${t.color}22;color:${t.color};border-color:${t.color}44">${t.name}</span>`
      ).join('')}</div>` : ''}
      ${isBrowse && m.description ? `<div class="model-description">${m.description}</div>` : ''}
      <div class="model-badges">
        ${m.parameters ? `<span class="badge blue">${m.parameters}</span>` : ''}
        ${m.quantization ? `<span class="badge purple">${m.quantization}</span>` : ''}
        ${m.size ? `<span class="badge">${m.size}</span>` : ''}
      </div>
    </div>
  `;
}

// ─── Browse / Search ───────────────────────────────────────────────────────────
let favoritesOnly = false;

function setupSearch() {
  const input = document.getElementById('search-input');
  let debounce;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(renderInstalledModels, 300);
  });

  document.getElementById('filter-param').addEventListener('change', renderInstalledModels);
  document.getElementById('filter-quant').addEventListener('change', renderInstalledModels);
  document.getElementById('filter-sort').addEventListener('change', renderInstalledModels);
  document.getElementById('filter-tag').addEventListener('change', renderInstalledModels);

  // Favorites filter toggle
  const favBtn = document.getElementById('filter-favorites-btn');
  if (favBtn) {
    favBtn.addEventListener('click', () => {
      favoritesOnly = !favoritesOnly;
      favBtn.style.opacity = favoritesOnly ? '1' : '0.4';
      renderInstalledModels();
    });
  }

  // Browse search
  const browseInput = document.getElementById('browse-search-input');
  const browseBtn = document.getElementById('browse-search-btn');
  browseBtn.addEventListener('click', () => searchBrowse(browseInput.value.trim()));
  browseInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') searchBrowse(browseInput.value.trim()); });
}

async function searchBrowse(query) {
  const resp = await api.get(`/api/models/search?q=${encodeURIComponent(query)}`);
  if (!resp.success) { showToast('搜索失败', 'error'); return; }
  browseModels = resp.data || [];
  renderBrowseModels();
}

function renderBrowseModels() {
  const container = document.getElementById('browse-models');
  const empty = document.getElementById('browse-empty');

  if (browseModels.length === 0) {
    container.innerHTML = '';
    empty.style.display = 'flex';
    return;
  }

  empty.style.display = 'none';
  container.innerHTML = browseModels.map(m => browseCardHTML(m)).join('');

  container.querySelectorAll('.card-pulldownload').forEach(btn => {
    btn.addEventListener('click', () => pullModel(btn.dataset.name));
  });
}

function browseCardHTML(m) {
  const model = { ...m, parameters: extractParams(m.name), quantization: extractQuant(m.name) };
  return modelCardHTML(model, true);
}

function extractParams(name) {
  const match = name.match(/(\d+b)/i);
  return match ? match[1] : '';
}

function extractQuant(name) {
  const quants = ['q4_K_M', 'q4_K_S', 'q5_K_M', 'q5_K_S', 'q8_0', 'q2_K', 'q3_K_M', 'q3_K_S', 'q16', 'f16'];
  for (const q of quants) {
    if (name.toLowerCase().includes(q)) return q;
  }
  return '';
}

// ─── Downloads ─────────────────────────────────────────────────────────────────
async function checkDownloads() {
  const resp = await api.get('/api/models');
  // Check which models are being downloaded
  for (const name in downloads) {
    const d = downloads[name];
    if (d.done) continue;
    const r = await api.get(`/api/pulls/${encodeURIComponent(name)}`);
    if (r.success && r.data) {
      downloads[name] = r.data;
    }
  }
  renderDownloads();
}

async function pullModel(name) {
  const existing = downloads[name];
  if (existing && !existing.done) {
    showToast('已经在下载中', '');
    return;
  }

  const queued = existing && existing.status === 'queued';
  showToast(queued ? `已在队列中: ${name}` : `开始下载: ${name}`, '');
  downloads[name] = { progress: 0, status: queued ? 'queued' : 'starting', done: false };

  const resp = await api.post('/api/models/pull', { name });
  if (resp.success) {
    switchView('downloads');
    renderDownloads();
    // Show notification when done (via SSE/periodic check)
    checkDownloadComplete(name);
  } else {
    showToast('下载失败: ' + resp.error, 'error');
    delete downloads[name];
  }
}

async function checkDownloadComplete(name) {
  // Watch for completion and notify
  const check = setInterval(() => {
    const d = downloads[name];
    if (d && d.done) {
      clearInterval(check);
      if (d.status === 'done') {
        api.notify('下载完成', `${name} 已成功下载`);
        showToast(`✓ 下载完成: ${name}`, 'success');
      } else if (d.status === 'failed') {
        showToast(`✗ 下载失败: ${name}`, 'error');
      }
    }
    if (!downloads[name]) {
      clearInterval(check);
    }
  }, 1000);
}

function renderDownloads() {
  const container = document.getElementById('downloads-list');
  const empty = document.getElementById('downloads-empty');

  const items = Object.entries(downloads);
  if (items.length === 0) {
    container.innerHTML = '';
    empty.style.display = 'flex';
    return;
  }

  empty.style.display = 'none';
  container.innerHTML = items.map(([name, d]) => {
    const statusClass = d.done ? (d.status === 'done' ? 'green' : d.status === 'cancelled' ? 'warning' : 'red') : 'blue';
    const statusText = d.done ? (d.status === 'done' ? '✓ 完成' : d.status === 'cancelled' ? '✗ 已取消' : '✗ 失败') : `${d.progress}%`;
    const showCancel = !d.done;
    return `
    <div class="download-item">
      <div class="download-item-header">
        <span class="download-item-name">${name}</span>
        <span class="badge ${statusClass}">${statusText}</span>
        ${showCancel ? `<button class="btn-cancel-download" data-name="${name}" title="取消下载">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>` : ''}
      </div>
      <div class="download-progress-bar">
        <div class="download-progress-fill" style="width:${d.progress}%"></div>
      </div>
      <div class="download-status">
        <span>${d.status}</span>
        ${!d.done ? '<div class="spinner"></div>' : ''}
      </div>
    </div>
  `}).join('');

  // Bind cancel buttons
  container.querySelectorAll('.btn-cancel-download').forEach(btn => {
    btn.addEventListener('click', () => cancelDownload(btn.dataset.name));
  });
}

async function cancelDownload(name) {
  const resp = await api.post(`/api/models/pull/${encodeURIComponent(name)}/cancel`, {});
  if (resp.success) {
    showToast(`已取消: ${name}`, 'warning');
    delete downloads[name];
    renderDownloads();
  }
}

// ─── Storage ───────────────────────────────────────────────────────────────────
async function loadStorage() {
  const resp = await api.get('/api/storage');
  if (!resp.success) { showToast('加载存储信息失败', 'error'); return; }

  const data = resp.data;
  const models = data.models || [];

  document.getElementById('storage-dashboard').innerHTML = `
    <div class="storage-summary">
      <div>
        <div class="storage-big-number">${data.total_formatted}</div>
        <div class="storage-label">总存储占用</div>
      </div>
      <div style="flex:1">
        <p style="font-size:13px;color:var(--text-muted)">Ollama 模型存储目录</p>
        <p style="font-size:12px;color:var(--text-subtle);font-family:var(--mono);margin-top:4px">~/.ollama/models</p>
      </div>
    </div>
    <div class="storage-charts-row">
      <div class="storage-chart-container">
        <h4 style="font-size:13px;color:var(--text-muted);margin-bottom:12px">存储分布</h4>
        <canvas id="storage-pie-chart" width="260" height="260"></canvas>
      </div>
      <div class="storage-chart-container">
        <h4 style="font-size:13px;color:var(--text-muted);margin-bottom:12px">模型大小对比</h4>
        <canvas id="storage-bar-chart" width="320" height="220"></canvas>
      </div>
    </div>
    <div class="storage-breakdown">
      ${models.map(m => `
        <div class="storage-item">
          <span class="storage-item-name">${m.name}</span>
          <span class="storage-item-size">${m.size_formatted}</span>
        </div>
      `).join('')}
    </div>
  `;

  // Render charts
  if (models.length > 0) {
    renderStorageCharts(models, data.total);
  }
}

function renderStorageCharts(models, total) {
  // Pie chart
  const pieCtx = document.getElementById('storage-pie-chart');
  if (pieCtx && window.Chart) {
    const colors = ['#3b82f6', '#a855f7', '#3fb950', '#f59e0b', '#f85149', '#06b6d4', '#ec4899', '#84cc16'];
    new window.Chart(pieCtx, {
      type: 'doughnut',
      data: {
        labels: models.map(m => m.name),
        datasets: [{
          data: models.map(m => m.size),
          backgroundColor: models.map((_, i) => colors[i % colors.length]),
          borderWidth: 0,
        }]
      },
      options: {
        responsive: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: '#8b949e', boxWidth: 10, font: { size: 10 } }
          }
        }
      }
    });
  }

  // Bar chart
  const barCtx = document.getElementById('storage-bar-chart');
  if (barCtx && window.Chart) {
    const colors = ['#3b82f6', '#a855f7', '#3fb950', '#f59e0b', '#f85149', '#06b6d4', '#ec4899', '#84cc16'];
    new window.Chart(barCtx, {
      type: 'bar',
      data: {
        labels: models.map(m => m.name.split(':')[0]),
        datasets: [{
          label: '大小',
          data: models.map(m => m.size),
          backgroundColor: models.map((_, i) => colors[i % colors.length] + 'cc'),
          borderRadius: 4,
        }]
      },
      options: {
        responsive: false,
        indexAxis: 'y',
        plugins: { legend: { display: false } },
        scales: {
          x: {
            ticks: { color: '#8b949e', callback: (v) => formatBytesShort(v) },
            grid: { color: '#21262d' }
          },
          y: {
            ticks: { color: '#8b949e', font: { size: 10 } },
            grid: { display: false }
          }
        }
      }
    });
  }
}

function formatBytesShort(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + 'KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(0) + 'MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + 'GB';
}

// ─── Download History ───────────────────────────────────────────────────────────
async function loadDownloadHistory() {
  const resp = await api.get('/api/downloads');
  if (!resp.success) { showToast('加载下载历史失败', 'error'); return; }

  const history = resp.data || [];
  const container = document.getElementById('download-history-list');
  const empty = document.getElementById('download-history-empty');

  if (history.length === 0) {
    container.innerHTML = '';
    empty.style.display = 'flex';
    return;
  }

  empty.style.display = 'none';
  container.innerHTML = history.map(d => {
    const statusClass = d.status === 'done' ? 'green' : d.status === 'cancelled' ? 'warning' : d.status === 'failed' ? 'red' : 'blue';
    const statusText = d.status === 'done' ? '✓ 成功' : d.status === 'cancelled' ? '✕ 已取消' : d.status === 'failed' ? '✕ 失败' : '...进行中';
    return `
      <div class="download-history-item">
        <div class="download-history-name">${d.name}</div>
        <div class="download-history-meta">
          <span class="badge ${statusClass}">${statusText}</span>
          <span style="font-size:12px;color:var(--text-subtle)">${d.size || '-'}</span>
          <span style="font-size:11px;color:var(--text-subtle)">${d.created_at ? new Date(d.created_at).toLocaleString() : ''}</span>
        </div>
      </div>
    `;
  }).join('');
}

// ─── Tags ──────────────────────────────────────────────────────────────────────
async function loadTags() {
  const resp = await api.get('/api/tags');
  if (!resp.success) return;
  tags = resp.data || [];
  renderTags();

  // Populate tag filter dropdown
  const tagFilter = document.getElementById('filter-tag');
  if (tagFilter) {
    tagFilter.innerHTML = '<option value="">所有标签</option>' +
      tags.map(t => `<option value="${t.name}">${t.name}</option>`).join('');
  }
}

function renderTags() {
  const container = document.getElementById('tags-list');
  if (tags.length === 0) {
    container.innerHTML = '<div class="empty-state" style="padding:40px"><p style="font-size:14px">还没有标签</p></div>';
    return;
  }
  container.innerHTML = tags.map(t => `
    <div class="tag-item">
      <span class="tag-color-dot" style="background:${t.color}"></span>
      <span class="tag-name">${t.name}</span>
      <button class="model-action-btn danger" onclick="deleteTag(${t.id})" title="删除">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
  `).join('');
}

function setupTagModal() {
  document.getElementById('add-tag-btn').addEventListener('click', () => {
    showTagModal();
  });
}

let tagModalEl = null;
function showTagModal() {
  if (tagModalEl) return;

  tagModalEl = document.createElement('div');
  tagModalEl.className = 'modal-overlay';
  tagModalEl.innerHTML = `
    <div class="modal">
      <h3>新建标签</h3>
      <div class="modal-field">
        <label>标签名称</label>
        <input type="text" id="tag-name-input" placeholder="例如：代码模型">
      </div>
      <div class="modal-field">
        <label>颜色</label>
        <input type="color" id="tag-color-input" value="#3b82f6">
      </div>
      <div class="modal-actions">
        <button class="btn-secondary" onclick="closeTagModal()">取消</button>
        <button class="btn-primary" onclick="createTag()">创建</button>
      </div>
    </div>
  `;
  document.body.appendChild(tagModalEl);
  document.getElementById('tag-name-input').focus();

  tagModalEl.addEventListener('click', (e) => {
    if (e.target === tagModalEl) closeTagModal();
  });
}

function closeTagModal() {
  if (tagModalEl) {
    tagModalEl.remove();
    tagModalEl = null;
  }
}

async function createTag() {
  const name = document.getElementById('tag-name-input').value.trim();
  const color = document.getElementById('tag-color-input').value;
  if (!name) { showToast('请输入标签名称', 'error'); return; }

  const resp = await api.post('/api/tags', { name, color });
  if (resp.success) {
    closeTagModal();
    await loadTags();
    showToast('标签已创建', 'success');
  } else {
    showToast('创建失败: ' + resp.error, 'error');
  }
}

async function deleteTag(id) {
  const resp = await api.delete(`/api/tags/${id}`);
  if (resp.success) {
    await loadTags();
    showToast('标签已删除', 'success');
  }
}

// ─── Model Detail ──────────────────────────────────────────────────────────────
function setupDetailOverlay() {
  document.getElementById('close-detail-btn').addEventListener('click', closeDetailOverlay);
  document.getElementById('detail-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'detail-overlay') closeDetailOverlay();
  });
}

function closeDetailOverlay() {
  document.getElementById('detail-overlay').style.display = 'none';
}

async function showModelDetail(name) {
  document.getElementById('detail-name').textContent = name;
  document.getElementById('detail-overlay').style.display = 'flex';
  document.getElementById('detail-body').innerHTML = '<div class="empty-state" style="padding:40px"><div class="spinner"></div></div>';

  const [infoResp, mfResp, tagsResp] = await Promise.all([
    api.get(`/api/models/${encodeURIComponent(name)}/info`),
    api.get(`/api/models/${encodeURIComponent(name)}/modelfile`),
    api.get(`/api/models/${encodeURIComponent(name)}/tags`),
  ]);

  const m = installedModels.find(m => m.name === name) || {};
  const info = infoResp.success ? infoResp.data : {};
  const mf = mfResp.success ? mfResp.data : {};
  const modelTagList = tagsResp.success ? tagsResp.data : [];
  modelTags[name] = modelTagList;

  // Parse context length and capabilities from info
  const contextLen = info.context_length || info.contextlength || (info.raw ? info.raw.match(/context length[\s:]*(\d+)/i)?.[1] : null) || null;
  const capabilities = info.capabilities || info.system || '';

  document.getElementById('detail-body').innerHTML = `
    <div class="detail-actions" style="margin-bottom:20px">
      <button class="btn-primary" onclick="launchModel('${name}')">▶ 运行模型</button>
      <button class="btn-secondary" onclick="openModelFolder('${name}')">📁 打开目录</button>
      <button class="btn-secondary" onclick="copyRunCommand('${name}')">📋 复制命令</button>
      <button class="btn-danger btn-sm" onclick="confirmDeleteModel('${name}'); closeDetailOverlay();">🗑 删除</button>
    </div>

    <div class="detail-section">
      <h4>基本信息</h4>
      <div class="detail-grid">
        <div class="detail-item"><span class="detail-item-label">名称</span><span class="detail-item-value">${name}</span></div>
        ${m.tag ? `<div class="detail-item"><span class="detail-item-label">标签</span><span class="detail-item-value">${m.tag}</span></div>` : ''}
        ${m.parameters ? `<div class="detail-item"><span class="detail-item-label">参数量</span><span class="detail-item-value">${m.parameters}</span></div>` : ''}
        ${m.quantization ? `<div class="detail-item"><span class="detail-item-label">量化</span><span class="detail-item-value">${m.quantization}</span></div>` : ''}
        ${m.size ? `<div class="detail-item"><span class="detail-item-label">大小</span><span class="detail-item-value">${m.size}</span></div>` : ''}
        ${contextLen ? `<div class="detail-item"><span class="detail-item-label">上下文长度</span><span class="detail-item-value">${parseInt(contextLen).toLocaleString()}</span></div>` : ''}
      </div>
    </div>

    ${modelTagList.length > 0 ? `
    <div class="detail-section">
      <h4>标签</h4>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">
        ${modelTagList.map(t => `<span class="tag-pill" style="background:${t.color}22;color:${t.color};border-color:${t.color}44">${t.name}
          <button onclick="removeModelTag('${name}', ${t.id})" style="background:none;border:none;cursor:pointer;color:inherit;padding:0 0 0 4px;font-size:11px">✕</button>
        </span>`).join('')}
      </div>
    </div>
    ` : ''}
    <div class="detail-section">
      <h4>添加标签</h4>
      <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">
        ${tags.filter(t => !modelTagList.find(mt => mt.id === t.id)).map(t =>
          `<button class="btn-tag-add" style="background:${t.color}22;color:${t.color};border:1px solid ${t.color}44;border-radius:20px;padding:4px 10px;font-size:12px;cursor:pointer"
            onclick="addModelTag('${name}', ${t.id})">+ ${t.name}</button>`
        ).join('')}
        ${tags.length === 0 ? '<span style="font-size:12px;color:var(--text-subtle)">先去标签管理创建标签</span>' : ''}
      </div>
    </div>

    ${mf.modelfile ? `
    <div class="detail-section">
      <h4>Modelfile</h4>
      <div class="modelfile-content">${escapeHtml(mf.modelfile)}</div>
    </div>
    ` : ''}

    ${info.raw ? `
    <div class="detail-section">
      <h4>完整信息</h4>
      <div class="modelfile-content">${escapeHtml(info.raw)}</div>
    </div>
    ` : ''}

    <div class="detail-section" id="recommendations-section">
      <h4>相似模型推荐</h4>
      <div id="recommendations-container">
        <span style="font-size:12px;color:var(--text-muted)">加载中...</span>
      </div>
    </div>
  `;

  // Load recommendations
  const recs = await loadRecommendations(name);
  const container = document.getElementById('recommendations-container');
  if (container) {
    container.innerHTML = recs || '<span style="font-size:12px;color:var(--text-muted)">暂无推荐</span>';
  }
}

async function addModelTag(modelName, tagId) {
  const resp = await api.post(`/api/models/${encodeURIComponent(modelName)}/tags/${tagId}`, {});
  if (resp.success) {
    showModelDetail(modelName);
  }
}

async function removeModelTag(modelName, tagId) {
  const resp = await api.delete(`/api/models/${encodeURIComponent(modelName)}/tags/${tagId}`);
  if (resp.success) {
    showModelDetail(modelName);
    renderInstalledModels();
  }
}

function copyRunCommand(name) {
  navigator.clipboard.writeText(`ollama run ${name}`);
  showToast('命令已复制', 'success');
}

// ─── Compare ───────────────────────────────────────────────────────────────────
function setupCompareOverlay() {
  document.getElementById('close-compare-btn').addEventListener('click', closeCompareOverlay);
  document.getElementById('compare-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'compare-overlay') closeCompareOverlay();
  });
}

function closeCompareOverlay() {
  document.getElementById('compare-overlay').style.display = 'none';
  compareSelected = [];
}

function toggleCompare(name) {
  const idx = compareSelected.indexOf(name);
  if (idx >= 0) {
    compareSelected.splice(idx, 1);
  } else {
    if (compareSelected.length >= 4) {
      showToast('最多对比 4 个模型', '');
      return;
    }
    compareSelected.push(name);
  }

  if (compareSelected.length >= 2) {
    showCompare();
  }
}

async function showCompare() {
  document.getElementById('compare-overlay').style.display = 'flex';
  document.getElementById('compare-body').innerHTML = '<div class="empty-state" style="padding:40px"><div class="spinner"></div></div>';

  // Use enhanced compare endpoint
  const params = compareSelected.map(n => `names=${encodeURIComponent(n)}`).join('&');
  const resp = await api.get(`/api/models/compare-detailed?${params}`);
  if (!resp.success) {
    document.getElementById('compare-body').innerHTML = '<p>加载失败</p>';
    return;
  }

  const models = resp.data || [];

  // Build side-by-side spec comparison table
  const specFields = ['parameters', 'quantization', 'size', 'context_length', 'last_used'];
  const specLabels = { parameters: '参数量', quantization: '量化', size: '大小', context_length: '上下文长度', last_used: '最近使用' };

  document.getElementById('compare-body').innerHTML = `
    <div class="compare-grid">
      ${models.map(m => `
        <div class="compare-card">
          <h4 style="word-break:break-all">${m.name}</h4>
          ${Object.entries(m.db).filter(([k]) => !['id', 'created_at', 'tag_names'].includes(k)).map(([k, v]) => `
            <div class="compare-row">
              <span class="compare-label">${k}</span>
              <span class="compare-value">${v || '-'}</span>
            </div>
          `).join('')}
          ${m.context_length ? `<div class="compare-row"><span class="compare-label">context_length</span><span class="compare-value">${parseInt(m.context_length).toLocaleString()}</span></div>` : ''}
          ${m.capabilities ? `<div class="compare-row"><span class="compare-label">capabilities</span><span class="compare-value">${m.capabilities}</span></div>` : ''}
          ${m.system ? `<div class="compare-row"><span class="compare-label">system</span><span class="compare-value">${m.system}</span></div>` : ''}
        </div>
      `).join('')}
    </div>
    ${models.some(m => m.modelfile) ? `
    <div style="margin-top:24px">
      <h4 style="margin-bottom:12px">Modelfile 对比</h4>
      <div style="display:grid;grid-template-columns:repeat(${models.length},1fr);gap:12px">
        ${models.map(m => `
          <div>
            <div style="font-size:13px;font-weight:600;margin-bottom:8px;color:var(--accent)">${m.name}</div>
            <pre class="modelfile-content" style="font-size:11px;max-height:300px;overflow:auto">${escapeHtml(m.modelfile || '(无)').replace(/\n/g, '<br>')}</pre>
          </div>
        `).join('')}
      </div>
    </div>
    ` : ''}
  `;
}

// ─── Actions ───────────────────────────────────────────────────────────────────
async function toggleFavorite(name) {
  const resp = await api.post(`/api/models/${encodeURIComponent(name)}/favorite`, {});
  if (resp.success) {
    const model = installedModels.find(m => m.name === name);
    if (model) model.is_favorite = resp.data.is_favorite;
    renderInstalledModels();
    if (currentView === 'browse') renderBrowseModels();
  }
}

async function launchModel(name) {
  showToast(`启动 ${name}...`, '');
  await api.launchTerminal(name);
}

async function openModelFolder(name) {
  const model = installedModels.find(m => m.name === name);
  if (model && model.path) {
    await api.openFolder(model.path);
  } else {
    await api.openFolder(os.homedir() + '/.ollama/models');
  }
}

async function confirmDeleteModel(name) {
  if (!confirm(`确定要删除模型 "${name}" 吗？此操作不可恢复。`)) return;

  showToast(`删除中: ${name}`, '');
  const resp = await api.delete(`/api/models/${encodeURIComponent(name)}`);
  if (resp.success) {
    showToast(`已删除: ${name}`, 'success');
    installedModels = installedModels.filter(m => m.name !== name);
    renderInstalledModels();
  } else {
    showToast('删除失败: ' + resp.error, 'error');
  }
}

// ─── Import/Export ─────────────────────────────────────────────────────────────
function setupImportExport() {
  document.getElementById('export-tags-btn')?.addEventListener('click', async () => {
    const resp = await api.get('/api/export');
    if (!resp.success) { showToast('导出失败', 'error'); return; }
    const blob = new Blob([JSON.stringify(resp.data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `modelhub-backup-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('导出成功', 'success');
  });

  const importFile = document.getElementById('import-file');
  document.getElementById('import-tags-btn')?.addEventListener('click', () => importFile.click());
  importFile?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const resp = await api.post('/api/import', data);
      if (resp.success) {
        showToast(`导入成功: ${resp.data.imported_tags} 个标签`, 'success');
        await loadTags();
        await loadInstalledModels();
      } else {
        showToast('导入失败', 'error');
      }
    } catch {
      showToast('无效的 JSON 文件', 'error');
    }
    importFile.value = '';
  });
}

// ─── Queue Controls ─────────────────────────────────────────────────────────────
let queuePaused = false;

function setupQueueControls() {
  document.getElementById('queue-pause-btn')?.addEventListener('click', async () => {
    const resp = await api.post('/api/queue/pause', {});
    if (resp.success) {
      queuePaused = true;
      document.getElementById('queue-pause-btn').style.display = 'none';
      document.getElementById('queue-resume-btn').style.display = 'inline-block';
      showToast('下载队列已暂停', '');
    }
  });

  document.getElementById('queue-resume-btn')?.addEventListener('click', async () => {
    const resp = await api.post('/api/queue/resume', {});
    if (resp.success) {
      queuePaused = false;
      document.getElementById('queue-pause-btn').style.display = 'inline-block';
      document.getElementById('queue-resume-btn').style.display = 'none';
      showToast('下载队列已恢复', 'success');
    }
  });
}

// ─── Recommendations ──────────────────────────────────────────────────────────
async function loadRecommendations(name) {
  const resp = await api.get(`/api/recommendations?name=${encodeURIComponent(name)}`);
  if (!resp.success || !resp.data.length) return '';
  return resp.data.map(m => `
    <div class="model-card compact" style="cursor:pointer" onclick="showModelDetail('${m.name}')">
      <div class="card-name" style="font-size:13px">${m.name}</div>
      <div style="font-size:11px;color:var(--text-muted)">${m.parameters || ''} ${m.quantization || ''}</div>
    </div>
  `).join('');
}

// ─── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, type = '') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  clearTimeout(toastTimer);

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  document.body.appendChild(toast);

  toastTimer = setTimeout(() => toast.remove(), 3000);
}

// ─── Globals for inline onclick ────────────────────────────────────────────────
window.toggleFavorite = toggleFavorite;
window.launchModel = launchModel;
window.openModelFolder = openModelFolder;
window.confirmDeleteModel = confirmDeleteModel;
window.showModelDetail = showModelDetail;
window.closeDetailOverlay = closeDetailOverlay;
window.closeCompareOverlay = closeCompareOverlay;
window.deleteTag = deleteTag;
window.createTag = createTag;
window.closeTagModal = closeTagModal;
window.pullModel = pullModel;
window.toggleCompare = toggleCompare;
window.addModelTag = addModelTag;
window.removeModelTag = removeModelTag;
window.copyRunCommand = copyRunCommand;
window.bulkDelete = bulkDelete;
window.selectAllModels = selectAllModels;
window.clearSelection = clearSelection;
window.cancelDownload = cancelDownload;
