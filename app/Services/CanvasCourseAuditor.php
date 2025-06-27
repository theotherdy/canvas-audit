<?php

namespace App\Services;

use App\Models\AuditCourseResult;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Http;

class CanvasCourseAuditor
{
    /**
     * Base URL *without* trailing slash, e.g. https://canvas.example.edu/api/v1
     */
    protected string $baseUrl;

    /**
     * Canvas API token.
     */
    protected string $token;

    public function __construct()
    {
        $this->baseUrl = rtrim(config('services.canvas.base_url'), '/');
        $this->token   = config('services.canvas.token');
    }

    // ───────────────────────────── Public entry point ────────────────────────────

    /**
     * Run a full audit for a single course.
     *
     * @param  int         $courseId  Canvas course id
     * @param  int|null    $batchId   AuditBatch id (optional)
     * @return AuditCourseResult
     */
    public function handle(int $courseId, ?int $batchId = null): AuditCourseResult
    {
        // Basic counts ───────────────────────────────────────────────────────────
        $activeStudents   = $this->countActiveStudents($courseId);
        $publishedPages   = $this->countPublishedPages($courseId);
        $classicQuizzes   = $this->countClassicQuizzes($courseId);
        $newQuizzes       = $this->countNewQuizzes($courseId);
        $otherAssignments = $this->countOtherAssignments($courseId);
        $discussions      = $this->countActiveDiscussions($courseId);

        // Engagement ratios ──────────────────────────────────────────────────────
        $quizEngagement        = $this->quizEngagement($courseId, $activeStudents);
        $assignmentEngagement  = $this->assignmentEngagement($courseId, $activeStudents);
        $discussionEngagement  = $this->discussionEngagement($courseId, $activeStudents);

        // Persist or update result row ───────────────────────────────────────────
        return AuditCourseResult::updateOrCreate(
            ['batch_id' => $batchId, 'course_id' => $courseId],
            [
                'published_pages'      => $publishedPages,
                'classic_quizzes'      => $classicQuizzes,
                'new_quizzes'          => $newQuizzes,
                'other_assignments'    => $otherAssignments,
                'discussions'          => $discussions,
                'active_students'      => $activeStudents,
                'quiz_engagement'      => $quizEngagement,
                'assignment_engagement'=> $assignmentEngagement,
                'discussion_engagement'=> $discussionEngagement,
            ]
        );
    }

    // ─────────────────────────── Low‑level HTTP helpers ──────────────────────────

    /**
     * Perform a GET request with bearer token and JSON accept header.
     */
    private function get(string $uri, array $query = []): Response
    {
        return Http::withToken($this->token)
            ->acceptJson()
            ->get("{$this->baseUrl}{$uri}", $query);
    }

    /**
     * Fetch every page of a Canvas collection, transparently following RFC‑5988
     * Link headers (rel="next").  Returns one big collection.
     *
     * @param  string  $uri   uri relative to /api/v1
     * @param  array   $query extra query string parameters
     * @return \Illuminate\Support\Collection
     */
    private function collectPaginated(string $uri, array $query = []): Collection
    {
        $items   = collect();
        $nextUrl = "{$this->baseUrl}{$uri}";

        while ($nextUrl) {
            $response = Http::withToken($this->token)
                ->acceptJson()
                ->get($nextUrl, $query + ['per_page' => 100])
                ->throw();

            $items   = $items->concat($response->json());
            $nextUrl = $this->nextLink($response);
            $query   = []; // subsequent pages already contain query string
        }

        return $items;
    }

    /**
     * Extract “next” link from Canvas Link header.
     *
     * @return string|null url or null if there is no next page
     */
    private function nextLink(Response $response): ?string
    {
        $header = $response->header('Link');
        if (!$header) {
            return null;
        }

        foreach (explode(',', $header) as $part) {
            if (str_contains($part, 'rel="next"')) {
                preg_match('/<([^>]+)>/', $part, $m);
                return $m[1] ?? null;
            }
        }

        return null;
    }

    // ──────────────────────────────── High‑level counts ──────────────────────────

    private function countActiveStudents(int $courseId): int
    {
        return $this->collectPaginated(
            "/courses/{$courseId}/enrollments",
            ['type[]' => 'StudentEnrollment', 'state[]' => 'active']
        )->count(); // :contentReference[oaicite:0]{index=0}
    }

    private function countPublishedPages(int $courseId): int
    {
        return $this->collectPaginated(
            "/courses/{$courseId}/pages",
            ['published' => true]
        )->count(); // :contentReference[oaicite:1]{index=1}
    }

    private function countClassicQuizzes(int $courseId): int
    {
        return $this
            ->collectPaginated("/courses/{$courseId}/quizzes")
            ->where('is_quiz_lti', false)
            ->count();
    }

    private function countNewQuizzes(int $courseId): int
    {
        return $this
            ->collectPaginated("/courses/{$courseId}/quizzes")
            ->where('is_quiz_lti', true)  // New Quiz is an LTI tool
            ->count();
    }

    private function countOtherAssignments(int $courseId): int
    {
        return $this
            ->collectPaginated("/courses/{$courseId}/assignments", ['published' => true])
            ->reject(fn ($a) => in_array('online_quiz', $a['submission_types'] ?? [], true)
                              || ($a['quiz_lti'] ?? false)) // exclude both classic & new quizzes
            ->count(); // :contentReference[oaicite:2]{index=2}
    }

    private function countActiveDiscussions(int $courseId): int
    {
        return $this
            ->collectPaginated("/courses/{$courseId}/discussion_topics", ['only_active' => true])
            ->count();
    }

    // ───────────────────────────── Engagement calculations ───────────────────────

    /**
     * Engagement = ∑ unique submitters ÷ (active students × tool count).
     */
    private function ratio(int $numerator, int $denominator): float
    {
        return $denominator > 0 ? $numerator / $denominator : 0.0;
    }

    private function quizEngagement(int $courseId, int $activeStudents): float
    {
        $quizzes = $this->collectPaginated("/courses/{$courseId}/quizzes");
        if ($quizzes->isEmpty() || $activeStudents === 0) {
            return 0.0;
        }

        $totalResponders = $quizzes->sum(function ($quiz) use ($courseId) {
            return $this->collectPaginated(
                "/courses/{$courseId}/quizzes/{$quiz['id']}/submissions"
            )->pluck('user_id')->unique()->count();
        });

        return $this->ratio($totalResponders, $activeStudents * $quizzes->count());
    }

    private function assignmentEngagement(int $courseId, int $activeStudents): float
    {
        $assignments = $this->collectPaginated("/courses/{$courseId}/assignments", ['published' => true])
                            ->reject(fn ($a) => in_array('online_quiz', $a['submission_types'] ?? [], true)
                                             || ($a['quiz_lti'] ?? false));

        if ($assignments->isEmpty() || $activeStudents === 0) {
            return 0.0;
        }

        $totalSubmitters = $assignments->sum(function ($assignment) use ($courseId) {
            return $this->collectPaginated(
                "/courses/{$courseId}/assignments/{$assignment['id']}/submissions"
            )->pluck('user_id')->unique()->count();
        });

        return $this->ratio($totalSubmitters, $activeStudents * $assignments->count());
    }

    private function discussionEngagement(int $courseId, int $activeStudents): float
    {
        $topics = $this->collectPaginated("/courses/{$courseId}/discussion_topics", ['only_active' => true]);

        if ($topics->isEmpty() || $activeStudents === 0) {
            return 0.0;
        }

        $totalParticipants = $topics->sum(function ($topic) use ($courseId) {
            return $this->collectPaginated(
                "/courses/{$courseId}/discussion_topics/{$topic['id']}/entries"
            )->pluck('user_id')->unique()->count();
        });

        return $this->ratio($totalParticipants, $activeStudents * $topics->count());
    }
}
