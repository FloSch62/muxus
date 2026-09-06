// The native preload must hydrate persisted state before any SPA modules run.
// Vite sets the entry URL after bundling; ordinary browsers have no bridge.
try {
  await window.muxusDesktopReady;
  const entry = document.querySelector('script[data-muxus-entry]').dataset.muxusEntry;
  await import(entry);
} catch (error) {
  console.error('Muxus startup failed', String(error));
  document.getElementById('root').textContent = 'Muxus could not start. Close this window and try again.';
}
