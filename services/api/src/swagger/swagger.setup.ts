import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

/**
 * The interactive API reference — Swagger UI over the whole TradeW surface.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * Every route in this service is reachable only with the right credential, and
 * there are FOUR different ones (see the security schemes below). Without a
 * generated reference, the only way to learn that `/sim/orders` needs a user
 * bearer token while `/admin/orders` needs a bearer token AND the operator
 * header is to read the guards. This page answers that question per route, and
 * lets you issue the call with the credential already attached.
 *
 * ── WHY IT IS GENERATED, NOT WRITTEN ───────────────────────────────────────
 *
 * The document is built from the Nest metadata that already exists on the
 * controllers — paths, methods, path/query parameters and DTO shapes are read
 * from the code itself, so a route added tomorrow appears here without anyone
 * remembering to document it. A hand-maintained spec would start accurate and
 * drift within a sprint, and a drifted API reference is worse than none: it is
 * confidently wrong.
 *
 * The summaries on each operation are taken from the handlers' own docstrings by
 * the `@nestjs/swagger` CLI plugin configured in nest-cli.json.
 *
 * ── TWO THINGS THAT WILL BITE WHOEVER TOUCHES THAT PLUGIN ──────────────────
 *
 * 1. It runs ONE visitor per file, chosen by filename, and returns early. Every
 *    DTO in this service is declared inside its controller file, so the two are
 *    mutually exclusive: adding `.controller.ts` to `dtoFileNameSuffix` derives
 *    DTO properties automatically but silently drops the summaries from all ~138
 *    operations. This project takes the summaries and writes `@ApiProperty` on
 *    the DTOs by hand — which is also what lets the Prisma enums be documented
 *    as real enums instead of as a bare `object`. Registering the plugin twice
 *    to get both does NOT work: each pass injects its own
 *    `const openapi = require("@nestjs/swagger")` and the output fails to parse.
 *
 * 2. `incremental: true` in tsconfig.json means TypeScript skips re-emitting
 *    files it thinks are unchanged, and a custom transformer only runs on files
 *    that are actually emitted. After changing plugin config, delete `dist/`
 *    once — otherwise the build succeeds and quietly produces a document with
 *    empty schemas.
 *
 * ── AVAILABILITY ───────────────────────────────────────────────────────────
 *
 * On outside production, off inside it, overridable either way with
 * SWAGGER_ENABLED. This mirrors `KnowledgeWorkspaceGuard`'s convention for the
 * same reason: a full map of the attack surface, including which routes are
 * unauthenticated, is not something to publish by default on a deployment that
 * serves real users.
 */

/** Mount point. Referenced by the CSP exemption in main.ts — keep them agreed. */
export const SWAGGER_PATH = 'docs';

/** Security scheme keys. Referenced by the `@ApiSecurity` decorators on the
 *  controllers, so they are constants rather than strings repeated 23 times. */
export const SECURITY = {
  /** `Authorization: Bearer <accessToken>` — AuthGuard. */
  bearer: 'bearer',
  /** `X-Admin-Token: <ADMIN_API_TOKEN>` — AdminTokenGuard / AdminGuard. */
  adminToken: 'admin-token',
  /** Ed25519 request signature — ControlGuard. Not issuable from a browser. */
  controlSignature: 'control-signature',
} as const;

/**
 * SWAGGER_ENABLED=true -> always on
 * SWAGGER_ENABLED=false -> always off
 * unset -> on outside production, off in production
 */
export function isSwaggerEnabled(): boolean {
  const flag = process.env.SWAGGER_ENABLED;
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return process.env.NODE_ENV !== 'production';
}

const DESCRIPTION = `
Interactive reference for the TradeW backend. Every route below is generated
from the running code, so what you see is what the server actually serves.

## Getting a bearer token

Most routes need a user access token. Two ways to get one:

1. **The quickest** — use the green **Log in & authorize** bar at the top of
   this page. It calls \`POST /auth/login\` for you and installs the returned
   token into every request on this page.
2. **By hand** — expand \`POST /auth/login\`, **Try it out**, send your email
   and password, copy \`accessToken\` out of the response, then click
   **Authorize** and paste it.

Either way the token is remembered across page reloads.

Access tokens are short-lived (\`ACCESS_TOKEN_TTL\`, 15 minutes by default).
When calls start coming back \`401\`, send the \`refreshToken\` you were given
to \`POST /auth/refresh\` for a fresh pair, or just log in again.

## The four credentials

A padlock on a route tells you it needs one; the lock's tooltip tells you which.

| Credential | How it is sent | Who it authorizes | Used by |
|---|---|---|---|
| **bearer** | \`Authorization: Bearer <accessToken>\` | one signed-in user | trading, portfolio, learning, discipline, notifications |
| **admin-token** | \`X-Admin-Token: <ADMIN_API_TOKEN>\` | the operator, as a role — carries no user identity | \`/entitlements/admin/*\`, \`/broker/dhan/admin/*\` |
| **bearer + admin-token** | both headers, both required | an operator who is *also* an admin user | \`/admin/*\` |
| **control-signature** | \`X-Control-*\` headers, Ed25519-signed | the Admin Control Plane | \`/control/*\` |

Routes with no padlock are genuinely public: health, plan listings, published
market data and news.

Some routes carry both a padlock and an entitlement — \`/sentinel/*\` and
\`/sentinel-intelligence/*\` additionally require the \`sentinel\` capability on
your plan, and return \`403\` with an upgrade payload without it.

## What you cannot drive from this page

\`/control/*\` is documented here for completeness but cannot be called from a
browser: each request is signed with an Ed25519 private key that only the Admin
Control Plane holds, over a canonical string covering the method, path, body
hash, timestamp and a single-use nonce. **Try it out** on those routes will
always come back \`401\`. That is the boundary working, not a bug.

Two more routes are Server-Sent Event streams — \`GET /admin/stream\` and
\`GET /admin/knowledge/stream\`. They are listed, but a long-lived stream does
not render usefully in Swagger UI; reach for \`curl\` or \`EventSource\`.
`.trim();

export function buildSwaggerDocument(app: INestApplication): OpenAPIObject {
  const builder = new DocumentBuilder()
    .setTitle('TradeW API')
    .setDescription(DESCRIPTION)
    .setVersion(process.env.npm_package_version || '0.1.0')

    // ── Credentials ────────────────────────────────────────────────────────
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'The `accessToken` from POST /auth/login or POST /auth/refresh. ' +
          'Paste the token only — Swagger UI adds the "Bearer " prefix itself.',
      },
      SECURITY.bearer,
    )
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'X-Admin-Token',
        description:
          'The operator shared secret, ADMIN_API_TOKEN. Authorizes "the operator" as a ' +
          'role and carries no user identity — anything that must act as a specific ' +
          'user needs the bearer token instead. Unset on the server disables every ' +
          'route that requires it, rather than opening them.',
      },
      SECURITY.adminToken,
    )
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'X-Control-Signature',
        description:
          'Ed25519 signature from the Admin Control Plane, accompanied by the other ' +
          'X-Control-* headers. Documented for completeness — it cannot be produced ' +
          'here, because TradeW Core holds only the public key.',
      },
      SECURITY.controlSignature,
    )

    // ── Where the API lives ────────────────────────────────────────────────
    // Relative, so "Try it out" targets whatever origin served this page and
    // keeps working through a tunnel or a port change without an edit here.
    .addServer('/', 'This server — the API addressed directly')
    .addServer('/api', 'Behind the web app proxy (production NEXT_PUBLIC_API_URL=/api)')

    // ── Tags, in the order the surface is best read ─────────────────────────
    .addTag('Health', 'Liveness probe. Public.')
    .addTag('Auth', 'Signup, login, token refresh, password reset, profile and preferences.')
    .addTag('Entitlements', 'Plans, the caller’s capabilities, and operator-driven subscriptions.')
    .addTag('Instruments', 'Instrument search.')
    .addTag('Market Data', 'Indian equities and indices, via the Dhan bridge.')
    .addTag('Crypto', 'Binance spot market data. Public, read-only.')
    .addTag('Forex', 'FX pairs via Twelve Data. Public, read-only.')
    .addTag('US Stocks', 'US equities via Twelve Data. Public, read-only.')
    .addTag('News', 'Market headlines across the wires. Public.')
    .addTag('Broker', 'Dhan account linking — OAuth consent, status, revocation.')
    .addTag('Discipline', 'The trader’s self-imposed daily limits and override history.')
    .addTag('Trading', 'Paper-trading OMS: orders, trades, positions, portfolio.')
    .addTag('Holdings', 'Settled CNC equity.')
    .addTag('Performance', 'P&L, portfolio value series, monthly returns, diary.')
    .addTag('Trade History', 'Filterable trade log and CSV export.')
    .addTag('Sentinel', 'The observation engine. Requires the `sentinel` entitlement.')
    .addTag('Sentinel Intelligence', 'Reasoning, workspace and the learned rule corpus.')
    .addTag('Learning', 'Course catalogue, lessons, quizzes and progress.')
    .addTag('Notifications', 'Per-user notification feed.')
    .addTag('Admin', 'Operator portal. Requires bearer + admin token.')
    .addTag('Admin Knowledge', 'The engineering knowledge vault. Feature-flagged.')
    .addTag('Control Plane', 'The Admin Control Plane boundary. Signed requests only.');

  return SwaggerModule.createDocument(app, builder.build());
}

/**
 * Convenience for the Authorize step. Swagger UI's own dialog wants a token you
 * already have, which means leaving the page to get one — so this adds a bar
 * that logs in and installs the result in place.
 *
 * Written as an injected string rather than a served asset because it is a few
 * lines of glue, and `customJsStr` keeps it in the same file as the config it
 * depends on. Everything it does is also doable by hand through the Authorize
 * button, so it degrades to "no bar" rather than to a broken page if the UI's
 * internals ever move under it — hence the defensive guards and the try/catch.
 */
const LOGIN_HELPER_JS = `
(function () {
  var BAR_ID = 'tradew-auth-bar';

  function ready(cb) {
    var tries = 0;
    var t = setInterval(function () {
      var host = document.querySelector('.swagger-ui .information-container');
      if (host && window.ui) { clearInterval(t); cb(host); }
      else if (++tries > 100) clearInterval(t);
    }, 100);
  }

  var KEY = ${JSON.stringify(SECURITY.bearer)};

  function authorize(token) {
    // authorizeWithPersistOption is what the Authorize dialog itself calls, and
    // it is the ONLY path that honours persistAuthorization — preauthorizeApiKey
    // dispatches plain \`authorize\`, which installs the token for this page view
    // and writes nothing, so a reload would silently drop it. Verified against
    // swagger-ui in the browser rather than assumed.
    try {
      var actions = window.ui && window.ui.authActions;
      if (actions && typeof actions.authorizeWithPersistOption === 'function') {
        var schema = window.ui.specSelectors.securityDefinitions().get(KEY);
        var payload = {};
        payload[KEY] = { schema: schema, value: token };
        actions.authorizeWithPersistOption(payload);
        return true;
      }
    } catch (err) {
      /* fall through to the non-persisting path below */
    }
    // Still authorizes this page view, just without surviving a reload.
    if (window.ui && typeof window.ui.preauthorizeApiKey === 'function') {
      window.ui.preauthorizeApiKey(KEY, token);
      return true;
    }
    return false;
  }

  ready(function (host) {
    if (document.getElementById(BAR_ID)) return;

    var bar = document.createElement('div');
    bar.id = BAR_ID;
    bar.style.cssText = 'margin:0 0 20px;padding:14px 16px;border:1px solid #49cc90;' +
      'border-radius:6px;background:#ecfdf3;display:flex;gap:8px;align-items:center;flex-wrap:wrap;' +
      'font-family:sans-serif;font-size:13px';

    bar.innerHTML =
      '<strong style="color:#0f5132">Log in &amp; authorize</strong>' +
      '<input id="tw-email" type="email" placeholder="email" autocomplete="username" ' +
        'style="padding:6px 8px;border:1px solid #b7dfc8;border-radius:4px;min-width:200px">' +
      '<input id="tw-pass" type="password" placeholder="password" autocomplete="current-password" ' +
        'style="padding:6px 8px;border:1px solid #b7dfc8;border-radius:4px;min-width:160px">' +
      '<button id="tw-go" type="button" ' +
        'style="padding:6px 14px;border:0;border-radius:4px;background:#49cc90;color:#fff;' +
        'font-weight:600;cursor:pointer">Authorize</button>' +
      '<span id="tw-msg" style="color:#555"></span>';

    host.appendChild(bar);

    var msg = bar.querySelector('#tw-msg');
    function say(text, colour) { msg.textContent = text; msg.style.color = colour || '#555'; }

    async function login() {
      var email = (bar.querySelector('#tw-email').value || '').trim();
      var password = bar.querySelector('#tw-pass').value || '';
      if (!email || !password) return say('Enter an email and password.', '#b02a37');

      say('Signing in…');
      try {
        var res = await fetch(window.location.origin + '/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email, password: password })
        });
        var body = await res.json().catch(function () { return {}; });

        if (!res.ok) {
          return say(res.status + ' — ' + (body.message || 'login failed'), '#b02a37');
        }
        if (!body.accessToken) {
          return say('No accessToken in the response.', '#b02a37');
        }
        if (!authorize(body.accessToken)) {
          return say('Got a token, but could not install it — use Authorize and paste it.', '#b02a37');
        }

        bar.querySelector('#tw-pass').value = '';
        say('Authorized as ' + email + '. Every request on this page now carries the token.', '#0f5132');
        if (body.refreshToken) {
          console.info('[TradeW] refreshToken for POST /auth/refresh:', body.refreshToken);
        }
      } catch (err) {
        say('Could not reach the API: ' + err, '#b02a37');
      }
    }

    bar.querySelector('#tw-go').addEventListener('click', login);
    bar.addEventListener('keydown', function (e) { if (e.key === 'Enter') login(); });
  });
})();
`.trim();

export function setupSwagger(app: INestApplication): void {
  if (!isSwaggerEnabled()) return;

  SwaggerModule.setup(SWAGGER_PATH, app, buildSwaggerDocument(app), {
    // The raw document, for client generators and for diffing the surface in CI.
    jsonDocumentUrl: `${SWAGGER_PATH}-json`,
    yamlDocumentUrl: `${SWAGGER_PATH}-yaml`,
    customSiteTitle: 'TradeW API',
    customJsStr: LOGIN_HELPER_JS,
    swaggerOptions: {
      // Without this the token is lost on every reload, which makes the page
      // tedious to actually work in.
      persistAuthorization: true,
      // 120-odd routes: collapsed is the only readable initial state.
      docExpansion: 'none',
      filter: true,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
      displayRequestDuration: true,
      tryItOutEnabled: true,
    },
  });
}
