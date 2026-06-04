import { useEffect, useState } from "react";

// The visible height of the page, tracking the visual viewport. On mobile the soft
// keyboard shrinks window.visualViewport.height while the layout viewport (100dvh) stays
// tall; binding the app container to this value keeps the terminal above the keyboard.
// On desktop this equals the window height, so it is a no-op there.
export function useViewportHeight(): number | undefined {
  const [height, setHeight] = useState<number | undefined>(undefined);

  useEffect(() => {
    const vv = window.visualViewport;
    const update = () => setHeight(vv?.height ?? window.innerHeight);
    update();
    if (vv) {
      vv.addEventListener("resize", update);
      vv.addEventListener("scroll", update);
    }
    window.addEventListener("resize", update);
    return () => {
      if (vv) {
        vv.removeEventListener("resize", update);
        vv.removeEventListener("scroll", update);
      }
      window.removeEventListener("resize", update);
    };
  }, []);

  return height;
}
