<?php

namespace App\Services;

use Illuminate\Http\Client\Response;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * Fetches counts + engagement ratios for ONE Canvas course
 * and returns them as a simple DTO (stdClass).
 *
 * ─────────────── Usage ───────────────
 * $auditor  = app(CanvasCourseAuditor::class);
 * $result   = $auditor->run($courseId);
 * echo $result->published_pages;
 */
class CanvasCourseAuditor
{
    protected string $baseUrl;   // e.g. https://canvas.example.edu/api/v1
    protected string $token;     // Canvas API token

    public function __construct()
    {
        $this->baseUrl = rtrim(config('services.canvas.base_url'), '/');
        $this->token   = config('services.canvas.token');
        
        // Validate configuration
        if (empty($this->baseUrl) || empty($this->token)) {
            Log::channel('canvas')->error('Canvas configuration missing', [
                'base_url' => $this->baseUrl ?: 'NOT_SET',
                'token' => $this->token ? 'SET' : 'NOT_SET'
            ]);
            throw new \InvalidArgumentException('Canvas API configuration is incomplete');
        }
    }

    /* -------------------------------------------------------------------------
     | Public entry point
     *------------------------------------------------------------------------ */
    public function run(int $courseId): \stdClass
    {
        $startTime = microtime(true);
        Log::channel('canvas')->info("Starting audit for course {$courseId}", [
            'course_id' => $courseId,
            'base_url' => $this->baseUrl
        ]);

        try {
            $active = $this->countActiveStudents($courseId);
            $pages  = $this->countPublishedPages($courseId);
            $cq     = $this->countClassicQuizzes($courseId);
            $nq     = $this->countNewQuizzes($courseId);
            $other  = $this->countOtherAssignments($courseId);
            $disc   = $this->countActiveDiscussions($courseId);

            $quizEng  = $this->quizEngagement($courseId, $active);
            $assnEng  = $this->assignmentEngagement($courseId, $active);
            $discEng  = $this->discussionEngagement($courseId, $active);

            $duration = microtime(true) - $startTime;
            Log::channel('canvas')->info("Completed audit for course {$courseId}", [
                'course_id' => $courseId,
                'duration_seconds' => round($duration, 2),
                'active_students' => $active,
                'published_pages' => $pages,
                'classic_quizzes' => $cq,
                'new_quizzes' => $nq,
                'other_assignments' => $other,
                'discussions' => $disc
            ]);

            return (object) [
                'course_id'             => $courseId,
                'published_pages'       => $pages,
                'classic_quizzes'       => $cq,
                'new_quizzes'           => $nq,
                'other_assignments'     => $other,
                'discussions'           => $disc,
                'active_students'       => $active,
                'quiz_engagement'       => $quizEng,
                'assignment_engagement' => $assnEng,
                'discussion_engagement' => $discEng,
                'audit_duration'        => round($duration, 2),
            ];
        } catch (\Throwable $e) {
            $duration = microtime(true) - $startTime;
            Log::channel('canvas')->error("Failed to audit course {$courseId}", [
                'course_id' => $courseId,
                'duration_seconds' => round($duration, 2),
                'error' => $e->getMessage(),
                'file' => $e->getFile(),
                'line' => $e->getLine(),
                'trace' => $e->getTraceAsString()
            ]);
            throw $e;
        }
    }

    /* -------------------------------------------------------------------------
     | Low-level helpers
     *------------------------------------------------------------------------ */
    private function collectPaginated(string $uri, array $query = []): Collection
    {
        $startTime = microtime(true);
        $fullUrl = "{$this->baseUrl}{$uri}";
        
        Log::channel('canvas')->debug("Starting paginated collection", [
            'uri' => $uri,
            'full_url' => $fullUrl,
            'query' => $query
        ]);

        $items   = collect();
        $next    = $fullUrl;
        $pageCount = 0;

        while ($next) {
            $pageCount++;
            $pageStartTime = microtime(true);
            
            try {
                $resp = Http::withToken($this->token)
                            ->acceptJson()
                            ->timeout(30) // Add timeout
                            ->get($next, $query + ['per_page' => 100])
                            ->throw();

                $pageDuration = microtime(true) - $pageStartTime;
                $itemCount = count($resp->json());
                
                Log::channel('canvas')->debug("API request completed", [
                    'page' => $pageCount,
                    'url' => $next,
                    'status' => $resp->status(),
                    'items_returned' => $itemCount,
                    'duration_seconds' => round($pageDuration, 2)
                ]);

                $items = $items->concat($resp->json());
                $next  = $this->nextLink($resp);
                $query = [];           // query already baked into next URL
                
            } catch (\Throwable $e) {
                Log::channel('canvas')->error("API request failed", [
                    'page' => $pageCount,
                    'url' => $next,
                    'error' => $e->getMessage(),
                    'status' => $e instanceof \Illuminate\Http\Client\RequestException ? $e->response->status() : 'N/A'
                ]);
                throw $e;
            }
        }

        $totalDuration = microtime(true) - $startTime;
        Log::channel('canvas')->debug("Completed paginated collection", [
            'uri' => $uri,
            'total_pages' => $pageCount,
            'total_items' => $items->count(),
            'total_duration_seconds' => round($totalDuration, 2)
        ]);

        return $items;
    }

    private function nextLink(Response $r): ?string
    {
        if (! $link = $r->header('Link')) {
            return null;
        }
        foreach (explode(',', $link) as $part) {
            if (str_contains($part, 'rel="next"')) {
                preg_match('/<([^>]+)>/', $part, $m);
                return $m[1] ?? null;
            }
        }
        return null;
    }

    /* -------------------------------------------------------------------------
     | Count helpers
     *------------------------------------------------------------------------ */
    private function countActiveStudents(int $c): int
    {
        Log::channel('canvas')->debug("Counting active students", ['course_id' => $c]);
        $count = $this->collectPaginated(
            "/courses/{$c}/enrollments",
            ['type[]' => 'StudentEnrollment', 'state[]' => 'active']
        )->count();
        Log::channel('canvas')->debug("Active students count", ['course_id' => $c, 'count' => $count]);
        return $count;
    }

    private function countPublishedPages(int $c): int
    {
        Log::channel('canvas')->debug("Counting published pages", ['course_id' => $c]);
        $count = $this->collectPaginated("/courses/{$c}/pages", ['published' => true])
                    ->count();
        Log::channel('canvas')->debug("Published pages count", ['course_id' => $c, 'count' => $count]);
        return $count;
    }

    private function countClassicQuizzes(int $c): int
    {
        Log::channel('canvas')->debug("Counting classic quizzes", ['course_id' => $c]);
        $count = $this->collectPaginated("/courses/{$c}/quizzes")
                    ->where('is_quiz_lti', false)->count();
        Log::channel('canvas')->debug("Classic quizzes count", ['course_id' => $c, 'count' => $count]);
        return $count;
    }

    private function countNewQuizzes(int $c): int
    {
        Log::channel('canvas')->debug("Counting new quizzes", ['course_id' => $c]);
        $count = $this->collectPaginated("/courses/{$c}/quizzes")
                    ->where('is_quiz_lti', true)->count();
        Log::channel('canvas')->debug("New quizzes count", ['course_id' => $c, 'count' => $count]);
        return $count;
    }

    private function countOtherAssignments(int $c): int
    {
        Log::channel('canvas')->debug("Counting other assignments", ['course_id' => $c]);
        $count = $this->collectPaginated("/courses/{$c}/assignments", ['published' => true])
            ->reject(fn ($a) =>
                in_array('online_quiz', $a['submission_types'] ?? [], true) ||
                ($a['quiz_lti'] ?? false)
            )
            ->count();
        Log::channel('canvas')->debug("Other assignments count", ['course_id' => $c, 'count' => $count]);
        return $count;
    }

    private function countActiveDiscussions(int $c): int
    {
        Log::channel('canvas')->debug("Counting active discussions", ['course_id' => $c]);
        $count = $this->collectPaginated("/courses/{$c}/discussion_topics",
                                       ['only_active' => true])->count();
        Log::channel('canvas')->debug("Active discussions count", ['course_id' => $c, 'count' => $count]);
        return $count;
    }

    /* -------------------------------------------------------------------------
     | Engagement ratios
     *------------------------------------------------------------------------ */
    private function ratio(int $num, int $den): float
    {
        return $den > 0 ? $num / $den : 0.0;
    }

    private function quizEngagement(int $c, int $active): float
    {
        Log::channel('canvas')->debug("Calculating quiz engagement", ['course_id' => $c, 'active_students' => $active]);
        
        $quizzes = $this->collectPaginated("/courses/{$c}/quizzes");
        if ($quizzes->isEmpty() || $active === 0) {
            Log::channel('canvas')->debug("Quiz engagement calculation skipped", [
                'course_id' => $c,
                'quizzes_count' => $quizzes->count(),
                'active_students' => $active
            ]);
            return 0.0;
        }

        $responders = $quizzes->sum(fn ($q) =>
            $this->collectPaginated("/courses/{$c}/quizzes/{$q['id']}/submissions")
                 ->pluck('user_id')->unique()->count()
        );
        
        $ratio = $this->ratio($responders, $active * $quizzes->count());
        Log::channel('canvas')->debug("Quiz engagement calculated", [
            'course_id' => $c,
            'quizzes_count' => $quizzes->count(),
            'total_responders' => $responders,
            'engagement_ratio' => $ratio
        ]);
        
        return $ratio;
    }

    private function assignmentEngagement(int $c, int $active): float
    {
        Log::channel('canvas')->debug("Calculating assignment engagement", ['course_id' => $c, 'active_students' => $active]);
        
        $assn = $this->collectPaginated("/courses/{$c}/assignments", ['published' => true])
                     ->reject(fn ($a) =>
                         in_array('online_quiz', $a['submission_types'] ?? [], true) ||
                         ($a['quiz_lti'] ?? false)
                     );
        if ($assn->isEmpty() || $active === 0) {
            Log::channel('canvas')->debug("Assignment engagement calculation skipped", [
                'course_id' => $c,
                'assignments_count' => $assn->count(),
                'active_students' => $active
            ]);
            return 0.0;
        }

        $submitters = $assn->sum(fn ($a) =>
            $this->collectPaginated("/courses/{$c}/assignments/{$a['id']}/submissions")
                 ->pluck('user_id')->unique()->count()
        );
        
        $ratio = $this->ratio($submitters, $active * $assn->count());
        Log::channel('canvas')->debug("Assignment engagement calculated", [
            'course_id' => $c,
            'assignments_count' => $assn->count(),
            'total_submitters' => $submitters,
            'engagement_ratio' => $ratio
        ]);
        
        return $ratio;
    }

    private function discussionEngagement(int $c, int $active): float
    {
        Log::channel('canvas')->debug("Calculating discussion engagement", ['course_id' => $c, 'active_students' => $active]);
        
        $topics = $this->collectPaginated("/courses/{$c}/discussion_topics",
                                          ['only_active' => true]);

        if ($topics->isEmpty() || $active === 0) {
            Log::channel('canvas')->debug("Discussion engagement calculation skipped", [
                'course_id' => $c,
                'topics_count' => $topics->count(),
                'active_students' => $active
            ]);
            return 0.0;
        }

        $participants = $topics->sum(fn ($t) =>
            $this->collectPaginated("/courses/{$c}/discussion_topics/{$t['id']}/entries")
                 ->pluck('user_id')->unique()->count()
        );
        
        $ratio = $this->ratio($participants, $active * $topics->count());
        Log::channel('canvas')->debug("Discussion engagement calculated", [
            'course_id' => $c,
            'topics_count' => $topics->count(),
            'total_participants' => $participants,
            'engagement_ratio' => $ratio
        ]);
        
        return $ratio;
    }
}
