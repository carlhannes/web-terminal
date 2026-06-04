import { useEffect, useState } from "react";

// Single source of truth for "treat this as a touch/narrow device". Mirrored verbatim
// by the .touch-visible @media rule in styles.css — keep the two in sync. 640px = sm.
export const MOBILE_MQ = "(pointer: coarse), (max-width: 640px)";

// True when the viewport is coarse-pointer OR narrow. Drives the mobile single-pane
// view, accessory key bar, and touch-visible controls. Safe to call from the /app route
// (ssr: false), so window/matchMedia exist on mount.
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_MQ);
    const update = () => setIsMobile(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);

  return isMobile;
}
