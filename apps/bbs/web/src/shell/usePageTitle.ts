import { useEffect } from "react";

export const SITE_TITLE = "RM 文库";

/**
 * Screens set the title with the same value the server injected (`src/spa/head.ts`),
 * so the first paint of `/articles/:id` keeps the injected `<title>` and client
 * navigations update it. `null` is the site default. The root never touches it.
 */
export function usePageTitle(title: string | null): void {
  useEffect(() => {
    document.title = title ? `${title} · ${SITE_TITLE}` : SITE_TITLE;
  }, [title]);
}
