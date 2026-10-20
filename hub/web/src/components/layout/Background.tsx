/** Drifting blurred mint blobs + 2% noise. Static under prefers-reduced-motion (CSS). */
export function Background() {
  return (
    <div className="bg-stage" aria-hidden>
      <div className="bg-blob bg-blob-1" />
      <div className="bg-blob bg-blob-2" />
      <div className="bg-blob bg-blob-3" />
      <div className="bg-noise" />
    </div>
  );
}
