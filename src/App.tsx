import { useEffect, useMemo, useRef, useState } from 'react';
import * as maplibregl from 'maplibre-gl';
import { BarChart3, RotateCcw, Search, X } from 'lucide-react';

interface GeoJsonGeometry {
  type: string;
  coordinates: unknown;
}

interface GeoJsonFeature {
  id?: string | number;
  type: 'Feature';
  properties: Record<string, unknown> | null;
  geometry: GeoJsonGeometry;
}

interface GeoJsonFeatureCollection {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
}

interface SettlementProperties {
  id: string;
  name: string;
  hromada: string;
  outage_percent: number | null;
}

interface SettlementItem {
  featureId: number;
  id: string;
  name: string;
  hromada: string;
  pct: number | null;
  center: [number, number];
  geometry: GeoJsonGeometry;
  searchKey: string;
}

interface HoverState {
  name: string;
  hromada: string;
  pct: number | null;
  x: number;
  y: number;
}

interface OutagesSummary {
  off_percent?: number;
  off_streets?: number;
  total_streets?: number;
  off_settlements?: number;
  total_settlements?: number;
}

interface OutagesRaionItem {
  name: string;
  off_percent: number;
  off_streets?: number;
  off_settlements?: number;
  off_settlements_percent?: number;
}

interface OutagesPayload {
  updated_at: string | null;
  summary?: OutagesSummary;
  raions?: OutagesRaionItem[];
  data: Record<string, number>;
}

const ZHYTOMYR_CENTER: [number, number] = [28.66, 50.65];
const ZHYTOMYR_ZOOM = 7.7;
// Щоб брати дані з іншого репозиторію, замініть на:
// 'https://raw.githubusercontent.com/<USER>/<REPO>/main/outages.json'
const OUTAGES_URL = './data/outages.json';

const DARK_ISOLATED_STYLE: maplibregl.StyleSpecification = {
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
function computeOutageColor(pct: number | null): string {
  if (pct === null || Number.isNaN(pct)) return '#475569';
  const p = Math.max(0, Math.min(100, pct)) / 100;
  const hue = (48 - 72 * p + 360) % 360;
  const sat = 96 - 68 * Math.pow(p, 2.2);
  const light = 64 - 58 * Math.pow(p, 1.15);
  return `hsl(${hue.toFixed(1)}, ${sat.toFixed(1)}%, ${light.toFixed(1)}%)`;
}

function buildFormulaGradientCss(): string {
  const stops: string[] = [];
  for (let pct = 0; pct <= 100; pct += 5) {
    stops.push(`${computeOutageColor(pct)} ${pct}%`);
  }
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

function formatStatusLabel(pct: number | null): string {
  if (pct === null) return 'немає даних';
  if (pct === 0) return 'світло є';
  if (pct >= 80) return 'аварія · без світла';
  return 'без світла';
}

function formatUpdatedAt(isoString: string | null): string {
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

function getFeatureBounds(geometry: GeoJsonGeometry): maplibregl.LngLatBounds {
  const bounds = new maplibregl.LngLatBounds();
  const walk = (coords: unknown) => {
    if (Array.isArray(coords) && typeof coords[0] === 'number') {
      bounds.extend(coords as [number, number]);
    } else if (Array.isArray(coords)) {
      for (const c of coords) walk(c);
    }
  };
  walk(geometry.coordinates);
  return bounds;
}

export default function App() {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const hoveredIdRef = useRef<number | null>(null);
  const selectedIdRef = useRef<number | null>(null);
  const [settlements, setSettlements] = useState<SettlementItem[]>([]);
  const [outagesSummary, setOutagesSummary] = useState<OutagesSummary | null>(null);
  const [outagesRaions, setOutagesRaions] = useState<OutagesRaionItem[] | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [situationOpen, setSituationOpen] = useState(false);
  const [situationTab, setSituationTab] = useState<'raions' | 'villages'>('raions');
  const [modalSearch, setModalSearch] = useState('');
  const [hoverInfo, setHoverInfo] = useState<HoverState | null>(null);
  const [selectedInfo, setSelectedInfo] = useState<{
    name: string;
    hromada: string;
    pct: number | null;
  } | null>(null);

  const situationStats = useMemo(() => {
    const total = settlements.length;
    if (total === 0) {
      return {
        oblastOffPct: 0,
        oblastLitPct: 100,
        offCount: 0,
        totalCount: 0,
        raions: [] as Array<{
          name: string;
          remName: string;
          offPct: number;
          litPct: number;
          offCount: number;
          offStreets?: number;
          totalCount: number;
          offSettlementsPct: number;
          bounds: maplibregl.LngLatBounds | null;
        }>,
        offVillages: [] as SettlementItem[],
      };
    }

    let offSum = 0;
    let offCount = 0;
    const offVillages: SettlementItem[] = [];
    const byRaion = new Map<
      string,
      { offSum: number; offCount: number; totalCount: number; bounds: maplibregl.LngLatBounds }
    >();

    for (const s of settlements) {
      const pct = Math.max(0, Math.min(100, s.pct ?? 0));
      offSum += pct;
      if (pct > 0) {
        offCount += 1;
        offVillages.push(s);
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
      if (s.center[0] && s.center[1]) {
        bucket.bounds.extend(s.center);
      }
    }

    const round1 = (v: number) => Math.round(v * 10) / 10;

    const boundsByRaion = new Map<string, maplibregl.LngLatBounds>();
    for (const [name, b] of byRaion.entries()) {
      boundsByRaion.set(name.replace(/\s+район$/i, '').toLowerCase(), b.bounds);
    }

    let raions: Array<{
      name: string;
      remName: string;
      offPct: number;
      litPct: number;
      offCount: number;
      offStreets?: number;
      totalCount: number;
      offSettlementsPct: number;
      bounds: maplibregl.LngLatBounds | null;
    }>;

    if (outagesRaions && outagesRaions.length > 0) {
      raions = outagesRaions
        .map((r) => {
          const base = r.name.replace(/\s+(район|РЕМ)$/i, '').trim();
          const offPct = round1(Math.max(0, Math.min(100, r.off_percent)));
          return {
            name: r.name,
            remName: `${base} РЕМ`,
            offPct,
            litPct: round1(100 - offPct),
            offCount: r.off_settlements ?? 0,
            offStreets: r.off_streets,
            totalCount: 0,
            offSettlementsPct: round1(r.off_settlements_percent ?? 0),
            bounds: boundsByRaion.get(base.toLowerCase()) ?? null,
          };
        })
        .sort((a, b) => b.offPct - a.offPct || (b.offStreets ?? b.offCount) - (a.offStreets ?? a.offCount));
    } else {
      raions = Array.from(byRaion.entries())
        .map(([name, b]) => {
          const remName = name.replace(/\s+район$/i, '') + ' РЕМ';
          const offPct = round1(b.offSum / b.totalCount);
          return {
            name,
            remName,
            offPct,
            litPct: round1(100 - offPct),
            offCount: b.offCount,
            totalCount: b.totalCount,
            offSettlementsPct: round1((b.offCount / b.totalCount) * 100),
            bounds: b.bounds,
          };
        })
        .sort((a, b) => b.offPct - a.offPct || b.offCount - a.offCount);
    }

    offVillages.sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0) || a.name.localeCompare(b.name, 'uk'));

    const computedOffPct = round1(offSum / total);
    const oblastOffPct =
      outagesSummary?.off_percent !== undefined
        ? round1(Math.max(0, Math.min(100, outagesSummary.off_percent)))
        : computedOffPct;

    return {
      oblastOffPct,
      oblastLitPct: round1(100 - oblastOffPct),
      offCount: outagesSummary?.off_settlements ?? offCount,
      totalCount: outagesSummary?.total_settlements ?? total,
      offStreets: outagesSummary?.off_streets,
      totalStreets: outagesSummary?.total_streets,
      raions,
      offVillages,
    };
  }, [settlements, outagesSummary, outagesRaions]);

  const filteredModalVillages = useMemo(() => {
    const q = modalSearch.trim().toLowerCase();
    if (!q) return situationStats.offVillages.slice(0, 150);
    return settlements
      .filter((item) => item.searchKey.includes(q))
      .sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0) || a.name.localeCompare(b.name, 'uk'))
      .slice(0, 100);
  }, [settlements, situationStats.offVillages, modalSearch]);

  useEffect(() => {
    if (!mapContainerRef.current) return;

    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: mapContainerRef.current,
        style: DARK_ISOLATED_STYLE,
        center: ZHYTOMYR_CENTER,
        zoom: ZHYTOMYR_ZOOM,
        minZoom: 6.5,
        maxZoom: 14,
        attributionControl: false,
      });
      mapRef.current = map;
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    } catch {
      setLoadError('Помилка ініціалізації мапи (WebGL)');
      return;
    }

    map.on('load', async () => {
      try {
        const [oblastRes, maskRes, raionsRes, labelsRes, geoRes, outagesRes] = await Promise.all([
          fetch('./data/zhytomyr_oblast.geojson', { cache: 'no-cache' }),
          fetch('./data/zhytomyr_mask.geojson', { cache: 'no-cache' }),
          fetch('./data/zhytomyr_raions.geojson', { cache: 'no-cache' }),
          fetch('./data/zhytomyr_raion_labels.geojson', { cache: 'no-cache' }),
          fetch('./data/zhytomyr_villages.geojson', { cache: 'no-cache' }),
          fetch(`${OUTAGES_URL}?t=${Date.now()}`, { cache: 'no-cache' }),
        ]);

        if (!geoRes.ok) throw new Error('Помилка завантаження GeoJSON');
        const oblastGeojson = oblastRes.ok ? await oblastRes.json() : null;
        const maskGeojson = maskRes.ok ? await maskRes.json() : null;
        const raionsGeojson = raionsRes.ok ? await raionsRes.json() : null;
        const raionLabelsGeojson = labelsRes.ok ? (await labelsRes.json()) as GeoJsonFeatureCollection : null;
        const geojson = (await geoRes.json()) as GeoJsonFeatureCollection;

        let outagesPayload: OutagesPayload = {
          updated_at: null,
          data: {},
        };
        if (outagesRes.ok) {
          outagesPayload = await outagesRes.json();
        }
        setUpdatedAt(outagesPayload.updated_at);
        setOutagesSummary(outagesPayload.summary ?? null);
        setOutagesRaions(outagesPayload.raions ?? null);

        const indexList: SettlementItem[] = [];
        geojson.features.forEach((feat: GeoJsonFeature, idx: number) => {
          const props = (feat.properties || {}) as Record<string, unknown>;
          const id = String(props.id ?? idx);
          const rawPct = outagesPayload.data?.[id];
          const pct = rawPct !== undefined && rawPct !== null ? Number(rawPct) : 0;
          const name = String(props.name || 'Без назви');
          const hromada = String(props.hromada || '');

          feat.id = idx;
          feat.properties = {
            id,
            name,
            hromada,
            outage_percent: pct,
            fill_color: computeOutageColor(pct),
          };

          const ring = (feat.geometry.coordinates as number[][][])?.[0] || [];
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

          indexList.push({
            featureId: idx,
            id,
            name,
            hromada,
            pct,
            center: [cx, cy],
            geometry: feat.geometry,
            searchKey: `${name.toLowerCase()} ${hromada.toLowerCase()}`,
          });
        });

        setSettlements(indexList);

        map.addSource('villages', {
          type: 'geojson',
          data: geojson as unknown as string,
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

        // Назви 19 районів текстом (завжди видимі на мінімальному збільшенні)
        if (raionLabelsGeojson && Array.isArray(raionLabelsGeojson.features)) {
          const labelEls: HTMLDivElement[] = [];
          for (const feat of raionLabelsGeojson.features) {
            const coords = feat.geometry.coordinates as [number, number];
            const el = document.createElement('div');
            el.textContent = String(feat.properties?.name || '');
            el.style.pointerEvents = 'none';
            el.style.userSelect = 'none';
            el.style.fontSize = '11px';
            el.style.fontWeight = '700';
            el.style.letterSpacing = '0.02em';
            el.style.color = 'rgba(254, 243, 199, 0.94)';
            el.style.textShadow =
              '0 1px 3px rgba(6,8,14,0.98), 0 0 8px rgba(6,8,14,0.95), 0 0 2px rgba(6,8,14,1)';
            el.style.whiteSpace = 'nowrap';
            el.style.transition = 'opacity 200ms ease';
            labelEls.push(el);
            new maplibregl.Marker({ element: el, anchor: 'center' })
              .setLngLat(coords)
              .addTo(map);
          }

          const updateLabelVisibility = () => {
            const z = map.getZoom();
            const opacity = z > 10.6 ? '0.35' : '1';
            for (const el of labelEls) {
              el.style.opacity = opacity;
            }
          };
          map.on('zoom', updateLabelVisibility);
          updateLabelVisibility();
        }

        // Назви населених пунктів: приховані на мінімальному зумі, з'являються при наближенні (zoom >= 10.6)
        let activeVillageMarkers: maplibregl.Marker[] = [];
        const updateVillageLabels = () => {
          for (const m of activeVillageMarkers) m.remove();
          activeVillageMarkers = [];

          const z = map.getZoom();
          if (z < 10.6) return;

          const bounds = map.getBounds();
          const placedBoxes: Array<{ x1: number; x2: number; y1: number; y2: number }> = [];
          const skipCollision = z >= 12.0;
          const padX = 34;
          const padY = 12;

          for (const item of indexList) {
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
            el.textContent = item.name;
            el.style.pointerEvents = 'none';
            el.style.userSelect = 'none';
            el.style.fontSize = '11px';
            el.style.fontWeight = '600';
            el.style.color = '#ffffff';
            el.style.textShadow =
              '0 1px 3px rgba(6,8,14,0.98), 0 0 6px rgba(6,8,14,0.95), 0 0 2px rgba(6,8,14,1)';
            el.style.whiteSpace = 'nowrap';

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

        map.on('mousemove', 'villages-fill', (e: maplibregl.MapLayerMouseEvent) => {
          if (!e.features || e.features.length === 0) return;
          map.getCanvas().style.cursor = 'pointer';

          const feat = e.features[0];
          const fid = Number(feat.id);
          if (hoveredIdRef.current !== null && hoveredIdRef.current !== fid) {
            map.setFeatureState({ source: 'villages', id: hoveredIdRef.current }, { hover: false });
          }
          hoveredIdRef.current = fid;
          map.setFeatureState({ source: 'villages', id: fid }, { hover: true });

          const props = feat.properties as unknown as SettlementProperties;
          const pct =
            props.outage_percent !== null && props.outage_percent !== undefined
              ? Number(props.outage_percent)
              : null;

          setHoverInfo({
            name: props.name || 'Населений пункт',
            hromada: props.hromada || '',
            pct,
            x: Math.min(window.innerWidth - 270, e.originalEvent.clientX + 14),
            y: Math.min(window.innerHeight - 110, e.originalEvent.clientY + 14),
          });
        });

        map.on('mouseleave', 'villages-fill', () => {
          map.getCanvas().style.cursor = '';
          if (hoveredIdRef.current !== null) {
            map.setFeatureState({ source: 'villages', id: hoveredIdRef.current }, { hover: false });
            hoveredIdRef.current = null;
          }
          setHoverInfo(null);
        });

        map.on('click', 'villages-fill', (e: maplibregl.MapLayerMouseEvent) => {
          if (!e.features || e.features.length === 0) return;
          const feat = e.features[0];
          const fid = Number(feat.id);
          if (selectedIdRef.current !== null) {
            map.setFeatureState({ source: 'villages', id: selectedIdRef.current }, { selected: false });
          }
          selectedIdRef.current = fid;
          map.setFeatureState({ source: 'villages', id: fid }, { selected: true });

          const props = feat.properties as unknown as SettlementProperties;
          const pct =
            props.outage_percent !== null && props.outage_percent !== undefined
              ? Number(props.outage_percent)
              : null;

          setSelectedInfo({
            name: props.name || 'Населений пункт',
            hromada: props.hromada || '',
            pct,
          });
        });
      } catch {
        setLoadError('Помилка завантаження даних');
      }
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  const handleSelectSettlement = (item: SettlementItem) => {
    setSituationOpen(false);
    const map = mapRef.current;
    if (!map) return;

    if (selectedIdRef.current !== null) {
      map.setFeatureState({ source: 'villages', id: selectedIdRef.current }, { selected: false });
    }
    selectedIdRef.current = item.featureId;
    map.setFeatureState({ source: 'villages', id: item.featureId }, { selected: true });

    const bounds = getFeatureBounds(item.geometry);
    map.fitBounds(bounds, {
      padding: { top: 90, bottom: 110, left: 60, right: 60 },
      maxZoom: 12.5,
      duration: 850,
    });

    setSelectedInfo({
      name: item.name,
      hromada: item.hromada,
      pct: item.pct,
    });
  };

  const handleSelectRaion = (bounds: maplibregl.LngLatBounds | null) => {
    setSituationOpen(false);
    if (!bounds || !mapRef.current) return;
    mapRef.current.fitBounds(bounds, {
      padding: { top: 80, bottom: 90, left: 50, right: 50 },
      maxZoom: 10.2,
      duration: 800,
    });
  };

  const handleResetView = () => {
    mapRef.current?.flyTo({
      center: ZHYTOMYR_CENTER,
      zoom: ZHYTOMYR_ZOOM,
      duration: 750,
    });
  };

  const handleCloseSelected = () => {
    if (selectedIdRef.current !== null && mapRef.current?.getSource('villages')) {
      mapRef.current.setFeatureState(
        { source: 'villages', id: selectedIdRef.current },
        { selected: false }
      );
    }
    selectedIdRef.current = null;
    setSelectedInfo(null);
  };

  return (
    <main className="relative w-screen h-screen overflow-hidden bg-[#06080e]">
      <div
        ref={mapContainerRef}
        className="w-full h-full"
        role="application"
        aria-label="Інтерактивна мапа відключень Житомирської області"
      />

      {/* Кнопка перегляду ситуації по області (верхній лівий кут) */}
      <button
        type="button"
        onClick={() => setSituationOpen(true)}
        aria-label="Переглянути ситуацію по області"
        className="absolute top-4 left-4 z-20 inline-flex items-center gap-2.5 h-11 px-3.5 bg-[#0d101a]/88 backdrop-blur-md border border-amber-400/25 rounded-xl shadow-[0_10px_36px_rgba(0,0,0,0.55)] text-[13px] font-semibold text-slate-50 hover:border-amber-400/55 active:scale-[0.98] transition-all whitespace-nowrap"
      >
        <BarChart3 className="w-4 h-4 text-amber-400 shrink-0" aria-hidden="true" />
        <span>Ситуація</span>
        {settlements.length > 0 && (
          <span className="font-mono-tabular text-amber-300 font-bold">
            {situationStats.oblastOffPct}%
          </span>
        )}
      </button>

      {/* Кнопка скидання виду */}
      <button
        type="button"
        onClick={handleResetView}
        title="Показати всю Житомирську область"
        aria-label="Показати всю Житомирську область"
        className="absolute top-4 right-4 z-20 inline-flex items-center gap-2 h-11 px-3 sm:px-3.5 bg-[#0d101a]/84 backdrop-blur-md border border-amber-400/20 rounded-xl shadow-[0_10px_36px_rgba(0,0,0,0.55)] text-[13px] font-semibold text-slate-50 hover:border-amber-400/45 active:scale-[0.98] transition-all whitespace-nowrap shrink-0"
      >
        <RotateCcw className="w-4 h-4" aria-hidden="true" />
        <span className="hidden sm:inline">Вся область</span>
      </button>

      {/* Glassmorphism Tooltip при наведенні */}
      {hoverInfo && (
        <div
          role="status"
          aria-live="polite"
          style={{ left: hoverInfo.x, top: hoverInfo.y }}
          className="fixed z-30 pointer-events-none min-w-[195px] max-w-[265px] px-3 py-2.5 bg-[#0d101a]/92 backdrop-blur-md border border-amber-400/20 rounded-xl shadow-[0_10px_36px_rgba(0,0,0,0.55)]"
        >
          <div className="text-[13.5px] font-semibold text-slate-50 leading-snug">
            {hoverInfo.name}
          </div>
          <div className="mt-0.5 text-[11.5px] text-slate-400">
            {hoverInfo.hromada || 'Житомирська область'}
          </div>
          <div className="flex items-center gap-2 mt-2 pt-1.5 border-t border-white/10 text-[12.5px] font-semibold text-slate-50">
            <span
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{
                backgroundColor: computeOutageColor(hoverInfo.pct),
                boxShadow:
                  hoverInfo.pct !== null && hoverInfo.pct < 50
                    ? '0 0 8px rgba(251, 191, 36, 0.85)'
                    : 'none',
              }}
            />
            <span className="font-mono-tabular">
              {hoverInfo.pct !== null ? `${hoverInfo.pct}%` : '—'}
            </span>
            <span>{formatStatusLabel(hoverInfo.pct)}</span>
          </div>
        </div>
      )}

      {/* Закріплена картка при кліку / тапі */}
      {selectedInfo && (
        <aside
          aria-live="polite"
          className="absolute top-[70px] left-3 right-3 sm:top-auto sm:left-auto sm:bottom-4 sm:right-4 z-25 sm:w-[300px] px-4 py-3.5 bg-[#0d101a]/92 backdrop-blur-lg border border-amber-400/20 rounded-xl shadow-[0_10px_36px_rgba(0,0,0,0.55)]"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[15px] font-bold text-slate-50 leading-snug">
                {selectedInfo.name}
              </div>
              <div className="mt-0.5 text-[12.5px] text-slate-400">
                {selectedInfo.hromada || 'Житомирська область'}
              </div>
            </div>
            <button
              type="button"
              onClick={handleCloseSelected}
              aria-label="Закрити картку"
              className="inline-flex items-center justify-center w-8 h-8 rounded-lg text-slate-400 hover:bg-white/10 hover:text-slate-50 transition-colors shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex items-center gap-2 mt-3 pt-2.5 border-t border-white/10">
            <span
              className="w-3 h-3 rounded-full shrink-0"
              style={{
                backgroundColor: computeOutageColor(selectedInfo.pct),
                boxShadow:
                  selectedInfo.pct !== null && selectedInfo.pct < 50
                    ? '0 0 8px rgba(251, 191, 36, 0.85)'
                    : 'none',
              }}
            />
            <span className="font-mono-tabular text-[15px] font-bold text-slate-50">
              {selectedInfo.pct !== null ? `${selectedInfo.pct}%` : '—'}
            </span>
            <span className="text-[13px] text-slate-300">
              {formatStatusLabel(selectedInfo.pct)}
            </span>
          </div>
        </aside>
      )}

      {/* Компактна легенда та статус оновлення */}
      <footer
        aria-label="Легенда та статус оновлення"
        className="absolute bottom-3 left-3 right-3 sm:right-auto sm:bottom-4 sm:left-4 z-20 sm:w-[276px] px-3.5 py-3 bg-[#0d101a]/84 backdrop-blur-md border border-amber-400/20 rounded-xl shadow-[0_10px_36px_rgba(0,0,0,0.55)]"
      >
        <div className="text-xs font-semibold text-slate-50 mb-2">
          Освітлення населених пунктів
        </div>
        <div>
          <div
            aria-hidden="true"
            className="h-2 w-full rounded border border-white/12"
            style={{
              background: buildFormulaGradientCss(),
            }}
          />
          <div className="flex justify-between mt-1.5 font-mono-tabular text-[11px] text-slate-400">
            <span>0%</span>
            <span>25%</span>
            <span>50%</span>
            <span>75%</span>
            <span>100%</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 mt-2.5 pt-2 border-t border-white/10 text-[11.5px] text-slate-400">
          <span>Житомирська обл.</span>
          <span aria-hidden="true">·</span>
          <span className="font-mono-tabular">
            {loadError ? loadError : `Оновлено: ${formatUpdatedAt(updatedAt)}`}
          </span>
        </div>
        <div className="mt-1 text-[10.5px] leading-tight text-slate-400/70">
          Неофіційний проєкт · відкриті джерела, можливі неточності
        </div>
      </footer>

      {/* Повноекранна / модальна панель ситуації по області (як на скріншоті) */}
      {situationOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Ситуація з електропостачанням по області"
          className="fixed inset-0 z-40 bg-[#080c17]/96 backdrop-blur-xl flex flex-col"
        >
          <div className="w-full max-w-2xl mx-auto flex flex-col h-full px-4 pt-5 pb-4">
            {/* Верхній блок: % зі світлом + кнопка закриття */}
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="font-mono-tabular text-3xl sm:text-4xl font-bold text-[#fbbf24] tracking-tight">
                    {situationStats.oblastOffPct}%
                  </span>
                  <span className="text-sm sm:text-base font-medium text-slate-100">
                    населених пунктів без світла по області
                  </span>
                </div>
                <p className="mt-1 text-xs sm:text-[13px] text-slate-400">
                  {situationStats.offStreets !== undefined && situationStats.totalStreets !== undefined
                    ? `${situationStats.offStreets.toLocaleString('uk-UA')} з ${situationStats.totalStreets.toLocaleString('uk-UA')} вулиць області зараз знеструмлені (${situationStats.offCount} н.п.)`
                    : `${situationStats.offCount} з ${situationStats.totalCount} населених пунктів області мають відключення`}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSituationOpen(false)}
                aria-label="Закрити огляд ситуації"
                className="inline-flex items-center justify-center w-9 h-9 rounded-xl bg-white/5 border border-white/10 text-slate-300 hover:bg-white/10 hover:text-white transition-colors shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Загальний прогрес-бар області */}
            <div className="mt-3.5 h-3.5 w-full rounded-full bg-[#17213a] overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-[#f59e0b] to-[#fde047] transition-all duration-500"
                style={{ width: `${situationStats.oblastLitPct}%` }}
              />
            </div>

            {/* Перемикач вкладок */}
            <div className="mt-4 p-1 rounded-xl bg-[#0e1424] border border-white/10 grid grid-cols-2 gap-1 shrink-0">
              <button
                type="button"
                onClick={() => setSituationTab('raions')}
                className={`py-2 px-3 rounded-lg text-xs sm:text-[13px] font-semibold transition-all ${
                  situationTab === 'raions'
                    ? 'bg-[#fcd34d] text-[#090d16] shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Світло за районами (РЕМ)
              </button>
              <button
                type="button"
                onClick={() => setSituationTab('villages')}
                className={`py-2 px-3 rounded-lg text-xs sm:text-[13px] font-semibold transition-all ${
                  situationTab === 'villages'
                    ? 'bg-[#fcd34d] text-[#090d16] shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Населені пункти ({situationStats.offCount})
              </button>
            </div>

            {situationTab === 'raions' ? (
              <>
                <div className="mt-4 mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400 shrink-0">
                  Рейтинг проблемності районів електричних мереж:
                </div>
                <div className="flex-1 overflow-y-auto space-y-2.5 pr-1 pb-4">
                  {situationStats.raions.map((r) => (
                    <button
                      key={r.name}
                      type="button"
                      onClick={() => handleSelectRaion(r.bounds)}
                      className="w-full text-left p-3.5 rounded-xl bg-[#0d1323] border border-white/8 hover:border-amber-400/35 transition-colors"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-[14px] font-semibold text-slate-100">
                          {r.remName}
                        </span>
                        <span className="font-mono-tabular text-[14px] font-bold text-[#fbbf24]">
                          {r.offPct}% без світла
                        </span>
                      </div>
                      <div className="mt-2.5 h-2.5 w-full rounded-full bg-[#18223b] overflow-hidden">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-[#f59e0b] to-[#fde047]"
                          style={{ width: `${r.litPct}%` }}
                        />
                      </div>
                      <div className="mt-2 flex items-center justify-between text-[11.5px] text-slate-400">
                        <span>
                          {r.offStreets !== undefined
                            ? `${r.offStreets.toLocaleString('uk-UA')} вул. знеструмлено`
                            : `${r.offCount} н.п. знеструмлено`}
                        </span>
                        <span className="font-mono-tabular">{r.offSettlementsPct}% н.п. off</span>
                      </div>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div className="mt-3 mb-2.5 flex items-center gap-2 h-10 px-3 rounded-xl bg-[#0e1424] border border-white/10 focus-within:border-amber-400/45 shrink-0">
                  <Search className="w-4 h-4 text-slate-400 shrink-0" />
                  <input
                    type="search"
                    value={modalSearch}
                    onChange={(e) => setModalSearch(e.target.value)}
                    placeholder="Фільтр за назвою села або району..."
                    className="flex-1 min-w-0 bg-transparent text-sm text-slate-100 placeholder:text-slate-500 outline-none"
                  />
                  {modalSearch && (
                    <button
                      type="button"
                      onClick={() => setModalSearch('')}
                      className="text-slate-400 hover:text-slate-200"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                <div className="flex-1 overflow-y-auto space-y-2 pr-1 pb-4">
                  {filteredModalVillages.length === 0 ? (
                    <div className="py-10 text-center text-sm text-slate-400">
                      Населені пункти не знайдено
                    </div>
                  ) : (
                    filteredModalVillages.map((v) => {
                      const offPct = Math.round(Math.max(0, Math.min(100, v.pct ?? 0)) * 10) / 10;
                      const litPct = Math.round((100 - offPct) * 10) / 10;
                      return (
                        <button
                          key={v.id}
                          type="button"
                          onClick={() => handleSelectSettlement(v)}
                          className="w-full text-left p-3 rounded-xl bg-[#0d1323] border border-white/8 hover:border-amber-400/35 transition-colors"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-[13.5px] font-semibold text-slate-100 truncate">
                                {v.name}
                              </div>
                              <div className="text-[11.5px] text-slate-400 truncate">
                                {v.hromada || 'Житомирська область'}
                              </div>
                            </div>
                            <span className="font-mono-tabular text-[13.5px] font-bold text-[#fbbf24] shrink-0">
                              {offPct}% без світла
                            </span>
                          </div>
                          <div className="mt-2 h-2 w-full rounded-full bg-[#18223b] overflow-hidden">
                            <div
                              className="h-full rounded-full bg-gradient-to-r from-[#f59e0b] to-[#fde047]"
                              style={{ width: `${litPct}%` }}
                            />
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
