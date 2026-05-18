export type WorkflowInputs = {
  request_id: string;
  repo: string;
  slack_channel_id: string;
  slack_thread_ts: string;
  title: string;
  error_summary: string;
  reproduction_steps: string;
  expected_behavior: string;
  /** BCP47-style tag (예: ko, en, ja). 빈 입력 시 스크립트 기본값 `ko`. */
  language: string;
  allowed_file_patterns: string[];
  blocked_file_patterns: string[];
  environment_url: string;
  environment_name: string;
  max_context_files: number;
  max_patch_files: number;
};

export type BranchRouteMatch =
  | { environmentUrl?: string; environmentName?: string }
  | Record<string, string | undefined>;

export type BranchRoute = {
  match: BranchRouteMatch;
  baseBranch: string;
};

export type KeywordRoute = {
  keywords: string[];
  symbols?: string[];
  paths?: string[];
};

export type ContextDictionary = {
  branchRoutes: BranchRoute[];
  keywordRoutes: KeywordRoute[];
};

export type ResolvedBaseBranch = {
  selectedBaseBranch: string;
  matchedBranchRoute: BranchRoute | null;
};

export type BugReportNormalized = {
  inputs: WorkflowInputs;
  mergedBlockedPatterns: string[];
  effectiveAllowedPatterns: string[] | null;
  mergedTextLower: string;
  contextDictionary: ContextDictionary;
};

export type RawCandidateEvidence = {
  path: string;
  reasons: string[];
  /** Sources for downstream scoring hints */
  fromStackTrace?: boolean;
  /** Matched slack-derived token hits in file contents */
  contentKeywordHits?: number;
  fromSymbolSearch?: boolean;
  fromGlobPath?: boolean;
  fromRecentGit?: boolean;
};

export type ScoredCandidate = {
  path: string;
  score: number;
  reasons: string[];
};
