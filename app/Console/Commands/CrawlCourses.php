<?php
namespace App\Console\Commands;

use Illuminate\Console\Command;
use App\Jobs\CrawlCourse;

class CrawlCourses extends Command
{
    // the signature is what you type in the terminal
    protected $signature = 'crawl:courses';

    protected $description = 'Dispatch CrawlCourse jobs for every COURSE_IDS value';

    public function handle(): int
    {
        // Read comma-separated IDs from .env or config
        $ids = explode(',', env('COURSE_IDS', ''));
        foreach ($ids as $id) {
            $id = trim($id);
            if (!$id) continue;
            CrawlCourse::dispatch((int)$id);
            $this->info("Dispatched crawl for course {$id}");
        }
        return Command::SUCCESS;
    }
}