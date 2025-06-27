<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

/**
 * @property-read float $progress   // % complete (0‑100)
 */
class AuditBatch extends Model
{
    use HasFactory;

    protected $fillable = [
        'job_batch_id',
        'total_jobs',
        'processed_jobs',
        'failed_jobs',
        'failed_job_ids',
        'status',
        'started_at',
        'finished_at',
    ];

    protected $casts = [
        'total_jobs'     => 'integer',
        'processed_jobs' => 'integer',
        'failed_jobs'    => 'integer',
        'failed_job_ids' => 'array',
        'started_at'     => 'datetime',
        'finished_at'    => 'datetime',
    ];

    /* ─────────────── Relationships ─────────────── */

    public function results()
    {
        return $this->hasMany(AuditCourseResult::class, 'batch_id');
    }

    /* ─────────────── Convenience helpers ─────────────── */

    /**
     * Percentage of jobs processed (0‑100, integer).
     */
    public function progress(): int
    {
        return $this->total_jobs > 0
            ? (int) round(($this->processed_jobs / $this->total_jobs) * 100)
            : 0;
    }

    public function processedJobs(): int
    {
        return $this->processed_jobs;
    }
}
