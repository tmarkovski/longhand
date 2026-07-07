import { lazy, Suspense, useEffect, useState } from "react";
import App from "./App.js";
import BuildPage from "./BuildPage.js";

// Lazy: the gallery inlines its prerendered vignette SVGs into the
// bundle, and none of that belongs in the studio's first paint.
const UsesPage = lazy(() => import("./UsesPage.js"));

/**
 * Three-page hash router: "" is the studio, "#/build" the developer
 * guide, "#/uses" the use-case gallery. Hash routing keeps GitHub Pages
 * happy (no 404 rewrites). The studio stays mounted (hidden) while the
 * other pages are open: the whole point of the guide link next to "use
 * in your app" is carrying a dialed-in take into an app, so navigating
 * there must not destroy that take (or the loaded models and warm
 * worker) — and the gallery's "remix in studio" links write into that
 * same warm studio.
 */
export default function Root() {
  const [hash, setHash] = useState(() => window.location.hash);

  useEffect(() => {
    const onChange = () => {
      setHash(window.location.hash);
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  const onBuild = hash.startsWith("#/build");
  const onUses = hash.startsWith("#/uses");
  return (
    <>
      <div hidden={onBuild || onUses}>
        <App />
      </div>
      {onBuild && <BuildPage />}
      {onUses && (
        <Suspense fallback={null}>
          <UsesPage />
        </Suspense>
      )}
    </>
  );
}
