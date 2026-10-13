import { createHash } from "node:crypto";
import {
  SUMMARY_MARKER,
  REVIEW_MARKER,
  MAX_COMMENT_LENGTH,
  escapeMarkdown,
  inlineCode,
  issueCount,
  renderReviewProgress,
} from "./report";
import type { Diagnostic } from "../types";

const STATE_PREFIX = "<!-- react-luau-doctor:state:";
const CHECK_RUN_NAME = "React-Luau Doctor findings";
const MAX_CHECK_ANNOTATIONS_PER_REQUEST = 50;

export interface ReviewFinding {
  file: string;
  rule: string;
  severity: string;
  message: string;
  line: number;
  column?: number;
  diagnosticId?: string;
  anchor?: string;
  identity?: string;
  status: "active" | "fixed" | "unknown";
}

export interface ReviewState {
  version: 1;
  commit: string;
  signature: string;
  runId?: string;
  attempt?: string;
  findings: ReviewFinding[];
}

interface FindingRecord {
  state: ReviewState;
  finding: ReviewFinding;
  file: string | null;
  identity: string;
}

function assignFindings(records: FindingRecord[], analysis: ReviewAnalysis): void {
  const groups = new Map<string, FindingRecord[]>();

  for (const record of records) {
    if (!record.file) {
      record.finding.status = "unknown";
      continue;
    }

    const key = findingFingerprint({ ...record.finding, file: record.file });
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }

  for (const [key, group] of groups) {
    const identities = [...new Set(group.map((entry) => entry.identity))];
    const originals = identities.map(
      (identity) => group.find((entry) => entry.identity === identity)!,
    );
    const current = analysis.current
      .filter((finding) => findingFingerprint(finding) === key)
      .map((finding) => ({ finding, used: false }));
    const matches = new Map<string, ReviewFinding>();

    // Unique source anchors disambiguate otherwise identical diagnostics when lines move
    for (const original of originals) {
      if (
        !original.finding.anchor ||
        originals.filter((entry) => entry.finding.anchor === original.finding.anchor).length !== 1
      ) {
        continue;
      }

      const candidates = current.filter(
        (entry) => !entry.used && entry.finding.anchor === original.finding.anchor,
      );

      if (candidates.length !== 1) continue;

      candidates[0].used = true;
      matches.set(original.identity, candidates[0].finding);
    }

    const unmatched = originals.filter((entry) => !matches.has(entry.identity));
    const remaining = current.filter((entry) => !entry.used);
    const ambiguous = remaining.length > 0 && remaining.length < unmatched.length;

    if (!ambiguous) {
      for (const original of unmatched) {
        const candidate = remaining
          .filter((entry) => !entry.used)
          .sort(
            (a, b) =>
              Math.abs(a.finding.line - original.finding.line) -
              Math.abs(b.finding.line - original.finding.line),
          )[0];

        if (!candidate) continue;

        candidate.used = true;
        matches.set(original.identity, candidate.finding);
      }
    }

    for (const record of group) {
      const match = matches.get(record.identity);
      const potentiallyRelocated =
        analysis.deletedFiles?.has(record.file!) &&
        analysis.current.some(
          (finding) =>
            finding.file !== record.file &&
            finding.rule === record.finding.rule &&
            finding.severity === record.finding.severity &&
            finding.message === record.finding.message,
        );

      if (match) {
        record.finding.status = "active";
        match.identity = record.identity;
      } else {
        record.finding.status =
          !ambiguous &&
          !potentiallyRelocated &&
          analysis.verifiedFiles.has(record.file!) &&
          analysis.eligible({ ...record.finding, file: record.file! }) &&
          record.state.signature === analysis.signature
            ? "fixed"
            : "unknown";
      }
    }
  }
}

export function findingFingerprint(
  finding: Pick<ReviewFinding, "file" | "rule" | "severity" | "message">,
): string {
  return createHash("sha256")
    .update(`${finding.file}\0${finding.rule}\0${finding.severity}\0${finding.message}`)
    .digest("hex")
    .slice(0, 32);
}

export function readReviewState(body: string): ReviewState | null {
  const encoded = body.match(/<!-- react-luau-doctor:state:([A-Za-z0-9+/=]+) -->/)?.[1];

  if (!encoded) return null;

  try {
    const state = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as ReviewState;

    if (
      state.version !== 1 ||
      typeof state.commit !== "string" ||
      typeof state.signature !== "string" ||
      !Array.isArray(state.findings) ||
      state.findings.length === 0
    ) {
      return null;
    }

    if (
      state.findings.some(
        (f) =>
          !f ||
          typeof f.file !== "string" ||
          typeof f.rule !== "string" ||
          typeof f.severity !== "string" ||
          typeof f.message !== "string" ||
          !Number.isSafeInteger(f.line) ||
          f.line < 1 ||
          !["active", "fixed", "unknown"].includes(f.status) ||
          [f.anchor, f.identity, f.diagnosticId].some(
            (value) => value !== undefined && typeof value !== "string",
          ),
      )
    ) {
      return null;
    }

    return state;
  } catch {
    return null;
  }
}

export function renderReviewBody(state: ReviewState, discussions?: number): string {
  const fixed = state.findings.filter((finding) => finding.status === "fixed").length;
  const unknown = state.findings.filter((finding) => finding.status === "unknown").length;
  const progress = renderReviewProgress(state.findings.length, fixed, unknown, discussions);
  const metadata = Buffer.from(JSON.stringify(state)).toString("base64");

  return `${REVIEW_MARKER}\n${progress}\n\n${STATE_PREFIX}${metadata} -->`;
}

interface User {
  type?: string;
  login?: string;
}

interface Comment {
  id: number;
  body?: string;
  user?: User | null;
}

export interface ReviewComment extends Comment {
  pull_request_review_id: number;
  path: string;
  line?: number | null;
  original_line?: number;
  commit_id?: string;
  original_commit_id?: string;
  in_reply_to_id?: number;
}

export interface Review extends Comment {
  commit_id?: string;
}

interface Thread {
  isResolved: boolean;
  comments: { nodes: Array<{ databaseId: number | null }> };
}

export interface Publication {
  head: string;
  base: string;
  runId: string;
  attempt: string;
}

export class StalePublication extends Error {}

export class GitHubClient {
  private lastMutation = 0;

  constructor(
    readonly repo: string,
    readonly pullNumber: number,
    readonly publication: Publication,
  ) {}

  async request<T>(
    endpoint: string,
    options: { method?: string; body?: unknown; guarded?: boolean } = {},
    graphql = false,
  ): Promise<T> {
    const token = process.env.GITHUB_TOKEN;

    if (!token) throw new Error("GITHUB_TOKEN is unavailable");

    const base = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
    const url = graphql
      ? `${base.replace(/\/api\/v3$/, "/api")}/graphql`
      : `${base}/repos/${this.repo}${endpoint}`;
    const method = options.method ?? "GET";
    const mutation = !graphql && method !== "GET";
    // GitHub asks integrations to space out mutative requests to avoid secondary rate limits
    const interval = Number(process.env.DOCTOR_GITHUB_MUTATION_INTERVAL_MS ?? 1000);

    for (let attempt = 0; ; attempt += 1) {
      if (attempt > 0 && options.guarded) await this.assertCurrent();

      if (mutation) {
        const wait = this.lastMutation + interval - Date.now();

        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

        this.lastMutation = Date.now();
      }

      const response = await fetch(url, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "react-luau-doctor",
          "Content-Type": "application/json",
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(30_000),
      });
      const responseText = response.status === 204 ? "" : await response.text();
      const result = response.ok && responseText ? JSON.parse(responseText) : undefined;
      const rateLimited =
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.get("x-ratelimit-remaining") === "0" ||
            /rate limit|rate_limit|abuse detection/i.test(responseText))) ||
        (response.ok && graphql && result?.errors && /rate limit|rate_limit/i.test(responseText));

      if (response.ok && !rateLimited) {
        if (graphql && (result?.errors || !result?.data)) {
          throw new Error(`GitHub GraphQL: ${responseText}`);
        }

        return result as T;
      }

      const retryAfter = response.headers.get("retry-after");
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      const delay = retryAfter
        ? /^\d+$/.test(retryAfter)
          ? Number(retryAfter) * 1000
          : Date.parse(retryAfter) - Date.now()
        : response.headers.get("x-ratelimit-remaining") === "0" && reset
          ? Math.max(0, reset * 1000 - Date.now() + 1000)
          : 60_000 * 2 ** attempt;

      // Only retry explicit rate-limit rejections, never ambiguous publication failures
      if (!rateLimited || attempt >= 2 || !Number.isFinite(delay) || delay > 300_000) {
        throw new Error(`GitHub API ${response.status}: ${responseText}`);
      }

      process.stderr.write(
        `react-luau-doctor: GitHub API ${response.status}; retrying in ${Math.ceil(Math.max(0, delay) / 1000)} seconds\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, delay)));
    }
  }

  async list<T>(endpoint: string): Promise<T[]> {
    const all: T[] = [];

    for (let page = 1; ; page++) {
      const batch = await this.request<T[]>(`${endpoint}?per_page=100&page=${page}`);

      if (!Array.isArray(batch)) throw new Error("GitHub returned an invalid paginated response");

      all.push(...batch);

      if (batch.length < 100) return all;
    }
  }

  async assertCurrent(): Promise<void> {
    const pull = await this.request<{
      head: { sha: string };
      base: { sha: string };
      state: string;
    }>(`/pulls/${this.pullNumber}`);

    if (
      pull.head?.sha !== this.publication.head ||
      pull.base?.sha !== this.publication.base ||
      pull.state !== "open"
    ) {
      throw new StalePublication("PR head or baseline changed; skipping outdated publication");
    }

    const summaries = await this.list<Comment>(`/issues/${this.pullNumber}/comments`);

    for (const summary of summaries.filter(
      (c) => c.user?.type === "Bot" && c.body?.startsWith(SUMMARY_MARKER),
    )) {
      const marker = summary.body?.match(/<!-- react-luau-doctor:run:(\d+):(\d+) -->/);

      if (
        marker &&
        this.publication.runId &&
        (BigInt(marker[1]) > BigInt(this.publication.runId) ||
          (marker[1] === this.publication.runId &&
            Number(marker[2]) > Number(this.publication.attempt)))
      ) {
        throw new StalePublication(
          "A newer workflow run already published; skipping outdated publication",
        );
      }
    }

    if (!summaries.some((c) => c.user?.type === "Bot" && c.body?.startsWith(SUMMARY_MARKER))) {
      const reviews = await this.list<Review>(`/pulls/${this.pullNumber}/reviews`);

      for (const review of reviews.filter((r) => r.user?.type === "Bot")) {
        const state = readReviewState(review.body ?? "");

        if (
          state?.runId &&
          /^\d+$/.test(state.runId) &&
          this.publication.runId &&
          (BigInt(state.runId) > BigInt(this.publication.runId) ||
            (state.runId === this.publication.runId &&
              Number(state.attempt) > Number(this.publication.attempt)))
        ) {
          throw new StalePublication(
            "A newer review run already published; skipping outdated publication",
          );
        }
      }
    }
  }

  async mutate<T>(endpoint: string, method: string, body?: unknown): Promise<T> {
    await this.assertCurrent();

    return this.request<T>(endpoint, { method, body, guarded: true });
  }

  async sticky(body: string, complete = true): Promise<void> {
    await this.assertCurrent();
    const comments = await this.list<Comment>(`/issues/${this.pullNumber}/comments`);
    const previous = comments.find(
      (c) => c.user?.type === "Bot" && c.body?.startsWith(SUMMARY_MARKER),
    );
    const identity = `<!-- react-luau-doctor:commit:${this.publication.head}:${this.publication.base}:complete -->`;

    if (!complete && previous?.body?.includes(identity)) return;

    const stamp =
      (this.publication.runId
        ? `\n<!-- react-luau-doctor:run:${this.publication.runId}:${this.publication.attempt} -->`
        : "") +
      `\n<!-- react-luau-doctor:commit:${this.publication.head}:${this.publication.base}:${complete ? "complete" : "incomplete"} -->`;
    const next = body + stamp;

    if (previous?.body === next) return;

    await this.mutate(
      previous ? `/issues/comments/${previous.id}` : `/issues/${this.pullNumber}/comments`,
      previous ? "PATCH" : "POST",
      { body: next },
    );
  }

  async threads(): Promise<Map<number, { resolved: boolean }>> {
    const [owner, name] = this.repo.split("/");
    const result = new Map<number, { resolved: boolean }>();
    let cursor: string | null = null;

    for (;;) {
      const response: {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: Thread[];
                pageInfo: { hasNextPage: boolean; endCursor: string | null };
              };
            };
          };
        };
      } = await this.request(
        "",
        {
          method: "POST",
          body: {
            query: `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
              repository(owner: $owner, name: $name) {
                pullRequest(number: $number) {
                  reviewThreads(first: 100, after: $cursor) {
                    nodes {
                      isResolved
                      comments(first: 1) {
                        nodes { databaseId }
                      }
                    }
                    pageInfo {
                      hasNextPage
                      endCursor
                    }
                  }
                }
              }
            }`,
            variables: { owner, name, number: this.pullNumber, cursor },
          },
        },
        true,
      );
      const connection = response.data.repository?.pullRequest?.reviewThreads;

      if (!connection || !Array.isArray(connection.nodes)) {
        throw new Error("GitHub review-thread state is unavailable");
      }

      for (const thread of connection.nodes) {
        const root = thread.comments.nodes[0]?.databaseId;

        // REST has all replies; the GraphQL connection supplies the actual resolution state
        if (typeof thread.isResolved !== "boolean") {
          throw new Error("GitHub returned an invalid review-thread resolution state");
        }

        if (root) result.set(root, { resolved: thread.isResolved });
      }

      if (!connection.pageInfo.hasNextPage) return result;

      if (!connection.pageInfo.endCursor || connection.pageInfo.endCursor === cursor) {
        throw new Error("GitHub review-thread pagination did not advance");
      }

      cursor = connection.pageInfo.endCursor;
    }
  }
}

export interface CheckAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  start_column?: number;
  end_column?: number;
  annotation_level: "notice" | "warning" | "failure";
  title: string;
  message: string;
}

export interface CheckRunResult {
  conclusion: "success" | "neutral";
  title: string;
  summary: string;
  annotations: CheckAnnotation[];
}

export async function publishCheckRun(
  client: GitHubClient,
  sha: string,
  result: CheckRunResult,
): Promise<void> {
  const output = { title: result.title, summary: result.summary };
  const completed = { status: "completed", conclusion: result.conclusion };
  // GitHub accepts 50 annotations per request and appends each update to the run
  const size = MAX_CHECK_ANNOTATIONS_PER_REQUEST;
  const [first, ...rest] = Array.from(
    { length: Math.max(1, Math.ceil(result.annotations.length / size)) },
    (_, index) => result.annotations.slice(index * size, (index + 1) * size),
  );
  const run = await client.request<{ id: number }>("/check-runs", {
    method: "POST",
    body: {
      name: CHECK_RUN_NAME,
      head_sha: sha,
      ...(rest.length ? { status: "in_progress" } : completed),
      output: { ...output, annotations: first },
    },
  });
  const update = (body: unknown) =>
    client.request(`/check-runs/${run.id}`, { method: "PATCH", body });

  try {
    for (const [index, annotations] of rest.entries()) {
      await update({
        ...(index === rest.length - 1 ? completed : {}),
        output: { ...output, annotations },
      });
    }
  } catch (error) {
    // Avoid leaving a run stuck in progress
    await update({
      status: "completed",
      conclusion: "neutral",
      output: {
        ...output,
        summary: `${result.summary}\n\nSome annotations could not be published`,
      },
    }).catch(() => undefined);

    throw error;
  }
}

export function commentFingerprint(comment: ReviewComment): string | null {
  if (
    comment.user?.type !== "Bot" ||
    !comment.body?.startsWith(REVIEW_MARKER) ||
    comment.in_reply_to_id
  ) {
    return null;
  }

  const marker = comment.body.match(/<!-- react-luau-doctor:fingerprint:([a-f0-9]{32}) -->/i);

  if (marker) return marker[1].toLowerCase();

  const legacy = comment.body.match(
    /\*\*React-Luau Doctor\*\* · `([^`]+)` \((error|warning|suggestion)\)\n\n([^\n]+)/,
  );

  return legacy
    ? findingFingerprint({
        file: comment.path,
        rule: legacy[1],
        severity: legacy[2],
        message: legacy[3],
      })
    : null;
}

export interface ReviewAnalysis {
  signature: string;
  complete: boolean;
  current: ReviewFinding[];
  introduced: Array<{ finding: ReviewFinding; diagnostic: Diagnostic }>;
  verifiedFiles: Set<string>;
  deletedFiles?: ReadonlySet<string>;
  eligible: (finding: ReviewFinding) => boolean;
  canonicalFile: (file: string, commit: string) => string | null;
}

export interface ReviewSnapshot {
  reviews: Review[];
  comments: ReviewComment[];
}

function recoverReviewState(review: Review, comments: ReviewComment[]): ReviewState | null {
  const count = Number(
    review.body?.match(
      /(?:^|\n)(?:\*\*)?React-Luau Doctor found (\d+) new issues?(?:\*\*)?(?:\n|$)/,
    )?.[1],
  );
  const roots = comments.filter(
    (comment) => comment.pull_request_review_id === review.id && !comment.in_reply_to_id,
  );

  if (!count || roots.length !== count) return null;

  const commit = review.commit_id ?? roots[0]?.original_commit_id ?? roots[0]?.commit_id;

  if (!commit) return null;

  const findings: ReviewFinding[] = [];

  for (const comment of roots) {
    const diagnostic = comment.body?.match(
      /\*\*React-Luau Doctor\*\* · `([^`]+)` \((error|warning|suggestion)\)\n\n([^\n]+)/,
    );
    const line = comment.original_line ?? comment.line;

    if (!diagnostic || !Number.isSafeInteger(line) || line! < 1) return null;

    const finding: ReviewFinding = {
      file: comment.path,
      rule: diagnostic[1],
      severity: diagnostic[2],
      message: diagnostic[3],
      line: line!,
      identity: `legacy:${review.id}:${comment.id}`,
      status: "unknown",
    };

    if (commentFingerprint(comment) !== findingFingerprint(finding)) return null;

    findings.push(finding);
  }

  // Deleted comments cannot be reconstructed, and surviving comments do not prove the original configuration
  return { version: 1, commit, signature: "", findings };
}

function prioritizedFindings(
  candidates: ReviewAnalysis["introduced"],
): ReviewAnalysis["introduced"] {
  const severity = { error: 0, warning: 1, suggestion: 2 };
  const counts = new Map<string, number>();

  return [...candidates]
    .sort(
      (a, b) =>
        a.finding.file.localeCompare(b.finding.file) ||
        a.finding.line - b.finding.line ||
        a.diagnostic.id.localeCompare(b.diagnostic.id),
    )
    .map((candidate) => {
      const key = `${candidate.finding.severity}\0${candidate.finding.file}`;
      const round = counts.get(key) ?? 0;
      counts.set(key, round + 1);

      return { candidate, round };
    })
    .sort(
      (a, b) =>
        severity[a.candidate.diagnostic.severity] - severity[b.candidate.diagnostic.severity] ||
        a.round - b.round ||
        a.candidate.finding.file.localeCompare(b.candidate.finding.file),
    )
    .map(({ candidate }) => candidate);
}

export async function reviewSnapshot(client: GitHubClient): Promise<ReviewSnapshot> {
  // GitHub recommends serial requests to avoid secondary rate limits
  const reviews = await client.list<Review>(`/pulls/${client.pullNumber}/reviews`);
  const comments = await client.list<ReviewComment>(`/pulls/${client.pullNumber}/comments`);

  return { reviews, comments };
}

export async function reconcileReviews(
  client: GitHubClient,
  snapshot: ReviewSnapshot,
  analysis: ReviewAnalysis,
  canInline: (diagnostic: Diagnostic) => boolean,
  limit: number,
): Promise<number> {
  if (!analysis.complete) return snapshot.comments.filter((c) => commentFingerprint(c)).length;

  const ownedReviews = snapshot.reviews.filter(
    (r) =>
      r.user?.type === "Bot" &&
      (r.body?.startsWith(REVIEW_MARKER) ||
        /^(?:\*\*)?React-Luau Doctor found (?:\d+ )?new issues?(?:\*\*)?$/.test(r.body ?? "") ||
        r.body?.startsWith(
          "✅ React-Luau Doctor: findings from this review are no longer current",
        )),
  );
  let threads: Map<number, { resolved: boolean }> | undefined;

  try {
    threads = await client.threads();
  } catch (error) {
    process.stderr.write(
      `react-luau-doctor: could not read review threads; preserving discussions: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }

  const states = new Map<number, ReviewState>();
  const records: FindingRecord[] = [];

  for (const review of ownedReviews) {
    const original =
      readReviewState(review.body ?? "") ?? recoverReviewState(review, snapshot.comments);

    if (!original) continue;

    const state = { ...original, findings: original.findings.map((finding) => ({ ...finding })) };
    states.set(review.id, state);

    for (const finding of state.findings) {
      const identity =
        finding.identity ?? `${state.commit}:${findingFingerprint(finding)}:${finding.line}`;
      finding.identity = identity;
      records.push({
        state,
        finding,
        identity,
        file: analysis.canonicalFile(finding.file, state.commit),
      });
    }
  }

  assignFindings(records, analysis);

  for (const state of states.values()) {
    if (state.signature !== "") continue;

    // Once every recovered finding is observed under this configuration, later compatible scans can verify fixes
    if (
      state.findings.every((finding) => {
        const file = analysis.canonicalFile(finding.file, state.commit);

        return (
          finding.status === "active" &&
          file &&
          analysis.verifiedFiles.has(file) &&
          analysis.eligible({ ...finding, file })
        );
      })
    ) {
      state.signature = analysis.signature;
    }
  }

  const represented = new Map<string, number>();
  const representedIdentities = new Set<string>();
  const failures: string[] = [];
  const updates: Array<{ review: Review; body: string; cleanup: ReviewComment[] }> = [];
  let inlineCount = snapshot.comments.filter((c) => commentFingerprint(c)).length;

  for (const review of ownedReviews.sort((a, b) => a.id - b.id)) {
    const state = states.get(review.id);

    if (!state) {
      const retained = snapshot.comments.filter(
        (comment) => comment.pull_request_review_id === review.id && commentFingerprint(comment),
      ).length;
      const body =
        `${REVIEW_MARKER}\n**React-Luau Doctor · earlier findings**\n\n` +
        `${retained ? `${issueCount(retained)} retained inline · ` : ""}` +
        "Original finding history unavailable · See the current PR report";
      updates.push({ review, body, cleanup: [] });
      continue;
    }

    let discussions: number | undefined = threads ? 0 : undefined;
    const ownedComments = snapshot.comments.filter(
      (c) => c.pull_request_review_id === review.id && commentFingerprint(c),
    );
    const consumedComments = new Set<number>();
    const cleanup: ReviewComment[] = [];

    for (const finding of state.findings) {
      const file = analysis.canonicalFile(finding.file, state.commit);
      const fingerprint = findingFingerprint(finding);
      const comments = ownedComments
        .filter((c) => !consumedComments.has(c.id) && commentFingerprint(c) === fingerprint)
        .sort(
          (a, b) =>
            Math.abs((a.original_line ?? a.line ?? finding.line) - finding.line) -
            Math.abs((b.original_line ?? b.line ?? finding.line) - finding.line),
        );
      const comment = comments[0];

      if (comment) consumedComments.add(comment.id);

      const replies = comment
        ? snapshot.comments.filter((c) => c.in_reply_to_id === comment.id)
        : [];
      const discussion = comment && replies.length > 0;

      if (discussion && threads) {
        const thread = threads.get(comment.id);

        if (!thread || typeof thread.resolved !== "boolean") discussions = undefined;
        else if (!thread.resolved && discussions !== undefined) discussions++;
      }

      const key = findingFingerprint({ ...finding, file: file ?? finding.file });

      if (
        ((finding.status === "active" && comment) || finding.status === "unknown") &&
        !representedIdentities.has(finding.identity!)
      ) {
        represented.set(key, (represented.get(key) ?? 0) + 1);
        representedIdentities.add(finding.identity!);
      }

      if (comment && finding.status === "fixed" && !discussion && threads?.has(comment.id)) {
        cleanup.push(comment);
      }
    }

    const body = renderReviewBody(state, discussions);

    if (body !== review.body) {
      state.runId = client.publication.runId;
      state.attempt = client.publication.attempt;
    }

    updates.push({
      review,
      body: body === review.body ? body : renderReviewBody(state, discussions),
      cleanup,
    });
  }

  for (const comment of snapshot.comments) {
    if (!commentFingerprint(comment) || states.has(comment.pull_request_review_id)) continue;

    const key = commentFingerprint(comment)!;
    represented.set(key, (represented.get(key) ?? 0) + 1);
  }

  const selected: Array<{ finding: ReviewFinding; diagnostic: Diagnostic }> = [];
  const candidates: ReviewAnalysis["introduced"] = [];
  const alreadyPublished = [...states.values()]
    .filter((state) => state.commit === client.publication.head)
    .reduce((count, state) => count + state.findings.length, 0);

  for (const candidate of analysis.introduced) {
    const key = findingFingerprint(candidate.finding);
    const count = represented.get(key) ?? 0;

    if (count) {
      represented.set(key, count - 1);
      continue;
    }

    if (!canInline(candidate.diagnostic)) continue;

    candidates.push(candidate);
  }

  for (const candidate of prioritizedFindings(candidates)) {
    const key = findingFingerprint(candidate.finding);

    if (selected.length + alreadyPublished >= limit) break;

    const current = analysis.current.find(
      (finding) =>
        findingFingerprint(finding) === key &&
        (candidate.finding.diagnosticId
          ? finding.diagnosticId === candidate.finding.diagnosticId
          : finding.line === candidate.finding.line && finding.column === candidate.finding.column),
    );
    candidate.finding.identity =
      current?.identity ?? `${client.publication.head}:${key}:${candidate.diagnostic.id}`;
    const nextState: ReviewState = {
      version: 1,
      signature: analysis.signature,
      commit: client.publication.head,
      findings: [...selected, candidate].map((entry) => entry.finding),
    };

    if (
      renderReviewBody(nextState, 0).length > MAX_COMMENT_LENGTH ||
      inlineBody(candidate.finding, candidate.diagnostic).length > MAX_COMMENT_LENGTH
    ) {
      continue;
    }

    selected.push(candidate);
  }

  let publicationSucceeded = true;

  if (selected.length) {
    const state: ReviewState = {
      version: 1,
      commit: client.publication.head,
      signature: analysis.signature,
      runId: client.publication.runId,
      attempt: client.publication.attempt,
      findings: selected.map((entry) => entry.finding),
    };
    const comments = selected.map(({ finding, diagnostic }) => ({
      path: finding.file,
      line: finding.line,
      side: "RIGHT",
      body: inlineBody(finding, diagnostic),
    }));

    try {
      await client.mutate(`/pulls/${client.pullNumber}/reviews`, "POST", {
        commit_id: client.publication.head,
        event: "COMMENT",
        body: renderReviewBody(state, 0),
        comments,
      });
      inlineCount += comments.length;
    } catch (error) {
      if (error instanceof StalePublication) throw error;

      publicationSucceeded = false;
      failures.push(`could not create new review comments: ${String(error)}`);
    }
  }

  for (const { review, body, cleanup } of updates) {
    try {
      // Persist original membership before deleting its only remaining evidence
      if (body !== review.body) {
        await client.mutate(`/pulls/${client.pullNumber}/reviews/${review.id}`, "PUT", { body });
      }

      if (!publicationSucceeded) continue;

      for (const comment of cleanup) {
        const latest = await client.list<ReviewComment>(`/pulls/${client.pullNumber}/comments`);

        if (latest.some((entry) => entry.in_reply_to_id === comment.id)) continue;

        if (!latest.some((entry) => entry.id === comment.id)) continue;

        await client.mutate(`/pulls/comments/${comment.id}`, "DELETE");
        inlineCount--;
      }
    } catch (error) {
      if (error instanceof StalePublication) throw error;

      failures.push(`could not update review ${review.id}: ${String(error)}`);
    }
  }

  if (failures.length) {
    process.stderr.write(
      `react-luau-doctor: could not update inline review comments: ${failures.join("; ")}\n`,
    );
  }

  return inlineCount;
}

function inlineBody(finding: ReviewFinding, diagnostic: Diagnostic): string {
  const details = [diagnostic.help, diagnostic.explanation, diagnostic.caveat].filter(
    (value): value is string => Boolean(value) && value !== finding.message,
  );

  const header = `${REVIEW_MARKER}\n<!-- react-luau-doctor:fingerprint:${findingFingerprint(finding)} -->`;
  const title = `**React-Luau Doctor** · ${inlineCode(finding.rule)} (${finding.severity})`;
  const guidance = [...new Set(details)].map((detail) => `\n\n${escapeMarkdown(detail)}`).join("");

  return `${header}\n${title}\n\n${escapeMarkdown(finding.message)}${guidance}`;
}
