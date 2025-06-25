<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use App\Services\Canvas;
use App\Models\{Course, Page, Quiz, QuizItem};

class CanvasCrawl extends Command
{
    /** php artisan canvas:crawl */
    protected $signature = 'canvas:crawl';

    protected $description = 'Synchronously crawl each COURSE_IDS course and show progress';

    public function __construct(private Canvas $api) { parent::__construct(); }

    public function handle(): int
    {
        $ids = array_filter(array_map('trim', explode(',', env('COURSE_IDS', ''))));
        if (empty($ids)) { $this->error('COURSE_IDS not set in .env'); return Command::FAILURE; }

        foreach ($ids as $index => $canvasId) {
            $this->line("\n<fg=yellow>▶︎  Crawling course {$canvasId} (" . ($index+1) . '/' . count($ids) . ")</>");
            $this->crawlOne((int)$canvasId);
        }

        $this->info("\nAll courses crawled!");
        return Command::SUCCESS;
    }

    /* ------------------------------------------------------------- */
    /*                Single-course crawl logic                       */
    /* ------------------------------------------------------------- */
    private function crawlOne(int $canvasId): void
    {
        /* 1 ─ Course meta */
        $cData  = $this->api->get("courses/{$canvasId}");
        $course = Course::updateOrCreate(
            ['canvas_id'=>$canvasId],
            ['name'=>$cData['name'] ?? 'Unknown',
             'students'=>$cData['total_students'] ?? 0]
        );
        $this->info("   • {$course->name}");

        /* 2 ─ Pages */
        foreach ($this->api->paged("courses/{$canvasId}/modules?per_page=50") as $m) {
            foreach ($this->api->paged("courses/{$canvasId}/modules/{$m['id']}/items?per_page=50") as $it) {
                if ($it['type'] !== 'Page') continue;
                $body = $this->api->get("courses/{$canvasId}/pages/{$it['page_url']}")['body'] ?? '';
                $course->pages()->updateOrCreate(
                    ['title'=>$it['title']],
                    ['module'=>$m['name'],'html'=>$body,'plain'=>strip_tags($body)]
                );
            }
        }
        $this->line('     Pages: '. $course->pages()->count());

        /* 3 ─ Classic quizzes */
        $classic = 0;
        foreach ($this->api->paged("courses/{$canvasId}/quizzes?per_page=50") as $q) {
            if (!$q['published']) continue;
            $classic++;
            $quiz = $course->quizzes()->updateOrCreate(
                ['title'=>$q['title'],'type'=>'classic']
            );
            foreach ($this->api->paged("courses/{$canvasId}/quizzes/{$q['id']}/questions?per_page=100") as $qq) {
                $quiz->items()->updateOrCreate(['question'=>$qq['question_text']]);
            }
        }
        $this->line("     Classic quizzes: {$classic}");

        /* 4 ─ New quizzes (meta only) */
        $new = 0;
        foreach ($this->api->paged("courses/{$canvasId}/assignments?per_page=100") as $a) {
            if (!$a['published'] || empty($a['is_quiz_lti_assignment'])) continue;
            $new++;
            $course->quizzes()->updateOrCreate(
                ['title'=>$a['name'],'type'=>'new_lti'],
                ['lti_url'=>$a['external_tool_tag_attributes']['url'] ?? '']
            );
        }
        $this->line("     New-quiz assignments: {$new}");

        /* Little pause so Canvas stays happy (already throttled in Canvas service) */
    }
}
