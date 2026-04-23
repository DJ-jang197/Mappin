import { AlarmHistoryEntry, AlarmState, ExtensionMessage } from "./utils/types";

const DEFAULT_STATE: AlarmState = {
  destination: null,
  isActive: false,
  hasArrived: false,
  radiusMetres: 200
};

const RADIUS_MIN_M = 50;
const RADIUS_MAX_M = 2_000;
const RADIUS_DEFAULT_M = 200;

async function getSessionState(): Promise<AlarmState> {
  const result = await chrome.storage.session.get("alarmState");
  return (result.alarmState as AlarmState | undefined) ?? DEFAULT_STATE;
}

async function getRadiusFromSync(): Promise<number> {
  const result = await chrome.storage.sync.get("radiusMetres");
  const v = result.radiusMetres;
  if (typeof v === "number" && Number.isFinite(v) && v >= RADIUS_MIN_M && v <= RADIUS_MAX_M) {
    return Math.round(v);
  }
  return RADIUS_DEFAULT_M;
}

async function getFullState(): Promise<AlarmState> {
  const session = await getSessionState();
  const radius = await getRadiusFromSync();
  return { ...session, radiusMetres: radius };
}

async function setSessionState(next: AlarmState): Promise<void> {
  await chrome.storage.session.set({ alarmState: next });
}

async function appendArrivalHistory(entry: AlarmHistoryEntry): Promise<void> {
  const result = await chrome.storage.local.get("alarmHistory");
  const current = (result.alarmHistory as AlarmHistoryEntry[] | undefined) ?? [];
  const next = [entry, ...current].slice(0, 5);
  await chrome.storage.local.set({ alarmHistory: next });
}

async function getAlarmHistory(): Promise<AlarmHistoryEntry[]> {
  const result = await chrome.storage.local.get("alarmHistory");
  const raw = result.alarmHistory as AlarmHistoryEntry[] | undefined;
  return Array.isArray(raw) ? raw : [];
}

const NOTIFICATION_ICON_URL = chrome.runtime.getURL("icons/icon-128.png");

function showArrivalNotification(label: string): void {
  chrome.notifications.getPermissionLevel((level) => {
    if (level === "denied") {
      console.warn("[location-alarm] Notifications denied at OS/browser level; arrival still recorded.");
      return;
    }

    chrome.notifications.create(
      {
        type: "basic",
        iconUrl: NOTIFICATION_ICON_URL,
        title: "Mappin' — you've arrived",
        message: `You arrived at ${label || "your destination"}.`,
        priority: 2,
        silent: false
      },
      () => {
        if (chrome.runtime.lastError) {
          console.warn("[location-alarm] Notification failed:", chrome.runtime.lastError.message);
        }
      }
    );
  });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const sync = await chrome.storage.sync.get("radiusMetres");
  if (typeof sync.radiusMetres !== "number") {
    await chrome.storage.sync.set({ radiusMetres: RADIUS_DEFAULT_M });
  }
  if (details.reason === "install") {
    const radius = await getRadiusFromSync();
    await setSessionState({ ...DEFAULT_STATE, radiusMetres: radius });
  }
});

type MessageResponse = {
  ok: boolean;
  error?: string;
  skipped?: boolean;
  state?: AlarmState;
  history?: AlarmHistoryEntry[];
};

type MessageType = ExtensionMessage["type"];

const RATE_LIMIT_RULES: Partial<Record<MessageType, { windowMs: number; max: number }>> = {
  SET_DESTINATION: { windowMs: 60_000, max: 30 },
  SET_RADIUS: { windowMs: 60_000, max: 40 },
  GET_STATE: { windowMs: 60_000, max: 120 },
  ARRIVED: { windowMs: 60_000, max: 20 },
  CLEAR_ALARM: { windowMs: 60_000, max: 20 },
  ACK_ARRIVAL_COMPLETE: { windowMs: 60_000, max: 20 }
};

const rateLimitBuckets = new Map<string, number[]>();

const MAX_LABEL_LENGTH = 200;

function isExtensionUrl(url: string | undefined): boolean {
  return Boolean(url && url.startsWith(`chrome-extension://${chrome.runtime.id}/`));
}

function isMapsUrl(url: string | undefined): boolean {
  return Boolean(url && url.startsWith("https://www.google.com/maps/"));
}

function isValidCoords(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === "number" &&
    Number.isFinite(lat) &&
    lat >= -90 &&
    lat <= 90 &&
    typeof lng === "number" &&
    Number.isFinite(lng) &&
    lng >= -180 &&
    lng <= 180
  );
}

function isValidDestinationPayload(payload: unknown): payload is AlarmState["destination"] {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const candidate = payload as {
    coords?: { lat?: unknown; lng?: unknown };
    label?: unknown;
    setAt?: unknown;
  };
  if (!candidate.coords || !isValidCoords(candidate.coords.lat, candidate.coords.lng)) {
    return false;
  }
  if (typeof candidate.label !== "string" || candidate.label.length > MAX_LABEL_LENGTH) {
    return false;
  }
  if (typeof candidate.setAt !== "number" || !Number.isFinite(candidate.setAt)) {
    return false;
  }
  return true;
}

function isTrustedSenderForMessage(
  message: ExtensionMessage,
  sender: chrome.runtime.MessageSender
): boolean {
  const senderUrl = sender.url ?? sender.tab?.url;
  if (!senderUrl) {
    return false;
  }

  if (message.type === "SET_DESTINATION") {
    // Only Google Maps content script should set destination.
    return isMapsUrl(senderUrl);
  }

  // Popup and extension pages own all state-mutating commands.
  return isExtensionUrl(senderUrl);
}

function buildRateLimitKey(message: ExtensionMessage, sender: chrome.runtime.MessageSender): string {
  const context = sender.tab?.id ?? sender.url ?? "unknown";
  return `${message.type}:${context}`;
}

function isRateLimited(key: string, rule: { windowMs: number; max: number }, now = Date.now()): boolean {
  const timestamps = rateLimitBuckets.get(key) ?? [];
  const fresh = timestamps.filter((ts) => now - ts < rule.windowMs);
  if (fresh.length >= rule.max) {
    rateLimitBuckets.set(key, fresh);
    return true;
  }
  fresh.push(now);
  rateLimitBuckets.set(key, fresh);
  return false;
}

async function handleExtensionMessage(message: ExtensionMessage): Promise<MessageResponse> {
  if (message.type === "SET_DESTINATION") {
    if (!isValidDestinationPayload(message.payload)) {
      return { ok: false, error: "Invalid destination payload" };
    }
    const state = await getFullState();
    await setSessionState({
      ...state,
      destination: message.payload,
      isActive: false,
      hasArrived: false
    });
    return { ok: true, state: await getFullState(), history: await getAlarmHistory() };
  }

  if (message.type === "CLEAR_ALARM") {
    const state = await getFullState();
    await setSessionState({ ...DEFAULT_STATE, radiusMetres: state.radiusMetres });
    return {
      ok: true,
      state: await getFullState(),
      history: await getAlarmHistory()
    };
  }

  if (message.type === "SET_RADIUS") {
    const raw = message.payload.radiusMetres;
    const r = Math.round(raw);
    if (!Number.isFinite(r) || r < RADIUS_MIN_M || r > RADIUS_MAX_M) {
      return { ok: false, error: "Invalid radius" };
    }
    await chrome.storage.sync.set({ radiusMetres: r });
    const session = await getSessionState();
    await setSessionState({ ...session, radiusMetres: r });
    return {
      ok: true,
      state: await getFullState(),
      history: await getAlarmHistory()
    };
  }

  if (message.type === "ARRIVED") {
    const arrivedAt = message.payload.arrivedAt;
    if (typeof arrivedAt !== "number" || !Number.isFinite(arrivedAt)) {
      return { ok: false, error: "Invalid arrival timestamp" };
    }
    const state = await getFullState();
    if (!state.destination || state.hasArrived) {
      return {
        ok: true,
        skipped: true,
        state: await getFullState(),
        history: await getAlarmHistory()
      };
    }

    const historyEntry: AlarmHistoryEntry = {
      destination: state.destination,
      arrivedAt
    };
    await setSessionState({ ...state, hasArrived: true, isActive: false });
    await appendArrivalHistory(historyEntry);
    showArrivalNotification(state.destination.label || "your destination");
    return {
      ok: true,
      state: await getFullState(),
      history: await getAlarmHistory()
    };
  }

  if (message.type === "ACK_ARRIVAL_COMPLETE") {
    const state = await getFullState();
    if (!state.destination || !state.hasArrived) {
      return {
        ok: true,
        skipped: true,
        state: await getFullState(),
        history: await getAlarmHistory()
      };
    }
    await setSessionState({ ...state, hasArrived: false, isActive: false });
    return {
      ok: true,
      state: await getFullState(),
      history: await getAlarmHistory()
    };
  }

  if (message.type === "GET_STATE") {
    return {
      ok: true,
      state: await getFullState(),
      history: await getAlarmHistory()
    };
  }

  return { ok: false, error: "Unknown message type" };
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  if (!isTrustedSenderForMessage(message, sender)) {
    sendResponse({
      ok: false,
      error: "Untrusted sender for this request."
    });
    return false;
  }

  const rule = RATE_LIMIT_RULES[message.type];
  if (rule && isRateLimited(buildRateLimitKey(message, sender), rule)) {
    sendResponse({
      ok: false,
      error: "Too many requests. Please slow down and try again."
    });
    return false;
  }

  handleExtensionMessage(message)
    .then((response) => {
      sendResponse(response);
    })
    .catch((err) => {
      console.error("[location-alarm] onMessage:", err);
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : String(err)
      });
    });
  return true;
});
