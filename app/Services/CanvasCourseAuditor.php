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
    }

    /* -------------------------------------------------------------------------
     | Public entry point
     *------------------------------------------------------------------------ */
    public function run(int $courseId): \stdClass
    {
        $active = $this->countActiveStudents($courseId);
        $pages  = $this->countPublishedPages($courseId);
        $cq     = $this->countClassicQuizzes($courseId);
        $nq     = $this->countNewQuizzes($courseId);
        $other  = $this->countOtherAssignments($courseId);
        $disc   = $this->countActiveDiscussions($courseId);

        $quizEng  = $this->quizEngagement($courseId, $active);
        $assnEng  = $this->assignmentEngagement($courseId, $active);
        $discEng  = $this->discussionEngagement($courseId, $active);

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
        ];
    }

    /* -------------------------------------------------------------------------
     | Low-level helpers
     *------------------------------------------------------------------------ */
    private function collectPaginated(string $uri, array $query = []): Collection
    {
        $items   = collect();
        $next    = "{$this->baseUrl}{$uri}";

        while ($next) {
            $resp = Http::withToken($this->token)
                        ->acceptJson()
                        ->get($next, $query + ['per_page' => 100])
                        ->throw();

            $items = $items->concat($resp->json());
            $next  = $this->nextLink($resp);
            $query = [];           // query already baked into next URL
        }

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
        return $this->collectPaginated(
            "/courses/{$c}/enrollments",
            ['type[]' => 'StudentEnrollment', 'state[]' => 'active']
        )->count();
    }

    private function countPublishedPages(int $c): int
    {
        return $this->collectPaginated("/courses/{$c}/pages", ['published' => true])
                    ->count();
    }

    private function countClassicQuizzes(int $c): int
    {
        return $this->collectPaginated("/courses/{$c}/quizzes")
                    ->where('is_quiz_lti', false)->count();
    }

    private function countNewQuizzes(int $c): int
    {
        return $this->collectPaginated("/courses/{$c}/quizzes")
                    ->where('is_quiz_lti', true)->count();
    }

    private function countOtherAssignments(int $c): int
    {
        return $this->collectPaginated("/courses/{$c}/assignments", ['published' => true])
            ->reject(fn ($a) =>
                in_array('online_quiz', $a['submission_types'] ?? [], true) ||
                ($a['quiz_lti'] ?? false)
            )
            ->count();
    }

    private function countActiveDiscussions(int $c): int
    {
        return $this->collectPaginated("/courses/{$c}/discussion_topics",
                                       ['only_active' => true])->count();
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
        $quizzes = $this->collectPaginated("/courses/{$c}/quizzes");
        if ($quizzes->isEmpty() || $active === 0) return 0.0;

        $responders = $quizzes->sum(fn ($q) =>
            $this->collectPaginated("/courses/{$c}/quizzes/{$q['id']}/submissions")
                 ->pluck('user_id')->unique()->count()
        );
        return $this->ratio($responders, $active * $quizzes->count());
    }

    private function assignmentEngagement(int $c, int $active): float
    {
        $assn = $this->collectPaginated("/courses/{$c}/assignments", ['published' => true])
                     ->reject(fn ($a) =>
                         in_array('online_quiz', $a['submission_types'] ?? [], true) ||
                         ($a['quiz_lti'] ?? false)
                     );
        if ($assn->isEmpty() || $active === 0) return 0.0;

        $submitters = $assn->sum(fn ($a) =>
            $this->collectPaginated("/courses/{$c}/assignments/{$a['id']}/submissions")
                 ->pluck('user_id')->unique()->count()
        );
        return $this->ratio($submitters, $active * $assn->count());
    }

    private function discussionEngagement(int $c, int $active): float
    {
        $topics = $this->collectPaginated("/courses/{$c}/discussion_topics",
                                          ['only_active' => true]);

        if ($topics->isEmpty() || $active === 0) return 0.0;

        $participants = $topics->sum(fn ($t) =>
            $this->collectPaginated("/courses/{$c}/discussion_topics/{$t['id']}/entries")
                 ->pluck('user_id')->unique()->count()
        );
        return $this->ratio($participants, $active * $topics->count());
    }
}
