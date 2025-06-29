<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use App\Services\CanvasCourseAuditor;

use Illuminate\Support\Facades\Log;

class AuditController extends Controller
{
    /* ---------- GET / ---------- */
    public function index()
    {
        return view('audit.home');
    }

    /* ---------- POST /audit/run ---------- */
    public function run(Request $request, CanvasCourseAuditor $auditor)
    {
        $ids = collect(preg_split('/[\s,]+/', trim($request->input('course_ids'))))
            ->filter()
            ->map(fn ($id) => (int) $id)
            ->unique()
            ->values();

        if ($ids->isEmpty()) {
            return back()->withErrors(['course_ids' => 'Enter at least one course ID.'])
                         ->withInput();
        }

        $results   = [];
        $hasErrors = false;

        foreach ($ids as $id) {
            try {
                Log::info("Audit  course {$id} ");
                $results[] = $auditor->run($id);
                Log::info("Finished audit  course {$id} ");
            } catch (\Throwable $e) {
                $hasErrors = true;
                $results[] = (object) [
                    'course_id'            => $id,
                    'error'                => $e->getMessage(),
                    'published_pages'      => 0,
                    'classic_quizzes'      => 0,
                    'new_quizzes'          => 0,
                    'other_assignments'    => 0,
                    'discussions'          => 0,
                    'active_students'      => 0,
                    'quiz_engagement'      => 0,
                    'assignment_engagement'=> 0,
                    'discussion_engagement'=> 0,
                ];
            }
        }

        return view('audit.results', [
            'results'   => $results,
            'hasErrors' => $hasErrors,
        ]);
    }
}
