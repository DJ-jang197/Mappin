import "./styles/webApp.css";
import { haversine } from "./utils/haversine";
import { parseDestinationFromMapsPage } from "./utils/parseCoords";
import { AlarmHistoryEntry, AlarmState, Destination } from "./utils/types";

const STORAGE_STATE = "locationAlarmWeb.state";
const STORAGE_HISTORY = "locationAlarmWeb.history";
const STORAGE_RADIUS = "locationAlarmWeb.radiusMetres";

const RADIUS_MIN_M = 50;
const RADIUS_MAX_M = 2_000;
const RADIUS_DEFAULT_M = 200;

const GEO_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 30_000,
  timeout: 10_000
};

const mapsUrlInput = document.getElementById("maps-url") as HTMLTextAreaElement | null;
const labelOverrideInput = document.getElementById("label-override") as HTMLInputElement | null;
const loadDestButton = document.getElementById("load-destination") as HTMLButtonElement | null;
const statusEl = document.getElementById("status");
const destinationEl = document.getElementById("destination");
const radiusSlider = document.getElementById("radius-slider") as HTMLInputElement | null;
const radiusValueEl = document.getElementById("radius-value");
const startButton = document.getElementById("start-monitoring") as HTMLButtonElement | null;
const clearButton = document.getElementById("clear-alarm") as HTMLButtonElement | null;
const distanceEl = document.getElementById("distance");
const accuracyEl = document.getElementById("accuracy");
const errorEl = document.getElementById("error");

if (
  !mapsUrlInput ||
  !labelOverrideInput ||
  !loadDestButton ||
  !statusEl ||
  !destinationEl ||
  !radiusSlider ||
  !radiusValueEl ||
  !startButton ||
  !clearButton ||
  !distanceEl ||
  !accuracyEl ||
  !errorEl
) {
  throw new Error("Web app markup is missing required elements.");
}

const mapsUrlNode = mapsUrlInput;
const labelOverrideNode = labelOverrideInput;
const loadDestNode = loadDestButton;
const statusNode = statusEl;
const destinationNode = destinationEl;
const radiusNode = radiusSlider;
const radiusValueNode = radiusValueEl;
const startNode = startButton;
const clearNode = clearButton;
const distanceNode = distanceEl;
const accuracyNode = accuracyEl;
const errorNode = errorEl;

let watchId: number | null = null;
let latestState: AlarmState = defaultState();
let arrivalNotified = false;
let radiusDebounce: number | null = null;

function defaultState(): AlarmState {
  return {
    destination: null,
    isActive: false,
    hasArrived: false,
    radiusMetres: RADIUS_DEFAULT_M
  };
}

function emptyDocumentLike(title: string): {
  title: string;
  querySelector: () => null;
} {
  return {
    title,
    querySelector: () => null
  };
}

function loadRadius(): number {
  try {
    const raw = localStorage.getItem(STORAGE_RADIUS);
    if (!raw) {
      return RADIUS_DEFAULT_M;
    }
    const v = Number(raw);
    if (!Number.isFinite(v) || v < RADIUS_MIN_M || v > RADIUS_MAX_M) {
      return RADIUS_DEFAULT_M;
    }
    return Math.round(v);
  } catch {
    return RADIUS_DEFAULT_M;
  }
}

function saveRadius(radiusMetres: number): void {
  localStorage.setItem(STORAGE_RADIUS, String(radiusMetres));
}

function loadState(): AlarmState {
  try {
    const raw = localStorage.getItem(STORAGE_STATE);
    if (!raw) {
      return { ...defaultState(), radiusMetres: loadRadius() };
    }
    const parsed = JSON.parse(raw) as Partial<AlarmState>;
    const radius = loadRadius();
    return {
      destination: parsed.destination ?? null,
      isActive: false,
      hasArrived: Boolean(parsed.hasArrived),
      radiusMetres: radius
    };
  } catch {
    return { ...defaultState(), radiusMetres: loadRadius() };
  }
}

function saveState(state: AlarmState): void {
  const serializable: AlarmState = {
    ...state,
    isActive: false
  };
  localStorage.setItem(STORAGE_STATE, JSON.stringify(serializable));
}

function loadHistory(): AlarmHistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_HISTORY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as AlarmHistoryEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveHistory(entries: AlarmHistoryEntry[]): void {
  localStorage.setItem(STORAGE_HISTORY, JSON.stringify(entries.slice(0, 5)));
}

function renderState(): void {
  const state = latestState;
  if (!state.destination) {
    statusNode.textContent = "IDLE";
  } else if (state.hasArrived) {
    statusNode.textContent = "ARRIVED";
  } else if (state.isActive) {
    statusNode.textContent = "ACTIVE";
  } else {
    statusNode.textContent = "IDLE";
  }

  destinationNode.textContent = state.destination
    ? `${state.destination.label} (${state.destination.coords.lat.toFixed(5)}, ${state.destination.coords.lng.toFixed(5)})`
    : "No destination loaded yet.";

  radiusNode.value = String(state.radiusMetres);
  radiusValueNode.textContent = String(state.radiusMetres);

  if (!state.destination) {
    distanceNode.textContent = "";
    accuracyNode.textContent = "";
  }

  const canStart = Boolean(state.destination) && !state.hasArrived && watchId === null;
  startNode.disabled = !canStart;
  startNode.textContent = watchId !== null ? "Monitoring…" : "Start monitoring";
}

function stopWatching(): void {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  if (latestState.isActive) {
    latestState = { ...latestState, isActive: false };
    saveState(latestState);
  }
}

function showArrivalNotification(destination: Destination): void {
  if (typeof Notification === "undefined") {
    return;
  }
  if (Notification.permission !== "granted") {
    return;
  }
  try {
    new Notification("Mappin — you've arrived", {
      body: `You arrived at ${destination.label || "your destination"}.`
    });
  } catch {
    // Ignore notification failures (e.g. mobile policy).
  }
}

function recordArrival(destination: Destination, arrivedAt: number): void {
  const entry: AlarmHistoryEntry = { destination, arrivedAt };
  const next = [entry, ...loadHistory()].slice(0, 5);
  saveHistory(next);
}

async function handleArrival(destination: Destination): Promise<void> {
  const arrivedAt = Date.now();
  latestState = { ...latestState, hasArrived: true, isActive: false };
  saveState(latestState);
  recordArrival(destination, arrivedAt);
  showArrivalNotification(destination);
  renderState();
}

function handleGeoPosition(position: GeolocationPosition): void {
  if (!latestState.destination) {
    stopWatching();
    return;
  }

  const current = {
    lat: position.coords.latitude,
    lng: position.coords.longitude
  };
  const accuracyMetres = position.coords.accuracy;
  const destination = latestState.destination.coords;
  const radiusMetres = latestState.radiusMetres;
  const distanceMetres = haversine(current, destination);

  distanceNode.textContent = `Distance: ${Math.round(
    distanceMetres
  )}m (arrival ≤ ${Math.round(radiusMetres)}m)`;
  accuracyNode.textContent =
    accuracyMetres > 500
      ? `GPS accuracy warning: ${Math.round(accuracyMetres)}m`
      : `GPS accuracy: ${Math.round(accuracyMetres)}m`;
  errorNode.textContent = "";

  if (distanceMetres <= radiusMetres && !latestState.hasArrived && !arrivalNotified) {
    arrivalNotified = true;
    stopWatching();
    void handleArrival(latestState.destination);
  }
}

function handleGeoError(error: GeolocationPositionError): void {
  if (error.code === error.PERMISSION_DENIED) {
    errorNode.textContent =
      "Location permission denied. On your phone: enable Location for the browser, open site settings for this page, and allow location. Then tap Start monitoring again.";
    stopWatching();
    renderState();
    return;
  }

  if (error.code === error.POSITION_UNAVAILABLE) {
    errorNode.textContent = "GPS signal unavailable. Keeping watch active and retrying.";
    return;
  }

  if (error.code === error.TIMEOUT) {
    errorNode.textContent = "GPS timeout. Waiting for the next position update.";
    return;
  }

  errorNode.textContent = "Unexpected geolocation error.";
}

async function startWatchIfNeeded(): Promise<void> {
  if (!latestState.destination || latestState.hasArrived || watchId !== null) {
    return;
  }

  if (typeof Notification !== "undefined" && Notification.permission === "default") {
    void Notification.requestPermission();
  }

  watchId = navigator.geolocation.watchPosition(handleGeoPosition, handleGeoError, GEO_OPTIONS);
  latestState = { ...latestState, isActive: true };
  saveState(latestState);
  renderState();

  navigator.geolocation.getCurrentPosition(handleGeoPosition, handleGeoError, GEO_OPTIONS);
}

loadDestNode.addEventListener("click", () => {
  errorNode.textContent = "";
  const href = mapsUrlNode.value.trim();
  if (!href) {
    errorNode.textContent = "Paste a Google Maps URL first.";
    return;
  }

  const labelOverride = labelOverrideNode.value.trim();
  const doc = emptyDocumentLike(labelOverride);
  const parsed = parseDestinationFromMapsPage(href, doc, {
    logger: console
  });

  if (!parsed) {
    errorNode.textContent =
      "Could not read coordinates from that URL. Try a link with @lat,lng in the path or ?q=lat,lng.";
    return;
  }

  const destination: Destination = labelOverride
    ? { ...parsed, label: labelOverride }
    : parsed;

  latestState = {
    ...latestState,
    destination,
    hasArrived: false,
    isActive: false,
    radiusMetres: loadRadius()
  };
  arrivalNotified = false;
  saveState(latestState);
  stopWatching();
  renderState();
});

startNode.addEventListener("click", () => {
  errorNode.textContent = "";
  void (async () => {
    if (!latestState.destination || latestState.hasArrived) {
      errorNode.textContent = "Load a destination first.";
      return;
    }
    if (watchId !== null) {
      return;
    }
    await startWatchIfNeeded();
  })();
});

clearNode.addEventListener("click", () => {
  stopWatching();
  latestState = {
    ...defaultState(),
    radiusMetres: loadRadius()
  };
  arrivalNotified = false;
  saveState(latestState);
  mapsUrlNode.value = "";
  labelOverrideNode.value = "";
  errorNode.textContent = "";
  distanceNode.textContent = "";
  accuracyNode.textContent = "";
  renderState();
});

radiusNode.addEventListener("input", () => {
  const value = Number(radiusNode.value);
  if (!Number.isFinite(value)) {
    return;
  }
  radiusValueNode.textContent = String(value);
  if (radiusDebounce !== null) {
    window.clearTimeout(radiusDebounce);
  }
  radiusDebounce = window.setTimeout(() => {
    radiusDebounce = null;
    const clamped = Math.min(RADIUS_MAX_M, Math.max(RADIUS_MIN_M, Math.round(value)));
    saveRadius(clamped);
    latestState = { ...latestState, radiusMetres: clamped };
    saveState(latestState);
    radiusNode.value = String(clamped);
    radiusValueNode.textContent = String(clamped);
  }, 100);
});

window.addEventListener("beforeunload", () => {
  stopWatching();
});

latestState = loadState();
if (latestState.isActive) {
  latestState = { ...latestState, isActive: false };
  saveState(latestState);
}
renderState();
