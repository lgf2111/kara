export function App() {
  return (
    <main className="shell">
      <h1>Kara</h1>
      <p className="tagline">Upload a song you own. Get a KTV room.</p>

      <section>
        <h2>Status</h2>
        <p>
          Foundation only. There is no ingest, separation, lyrics or player yet, and nothing on this
          page processes audio.
        </p>
        <p>
          Cross-origin isolation: <strong>{crossOriginIsolated ? 'on' : 'off'}</strong>
        </p>
      </section>

      <section>
        <h2>Ground rules</h2>
        <ul>
          <li>Upload only. No link import and no downloader, by design.</li>
          <li>Your file is processed in this browser and never uploaded.</li>
          <li>What you share with a friend holds timings and settings, never audio.</li>
        </ul>
      </section>
    </main>
  );
}
