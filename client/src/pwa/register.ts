// Registers the service worker at /sw.js once the page has finished
// loading, so the SW install doesn't compete with the initial render.
//
// No-op when the browser doesn't support service workers (old iOS) or
// when we're running on http:// (browsers refuse to register SWs on
// non-secure origins except localhost). Failures log and are ignored —
// the game boots fine without a SW; the user just loses the offline
// cache + "install to home screen" affordance.

export function registerServiceWorker(): void {
  if (typeof window === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;
  // Vite dev server serves /sw.js only via publicDir on full builds;
  // in dev mode we'd get a 404 which spams the console. Skip unless
  // we're on an HTTPS deploy or localhost.
  const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const isSecure = location.protocol === 'https:';
  if (!isLocal && !isSecure) return;

  // Wait for load so SW install doesn't compete with boot fetches.
  const register = (): void => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .catch((err) => {
        console.warn('service worker registration failed', err);
      });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}
