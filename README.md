# Мапа відключень електроенергії — Житомирська область
# Zhytomyr Oblast Power Outage Map

> **English Overview** · [Українська документація](#основні-можливості)

An interactive, minimalist **Progressive Web App (PWA)** visualizing real-time power outages across **2,047 settlements** and **19 districts (РЕМ)** in **Zhytomyr Oblast, Ukraine**, designed for zero-cost static hosting on **GitHub Pages** with automated data updates via the **GitHub REST API**.

- **Isolated Dark Map**: Custom dark obsidian theme (`#06080e`) rendered with **MapLibre GL JS**, featuring an outer oblast boundary glow, exact village-aligned district borders, and zoom-dependent labels.
- **Continuous Color Formula**: Smooth mathematical HSL gradient (`0%` lit = bright gold → `100%` outage/emergency = dark obsidian), supporting fractional percentages (e.g., `32.5%`, `63.1%`).
- **Situation Analytics**: Full-screen overview showing oblast-wide outage percentage, street/settlement counts, a sorted problemness ranking of all 19 districts (click to fly to district), and a searchable settlements tab.
- **Serverless Data Sync**: External cron jobs push a lightweight JSON (`docs/data/outages.json`) via the GitHub Contents API — no database or backend required on the frontend.
- **Offline-Ready PWA**: Caches GeoJSON layers and assets locally while fetching `outages.json` with a **Network-First** strategy.

> **Disclaimer**: This is an **unofficial**, independent informational project not affiliated with JSC "Zhytomyroblenergo" or any government authority. All displayed metrics are aggregated from publicly available open sources and reflect residential outage estimates only (no critical infrastructure, substations, power lines, or technical failure details are shown). Settlement polygons are approximate Voronoi visualizations, not official cadastral borders. Data is provided **"as is"** without any warranty of accuracy, completeness, or timeliness.
>
> **License & Attribution**: Source code is licensed under the [MIT License](./LICENSE). Boundary and settlement geodata are derived from [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors ([ODbL](https://opendatacommons.org/licenses/odbl/)) and [Wikidata](https://www.wikidata.org/) (`CC0 1.0`), rendered with [MapLibre GL JS](https://maplibre.org/) (`BSD-3-Clause`).

---

Інтерактивна мінімалістична мапа знеструмлень населених пунктів Житомирської області у форматі **PWA** (працює як мобільний та десктопний застосунок), адаптована для безкоштовного хостингу на **GitHub Pages** з оновленням даних через **GitHub REST API**.

> **Важливо (Відмова від відповідальності / Disclaimer)**
> - Це **неофіційний** інформаційний проєкт, який не має стосунку до АТ «Житомиробленерго» чи державних органів.
> - Відображаються виключно узагальнені дані про орієнтовні відключення по населених пунктах із **відкритих публічних джерел** — без жодної інформації про підстанції, ЛЕП, об'єкти критичної інфраструктури чи технічні причини.
> - Дані надаються **«як є» (as is)**: можливі затримки оновлення, неточності у відсотках або умовних межах полігонів. Автор не несе відповідальності за будь-які рішення, прийняті на основі цієї карти.

---

## Основні можливості

- **Ізольована Житомирська область**: темна нічна тема (`#06080e`) без сторонніх карт і сусідніх областей, підсвічений золотий контур області та межі 19 районів (РЕМ).
- **2 047 населених пунктів**: безперервна сітка полігонів, що не перекриваються (включно з населеними пунктами зі спільними координатами), підписи районів на загальному плані та динамічні підписи сіл при наближенні (`zoom >= 10.6`, без приховування колізій при `zoom >= 12.0`).
- **Математична формула кольору** (`computeOutageColor(pct)`): плавний безперервний градієнт для будь-якого відсотка від `0%` до `100%` (включно з дробовими значеннями на кшталт `32.5%` чи `63.1%`):
  - `0%` — яскравий золотий (світло є);
  - `1%–79%` — поступове згасання через бурштиновий і темно-бордовий;
  - `80%–100%` — темний фіолетово-чорний (аварія / без світла).
- **Панель «Ситуація»**:
  - кнопка у верхньому лівому куті показує поточний `% без світла` по області;
  - загальний прогрес-бар (золотим підсвічується частка **зі світлом**, темним — **без світла**);
  - вкладка **«Світло за районами (РЕМ)»**: рейтинг проблемності 19 РЕМів із переходом до обраного району при кліку;
  - вкладка **«Населені пункти»**: список пунктів із відключеннями, відсортований за проблемністю (`100% без світла` зверху), із фільтром пошуку всередині списку та перельотом на мапі при кліку.
- **PWA (Progressive Web App)**: встановлення на головний екран Android, iOS або ПК, офлайн-кеш геоданих і стратегія **Network-First** для `outages.json`.

---

## Структура проєкту

```text
├── docs/                                 # Готовий статичний сайт для GitHub Pages
│   ├── index.html                        # Головна сторінка + PWA мета-теги
│   ├── style.css                         # Стилі інтерфейсу та модального вікна «Ситуація»
│   ├── app.js                            # Логіка MapLibre GL JS, формула кольорів, реєстрація SW
│   ├── manifest.webmanifest              # PWA-маніфест (відносні шляхи для GitHub Pages)
│   ├── sw.js                             # Service Worker (кеш GeoJSON + Network-First для даних)
│   ├── icons/                            # PWA-іконки (192x192, 512x512, maskable, apple-touch-icon)
│   └── data/
│       ├── outages.json                  # Актуальні дані відключень (оновлюється ботом/кроном)
│       ├── outages.template.json         # Шаблон формату JSON-даних
│       ├── zhytomyr_oblast.geojson       # Зовнішня межа області
│       ├── zhytomyr_mask.geojson         # Інвертована маска за межами області
│       ├── zhytomyr_raions.geojson       # Межі 19 районів по контурах сіл
│       ├── zhytomyr_raion_labels.geojson # Центроїди підписів районів
│       └── zhytomyr_villages.geojson     # 2 047 полігонів населених пунктів
├── src/                                  # React + Vite версія (для локального прев'ю)
├── public/                               # Копія статичних даних та іконок для Vite
└── scripts/
    └── build_geojson.py                  # Генерація полігонів із data/addresses_directory
```

---

## 1. Публікація на GitHub Pages (безкоштовно)

1. Відкрийте репозиторій на GitHub → **Settings** → **Pages**.
2. У блоці **Build and deployment** → **Source** виберіть **Deploy from a branch**.
3. Виберіть гілку **`main`** та папку **`/docs`**, натисніть **Save**.
4. Через 1–2 хвилини мапа та PWA будуть доступні за адресою:
   `https://<ваш-логін>.github.io/<назва-репозиторію>/`

---

## 2. Налаштування оновлення даних через GitHub API

Мапа не потребує бази даних чи власного бекенду — ваш сторонній крон/скрипт періодично (оптимально раз на 10–15 хвилин) оновлює файл `docs/data/outages.json` через **GitHub REST API** (безкоштовно, ліміт 5 000 запитів/год).

### Крок 1. Створення токена (PAT)
1. Перейдіть на GitHub у **Settings** (профіль) → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.
2. У **Repository access** виберіть **Only select repositories** → вкажіть репозиторій з мапою.
3. У **Permissions** → **Repository permissions** → **Contents** виберіть **Read and write**.
4. Скопіюйте токен.

### Крок 2. Змінні середовища у вашому кроні
Додайте у `.env` або змінні середовища сервера/бота:
- `MAP_GITHUB_REPO` — `ваш-логін/назва-репозиторію`
- `MAP_GITHUB_TOKEN` — створений Personal Access Token
- `MAP_GITHUB_PATH` — `docs/data/outages.json` *(за замовчуванням)*

### Крок 3. Готовий код для відправлення з Python (`httpx`)
```python
import base64
import json
import os
from datetime import datetime, timezone
import httpx

def push_outages_to_github(payload: dict) -> None:
    repo = os.getenv("MAP_GITHUB_REPO", "").strip()
    token = os.getenv("MAP_GITHUB_TOKEN", "").strip()
    path = os.getenv("MAP_GITHUB_PATH", "docs/data/outages.json").strip()
    if not repo or not token:
        return

    url = f"https://api.github.com/repos/{repo}/contents/{path}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }

    with httpx.Client(timeout=20.0) as client:
        r = client.get(url, headers=headers)
        sha = r.json().get("sha") if r.status_code == 200 else None

        body = {
            "message": f"chore(data): оновлення карти ({datetime.now(timezone.utc).strftime('%H:%M %d.%m')})",
            "content": base64.b64encode(
                json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            ).decode("ascii"),
        }
        if sha:
            body["sha"] = sha

        res = client.put(url, headers=headers, json=body)
        res.raise_for_status()
```

---

## 3. Формат JSON (`docs/data/outages.json`)

Шаблон доступний у `docs/data/outages.template.json`:

```json
{
  "updated_at": "2026-01-01T12:00:00Z",
  "summary": {
    "off_percent": 12.5,
    "off_streets": 150,
    "total_streets": 18000,
    "off_settlements": 42
  },
  "raions": [
    {
      "name": "Житомирський",
      "off_percent": 18.4,
      "off_streets": 65,
      "off_settlements": 14,
      "off_settlements_percent": 14.0
    }
  ],
  "data": {
    "коростишів": 32.5,
    "бердичів": 63.1,
    "житомир": 10.0
  }
}
```

### Пояснення полів
- **`updated_at`** *(рядок ISO-8601)* — час останнього оновлення (відображається внизу в легенді).
- **`summary`** *(необов'язково)* — зведені показники по області для шапки панелі **«Ситуація»**. Якщо блок відсутній, мапа рахує середнє автоматично з `data`.
- **`raions`** *(необов'язково)* — масив РЕМів для вкладки **«Світло за районами (РЕМ)»**. Якщо блок відсутній, усі 19 районів рахуються автоматично з `data`.
- **`data`** — словник `ключ: відсоток_без_світла` (`0`..`100`):
  - Ключ — назва населеного пункту в нижньому регістрі **без префікса** `с.`, `смт.`, `м.` (наприклад, `"житомир"`, `"сингаї"`).
  - Усі населені пункти, яких **немає** в `data`, автоматично вважаються з **`0%`** (світло є) і світяться золотим.

### Підтримувані 19 районів (РЕМ)
`Житомирський`, `Звягельський`, `Овруцький`, `Попільнянський`, `Коростенський`, `Малинський`, `Олевський`, `Баранівський`, `Хорошівський`, `Радомишльський`, `Бердичівський`, `Черняхівський`, `Чуднівський`, `Любарський`, `Пулинський`, `Романівський`, `Андрушівський`, `Коростишівський`, `Брусилівський`.

---

## 4. Як працює PWA та кешування

- **Встановлення**:
  - **Android (Chrome)**: меню браузера → *«Встановити застосунок»* / *«Додати на головний екран»*.
  - **iOS (Safari)**: кнопка *«Поділитися»* → *«На екран «Домів»»*.
  - **ПК (Chrome / Edge)**: іконка встановлення праворуч в адресному рядку.
- **Кешування (`docs/sw.js`)**:
  - Усі статичні ресурси (`index.html`, `style.css`, `app.js`, іконки, усі `.geojson`) кешуються локально.
  - `outages.json` завантажується за стратегією **Network-First** (з параметром `?t=...` проти кешування браузером) — за наявності інтернету завжди підтягуються найсвіжіші дані, а офлайн показується останній збережений стан.
  - Якщо ви зміните `docs/app.js` або `docs/style.css` і хочете примусово оновити кеш у користувачів, збільште версію `STATIC_CACHE` (наприклад, `zhytomyr-map-static-v2`) у `docs/sw.js`.

---

## 5. Часті питання (FAQ)

- **Як швидко оновлюється сайт після пушу `outages.json`?**
  GitHub Pages перезбирає й роздає оновлений файл за 30–60 секунд після запиту через GitHub API.
- **Чому не варто пушити частіше ніж раз на 10 хвилин?**
  GitHub Pages має м'який ліміт ~10 деплоїв на годину. Інтервал **10–15 хвилин** працює стабільно без затримок.
- **Чи бачить хтось у браузері токен або джерело даних?**
  Ні. Токен і логіка формування JSON працюють лише на вашому зовнішньому сервері/кроні, а браузер читає виключно локальний статичний `./data/outages.json`.

---

## 6. Локальна розробка та перегенерація геоданих

### Локальний запуск Vite-версії
```bash
npm install
npm run dev
```

### Перегенерація GeoJSON-полігонів (за потреби)
```bash
pip install -r requirements.txt
python scripts/build_geojson.py
```

---

## 7. Ліцензія та джерела даних (License & Attribution)

- **Програмний код проєкту** розповсюджується на умовах ліцензії **[MIT](./LICENSE)** — код надається «як є» (`AS IS`), без жодних гарантій та відповідальності автора за наслідки використання.
- **Географічні дані та межі**:
  - **© [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors** (ліцензія **[ODbL 1.0](https://opendatacommons.org/licenses/odbl/)**) — зовнішня адміністративна межа Житомирської області (`Nominatim`) та довідкові координати населених пунктів.
  - **[Wikidata](https://www.wikidata.org/)** (ліцензія **CC0 1.0**) — координати населених пунктів Житомирської області (`UA-18`).
  - Полігони населених пунктів та меж районів побудовані алгоритмічно (діаграма Вороного) для зручної візуалізації і **не є офіційними кадастровими чи адміністративними межами**.
- **Рендеринг мапи**: **[MapLibre GL JS](https://maplibre.org/)** (ліцензія `BSD-3-Clause`).
- **Дані про відключення**: узагальнена інформація виключно з відкритих публічних джерел; проєкт не відображає об'єкти критичної інфраструктури, підстанції чи лінії електропередач.

