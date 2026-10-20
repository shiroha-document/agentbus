import { createRootRoute, createRoute, createRouter, lazyRouteComponent } from "@tanstack/react-router";
import { Layout } from "./components/layout/Layout";
import { NotFound, RouteError, RoutePending } from "./components/layout/RouteStates";

const rootRoute = createRootRoute({
  component: Layout,
  notFoundComponent: NotFound,
});

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: lazyRouteComponent(() => import("./pages/Home"), "HomePage"),
});

const workspacesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workspaces",
  component: lazyRouteComponent(() => import("./pages/Workspaces"), "WorkspacesPage"),
});

const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workspaces/$id",
  component: lazyRouteComponent(() => import("./pages/WorkspaceDetail"), "WorkspaceDetailPage"),
});

const threadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/threads/$id",
  component: lazyRouteComponent(() => import("./pages/Thread"), "ThreadPage"),
});

const membersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/members",
  component: lazyRouteComponent(() => import("./pages/Members"), "MembersPage"),
});

const memberRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/members/$id",
  component: lazyRouteComponent(() => import("./pages/MemberDetail"), "MemberDetailRoutePage"),
});

const usageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/usage",
  component: lazyRouteComponent(() => import("./pages/Usage"), "UsagePage"),
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  validateSearch: (s: Record<string, unknown>): { email?: string } =>
    typeof s.email === "string" ? { email: s.email } : {},
  component: lazyRouteComponent(() => import("./pages/Settings"), "SettingsPage"),
});

const routeTree = rootRoute.addChildren([
  homeRoute,
  workspacesRoute,
  workspaceRoute,
  threadRoute,
  membersRoute,
  memberRoute,
  usageRoute,
  settingsRoute,
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  defaultPendingComponent: RoutePending,
  defaultErrorComponent: RouteError,
  defaultPendingMs: 150,
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
