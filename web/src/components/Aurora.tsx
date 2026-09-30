/** Fixed aurora gradient background + noise overlay. Render once at app root. */
export function Aurora() {
  return (
    <div className="aurora" aria-hidden>
      <div className="aurora-blob aurora-a" />
      <div className="aurora-blob aurora-b" />
      <div className="aurora-blob aurora-c" />
      <div className="aurora-noise" />
    </div>
  );
}
