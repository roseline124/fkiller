import type { ResolvedBaseBranch } from "./types.ts";

function trimExact(s: string): string {
  return s.trim();
}

export type ResolveInputs = {
  environment_url?: string;
  environment_name?: string;
  branchRoutes?: import("./types.ts").BranchRoute[];
};

/** Priority: URL exact → environment name → fallback main */
export function resolveBaseBranch(resolveIn: ResolveInputs): ResolvedBaseBranch {
  const url = trimExact(resolveIn.environment_url ?? "");
  const envName = trimExact(resolveIn.environment_name ?? "");

  const routes = resolveIn.branchRoutes ?? [];

  if (url) {
    for (const route of routes) {
      const matchUrl = route.match.environmentUrl ?? (route.match as { environment_url?: string }).environment_url;
      const normalizedRouteUrl =
        typeof matchUrl === "string" ? trimExact(matchUrl) : undefined;
      if (normalizedRouteUrl === url && route.baseBranch) {
        return { selectedBaseBranch: route.baseBranch, matchedBranchRoute: route };
      }
    }
  }

  if (envName) {
    for (const route of routes) {
      const matchName =
        route.match.environmentName ?? (route.match as { environment_name?: string }).environment_name;
      const normalizedRouteName =
        typeof matchName === "string" ? trimExact(matchName) : undefined;
      if (normalizedRouteName && normalizedRouteName === envName && route.baseBranch) {
        return { selectedBaseBranch: route.baseBranch, matchedBranchRoute: route };
      }
    }
  }

  return { selectedBaseBranch: "main", matchedBranchRoute: null };
}
