import { createRootRoute, createRoute, createRouter, lazyRouteComponent } from "@tanstack/react-router";
import { Layout } from "./components/layout/Layout";
import { NotFound, RouteError, RoutePending } from "./components/layout/RouteStates";
import { installPageViews } from "./lib/pageview";

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

// Product overview + version / changelog. Rendered in a bare frame when there is no team yet.
const aboutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/about",
  component: lazyRouteComponent(() => import("./pages/About"), "AboutPage"),
});

// Owner / admin only (the page renders a friendly 403 for everyone else).
const analyticsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/analytics",
  component: lazyRouteComponent(() => import("./pages/Analytics"), "AnalyticsPage"),
});

// Invite links work with or without a current team; Layout renders them in a bare frame.
const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invite/$token",
  component: lazyRouteComponent(() => import("./pages/Invite"), "InvitePage"),
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
  aboutRoute,
  analyticsRoute,
  inviteRoute,
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  defaultPendingComponent: RoutePending,
  defaultErrorComponent: RouteError,
  defaultPendingMs: 150,
  scrollRestoration: true,
});

installPageViews(router);

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
