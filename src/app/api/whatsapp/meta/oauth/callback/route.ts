/**
 * Valid OAuth Redirect URI registered in the Meta App Dashboard.
 *
 * The normal Embedded Signup v4 flow exchanges the `code` via `FB.login`
 * (JS SDK popup) without ever navigating here. This route only gets hit if
 * the popup is blocked and the browser falls back to a full-page redirect,
 * or if a Meta reviewer navigates to the URI manually — so it must return
 * 200 instead of 404.
 */
export async function GET() {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WhatsApp connection complete</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 40px; color: #1f2933; text-align: center; }
  </style>
</head>
<body>
  <main>
    <h1>You can close this window</h1>
    <p>The WhatsApp connection process finished in this tab. Return to the original tab to continue.</p>
  </main>
  <script>
    if (window.opener) {
      window.opener.postMessage({ type: "META_EMBEDDED_SIGNUP_REDIRECT" }, "*");
    }
  </script>
</body>
</html>`,
    {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
      },
    }
  )
}
