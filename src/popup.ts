import "./styles/popup.css";
import { haversine } from "./utils/haversine";
import { AlarmHistoryEntry, AlarmState, ExtensionMessage } from "./utils/types";

const statePanel = document.getElementById("state-panel");
const statePill = document.getElementById("state-pill");
const stateDesc = document.getElementById("state-desc");
const destinationEl = document.getElementById("destination");
const metricsBlock = document.getElementById("metrics-block");
const distanceEl = document.getElementById("distance");
const accuracyBadge = document.getElementById("accuracy-badge");
const errorEl = document.getElementById("error");
const radiusSlider = document.getElementById("radius-slider") as HTMLInputElement | null;
const radiusValueEl = document.getElementById("radius-value");
const startButton = document.getElementById("start-monitoring") as HTMLButtonElement | null;
const stopButton = document.getElementById("stop-monitoring") as HTMLButtonElement | null;
const refreshButton = document.getElementById("refresh-state") as HTMLButtonElement | null;
const clearButton = document.getElementById("clear-alarm") as HTMLButtonElement | null;
const historyList = document.getElementById("history-list");
const historyEmpty = document.getElementById("history-empty");

const GEO_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 30_000,
  timeout: 10_000
};

if (
  !statePanel ||
  !statePill ||
  !stateDesc ||
  !destinationEl ||
  !metricsBlock ||
  !distanceEl ||
  !accuracyBadge ||
  !errorEl ||
  !radiusSlider ||
  !radiusValueEl ||
  !startButton ||
  !stopButton ||
  !refreshButton ||
  !clearButton ||
  !historyList ||
  !historyEmpty
) {
  throw new Error("Popup UI missing required elements.");
}

const statePanelNode = statePanel;
const statePillNode = statePill;
const stateDescNode = stateDesc;
const destinationNode = destinationEl;
const metricsBlockNode = metricsBlock;
const distanceNode = distanceEl;
const accuracyBadgeNode = accuracyBadge;
const errorNode = errorEl;
const radiusNode = radiusSlider;
const radiusValueNode = radiusValueEl;
const startNode = startButton;
const stopNode = stopButton;
const refreshNode = refreshButton;
const clearNode = clearButton;
const historyListNode = historyList;
const historyEmptyNode = historyEmpty;

let watchId: number | null = null;
let latestState: AlarmState | null = null;
let arrivalSent = false;
let radiusDebounce: number | null = null;

type SwResponse = {
  ok?: boolean;
  skipped?: boolean;
  error?: string;
  state?: AlarmState;
  history?: AlarmHistoryEntry[];
};

async function setSessionState(nextState: AlarmState): Promise<void> {
  await chrome.storage.session.set({ alarmState: nextState });
}

async function patchSessionState(
  updater: (current: AlarmState) => AlarmState
): Promise<AlarmState | null> {
  if (!latestState) {
    return null;
  }
  const nextState = updater(latestState);
  latestState = nextState;
  await setSessionState(nextState);
  renderState(nextState);
  return nextState;
}

function formatArrivedAt(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

function renderHistory(history: AlarmHistoryEntry[]): void {
  historyListNode.textContent = "";
  const hasItems = history.length > 0;
  historyEmptyNode.classList.toggle("history-hint--hidden", hasItems);

  for (const entry of history) {
    const li = document.createElement("li");
    li.className = "history-item";
    const label = document.createElement("strong");
    label.textContent = entry.destination.label || "Destination";
    li.appendChild(label);
    const meta = document.createElement("span");
    meta.className = "history-meta";
    const { lat, lng } = entry.destination.coords;
    meta.textContent = `${formatArrivedAt(entry.arrivedAt)} · ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    li.appendChild(meta);
    historyListNode.appendChild(li);
  }
}

function setAccuracyBadge(accuracyMetres: number | null): void {
  if (accuracyMetres === null || !Number.isFinite(accuracyMetres)) {
    accuracyBadgeNode.textContent = "";
    accuracyBadgeNode.classList.add("accuracy-badge--hidden");
    accuracyBadgeNode.classList.remove("accuracy-badge--ok", "accuracy-badge--warn");
    return;
  }

  const rounded = Math.round(accuracyMetres);
  accuracyBadgeNode.textContent = `±${rounded} m`;
  accuracyBadgeNode.classList.remove("accuracy-badge--hidden");
  accuracyBadgeNode.classList.toggle("accuracy-badge--warn", accuracyMetres > 500);
  accuracyBadgeNode.classList.toggle("accuracy-badge--ok", accuracyMetres <= 500);
}

function updateStatePanel(state: AlarmState): void {
  if (!state.destination) {
    statePanelNode.dataset.state = "idle";
    statePillNode.textContent = "Idle";
    stateDescNode.textContent = "Open Google Maps and pick a destination.";
    return;
  }

  if (state.hasArrived) {
    statePanelNode.dataset.state = "arrived";
    statePillNode.textContent = "Arrived";
    stateDescNode.textContent = "You were notified when you entered the arrival radius.";
    return;
  }

  if (state.isActive || watchId !== null) {
    statePanelNode.dataset.state = "active";
    statePillNode.textContent = "Active";
    stateDescNode.textContent = "Monitoring your position. Keep this popup open while traveling.";
    return;
  }

  statePanelNode.dataset.state = "ready";
  statePillNode.textContent = "Ready";
  stateDescNode.textContent = "Destination is set. Tap Start monitoring when you begin traveling.";
}

function renderState(state: AlarmState): void {
  updateStatePanel(state);

  destinationNode.textContent = state.destination
    ? `${state.destination.label} (${state.destination.coords.lat.toFixed(5)}, ${state.destination.coords.lng.toFixed(5)})`
    : "No destination set yet. Open Google Maps and choose a place.";

  radiusNode.value = String(state.radiusMetres);
  radiusValueNode.textContent = String(state.radiusMetres);

  const showLiveMetrics =
    Boolean(state.destination) && (state.isActive || watchId !== null) && !state.hasArrived;
  metricsBlockNode.hidden = !showLiveMetrics;

  if (!showLiveMetrics) {
    distanceNode.textContent = "";
    setAccuracyBadge(null);
  }

  const canStart = Boolean(state.destination) && !state.hasArrived && watchId === null;
  startNode.disabled = !canStart;
  if (watchId !== null) {
    startNode.textContent = "Monitoring…";
  } else if (state.hasArrived && state.destination) {
    startNode.textContent = "Trip complete";
  } else {
    startNode.textContent = "Start monitoring";
  }

  // Stop if there is still a live watch or session thinks we are active (covers rare races after arrival).
  stopNode.disabled = watchId === null && !state.isActive;
}

async function applyRadiusToServiceWorker(radiusMetres: number): Promise<void> {
  const message: ExtensionMessage = { type: "SET_RADIUS", payload: { radiusMetres } };
  const response = (await chrome.runtime.sendMessage(message)) as SwResponse;
  if (!response?.ok || !response.state) {
    return;
  }
  latestState = response.state;
  arrivalSent = latestState.hasArrived;
  if (response.history) {
    renderHistory(response.history);
  }
  renderState(latestState);
}

function stopWatching(): void {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
}

function applyGeolocationSample(position: GeolocationPosition): void {
  if (!latestState?.destination) {
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

  metricsBlockNode.hidden = false;
  distanceNode.textContent = `Distance: ${Math.round(
    distanceMetres
  )} m · arrival within ${Math.round(radiusMetres)} m`;
  setAccuracyBadge(accuracyMetres);
  errorNode.textContent = "";

  if (distanceMetres <= radiusMetres && !latestState.hasArrived && !arrivalSent) {
    arrivalSent = true;
    stopWatching();
    void (async () => {
      const message: ExtensionMessage = {
        type: "ARRIVED",
        payload: { arrivedAt: Date.now() }
      };
      const response = (await chrome.runtime.sendMessage(message)) as SwResponse;
      if (response?.ok && response.state) {
        latestState = response.state;
        if (response.history) {
          renderHistory(response.history);
        }
      } else if (response?.ok && response.skipped) {
        await fetchAndRenderState(false);
      } else {
        arrivalSent = false;
        await fetchAndRenderState(false);
      }
      if (latestState) {
        renderState(latestState);
      }
    })();
  }
}

function handleGeoError(error: GeolocationPositionError): void {
  if (error.code === error.PERMISSION_DENIED) {
    errorNode.textContent =
      "Location permission denied. If you just updated the extension, click Reload on chrome://extensions. Otherwise allow location: Chrome → Settings → Privacy and security → Site settings → Location (sites can ask), enable Windows/macOS location services, then open this popup again and tap Start monitoring.";
    void patchSessionState((state) => ({ ...state, isActive: false }));
    stopWatching();
    if (latestState) {
      renderState(latestState);
    }
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

  errorNode.textContent = "Unexpected geolocation error occurred.";
}

async function startWatchIfNeeded(): Promise<void> {
  if (!latestState?.destination || latestState.hasArrived || watchId !== null) {
    return;
  }

  if (typeof Notification !== "undefined" && Notification.permission === "default") {
    void Notification.requestPermission();
  }

  watchId = navigator.geolocation.watchPosition(applyGeolocationSample, handleGeoError, GEO_OPTIONS);
  await patchSessionState((state) => ({ ...state, isActive: true }));

  navigator.geolocation.getCurrentPosition(applyGeolocationSample, handleGeoError, GEO_OPTIONS);
}

async function fetchAndRenderState(startWatch = false): Promise<void> {
  let response: SwResponse;
  try {
    const message: ExtensionMessage = { type: "GET_STATE" };
    response = (await chrome.runtime.sendMessage(message)) as SwResponse;
  } catch {
    statePanelNode.dataset.state = "idle";
    statePillNode.textContent = "Error";
    stateDescNode.textContent = "Could not talk to the background script.";
    destinationNode.textContent = "";
    errorNode.textContent =
      "Message to the extension failed. Open chrome://extensions and click Reload, then try again.";
    return;
  }
  if (!response?.ok || !response.state) {
    statePanelNode.dataset.state = "idle";
    statePillNode.textContent = "Error";
    stateDescNode.textContent = "Could not load extension state. Try Reload on chrome://extensions.";
    destinationNode.textContent = "";
    errorNode.textContent = "Unable to reach the background service. Reload the extension and try again.";
    return;
  }

  latestState = response.state;
  arrivalSent = latestState.hasArrived;

  if (response.history) {
    renderHistory(response.history);
  }

  if (latestState.isActive && watchId === null) {
    latestState = { ...latestState, isActive: false };
    await setSessionState(latestState);
  }

  renderState(latestState);

  if (!latestState.destination || latestState.hasArrived) {
    stopWatching();
    return;
  }

  if (startWatch) {
    void startWatchIfNeeded();
  }
}

refreshNode.addEventListener("click", () => {
  errorNode.textContent = "";
  void fetchAndRenderState(false);
});

stopNode.addEventListener("click", () => {
  errorNode.textContent = "";
  stopWatching();
  void patchSessionState((s) => ({ ...s, isActive: false }));
});

clearNode.addEventListener("click", () => {
  errorNode.textContent = "";
  void (async () => {
    let response: SwResponse;
    try {
      response = (await chrome.runtime.sendMessage({
        type: "CLEAR_ALARM"
      } as ExtensionMessage)) as SwResponse;
    } catch {
      errorNode.textContent =
        "Could not reach the background script. Reload the extension on chrome://extensions.";
      return;
    }
    if (response?.ok && response.state) {
      latestState = response.state;
      arrivalSent = false;
      stopWatching();
      if (response.history) {
        renderHistory(response.history);
      }
      renderState(latestState);
    } else {
      errorNode.textContent =
        (response as { error?: string })?.error ?? "Clear alarm failed. Try reloading the extension.";
    }
  })();
});

startNode.addEventListener("click", () => {
  errorNode.textContent = "";
  void (async () => {
    if (!latestState) {
      await fetchAndRenderState(false);
    }
    if (!latestState?.destination) {
      errorNode.textContent = "Set a destination in Google Maps first, then open this popup again.";
      return;
    }
    if (latestState.hasArrived) {
      errorNode.textContent =
        "This trip is already complete. Tap Clear for a new trip, or pick another place in Maps and Refresh.";
      return;
    }
    if (watchId !== null) {
      return;
    }
    await startWatchIfNeeded();
  })();
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
    void applyRadiusToServiceWorker(value);
  }, 100);
});

window.addEventListener("beforeunload", () => {
  stopWatching();
  void patchSessionState((state) => ({ ...state, isActive: false }));
});

void fetchAndRenderState(false);
