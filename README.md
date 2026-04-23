# Location Alarm (Chrome Extension + Web)

Location Alarm helps you set a destination from Google Maps and get notified when you arrive within a radius.

- **Chrome extension (MV3):** runs on `https://www.google.com/maps/*`, reads URL/DOM in-page, uses the popup for geolocation (manifest includes the `geolocation` permission required by Chrome for popup `navigator.geolocation`).
- **Web app:** works in any modern mobile or desktop browser. You **paste a Google Maps URL** (coordinates must appear in the link), then start monitoring. No Chrome APIs; state is stored in `localStorage` on that origin.

## Mobile & the Google Maps app

**Most people use the official Google Maps app on their phone.** That app is separate from the Chrome browser. This project respects that reality in two different ways:

### What the Chrome extension can (and cannot) do on a phone

- The **extension** is built for **desktop Chrome** (where you can install it from `chrome://extensions` and use it on `https://www.google.com/maps/` in a normal tab).
- **Phone Chrome** and **Safari** do **not** offer the same “install this MV3 extension and run it everywhere” experience as desktop. In practice, **recruiters and friends testing on a phone will not use the extension inside the native Maps app**—that app never loads your extension code.
- So for mobile, treat the **extension as the desktop story** (“I’m in Maps in Chrome on my laptop”).

### How mobile users are supposed to use Location Alarm

Use the **web app** (files under `dist/web/` after a build, or your hosted site):

1. Pick a place in the **Google Maps app** (or any Maps client that lets you copy a link).
2. **Share → Copy link** (wording may vary slightly by platform).
3. Open the **Location Alarm web app** in **Safari, Chrome, or another mobile browser** (not inside the Maps app).
4. **Paste** the link, load the destination, then **Start monitoring** and allow **location** (and notifications if you want) **for that website**.

You are switching between two apps on purpose: **Maps** (pick place, copy link) → **browser** (alarm + GPS). That matches the rule of **no paid Maps APIs** and **no code running inside Google’s native app**.

### Links from the Maps app

- Many shared links include **`@latitude,longitude`** or **`?q=lat,lng`**—those work well with the web app’s parser.
- If the pasted link is **only a place name** with no coordinates in the URL, the web app may not be able to resolve it (the extension on **desktop** can sometimes use a DOM fallback on the Maps **website**; the web app cannot read the Maps app’s screen).

## Milestone Status

- M1: done (scaffold/build/load path working)
- M2: done (parser + tests implemented)
- M3: done (Haversine + popup `watchPosition`, arrival flow, notifications icon, GPS edge cases, already-at-destination)
- M4: done (popup three-state panel, GPS accuracy badge, error banner, recent arrivals list, Clear alarm)

## Build and Load

1. Install deps: `npm install`
2. Build: `npm run build`
3. Open `chrome://extensions`
4. Enable **Developer mode**
5. Click **Load unpacked**
6. Select: `C:\Code_Related_Works\VS_Code_Personal\Mappin\Mappin\dist`

## Web app (mobile + desktop)

After `npm run build`, static files are emitted under `dist/web/`:

- `dist/web/index.html` — open in a browser (or host the `dist/web` folder on any static host).
- `dist/web/webApp.js` — bundled application logic (loaded by `index.html`).
- `dist/web/manifest.webmanifest` — minimal PWA manifest (`Add to Home Screen` support varies by browser; you can add icons later).

### Mobile flow

1. In the Google Maps app (or mobile browser), open a place and use **Share** → **Copy link**.
2. Open the Location Alarm web app in your phone browser.
3. Paste the URL. If the link does **not** contain `@lat,lng` or `?q=lat,lng` with numbers, parsing will fail — open the place until the URL includes coordinates, or use the **Chrome extension** on desktop for DOM fallback.
4. Optional: set a **Label**.
5. Tap **Load destination from URL**, then **Start monitoring** and allow location + notifications when prompted.

### Local preview

From the repo root, after a build:

```bash
npx --yes serve dist -p 4173
```

Then open `http://localhost:4173/web/` (note the `/web/` path).

## Manual Test Checklist (M1-M2)

Use this script during local QA and demo recording.

### 0) Pre-flight

- [ ] `npm run build` succeeds
- [ ] Extension loads from `dist` with no red errors in `chrome://extensions`
- [ ] Service worker inspect window opens without runtime exceptions

### 1) Open consoles

- [ ] On Google Maps tab, open DevTools (`F12` or `Ctrl+Shift+I`)
- [ ] Select **Console** tab
- [ ] In console, run `window.location.href` and verify URL starts with `https://www.google.com/maps`

### 2) URL parsing: standard map view

- [ ] Visit `https://www.google.com/maps/@43.4723,-80.5449,14z`
- [ ] Confirm console log indicates destination sent
- [ ] Open popup and click refresh: destination appears

### 3) URL parsing: coordinate query

- [ ] Visit `https://www.google.com/maps?q=43.4723,-80.5449`
- [ ] Confirm destination is extracted and popup displays it

### 4) URL parsing: place-name query + DOM fallback

- [ ] Visit `https://www.google.com/maps?q=University+of+Waterloo`
- [ ] Wait for page content to settle
- [ ] Confirm destination still resolves (meta fallback path)

### 5) Graceful failure: directions without coords

- [ ] Visit `https://www.google.com/maps/dir/Home/Work`
- [ ] Confirm warning log appears (no crash)
- [ ] Popup remains idle/no destination

### 6) Graceful failure: Street View

- [ ] Open a Street View URL or switch to Street View
- [ ] Confirm parse is skipped with warning
- [ ] Confirm no destination update and no uncaught errors

### 7) Multi-tab behavior

- [ ] Open two Maps tabs with different destinations
- [ ] Trigger parse in tab A, then tab B
- [ ] Confirm most recent destination (tab B) is what popup shows

## Manual Test Checklist (M3)

### 1) Haversine sanity

- [ ] Run `npm run test` and confirm `haversine.test.ts` passes
- [ ] Confirm Toronto -> Waterloo check is around 94km

### 2) Popup watch activation

- [ ] Set destination from Google Maps
- [ ] Open popup: it should **not** request location until you tap **Start monitoring** (Chrome needs a user gesture)
- [ ] Tap **Start monitoring** and allow the location prompt if shown; status becomes `ACTIVE`
- [ ] Use the **Arrival radius** slider (50m–2km); confirm the label updates and `chrome.storage.sync` stores `radiusMetres`
- [ ] Confirm distance line shows `arrival ≤ Xm` matching the slider
- [ ] Confirm distance and accuracy text update while popup stays open

### 3) Permission denied handling

- [ ] Block location permission for the extension popup
- [ ] Reopen popup
- [ ] Confirm clear permission-denied error and no active watch

### 4) GPS loss handling

- [ ] Simulate poor/unstable location source
- [ ] Confirm warning appears for timeout/position unavailable
- [ ] Confirm popup does not crash and keeps trying

### 5) Arrival notification and duplicate guard

- [ ] Force location within radius of destination
- [ ] Confirm one arrival notification appears
- [ ] Move away and re-enter radius
- [ ] Confirm notification does not fire repeatedly for the same destination

### 5b) Already at destination

- [ ] Set destination to your current location (or temporarily set a huge radius), tap **Start monitoring**
- [ ] Confirm arrival triggers promptly (immediate `getCurrentPosition` + watch) without needing to move

### 6) Local arrival history

- [ ] Trigger arrivals for more than 5 destinations
- [ ] In service worker console, run `chrome.storage.local.get("alarmHistory")`
- [ ] Confirm only latest 5 entries are retained
- [ ] Confirm the popup **Recent arrivals** list matches (newest first)

## Manual Test Checklist (M4 — popup polish)

### 1) Three-state panel

- [ ] No destination: panel shows **Idle** (neutral styling) and destination hint
- [ ] Destination set, monitoring off: **Ready** (warm styling)
- [ ] After **Start monitoring**: **Active** (blue styling) while the watch runs
- [ ] After arrival: **Arrived** (green styling) and live metrics hide

### 2) GPS accuracy badge

- [ ] While **Active**, badge shows **±Xm**; at **>500 m** accuracy it uses the warning (red) style

### 3) Error banner

- [ ] Deny location (or break GPS): a visible red error banner appears with guidance text

### 4) Clear alarm

- [ ] Tap **Clear**: destination clears, state returns to **Idle**, monitoring stops
- [ ] **Recent arrivals** list is unchanged (history is separate from current alarm)

### 4b) Stop vs Refresh vs Clear

- **Stop** — ends the live GPS watch and sets the trip to **Ready**; the destination from Maps is still stored.
- **Refresh** — asks the background for the latest `chrome.storage.session` / sync state (e.g. after you changed place in another Maps tab).
- **Clear** — clears the current alarm session (no destination, not arrived); radius and **Recent arrivals** stay.

### 5) Demo video (portfolio)

- [ ] Record a short walkthrough (install → Maps → popup → monitoring → arrival). Script talking points are in your original project brief.

## Troubleshooting

### `PERMISSION_DENIED` right after “Start monitoring” (extension popup)

Chrome’s extension docs require declaring **`"geolocation"`** in `manifest.json` → `permissions` when you use **`navigator.geolocation` in the popup**. If it is missing, Chrome can fail **immediately** with `PERMISSION_DENIED` (same code as a real denial), often **without** a useful prompt — which looks like a settings problem but is actually the manifest.

This project includes `"geolocation"` alongside `"storage"` and `"notifications"`. After changing permissions, run `npm run build` and **reload** the extension (or remove and **Load unpacked** again on `dist`).

You may still see a generic validator note about the `geolocation` permission; for popup geolocation, declaring it is what [Chrome’s geolocation guide](https://developer.chrome.com/docs/extensions/how-to/web-platform/geolocation) describes.

Also check: OS location services on, and Chrome **Settings → Privacy and security → Site settings → Location** allows prompts. For the extension origin, open `chrome://extensions`, copy the extension ID, and if needed reset location for that `chrome-extension://` origin under site settings.

## Notes

- Geolocation watch runs in popup context for MV3 reliability.
- Background monitoring stops when popup closes (MVP limitation).
- Google Maps in iframe/embedded surfaces may not execute content scripts depending on host page policies.
- This MVP intentionally avoids paid Maps APIs and external geolocation services.
- `assets/icon-128.png` is a tiny placeholder PNG copied to `dist/icons/` for `chrome.notifications`; swap it for a crisp 128×128 marketing icon when polishing for portfolio.
