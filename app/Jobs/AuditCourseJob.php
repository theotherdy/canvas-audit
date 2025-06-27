<?php

namespace App\Jobs;

use App\Services\CanvasCourseAuditor;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;

class AuditCourseJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;

    public function __construct(
        public int $courseId,
        public int $batchId
    ) {}

    public function handle(CanvasCourseAuditor $auditor): void
    {
        $auditor->handle($this->courseId, $this->batchId);
    }
}
