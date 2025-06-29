<?php

namespace App\Jobs;

use Illuminate\Bus\Batchable;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use App\Services\CanvasCourseAuditor;

class AuditCourseJob implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels, Batchable;

    /**
     * @param int $courseId        Canvas course ID
     * @param int $auditBatchId    Primary key of **your** audit_batches row
     */
    public function __construct(
        public int $courseId,
        public int $auditBatchId   // ← renamed, no conflict
    ) {}

    public function handle(CanvasCourseAuditor $auditor): void
    {
        // pass the DB batch id to the service so it can write to audit_course_results
        $auditor->handle($this->courseId, $this->auditBatchId);
    }
}
