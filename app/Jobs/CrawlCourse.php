<?php

namespace App\Jobs;

use App\Models\{Course, Page, Quiz, QuizItem};
use App\Services\Canvas;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;

class CrawlCourse implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public function __construct(public int $canvasId) {}

    public function handle(Canvas $api): void
    {
        $cData = $api->get("courses/{$this->canvasId}");
        $course = Course::updateOrCreate(
            ['canvas_id'=>$this->canvasId],
            ['name'=>$cData['name'] ?? 'Unknown', 'students'=>$cData['total_students'] ?? 0]
        );

        // pages
        foreach ($api->paged("courses/{$this->canvasId}/modules?per_page=50") as $m) {
            foreach ($api->paged("courses/{$this->canvasId}/modules/{$m['id']}/items?per_page=50") as $it) {
                if ($it['type'] !== 'Page') continue;
                $body = $api->get("courses/{$this->canvasId}/pages/{$it['page_url']}")['body'] ?? '';
                $course->pages()->updateOrCreate(
                    ['title'=>$it['title']],
                    ['module'=>$m['name'],'html'=>$body,'plain'=>strip_tags($body)]
                );
            }
        }

        // classic quizzes
        foreach ($api->paged("courses/{$this->canvasId}/quizzes?per_page=50") as $q) {
            if (!$q['published']) continue;
            $quiz = $course->quizzes()->updateOrCreate(
                ['title'=>$q['title'],'type'=>'classic']
            );
            foreach ($api->paged("courses/{$this->canvasId}/quizzes/{$q['id']}/questions?per_page=100") as $qq) {
                $quiz->items()->updateOrCreate(
                    ['question'=>$qq['question_text']]
                );
            }
        }

        // new quizzes (meta only)
        foreach ($api->paged("courses/{$this->canvasId}/assignments?per_page=100") as $a) {
            if (!$a['published'] || empty($a['is_quiz_lti_assignment'])) continue;
            $course->quizzes()->updateOrCreate(
                ['title'=>$a['name'],'type'=>'new_lti'],
                ['lti_url'=>$a['external_tool_tag_attributes']['url'] ?? '']
            );
        }
    }
}
