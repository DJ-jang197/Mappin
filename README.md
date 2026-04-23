# Mappin'

Mappin' is a location-based arrival alarm with two user surfaces:

- **Chrome Extension (MV3)** for desktop Google Maps.
- **Web App (mobile + desktop)** for real-world travel workflows.

Set a destination, choose an arrival radius, and get notified (with alarm + vibration where supported) when you enter that range.

## Why two surfaces?

- **Extension** is best for desktop Maps integration (`google.com/maps` tab parsing + popup controls).
- **Web app** is best for phones (copy a Maps link, paste, start monitoring).

Most users on mobile should use the web app.

## Features

- Parses coordinates from Google Maps links (`@lat,lng`, `?q=lat,lng`, `!3d...!4d...`) plus desktop DOM fallback.
- Arrival detection via Haversine distance.
- Configurable radius (`50m` to `2000m`).
- Alarm loop with:
  - sound,
  - vibration (supported devices),
  - stop/complete controls.
- Recent arrival history (last 5).
- State panel with Idle / Ready / Active / Arrived.
- Refresh / Stop / Clear controls.

## Project structure

- `src/` — extension + shared TS source
  - `popup.ts` / `popup.html` — extension UI + monitoring loop
  - `background.ts` — extension state, notifications, message handling
  - `content.ts` — Google Maps page parsing bridge
  - `webApp.ts` — web app runtime
  - `utils/` — parsing, math, alarm/vibration helpers, types
- `web/` — static web shell files (`index.html`, `manifest.webmanifest`)
- `dist/` — build output (load this into Chrome for extension)

## Quick start

### 1) Install and build

```bash
npm install
npm run build
```

### 2) Load extension (desktop Chrome)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select your repo `dist` folder

## Web app usage

After build, use either:

- `dist/web/` as static files for hosting, or
- local preview:

```bash
npx --yes serve dist/web -p 4173
```

Open: `http://localhost:4173/`

### Mobile flow

1. In Google Maps app: **Share -> Copy link**
2. Open Mappin' web app in browser
3. Paste link, load destination
4. Set radius
5. Tap **Start monitoring**
6. Allow location + notifications when prompted

## Controls

- **Start monitoring**: begins GPS watch.
- **Stop**: stops live GPS watch, keeps destination.
- **Refresh**: reloads latest state from storage.
- **Clear**: removes current destination/trip state (history kept).
- **Stop alarm**: silences active alarm loop.
- **Complete**: acknowledges arrival and resets arrived state for re-monitoring.

## Data & storage

- Extension:
  - `chrome.storage.sync` — radius
  - `chrome.storage.session` — current alarm state
  - `chrome.storage.local` — recent arrival history
- Web app:
  - `localStorage` for equivalent state/history/radius

No backend or paid Maps API is required.

## Security hardening currently included

- Runtime message rate limiting in extension background.
- Sender trust checks for privileged message types.
- Payload validation for destination and arrival events.
- Coordinate range validation and safe text rendering via `textContent`.

## Known limitations

- Extension monitoring runs in popup context; closing popup stops extension-side watch.
- Mobile browser behavior for background geolocation/notifications/vibration varies by OS/browser.
- Some Maps links without coordinates cannot be resolved unless desktop DOM fallback is available.

## Development scripts

```bash
npm run build
npm run dev
npm run test
```

## Troubleshooting

### Extension shows permission denied immediately

Ensure:

- `manifest.json` includes `"geolocation"` permission.
- Extension was reloaded after permission changes.
- OS and browser location permissions are enabled.

### Web app not updating after changes

- Re-run `npm run build`
- Hard refresh browser (`Ctrl+Shift+R`)
- If serving static files, restart your local server

---

If you plan to publish publicly, host `dist/web` over HTTPS for best location/notification compatibility on mobile.
