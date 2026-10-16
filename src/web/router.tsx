import { createRootRoute, createRoute, createRouter, Outlet, redirect } from "@tanstack/react-router";
import { OpportunityId } from "@/shared/api";
import { TopBar } from "./components/top-bar";
import { BoardPage } from "./routes/board";
import { ProfilePage } from "./routes/profile";
import { WorkspacePage } from "./routes/workspace";
import { Toaster } from "./ui/sonner";

const rootRoute = createRootRoute({
  component: () => (
    <>
      <TopBar />
      <main className="mx-auto w-full max-w-6xl px-4 pt-6 pb-16 sm:px-6">
        <Outlet />
      </main>
      <Toaster position="bottom-right" />
    </>
  ),
  notFoundComponent: () => (
    <p className="text-muted-foreground">This page does not exist. Use Board or Profile above.</p>
  ),
});

// Matches arrives in slice 7; until then the board is the home screen.
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/board" });
  },
});

const boardRoute = createRoute({ getParentRoute: () => rootRoute, path: "/board", component: BoardPage });
const profileRoute = createRoute({ getParentRoute: () => rootRoute, path: "/profile", component: ProfilePage });

export const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/jobs/$opportunityId",
  params: {
    parse: (raw) => ({ opportunityId: OpportunityId.parse(raw.opportunityId) }),
    stringify: ({ opportunityId }) => ({ opportunityId }),
  },
  component: function WorkspaceRoute() {
    const { opportunityId } = workspaceRoute.useParams();
    return <WorkspacePage key={opportunityId} opportunityId={opportunityId} />;
  },
  errorComponent: () => (
    <p className="text-muted-foreground">That link does not point to a job. Open one from the Board.</p>
  ),
});

const routeTree = rootRoute.addChildren([indexRoute, boardRoute, profileRoute, workspaceRoute]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
