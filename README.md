# Lightmap

[Lightmap](https://hereforyoumap.com) is a minimalist real-time connection map.
People can place one of four brief sentiments on an approximate part of the
world map. After using all four during their current local calendar day, they
can leave one small “Here for you” dot for the next 24 hours. Saved button
progress resets at local midnight, whether or not they used “Here for you.”

The project is inspired by Ho'oponopono and *The Pitt*. Its purpose is modest:
to offer a quiet reminder that someone else is out there.

## How it works

- The browser converts a location to a four-character geohash before sending
  it. This locates a dot to a cell measuring tens of kilometres, not a precise
  coordinate.
- New public map records contain a geohash, timestamp, and display type/color.
  They do not contain an account, device, or advertising identifier.
- Firebase Anonymous Authentication controls database access. Realtime Database
  rules validate direct client writes. Button cooldowns are user-experience
  controls rather than a security boundary.
- Ephemeral dots display for 10 seconds; “Here for you” dots display for 24
  hours. An hourly Cloud Function deletes ephemeral records after one hour and
  daily-dot records after 25 hours.
- A global circuit breaker caps the site at 25,000 button presses per UTC day.
  Each press writes its message and a shared counter increment in one atomic
  database update, so the cap adds no extra network round trip. At the cap,
  the buttons disappear and writes are rejected by the database rules until
  the next UTC day; the map itself stays visible.
- Listeners are bounded so one visitor downloads at most the displayable
  dots: ephemeral messages are queried from the last few seconds only, and
  daily dots are limited to the newest 2,000.

The client uses plain HTML, CSS, and JavaScript with D3, TopoJSON, and Firebase.
There is no frontend build step.

## Local setup

Requirements: Node.js 22+, npm, Java, and a Firebase project.

1. Clone the repository.
2. Enable Anonymous Authentication and Realtime Database in Firebase.
3. Copy `public/config.template.js` to `public/config.js` and fill in the web app
   configuration from Firebase Console → Project settings.
4. Set your Firebase project alias in `.firebaserc`.
5. Install the pinned Firebase CLI and function dependencies, then verify the
   project:

   ```sh
   npm ci
   npm ci --prefix functions
   npm run check
   npm run test:rules
   ```

6. Start local hosting:

   ```sh
   npm run firebase -- emulators:start --only hosting
   ```

Opening `public/index.html` directly will not work reliably because browsers
restrict JavaScript modules loaded from `file://` URLs.

To rerun only the database rules behavior tests (including the daily cap)
against the Realtime Database emulator:

```sh
npm run test:rules
```

## Daily write cap

`database.rules.json` maintains a single counter at `stats/daily`
(`{day, count, messageId, messagePath}`). A message write is only valid when
the same atomic update increments today's counter by exactly one and names
that exact newly created record. This one-to-one correlation prevents a
crafted batch from sharing a counter slot across several records, prevents
counter-only writes, and prevents clients from deleting the counter. The
counter can reset to one only on the first press of a new UTC day. The cap
value lives in two places that must match: the `count` validation in
`database.rules.json` and `DAILY_GLOBAL_CAP` in `public/main.js` (a unit test
enforces this).

The 25,000 value is derived from Realtime Database pricing ($1 per GB
downloaded, $5 per GB-month stored, with no free allowance on the Blaze
plan). Records are ~0.15 KB on the wire and hourly cleanup keeps storage
negligible, so the dominant cost is realtime fan-out: presses × concurrent
viewers × record size. A month of maximally scripted abuse against a quiet
site stays around $1; a genuinely viral day is dominated instead by each
visitor syncing the day's dots, which the query bounds above cap at roughly
a quarter-megabyte per visit. Adjust the cap by changing the value in
`database.rules.json` and `public/main.js` together.

## Deployment

Review `database.rules.json` for your project, then deploy the cleanup Function,
Hosting assets, and Database Rules:

```sh
npm run firebase -- deploy --only functions
npm run firebase -- deploy --only hosting
npm run firebase -- deploy --only database
```

Deploy Hosting and Database Rules back to back: clients served before the
rules land cannot write the daily counter, and clients cached from before
this version cannot satisfy the new rules until they refresh. At low traffic
this brief window is harmless, but it is worth knowing about.

The Hosting configuration publishes only `public/`; source, tests, functions,
and local tooling are not served as website assets. It also adds a restrictive
Content Security Policy and related browser security headers.

Before promoting a public instance, register the web app with Firebase App
Check using reCAPTCHA Enterprise, add the public site key as `appCheckSiteKey`
in `public/config.js`, monitor App Check metrics, and then enforce App Check for
Realtime Database in the console. App Check is the primary additional control
against inexpensive scripted writes from outside the web app.

For testing, use the Firebase Emulator Suite or a non-production preview/staging
channel first. Only enable App Check enforcement in production after the app has
been verified to work with anonymous auth and the intended Firebase rules.

## Repository status

The web app is maintained and covered by lightweight unit, configuration,
function, lint, and dependency checks in GitHub Actions.

## Privacy and limitations

A four-character geohash is approximate, but it is still location-derived data.
Do not describe it as fully anonymous in a formal privacy or legal sense.
Operators should disclose their Firebase processing and retention practices and
monitor usage, billing, Authentication quotas, and cleanup failures.

Firebase client configuration is normally public by design. Authorization comes
from Database Rules, IAM, and App Check—not from hiding `apiKey`. Never commit
Admin SDK keys or service-account files.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow and
[SECURITY.md](SECURITY.md) for private vulnerability reporting.

Licensed under the [MIT License](LICENSE).
