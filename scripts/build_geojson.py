#!/usr/bin/env python3
"""
Генератор оптимізованого GeoJSON з межами населених пунктів Житомирської області
на основі довідника data/addresses_directory та відкритих геоданих (Overpass API / KATOTTG).

Використання:
  python scripts/build_geojson.py
  python scripts/build_geojson.py --katottg-geojson path/to/katottg_ua18.geojson
"""

import argparse
import json
import re
import sys
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

import requests
from pyproj import Transformer
from shapely.geometry import GeometryCollection, MultiPolygon, Point, Polygon, mapping, shape
from shapely.ops import polygonize, transform, unary_union

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

OVERPASS_QUERY = """
[out:json][timeout:180];
area["ISO3166-2"="UA-18"]->.zhytomyr;
(
  relation(area.zhytomyr)["boundary"="administrative"]["admin_level"~"^(8|9|10)$"];
  way(area.zhytomyr)["place"~"^(city|town|village|hamlet)$"];
  relation(area.zhytomyr)["place"~"^(city|town|village|hamlet)$"];
  node(area.zhytomyr)["place"~"^(city|town|village|hamlet)$"];
);
out body;
>;
out skel qt;
"""

PREFIX_RE = re.compile(
    r"^(?:с\.|смт\.?|м\.|с-ще|село|місто|селище(?:\s+міського\s+типу)?)\s+",
    re.IGNORECASE,
)
HROMADA_SUFFIX_RE = re.compile(
    r"\s+(?:територіальна\s+громада|громада|тг|міська|селищна|сільська|район|р-н)$",
    re.IGNORECASE,
)


def normalize_text(value: str | None) -> str:
    if not value:
        return ""
    text = value.strip().lower()
    text = text.replace("’", "'").replace("`", "'").replace("ʼ", "'").replace('"', "")
    text = re.sub(r"\s+", " ", text)
    return text


def normalize_settlement_name(name: str | None) -> str:
    text = normalize_text(name)
    text = PREFIX_RE.sub("", text).strip()
    return text


def normalize_hromada_name(name: str | None) -> str:
    text = normalize_text(name)
    for _ in range(2):
        text = HROMADA_SUFFIX_RE.sub("", text).strip()
    return text


def extract_records(raw: Any) -> list[dict[str, Any]]:
    if isinstance(raw, list):
        return [r for r in raw if isinstance(r, dict)]
    if isinstance(raw, dict):
        if isinstance(raw.get("cities"), dict):
            records = []
            for k, v in raw["cities"].items():
                if isinstance(v, dict):
                    rec = dict(v)
                    rec.setdefault("id", k)
                    records.append(rec)
            return records
        for key in ("villages", "settlements", "items", "data", "records"):
            if isinstance(raw.get(key), list):
                return [r for r in raw[key] if isinstance(r, dict)]
        # Словник виду { "id": { ... } }
        records = []
        for k, v in raw.items():
            if isinstance(v, dict):
                rec = dict(v)
                rec.setdefault("id", k)
                records.append(rec)
        return records
    return []


def load_addresses_directory(directory: Path) -> list[dict[str, Any]]:
    index_path = directory / "index.json"
    shards_dir = directory / "shards"

    if not directory.exists():
        raise FileNotFoundError(f"Директорія не знайдена: {directory}")

    raw_items: list[dict[str, Any]] = []

    if shards_dir.exists() and shards_dir.is_dir():
        shard_files = sorted(shards_dir.glob("*.json"))
        for shard_file in shard_files:
            with shard_file.open("r", encoding="utf-8") as f:
                raw_items.extend(extract_records(json.load(f)))

    if not raw_items and index_path.exists():
        with index_path.open("r", encoding="utf-8") as f:
            raw_items.extend(extract_records(json.load(f)))

    # Дедуплікація та нормалізація полів
    seen_ids: set[str] = set()
    settlements: list[dict[str, Any]] = []

    for item in raw_items:
        vid = (
            item.get("id")
            or item.get("village_id")
            or item.get("settlement_id")
            or item.get("katottg")
            or item.get("code")
        )
        name = item.get("name") or item.get("title") or item.get("settlement") or item.get("village")
        if not vid or not name:
            continue

        vid_str = str(vid).strip()
        if vid_str in seen_ids:
            continue
        seen_ids.add(vid_str)

        hromada = (
            item.get("hromada")
            or item.get("community")
            or item.get("otg")
            or item.get("district")
            or item.get("raion")
            or ""
        )
        katottg = str(item.get("katottg") or item.get("koatuu") or "").strip().upper()
        lat = item.get("lat") or item.get("latitude")
        lon = item.get("lon") or item.get("lng") or item.get("longitude")

        settlements.append(
            {
                "id": vid_str,
                "name": str(name).strip(),
                "hromada": str(hromada).strip(),
                "katottg": katottg,
                "norm_name": normalize_settlement_name(str(name)),
                "norm_hromada": normalize_hromada_name(str(hromada)),
                "lat": float(lat) if lat is not None else None,
                "lon": float(lon) if lon is not None else None,
            }
        )

    return settlements


def create_metric_buffer(lon: float, lat: float, radius_m: float = 600.0) -> Polygon:
    """Створює точний круглий буфер заданого радіусу в метрах (EPSG:4326)."""
    aeqd_proj = f"+proj=aeqd +lat_0={lat} +lon_0={lon} +datum=WGS84 +units=m +no_defs"
    to_metric = Transformer.from_crs("EPSG:4326", aeqd_proj, always_xy=True).transform
    to_wgs84 = Transformer.from_crs(aeqd_proj, "EPSG:4326", always_xy=True).transform
    metric_circle = Point(0.0, 0.0).buffer(radius_m, resolution=16)
    return transform(to_wgs84, metric_circle)


def fetch_overpass_data() -> dict[str, Any]:
    last_error: Exception | None = None
    for endpoint in OVERPASS_ENDPOINTS:
        try:
            print(f"Запит до Overpass API: {endpoint} ...")
            resp = requests.post(
                endpoint,
                data={"data": OVERPASS_QUERY},
                timeout=200,
                headers={"User-Agent": "ZhytomyrOutageMapBuilder/1.0"},
            )
            resp.raise_for_status()
            return resp.json()
        except Exception as exc:
            last_error = exc
            print(f"Помилка {endpoint}: {exc}", file=sys.stderr)
            time.sleep(2)
    raise RuntimeError(f"Не вдалося отримати дані з Overpass API: {last_error}")


def parse_overpass_features(osm_data: dict[str, Any]) -> list[dict[str, Any]]:
    elements = osm_data.get("elements", [])
    nodes: dict[int, tuple[float, float]] = {}
    ways: dict[int, list[int]] = {}

    for el in elements:
        el_type = el.get("type")
        if el_type == "node":
            nodes[el["id"]] = (el["lon"], el["lat"])
        elif el_type == "way":
            ways[el["id"]] = el.get("nodes", [])

    features: list[dict[str, Any]] = []

    for el in elements:
        tags = el.get("tags") or {}
        name = tags.get("name:uk") or tags.get("name")
        if not name:
            continue

        katottg = str(tags.get("katottg") or tags.get("ref:katottg") or "").strip().upper()
        hromada_hint = (
            tags.get("addr:subdistrict")
            or tags.get("is_in:municipality")
            or tags.get("addr:district")
            or ""
        )

        el_type = el.get("type")
        geom = None
        is_point = False

        if el_type == "relation":
            outer_lines = []
            for member in el.get("members", []):
                if member.get("type") == "way" and member.get("role", "outer") in ("outer", ""):
                    way_nodes = ways.get(member["ref"])
                    if way_nodes and len(way_nodes) >= 2:
                        coords = [nodes[nid] for nid in way_nodes if nid in nodes]
                        if len(coords) >= 2:
                            outer_lines.append(coords)
            if outer_lines:
                polys = list(polygonize(outer_lines))
                if polys:
                    geom = unary_union(polys)

        elif el_type == "way":
            way_nodes = el.get("nodes", [])
            coords = [nodes[nid] for nid in way_nodes if nid in nodes]
            if len(coords) >= 4 and coords[0] == coords[-1]:
                poly = Polygon(coords)
                if not poly.is_valid:
                    poly = poly.buffer(0)
                if not poly.is_empty:
                    geom = poly

        elif el_type == "node":
            lon, lat = el.get("lon"), el.get("lat")
            if lon is not None and lat is not None:
                geom = Point(lon, lat)
                is_point = True

        if geom is not None and not geom.is_empty:
            features.append(
                {
                    "name": name,
                    "norm_name": normalize_settlement_name(name),
                    "norm_hromada": normalize_hromada_name(hromada_hint),
                    "katottg": katottg,
                    "geom": geom,
                    "is_point": is_point,
                }
            )

    return features


def load_katottg_features(source: str) -> list[dict[str, Any]]:
    if source.startswith(("http://", "https://")):
        resp = requests.get(source, timeout=120)
        resp.raise_for_status()
        geojson = resp.json()
    else:
        with Path(source).open("r", encoding="utf-8") as f:
            geojson = json.load(f)

    features: list[dict[str, Any]] = []
    for feat in geojson.get("features", []):
        props = feat.get("properties") or {}
        geom_raw = feat.get("geometry")
        if not geom_raw:
            continue

        katottg = str(
            props.get("katottg") or props.get("KATOTTG") or props.get("code") or ""
        ).strip().upper()
        if katottg and not katottg.startswith("UA18"):
            continue

        name = (
            props.get("name:uk")
            or props.get("name")
            or props.get("NAME")
            or props.get("settlement")
            or ""
        )
        hromada = props.get("hromada") or props.get("HROMADA") or props.get("community") or ""
        if not name and not katottg:
            continue

        geom = shape(geom_raw)
        if geom.is_empty:
            continue

        features.append(
            {
                "name": str(name).strip(),
                "norm_name": normalize_settlement_name(str(name)),
                "norm_hromada": normalize_hromada_name(str(hromada)),
                "katottg": katottg,
                "geom": geom,
                "is_point": geom.geom_type == "Point",
            }
        )

    return features


def round_coords(coords: Any, precision: int = 5) -> Any:
    if isinstance(coords, (int, float)):
        return round(coords, precision)
    return [round_coords(c, precision) for c in coords]


def build_optimized_geojson(
    matched_items: list[tuple[dict[str, Any], Polygon | MultiPolygon]],
    output_path: Path,
    max_mb: float = 3.8,
) -> float:
    tolerances = [0.0004, 0.0007, 0.001, 0.0014]
    output_path.parent.mkdir(parents=True, exist_ok=True)

    for tol in tolerances:
        features = []
        for item, geom in matched_items:
            simplified = geom.simplify(tol, preserve_topology=True)
            if simplified.is_empty:
                simplified = geom
            if isinstance(simplified, GeometryCollection):
                polys = [g for g in simplified.geoms if g.geom_type in ("Polygon", "MultiPolygon")]
                if not polys:
                    continue
                simplified = unary_union(polys)

            geo_dict = mapping(simplified)
            geo_dict["coordinates"] = round_coords(geo_dict["coordinates"], 5)

            features.append(
                {
                    "type": "Feature",
                    "properties": {
                        "id": item["id"],
                        "name": item["name"],
                        "hromada": item["hromada"],
                    },
                    "geometry": geo_dict,
                }
            )

        fc = {"type": "FeatureCollection", "features": features}
        with output_path.open("w", encoding="utf-8") as f:
            json.dump(fc, f, ensure_ascii=False, separators=(",", ":"))

        size_mb = output_path.stat().st_size / (1024 * 1024)
        if size_mb <= max_mb or tol == tolerances[-1]:
            return size_mb

    return output_path.stat().st_size / (1024 * 1024)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Генерація zhytomyr_villages.geojson з data/addresses_directory"
    )
    parser.add_argument(
        "--directory",
        default="data/addresses_directory",
        help="Шлях до папки addresses_directory",
    )
    parser.add_argument(
        "--output",
        default="docs/data/zhytomyr_villages.geojson",
        help="Шлях до підсумкового GeoJSON файлу",
    )
    parser.add_argument(
        "--katottg-geojson",
        default=None,
        help="Опціонально: шлях або URL до локального/відкритого GeoJSON датасету КАТОТТГ",
    )
    parser.add_argument(
        "--buffer-radius",
        type=float,
        default=600.0,
        help="Радіус буфера в метрах для сіл, де знайдено лише точку (за замовчуванням 600 м)",
    )
    args = parser.parse_args()

    settlements = load_addresses_directory(Path(args.directory))
    print(f"Завантажено населених пунктів із довідника: {len(settlements)}")

    if args.katottg_geojson:
        geo_features = load_katottg_features(args.katottg_geojson)
    else:
        osm_raw = fetch_overpass_data()
        geo_features = parse_overpass_features(osm_raw)

    print(f"Отримано географічних об'єктів Житомирської області: {len(geo_features)}")

    # Індекси для швидкого та точного зіставлення
    by_katottg: dict[str, list[dict[str, Any]]] = defaultdict(list)
    by_name_hromada: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    by_name: dict[str, list[dict[str, Any]]] = defaultdict(list)

    for gf in geo_features:
        if gf["katottg"]:
            by_katottg[gf["katottg"]].append(gf)
        if gf["norm_name"] and gf["norm_hromada"]:
            by_name_hromada[(gf["norm_name"], gf["norm_hromada"])].append(gf)
        if gf["norm_name"]:
            by_name[gf["norm_name"]].append(gf)

    def pick_best(candidates: list[dict[str, Any]]) -> dict[str, Any] | None:
        if not candidates:
            return None
        # Пріоритет полігонам над точками
        polygons = [c for c in candidates if not c["is_point"]]
        return polygons[0] if polygons else candidates[0]

    matched_items: list[tuple[dict[str, Any], Polygon | MultiPolygon]] = []
    unmatched: list[dict[str, Any]] = []
    polygon_count = 0
    buffer_count = 0

    for s in settlements:
        candidate = None
        if s["katottg"] and s["katottg"] in by_katottg:
            candidate = pick_best(by_katottg[s["katottg"]])
        if candidate is None and s["norm_hromada"]:
            candidate = pick_best(by_name_hromada.get((s["norm_name"], s["norm_hromada"]), []))
        if candidate is None:
            name_cands = by_name.get(s["norm_name"], [])
            if len(name_cands) == 1:
                candidate = name_cands[0]
            elif len(name_cands) > 1:
                candidate = pick_best(name_cands)

        if candidate is not None:
            geom = candidate["geom"]
            if candidate["is_point"] or geom.geom_type == "Point":
                pt = geom if geom.geom_type == "Point" else geom.centroid
                geom = create_metric_buffer(pt.x, pt.y, args.buffer_radius)
                buffer_count += 1
            else:
                polygon_count += 1
            matched_items.append((s, geom))
        elif s["lat"] is not None and s["lon"] is not None:
            geom = create_metric_buffer(s["lon"], s["lat"], args.buffer_radius)
            buffer_count += 1
            matched_items.append((s, geom))
        else:
            unmatched.append(s)

    output_path = Path(args.output)
    size_mb = build_optimized_geojson(matched_items, output_path)

    print("\n" + "=" * 54)
    print("ЗВІТ ПРО ГЕНЕРАЦІЮ GEOJSON (ЖИТОМИРСЬКА ОБЛАСТЬ)")
    print("=" * 54)
    print(f"Усього в довіднику:          {len(settlements)}")
    print(f"Зіставлено полігонами:       {polygon_count}")
    print(f"Згенеровано буфером (600 м): {buffer_count}")
    print(f"Не знайдено:                 {len(unmatched)}")
    print(f"Файл результату:             {output_path} ({size_mb:.2f} МБ)")

    if unmatched:
        print("\nПриклади не знайдених населених пунктів (перші 20):")
        for u in unmatched[:20]:
            print(f"  - {u['name']} ({u['hromada'] or 'громада не вказана'}) [id={u['id']}]")

        report_path = Path("scripts/unmatched_report.json")
        with report_path.open("w", encoding="utf-8") as f:
            json.dump(
                [{"id": u["id"], "name": u["name"], "hromada": u["hromada"]} for u in unmatched],
                f,
                ensure_ascii=False,
                indent=2,
            )
        print(f"Повний список не знайдених збережено у: {report_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
