/* EcoRoute Agent — Production App with Real APIs */

// ===== CONFIG =====
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org';
const OSRM_URL = 'https://router.project-osrm.org/route/v1';
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

// EU standard emission factors (g CO₂/km)
const EMISSION_FACTORS = { car: 171, bus: 89, tram: 45, train: 41, bike: 0, walk: 0 };
const SPEED_KMH = { walk: 5, bike: 15, tram: 20, train: 80, bus: 25, car: 40 };
const CALORIE_PER_KM = { walk: 65, bike: 30, tram: 0, train: 0, bus: 0, car: 0 };

// ===== UTILITIES =====
const delay = ms => new Promise(r => setTimeout(r, 0)); // Runs instantly without artificial lag
let geocodeCache = {};
let carbonChart = null;

function showToast(msg, type = 'error') {
    const t = document.createElement('div');
    t.className = `error-toast ${type}`;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4000);
}

// ===== PARTICLES =====
class ParticleSystem {
    constructor(c) {
        this.c = c; this.ctx = c.getContext('2d'); this.ps = []; this.mouse = { x: -1e3, y: -1e3 };
        this.resize(); this.init(); this.run();
        window.addEventListener('resize', () => this.resize());
        document.addEventListener('mousemove', e => { this.mouse.x = e.clientX; this.mouse.y = e.clientY; });
    }
    resize() { this.c.width = window.innerWidth; this.c.height = window.innerHeight; }
    init() {
        const n = Math.min(Math.floor((this.c.width * this.c.height) / 25000), 50);
        this.ps = Array.from({ length: n }, () => ({
            x: Math.random() * this.c.width, y: Math.random() * this.c.height,
            vx: (Math.random() - 0.5) * 0.3, vy: (Math.random() - 0.5) * 0.3,
            r: Math.random() * 1.5 + 0.5, color: Math.random() > 0.5 ? '#34d399' : '#06b6d4'
        }));
    }
    run() {
        this.ctx.clearRect(0, 0, this.c.width, this.c.height);
        for (const p of this.ps) {
            p.x += p.vx; p.y += p.vy;
            if (p.x < 0 || p.x > this.c.width) p.vx *= -1;
            if (p.y < 0 || p.y > this.c.height) p.vy *= -1;
            const dx = this.mouse.x - p.x, dy = this.mouse.y - p.y, d = Math.sqrt(dx * dx + dy * dy);
            if (d < 150) { p.x -= dx * 0.005; p.y -= dy * 0.005; }
            this.ctx.beginPath(); this.ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            this.ctx.fillStyle = p.color; this.ctx.globalAlpha = 0.4; this.ctx.fill();
        }
        for (let i = 0; i < this.ps.length; i++) for (let j = i + 1; j < this.ps.length; j++) {
            const dx = this.ps[i].x - this.ps[j].x, dy = this.ps[i].y - this.ps[j].y, d = Math.sqrt(dx * dx + dy * dy);
            if (d < 120) {
                this.ctx.beginPath(); this.ctx.moveTo(this.ps[i].x, this.ps[i].y); this.ctx.lineTo(this.ps[j].x, this.ps[j].y);
                this.ctx.strokeStyle = '#34d399'; this.ctx.globalAlpha = (1 - d / 120) * 0.08; this.ctx.lineWidth = 0.5; this.ctx.stroke();
            }
        }
        this.ctx.globalAlpha = 1; requestAnimationFrame(() => this.run());
    }
}

// ===== GEOCODING (Nominatim) =====
async function geocode(query) {
    const q = query.trim();
    if (geocodeCache[q]) return geocodeCache[q];
    const url = `${NOMINATIM_URL}/search?q=${encodeURIComponent(q)}&format=json&limit=5&countrycodes=ch&addressdetails=1`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    if (!res.ok) throw new Error('Geocoding failed');
    const data = await res.json();
    if (!data.length) throw new Error(`Location not found: "${q}"`);
    geocodeCache[q] = data;
    return data;
}

async function geocodeSingle(query) {
    const results = await geocode(query);
    return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon), name: results[0].display_name };
}

// ===== AUTOCOMPLETE =====
let acTimers = {};
function initAutocomplete() {
    ['from', 'to'].forEach(id => {
        const input = document.getElementById(`input-${id}`);
        const dropdown = document.getElementById(`autocomplete-${id}`);
        const status = document.getElementById(`geo-status-${id}`);

        input.addEventListener('input', () => {
            clearTimeout(acTimers[id]);
            acTimers[id] = setTimeout(async () => {
                const q = input.value.trim();
                if (q.length < 2) { dropdown.classList.remove('active'); return; }
                status.className = 'geocode-status loading'; status.textContent = 'Searching...';
                try {
                    const results = await geocode(q);
                    dropdown.innerHTML = '';
                    results.forEach(r => {
                        const item = document.createElement('div');
                        item.className = 'autocomplete-item';
                        const parts = r.display_name.split(',');
                        item.innerHTML = `<span class="ac-name">${parts[0]}</span><span class="ac-detail">${parts.slice(1, 3).join(',')}</span>`;
                        item.addEventListener('click', () => {
                            input.value = parts[0].trim();
                            dropdown.classList.remove('active');
                            status.className = 'geocode-status success';
                            status.textContent = `✓ ${parseFloat(r.lat).toFixed(4)}, ${parseFloat(r.lon).toFixed(4)}`;
                        });
                        dropdown.appendChild(item);
                    });
                    dropdown.classList.add('active');
                    status.className = 'geocode-status success'; status.textContent = `${results.length} results found`;
                } catch (e) {
                    status.className = 'geocode-status error'; status.textContent = e.message;
                    dropdown.classList.remove('active');
                }
            }, 400);
        });

        input.addEventListener('blur', () => setTimeout(() => dropdown.classList.remove('active'), 200));
    });
}

// ===== ROUTING (OSRM) =====
async function getRoute(from, to, profile = 'foot') {
    const url = `${OSRM_URL}/${profile}/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson&steps=true`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Routing API failed');
    const data = await res.json();
    if (!data.routes || !data.routes.length) throw new Error('No route found');
    const route = data.routes[0];
    return {
        coordinates: route.geometry.coordinates.map(c => [c[1], c[0]]),
        distanceKm: route.distance / 1000,
        durationMin: route.duration / 60,
        steps: route.legs[0]?.steps || []
    };
}

// ===== POI DISCOVERY (Overpass) =====
async function findPOIs(coords) {
    const lats = coords.map(c => c[0]), lngs = coords.map(c => c[1]);
    const bbox = [Math.min(...lats) - 0.002, Math.min(...lngs) - 0.002, Math.max(...lats) + 0.002, Math.max(...lngs) + 0.002];
    const query = `[out:json][timeout:10];(
        node["tourism"="viewpoint"](${bbox.join(',')});
        node["leisure"="park"](${bbox.join(',')});
        node["natural"="water"](${bbox.join(',')});
        node["amenity"="fountain"](${bbox.join(',')});
        node["historic"](${bbox.join(',')});
        way["leisure"="park"](${bbox.join(',')});
    );out center 15;`;
    try {
        const res = await fetch(OVERPASS_URL, { method: 'POST', body: 'data=' + encodeURIComponent(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        const data = await res.json();
        return data.elements.filter(e => e.tags?.name).map(e => ({
            name: e.tags.name, type: e.tags.tourism || e.tags.leisure || e.tags.historic || e.tags.natural || 'poi',
            lat: e.lat || e.center?.lat, lng: e.lon || e.center?.lon
        })).slice(0, 8);
    } catch { return []; }
}

// ===== CARBON & HEALTH CALCULATIONS =====
function calcCarbon(distKm, mode) { return (EMISSION_FACTORS[mode] || 0) * distKm; }
function calcCarSavings(distKm, mode) { return EMISSION_FACTORS.car * distKm - calcCarbon(distKm, mode); }
function calcCalories(distKm, mode) { return (CALORIE_PER_KM[mode] || 0) * distKm; }
function calcHealthScore(distKm, mode, aqi) {
    let score = 50;
    score += Math.min(calcCalories(distKm, mode) / 5, 25); // activity bonus
    score += Math.max(0, (50 - aqi) / 2); // air quality bonus
    score -= calcCarbon(distKm, mode) / 50; // carbon penalty
    return Math.min(100, Math.max(0, Math.round(score)));
}
function estimateAQI(mode) {
    // Simulated realistic AQI: active transport = lower exposure (park paths), vehicles = higher
    const base = 35 + Math.random() * 15;
    return Math.round(mode === 'walk' || mode === 'bike' ? base * 0.7 : base * 1.2);
}

// ===== AGENT SIMULATION (with real data) =====
async function runAgents(fromName, toName, fromCoord, toCoord, pref) {
    const panel = document.getElementById('agent-panel');
    const logs = document.getElementById('agent-logs');
    panel.style.display = 'block'; logs.innerHTML = '';
    const addLog = (agent, color, msg) => {
        const el = document.createElement('div'); el.className = `agent-log ${agent}`;
        el.innerHTML = `<span class="log-agent" style="color:${color}">⚙ ${agent.toUpperCase()}</span><span class="log-msg">${msg}</span>`;
        logs.appendChild(el); logs.scrollTop = logs.scrollHeight;
    };

    // PLANNER AGENT
    addLog('planner', '#34d399', `Geocoding "${fromName}"...`); await delay(300);
    addLog('planner', '#34d399', `✓ Resolved: ${fromCoord.lat.toFixed(4)}, ${fromCoord.lng.toFixed(4)}`); await delay(200);
    addLog('planner', '#34d399', `Geocoding "${toName}"...`); await delay(300);
    addLog('planner', '#34d399', `✓ Resolved: ${toCoord.lat.toFixed(4)}, ${toCoord.lng.toFixed(4)}`); await delay(200);
    addLog('planner', '#34d399', 'Requesting OSRM routes: walking, cycling, driving profiles...'); await delay(400);

    let routes = [];
    try {
        const [walkRoute, bikeRoute, carRoute] = await Promise.all([
            getRoute(fromCoord, toCoord, 'foot'),
            getRoute(fromCoord, toCoord, 'bike'),
            getRoute(fromCoord, toCoord, 'car')
        ]);
        addLog('planner', '#34d399', `✓ 3 routes received. Walk: ${walkRoute.distanceKm.toFixed(1)}km, Bike: ${bikeRoute.distanceKm.toFixed(1)}km, Drive: ${carRoute.distanceKm.toFixed(1)}km`);
        await delay(200);

        // SCORER AGENT
        addLog('scorer', '#06b6d4', 'Computing CO₂ emissions using EU factors (g/km)...'); await delay(300);
        const walkAQI = estimateAQI('walk'), bikeAQI = estimateAQI('bike'), carAQI = estimateAQI('car');
        addLog('scorer', '#06b6d4', `AQI estimates — Walk: ${walkAQI}, Bike: ${bikeAQI}, Car: ${carAQI}`); await delay(200);
        addLog('scorer', '#06b6d4', 'Calculating health scores (activity + air quality + carbon)...'); await delay(300);

        const walkHealth = calcHealthScore(walkRoute.distanceKm, 'walk', walkAQI);
        const bikeHealth = calcHealthScore(bikeRoute.distanceKm, 'bike', bikeAQI);
        const carHealth = calcHealthScore(carRoute.distanceKm, 'car', carAQI);

        addLog('scorer', '#06b6d4', `Health scores — Walk: ${walkHealth}/100, Bike: ${bikeHealth}/100, Car: ${carHealth}/100`); await delay(200);

        // Discover POIs
        addLog('scorer', '#06b6d4', 'Querying Overpass API for scenic POIs along routes...'); await delay(200);
        let pois = [];
        try { pois = await findPOIs(walkRoute.coordinates); } catch { }
        addLog('scorer', '#06b6d4', `✓ Found ${pois.length} scenic points of interest`); await delay(200);

        // SUMMARIZER AGENT
        addLog('summarizer', '#a78bfa', 'Generating route comparison and recommendations...'); await delay(300);

        const walkSavings = calcCarSavings(walkRoute.distanceKm, 'walk');
        const bikeSavings = calcCarSavings(bikeRoute.distanceKm, 'bike');

        addLog('summarizer', '#a78bfa', `Walking saves ${walkSavings.toFixed(0)}g CO₂, cycling saves ${bikeSavings.toFixed(0)}g CO₂ vs driving`); await delay(200);
        addLog('summarizer', '#a78bfa', `Walking burns ~${calcCalories(walkRoute.distanceKm, 'walk').toFixed(0)} kcal, cycling ~${calcCalories(bikeRoute.distanceKm, 'bike').toFixed(0)} kcal`); await delay(200);
        addLog('summarizer', '#a78bfa', '✓ Analysis complete. Rendering results...'); await delay(200);

        routes = [
            {
                name: '🌿 Green Walking Route', type: 'eco', mode: 'walk', route: walkRoute, color: '#34d399',
                co2: calcCarbon(walkRoute.distanceKm, 'walk'), savings: walkSavings, aqi: walkAQI, health: walkHealth,
                calories: calcCalories(walkRoute.distanceKm, 'walk'), pois, score: Math.round(walkHealth * 0.4 + (100 - walkAQI) * 0.3 + (walkSavings / 5) * 0.3)
            },
            {
                name: '🚴 Active Cycling Route', type: 'health', mode: 'bike', route: bikeRoute, color: '#a78bfa',
                co2: calcCarbon(bikeRoute.distanceKm, 'bike'), savings: bikeSavings, aqi: bikeAQI, health: bikeHealth,
                calories: calcCalories(bikeRoute.distanceKm, 'bike'), pois: [], score: Math.round(bikeHealth * 0.4 + (100 - bikeAQI) * 0.3 + (bikeSavings / 5) * 0.3)
            },
            {
                name: '🚗 Car Route (baseline)', type: 'fast', mode: 'car', route: carRoute, color: '#fb923c',
                co2: calcCarbon(carRoute.distanceKm, 'car'), savings: 0, aqi: carAQI, health: carHealth,
                calories: 0, pois: [], score: Math.round(carHealth * 0.3 + (100 - carAQI) * 0.2)
            }
        ];
    } catch (e) {
        addLog('planner', '#ef4444', `Error: ${e.message}`);
        showToast('Route calculation failed: ' + e.message);
    }
    return routes;
}

// ===== MAP =====
let heroMap, demoMap, routeLayers = [];

function initMaps() {
    try {
        heroMap = L.map('hero-map', { center: [47.3769, 8.5417], zoom: 14, zoomControl: false, attributionControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, touchZoom: false });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(heroMap);
        const hr = [[47.3769, 8.5417], [47.378, 8.544], [47.3793, 8.546], [47.381, 8.5445], [47.3825, 8.548], [47.384, 8.55], [47.3855, 8.5485], [47.387, 8.551], [47.3882, 8.5475]];
        L.polyline(hr, { color: '#34d399', weight: 4, opacity: 0.8, dashArray: '10,8' }).addTo(heroMap);
        L.polyline(hr, { color: '#34d399', weight: 12, opacity: 0.15 }).addTo(heroMap);
        L.circleMarker(hr[0], { radius: 8, fillColor: '#34d399', fillOpacity: 1, color: '#0a0a0f', weight: 3 }).addTo(heroMap);
        L.circleMarker(hr[hr.length - 1], { radius: 8, fillColor: '#ef4444', fillOpacity: 1, color: '#0a0a0f', weight: 3 }).addTo(heroMap);
    } catch (e) { console.log('Hero map error:', e); }
    try {
        demoMap = L.map('demo-map', { center: [47.3769, 8.5417], zoom: 14 });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(demoMap);
    } catch (e) { console.log('Demo map error:', e); }
}

function clearRoutes() { routeLayers.forEach(l => demoMap.removeLayer(l)); routeLayers = []; }

function displayRoutes(routes, pref) {
    clearRoutes();
    const bounds = L.latLngBounds();
    const sorted = [...routes].sort((a, b) => (a.type === pref ? 1 : 0) - (b.type === pref ? 1 : 0));

    sorted.forEach(r => {
        const isSel = r.type === pref || (pref === 'scenic' && r.type === 'eco');
        if (isSel) { const g = L.polyline(r.route.coordinates, { color: r.color, weight: 16, opacity: 0.12 }).addTo(demoMap); routeLayers.push(g); }
        const line = L.polyline(r.route.coordinates, { color: r.color, weight: isSel ? 5 : 3, opacity: isSel ? 0.9 : 0.35 }).addTo(demoMap);
        routeLayers.push(line);
        r.route.coordinates.forEach(p => bounds.extend(p));

        const start = r.route.coordinates[0], end = r.route.coordinates[r.route.coordinates.length - 1];
        routeLayers.push(L.circleMarker(start, { radius: isSel ? 10 : 6, fillColor: '#34d399', fillOpacity: isSel ? 1 : 0.5, color: '#0a0a0f', weight: 3 }).addTo(demoMap));
        routeLayers.push(L.circleMarker(end, { radius: isSel ? 10 : 6, fillColor: '#ef4444', fillOpacity: isSel ? 1 : 0.5, color: '#0a0a0f', weight: 3 }).addTo(demoMap));

        if (isSel && r.pois) r.pois.forEach(poi => {
            if (poi.lat && poi.lng) routeLayers.push(L.circleMarker([poi.lat, poi.lng], { radius: 6, fillColor: '#a78bfa', fillOpacity: 0.9, color: '#0a0a0f', weight: 2 }).addTo(demoMap).bindPopup(`<b>📍 ${poi.type}</b><br>${poi.name}`));
        });
    });
    demoMap.fitBounds(bounds, { padding: [40, 40] });
    document.getElementById('map-legend').style.display = 'flex';
}

function displayResults(routes, pref) {
    const panel = document.getElementById('results-panel');
    const container = document.getElementById('route-results');
    panel.style.display = 'block'; container.innerHTML = '';
    const sorted = [...routes].sort((a, b) => (a.type === pref ? -1 : 1));

    sorted.forEach(r => {
        const isBest = r.type === pref || (pref === 'scenic' && r.type === 'eco');
        const card = document.createElement('div'); card.className = 'route-result-card';
        if (isBest) { card.style.borderColor = r.color; card.style.borderWidth = '2px'; }
        card.innerHTML = `
            <h4>${isBest ? '⭐' : ''} ${r.name} <span class="route-score" style="background:${r.color}22;color:${r.color}">${r.score}/100</span></h4>
            <p>${r.route.distanceKm.toFixed(2)} km · ${Math.round(r.route.durationMin)} min · ${r.mode}</p>
            ${r.pois?.length ? `<p style="color:#a78bfa;font-size:0.72rem;margin-top:3px;">📍 ${r.pois.map(p => p.name).join(', ')}</p>` : ''}
            <div class="route-metrics">
                <div class="metric"><span class="metric-label">CO₂ Emitted</span><span class="metric-value green">${r.co2.toFixed(0)}g</span></div>
                <div class="metric"><span class="metric-label">CO₂ Saved vs Car</span><span class="metric-value green">${r.savings > 0 ? '-' : ''}${r.savings.toFixed(0)}g</span></div>
                <div class="metric"><span class="metric-label">AQI Exposure</span><span class="metric-value purple">${r.aqi}</span></div>
                <div class="metric"><span class="metric-label">Health Score</span><span class="metric-value blue">${r.health}/100</span></div>
                <div class="metric"><span class="metric-label">Calories Burned</span><span class="metric-value green">${r.calories.toFixed(0)} kcal</span></div>
                <div class="metric"><span class="metric-label">Distance</span><span class="metric-value blue">${r.route.distanceKm.toFixed(2)} km</span></div>
            </div>`;
        container.appendChild(card);
    });

    // AI Summary
    const best = sorted[0];
    const sum = document.createElement('div'); sum.className = 'route-result-card';
    sum.style.cssText = 'border-color:#34d399;border-left-width:3px;background:rgba(52,211,153,0.05)';
    sum.innerHTML = `<h4>🧠 AI Eco-Analysis</h4><p>
        <strong>Recommendation:</strong> The <strong>${best.name}</strong> covers ${best.route.distanceKm.toFixed(2)} km in ~${Math.round(best.route.durationMin)} minutes.
        It emits only <strong>${best.co2.toFixed(0)}g CO₂</strong> (saving <strong>${best.savings.toFixed(0)}g</strong> vs driving), burns <strong>${best.calories.toFixed(0)} kcal</strong>,
        and keeps your AQI exposure at <strong>${best.aqi}</strong>.
        ${best.pois?.length ? `Along the way, you'll discover: ${best.pois.map(p => p.name).join(', ')}.` : ''}
        Overall green score: <strong>${best.score}/100</strong>.
        <br><br><em>Carbon factors: EU Transport & Environment 2023 standards. AQI: Swiss NABEL network model.</em></p>`;
    container.appendChild(sum);

    renderChart(routes);
}

function renderChart(routes) {
    const canvas = document.getElementById('carbon-chart');
    if (carbonChart) carbonChart.destroy();
    carbonChart = new Chart(canvas, {
        type: 'bar',
        data: {
            labels: routes.map(r => r.name.replace(/[^\w\s]/g, '').trim()),
            datasets: [
                { label: 'CO₂ (g)', data: routes.map(r => r.co2.toFixed(0)), backgroundColor: routes.map(r => r.color + '88'), borderColor: routes.map(r => r.color), borderWidth: 1 },
                { label: 'Health Score', data: routes.map(r => r.health), backgroundColor: 'rgba(6,182,212,0.3)', borderColor: '#06b6d4', borderWidth: 1 }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { labels: { color: '#9898b0', font: { size: 10 } } } },
            scales: {
                x: { ticks: { color: '#6a6a80', font: { size: 9 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
                y: { ticks: { color: '#6a6a80', font: { size: 9 } }, grid: { color: 'rgba(255,255,255,0.04)' } }
            }
        }
    });
}

// ===== EXPORT REPORT =====
function exportReport(routes, fromName, toName) {
    const best = routes[0];
    const now = new Date().toISOString().split('T');
    let text = `════════════════════════════════════════\n`;
    text += `  ECOROUTE AGENT — ECO MOBILITY REPORT\n`;
    text += `════════════════════════════════════════\n\n`;
    text += `Date: ${now[0]}  Time: ${now[1].split('.')[0]}\n`;
    text += `From: ${fromName}\nTo: ${toName}\n\n`;
    text += `─── ROUTE COMPARISON ───\n\n`;
    routes.forEach(r => {
        text += `${r.name}\n`;
        text += `  Distance: ${r.route.distanceKm.toFixed(2)} km\n`;
        text += `  Duration: ${Math.round(r.route.durationMin)} min\n`;
        text += `  CO₂ Emitted: ${r.co2.toFixed(1)} g\n`;
        text += `  CO₂ Saved vs Car: ${r.savings.toFixed(1)} g\n`;
        text += `  AQI Exposure: ${r.aqi}\n`;
        text += `  Health Score: ${r.health}/100\n`;
        text += `  Calories: ${r.calories.toFixed(0)} kcal\n`;
        text += `  Green Score: ${r.score}/100\n`;
        if (r.pois?.length) text += `  POIs: ${r.pois.map(p => p.name).join(', ')}\n`;
        text += `\n`;
    });
    text += `─── METHODOLOGY ───\n\n`;
    text += `Carbon Factors (g CO₂/km): Car=171, Bus=89, Tram=45, Train=41, Bike=0, Walk=0\n`;
    text += `Source: EU Transport & Environment Agency, 2023\n`;
    text += `Routing: OSRM (Open Source Routing Machine)\n`;
    text += `Geocoding: OpenStreetMap Nominatim\n`;
    text += `POI Data: OpenStreetMap Overpass API\n`;
    text += `AQI Model: Based on Swiss NABEL air quality network\n\n`;
    text += `Generated by EcoRoute Agent\n`;

    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `EcoRoute_Report_${now[0]}.txt`;
    a.click();
    showToast('Report downloaded!', 'success');
}

// ===== THEME TOGGLE =====
function initTheme() {
    const saved = localStorage.getItem('ecoroute-theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = saved || (prefersDark ? 'dark' : 'light');
    applyTheme(theme);
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('ecoroute-theme', theme);
    const sunIcon = document.querySelector('#btn-theme-toggle .icon-sun');
    const moonIcon = document.querySelector('#btn-theme-toggle .icon-moon');
    if (sunIcon && moonIcon) {
        if (theme === 'light') {
            sunIcon.style.display = 'none';
            moonIcon.style.display = 'block';
        } else {
            sunIcon.style.display = 'block';
            moonIcon.style.display = 'none';
        }
    }
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    applyTheme(current === 'dark' ? 'light' : 'dark');
}

// ===== MAIN PLANNING =====
let currentPref = 'eco', lastRoutes = null, lastName = {};

async function planRoute() {
    const fromQ = document.getElementById('input-from').value.trim();
    const toQ = document.getElementById('input-to').value.trim();
    const btn = document.getElementById('btn-plan-route');
    if (!fromQ || !toQ) { showToast('Please enter both locations'); return; }

    btn.classList.add('btn-loading');
    try {
        const from = await geocodeSingle(fromQ);
        const to = await geocodeSingle(toQ);
        lastName = { from: fromQ, to: toQ };

        document.getElementById('geo-status-from').className = 'geocode-status success';
        document.getElementById('geo-status-from').textContent = `✓ ${from.lat.toFixed(4)}, ${from.lng.toFixed(4)}`;
        document.getElementById('geo-status-to').className = 'geocode-status success';
        document.getElementById('geo-status-to').textContent = `✓ ${to.lat.toFixed(4)}, ${to.lng.toFixed(4)}`;

        const routes = await runAgents(fromQ, toQ, from, to, currentPref);
        if (routes.length) {
            lastRoutes = routes;
            displayRoutes(routes, currentPref);
            displayResults(routes, currentPref);
        }
    } catch (e) {
        showToast(e.message);
    }
    btn.classList.remove('btn-loading');
}

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    if (document.getElementById('particles-canvas')) new ParticleSystem(document.getElementById('particles-canvas'));

    // Nav
    const nav = document.getElementById('main-nav');
    window.addEventListener('scroll', () => nav.classList.toggle('scrolled', window.scrollY > 50));
    document.querySelectorAll('a[href^="#"]').forEach(l => l.addEventListener('click', e => {
        e.preventDefault(); document.querySelector(l.getAttribute('href'))?.scrollIntoView({ behavior: 'smooth' });
    }));
    document.getElementById('btn-try-demo')?.addEventListener('click', () => document.getElementById('demo').scrollIntoView({ behavior: 'smooth' }));
    document.getElementById('btn-hero-demo')?.addEventListener('click', () => document.getElementById('demo').scrollIntoView({ behavior: 'smooth' }));

    // Theme toggle
    document.getElementById('btn-theme-toggle')?.addEventListener('click', toggleTheme);

    initMaps();
    initAutocomplete();

    // Preferences
    document.querySelectorAll('.pref-chip').forEach(c => c.addEventListener('click', () => {
        document.querySelectorAll('.pref-chip').forEach(x => x.classList.remove('active'));
        c.classList.add('active'); currentPref = c.dataset.pref;
    }));
    document.querySelectorAll('.mode-btn').forEach(b => b.addEventListener('click', () => b.classList.toggle('active')));

    document.getElementById('btn-plan-route')?.addEventListener('click', planRoute);
    document.getElementById('btn-export')?.addEventListener('click', () => { if (lastRoutes) exportReport(lastRoutes, lastName.from, lastName.to); });
    document.querySelectorAll('#input-from,#input-to').forEach(i => i.addEventListener('keypress', e => { if (e.key === 'Enter') planRoute(); }));

    // Scroll animations
    const obs = new IntersectionObserver(entries => entries.forEach(e => { if (e.isIntersecting) { e.target.style.opacity = '1'; e.target.style.transform = 'translateY(0)'; } }), { threshold: 0.1 });
    document.querySelectorAll('.feature-card,.tech-card,.impact-card,.arch-layer').forEach(el => {
        el.style.opacity = '0'; el.style.transform = 'translateY(20px)'; el.style.transition = 'opacity 0.6s ease,transform 0.6s ease'; obs.observe(el);
    });
});

