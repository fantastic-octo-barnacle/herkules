/** The entry `index.html` loads. Runs at module top level; nothing else calls it. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { createApi } from "./api/client.ts";
import { createQueries } from "./api/queries.ts";
import { createAppRouter } from "./routes.tsx";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});
const q = createQueries(createApi({ origin: location.origin }));
const router = createAppRouter({ queryClient, q });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
