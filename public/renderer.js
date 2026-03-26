// ModelHub-Desktop — Renderer Script

// ─── State ─────────────────────────────────────────────────────────────────────
let currentView = 'installed';
let viewMode = 'grid';
let installedModels = [];
let browseModels = [];
let tags = [];
let downloads = {}; // name -> { progress, status, done }
let pullTimers = {};
let compareSelected = [];

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  setupNavigation();
  setupViewToggle();
  setupSearch();
  setupSyncButton();
  setupTagModal();
  setupCompareOverlay();
  setupDetailOverlay();

  await checkOllama();
  await loadInstalledModels();
  await loadTags();
  await checkDownloads();

  // Poll for download progress
  setInterval(checkDownloads, 2000);
});

// ─── Navigation ────────────────────────────────────────────────────────────────
function setupNavigation() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', async () => {
      const view = btn.dataset.view;
      switchView(view);

      if (view === 'browse' && browseModels.length === 0) {
        // Load featured models
        await searchBrowse('llama');
      }
      if (view === 'storage') {
        await loadStorage();
      }
      if (view === 'tags') {
        await loadTags();
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
  renderInstalledModels();
}

function renderInstalledModels() {
  const container = document.getElementById('installed-models');
  const empty = document.getElementById('installed-empty');
  const search = document.getElementById('search-input').value.toLowerCase();
  const filterParam = document.getElementById('filter-param').value;
  const filterQuant = document.getElementById('filter-quant').value;
  const sortBy = document.getElementById('filter-sort').value;

  let models = installedModels.filter(m => {
    const matchSearch = !search || m.name.toLowerCase().includes(search) || (m.tag || '').toLowerCase().includes(search);
    const matchParam = !filterParam || (m.parameters || '').toLowerCase().includes(filterParam);
    const matchQuant = !filterQuant || m.quantization === filterQuant;
    return matchSearch && matchParam && matchQuant;
  });

  if (sortBy === 'size') {
    // Sort by size string (rough numeric conversion)
    models.sort((a, b) => {
      const toNum = (s) => {
        if (!s) return 0;
        const m = s.match(/([\d.]+)/);
        const n = m ? parseFloat(m[1]) : 0;
        return s.includes('GB') ? n * 1024 : n;
      };
      return toNum(b.size) - toNum(a.size);
    });
  } else if (sortBy === 'name') {
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
  });
}

function modelCardHTML(m, isBrowse = false) {
  const favClass = m.is_favorite ? 'active' : '';
  return `
    <div class="model-card ${isBrowse ? 'browse-card' : ''}" data-name="${m.name}">
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
  if (downloads[name] && !downloads[name].done) {
    showToast('已经在下载中', '');
    return;
  }

  showToast(`开始下载: ${name}`, '');
  downloads[name] = { progress: 0, status: 'starting', done: false };

  const resp = await api.post('/api/models/pull', { name });
  if (resp.success) {
    switchView('downloads');
    renderDownloads();
  } else {
    showToast('下载失败: ' + resp.error, 'error');
    delete downloads[name];
  }
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
  container.innerHTML = items.map(([name, d]) => `
    <div class="download-item">
      <div class="download-item-header">
        <span class="download-item-name">${name}</span>
        <span class="badge ${d.done ? 'green' : 'blue'}">${d.done ? '已完成' : d.progress + '%'}</span>
      </div>
      <div class="download-progress-bar">
        <div class="download-progress-fill" style="width:${d.progress}%"></div>
      </div>
      <div class="download-status">
        <span>${d.status}</span>
        ${!d.done ? '<div class="spinner"></div>' : '<span style="color:var(--success)">✓</span>'}
      </div>
    </div>
  `).join('');
}

// ─── Storage ───────────────────────────────────────────────────────────────────
async function loadStorage() {
  const resp = await api.get('/api/storage');
  if (!resp.success) { showToast('加载存储信息失败', 'error'); return; }

  const data = resp.data;
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
    <div class="storage-breakdown">
      ${data.models.map(m => `
        <div class="storage-item">
          <span class="storage-item-name">${m.name}</span>
          <span class="storage-item-size">${m.size_formatted}</span>
        </div>
      `).join('')}
    </div>
  `;
}

// ─── Tags ──────────────────────────────────────────────────────────────────────
async function loadTags() {
  const resp = await api.get('/api/tags');
  if (!resp.success) return;
  tags = resp.data || [];
  renderTags();
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

  const [infoResp, mfResp] = await Promise.all([
    api.get(`/api/models/${encodeURIComponent(name)}/info`),
    api.get(`/api/models/${encodeURIComponent(name)}/modelfile`),
  ]);

  const m = installedModels.find(m => m.name === name) || {};
  const info = infoResp.success ? infoResp.data : {};
  const mf = mfResp.success ? mfResp.data : {};

  document.getElementById('detail-body').innerHTML = `
    <div class="detail-actions" style="margin-bottom:20px">
      <button class="btn-primary" onclick="launchModel('${name}')">▶ 运行模型</button>
      <button class="btn-secondary" onclick="openModelFolder('${name}')">📁 打开目录</button>
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
        ${info.modelfile ? `<div class="detail-item"><span class="detail-item-label">系统</span><span class="detail-item-value">${info.system || '-'}</span></div>` : ''}
        ${info.capabilities ? `<div class="detail-item"><span class="detail-item-label">能力</span><span class="detail-item-value">${info.capabilities}</span></div>` : ''}
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
  `;
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

  const resp = await api.post('/api/models/compare', { names: compareSelected });
  if (!resp.success) {
    document.getElementById('compare-body').innerHTML = '<p>加载失败</p>';
    return;
  }

  const models = resp.data || [];
  document.getElementById('compare-body').innerHTML = `
    <div class="compare-grid">
      ${models.map(m => `
        <div class="compare-card">
          <h4>${m.name}</h4>
          ${Object.entries(m.db).filter(([k]) => !['id', 'created_at'].includes(k)).map(([k, v]) => `
            <div class="compare-row">
              <span class="compare-label">${k}</span>
              <span class="compare-value">${v || '-'}</span>
            </div>
          `).join('')}
          ${m.capabilities ? `<div class="compare-row"><span class="compare-label">capabilities</span><span class="compare-value">${m.capabilities}</span></div>` : ''}
          ${m.system ? `<div class="compare-row"><span class="compare-label">system</span><span class="compare-value">${m.system}</span></div>` : ''}
        </div>
      `).join('')}
    </div>
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

// ─── Utils ─────────────────────────────────────────────────────────────────────
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
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
