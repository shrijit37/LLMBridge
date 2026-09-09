import "./proxy-scene.css";

/**
 * Local proxy card background: snowy mountain + sunset.
 * `running` is true: sun rises behind ridge, snow peaks glowing warm; `running` is false: sun sets behind ridge.
 * `dark` switches ambient elements by theme: dark shows stars, light shows clouds (colors overridden by CSS .dark).
 * Pure display, does not receive pointer events; respects prefers-reduced-motion (see proxy-scene.css).
 */
export function ProxyScene({
  running,
  dark = false,
}: {
  running: boolean;
  dark?: boolean;
}) {
  return (
    <div aria-hidden className={running ? "proxy-scene running" : "proxy-scene"}>
      <div className="glow" />
      <div className="sun" />
      {dark ? (
        <div className="stars" />
      ) : (
        <>
          <div className="cloud" />
          <div className="cloud cloud-1" />
        </>
      )}
      <div className="range range-far" />
      <div className="range range-mid" />
      <div className="range range-near" />
    </div>
  );
}
