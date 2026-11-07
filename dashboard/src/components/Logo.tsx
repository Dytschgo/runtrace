/** A run leaving a trace: one line that spikes, settles, and ends in the point where the run is now. */
export function Logo() {
  return (
    <span className="logo">
      <svg width="34" height="22" viewBox="0 0 34 22" fill="none" aria-hidden="true">
        <path className="logo-trace" pathLength={1} d="M1 15h5c2.4 0 2.6-11 5-11s3 15 5.4 15 2-8 4.4-8H27" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <circle className="logo-dot" cx="30.6" cy="11" r="2.4" fill="currentColor" />
      </svg>
      <span className="logo-word">runtrace</span>
    </span>
  );
}
