(() => {
  'use strict';

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }

  // Масштаб інтерфейсу для телефона в режимі «версія для комп'ютера»:
  // там сторінка рендериться у ~980px і кнопки/легенда дрібніють.
  // Масштаб = ширина layout-viewport / ширина екрана пристрою (не залежить від pinch-zoom).
  function applyUiScale() {
    const root = document.documentElement;
    let s = 1;
    try {
      const coarse = window.matchMedia('(pointer: coarse)').matches;
      const layoutW = root.clientWidth || window.innerWidth;
      const screenW = window.screen && window.screen.width ? window.screen.width : layoutW;
      if (coarse && layoutW > 640 && screenW > 0) {
        const ratio = layoutW / screenW;
        if (ratio > 1.15) s = Math.min(ratio, 3);
      }
    } catch (e) {
      s = 1;
    }
    root.style.setProperty('--s', s.toFixed(3));
    root.classList.toggle('is-ui-scaled', s > 1);
  }
  applyUiScale();
  window.addEventListener('resize', applyUiScale);
  window.addEventListener('orientationchange', applyUiScale);

  const MAP_CONFIG = {
    center: [28.66, 50.65],
    zoom: 7.2,
    minZoom: 6.0,
    maxZoom: 14,
    oblastGeojsonUrl: './data/zhytomyr_oblast.geojson',
    maskGeojsonUrl: './data/zhytomyr_mask.geojson',
    raionsGeojsonUrl: './data/zhytomyr_raions.geojson',
    raionLabelsUrl: './data/zhytomyr_raion_labels.geojson',
    geojsonUrl: './data/zhytomyr_villages.geojson',
    // Щоб брати дані з іншого репозиторію, замініть на:
    // 'https://raw.githubusercontent.com/<USER>/<REPO>/main/outages.json'
    outagesUrl: './data/outages.json',
  };

  // Автооновлення даних відключень (хвилини)
  const AUTO_REFRESH_MINUTES = 10;

  // Порожній темний стиль — видно ТІЛЬКИ Житомирську область, без сусідніх областей
  const DARK_ISOLATED_STYLE = {
    version: 8,
    sources: {},
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: {
          'background-color': '#06080e',
        },
      },
    ],
  };

  /**
   * Безперервна математична формула кольору для будь-якого відсотка (0..100, включно з дробовими 32.5, 63.1).
   * Крива охолодження: від яскравого золотого світла (0%) до темного згасання (100%).
   */
  function computeOutageColor(pct) {
    if (pct === null || pct === undefined || Number.isNaN(Number(pct))) {
      return '#475569';
    }
    const p = Math.max(0, Math.min(100, Number(pct))) / 100;
    const hue = (48 - 72 * p + 360) % 360;
    const sat = 96 - 68 * Math.pow(p, 2.2);
    const light = 64 - 58 * Math.pow(p, 1.15);
    return `hsl(${hue.toFixed(1)}, ${sat.toFixed(1)}%, ${light.toFixed(1)}%)`;
  }

  function buildFormulaGradientCss() {
    const stops = [];
    for (let pct = 0; pct <= 100; pct += 5) {
      stops.push(`${computeOutageColor(pct)} ${pct}%`);
    }
    return `linear-gradient(90deg, ${stops.join(', ')})`;
  }

  function formatStatusLabel(pct) {
    if (pct === null || pct === undefined) return 'Немає даних';
    const v = Number(pct);
    if (v === 0) return 'світло є';
    if (v >= 80) return 'аварія · без світла';
    return 'без світла';
  }

  function formatUpdatedAt(isoString) {
    if (!isoString) return 'невідомо';
    const dt = new Date(isoString);
    if (Number.isNaN(dt.getTime())) return isoString;
    return new Intl.DateTimeFormat('uk-UA', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(dt);
  }

  function getFeatureBounds(geometry) {
    const bounds = new maplibregl.LngLatBounds();
    const walk = (coords) => {
      if (typeof coords[0] === 'number') {
        bounds.extend(coords);
      } else {
        for (const c of coords) walk(c);
      }
    };
    walk(geometry.coordinates);
    return bounds;
  }

  // DOM елементи
  const situationBtn = document.getElementById('situation-btn');
  const situationBtnPct = document.getElementById('situation-btn-pct');
  const situationModal = document.getElementById('situation-modal');
  const situationClose = document.getElementById('situation-close');
  const situationOblastPct = document.getElementById('situation-oblast-pct');
  const situationOblastSub = document.getElementById('situation-oblast-sub');
  const situationOblastBar = document.getElementById('situation-oblast-bar');
  const tabRaions = document.getElementById('tab-raions');
  const tabVillages = document.getElementById('tab-villages');
  const tabVillagesCount = document.getElementById('tab-villages-count');
  const panelRaions = document.getElementById('panel-raions');
  const panelVillages = document.getElementById('panel-villages');
  const raionsList = document.getElementById('raions-list');
  const villagesList = document.getElementById('villages-list');
  const modalVillageSearch = document.getElementById('modal-village-search');
  const refreshDataBtn = document.getElementById('refresh-data-btn');
  const hoverTooltip = document.getElementById('hover-tooltip');
  const selectedCard = document.getElementById('selected-card');
  const selectedName = document.getElementById('selected-name');
  const selectedHromada = document.getElementById('selected-hromada');
  const selectedSwatch = document.getElementById('selected-swatch');
  const selectedPercent = document.getElementById('selected-percent');
  const selectedStatusText = document.getElementById('selected-status-text');
  const selectedClose = document.getElementById('selected-close');
  const updatedAtEl = document.getElementById('updated-at');
  const legendGradientEl = document.querySelector('.legend-gradient');

  if (legendGradientEl) {
    legendGradientEl.style.background = buildFormulaGradientCss();
  }

  let settlementsIndex = [];
  let hoveredFeatureId = null;
  let selectedFeatureId = null;

  if (typeof maplibregl === 'undefined') {
    if (updatedAtEl) updatedAtEl.textContent = 'Не вдалося завантажити рушій мапи';
    return;
  }

  let map;
  try {
    map = new maplibregl.Map({
      container: 'map',
      style: DARK_ISOLATED_STYLE,
      center: MAP_CONFIG.center,
      zoom: MAP_CONFIG.zoom,
      minZoom: MAP_CONFIG.minZoom,
      maxZoom: MAP_CONFIG.maxZoom,
      attributionControl: false,
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
  } catch (err) {
    console.error(err);
    if (updatedAtEl) updatedAtEl.textContent = 'Помилка ініціалізації мапи (WebGL)';
    return;
  }

  async function loadMapData() {
    const [oblastRes, maskRes, raionsRes, labelsRes, geoRes, outagesRes] = await Promise.all([
      fetch(MAP_CONFIG.oblastGeojsonUrl, { cache: 'no-cache' }),
      fetch(MAP_CONFIG.maskGeojsonUrl, { cache: 'no-cache' }),
      fetch(MAP_CONFIG.raionsGeojsonUrl, { cache: 'no-cache' }),
      fetch(MAP_CONFIG.raionLabelsUrl, { cache: 'no-cache' }),
      fetch(MAP_CONFIG.geojsonUrl, { cache: 'no-cache' }),
      fetch(`${MAP_CONFIG.outagesUrl}?t=${Date.now()}`, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
      }),
    ]);

    if (!geoRes.ok) throw new Error('Не вдалося завантажити GeoJSON');
    const oblastGeojson = oblastRes.ok ? await oblastRes.json() : null;
    const maskGeojson = maskRes.ok ? await maskRes.json() : null;
    const raionsGeojson = raionsRes.ok ? await raionsRes.json() : null;
    const raionLabelsGeojson = labelsRes.ok ? await labelsRes.json() : null;
    const geojson = await geoRes.json();

    let outagesPayload = { updated_at: null, data: {} };
    if (outagesRes.ok) {
      outagesPayload = await outagesRes.json();
    }

    const outagesMap = outagesPayload.data || {};
    const normalizedOutagesMap = buildNormalizedOutagesMap(outagesMap);
    updatedAtEl.textContent = `Оновлено: ${formatUpdatedAt(outagesPayload.updated_at)}`;

    window.__zhLastVillagesGeojson = geojson;
    settlementsIndex = [];
    geojson.features.forEach((feat, idx) => {
      const props = feat.properties || {};
      const id = String(props.id ?? idx);
      const pct = lookupOutagePct(outagesMap, normalizedOutagesMap, id, props.name);

      feat.id = idx;
      feat.properties = {
        ...props,
        id,
        outage_percent: pct,
        fill_color: computeOutageColor(pct),
      };

      const center = getGeometryCenter(feat.geometry);

      settlementsIndex.push({
        featureId: idx,
        id,
        name: props.name || 'Без назви',
        hromada: props.hromada || '',
        pct,
        center,
        geometry: feat.geometry,
        searchKey: `${normalizeOutageKey(props.name)} ${normalizeOutageKey(props.hromada)}`,
      });
    });

    updateSituationStats(outagesPayload);
    return { oblastGeojson, maskGeojson, raionsGeojson, raionLabelsGeojson, geojson };
  }

  function normalizeOutageKey(raw) {
    return String(raw || '')
      .toLowerCase()
      .replace(/[\u2019\u2018\u02bc\u02bb\u2032`]/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  function buildNormalizedOutagesMap(outagesMap) {
    const normalized = Object.create(null);
    if (!outagesMap || typeof outagesMap !== 'object') return normalized;
    for (const [k, v] of Object.entries(outagesMap)) {
      if (v === undefined || v === null) continue;
      const nk = normalizeOutageKey(k);
      if (!nk) continue;
      const num = Number(v);
      if (!Number.isFinite(num)) continue;
      if (normalized[nk] === undefined || num > normalized[nk]) {
        normalized[nk] = num;
      }
    }
    return normalized;
  }

  function getGeometryCenter(geometry) {
    if (!geometry) return [0, 0];
    const ring = geometry.type === 'MultiPolygon'
      ? (geometry.coordinates?.[0]?.[0] || [])
      : (geometry.coordinates?.[0] || []);
    let cx = 0;
    let cy = 0;
    if (ring.length > 0) {
      for (const pt of ring) {
        cx += pt[0];
        cy += pt[1];
      }
      cx /= ring.length;
      cy /= ring.length;
    }
    return [cx, cy];
  }

  function lookupOutagePct(outagesMap, normalizedOutagesMap, featureId, featureName) {
    if (!outagesMap) return 0;
    if (featureId != null && outagesMap[featureId] !== undefined && outagesMap[featureId] !== null) {
      return Number(outagesMap[featureId]);
    }
    const normId = normalizeOutageKey(featureId);
    if (normId && normalizedOutagesMap[normId] !== undefined) {
      return normalizedOutagesMap[normId];
    }
    const nameKey = normalizeOutageKey(featureName)
      .replace(/^(?:с\.|село|місто|м\.|селище|смт\.?)\s+/u, '')
      .trim();
    if (nameKey && normalizedOutagesMap[nameKey] !== undefined) {
      return normalizedOutagesMap[nameKey];
    }
    return 0;
  }

  async function fetchOutagesPayload() {
    const url = `${MAP_CONFIG.outagesUrl}?t=${Date.now()}`;
    const res = await fetch(url, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
    });
    if (!res.ok) throw new Error(`outages HTTP ${res.status}`);
    return res.json();
  }

  function applyOutagesToMap(outagesPayload) {
    if (!map || !map.getSource('villages')) return;

    const outagesMap = outagesPayload.data || {};
    const normalizedOutagesMap = buildNormalizedOutagesMap(outagesMap);
    const src = map.getSource('villages');
    const data = src._data || src.serialize?.()?.data;
    // MapLibre GeoJSONSource: get own copy via _data if available
    let geojson = null;
    try {
      // Prefer internal data if present
      if (src._data) geojson = JSON.parse(JSON.stringify(src._data));
    } catch (_) {}

    // Rebuild from settlementsIndex + update source features
    // Safer path: re-fetch is heavy; mutate feature properties via setData
    // We keep last geojson on window-scoped var
    if (!window.__zhLastVillagesGeojson) return;

    geojson = JSON.parse(JSON.stringify(window.__zhLastVillagesGeojson));
    settlementsIndex = [];
    geojson.features.forEach((feat, idx) => {
      const props = feat.properties || {};
      const id = String(props.id ?? idx);
      const pct = lookupOutagePct(outagesMap, normalizedOutagesMap, id, props.name);
      feat.id = idx;
      feat.properties = {
        ...props,
        id,
        outage_percent: pct,
        fill_color: computeOutageColor(pct),
      };
      const center = getGeometryCenter(feat.geometry);
      settlementsIndex.push({
        featureId: idx,
        id,
        name: props.name || 'Без назви',
        hromada: props.hromada || '',
        pct,
        center,
        geometry: feat.geometry,
        searchKey: `${normalizeOutageKey(props.name)} ${normalizeOutageKey(props.hromada)}`,
      });
    });

    src.setData(geojson);
    window.__zhLastVillagesGeojson = geojson;
    if (updatedAtEl) {
      updatedAtEl.textContent = `Оновлено: ${formatUpdatedAt(outagesPayload.updated_at)}`;
    }
    updateSituationStats(outagesPayload);
  }

  let refreshInFlight = false;
  async function refreshOutagesData({ silent = false } = {}) {
    if (refreshInFlight) return false;
    refreshInFlight = true;
    const icon = refreshDataBtn?.querySelector('.refresh-icon');
    if (!silent && refreshDataBtn) {
      refreshDataBtn.classList.add('is-refreshing');
      icon?.classList.add('is-spinning');
    }
    try {
      const payload = await fetchOutagesPayload();
      applyOutagesToMap(payload);
      return true;
    } catch (err) {
      console.error('refreshOutagesData', err);
      if (!silent && updatedAtEl) {
        const prev = updatedAtEl.textContent;
        updatedAtEl.textContent = 'Не вдалося оновити';
        setTimeout(() => {
          if (updatedAtEl.textContent === 'Не вдалося оновити') {
            updatedAtEl.textContent = prev;
          }
        }, 2500);
      }
      return false;
    } finally {
      refreshInFlight = false;
      if (refreshDataBtn) {
        refreshDataBtn.classList.remove('is-refreshing');
        icon?.classList.remove('is-spinning');
      }
    }
  }

  function showSelectedCard(props) {
    const pct = props.outage_percent;
    selectedName.textContent = props.name || 'Населений пункт';
    selectedHromada.textContent = props.hromada || 'Житомирська область';
    selectedSwatch.style.backgroundColor = computeOutageColor(pct);
    selectedSwatch.style.boxShadow =
      pct !== null && pct < 50 ? '0 0 8px rgba(251, 191, 36, 0.8)' : 'none';
    selectedPercent.textContent = pct !== null && pct !== undefined ? `${pct}%` : '—';
    selectedStatusText.textContent = formatStatusLabel(pct);
    selectedCard.hidden = false;
  }

  function clearSelection() {
    if (selectedFeatureId !== null && map.getSource('villages')) {
      map.setFeatureState({ source: 'villages', id: selectedFeatureId }, { selected: false });
    }
    selectedFeatureId = null;
    selectedCard.hidden = true;
  }

  function selectAndFlyTo(item) {
    if (selectedFeatureId !== null) {
      map.setFeatureState({ source: 'villages', id: selectedFeatureId }, { selected: false });
    }
    selectedFeatureId = item.featureId;
    map.setFeatureState({ source: 'villages', id: selectedFeatureId }, { selected: true });

    const bounds = getFeatureBounds(item.geometry);
    map.fitBounds(bounds, {
      padding: { top: 90, bottom: 110, left: 60, right: 60 },
      maxZoom: 12.5,
      duration: 850,
    });

    showSelectedCard({
      name: item.name,
      hromada: item.hromada,
      outage_percent: item.pct,
    });
  }

  function round1(v) {
    return Math.round(v * 10) / 10;
  }

  let cachedOffVillages = [];

  function renderVillagesModalList(query) {
    const q = normalizeOutageKey(query);
    const list = q
      ? settlementsIndex
          .filter((item) => item.searchKey.includes(q))
          .sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0) || a.name.localeCompare(b.name, 'uk'))
          .slice(0, 100)
      : cachedOffVillages.slice(0, 150);

    villagesList.innerHTML = '';
    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.style.padding = '32px 0';
      empty.style.textAlign = 'center';
      empty.style.fontSize = '13.5px';
      empty.style.color = '#94a3b8';
      empty.textContent = 'Населені пункти не знайдено';
      villagesList.appendChild(empty);
      return;
    }

    for (const v of list) {
      const offPct = round1(Math.max(0, Math.min(100, v.pct ?? 0)));
      const litPct = round1(100 - offPct);
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'situation-card';
      card.innerHTML = `
        <div class="situation-card-top">
          <div style="min-width:0">
            <div class="situation-card-title" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${v.name}</div>
            <div class="situation-card-sub">${v.hromada || 'Житомирська область'}</div>
          </div>
          <span class="situation-card-pct">${offPct}% без світла</span>
        </div>
        <div class="situation-card-track">
          <div class="situation-card-fill" style="width:${litPct}%"></div>
        </div>
      `;
      card.addEventListener('click', () => {
        situationModal.hidden = true;
        selectAndFlyTo(v);
      });
      villagesList.appendChild(card);
    }
  }

  function updateSituationStats(outagesPayload) {
    const total = settlementsIndex.length;
    if (total === 0) return;

    const summary = outagesPayload?.summary || null;
    const customRaions = Array.isArray(outagesPayload?.raions) ? outagesPayload.raions : null;

    let offSum = 0;
    let offCount = 0;
    cachedOffVillages = [];
    const byRaion = new Map();

    for (const s of settlementsIndex) {
      const pct = Math.max(0, Math.min(100, s.pct ?? 0));
      offSum += pct;
      if (pct > 0) {
        offCount += 1;
        cachedOffVillages.push(s);
      }

      const rName = s.hromada || 'Житомирський район';
      let bucket = byRaion.get(rName);
      if (!bucket) {
        bucket = {
          offSum: 0,
          offCount: 0,
          totalCount: 0,
          bounds: new maplibregl.LngLatBounds(),
        };
        byRaion.set(rName, bucket);
      }
      bucket.offSum += pct;
      bucket.totalCount += 1;
      if (pct > 0) bucket.offCount += 1;
      if (s.center[0] && s.center[1]) bucket.bounds.extend(s.center);
    }

    const oblastOffPct =
      summary && summary.off_percent !== undefined
        ? round1(Math.max(0, Math.min(100, summary.off_percent)))
        : round1(offSum / total);
    const oblastLitPct = round1(100 - oblastOffPct);
    const displayOffCount = summary?.off_settlements ?? offCount;

    situationBtnPct.textContent = `${oblastOffPct}%`;
    situationBtnPct.hidden = false;
    situationOblastPct.textContent = `${oblastOffPct}%`;
    situationOblastSub.textContent =
      summary?.off_streets !== undefined && summary?.total_streets !== undefined
        ? `${Number(summary.off_streets).toLocaleString('uk-UA')} з ${Number(summary.total_streets).toLocaleString('uk-UA')} вулиць області зараз знеструмлені (${displayOffCount} н.п.)`
        : `${displayOffCount} з ${total} населених пунктів області мають відключення`;
    situationOblastBar.style.width = `${oblastLitPct}%`;
    tabVillagesCount.textContent = String(displayOffCount);

    const boundsByBase = new Map();
    for (const [name, b] of byRaion.entries()) {
      boundsByBase.set(name.replace(/\s+район$/i, '').toLowerCase(), b.bounds);
    }

    const raions = customRaions && customRaions.length > 0
      ? customRaions
          .map((r) => {
            const base = String(r.name || '').replace(/\s+(район|РЕМ)$/i, '').trim();
            const offPct = round1(Math.max(0, Math.min(100, Number(r.off_percent || 0))));
            return {
              name: r.name,
              remName: `${base} РЕМ`,
              offPct,
              litPct: round1(100 - offPct),
              offCount: r.off_settlements ?? 0,
              offStreets: r.off_streets,
              offSettlementsPct: round1(r.off_settlements_percent ?? 0),
              bounds: boundsByBase.get(base.toLowerCase()) || null,
            };
          })
          .sort((a, b) => b.offPct - a.offPct || (b.offStreets ?? b.offCount) - (a.offStreets ?? a.offCount))
      : Array.from(byRaion.entries())
          .map(([name, b]) => {
            const offPct = round1(b.offSum / b.totalCount);
            return {
              name,
              remName: `${name.replace(/\s+район$/i, '')} РЕМ`,
              offPct,
              litPct: round1(100 - offPct),
              offCount: b.offCount,
              offSettlementsPct: round1((b.offCount / b.totalCount) * 100),
              bounds: b.bounds,
            };
          })
          .sort((a, b) => b.offPct - a.offPct || b.offCount - a.offCount);

    raionsList.innerHTML = '';
    for (const r of raions) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'situation-card';
      const leftLabel =
        r.offStreets !== undefined
          ? `${Number(r.offStreets).toLocaleString('uk-UA')} вул. знеструмлено`
          : `${r.offCount} н.п. знеструмлено`;
      card.innerHTML = `
        <div class="situation-card-top">
          <span class="situation-card-title">${r.remName}</span>
          <span class="situation-card-pct">${r.offPct}% без світла</span>
        </div>
        <div class="situation-card-track">
          <div class="situation-card-fill" style="width:${r.litPct}%"></div>
        </div>
        <div class="situation-card-bottom">
          <span>${leftLabel}</span>
          <span style="font-family:var(--font-mono)">${r.offSettlementsPct}% н.п. off</span>
        </div>
      `;
      card.addEventListener('click', () => {
        situationModal.hidden = true;
        if (r.bounds) {
          map.fitBounds(r.bounds, {
            padding: { top: 80, bottom: 90, left: 50, right: 50 },
            maxZoom: 10.2,
            duration: 800,
          });
        }
      });
      raionsList.appendChild(card);
    }

    cachedOffVillages.sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0) || a.name.localeCompare(b.name, 'uk'));
    renderVillagesModalList(modalVillageSearch.value);
  }

  situationBtn.addEventListener('click', () => {
    situationModal.hidden = false;
  });
  situationClose.addEventListener('click', () => {
    situationModal.hidden = true;
  });
  tabRaions.addEventListener('click', () => {
    tabRaions.classList.add('is-active');
    tabVillages.classList.remove('is-active');
    panelRaions.hidden = false;
    panelVillages.hidden = true;
  });
  tabVillages.addEventListener('click', () => {
    tabVillages.classList.add('is-active');
    tabRaions.classList.remove('is-active');
    panelVillages.hidden = false;
    panelRaions.hidden = true;
  });
  modalVillageSearch.addEventListener('input', (e) => {
    renderVillagesModalList(e.target.value);
  });

  if (refreshDataBtn) {
    refreshDataBtn.addEventListener('click', async () => {
      await refreshOutagesData({ silent: false });
      map.flyTo({
        center: MAP_CONFIG.center,
        zoom: MAP_CONFIG.zoom,
        duration: 750,
      });
    });
  }

  // Автооновлення раз на N хвилин (лише коли вкладка видима)
  setInterval(() => {
    if (document.visibilityState === 'visible') {
      refreshOutagesData({ silent: true });
    }
  }, AUTO_REFRESH_MINUTES * 60 * 1000);

  // Оновити одразу після повернення в застосунок
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refreshOutagesData({ silent: true });
    }
  });

  selectedClose.addEventListener('click', clearSelection);

  map.on('load', async () => {
    try {
      const { oblastGeojson, maskGeojson, raionsGeojson, raionLabelsGeojson, geojson } = await loadMapData();

      map.addSource('villages', {
        type: 'geojson',
        data: geojson,
      });

      // Чітка заливка кожного населеного пункту (вогняне світло при 0%, темрява при аварії)
      map.addLayer({
        id: 'villages-fill',
        type: 'fill',
        source: 'villages',
        paint: {
          'fill-color': ['get', 'fill_color'],
          'fill-opacity': [
            'case',
            ['boolean', ['feature-state', 'selected'], false],
            0.95,
            ['boolean', ['feature-state', 'hover'], false],
            0.92,
            0.82,
          ],
        },
      });

      // Чітка нерозмита межа між сусідніми населеними пунктами
      map.addLayer({
        id: 'villages-outline',
        type: 'line',
        source: 'villages',
        paint: {
          'line-color': [
            'case',
            ['boolean', ['feature-state', 'selected'], false],
            '#ffffff',
            ['boolean', ['feature-state', 'hover'], false],
            '#fef3c7',
            ['>=', ['coalesce', ['get', 'outage_percent'], 0], 65],
            '#2e294e',
            '#78350f',
          ],
          'line-width': [
            'interpolate',
            ['linear'],
            ['zoom'],
            7,
            [
              'case',
              ['boolean', ['feature-state', 'selected'], false],
              1.8,
              ['boolean', ['feature-state', 'hover'], false],
              1.4,
              0.55,
            ],
            10,
            [
              'case',
              ['boolean', ['feature-state', 'selected'], false],
              2.0,
              ['boolean', ['feature-state', 'hover'], false],
              1.5,
              0.9,
            ],
            13,
            [
              'case',
              ['boolean', ['feature-state', 'selected'], false],
              2.4,
              ['boolean', ['feature-state', 'hover'], false],
              1.8,
              1.3,
            ],
          ],
          'line-opacity': [
            'case',
            ['boolean', ['feature-state', 'selected'], false],
            1,
            ['boolean', ['feature-state', 'hover'], false],
            0.95,
            0.75,
          ],
        },
      });

      // Підсвічені межі 19 районів області (перед маскою області)
      if (raionsGeojson) {
        map.addSource('zhytomyr-raions', {
          type: 'geojson',
          data: raionsGeojson,
        });

        map.addLayer({
          id: 'raions-glow',
          type: 'line',
          source: 'zhytomyr-raions',
          paint: {
            'line-color': '#fef08a',
            'line-width': 4.5,
            'line-blur': 4,
            'line-opacity': 0.42,
          },
        });

        map.addLayer({
          id: 'raions-border',
          type: 'line',
          source: 'zhytomyr-raions',
          paint: {
            'line-color': '#fef3c7',
            'line-width': 1.4,
            'line-opacity': 0.9,
          },
        });
      }

      // Маска за межами Житомирської області — ідеально обрізає край по межі області
      if (maskGeojson) {
        map.addSource('zhytomyr-mask', {
          type: 'geojson',
          data: maskGeojson,
        });

        map.addLayer({
          id: 'oblast-outside-mask',
          type: 'fill',
          source: 'zhytomyr-mask',
          paint: {
            'fill-color': '#06080e',
            'fill-opacity': 1,
          },
        });
      }

      // Світіння та чіткий контур зовнішньої межі Житомирської області
      if (oblastGeojson) {
        map.addSource('zhytomyr-oblast', {
          type: 'geojson',
          data: oblastGeojson,
        });

        map.addLayer({
          id: 'oblast-glow-outer',
          type: 'line',
          source: 'zhytomyr-oblast',
          paint: {
            'line-color': '#f59e0b',
            'line-width': 12,
            'line-blur': 12,
            'line-opacity': 0.35,
          },
        });

        map.addLayer({
          id: 'oblast-border',
          type: 'line',
          source: 'zhytomyr-oblast',
          paint: {
            'line-color': '#fde68a',
            'line-width': 1.8,
            'line-opacity': 0.95,
          },
        });
      }


      // Підігнати область під екран (особливо важливо на мобільних)
      if (oblastGeojson && oblastGeojson.features && oblastGeojson.features.length) {
        try {
          const ob = getFeatureBounds(oblastGeojson.features[0].geometry);
          const isNarrow = window.innerWidth < 640;
          map.fitBounds(ob, {
            padding: isNarrow
              ? { top: 72, bottom: 140, left: 20, right: 20 }
              : { top: 48, bottom: 100, left: 40, right: 40 },
            duration: 0,
            maxZoom: 8.5,
          });
        } catch (e) {
          console.warn('fitBounds oblast', e);
        }
      }

      // Назви 19 районів текстом (завжди видимі на мінімальному збільшенні)
      if (raionLabelsGeojson && Array.isArray(raionLabelsGeojson.features)) {
        const labelInners = [];
        for (const feat of raionLabelsGeojson.features) {
          const wrapper = document.createElement('div');
          wrapper.style.pointerEvents = 'none';
          wrapper.style.userSelect = 'none';

          const inner = document.createElement('span');
          inner.className = 'raion-label';
          inner.textContent = feat.properties.name;
          wrapper.appendChild(inner);
          labelInners.push(inner);

          new maplibregl.Marker({ element: wrapper, anchor: 'center' })
            .setLngLat(feat.geometry.coordinates)
            .addTo(map);
        }

        const updateLabelVisibility = () => {
          const z = map.getZoom();
          const opacity = z > 10.6 ? '0.35' : '1';
          const scale = z < 7.2 ? 'scale(0.9)' : 'scale(1)';
          for (const inner of labelInners) {
            inner.style.opacity = opacity;
            inner.style.transform = scale;
          }
        };
        map.on('zoom', updateLabelVisibility);
        updateLabelVisibility();
      }

      // Назви населених пунктів: приховані на мінімальному зумі, з'являються при наближенні (zoom >= 10.6)
      let activeVillageMarkers = [];
      const updateVillageLabels = () => {
        for (const m of activeVillageMarkers) m.remove();
        activeVillageMarkers = [];

        const z = map.getZoom();
        if (z < 10.6) return;

        const bounds = map.getBounds();
        const placedBoxes = [];
        const skipCollision = z >= 12.0;
        const padX = 34;
        const padY = 12;

        for (const item of settlementsIndex) {
          const [lng, lat] = item.center;
          if (!bounds.contains([lng, lat])) continue;

          if (!skipCollision) {
            const pt = map.project([lng, lat]);
            const box = {
              x1: pt.x - padX,
              x2: pt.x + padX,
              y1: pt.y - padY,
              y2: pt.y + padY,
            };

            let overlaps = false;
            for (const b of placedBoxes) {
              if (box.x1 < b.x2 && box.x2 > b.x1 && box.y1 < b.y2 && box.y2 > b.y1) {
                overlaps = true;
                break;
              }
            }
            if (overlaps) continue;
            placedBoxes.push(box);
          }

          const el = document.createElement('div');
          el.className = 'village-label';
          el.textContent = item.name;
          const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
            .setLngLat([lng, lat])
            .addTo(map);
          activeVillageMarkers.push(marker);

          if (activeVillageMarkers.length >= 300) break;
        }
      };

      map.on('moveend', updateVillageLabels);
      map.on('zoomend', updateVillageLabels);
      updateVillageLabels();

      map.on('mousemove', 'villages-fill', (e) => {
        if (!e.features || e.features.length === 0) return;
        map.getCanvas().style.cursor = 'pointer';

        const feat = e.features[0];
        if (hoveredFeatureId !== null && hoveredFeatureId !== feat.id) {
          map.setFeatureState({ source: 'villages', id: hoveredFeatureId }, { hover: false });
        }
        hoveredFeatureId = feat.id;
        map.setFeatureState({ source: 'villages', id: hoveredFeatureId }, { hover: true });

        const props = feat.properties;
        const pct = props.outage_percent;
        const color = computeOutageColor(pct);
        const pctText = pct !== null && pct !== undefined ? `${pct}%` : '—';
        const statusText = formatStatusLabel(pct);
        const glowStyle = pct !== null && pct < 50 ? 'box-shadow:0 0 8px rgba(251,191,36,0.8);' : '';

        hoverTooltip.innerHTML = `
          <div class="tooltip-name">${props.name || 'Населений пункт'}</div>
          <div class="tooltip-hromada">${props.hromada || 'Житомирська область'}</div>
          <div class="tooltip-metric">
            <span class="tooltip-swatch" style="background:${color};${glowStyle}"></span>
            <span class="tooltip-pct">${pctText}</span>
            <span>${statusText}</span>
          </div>
        `;

        const pad = 14;
        const x = Math.min(window.innerWidth - 270, e.originalEvent.clientX + pad);
        const y = Math.min(window.innerHeight - 110, e.originalEvent.clientY + pad);
        hoverTooltip.style.left = `${x}px`;
        hoverTooltip.style.top = `${y}px`;
        hoverTooltip.hidden = false;
      });

      map.on('mouseleave', 'villages-fill', () => {
        map.getCanvas().style.cursor = '';
        if (hoveredFeatureId !== null) {
          map.setFeatureState({ source: 'villages', id: hoveredFeatureId }, { hover: false });
          hoveredFeatureId = null;
        }
        hoverTooltip.hidden = true;
      });

      map.on('click', 'villages-fill', (e) => {
        if (!e.features || e.features.length === 0) return;
        const feat = e.features[0];
        if (selectedFeatureId !== null) {
          map.setFeatureState({ source: 'villages', id: selectedFeatureId }, { selected: false });
        }
        selectedFeatureId = feat.id;
        map.setFeatureState({ source: 'villages', id: selectedFeatureId }, { selected: true });
        showSelectedCard(feat.properties);
      });
    } catch (err) {
      console.error(err);
      updatedAtEl.textContent = 'Помилка завантаження даних';
    }
  });
})();
