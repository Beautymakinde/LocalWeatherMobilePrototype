import { useState, useEffect, useRef } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

type Unit = 'F' | 'C';

interface Loc {
  lat: number;
  lng: number;
  name: string;
  admin: string;
}

interface Current {
  temp: number;
  feelsLike: number;
  weatherCode: number;
  windSpeed: number;
  windGusts: number;
  humidity: number;
  precip: number;
}

interface Hour {
  time: Date;
  label: string;
  temp: number;
  feelsLike: number;
  precipProb: number;
  precip: number;
  weatherCode: number;
  windSpeed: number;
  uvIndex: number;
}

interface Weather {
  current: Current;
  hourly: Hour[];
  todayHigh: number;
  todayLow: number;
  fetchedAt: Date;
  tz: string;
}

type Phase = 'requesting' | 'loading' | 'success' | 'error';

// ─── Constants ────────────────────────────────────────────────────────────────

const CHICAGO: Loc = { lat: 41.8781, lng: -87.6298, name: 'Chicago', admin: 'IL' };

// ─── WMO Weather Code Map ─────────────────────────────────────────────────────

function wmo(code: number): { label: string; icon: string } {
  if (code === 0) return { label: 'Clear sky', icon: '☀️' };
  if (code === 1) return { label: 'Mainly clear', icon: '🌤️' };
  if (code === 2) return { label: 'Partly cloudy', icon: '⛅' };
  if (code === 3) return { label: 'Overcast', icon: '☁️' };
  if (code === 45 || code === 48) return { label: 'Fog', icon: '🌫️' };
  if (code >= 51 && code <= 55) return { label: 'Drizzle', icon: '🌦️' };
  if (code >= 61 && code <= 65) return { label: 'Rain', icon: '🌧️' };
  if (code >= 71 && code <= 75) return { label: 'Snow', icon: '🌨️' };
  if (code === 77) return { label: 'Snow grains', icon: '❄️' };
  if (code >= 80 && code <= 82) return { label: 'Rain showers', icon: '🌦️' };
  if (code === 85 || code === 86) return { label: 'Snow showers', icon: '🌨️' };
  if (code === 95) return { label: 'Thunderstorm', icon: '⛈️' };
  if (code === 96 || code === 99) return { label: 'Thunderstorm', icon: '⛈️' };
  return { label: 'Unknown', icon: '🌡️' };
}

// ─── Conversions ──────────────────────────────────────────────────────────────

const toF = (c: number) => Math.round(c * 9 / 5 + 32);
const toMph = (k: number) => Math.round(k * 0.621371);

function dispT(c: number, u: Unit) {
  return u === 'F' ? `${toF(c)}°` : `${Math.round(c)}°`;
}

function dispW(kmh: number, u: Unit) {
  return u === 'F' ? `${toMph(kmh)} mph` : `${Math.round(kmh)} km/h`;
}

// ─── Decision Logic ───────────────────────────────────────────────────────────

function jacketRec(feelsC: number, windKmh: number) {
  let text: string;
  if (feelsC >= 24) text = 'No jacket needed';
  else if (feelsC >= 16) text = 'Light layer recommended';
  else if (feelsC >= 10) text = 'Jacket recommended';
  else if (feelsC >= 4) text = 'Warm jacket recommended';
  else text = 'Heavy coat — dress warmly';
  const windNote = windKmh >= 24 && feelsC < 16 ? 'Wind is making it feel colder' : undefined;
  return { text, windNote };
}

function rainRec(hours: Hour[]) {
  const window = hours.slice(0, 6);
  const likely = window.find(h => h.precipProb >= 70);
  const possible = window.find(h => h.precipProb >= 40);
  if (likely) return { text: `Rain likely around ${likely.label}`, level: 'likely' as const };
  if (possible) return { text: `Rain possible around ${possible.label}`, level: 'possible' as const };
  return { text: 'No rain expected in the next 6 hours', level: 'none' as const };
}

function bestWindow(hours: Hour[]) {
  if (hours.length < 4) return null;
  const score = (h: Hour) => {
    let s = 100;
    s -= h.precipProb * 0.4;
    s -= Math.min(Math.abs(h.feelsLike - 20) * 1.5, 30);
    if (h.windSpeed > 24) s -= Math.min((h.windSpeed - 24) * 0.5, 20);
    if (h.uvIndex > 8) s -= 10;
    return s;
  };
  const slice = hours.slice(0, 10);
  const scores = slice.map(score);
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  let best = -Infinity, bi = 0;
  for (let i = 0; i < scores.length - 1; i++) {
    const ws = (scores[i] + scores[i + 1]) / 2;
    if (ws > best) { best = ws; bi = i; }
  }
  if (best - avg < 8) return null;
  const ei = Math.min(bi + 1, hours.length - 1);
  return { si: bi, ei, label: `${hours[bi].label}–${hours[ei].label}` };
}

// ─── API ─────────────────────────────────────────────────────────────────────

async function fetchWeather(loc: Loc): Promise<Weather> {
  const params = new URLSearchParams({
    latitude: String(loc.lat),
    longitude: String(loc.lng),
    current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_gusts_10m,relative_humidity_2m,precipitation',
    hourly: 'temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,uv_index',
    daily: 'temperature_2m_max,temperature_2m_min',
    timezone: 'auto',
    forecast_days: '2',
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!res.ok) throw new Error(`Weather API error: ${res.status}`);
  const d = await res.json();

  const offsetMs: number = d.utc_offset_seconds * 1000;
  const tz: string = d.timezone;
  const now = new Date();

  // API returns times in the location's local timezone without offset marker.
  // Treating the string as UTC then subtracting the offset yields correct UTC.
  const parseLocal = (s: string) => new Date(Date.parse(s + ':00Z') - offsetMs);

  const fmtHour = (dt: Date) =>
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: true, timeZone: tz }).format(dt);

  const allTimes = (d.hourly.time as string[]).map(parseLocal);
  const nowIdx = allTimes.findIndex(t => t >= now);
  const start = nowIdx >= 0 ? nowIdx : 0;

  const hourly: Hour[] = [];
  for (let i = start; i < Math.min(start + 12, allTimes.length); i++) {
    hourly.push({
      time: allTimes[i],
      label: fmtHour(allTimes[i]),
      temp: d.hourly.temperature_2m[i],
      feelsLike: d.hourly.apparent_temperature[i],
      precipProb: d.hourly.precipitation_probability[i] ?? 0,
      precip: d.hourly.precipitation[i] ?? 0,
      weatherCode: d.hourly.weather_code[i],
      windSpeed: d.hourly.wind_speed_10m[i],
      uvIndex: d.hourly.uv_index[i] ?? 0,
    });
  }

  return {
    current: {
      temp: d.current.temperature_2m,
      feelsLike: d.current.apparent_temperature,
      weatherCode: d.current.weather_code,
      windSpeed: d.current.wind_speed_10m,
      windGusts: d.current.wind_gusts_10m,
      humidity: d.current.relative_humidity_2m,
      precip: d.current.precipitation,
    },
    hourly,
    todayHigh: d.daily.temperature_2m_max[0],
    todayLow: d.daily.temperature_2m_min[0],
    fetchedAt: now,
    tz,
  };
}

async function geocodeSearch(q: string): Promise<Loc[]> {
  const res = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=5&language=en&format=json`
  );
  if (!res.ok) throw new Error('Geocoding failed');
  const d = await res.json();
  if (!d.results?.length) return [];
  return d.results.map((r: Record<string, unknown>) => ({
    lat: r.latitude as number,
    lng: r.longitude as number,
    name: r.name as string,
    admin: (r.admin1 ?? r.country ?? '') as string,
  }));
}

// ─── Icons ────────────────────────────────────────────────────────────────────

function PinIcon() {
  return (
    <svg width="11" height="14" viewBox="0 0 11 14" fill="none" aria-hidden="true">
      <path
        d="M5.5 0C3.02 0 1 2.02 1 4.5 1 7.88 5.5 14 5.5 14s4.5-6.12 4.5-9.5C10 2.02 7.98 0 5.5 0Zm0 6.25a1.75 1.75 0 1 1 0-3.5 1.75 1.75 0 0 1 0 3.5Z"
        fill="#94A3B8"
      />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg width="10" height="6" viewBox="0 0 10 6" fill="none" aria-hidden="true">
      <path d="M1 1l4 4 4-4" stroke="#94A3B8" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      width="16" height="16" viewBox="0 0 16 16" fill="none"
      className={spinning ? 'animate-spin' : ''}
      aria-hidden="true"
    >
      <path
        d="M14 8A6 6 0 1 1 8 2a6 6 0 0 1 4.24 1.76L10.5 5.5H14V2l-1.52 1.52A7.5 7.5 0 1 0 15.5 8H14Z"
        fill="currentColor"
      />
    </svg>
  );
}

function CrossIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M9.5 9.5L13 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function TargetIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 1.5V4M8 12v2.5M1.5 8H4M12 8h2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

// ─── App ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [unit, setUnit] = useState<Unit>('F');
  const [phase, setPhase] = useState<Phase>('requesting');
  const [loc, setLoc] = useState<Loc>(CHICAGO);
  const [locDenied, setLocDenied] = useState(false)
  const [userTriedLocation, setUserTriedLocation] = useState(false);
  const [weather, setWeather] = useState<Weather | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showSearch, setShowSearch] = useState(false);

  const [query, setQuery] = useState('');
  const [searchRes, setSearchRes] = useState<Loc[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // ── Core fetch ──────────────────────────────────────────────────────────────

  async function loadFor(target: Loc, isRefresh = false) {
    if (isRefresh) {
      setRefreshing(true);
    } else {
      setPhase('loading');
      setWeather(null);
    }
    setErrMsg(null);
    try {
      const w = await fetchWeather(target);
      setWeather(w);
      setPhase('success');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not load weather';
      setErrMsg(msg);
      if (!isRefresh) setPhase('error');
    } finally {
      setRefreshing(false);
    }
  }

  // ── Initial geolocation ─────────────────────────────────────────────────────

  useEffect(() => {
    if (!navigator.geolocation) {
      setLocDenied(true);
      loadFor(CHICAGO);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => {
        const l: Loc = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          name: 'Current location',
          admin: '',
        };
        setLoc(l);
        loadFor(l);
      },
      () => {
        setLocDenied(true);
        loadFor(CHICAGO);
      },
      { timeout: 8000, maximumAge: 60000 }
    );
  }, []);

  // ── Search debounce ─────────────────────────────────────────────────────────

  useEffect(() => {
    setSearchRes([]);
    setSearchErr(null);
    if (!query.trim()) return;
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const results = await geocodeSearch(query.trim());
        setSearchRes(results);
        if (!results.length) setSearchErr('No locations found');
      } catch {
        setSearchErr('Search failed — check your connection');
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => clearTimeout(searchTimer.current);
  }, [query]);

  // ── Focus search input ──────────────────────────────────────────────────────

  useEffect(() => {
    if (showSearch) {
      setTimeout(() => searchInputRef.current?.focus(), 80);
    } else {
      setQuery('');
      setSearchRes([]);
      setSearchErr(null);
    }
  }, [showSearch]);

  // ── Handlers ────────────────────────────────────────────────────────────────

  function selectLoc(l: Loc) {
    setLoc(l);
    setLocDenied(false);
    setShowSearch(false);
    loadFor(l);
  }

  function requestCurrentLoc() {
    setShowSearch(false);
    setUserTriedLocation(true);
    if (!navigator.geolocation) {
      setLocDenied(true);
      return;
    }
    setPhase('loading');
    navigator.geolocation.getCurrentPosition(
      pos => {
        const l: Loc = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          name: 'Current location',
          admin: '',
        };
        setLoc(l);
        setLocDenied(false);
        loadFor(l);
      },
      () => {
        setLocDenied(true);
        if (!weather) loadFor(CHICAGO);
        else setPhase('success');
      },
      { timeout: 8000 }
    );
  }

  function skipToChicago() {
    setLoc(CHICAGO);
    setLocDenied(true);
    loadFor(CHICAGO);
  }

  // ── Derived values ──────────────────────────────────────────────────────────

  const locLabel = loc.admin ? `${loc.name}, ${loc.admin}` : loc.name;
  const cond = weather ? wmo(weather.current.weatherCode) : null;
  const jacket = weather ? jacketRec(weather.current.feelsLike, weather.current.windSpeed) : null;
  const rain = weather ? rainRec(weather.hourly) : null;
  const bw = weather ? bestWindow(weather.hourly) : null;

  const tempDiff = weather ? Math.abs(weather.current.temp - weather.current.feelsLike) : 0;
  const feelsWarning =
    weather && tempDiff >= 3
      ? weather.current.feelsLike < weather.current.temp
        ? '↓ colder than it looks'
        : '↑ warmer than it looks'
      : null;

  const fmtUpdated = (d: Date, tz: string) =>
    new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: tz,
    }).format(d);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-[#EDEEF0] font-sans text-[#0D0F14] max-w-[430px] mx-auto relative">

      {/* ── HEADER ─────────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-10 bg-[#EDEEF0]" style={{ paddingTop: 'max(env(safe-area-inset-top), 50px)' }}>
        <div className="flex items-center px-4 h-[52px] gap-1">

          {/* Location button */}
          <button
            onClick={() => setShowSearch(true)}
            className="flex items-center gap-1.5 flex-1 min-h-[44px] text-left"
            aria-label="Change location"
          >
            <PinIcon />
            <span className="text-[13px] font-semibold truncate">
              {phase === 'requesting' ? 'Locating…' : locLabel}
            </span>
            <ChevronIcon />
          </button>

          {/* Refresh */}
          <button
            onClick={() => weather && loadFor(loc, true)}
            disabled={phase === 'loading' || phase === 'requesting' || refreshing}
            className="w-[44px] h-[44px] flex items-center justify-center text-[#94A3B8] hover:text-[#0D0F14] disabled:opacity-30 transition-colors"
            aria-label="Refresh weather"
          >
            <RefreshIcon spinning={refreshing} />
          </button>

          {/* Unit toggle */}
          <div className="flex rounded-full border border-[#0D0F14]/12 overflow-hidden ml-1 bg-[#E4E5E8]" role="group" aria-label="Temperature unit">
            {(['F', 'C'] as Unit[]).map(u => (
              <button
                key={u}
                onClick={() => setUnit(u)}
                aria-pressed={unit === u}
                aria-label={u === 'F' ? 'Fahrenheit' : 'Celsius'}
                className={`w-[36px] h-[30px] text-xs font-semibold transition-all ${
                  unit === u
                    ? 'bg-white text-[#0D0F14] shadow-sm'
                    : 'text-[#94A3B8] hover:text-[#64748B]'
                }`}
              >
                °{u}
              </button>
            ))}
          </div>
        </div>

        <div className="h-px bg-[#0D0F14]/10" />
      </header>

      {/* ── MAIN CONTENT ───────────────────────────────────────────────────── */}
      <main className="pb-16">

        {/* Requesting location permission */}
        {phase === 'requesting' && (
          <div className="flex flex-col items-center justify-center min-h-[70vh] px-8 text-center gap-4">
            <span className="text-5xl" role="img" aria-label="Location pin">📍</span>
            <p className="text-[16px] font-semibold">Allow location access</p>
            <p className="text-[14px] text-[#64748B] leading-relaxed">
              Allow location access for your local weather. Chicago will be used as the default if access is denied.
            </p>
            <button
              onClick={skipToChicago}
              className="mt-1 h-[44px] px-6 rounded-full border border-[#0D0F14]/20 text-[14px] font-medium text-[#64748B] hover:text-[#0D0F14] hover:border-[#0D0F14]/40 transition-colors"
            >
              Use Chicago instead
            </button>
          </div>
        )}

        {/* Loading */}
        {phase === 'loading' && (
          <div className="flex flex-col items-center justify-center min-h-[70vh] gap-3">
            <div className="w-6 h-6 border-2 border-[#0D0F14]/15 border-t-[#0D0F14] rounded-full animate-spin" />
            <p className="text-[13px] text-[#94A3B8]">Loading weather…</p>
          </div>
        )}

        {/* Error — no prior data */}
        {phase === 'error' && (
          <div className="flex flex-col items-center justify-center min-h-[70vh] px-8 text-center gap-4">
            <span className="text-4xl" role="img" aria-label="Warning">⚠️</span>
            <p className="text-[16px] font-semibold">Could not load weather</p>
            <p className="text-[14px] text-[#64748B] leading-relaxed">
              {errMsg ?? 'Check your connection and try again.'}
            </p>
            <button
              onClick={() => loadFor(loc)}
              className="mt-1 h-[44px] px-6 bg-[#0D0F14] text-white text-[14px] font-semibold rounded-full"
            >
              Try again
            </button>
          </div>
        )}

        {/* ── WEATHER DATA ─────────────────────────────────────────────────── */}
        {phase === 'success' && weather && cond && jacket && rain && (

          <div className={refreshing ? 'opacity-60 transition-opacity duration-200' : 'transition-opacity duration-200'}>

            {/* Context notices — only shown when user actively requested location */}
            {locDenied && userTriedLocation && (
              <div className="flex items-center gap-2 px-6 pt-3 pb-0">
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
                  <circle cx="5.5" cy="5.5" r="4.5" stroke="#94A3B8" strokeWidth="1" />
                  <path d="M5.5 4.5v3M5.5 3.5v.5" stroke="#94A3B8" strokeWidth="1" strokeLinecap="round" />
                </svg>
                <p className="text-[11px] text-[#94A3B8]">Location unavailable — showing Chicago, IL</p>
              </div>
            )}
            {errMsg && (
              <p className="px-6 pt-3 pb-0 text-[11px] text-red-400">Refresh failed — showing last update</p>
            )}

            {/* ── NOW ── */}
            <section className="px-6 pt-5 pb-7">

              {/* Condition */}
              <div className="flex items-center gap-2 mb-3">
                <span className="text-[20px]" role="img" aria-label={cond.label}>{cond.icon}</span>
                <span className="text-[14px] font-medium text-[#64748B]">{cond.label}</span>
              </div>

              {/* Temperature — number and unit as one composed element */}
              <div className="flex items-baseline gap-0">
                <span className="font-mono text-[80px] leading-none font-light tracking-tight">
                  {unit === 'F' ? toF(weather.current.temp) : Math.round(weather.current.temp)}
                </span>
                <span className="font-mono text-[32px] leading-none font-light text-[#0D0F14] ml-0.5">
                  °{unit}
                </span>
              </div>

              {/* Feels like + warning */}
              <div className="mt-2.5 flex items-center gap-2.5 flex-wrap">
                <span className="text-[14px] text-[#64748B]">
                  Feels like{' '}
                  <span className="font-mono font-medium text-[#0D0F14]">
                    {dispT(weather.current.feelsLike, unit)}
                  </span>
                </span>
                {feelsWarning && (
                  <span className="text-[11px] text-[#94A3B8] bg-[#0D0F14]/5 px-2 py-0.5 rounded-full">
                    {feelsWarning}
                  </span>
                )}
              </div>

              {/* H / L + timestamp on same row */}
              <div className="mt-1.5 flex items-center justify-between">
                <span className="text-[13px] text-[#64748B]">
                  H{' '}
                  <span className="font-mono font-medium text-[#0D0F14]">{dispT(weather.todayHigh, unit)}</span>
                  <span className="mx-1 text-[#C4C8D0]">·</span>
                  L{' '}
                  <span className="font-mono font-medium text-[#0D0F14]">{dispT(weather.todayLow, unit)}</span>
                  <span className="ml-1.5 text-[#94A3B8] text-[12px]">today</span>
                </span>
                <span className="text-[11px] text-[#B0B5BF]">
                  {fmtUpdated(weather.fetchedAt, weather.tz)}
                </span>
              </div>
            </section>

            {/* ── BEFORE YOU GO ── */}
            <section className="border-t border-[#0D0F14]/10 px-6 py-6">
              <h2 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#94A3B8] mb-5">
                Before you go
              </h2>

              {/* Rain first — more binary, more urgent */}
              <div className="flex gap-3 items-start mb-5">
                <div className={`w-5 h-5 flex-shrink-0 mt-0.5 flex items-center justify-center rounded-full ${
                  rain.level === 'none' ? 'bg-[#166534]/10' : 'bg-[#92400E]/10'
                }`}>
                  {rain.level === 'none' ? (
                    <svg width="9" height="7" viewBox="0 0 9 7" fill="none" aria-hidden="true">
                      <path d="M1 3.5l2.5 2.5 5-5" stroke="#166534" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : (
                    <span className="text-[11px]" role="img" aria-label="Rain">☂</span>
                  )}
                </div>
                <div>
                  {rain.level === 'none' ? (
                    <p className="text-[14px] text-[#64748B] leading-snug">{rain.text}</p>
                  ) : (
                    <>
                      <p className={`text-[15px] font-semibold leading-snug ${
                        rain.level === 'likely' ? 'text-[#92400E]' : 'text-[#B45309]'
                      }`}>
                        {rain.text}
                      </p>
                      <p className="text-[12px] text-[#64748B] mt-0.5">Bring an umbrella or raincoat</p>
                    </>
                  )}
                </div>
              </div>

              {/* Jacket */}
              <div className="flex gap-3 items-start">
                <div className="w-5 h-5 flex-shrink-0 mt-0.5 flex items-center justify-center">
                  <span className="text-[16px]" role="img" aria-label="Clothing">🧥</span>
                </div>
                <div>
                  <p className="text-[15px] font-semibold leading-snug">{jacket.text}</p>
                  {jacket.windNote && (
                    <p className="text-[12px] text-[#64748B] mt-0.5">{jacket.windNote}</p>
                  )}
                  <p className="text-[12px] text-[#94A3B8] mt-0.5">
                    Wind {dispW(weather.current.windSpeed, unit)}
                    {weather.current.windGusts > weather.current.windSpeed + 8
                      ? `, gusts to ${dispW(weather.current.windGusts, unit)}`
                      : ''}
                  </p>
                </div>
              </div>
            </section>

            {/* ── NEXT FEW HOURS ── */}
            {weather.hourly.length > 0 && (
              <section className="border-t border-[#0D0F14]/10 pt-6 pb-5">
                <div className="flex items-baseline justify-between px-6 mb-4">
                  <h2 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#94A3B8]">
                    Next few hours
                  </h2>
                  {bw && (
                    <span className="text-[11px] font-medium text-[#1B3A6B]">
                      Best: {bw.label}
                    </span>
                  )}
                </div>

                <div className="flex gap-1.5 overflow-x-auto no-scrollbar px-5 pb-0.5">
                  {weather.hourly.map((h, i) => {
                    const hc = wmo(h.weatherCode);
                    const isBest = bw != null && i >= bw.si && i <= bw.ei;
                    const isNow = i === 0;
                    return (
                      <div
                        key={i}
                        className={`flex-shrink-0 flex flex-col items-center gap-1.5 px-2.5 pt-2.5 pb-3 rounded-xl min-w-[56px] ${
                          isBest
                            ? 'bg-[#EEF2FF] ring-1 ring-[#C7D2FE]'
                            : isNow
                            ? 'bg-white ring-1 ring-[#0D0F14]/10'
                            : 'bg-white'
                        }`}
                      >
                        <span className={`text-[10px] font-semibold whitespace-nowrap ${
                          isNow ? 'text-[#0D0F14]' : 'text-[#94A3B8]'
                        }`}>
                          {isNow ? 'Now' : h.label}
                        </span>
                        <span className="text-[16px]" role="img" aria-label={hc.label}>
                          {hc.icon}
                        </span>
                        <span className="font-mono text-[13px] font-medium">
                          {dispT(h.temp, unit)}
                        </span>
                        {h.precipProb > 10 ? (
                          <span className={`text-[10px] font-medium ${
                            h.precipProb >= 70 ? 'text-[#92400E]' :
                            h.precipProb >= 40 ? 'text-[#B45309]' :
                            'text-[#94A3B8]'
                          }`}>
                            {h.precipProb}%
                          </span>
                        ) : (
                          <div className="h-[14px]" />
                        )}
                      </div>
                    );
                  })}
                </div>

                {bw && (
                  <p className="text-[11px] text-[#94A3B8] px-6 mt-3">
                    Best window — lower precipitation, lighter wind
                  </p>
                )}
              </section>
            )}

            {/* ── CONDITIONS ── */}
            <section className="border-t border-[#0D0F14]/10 px-6 pt-6 pb-8">
              <h2 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#94A3B8] mb-4">
                Conditions
              </h2>
              <div className="grid grid-cols-2 gap-x-6 gap-y-5">
                <div>
                  <p className="text-[12px] text-[#94A3B8] mb-1">Wind</p>
                  <p className="font-mono text-[20px] font-medium leading-tight">
                    {dispW(weather.current.windSpeed, unit)}
                  </p>
                  {weather.current.windGusts > weather.current.windSpeed + 8 && (
                    <p className="text-[12px] text-[#64748B] mt-0.5">
                      Gusts {dispW(weather.current.windGusts, unit)}
                    </p>
                  )}
                </div>
                <div>
                  <p className="text-[12px] text-[#94A3B8] mb-1">Humidity</p>
                  <p className="font-mono text-[20px] font-medium leading-tight">
                    {weather.current.humidity}%
                  </p>
                </div>
              </div>
            </section>

          </div>
        )}
      </main>

      {/* ── SEARCH OVERLAY ─────────────────────────────────────────────────── */}
      {showSearch && (
        <div className="fixed inset-0 z-50 flex flex-col justify-end" role="dialog" aria-modal="true" aria-label="Search location">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setShowSearch(false)}
            aria-hidden="true"
          />

          {/* Panel */}
          <div className="relative w-full max-w-[430px] mx-auto bg-white rounded-t-2xl shadow-2xl max-h-[82vh] flex flex-col">

            {/* Drag handle */}
            <div className="flex justify-center pt-3 pb-0.5">
              <div className="w-8 h-1 rounded-full bg-[#E2E8F0]" />
            </div>

            {/* Panel header */}
            <div className="flex items-center justify-between px-5 pt-2 pb-3">
              <h3 className="text-[15px] font-semibold">Search location</h3>
              <button
                onClick={() => setShowSearch(false)}
                className="w-[44px] h-[44px] flex items-center justify-center text-[#94A3B8] hover:text-[#0D0F14] transition-colors"
                aria-label="Close"
              >
                <CrossIcon />
              </button>
            </div>

            {/* Search input */}
            <div className="px-5 pb-3">
              <div className="flex items-center gap-2.5 bg-[#F1F5F9] rounded-xl h-[44px] px-3.5">
                <span className="text-[#94A3B8] flex-shrink-0"><SearchIcon /></span>
                <input
                  ref={searchInputRef}
                  type="search"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="City or ZIP code…"
                  className="flex-1 text-[14px] bg-transparent outline-none placeholder:text-[#94A3B8]"
                  aria-label="Search for a city"
                />
                {searching && (
                  <div className="w-4 h-4 border-2 border-[#94A3B8] border-t-transparent rounded-full animate-spin flex-shrink-0" />
                )}
                {query && !searching && (
                  <button
                    onClick={() => setQuery('')}
                    className="text-[#94A3B8] hover:text-[#0D0F14] flex-shrink-0 transition-colors"
                    aria-label="Clear search"
                  >
                    <CrossIcon size={12} />
                  </button>
                )}
              </div>
            </div>

            {/* Results list */}
            <div className="overflow-y-auto flex-1 no-scrollbar">

              {/* Use current location */}
              <button
                onClick={requestCurrentLoc}
                className="w-full flex items-center gap-3 px-5 py-3.5 border-b border-black/5 hover:bg-[#F8FAFC] text-left transition-colors"
              >
                <span className="text-[#1B3A6B] flex-shrink-0"><TargetIcon /></span>
                <span className="text-[14px] font-medium text-[#1B3A6B]">Use my current location</span>
              </button>

              {/* Search error */}
              {searchErr && !searching && (
                <p className="px-5 py-8 text-[13px] text-[#94A3B8] text-center">{searchErr}</p>
              )}

              {/* Results */}
              {searchRes.map((r, i) => (
                <button
                  key={i}
                  onClick={() => selectLoc(r)}
                  className="w-full flex items-center gap-3 px-5 py-3.5 border-b border-black/5 hover:bg-[#F8FAFC] text-left transition-colors"
                >
                  <span className="flex-shrink-0">
                    <svg width="11" height="14" viewBox="0 0 11 14" fill="none" aria-hidden="true">
                      <path
                        d="M5.5 0C3.02 0 1 2.02 1 4.5 1 7.88 5.5 14 5.5 14s4.5-6.12 4.5-9.5C10 2.02 7.98 0 5.5 0Zm0 6.25a1.75 1.75 0 1 1 0-3.5 1.75 1.75 0 0 1 0 3.5Z"
                        fill="#94A3B8"
                      />
                    </svg>
                  </span>
                  <div>
                    <p className="text-[14px] font-medium">{r.name}</p>
                    {r.admin && <p className="text-[12px] text-[#94A3B8]">{r.admin}</p>}
                  </div>
                </button>
              ))}

              {/* Empty state */}
              {!query && !searchRes.length && (
                <p className="px-5 py-8 text-[13px] text-[#94A3B8] text-center">
                  Search for a city, neighborhood, or ZIP code
                </p>
              )}

              <div className="h-8" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
