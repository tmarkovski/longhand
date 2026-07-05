import { useEffect, useState } from "react";
import App from "./App.js";
import BuildPage from "./BuildPage.js";

/**
 * Two-page hash router: "" is the studio, "#/build" the developer guide.
 * Hash routing keeps GitHub Pages happy (no 404 rewrites). The studio
 * stays mounted (hidden) while the guide is open: the whole point of the
 * guide link next to "use in your app" is carrying a dialed-in take into
 * an app, so navigating there must not destroy that take (or the loaded
 * models and warm worker).
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
  return (
    <>
      <div hidden={onBuild}>
        <App />
      </div>
      {onBuild && <BuildPage />}
    </>
  );
}
